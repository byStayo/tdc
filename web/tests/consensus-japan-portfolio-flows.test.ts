import assert from "node:assert/strict";
import test from "node:test";
import {
  collectJapanPortfolioFlows,
  JAPAN_PORTFOLIO_FLOWS_URL,
  validateJapanPortfolioFlows,
} from "../lib/consensus/japan-portfolio-flows.ts";
import { SourceTransportError } from "../lib/consensus/source-failure.ts";

const retrievedAt = "2026-11-18T13:00:00.000Z";

function row(cells: Record<number, string>): string {
  return Array.from({ length: 23 }, (_, index) => {
    const value = cells[index] ?? "";
    return /[,\r\n"]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  }).join(",");
}

function sample({
  lastPeriod = "2026．11．1～11．7",
  edition = "November 12, 2026",
  assets = "Portfolio Investment Assets",
  foreignNet = "-6,439",
  firstPeriod = "2026．10．25～10．31",
} = {}) {
  const text = [
    row({ 0: "International Transactions in Securities (Weekly; based on reports from designated major investors)", 19: "Final Update  " + edition }),
    row({ 19: "Unit: 100 million Yen" }),
    row({ 1: "1. " + assets, 12: "2. Portfolio Investment Liabilities" }),
    row({ 0: "Japanese date label\nPeriod" }),
    row({ 1: "Equity and investment fund shares", 12: "Equity and investment fund shares" }),
    row({ 1: "Acquisition", 2: "Disposition", 3: "Net", 7: "Net", 12: "Acquisition", 13: "Disposition", 14: "Net" }),
    row({ 0: firstPeriod, 1: "38,200", 2: "27,422", 3: "10,777", 12: "443,828", 13: "432,534", 14: "11,293" }),
    row({ 0: lastPeriod, 1: "30,310 ", 2: "36,749 ", 3: foreignNet, 12: "404,355", 13: "405,407", 14: "-1,052" }),
    row({ 0: "①", 1: "Totals may not add due to rounding." }),
  ].join("\r\n");
  return Buffer.from(text.replaceAll("．", "\x81\x44").replaceAll("～", "\x81\x60").replaceAll("①", "\x87\x40"), "latin1");
}

test("collects only the latest signed equity rows with separate observation and vintage dates", async () => {
  const bytes = sample();
  const signal = await collectJapanPortfolioFlows(async (url) => {
    assert.equal(url, JAPAN_PORTFOLIO_FLOWS_URL);
    return { bytes, retrievedAt };
  });
  assert.equal(signal.family, "international");
  assert.deepEqual(signal.instruments, ["MARKET"]);
  assert.deepEqual(signal.directionalInstruments, []);
  assert.equal(signal.status, "available");
  assert.equal(signal.source.observedAt, "2026-11-07");
  assert.equal(signal.source.vintageAt, "2026-11-12");
  assert.equal(signal.source.retrievedAt, retrievedAt);
  assert.equal(signal.source.releasedAt, null);
  assert.match(signal.source.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(signal.scores, { daily: null, weekly: null, monthly: null });
  assert.deepEqual(signal.series, [{ date: "2026-11-07", value: -6_439 }]);
  assert.deepEqual(signal.metrics.map((metric) => metric.value), [-6_439, -1_052]);
  validateJapanPortfolioFlows(signal);
  assert.throws(() => validateJapanPortfolioFlows({ ...signal, scores: { ...signal.scores, weekly: 0.5 } }));
});

test("reads a week spanning New Year and accepts the source's rounding difference", async () => {
  const signal = await collectJapanPortfolioFlows(async () => ({
    bytes: sample({
      firstPeriod: "2025．12．21～12．27",
      lastPeriod: "2025．12．28～ 2026．1．3",
      edition: "January 8, 2026",
      foreignNet: "-6,438",
    }),
    retrievedAt,
  }));
  assert.equal(signal.status, "available");
  assert.equal(signal.source.observedAt, "2026-01-03");
  assert.equal(signal.metrics[0].value, -6_438);
});

test("rejects a file staged before its scheduled Tokyo release or retrieved after the cutoff", async () => {
  const bytes = sample();
  for (const [fetchAt, cutoff] of [
    ["2026-11-11T22:50:18.000Z", undefined],
    ["2026-11-12T02:00:00.000Z", "2026-11-11T23:59:59.000Z"],
  ] as const) {
    const signal = await collectJapanPortfolioFlows(async () => ({ bytes, retrievedAt: fetchAt }), cutoff);
    assert.equal(signal.status, "unavailable");
    assert.equal(signal.failureKind, "validation");
    assert.deepEqual(signal.metrics, []);
    assert.equal(signal.source.sha256, null);
  }
});

test("rejects changed geography, non-tied net flow, a duplicate week and invalid period dates", async () => {
  for (const bytes of [
    sample({ assets: "Portfolio Investment Liabilities" }),
    sample({ foreignNet: "6,439" }),
    sample({ firstPeriod: "2026．11．1～11．7" }),
    sample({ lastPeriod: "2026．11．28～11．34" }),
  ]) {
    const signal = await collectJapanPortfolioFlows(async () => ({ bytes, retrievedAt }));
    assert.equal(signal.status, "unavailable");
    assert.equal(signal.failureKind, "validation");
    assert.equal(signal.source.observedAt, null);
  }
});

test("preserves the distinction between validation and a temporary source outage", async () => {
  const signal = await collectJapanPortfolioFlows(async () => {
    throw new SourceTransportError("HTTP 503");
  }, retrievedAt);
  assert.equal(signal.status, "unavailable");
  assert.equal(signal.failureKind, "transport");
  validateJapanPortfolioFlows(signal);
});
