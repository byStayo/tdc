import { createHash } from "node:crypto";
import { sourceChunk, sourceResponse } from "./source-failure.ts";
import { freeMarketHistoryBalance, MARKET_HISTORY_ETF_IDS, type MarketHistoryETF } from "./market-history-boundaries.ts";
import type { DeliveredMarketHistoryHours, MarketHistoryGrid } from "./market-history-closes.ts";

export function etfHourSource(symbol: MarketHistoryETF, from: string, through: string, grid: MarketHistoryGrid) {
  if (!Object.hasOwn(MARKET_HISTORY_ETF_IDS, symbol)) throw new Error("Unsupported Market History ETF");
  const validDay = (day: string) => /^\d{4}-\d\d-\d\d$/.test(day) && Number.isFinite(Date.parse(day)) &&
    new Date(day).toISOString().slice(0, 10) === day;
  if (!validDay(from) || !validDay(through) || from > through || Date.parse(through) - Date.parse(from) > 35 * 86_400_000 ||
      !["exchange", "Asia/Kolkata"].includes(grid)) throw new Error(`Invalid bounded ${symbol} hourly request`);
  const url = new URL(`https://getmarkethistory.com/query/v1/bars/stocks/us/${symbol}/1h`);
  url.search = new URLSearchParams({ start: from, end: through, feed: "consolidated", adjust: "raw", tz: grid,
    limit: "5000", format: "jsonl" }).toString();
  return url.href;
}

export function tltHourSource(from: string, through: string, grid: MarketHistoryGrid) {
  return etfHourSource("TLT", from, through, grid);
}

export type FreeHourlyAccount = { key: string; remaining?: number };

export function fetchFreeTltHours(from: string, through: string, grid: MarketHistoryGrid,
  account: FreeHourlyAccount, fetcher: typeof fetch = fetch) {
  return fetchFreeEtfHours("TLT", from, through, grid, account, fetcher);
}

/** Only authenticated read requests to the provider's official authority. It receives the key in the header. */
export async function fetchFreeEtfHours(symbol: MarketHistoryETF, from: string, through: string, grid: MarketHistoryGrid,
  account: FreeHourlyAccount, fetcher: typeof fetch = fetch): Promise<DeliveredMarketHistoryHours> {
  const source = etfHourSource(symbol, from, through, grid);
  if (typeof account.key !== "string" || !account.key.trim() || /[\r\n]/.test(account.key)) throw new Error("Invalid owner-provided Market History key");
  const authenticated = (url: string) => sourceResponse(fetcher, url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(25_000),
    headers: { Authorization: "Bearer " + account.key, Accept: "application/x-ndjson" } });
  if (account.remaining === undefined) {
    // This authenticated endpoint is unmetered. A mixed balance has no documented free-first spending order.
    const status = await authenticated("https://getmarkethistory.com/query/v1/fee-rules?dataset=stocks%2Fus&scheme=regulatory_levy&at=" + through);
    try { account.remaining = freeMarketHistoryBalance(status.headers); } finally { await status.body?.cancel(); }
  }
  const maxBars = Math.ceil(((Date.parse(through) - Date.parse(from)) / 3_600_000 + 25) / 100) * 100;
  if (account.remaining < maxBars) throw new Error("Market History free allowance cannot cover this bounded hourly request");
  const response = await authenticated(source);
  const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await sourceChunk(reader);
      if (part.done) break;
      length += part.value.length;
      if (length > 2_000_000) throw new Error("Market History response exceeds the private capture bound");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const headers = Object.fromEntries(["content-type", "date", "x-feed", "x-session", "x-row-count", "x-data-through",
    "x-bars-charged", "x-bars-remaining", "x-bars-paid-remaining", "x-cap-remaining", "x-next-cursor", "x-limit-clamped", "link"]
    .flatMap(h => response.headers.has(h) ? [[h, response.headers.get(h)!]] : []));
  account.remaining = freeMarketHistoryBalance(response.headers);
  return { source, status: response.status, headers, sha256: createHash("sha256").update(bytes).digest("hex"), text };
}
