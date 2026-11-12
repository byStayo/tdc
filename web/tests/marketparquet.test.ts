import assert from "node:assert/strict";
import test from "node:test";
import { ETF_SYMBOLS, marketParquetEvidence, reconcileMarketParquet, reviewedMarketParquetDays, type MarketParquetDay, type ReferenceBars } from "../lib/consensus/marketparquet.ts";
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

const dividendCalendar = exchangeSessions("2026-11-19", "2026-11-30");
const bar = (session: string, open = 90, close = 100) => ({
  session, sha256: "a".repeat(64),
  bars: Object.fromEntries(ETF_SYMBOLS.map(symbol => [symbol, { open, close }])) as MarketParquetDay["bars"],
});
const referenceFor = (files: MarketParquetDay[]) => Object.fromEntries(ETF_SYMBOLS.map(symbol =>
  [symbol, files.map(row => ({ session: row.session, ...row.bars[symbol] }))])) as ReferenceBars;
const noCash = { SPY: [], QQQ: [], IWM: [], DIA: [], TLT: [] };
const strict = { openBps: 0.5, closeBps: 0.5 };

test("keeps an early close out of the evidence until a review lists it", () => {
  const files = dividendCalendar.map(session => bar(session));
  assert.ok(!reviewedMarketParquetDays(files, []).some(row => row.session === "2026-11-27"));
  assert.equal(reviewedMarketParquetDays(files, ["2026-11-27"]).length, files.length);
  const gap = marketParquetEvidence(dividendCalendar, reviewedMarketParquetDays(files, []), noCash);
  assert.ok(!gap[0].sessions.some(row => row.session === "2026-11-27"));
});

test("reconciles every session, an ex-date boundary and an early close against the reference", () => {
  const files = dividendCalendar.map(session => bar(session));
  const result = reconcileMarketParquet(dividendCalendar, files,
    { ...noCash, DIA: [{ session: "2026-11-20", amount: 0.11 }] }, referenceFor(files), strict);
  assert.equal(result.passed, true);
  assert.equal(result.verifiedThrough, "2026-11-30");
  assert.deepEqual(result.earlyClosesVerified, ["2026-11-27"]);
  assert.deepEqual(result.boundarySymbolsVerified, ["DIA"]);
});

test("leaves a boundary unresolved when the vendor close already reflects the distribution", () => {
  const files = dividendCalendar.map(session => bar(session));
  const reference = referenceFor(files);
  // As-traded close on the prior session sits one distribution above the vendor's.
  reference.DIA[0] = { ...reference.DIA[0], close: 100.11 };
  const result = reconcileMarketParquet(dividendCalendar, files,
    { ...noCash, DIA: [{ session: "2026-11-20", amount: 0.11 }] }, reference, { openBps: 3, closeBps: 15 });
  assert.equal(result.symbols.find(row => row.symbol === "DIA")!.boundaries[0].status, "unresolved");
  assert.deepEqual(result.boundarySymbolsVerified, []);
});

test("stops the verified share basis at the first differing or unmatched session", () => {
  const files = dividendCalendar.map(session => bar(session));
  const reference = referenceFor(files);
  reference.QQQ[3] = { ...reference.QQQ[3], close: 50 };
  const split = reconcileMarketParquet(dividendCalendar, files, noCash, reference, strict);
  assert.equal(split.passed, false);
  assert.equal(split.verifiedThrough, files[2].session);
  reference.QQQ.splice(3);
  const short = reconcileMarketParquet(dividendCalendar, files, noCash, reference, strict);
  assert.equal(short.verifiedThrough, files[2].session);
  assert.deepEqual(short.earlyClosesVerified, []);
});

test("reports a boundary whose prior session was not captured", () => {
  const files = dividendCalendar.slice(1).map(session => bar(session));
  const result = reconcileMarketParquet(dividendCalendar, files,
    { ...noCash, DIA: [{ session: "2026-11-20", amount: 0.11 }] }, referenceFor(files), strict);
  assert.equal(result.symbols.find(row => row.symbol === "DIA")!.boundaries[0].status, "prior-session-missing");
});
