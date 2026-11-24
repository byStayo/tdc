import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { adjustETFPrices, ETF_CASH_SOURCES, officialCashLocation, type CashDistribution } from "./corporate-adjustment.ts";
import { exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import type { PriceEvidence } from "./evaluation.ts";
import { digest } from "./history.ts";
import { readNasdaqHistoricalControl } from "./kibot-session-witnesses.ts";
import { KIBOT_PRICE_CITATION, MAX_KIBOT_RESPONSE_BYTES, parseKibotDaily } from "./kibot.ts";
import { boundaryClock, compareMarketHistoryBoundary, freeMarketHistoryBalance, marketHistoryBoundaries } from "./market-history-boundaries.ts";
import type { DeliveredMarketHistoryHours } from "./market-history-closes.ts";
import { OUTCOME_PRICE_BASIS } from "./price-basis.ts";
import { readResearchReceipt } from "./research-price-capture.ts";

export const MARKET_HISTORY_SOURCE = "https://getmarkethistory.com/docs/guides/historical-stock-market-data/";
const fingerprint = (input: Buffer | string) => createHash("sha256").update(input).digest("hex");
const hasHash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const isTime = (v: string) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const directory = (root: string) => resolve(root, ".consensus/private-market-history/tlt-settlement");
const sourceRoot = (root: string) => resolve(root, ".consensus/private-kibot/sources");
const issuerScripts = fileURLToPath(new URL("../../scripts/", import.meta.url));
export type IssuerLocation = { kind: "kibot" | "firstrate"; session: string };
export type NativeOriginal = { source: string; capturedAt: string; sha256: string; csv: string; symbol: string;
  first: string; through: string; unadjusted: boolean; splitAdjusted?: boolean };
type SourceStamp = { sha256: string; capturedAt: string };
export type NativeLocation = SourceStamp & { kind: "kibot" | "qualification" };
export type ListedLocation = SourceStamp & { kind: "kibot" | "range"; generation?: string };
type Meta = { url: string; responseUrl?: string; sha256: string; capturedAt: string };
type SessionInputs = { session: string; raw: NativeLocation; split: NativeLocation; listed: ListedLocation };
export type TltSettlementReview = { schema: 1; from: string; through: string; opening: string; closing: string;
  windowFrom: string; windowThrough: string;
  issuer: IssuerLocation & SourceStamp; controls: SessionInputs[] };
type StoredSettlement = { review: TltSettlementReview; reviewedAt: string; sha256: string };

export async function readTltIssuer(root: string, location: IssuerLocation, asOf: string) {
  if (!/^\d{4}-\d\d-\d\d$/.test(location.session) || !["kibot", "firstrate"].includes(location.kind))
    throw new Error("Invalid TLT issuer source location");
  const folder = location.kind === "kibot" ? resolve(sourceRoot(root), location.session, "issuer-post-close/TLT") :
    resolve(root, ".consensus/private-firstrate/captures", location.session);
  const meta = await readResearchReceipt<Meta>(resolve(folder, "issuer-TLT.json"));
  if (!meta) return null;
  // Older issuer captures made by Python spell the identical UTC offset as +00:00.
  const capturedAt = typeof meta.capturedAt === "string" ? meta.capturedAt.replace(/\+00:00$/, "Z") : "";
  const path = resolve(folder, "issuer-TLT.bin"), stat = await lstat(path);
  if (!stat.isFile() || stat.mode & 0o077 || !stat.size || stat.size > 4_000_000 ||
      !officialCashLocation("TLT", meta.url, meta.responseUrl ?? meta.url) || !isTime(capturedAt) || capturedAt > asOf)
    throw new Error("Invalid private TLT issuer capture");
  const input = await readFile(path);
  if (fingerprint(input) !== meta.sha256) throw new Error("TLT issuer original differs from its capture");
  const output = execFileSync("python3", ["-B", "-c", "import json,sys\nfrom issuer_corporate_actions import issuer_cash\n" +
    "print(json.dumps(issuer_cash('TLT',sys.stdin.buffer.read(),'2002-01-01')))"],
  { cwd: issuerScripts, input, encoding: "utf8", timeout: 10_000, maxBuffer: 100_000 });
  const decoded = JSON.parse(output) as { symbol: string; source: string; sha256: string; cash: CashDistribution[] };
  if (decoded.source !== ETF_CASH_SOURCES.TLT || decoded.symbol !== "TLT" || decoded.sha256 !== meta.sha256 || !decoded.cash.length)
    throw new Error("TLT issuer history could not be reproduced");
  return { ...meta, capturedAt, cash: decoded.cash, location };
}

export function tltNativeBar(record: NativeOriginal, day: string, split: boolean, asOf: string) {
  if (record.source !== KIBOT_PRICE_CITATION || record.symbol !== "TLT" || record.first !== day || record.through !== day ||
      record.unadjusted !== !split || Boolean(record.splitAdjusted) !== split || typeof record.csv !== "string" ||
      Buffer.byteLength(record.csv) > MAX_KIBOT_RESPONSE_BYTES || record.sha256 !== fingerprint(record.csv) ||
      !isTime(record.capturedAt) || record.capturedAt <= boundaryClock(day)!.closeAt || record.capturedAt > asOf)
    throw new Error("Invalid retained TLT share-basis control");
  return parseKibotDaily(record.csv, [day], boundaryClock)[0];
}

async function originalControls(root: string, day: string, input: SessionInputs, range: { from: string; through: string }, asOf: string) {
  const dir = directory(root), witnesses = sourceRoot(root);
  async function native(location: NativeLocation, split: boolean) {
    if (!location || !["kibot", "qualification"].includes(location.kind) || (split && location.kind !== "qualification"))
      throw new Error("TLT settlement is missing a required share-basis control");
    const folder = location.kind === "kibot" ? resolve(witnesses, day) : resolve(dir, "controls", day);
    const original = await readResearchReceipt<NativeOriginal>(resolve(folder, split ? "TLT-splits.json" : "TLT-kibot.json"));
    if (!original || !hasHash(location.sha256) || original.sha256 !== location.sha256 || original.capturedAt !== location.capturedAt)
      throw new Error("TLT native source capture changed");
    return tltNativeBar(original, day, split, asOf);
  }
  const { listed } = input;
  if (!listed || !hasHash(listed.sha256) || !["kibot", "range"].includes(listed.kind) ||
      (listed.kind === "range" && !/^\d{4}-\d\d-\d\d(?:T\d\d-\d\d-\d\d\.\d{3}Z)?$/.test(listed.generation ?? "")))
    throw new Error("Missing TLT Nasdaq source control");
  const wide = listed.kind === "range";
  const folder = wide ? resolve(dir, "controls", listed.generation!) : resolve(witnesses, day);
  const [raw, split, history] = await Promise.all([native(input.raw, false), native(input.split, true),
    readNasdaqHistoricalControl(folder, "TLT", day, false, fetch, exchangeSession, wide ? range : undefined)]);
  if (!isTime(history.stamp.capturedAt) || history.stamp.capturedAt !== listed.capturedAt || history.stamp.capturedAt > asOf ||
      history.stamp.sha256 !== listed.sha256)
    throw new Error("TLT Nasdaq historical response differs from its dated source");
  return { raw, split, listed: { session: day, ...history.prices } };
}

/** Rebuild only from complete original, post-close, owner-authorized source and control responses. */
export async function tltSettlementPriceEvidence(root: string, review: TltSettlementReview, asOf: string): Promise<PriceEvidence> {
  if (!isTime(asOf) || review.schema !== 1 || !hasHash(review.opening) || !hasHash(review.closing) || review.opening === review.closing ||
      !review.issuer || !hasHash(review.issuer.sha256) || Date.parse(review.through) - Date.parse(review.from) > 35 * 86_400_000)
    throw new Error("Invalid TLT settlement review");
  const requested = exchangeSessions(review.from, review.through);
  if (!requested.includes(review.windowFrom) || !requested.includes(review.windowThrough) || review.windowFrom > review.windowThrough)
    throw new Error("TLT settlement subwindow must stay inside its original hourly request");
  const dates = exchangeSessions(review.windowFrom, review.windowThrough), clocks = dates.map(day => exchangeSession(day)!);
  if (!dates.length || !Array.isArray(review.controls) || review.controls.length !== dates.length ||
      review.controls.some((row, i) => row?.session !== dates[i]) || clocks.at(-1)!.closeAt > asOf)
    throw new Error("TLT settlement requires every dated source control");
  async function delivery(id: string) {
    const page = await readResearchReceipt<DeliveredMarketHistoryHours>(resolve(directory(root), id + ".json"));
    if (!page || digest(page) !== id) throw new Error("TLT signed hourly original differs from its receipt");
    freeMarketHistoryBalance(new Headers(page.headers));
    const query = new URL(page.source).searchParams;
    if (query.get("start") !== review.from || query.get("end") !== review.through)
      throw new Error("TLT hourly sources differ from the approved window");
    return page;
  }
  const [opening, closing, issuer] = await Promise.all([delivery(review.opening), delivery(review.closing), readTltIssuer(root, review.issuer, asOf)]);
  if (!issuer || issuer.sha256 !== review.issuer.sha256 || issuer.capturedAt !== review.issuer.capturedAt ||
      issuer.capturedAt <= clocks.at(-1)!.closeAt || issuer.cash[0].session > dates[0])
    throw new Error("TLT needs the matching issuer history captured after the final close");
  const boundaries = marketHistoryBoundaries(opening, closing, clocks, asOf);
  const rows = [], rawCloses = [];
  for (const [i, day] of dates.entries()) {
    const controls = await originalControls(root, day, review.controls[i], { from: requested[0], through: requested.at(-1)! }, asOf);
    const boundary = boundaries[i];
    // Prospective Tape C short-session auction originals have not yet been independently qualified.
    const status = compareMarketHistoryBoundary(boundary, controls.raw, controls.split, controls.listed, true);
    if (status !== "matched") throw new Error(`TLT settlement withheld for ${day}: ${status}`);
    rows.push({ ...clocks[i], open: boundary.open!, close: boundary.close! });
    rawCloses.push(controls.raw.close);
  }
  const actions = issuer.cash.filter(r => r.session >= dates[0] && r.session <= dates.at(-1)!);
  for (const action of actions) {
    const index = dates.indexOf(action.session);
    if (index < 1 || Math.abs(rows[index - 1].close - rawCloses[index - 1]) >= action.amount / 2)
      throw new Error("TLT issuer adjustment requires the verified preceding session and its as-traded basis");
  }
  return { instrument: "TLT", source: MARKET_HISTORY_SOURCE, adjustment: OUTCOME_PRICE_BASIS,
    expectedSessions: requested, sessions: adjustETFPrices(rows, actions, []) };
}

export async function recordTltSettlement(root: string, review: TltSettlementReview, asOf: string) {
  const evidence = await tltSettlementPriceEvidence(root, review, asOf);
  const id = digest(review), folder = resolve(directory(root), "settlements");
  await durableDirectory(folder, 0o700);
  const path = resolve(folder, review.windowThrough + "_" + review.windowFrom + "_" + id + ".json");
  const saved = await readResearchReceipt<StoredSettlement>(path);
  const valid = (record: StoredSettlement | null) => record && digest(record.review) === id && isTime(record.reviewedAt) &&
    record.reviewedAt <= asOf && digest({ review: record.review, reviewedAt: record.reviewedAt }) === record.sha256;
  if (saved && !valid(saved)) throw new Error("TLT settlement proof changed");
  if (!saved) {
    const entry = { review, reviewedAt: asOf };
    try { await durableJSON(path, { ...entry, sha256: digest(entry) }, true); } catch (error) {
      if (!valid(await readResearchReceipt<StoredSettlement>(path))) throw error;
    }
  }
  return evidence;
}

export async function loadTltSettlement(root: string, asOf: string, warn: (message: string) => void) {
  const folder = resolve(directory(root), "settlements"), prices: PriceEvidence[] = [];
  let entries;
  try { entries = await readdir(folder); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return prices; throw error; }
  for (const name of entries.sort().reverse()) {
    const match = /^(\d{4}-\d\d-\d\d)_(\d{4}-\d\d-\d\d)_([a-f0-9]{64})\.json$/.exec(name);
    if (!match || prices.some(p => p.sessions[0].session <= match[2] && p.sessions.at(-1)!.session >= match[1])) continue;
    try {
      const entry = await readResearchReceipt<StoredSettlement>(resolve(folder, name)), review = entry?.review;
      if (!entry || !review || review.windowFrom !== match[2] || review.windowThrough !== match[1] || digest(review) !== match[3] ||
          !isTime(entry.reviewedAt) || digest({ review, reviewedAt: entry.reviewedAt }) !== entry.sha256)
        throw new Error("Invalid TLT settlement manifest");
      if (entry.reviewedAt <= asOf) prices.push(await tltSettlementPriceEvidence(root, review, entry.reviewedAt));
    } catch { warn(`Market History TLT settlement withheld for ${match[2]} through ${match[1]}. The original prices or controls did not verify.`); }
  }
  return prices;
}
