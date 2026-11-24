import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { adjustETFPrices } from "../lib/consensus/corporate-adjustment.ts";
import { extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { exchangeSessions, hasReviewedCalendar } from "../lib/consensus/exchange-calendar.ts";
import { loadReviewedTltCash } from "../lib/consensus/firstrate.ts";
import { digest } from "../lib/consensus/history.ts";
import { readNasdaqHistoricalControl } from "../lib/consensus/kibot-session-witnesses.ts";
import { collectKibotSeries, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { boundaryClock, compareMarketHistoryBoundary, contiguousTltWindows, marketHistoryBoundaries } from "../lib/consensus/market-history-boundaries.ts";
import { importMarketHistoryHours, type DeliveredMarketHistoryHours, type MarketHistoryGrid } from "../lib/consensus/market-history-closes.ts";
import { fetchFreeTltHours, tltHourSource } from "../lib/consensus/market-history-hourly-access.ts";
import { readTltIssuer, recordTltSettlement, tltNativeBar, type IssuerLocation, type NativeOriginal,
  type ListedLocation, type NativeLocation } from "../lib/consensus/market-history-settlement.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { SourceMissingError } from "../lib/consensus/source-failure.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const archive = resolve(root, ".consensus/private-market-history"), dir = resolve(archive, "tlt-settlement");
const witnesses = resolve(root, ".consensus/private-kibot/sources");
const sha = (input: Buffer | string) => createHash("sha256").update(input).digest("hex");
const args = process.argv.slice(2), [from, through, ...flags] = args;
const collect = flags.includes("--collect"), controls = collect || flags.includes("--controls");
if (!from || !through || new Set(flags).size !== flags.length || flags.some(f => !["--collect", "--controls", "--refresh", "--settle-verified"].includes(f)) ||
    ((flags.includes("--refresh") || flags.includes("--settle-verified")) && !collect) || Date.parse(through) - Date.parse(from) > 35 * 86_400_000)
  throw new Error("Use FROM THROUGH [--controls | --collect [--refresh]] for at most 36 calendar dates");
const dates = hasReviewedCalendar(from) ? exchangeSessions(from, through) : extendedResearchSessions(from, through);
const clocks = dates.map(day => boundaryClock(day)!);
if (!dates.length || Date.parse(clocks.at(-1)!.closeAt) >= Date.now()) throw new Error("Completed exchange sessions required");
await durableDirectory(dir, 0o700);
const now = () => new Date().toISOString();

async function pinned<T>(folder: string, value: T) {
  const id = digest(value), path = resolve(folder, id + ".json");
  const old = await readResearchReceipt<T>(path);
  if (old && digest(old) !== id) throw new Error("Immutable TLT evidence changed");
  if (!old) {
    try { await durableJSON(path, value, true); }
    catch (error) {
      const parallel = await readResearchReceipt<T>(path);
      if (!parallel || digest(parallel) !== id) throw error;
    }
  }
  return id;
}
const storedKey = collect && !process.env.MARKET_HISTORY_KEY ? await readResearchReceipt<{ apiKey: string }>(resolve(archive, "credentials.json")) : null;
const key = collect ? process.env.MARKET_HISTORY_KEY ?? storedKey?.apiKey : undefined;
const account = key ? { key } : null;
async function hourly(grid: MarketHistoryGrid) {
  const bucket = grid === "exchange" ? "closing" : "opening";
  const pointer = resolve(dir, `${from}-${through}-${bucket}.json`);
  const saved = await readResearchReceipt<{ id: string }>(pointer);
  const source = tltHourSource(from, through, grid);
  if (saved) {
    if (!/^[a-f0-9]{64}$/.test(saved.id)) throw new Error("Invalid TLT response pointer");
    const old = await readResearchReceipt<DeliveredMarketHistoryHours>(resolve(dir, saved.id + ".json"));
    if (!old || digest(old) !== saved.id || old.source !== source) throw new Error("Stored TLT response differs from its receipt");
    const receipt = importMarketHistoryHours(old, "TLT", now(), grid);
    if (!account || (!flags.includes("--refresh") && Date.parse(receipt.through) >= Date.parse(clocks.at(-1)!.closeAt))) return old;
  }
  if (!account) return null;
  const result = await fetchFreeTltHours(from, through, grid, account);
  const id = await pinned(dir, result);
  importMarketHistoryHours(result, "TLT", now(), grid);
  await durableJSON(pointer, { id });
  return result;
}

async function issuer() {
  const reviewed = await loadReviewedTltCash(root, now());
  const locations: IssuerLocation[] = [{ kind: "kibot", session: through }, { kind: "firstrate", session: through }];
  if (reviewed && reviewed.through !== through) locations.push({ kind: "firstrate", session: reviewed.through });
  for (const location of locations) {
    const decoded = await readTltIssuer(root, location, now());
    if (decoded) return decoded;
  }
  return null;
}

async function native(day: string, split: boolean) {
  const folder = resolve(dir, "controls", day), path = resolve(folder, split ? "TLT-splits.json" : "TLT-kibot.json");
  let record = !split ? await readResearchReceipt<NativeOriginal>(resolve(witnesses, day, "TLT-kibot.json")) : null;
  const kind: NativeLocation["kind"] = record ? "kibot" : "qualification";
  record ??= await readResearchReceipt<NativeOriginal>(path);
  if (!record && controls) {
    let csv = "";
    const data = await collectKibotSeries("TLT", [day], { unadjusted: !split, splitAdjusted: split, sessionClock: boundaryClock,
      onVerifiedResponse: original => { csv = original; } });
    record = { source: KIBOT_PRICE_CITATION, capturedAt: now(), sha256: data.sha256, csv, symbol: "TLT", first: day, through: day,
      unadjusted: !split, splitAdjusted: split };
    await durableDirectory(folder, 0o700);
    await durableJSON(path, record, true);
  }
  if (!record) return null;
  return { ...tltNativeBar(record, day, split, now()), sha256: record.sha256,
    location: { kind, sha256: record.sha256, capturedAt: record.capturedAt } };
}
async function nasdaq(day: string) {
  const canonical = resolve(witnesses, day);
  const saved = await readResearchReceipt(resolve(canonical, "TLT-daily.json"));
  const range = { from: dates[0], through: dates.at(-1)! };
  // The exchange sometimes answers a one-day request with an empty table while its dated range contains the row.
  let source, selectedGeneration: string | undefined;
  if (saved) source = await readNasdaqHistoricalControl(canonical, "TLT", day, false);
  else {
    if (rangePointer && !flags.includes("--refresh")) {
      try {
        source = await readNasdaqHistoricalControl(resolve(dir, "controls", rangePointer.generation),
          "TLT", day, false, fetch, boundaryClock, range);
        selectedGeneration = rangePointer.generation;
        if (source.stamp.sha256 !== rangePointer.sha256) throw new Error("Pinned Nasdaq history changed");
      } catch (error) { if (!(error instanceof SourceMissingError) || !controls) throw error; }
    }
    if (!source) {
      const generation = rangePointer || flags.includes("--refresh") ? generationAtStart : generationAtStart.slice(0, 10);
      source = await readNasdaqHistoricalControl(resolve(dir, "controls", generation), "TLT", day, controls, fetch, boundaryClock, range);
      selectedGeneration = generation;
      if (rangePointer?.sha256 !== source.stamp.sha256) {
        rangePointer = { generation, sha256: source.stamp.sha256 };
        await durableJSON(rangePointerPath, rangePointer);
      }
    }
  }
  if (source.stamp.capturedAt > now()) throw new Error("Nasdaq comparison capture is future-dated");
  const stamp = { sha256: source.stamp.sha256, capturedAt: source.stamp.capturedAt };
  const location: ListedLocation = saved ? { kind: "kibot", ...stamp } : { kind: "range", generation: selectedGeneration, ...stamp };
  return { session: day, ...source.prices, sha256: source.stamp.sha256, location };
}

// Independently reviewed TotalView-ITCH opening and closing crosses on the November 2025 shortened session.
async function historicalAuction(day: string) {
  if (day !== "2025-11-28") return undefined;
  const file = resolve(root, ".consensus/private-nasdaq-crosses/2025-11-28-e965ea6f9779.json");
  const record = await readResearchReceipt<{ comparison: { symbol: string; open: { price: number }; close: { price: number } }[] }>(file);
  if (!record) return undefined;
  if (sha(await readFile(file)) !== "2cc16cfd6ff2b5f8051384488352a7c6df2350e6f47acb23dca79ae8d0f0d485")
    throw new Error("Reviewed 2025 shortened-session auction evidence changed");
  const cross = record.comparison.find(r => r.symbol === "TLT")!;
  return { session: day, open: cross.open.price, close: cross.close.price };
}
const generationAtStart = now().replaceAll(":", "-"), rangePointerPath = resolve(dir, `${from}-${through}-nasdaq.json`);
let rangePointer = await readResearchReceipt<{ generation: string; sha256: string }>(rangePointerPath);
if (rangePointer && (!/^\d{4}-\d\d-\d\d(?:T\d\d-\d\d-\d\d\.\d{3}Z)?$/.test(rangePointer.generation) ||
    !/^[a-f0-9]{64}$/.test(rangePointer.sha256))) throw new Error("Invalid Nasdaq range receipt");
const cash = await issuer(), opening = await hourly("Asia/Kolkata"), closing = await hourly("exchange");
const boundaries = opening && closing ? marketHistoryBoundaries(opening, closing, clocks, now()) : [];
async function reviewDay(day: string, i: number) {
  const [a, b, c] = await Promise.allSettled([native(day, false), native(day, true), nasdaq(day)]);
  const raw = a.status === "fulfilled" ? a.value : null, split = b.status === "fulfilled" ? b.value : null;
  const listed = c.status === "fulfilled" ? c.value : null, auction = await historicalAuction(day);
  const covered = !!cash && cash.cash[0].session <= day && cash.capturedAt > clocks[i].closeAt;
  const boundary = boundaries[i];
  const comparison = listed ?? auction;
  const status = boundary ? compareMarketHistoryBoundary(boundary, raw ?? undefined, split ?? undefined, comparison, covered, auction) : "awaiting_hourly_delivery";
  const errors = [a, b, c].flatMap((entry, n) => entry.status === "rejected" ? [`${["raw", "splits", "Nasdaq"][n]}: ${entry.reason instanceof Error ? entry.reason.message : "source unavailable"}`] : []);
  return { day, status, raw, split, listed, auction, issuerCovered: covered, boundary, errors };
}
const review: Awaited<ReturnType<typeof reviewDay>>[] = [];
for (const [i, day] of dates.entries()) review.push(await reviewDay(day, i));
const distributions = cash?.cash.filter(r => r.session >= dates[0] && r.session <= dates.at(-1)!) ?? [];
const matched = review.filter(r => r.status === "matched");
const cashBoundaries = distributions.map(({ session, amount }) => {
  const index = dates.indexOf(session);
  const previous = index > 0 ? review[index - 1] : null;
  const status = !previous ? "prior_session_outside_range" : previous.status !== "matched" || review[index].status !== "matched"
    ? "prices_pending" : Math.abs(previous.boundary!.close! - previous.raw!.close) < amount / 2 ? "matched" : "prior_close_difference";
  return { session, status };
});
const windows = contiguousTltWindows(review, distributions);
const adjusted = windows.flatMap(window => adjustETFPrices(window.map(r => ({ ...boundaryClock(r.day)!, open: r.boundary!.open!, close: r.boundary!.close! })),
  distributions.filter(a => a.session >= window[0].day && a.session <= window.at(-1)!.day), []));
const report = { scope: "private-source-qualification", from, through, opening: opening && digest(opening), closing: closing && digest(closing),
  issuer: cash?.sha256 ?? null, distributions, cashBoundaries, adjusted, review };
const receipt = await pinned(dir, report);
let settlementSessions = 0;
if (flags.includes("--settle-verified") && opening && closing && cash && hasReviewedCalendar(dates[0])) {
  for (const window of windows) {
    const evidence = await recordTltSettlement(root, { schema: 1, from, through, windowFrom: window[0].day, windowThrough: window.at(-1)!.day,
      opening: digest(opening), closing: digest(closing), issuer: { ...cash.location, sha256: cash.sha256, capturedAt: cash.capturedAt },
      controls: window.map(r => ({ session: r.day, raw: r.raw!.location, split: r.split!.location, listed: r.listed!.location })) }, now());
    settlementSessions += evidence.sessions.length;
  }
}
console.log(JSON.stringify({ instrument: "TLT", from, through, scope: report.scope, receipt, sessions: dates.length,
  completeHourlyGrids: Number(!!opening) + Number(!!closing), matched: matched.length, issuerCashDates: distributions.map(row => row.session),
  cashBoundaries, adjustedSessions: adjusted.length, settlementSessions, days: review.map(r => ({ session: r.day, status: r.status, asTraded: !!r.raw, splitOnly: !!r.split,
    nasdaq: !!r.listed, rawMatchesSplit: r.raw && r.split ? r.raw.open === r.split.open && r.raw.close === r.split.close : null,
    issuer: r.issuerCovered, auction: !!r.auction, errors: r.errors })) }, null, 2));
