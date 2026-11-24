import { resolve } from "node:path";
import { FIRST_PUBLIC_FORECAST } from "./cftc-release-clocks.ts";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions, hasReviewedCalendarRange, trailingExchangeSessions } from "./exchange-calendar.ts";
import { loadTltSettlement } from "./market-history-settlement.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { sourceChunk, sourceResponse } from "./source-failure.ts";
import { newYorkDate } from "./time.ts";

type Summary = { scope: string; from: string; through: string; completeHourlyGrids: number; matched: number;
  sessions: number; adjustedSessions: number; settlementSessions: number; receipt: string };
type Catalogue = { dataset: string; ticker: string; contract: { exchange: string; status: string };
  bars: { timeframes: { timeframe: string; feed: string; venue: string; updated: string; last: string }[] } };
type Run = (from: string, through: string) => Promise<Summary>;
const catalogue = "https://getmarkethistory.com/api/v1/stocks/us/TLT";
const firstForecastDate = newYorkDate(FIRST_PUBLIC_FORECAST);

function lookback(day: string) {
  const from = new Date(Date.parse(day) - 35 * 86_400_000).toISOString().slice(0, 10);
  return from < EXCHANGE_CALENDAR.from ? EXCHANGE_CALENDAR.from : from;
}

/** The scheduled run uses the public catalogue to avoid spending free bars on an undelivered session. */
export async function prepareTltBoundaryQualification(root: string, run: Run, { cutoff = new Date().toISOString(),
  environmentKey = process.env.MARKET_HISTORY_KEY, fetcher = fetch, loadSettlements = loadTltSettlement } = {}) {
  const credentials = environmentKey ? null : await readResearchReceipt<{ apiKey: string }>(
    resolve(root, ".consensus/private-market-history/credentials.json"));
  if (!environmentKey && !credentials?.apiKey) return { status: "awaiting_free_account" };
  const response = await sourceResponse(fetcher, catalogue, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(12_000) });
  const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await sourceChunk(reader);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 64_000) throw new Error("Market History TLT catalogue exceeds its response bound");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const spec: Catalogue = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const frames = spec.bars?.timeframes?.filter(row => row.timeframe === "1m" && row.feed === "consolidated" && row.venue === "US consolidated tape");
  if (spec.dataset !== "stocks/us" || spec.ticker !== "TLT" || spec.contract?.exchange !== "NASDAQ" ||
      spec.contract.status !== "active" || frames?.length !== 1) throw new Error("Unverified TLT consolidated source catalogue");
  const [series] = frames, delivered = Date.parse(series.last), updated = Date.parse(series.updated), asOf = Date.parse(cutoff);
  if (![delivered, updated, asOf].every(Number.isFinite) || delivered > updated || updated > asOf)
    throw new Error("Market History catalogue has an invalid delivery clock");
  const today = newYorkDate(cutoff);
  const dates = trailingExchangeSessions(lookback(today), today).filter(day => Date.parse(exchangeSession(day)!.closeAt) <= asOf);
  const available = dates.filter(day => Date.parse(exchangeSession(day)!.closeAt) <= delivered);
  const through = available.at(-1), expected = dates.at(-1);
  if (!through) return { status: "awaiting_consolidated_prices", expected, dataThrough: series.last };
  const eligible = trailingExchangeSessions(lookback(through), through).filter(day => day >= firstForecastDate);
  if (!eligible.length) return { status: "no_issued_targets", expected, through, dataThrough: series.last };
  const settled = await loadSettlements(root, cutoff, message => console.warn(message));
  // One revalidated span must contain every eligible day, including the interior of multi-session targets.
  // expectedSessions is the original request calendar. It may include sessions that never settled.
  const existing = settled.find(evidence => {
    const verified = new Set(evidence.sessions.map(row => row.session));
    return eligible.every(day => verified.has(day));
  });
  if (existing) {
    const covered = existing.sessions.filter(row => row.session >= lookback(through) && row.session <= through &&
      hasReviewedCalendarRange(row.session, through));
    return { status: "verified_private_settlement", reused: true, expected, from: covered[0].session, through,
      dataThrough: series.last, sessions: covered.length, matched: covered.length, completeHourlyGrids: 2,
      adjustedSessions: covered.length, settlementSessions: covered.length };
  }

  // Keep the original hourly query when it can fill a gap from updated controls. Otherwise anchor
  // the request to the delivered close so that an identical provider vintage keeps its cache keys.
  const retainedStarts = settled.filter(evidence => evidence.expectedSessions.at(-1) === through &&
    evidence.expectedSessions[0] <= eligible[0] && hasReviewedCalendarRange(evidence.expectedSessions[0], through))
    .map(evidence => evidence.expectedSessions[0]).sort();
  const from = retainedStarts.at(-1) ?? trailingExchangeSessions(lookback(through), through)[0];
  const output = await run(from, through);
  if (output.scope !== "private-source-qualification" || output.from !== from || output.through !== through ||
      output.sessions !== exchangeSessions(from, through).length || !/^[a-f0-9]{64}$/.test(output.receipt) ||
      !Number.isInteger(output.completeHourlyGrids) || output.completeHourlyGrids < 0 || output.completeHourlyGrids > 2 ||
      !Number.isInteger(output.matched) || output.matched < 0 || output.matched > output.sessions ||
      !Number.isInteger(output.adjustedSessions) || output.adjustedSessions < 0 || output.adjustedSessions > output.matched ||
      ![0, output.adjustedSessions].includes(output.settlementSessions) ||
      (output.matched > 0 && output.completeHourlyGrids !== 2)) throw new Error("Unverified TLT qualification summary");
  return { status: output.settlementSessions === output.sessions ? "verified_private_settlement" :
    output.settlementSessions ? "partial_private_settlement" : "candidate_pending",
    expected, from, through, dataThrough: series.last, sessions: output.sessions, matched: output.matched,
    completeHourlyGrids: output.completeHourlyGrids, adjustedSessions: output.adjustedSessions, settlementSessions: output.settlementSessions, receipt: output.receipt };
}
