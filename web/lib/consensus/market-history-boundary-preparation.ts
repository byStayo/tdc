import { resolve } from "node:path";
import { exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { sourceChunk, sourceResponse } from "./source-failure.ts";
import { newYorkDate } from "./time.ts";

type Summary = { scope: string; from: string; through: string; completeHourlyGrids: number; matched: number;
  sessions: number; adjustedSessions: number; settlementSessions: number; receipt: string };
type Catalogue = { dataset: string; ticker: string; contract: { exchange: string; status: string };
  bars: { timeframes: { timeframe: string; feed: string; venue: string; updated: string; last: string }[] } };
type Run = (from: string, through: string) => Promise<Summary>;
const catalogue = "https://getmarkethistory.com/api/v1/stocks/us/TLT";

/** The scheduled run uses the public catalogue to avoid spending free bars on an undelivered session. */
export async function prepareTltBoundaryQualification(root: string, run: Run, { cutoff = new Date().toISOString(),
  environmentKey = process.env.MARKET_HISTORY_KEY, fetcher = fetch } = {}) {
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
  const today = newYorkDate(cutoff), start = new Date(Date.parse(today) - 35 * 86_400_000).toISOString().slice(0, 10);
  const dates = exchangeSessions(start, today).filter(day => Date.parse(exchangeSession(day)!.closeAt) <= asOf);
  const available = dates.filter(day => Date.parse(exchangeSession(day)!.closeAt) <= delivered);
  const through = available.at(-1), expected = dates.at(-1);
  if (!through) return { status: "awaiting_consolidated_prices", expected, dataThrough: series.last };
  const output = await run(available[0], through);
  if (output.scope !== "private-source-qualification" || output.from !== available[0] || output.through !== through ||
      output.sessions !== available.length || !/^[a-f0-9]{64}$/.test(output.receipt) ||
      !Number.isInteger(output.completeHourlyGrids) || output.completeHourlyGrids < 0 || output.completeHourlyGrids > 2 ||
      !Number.isInteger(output.matched) || output.matched < 0 || output.matched > output.sessions ||
      !Number.isInteger(output.adjustedSessions) || output.adjustedSessions < 0 || output.adjustedSessions > output.matched ||
      ![0, output.adjustedSessions].includes(output.settlementSessions) ||
      (output.matched > 0 && output.completeHourlyGrids !== 2)) throw new Error("Unverified TLT qualification summary");
  return { status: output.settlementSessions === output.sessions ? "verified_private_settlement" :
    output.settlementSessions ? "partial_private_settlement" : "candidate_pending",
    expected, through, dataThrough: series.last, sessions: output.sessions, matched: output.matched,
    completeHourlyGrids: output.completeHourlyGrids, adjustedSessions: output.adjustedSessions, settlementSessions: output.settlementSessions, receipt: output.receipt };
}
