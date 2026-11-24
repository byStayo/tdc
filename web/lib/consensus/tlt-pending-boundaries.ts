import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { exchangeSession } from "./exchange-calendar.ts";
import { digest } from "./history.ts";
import { readMarketHistoryPriceControl } from "./market-history-price-controls.ts";
import { reviewedMarketHistoryRangeSources } from "./market-history-ranges.ts";
import { readTltIssuer, type IssuerLocation } from "./market-history-settlement.ts";
import { rangeInstant } from "./regular-session-range.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { newYorkDate } from "./time.ts";

const method = "market-history-tlt-boundary-inputs-v1";
export const TLT_PENDING_INPUTS = ".consensus/private-market-history/tlt-settlement/pending-inputs";
type Hourly = NonNullable<Awaited<ReturnType<typeof reviewedMarketHistoryRangeSources>>>;
type Issuer = NonNullable<Awaited<ReturnType<typeof readTltIssuer>>>;
type Proof = ReturnType<typeof proof>;
type PendingState =
  | "waiting_for_free_hours"
  | "hourly_sources_invalid"
  | "raw_split_boundaries_disagree"
  | "waiting_for_postclose_issuer"
  | "issuer_original_invalid"
  | "short_session_auction_required"
  | "saved_proof_invalid"
  | "awaiting_independent_controls";
type Result = { session: string; status: PendingState; receipt?: string; evidenceAvailableAt?: string };

function proof(session: string, hours: Hourly, raw: string, splits: string, priceDigest: string, issuer: Issuer) {
  return {
    method, instrument: "TLT", session, regularCloseAt: exchangeSession(session)!.closeAt,
    evidenceAvailableAt: [hours.row.verifiedAt, issuer.capturedAt].sort()[1],
    rangeReceipt: hours.row.receiptSha256, raw, splits, priceDigest,
    issuer: { kind: issuer.location.kind, session: issuer.location.session, capturedAt: issuer.capturedAt, sha256: issuer.sha256,
      cashThroughSessionSha256: digest(issuer.cash.filter(row => row.session <= session)) },
  };
}

async function issuerLocations(root: string, first: string, cutoff: string) {
  const last = newYorkDate(cutoff);
  const locations: IssuerLocation[] = [];
  for (const [kind, path] of [["firstrate", ".consensus/private-firstrate/captures"],
    ["kibot", ".consensus/private-kibot/sources"]] as const) {
    let entries;
    try { entries = await readdir(resolve(root, path), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const entry of entries) if (entry.isDirectory() && /^\d{4}-\d\d-\d\d$/.test(entry.name) &&
      entry.name >= first && entry.name <= last) locations.push({ kind, session: entry.name });
  }
  return locations.sort((a, b) => a.session.localeCompare(b.session));
}

/** Carry forward the authenticated originals that already arrived. These references never create an outcome or approve a share basis. */
export async function preparePendingTltInputs(root: string, dates: string[], cutoff: string) {
  if (!rangeInstant(cutoff) || dates.some((day, i) => !exchangeSession(day) ||
      exchangeSession(day)!.closeAt > cutoff || (i > 0 && dates[i - 1] >= day))) throw Error("Invalid TLT input review sessions");
  const dir = resolve(root, TLT_PENDING_INPUTS);
  const issuers = new Map<string, ReturnType<typeof readTltIssuer>>();
  let locations: Promise<IssuerLocation[]> | undefined;
  function issuerAt(location: IssuerLocation) {
    const key = location.kind + "/" + location.session;
    let original = issuers.get(key);
    if (!original) { original = readTltIssuer(root, location, cutoff); issuers.set(key, original); }
    return original;
  }
  async function inspect(session: string): Promise<Result> {
    const clock = exchangeSession(session)!;
    if (Date.parse(clock.closeAt) - Date.parse(clock.openAt) !== 390 * 60_000)
      return { session, status: "short_session_auction_required" };
    let hours, raw, splits;
    try {
      hours = await reviewedMarketHistoryRangeSources(root, "TLT", session, cutoff);
      if (!hours) return { session, status: "waiting_for_free_hours" };
      const [opening, closing, splitOpening, splitClosing] = hours.native;
      raw = readMarketHistoryPriceControl("TLT", [session], { opening, closing }, "raw", cutoff);
      splits = readMarketHistoryPriceControl("TLT", [session], { opening: splitOpening, closing: splitClosing }, "splits", cutoff);
    } catch { return { session, status: "hourly_sources_invalid" }; }
    if (raw.priceDigest !== splits.priceDigest) return { session, status: "raw_split_boundaries_disagree" };

    const path = resolve(dir, session + ".json");
    const exact = (issuer: Issuer) => proof(session, hours, raw.sha256, splits.sha256, raw.priceDigest, issuer);
    const usable = (issuer: Issuer | null): issuer is Issuer => !!issuer && issuer.capturedAt > clock.closeAt &&
      issuer.cash[0].session <= session && issuer.location.session >= session && issuer.location.session <= newYorkDate(cutoff);
    const accepted = (value: Proof) => ({ session, status: "awaiting_independent_controls" as const,
      receipt: digest(value), evidenceAvailableAt: value.evidenceAvailableAt });
    async function replay(saved: Proof) {
      const issuer = await issuerAt(saved.issuer);
      if (!usable(issuer) || digest(exact(issuer)) !== digest(saved)) throw Error("TLT input originals differ from their dated proof");
      return accepted(saved);
    }
    try {
      const saved = await readResearchReceipt<Proof>(path);
      if (saved) return await replay(saved);
    } catch { return { session, status: "saved_proof_invalid" }; }

    locations ??= issuerLocations(root, dates[0], cutoff);
    let invalidIssuer = false;
    for (const location of await locations) {
      if (location.session < session) continue;
      let issuer;
      try { issuer = await issuerAt(location); }
      catch { invalidIssuer = true; continue; }
      if (!usable(issuer)) continue;
      const value = exact(issuer);
      await durableDirectory(dir, 0o700);
      try { await durableJSON(path, value, true); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try { return await replay((await readResearchReceipt<Proof>(path))!); }
        catch { return { session, status: "saved_proof_invalid" }; }
      }
      return accepted(value);
    }
    return { session, status: invalidIssuer ? "issuer_original_invalid" : "waiting_for_postclose_issuer" };
  }
  const results: Result[] = [];
  for (const day of dates) results.push(await inspect(day));
  return results;
}
