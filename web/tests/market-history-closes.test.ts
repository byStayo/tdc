import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { coreSessionCloses, closeMomentum, parseMarketHistoryHours, reconcileCoreCloses, fetchMarketHistoryHours } from "../lib/consensus/market-history-closes.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { historicalResearchSession } from "../lib/consensus/research-session-calendar.ts";

const row = (timestamp: string, close = 100) => ({
  timestamp, symbol: "TLT", symbol_id: 11418, open: 100, high: 102, low: 98, close,
  volume: 1000, vwap: 100, trade_count: 10, is_gap: false, gap_fill_method: 0,
});
const receipt = (rows: ReturnType<typeof row>[]) => {
  const text = rows.map(bar => JSON.stringify(bar)).join("\n") + "\n";
  return { source: "https://getmarkethistory.com/api/v1/bars/stocks/us/TLT/1h?start=2026-10-30&end=2026-11-02&adjust=raw&feed=consolidated",
    text, sha256: createHash("sha256").update(text).digest("hex"), capturedAt: "2026-11-03T12:00:00.000Z",
    through: "2026-11-02T23:56:00Z", count: rows.length };
};

test("hourly parser rejects mutated bodies, duplicate timestamps and gap-filled rows", () => {
  const valid = receipt([row("2026-10-30T19:00:00Z"), row("2026-11-02T20:00:00Z")]);
  assert.equal(parseMarketHistoryHours(valid, "TLT").length, 2);
  assert.throws(() => parseMarketHistoryHours({ ...valid, text: valid.text + "\n" }, "TLT"), /hash/);
  assert.throws(() => parseMarketHistoryHours(receipt([row("2026-11-02T20:00:00Z"), row("2026-11-02T20:00:00Z")]), "TLT"), /ordered/);
  const gap = { ...row("2026-11-02T20:00:00Z"), is_gap: true };
  assert.throws(() => parseMarketHistoryHours(receipt([gap]), "TLT"), /hourly/);
});

test("hourly receipt accepts ordinary ISO milliseconds and rejects changing instrument identity", () => {
  const valid = receipt([row("2026-10-30T19:00:00Z"), row("2026-11-02T20:00:00Z")]);
  assert.equal(parseMarketHistoryHours({ ...valid, capturedAt: "2026-11-03T12:00:00.583Z" }, "TLT").length, 2);
  assert.equal(parseMarketHistoryHours(receipt([row("2026-10-30T19:00:00.000Z")]), "TLT").length, 1);
  const changed = { ...row("2026-11-02T20:00:00Z"), symbol_id: 999 };
  assert.throws(() => parseMarketHistoryHours(receipt([row("2026-10-30T19:00:00Z"), changed]), "TLT"), /identity/);
});

test("free fetch follows complete consolidated pages and rejects a charged response", async () => {
  const first = row("2026-10-30T19:00:00Z"), second = row("2026-11-02T20:00:00Z");
  const calls: string[] = [];
  const capture = await fetchMarketHistoryHours("TLT", "2026-10-30", "2026-11-02", async input => {
    const url = new URL(input);
    calls.push(url.href);
    return new Response(JSON.stringify(url.searchParams.has("cursor") ? second : first) + "\n", {
      headers: { "content-type": "application/x-ndjson", "x-feed": "consolidated",
        "x-row-count": "1", "x-data-through": "2026-11-02T23:56:00Z", "x-bars-charged": "0",
        ...(!url.searchParams.has("cursor") ? { "x-next-cursor": "page-two" } : {}) },
    });
  });
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]).searchParams.get("cursor"), "page-two");
  assert.equal(capture.count, 2);
  assert.equal(parseMarketHistoryHours(capture, "TLT").length, 2);
  let cancelled = false;
  const chargedBody = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("{}")); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(fetchMarketHistoryHours("TLT", "2026-10-30", "2026-11-02", async () => new Response(chargedBody, {
    headers: { "content-type": "application/x-ndjson", "x-feed": "consolidated", "x-row-count": "1",
      "x-data-through": "2026-11-02T23:56:00Z", "x-bars-charged": "100" },
  })), /free/);
  assert.equal(cancelled, true);
});

test("core closes use the final complete hourly bucket at normal and shortened closes", () => {
  const calendar = [historicalResearchSession("2025-07-02")!, historicalResearchSession("2025-07-03")!];
  const hours = [
    row("2025-07-02T19:00:00Z", 101), row("2025-07-02T20:00:00Z", 99),
    row("2025-07-03T16:00:00Z", 102), row("2025-07-03T17:00:00Z", 98),
  ];
  const result = coreSessionCloses(hours, calendar, "2025-07-03T21:00:00Z");
  assert.deepEqual(result.closes.map(bar => [bar.session, bar.close]), [["2025-07-02", 101], ["2025-07-03", 102]]);
  assert.equal(Object.hasOwn(result.closes[0], "open"), false);
  assert.equal(result.closes[1].earlyClose, true);
  const incomplete = coreSessionCloses(hours, calendar, "2025-07-03T16:59:00Z");
  assert.deepEqual(incomplete.missingSessions, ["2025-07-03"]);
});

test("close momentum preserves a missing exchange session and applies cash only before the ex-date", () => {
  const dates = exchangeSessions("2026-10-26", "2026-11-02");
  const closes = dates.map(session => ({ session, closeAt: exchangeSession(session)!.closeAt,
    bucketAt: new Date(Date.parse(exchangeSession(session)!.closeAt) - 3600000).toISOString(),
    close: session === "2026-11-02" ? 100 : 101, earlyClose: false }));
  const cash = [{ session: "2026-11-02", amount: 1 }];
  const result = closeMomentum(closes, dates, cash);
  assert.equal(result[0].sessions, 1);
  assert.ok(Math.abs(result[0].rawChangePct! + 0.990099) < 0.000001);
  assert.equal(result[0].issuerAdjustedChangePct, 0);
  assert.ok(Math.abs(result[0].cashEffectBps! - 99.0099) < 0.0001);
  assert.equal(result[1].sessions, 5);
  assert.equal(result[1].issuerAdjustedChangePct, 0);
  const gap = closeMomentum(closes.filter(bar => bar.session !== "2026-10-29"), dates, cash);
  assert.equal(gap[0].status, "contiguous");
  assert.equal(gap[1].status, "gap");
  assert.equal(gap[1].rawChangePct, null);
});

test("close reconciliation reports missing controls and differing closes independently", () => {
  const dates = ["2026-10-29", "2026-10-30", "2026-11-02"];
  const closes = dates.map(session => ({ session, closeAt: exchangeSession(session)!.closeAt,
    bucketAt: new Date(Date.parse(exchangeSession(session)!.closeAt) - 3600000).toISOString(),
    close: 100, earlyClose: false }));
  const raw = [{ session: dates[0], close: 100 }, { session: dates[1], close: 99.8 }];
  const split = dates.map(session => ({ session, close: 100 }));
  const result = reconcileCoreCloses(closes, raw, split);
  assert.equal(result.raw.compared, 2);
  assert.equal(result.raw.matched, 1);
  assert.equal(result.raw.missing, 1);
  assert.equal(result.splits.matched, 3);
  assert.equal(result.qualified, false);
  assert.ok(result.raw.maxErrorBps > 20);
});
