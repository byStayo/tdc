import { createHash } from "node:crypto";
import { join } from "node:path";
import { acquirePublicationLock, finishPublicationLock } from "../publication-lock.ts";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { latestFirstRateSession } from "./firstrate.ts";
import { digest } from "./history.ts";
import { freeMarketHistoryBalance, MARKET_HISTORY_ETF_IDS } from "./market-history-boundaries.ts";
import { importMarketHistoryHours, parseMarketHistoryHours, type DeliveredMarketHistoryHours as Hours } from "./market-history-closes.ts";
import { authenticatedFreeMarketHistoryResponse, fetchFreeEtfHours, type FreeHourlyAccount } from "./market-history-hourly-access.ts";
import { marketHistoryPreview } from "./market-history-preview.ts";
import { reviewedMarketHistoryRangeSources } from "./market-history-ranges.ts";
import { rangeInstant } from "./regular-session-range.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { tltPremarketClocks, tltPremarketSignal } from "./tlt-premarket-signal.ts";

const hour = 3_600_000, minute = 60_000;
const instrument = "stocks/us/TLT";
const host = "https://getmarkethistory.com/api/v1/";
const policy = "tlt-prior-premarket-raw-splits-v1";
const rootPath = (root: string) => join(root, ".consensus/private-market-history");
const store = (root: string) => join(rootPath(root), "tlt-premarket-v1");
const positions = [
  ["Asia/Kolkata", "raw"], ["exchange", "raw"], ["Asia/Kolkata", "splits"], ["exchange", "splits"],
] as const;
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const instant = (n: number) => new Date(n).toISOString();
const validId = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const clockNow = () => new Date().toISOString();
type MapRow = { start: string; end: string; bars: number; kind: string; traded?: number };
type PublicOriginal = {
  source: string; status: number; contentType: string; charged: string | null;
  text: string; sha256: string; date: string; retrievedAt: string;
};
type Review = { method: typeof policy; session: string; approvedAt: string; catalogue: PublicOriginal; minuteMap: PublicOriginal; native: string[] };
const coveragePath = (session: string) => {
  const c = tltPremarketClocks(session);
  return instrument + "/gaps?" + new URLSearchParams({ timeframe: "1m", start: instant(c.first), end: instant(c.last) });
};

function verifyOriginal(original: PublicOriginal, path: string, asOf: string) {
  const served = Date.parse(original.date);
  if (original.source !== host + path || original.status !== 200 || original.contentType !== "application/json" ||
    (original.charged !== null && original.charged !== "0") || typeof original.text !== "string" || !validId(original.sha256) ||
    hash(original.text) !== original.sha256 || !rangeInstant(original.retrievedAt) || !Number.isFinite(served) ||
    new Date(served).toUTCString() !== original.date || served > Date.parse(original.retrievedAt) || original.retrievedAt > asOf)
    throw Error("Unverified Market History discovery response");
  return JSON.parse(original.text);
}

function sourceVintage(original: PublicOriginal, session: string, asOf: string) {
  const data = verifyOriginal(original, instrument, asOf);
  const rows = data.bars?.timeframes?.filter((r: { timeframe: string; venue: string; feed: string }) =>
    r.timeframe === "1m" && r.feed === "consolidated" && r.venue === "US consolidated tape");
  const c = tltPremarketClocks(session);
  if (data.ticker !== "TLT" || data.dataset !== "stocks/us" || data.contract?.status !== "active" ||
    data.contract.exchange !== "NASDAQ" || rows?.length !== 1) throw Error("Unexpected TLT market catalogue");
  const vintage = Date.parse(rows[0].updated), through = Date.parse(rows[0].last);
  if (!Number.isFinite(vintage) || !Number.isFinite(through) || through < c.last || through > vintage ||
    vintage < c.last || vintage > Date.parse(original.date))
    throw Error("Prior TLT premarket is not yet delivered");
  return instant(vintage);
}

export function marketHistoryPremarketMinutes(original: PublicOriginal, session: string, asOf: string) {
  const data = verifyOriginal(original, coveragePath(session), asOf);
  const { first, last, earliest } = tltPremarketClocks(session);
  if (data.ticker !== "TLT" || data.dataset !== "stocks/us" || data.feed !== "consolidated" || data.timeframe !== "1m" ||
    data.reliable !== true || (data.witness !== undefined && data.witness !== "iex") || Date.parse(data.start) !== first || Date.parse(data.end) !== last ||
    Date.parse(original.date) < Date.parse(earliest) || data.bars !== 330 ||
    !Number.isInteger(data.present) || data.present < 2 || data.present > 330 || !Array.isArray(data.ranges))
    throw Error("Incomplete TLT premarket minute map");
  const tally = new Map([["venue_break", 0], ["market_wide", 0], ["this_ticker", 0]]);
  let previous = first, missing = 0;
  for (const r of data.ranges as MapRow[]) {
    const a = Date.parse(r.start), b = Date.parse(r.end), count = (b - a) / minute;
    if (!Number.isInteger(count) || count < 1 || a % minute !== 0 || a < previous || a <= first || b > last ||
      !tally.has(r.kind) || r.bars !== count || (r.traded !== undefined && r.traded !== 0))
      throw Error("Missing boundary, witnessed missing trade or inconsistent premarket coverage");
    previous = b; missing += count; tally.set(r.kind, tally.get(r.kind)! + count);
  }
  if (missing + data.present !== 330 || !data.missing || [...tally].some(([k, n]) => data.missing[k] !== n) ||
    (data.missing.traded !== undefined && data.missing.traded !== 0))
    throw Error("Premarket minute totals disagree");
  return data.present as number;
}

/** The final half-hour-aligned bucket ends at the opening bell. Both grids stay entirely inside premarket. */
export function marketHistoryPremarketChange(originals: Hours[], session: string, asOf: string) {
  const c = tltPremarketClocks(session);
  if (originals.length !== 4) throw Error("Expected raw and split-only TLT hourly grids");
  const native = originals.map((d, i) => {
    if (!d || Object.keys(d.headers).some(h => /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization)$/i.test(h)))
      throw Error("Invalid private TLT headers");
    freeMarketHistoryBalance(new Headers(d.headers));
    const [grid, basis] = positions[i], captured = importMarketHistoryHours(d, "TLT", asOf, grid, basis);
    const query = new URL(d.source).searchParams;
    const from = query.get("start")!, through = query.get("end")!;
    if (from > session || through < session || Date.parse(captured.through) < c.last || Date.parse(captured.capturedAt) < c.last)
      throw Error("Hourly grid does not cover this TLT premarket");
    const bars = parseMarketHistoryHours(captured, "TLT", grid, basis);
    if (bars[0].symbol_id !== MARKET_HISTORY_ETF_IDS.TLT) throw Error("TLT hourly instrument changed");
    return { from, through, bars: new Map(bars.map(bar => [Date.parse(bar.timestamp), bar])), capturedAt: captured.capturedAt };
  });
  const windows = [0, 2].map(i => {
    const half = native[i], whole = native[i + 1];
    if (half.from !== whole.from || half.through !== whole.through) throw Error("Mismatched native TLT query ranges");
    const required = [0, 1, 2, 3, 4].map(h => whole.bars.get(c.first + h * hour));
    required.push(half.bars.get(c.last + minute - hour));
    const bars = required.filter(b => b !== undefined);
    if (bars.length !== 6) throw Error("Missing complete premarket hour");
    return bars;
  });
  if (windows[0].some((bar, i) => (["open", "high", "low", "close"] as const).some(field =>
    bar[field] !== windows[1][i][field]))) throw Error("Raw and split-only TLT premarket disagree");
  return {
    changePct: Number((100 * (windows[0][5].close / windows[0][0].open - 1)).toFixed(1)) || 0,
    capturedAt: native.map(l => l.capturedAt).sort().at(-1)!
  };
}

export function replayTltPremarket(review: Review, originals: Hours[], asOf: string) {
  if (review.method !== policy || !rangeInstant(review.approvedAt) || review.approvedAt > asOf ||
    !Array.isArray(review.native) || review.native.length !== 4 || !review.native.every(validId) ||
    originals.length !== 4 || originals.some((d, i) => digest(d) !== review.native[i]))
    throw Error("Invalid sealed TLT premarket review");
  const vintageAt = sourceVintage(review.catalogue, review.session, review.approvedAt);
  const activeMinutes = marketHistoryPremarketMinutes(review.minuteMap, review.session, review.approvedAt);
  const { changePct, capturedAt } = marketHistoryPremarketChange(originals, review.session, review.approvedAt);
  const retrievedAt = [capturedAt, review.catalogue.retrievedAt, review.minuteMap.retrievedAt].sort().at(-1)!;
  return tltPremarketSignal({
    session: review.session, changePct, activeMinutes, approvedAt: review.approvedAt,
    retrievedAt, vintageAt, sha256: digest(review)
  }, asOf);
}

async function object(root: string, id: string) {
  if (!validId(id)) throw Error("Invalid TLT premarket object identity");
  for (const directory of [join(rootPath(root), "regular-session-ranges-v1", "objects"), join(store(root), "objects")]) {
    const native = await readResearchReceipt<Hours>(join(directory, id + ".json"));
    if (native && digest(native) === id) return native;
  }
  throw Error("Missing or changed TLT premarket original");
}

export async function loadTltPremarket(root: string, asOf: string) {
  const session = latestFirstRateSession(asOf);
  const saved = await readResearchReceipt<{ review: Review; sha256: string }>(join(store(root), session + ".json"));
  if (!saved || saved.review.approvedAt > asOf) return null;
  if (saved.review.session !== session || digest(saved.review) !== saved.sha256 || !Array.isArray(saved.review.native) ||
    saved.review.native.length !== 4) throw Error("Dated TLT premarket receipt changed");
  return replayTltPremarket(saved.review, await Promise.all(saved.review.native.map(id => object(root, id))), asOf);
}

export async function prepareTltPremarket(root: string, opts: {
  live: boolean; fetcher?: typeof fetch; clock?: () => string;
  environmentKey?: string; signal?: AbortSignal
}) {
  const clock = opts.clock ?? clockNow, at = clock(), session = latestFirstRateSession(at);
  const { earliest, expires } = tltPremarketClocks(session);
  if (at >= expires) return { session, status: "expired" };
  if (at < earliest) return { session, status: "source_delay" };
  if (!opts.live) return { session, status: (await loadTltPremarket(root, at)) ? "cached" : "skipped_public_only" };
  const dir = store(root);
  await durableDirectory(dir, 0o700);
  const release = await acquirePublicationLock(dir, "tlt-prior-premarket");
  let failure: { error: unknown } | undefined;
  try {
    if (await loadTltPremarket(root, clock())) return { session, status: "cached" };
    const timeout = AbortSignal.timeout(24_000), signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    const upstream = opts.fetcher ?? fetch;
    const fetcher: typeof fetch = (url, init) => upstream(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
    async function obtain(path: string): Promise<PublicOriginal> {
      let status = 0;
      const { text, sha256, headers } = await marketHistoryPreview(path, async (url, init) => {
        const response = await fetcher(url, init);
        status = response.status;
        return response;
      });
      return { source: host + path, status, contentType: headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "",
        charged: headers.get("x-bars-charged"), text, sha256, date: headers.get("date") ?? "", retrievedAt: clock() };
    }
    const catalogue = await obtain(instrument);
    sourceVintage(catalogue, session, clock());
    const minuteMap = await obtain(coveragePath(session));
    marketHistoryPremarketMinutes(minuteMap, session, clock());
    let originals: Hours[] | undefined;
    try {
      originals = (await reviewedMarketHistoryRangeSources(root, "TLT", session, clock()))?.native;
      if (originals) marketHistoryPremarketChange(originals, session, clock());
    } catch {
      // Preserve a damaged or core-only range receipt. A fresh approved premarket query can still qualify.
      originals = undefined;
    }
    if (!originals) {
      const credentials = opts.environmentKey ?? process.env.MARKET_HISTORY_KEY ??
        (await readResearchReceipt<{ apiKey: string }>(join(rootPath(root), "credentials.json")))?.apiKey;
      if (!credentials) return { session, status: "awaiting_free_account" };
      const fees = await authenticatedFreeMarketHistoryResponse(
        "https://getmarkethistory.com/query/v1/fee-rules?dataset=stocks%2Fus&scheme=regulatory_levy&at=" + session,
        credentials, fetcher, signal);
      let remaining: number;
      try {
        if (fees.headers.has("x-bars-charged") && fees.headers.get("x-bars-charged") !== "0")
          throw Error("Unexpected charge on Market History free balance check");
        remaining = freeMarketHistoryBalance(fees.headers);
        // A one-day hourly query is billed in units of 100 bars. There are four grids.
        if (remaining < 400) throw Error("Insufficient included bars for the four TLT grids");
      } finally { await fees.body?.cancel(); }
      const account: FreeHourlyAccount = { key: credentials, remaining, signal };
      originals = [];
      // A failed four-leg comparison is left pending; a later source correction can be verified on retry.
      for (const [grid, basis] of positions)
        originals.push(await fetchFreeEtfHours("TLT", session, session, grid, account, fetcher, basis));
    }
    const verifiedAt = clock();
    if (verifiedAt >= expires) return { session, status: "expired" };
    const native = originals.map(digest);
    const review: Review = { method: policy, session, catalogue, minuteMap, approvedAt: verifiedAt, native };
    const sample = replayTltPremarket(review, originals, verifiedAt);
    for (const [i, id] of native.entries()) {
      const common = await readResearchReceipt<Hours>(join(rootPath(root), "regular-session-ranges-v1", "objects", id + ".json"));
      if (common && digest(common) === id) continue;
      const name = join(dir, "objects", id + ".json"), existing = await readResearchReceipt<Hours>(name);
      if (existing) { if (digest(existing) !== id) throw Error("TLT content address changed"); }
      else await durableJSON(name, originals[i], true);
    }
    const approvedAt = clock();
    if (approvedAt >= expires) return { session, status: "expired" };
    if (approvedAt < verifiedAt) throw Error("TLT premarket approval clock moved backwards");
    review.approvedAt = approvedAt;
    await durableJSON(join(dir, session + ".json"), { review, sha256: digest(review) }, true);
    return { session, status: sample.status, approvedAt };
  } catch (error) {
    failure = { error };
    throw error;
  } finally { await finishPublicationLock(release, failure); }
}
