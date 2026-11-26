import assert from "node:assert/strict";
import test from "node:test";
import { ETF_SYMBOLS, marketParquetEvidence, marketParquetIssuerFingerprints, matchesMarketParquetReview, reconcileMarketParquet, reviewedMarketParquetDays, type MarketParquetDay, type ReferenceBars } from "../lib/consensus/marketparquet.ts";
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

test("an independently confirmed dividend after an unresolved market day cannot restate earlier approved prices", () => {
  const sessions = ["2027-11-24", "2027-11-29", "2027-11-30"];
  const files = sessions.map(file);
  const cashAtNewBlock = { ...cash, TLT: [{ session: "2027-11-26", amount: 1 }, { session: "2027-11-29", amount: 3 }] };
  const prices = marketParquetEvidence(sessions, files, cashAtNewBlock);
  const tlt = prices.find(series => series.instrument === "TLT")!.sessions;
  assert.deepEqual(tlt.map(row => row.close), [100, 100, 100]);
  assert.throws(() => reconcileMarketParquet(sessions, files, cashAtNewBlock, referenceFor(files), strict),
    /contiguous reviewed coverage/);
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
  assert.equal(result.passed, false);
  assert.equal(result.verifiedThrough, "2026-11-19");
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

test("a fully matching reference cannot approve an omitted completed session", () => {
  const files = dividendCalendar.filter(day => day !== "2026-11-20").map(session => bar(session));
  const result = reconcileMarketParquet(dividendCalendar, files, noCash, referenceFor(files), strict);
  assert.equal(result.passed, false);
  assert.equal(result.verifiedThrough, "2026-11-19");
});

test("a licensed daily settlement rejects an opposite intraday direction inside both price tolerances", () => {
  const files = dividendCalendar.map(session => bar(session, 100, 100.001));
  const reference = referenceFor(files);
  reference.TLT[0] = { ...reference.TLT[0], close: 99.999 };
  const result = reconcileMarketParquet(dividendCalendar, files, noCash, reference, strict, { requireDirection: true });
  assert.equal(result.passed, false);
  assert.deepEqual(result.symbols.find(row => row.symbol === "TLT")!.differing, [dividendCalendar[0]]);
});

test("licensed reconciliation reports all reversed windows, preserves daily matches and stops the cumulative review at their first exit", () => {
  const days = exchangeSessions("2026-10-23", "2026-11-20");
  const files = days.map(day => bar(day, 100, 100.001));
  const reference = referenceFor(files);
  Object.assign(reference.DIA[4], { open: 99.99, close: 99.999 });
  // The last five sessions still rise on both feeds. Only this fund's 21-session sign reverses.
  reference.QQQ[16].open = 99.995;
  Object.assign(reference.QQQ[20], { open: 99.99, close: 99.999 });
  const compare = () => reconcileMarketParquet(days, files, noCash, reference,
    { openBps: 3, closeBps: 15 }, { requireDirection: true });
  const result = compare();
  assert.equal(result.symbols.every(row => row.matched.length === 21), true);
  assert.equal(result.passed, false);
  assert.equal(result.verifiedThrough, days[3]);
  assert.deepEqual(result.horizonDifferences.map(row => [row.symbol, row.horizon, row.from, row.through, row.vendorDirection, row.referenceDirection]).sort(), [
    ["DIA", "weekly", days[0], days[4], "up", "down"],
    ["QQQ", "monthly", days[0], days[20], "up", "down"],
  ]);
  reference.DIA.splice(2, 1);
  reference.QQQ[20].close = 100;
  const gap = compare();
  assert.deepEqual(gap.horizonDifferences.map(row => [row.symbol, row.horizon, row.referenceDirection]), [["QQQ", "monthly", "flat"]]);
  assert.equal(gap.verifiedThrough, days[1]);
});

test("compares both feeds on the issuer's dividend-adjusted basis within the holding period", () => {
  const days = exchangeSessions("2026-10-29", "2026-11-04");
  const files = days.map(day => bar(day, 99.5, 100));
  files[0].bars.TLT.open = 100;
  Object.assign(files.at(-1)!.bars.TLT, { open: 99.1, close: 99.60004 });
  const reference = referenceFor(files);
  reference.TLT[1].close = 100.02;
  const cash = { ...noCash, TLT: [{ session: days[2], amount: 0.4 }] };
  const limits = { openBps: 3, closeBps: 15 };
  assert.equal(reconcileMarketParquet(days, files, noCash, reference, limits, { requireDirection: true }).passed, true);
  const result = reconcileMarketParquet(days, files, cash, reference, limits, { requireDirection: true });
  assert.equal(result.symbols.find(row => row.symbol === "TLT")!.boundaries[0].status, "verified");
  assert.deepEqual(result.horizonDifferences, [{ symbol: "TLT", horizon: "weekly", from: days[0], through: days[4],
    vendorDirection: "up", referenceDirection: "down" }]);
});

test("binds a licensed review to its bars and the applicable issuer distributions", () => {
  const files = dividendCalendar.map(session => bar(session));
  const through = dividendCalendar.at(-1)!;
  const first = dividendCalendar[0];
  const issuers = ETF_SYMBOLS.map(symbol => ({ symbol, cash: [] as { session: string; amount: number }[] }));
  const fingerprints = marketParquetIssuerFingerprints(issuers, first, through);
  const evidence = { mode: "licensed", passed: true, capturedAfterClose: true, verifiedThrough: through,
    files, issuerActions: fingerprints };
  assert.equal(matchesMarketParquetReview(evidence, "licensed", through, files, fingerprints), true);
  assert.equal(matchesMarketParquetReview(evidence, "sample", through, files, fingerprints), false);
  const sample = { ...evidence, mode: "sample", schemaVersion: 2, horizonDifferences: [] };
  assert.equal(matchesMarketParquetReview({ ...sample, schemaVersion: 1 }, "sample", through, files, fingerprints), false);
  assert.equal(matchesMarketParquetReview({ ...sample, horizonDifferences: [{}] }, "sample", through, files, fingerprints), false);
  assert.equal(matchesMarketParquetReview(sample, "sample", through, files, fingerprints), true);
  const revisedBars = [{ ...files[0], sha256: "b".repeat(64) }, ...files.slice(1)];
  assert.equal(matchesMarketParquetReview(evidence, "licensed", through, revisedBars, fingerprints), false);
  issuers[0].cash.push({ session: through, amount: 0.5 });
  const revisedIssuer = marketParquetIssuerFingerprints(issuers, first, through);
  assert.equal(matchesMarketParquetReview(evidence, "licensed", through, files, revisedIssuer), false);
});
