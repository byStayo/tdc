import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { historicalResearchSessions } from "../lib/consensus/research-session-calendar.ts";
import { parseRangePage, rangeDelivery, rangeFeatures } from "../scripts/research-spy-close-location.ts";

const route = "bars/stocks/us/SPY/1d?start=2025-01-01T05%3A00%3A00Z&end=2026-01-01T05%3A00%3A00Z&tz=exchange&limit=1000";
const fixture = { symbol: "SPY", symbol_id: 1, timestamp: "2025-03-07T05:00:00Z",
  open: 100, high: 108, low: 96, close: 105, vwap: 103, trade_count: 55, volume: 80, is_gap: false, gap_fill_method: 0 };

function preview(raw: unknown = fixture) {
  const text = JSON.stringify(raw);
  return { source: "https://getmarkethistory.com/api/v1/" + route, attemptedAt: "2026-11-24T01:00:00.000Z",
    capturedAt: "2026-11-24T01:00:01.000Z", sha256: createHash("sha256").update(text).digest("hex"), text,
    headers: { "content-type": "application/x-ndjson", "x-feed": "consolidated", "x-format": "jsonl",
      "x-session": "venue America/New_York 00:00", "x-row-count": "1", "x-data-through": "2026-11-21T00:59:00Z",
      "x-preview-from": "2024-11-22T00:00:00Z", "x-bars-charged": null } };
}

test("the full New York civil day ages 48 hours before the next nightly load in both DST regimes", () => {
  assert.deepEqual(rangeDelivery("2025-03-07"), { dayEndedAt: "2025-03-08T05:00:00.000Z",
    start: "2025-03-11T03:00:00.000Z", available: "2025-03-11T07:00:00.000Z" });
  assert.deepEqual(rangeDelivery("2025-10-31"), { dayEndedAt: "2025-11-01T04:00:00.000Z",
    start: "2025-11-04T03:00:00.000Z", available: "2025-11-04T07:00:00.000Z" });
});

test("only the dated raw consolidated New York midnight preview supplies the input", () => {
  const good = preview(), sealedAt = "2026-11-23T00:00:00Z";
  assert.equal(parseRangePage(good, route, sealedAt).length, 1);
  const headerChanges: Record<string, string>[] = [
    { "x-feed": "iex" }, { "x-session": "UTC 00:00" }, { "x-bars-charged": "1" }, { "x-row-count": "2" },
    { "x-preview-from": "2025-02-01T00:00:00Z" }, { "x-data-through": "2025-03-07T05:00:00Z" },
  ];
  for (const headers of headerChanges) assert.throws(() => parseRangePage({ ...good, headers: { ...good.headers, ...headers } }, route, sealedAt));
  for (const wrong of [{ timestamp: "2025-03-07T00:00:00Z" }, { symbol: "QQQ" }, { timestamp: "2026-01-02T05:00:00Z" }])
    assert.throws(() => parseRangePage(preview({ ...fixture, ...wrong }), route, sealedAt));
  assert.throws(() => parseRangePage({ ...good, sha256: "0".repeat(64) }, route, sealedAt));
  assert.throws(() => parseRangePage(good, route, "2026-11-25T00:00:00Z"));
});

test("the candidate and control share the exact source day and duplicate arrivals choose the latest", () => {
  const days = historicalResearchSessions(2025);
  const bars = new Map([["2025-03-05", { ...fixture, close: 97 }], ["2025-03-06", fixture], ["2025-03-07", fixture]]);
  const { features } = rangeFeatures(bars, days);
  const monday = features.get("2025-03-10")!, tuesday = features.get("2025-03-11")!;
  assert.equal(monday.observed, "2025-03-06");
  assert.equal(monday.location, 0.5);
  assert.equal(monday.control, Math.log(105 / 100));
  assert.equal(tuesday.observed, "2025-03-07");
  assert.equal(tuesday.issuedAt, "2025-03-11T11:48:00.000Z");
  assert.equal(new Set([...features.values()].map(row => row.observed)).size, features.size);
});

test("missing, synthetic, zero-range and shortened days cannot fall back to older data", () => {
  const days = historicalResearchSessions(2025);
  for (const bad of [undefined, { ...fixture, high: 100, low: 100, close: 100 }, { ...fixture, is_gap: true }, { ...fixture, trade_count: 0 }]) {
    const bars = new Map([["2025-03-05", fixture], ["2025-11-28", fixture]]);
    if (bad) bars.set("2025-03-06", bad);
    const { excluded, features } = rangeFeatures(bars, days);
    assert.equal(features.has("2025-03-10"), false);
    assert.match(excluded["2025-03-10"], /missing, invalid or zero-range/);
    assert.match(excluded["2025-12-02"], /shortened/);
  }
});
