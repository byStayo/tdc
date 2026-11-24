import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  boundaryClock,
  marketHistoryBoundaries,
  MARKET_HISTORY_ETF_IDS,
  type MarketHistoryETF,
} from "../lib/consensus/market-history-boundaries.ts";
import type {
  DeliveredMarketHistoryHours,
  MarketHistoryGrid,
} from "../lib/consensus/market-history-closes.ts";
import {
  etfHourSource,
  fetchFreeEtfHours,
} from "../lib/consensus/market-history-hourly-access.ts";
import { endpointDifferences } from "../scripts/qualify-market-history-etfs.ts";

const day = "2026-11-20";
const clock = boundaryClock(day)!;
const cutoff = "2026-11-24T07:00:01.000Z";
function delivery(
  symbol: MarketHistoryETF,
  grid: MarketHistoryGrid,
  id: number,
): DeliveredMarketHistoryHours {
  const timestamp =
    grid === "Asia/Kolkata"
      ? clock.openAt
      : new Date(Date.parse(clock.closeAt) - 3600000).toISOString();
  const text =
    JSON.stringify({
      timestamp,
      symbol,
      symbol_id: id,
      open: 10,
      high: 11,
      low: 9,
      close: 10.5,
      volume: 100,
      vwap: 10,
      trade_count: 5,
      is_gap: false,
      gap_fill_method: 0,
    }) + "\n";
  return {
    source: etfHourSource(symbol, day, day, grid),
    status: 200,
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    headers: {
      date: "Tue, 24 Nov 2026 07:00:00 GMT",
      "content-type": "application/x-ndjson",
      "x-feed": "consolidated",
      "x-session":
        grid === "exchange"
          ? "exchange America/New_York 00:00"
          : "Asia/Kolkata 00:00",
      "x-row-count": "1",
      "x-bars-charged": "100",
      "x-data-through": clock.closeAt,
    },
  };
}

test("each signed ETF grid must match the original instrument identity, symbol, timezone and scheduled boundary", () => {
  for (const [key, id] of Object.entries(MARKET_HISTORY_ETF_IDS)) {
    const symbol = key as MarketHistoryETF,
      opening = delivery(symbol, "Asia/Kolkata", id),
      closing = delivery(symbol, "exchange", id);
    const [boundary] = marketHistoryBoundaries(
      opening,
      closing,
      [clock],
      cutoff,
      symbol,
    );
    assert.equal(boundary.openingBucket, clock.openAt);
    assert.deepEqual(
      endpointDifferences(boundary, { session: day, open: 10, close: 10.5 }),
      { openBps: 0, closeBps: 0, directionMatches: true },
    );
    assert.throws(
      () =>
        marketHistoryBoundaries(
          opening,
          delivery(symbol, "exchange", id + 1),
          [clock],
          cutoff,
          symbol,
        ),
      /instrument ID/,
    );
    assert.equal(
      endpointDifferences(boundary, {
        session: "2026-11-19",
        open: 10,
        close: 10.5,
      }),
      null,
    );
    assert.throws(
      () =>
        endpointDifferences(boundary, { session: day, open: NaN, close: 10 }),
      /finite/,
    );
  }
});

test("unsupported symbols and a nonfree balance stop before the signed ETF query", async () => {
  assert.throws(
    () => etfHourSource("../bad" as MarketHistoryETF, day, day, "exchange"),
    /Unsupported/,
  );
  let calls = 0;
  await assert.rejects(
    fetchFreeEtfHours(
      "DIA",
      day,
      day,
      "exchange",
      { key: "demo-private" },
      async (url, init) => {
        calls++;
        assert.equal(new URL(String(url)).pathname, "/query/v1/fee-rules");
        assert.equal(init?.redirect, "error");
        return new Response("[]", {
          headers: { "x-bars-remaining": "500", "x-bars-paid-remaining": "1" },
        });
      },
    ),
    /free-only/,
  );
  assert.equal(calls, 1);
});
