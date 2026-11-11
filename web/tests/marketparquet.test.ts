import assert from "node:assert/strict";
import test from "node:test";
import { ETF_SYMBOLS, marketParquetEvidence, type MarketParquetDay } from "../lib/consensus/marketparquet.ts";
import { exchangeSessions } from "../lib/consensus/exchange-calendar.ts";

const calendar = exchangeSessions("2026-10-30", "2026-11-04");
const cash = { SPY: [], QQQ: [], IWM: [], DIA: [], TLT: [{ session: "2026-11-02", amount: 0.343177 }] };
const file = (session: string) => ({
  session, sha256: "a".repeat(64),
  bars: Object.fromEntries(ETF_SYMBOLS.map(symbol => [symbol, { open: 90, close: 100 }])) as MarketParquetDay["bars"],
});

test("applies issuer cash to both earlier endpoints on the vendor split-adjusted basis", () => {
  const prices = marketParquetEvidence(calendar, calendar.map(file), cash);
  const tlt = prices.find(series => series.instrument === "TLT")!.sessions;
  const factor = (100 - 0.343177) / 100;
  assert.equal(tlt[0].open, 90 * factor);
  assert.equal(tlt[0].close, 100 * factor);
  assert.equal(tlt[1].open, 90);
  assert.equal(tlt[1].close, 100);
  assert.equal(prices[0].sessions[0].open, 90);
});

test("preserves calendar gaps and prevents a dividend factor from crossing missing bars", () => {
  const files = calendar.filter(session => session !== "2026-11-02").map(file);
  const prices = marketParquetEvidence(calendar, files, cash);
  const tlt = prices.find(series => series.instrument === "TLT")!;
  assert.deepEqual(tlt.expectedSessions, calendar);
  assert.deepEqual(tlt.sessions.map(row => row.session), files.map(row => row.session));
  assert.equal(tlt.sessions[0].open, 90);
});

test("rejects a session when any ETF is absent", () => {
  const incomplete = file(calendar[0]);
  delete (incomplete.bars as Partial<MarketParquetDay["bars"]>).TLT;
  assert.throws(() => marketParquetEvidence(calendar, [incomplete], cash), /Incomplete/);
});
