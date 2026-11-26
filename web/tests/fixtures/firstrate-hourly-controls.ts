import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { marketHistoryActionCachePath, sealMarketHistoryActionCapture } from "../../lib/consensus/market-history-actions.ts";
import { MARKET_HISTORY_ETF_IDS, type MarketHistoryETF } from "../../lib/consensus/market-history-boundaries.ts";
import { etfHourSource } from "../../lib/consensus/market-history-hourly-access.ts";
import type { DeliveredMarketHistoryHours, MarketHistoryAdjustment, MarketHistoryGrid } from "../../lib/consensus/market-history-closes.ts";
import type { SessionPrice } from "../../lib/consensus/evaluation.ts";

export function hourlyFixture(symbol: MarketHistoryETF, sessions: SessionPrice[], adjustment: MarketHistoryAdjustment,
  grid: MarketHistoryGrid, priceFactor = 1): DeliveredMarketHistoryHours {
  const from = sessions[0].session, through = sessions.at(-1)!.session;
  const text = sessions.map(row => {
    const open = row.open * priceFactor, close = row.close * priceFactor;
    return JSON.stringify({ symbol, symbol_id: MARKET_HISTORY_ETF_IDS[symbol],
      timestamp: grid === "exchange" ? new Date(Date.parse(row.closeAt) - 3_600_000).toISOString() : row.openAt,
      open, close, high: Math.max(open, close), low: Math.min(open, close), volume: 1000, vwap: (open + close) / 2,
      trade_count: 10, is_gap: false, gap_fill_method: 0 });
  }).join("\n") + "\n";
  return { source: etfHourSource(symbol, from, through, grid, adjustment), status: 200,
    sha256: createHash("sha256").update(text).digest("hex"), text,
    headers: { date: new Date(through + "T23:00:00Z").toUTCString(), "x-data-through": through + "T22:58:00Z",
      "x-session": grid === "exchange" ? "exchange America/New_York 00:00" : "Asia/Kolkata 00:00",
      "x-feed": "consolidated", "content-type": "application/x-ndjson", "x-row-count": String(sessions.length),
      "x-bars-charged": "100", "x-bars-remaining": "3000", "x-bars-paid-remaining": "0" } };
}

export async function writeHourlyFixtures(root: string, symbol: MarketHistoryETF, sessions: SessionPrice[]) {
  const store = resolve(root, ".consensus/private-market-history/firstrate-controls");
  await mkdir(store, { recursive: true, mode: 0o700 });
  const from = sessions[0].session, through = sessions.at(-1)!.session;
  const source = new URL("https://getmarkethistory.com/query/v1/corporate-actions");
  source.search = new URLSearchParams({ dataset: "stocks/us", ticker: symbol, start: from, end: through, format: "jsonl" }).toString();
  const path = marketHistoryActionCachePath(root, symbol, from, through);
  const receivedAt = through + "T23:01:01.000Z";
  const capture = { source: source.href, receivedAt, raw: "", sha256: createHash("sha256").update("").digest("hex"),
    headers: { date: new Date(receivedAt).toUTCString(), "x-row-count": "0", "x-bars-charged": "0",
      "x-bars-paid-remaining": "0", "content-type": "application/x-ndjson" } };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(sealMarketHistoryActionCapture(capture)), { mode: 0o600 });
  for (const adjustment of ["raw", "splits"] as const) for (const grid of ["Asia/Kolkata", "exchange"] as const) {
    const file = [symbol, sessions[0].session, sessions.at(-1)!.session, adjustment, grid === "exchange" ? "close" : "open"].join("-") + ".json";
    await writeFile(resolve(store, file), JSON.stringify(hourlyFixture(symbol, sessions, adjustment, grid)), { mode: 0o600 });
  }
}
