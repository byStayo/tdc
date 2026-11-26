import assert from "node:assert/strict";
import test from "node:test";
import * as firstRate from "../lib/consensus/firstrate.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { validateSnapshot } from "../lib/consensus/history.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import type { Signal } from "../lib/consensus/types.ts";

const through = "2026-11-17";
const dates = exchangeSessions("2026-11-10", through);
const capturedAt = "2026-11-18T11:00:00.000Z";
const hash = "1".repeat(64);
const symbols = firstRate.FIRST_RATE_SYMBOLS;
const approval = {
  schemaVersion: 1 as const, source: firstRate.FIRST_RATE_SOURCE, from: dates[0], through, approvedAt: capturedAt,
  issuers: [...symbols, "TLT" as const].map(symbol => ({ symbol, source: "https://www.ishares.com/",
    sha256: hash, capturedAt, cash: [{ session: through, amount: 2 }] })),
  symbols: symbols.map((symbol, i) => ({
    symbol, reviewedThrough: through, withheld: [],
    rows: dates.map(day => ({ ...exchangeSession(day)!, open: day === through ? 98 : 100,
      close: day === through ? [99, 97, 98, 98.001][i] : 100 })),
    proof: { source: { symbol, basis: "split-adjusted" as const, capturedAt, modifiedAt: "2026-11-18T10:00:00.000Z",
      url: `https://frd001.s3.us-east-2.amazonaws.com/frd_sample_etf_${symbol}.zip`, sha256: hash },
      comparison: [hash], splitComparison: [hash], listingReferences: [] },
  })),
} satisfies Parameters<typeof firstRate.firstRateTechnicalSignals>[0];

function readings(input = approval, asOf = capturedAt): Signal[] {
  return firstRate.firstRateTechnicalSignals(input, asOf);
}

test("issuer cash adjusts consecutive returns and small advances count before display rounding", () => {
  const signals = readings();
  const spy = signals.find(row => row.instruments[0] === "SPY")!;
  assert.deepEqual(spy.metrics.map(row => row.value), [1, 1, 1]);
  const market = signals.find(row => row.instruments[0] === "MARKET")!;
  assert.deepEqual(market.metrics.map(row => row.value), [2, 1, 1]);
  assert.equal(market.source.observedAt, "2026-11-17T21:00:00.000Z");
  assert.equal(signals.length, 5);
  assert.ok(signals.every(s => !s.directionalInstruments?.length && Object.values(s.scores).every(v => v === null)));
  assert.ok(!JSON.stringify(signals).includes("98.001"));
  assert.deepEqual(readings(approval, "2026-11-18T10:59:59.999Z"), []);
});

test("a missing session breaks a lookback and mixed last dates withhold market breadth", () => {
  const gap = structuredClone(approval);
  gap.symbols[0].rows.splice(-2, 1);
  const signals = readings(gap);
  assert.deepEqual(signals.find(row => row.instruments[0] === "SPY")!.metrics.map(row => row.value), [1]);
  assert.ok(!signals.some(row => row.instruments.includes("MARKET")));
  const late = structuredClone(approval);
  late.symbols[0].rows.pop();
  assert.ok(!readings(late).some(row => row.instruments.some(symbol => symbol === "SPY" || symbol === "MARKET")));
  late.symbols[0].reviewedThrough = dates.at(-2)!;
  assert.ok(readings(late).some(row => row.instruments[0] === "SPY"));
  assert.ok(!readings(late).some(row => row.instruments.includes("MARKET")));
});

test("new-session cash and prior technicals are isolated across an unresolved listing-calendar date", () => {
  const oldDay = "2027-11-24", nextDay = "2027-11-29", now = "2027-11-30T12:00:00.000Z";
  const current = structuredClone(approval);
  current.from = oldDay;
  current.through = nextDay;
  current.approvedAt = now;
  for (const issuer of current.issuers) {
    issuer.capturedAt = now;
    issuer.cash = [{ session: "2027-11-26", amount: 2 }, { session: nextDay, amount: 1 }];
  }
  for (const fund of current.symbols) {
    fund.reviewedThrough = nextDay;
    fund.rows = [oldDay, nextDay].map(session => ({ ...exchangeSession(session)!, open: 100, close: 101 }));
    fund.proof.source.modifiedAt = nextDay + "T22:00:00.000Z";
    fund.proof.source.capturedAt = now;
  }
  const prices = firstRate.firstRatePriceEvidence(current);
  assert.deepEqual(prices[0].sessions.map(row => row.close), [101, 101]);
  const signals = readings(current, now);
  assert.equal(signals.length, 4);
  for (const signal of signals) assert.deepEqual(signal.metrics.map(row => row.value), [1]);
});

test("a verified file timestamp at the core close preserves independent ETF observations", () => {
  const atClose = structuredClone(approval);
  atClose.symbols[1].proof.source.modifiedAt = exchangeSession(through)!.closeAt;
  const rows = readings(atClose);
  assert.equal(rows.length, 5);
  const qqq = rows.find(s => s.instruments.includes("QQQ"))!;
  assert.equal(qqq.source.vintageAt, qqq.source.observedAt);
  validateSnapshot({ schemaVersion: 1, origin: "prospective", id: "2026-11-18T11-00-00-000Z", cutoff: capturedAt,
    issuedAt: capturedAt, engineVersion: "consensus-rules-2.0.0", catalysts: [], signals: rows,
    sourcesAttempted: 1, collectionErrors: [] });
});

test("an exact cash distribution stays flat despite floating-point back-adjustment", () => {
  const input = structuredClone(approval);
  for (let i = 0; i < 2; i++) {
    const [prior, cash, exClose] = [[100.01, 0.02, 99.99], [170.48, 0.46, 170.02]][i];
    input.issuers[i].cash[0].amount = cash;
    input.symbols[i].rows.at(-2)!.close = prior;
    input.symbols[i].rows.at(-1)!.close = exClose;
  }
  const market = readings(input).find(s => s.instruments.includes("MARKET"))!;
  assert.deepEqual(market.metrics.map(m => m.value), [1, 0, 3]);
});

test("the archive rejects a fabricated technical vote, extra price metric, or invalid publication clock", () => {
  const signals = readings(), valid = signals[0];
  const snapshot = { schemaVersion: 1 as const, origin: "prospective" as const, id: "2026-11-18T11-00-00-000Z",
    cutoff: capturedAt, issuedAt: capturedAt, engineVersion: "consensus-rules-2.0.0", catalysts: [],
    signals, sourcesAttempted: 1, collectionErrors: [] };
  validateSnapshot(snapshot);
  for (const forged of [
    { ...valid, scores: { ...valid.scores, daily: 1 } },
    { ...valid, metrics: [...valid.metrics, { date: through, label: "Raw close", unit: "USD", value: 99 }] },
    { ...valid, source: { ...valid.source, vintageAt: "2026-11-19T10:00:00.000Z" } },
  ]) assert.throws(() => validateSnapshot({ ...snapshot, signals: [forged, ...signals.slice(1)] }), /technical/i);
  assert.throws(() => validateSnapshot({ ...snapshot, signals: signals.slice(0, -1) }), /breadth/i);
  const wrongCount = valid.metrics.map((m, i) => ({ ...m, value: [2, 0, 2][i] }));
  assert.throws(() => validateSnapshot({ ...snapshot, signals: [{ ...valid, metrics: wrongCount }, ...signals.slice(1)] }), /breadth/i);
  const changedFlat = valid.metrics.map((m, i) => ({ ...m, value: [2, 2, 0][i] }));
  assert.throws(() => validateSnapshot({ ...snapshot, signals: [{ ...valid, metrics: changedFlat }, ...signals.slice(1)] }), /breadth/i);
  assert.throws(() => validateSnapshot({ ...snapshot, signals: [{ ...valid, source: { ...valid.source, sha256: "2".repeat(64) } },
    ...signals.slice(1)] }), /breadth/i);
});

test("refreshing the same evidence preserves other sources and restores the missing scope on loss", () => {
  const original = missingSignals(capturedAt);
  const technicals = readings();
  const merged = firstRate.replaceTechnicalSignals(original, technicals, capturedAt);
  assert.deepEqual(merged.find(s => s.id === "daily-prices")!.instruments, ["TLT"]);
  assert.deepEqual(merged.filter(s => s.family !== "technicals"), original.filter(s => s.family !== "technicals"));
  assert.deepEqual(firstRate.replaceTechnicalSignals(merged, technicals, capturedAt), merged);
  assert.deepEqual(firstRate.replaceTechnicalSignals(merged, [], capturedAt), original);
});

test("twenty-session return and daily volatility become available after twenty consecutive changes", () => {
  const input = structuredClone(approval);
  const finalDay = "2027-02-05", review = "2027-02-06T11:00:00.000Z";
  const days = exchangeSessions("2027-01-04", finalDay).slice(-21);
  input.from = days[0];
  input.through = finalDay;
  input.approvedAt = review;
  input.issuers = input.issuers.map(issuer => ({ ...issuer, capturedAt: review, cash: [{ session: finalDay, amount: 2 }] }));
  input.symbols = input.symbols.map(s => ({ ...s, reviewedThrough: finalDay, proof: { ...s.proof,
    source: { ...s.proof.source, modifiedAt: review, capturedAt: review } },
    rows: days.map(day => ({ ...exchangeSession(day)!, open: day === finalDay ? 98 : 100,
      close: day === finalDay ? s.rows.at(-1)!.close : 100 })) }));
  const spy = readings(input, review).find(s => s.instruments.includes("SPY"))!;
  assert.deepEqual(spy.metrics.map(m => m.value), [1, 1, 1, 1, 0.2]);
});
