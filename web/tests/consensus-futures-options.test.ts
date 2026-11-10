import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { collectFuturesOptions, validateFuturesOptions } from "../lib/consensus/futures-options.ts";

const cutoff = "2026-11-10T12:00:00.000Z";
const row = {
  cftc_contract_market_code: "13874A",
  report_date_as_yyyy_mm_dd: "2026-11-03T00:00:00.000",
  market_and_exchange_names: "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE",
  contract_units: "($50 X S&P 500 INDEX)",
};
const futures = { ...row, open_interest_all: "1986532", futonly_or_combined: "FutOnly" };
const combined = { ...row, open_interest_all: "2942595", futonly_or_combined: "Combined" };

async function spy(rows: unknown[]) {
  const text = JSON.stringify(rows);
  const signals = await collectFuturesOptions(async () => ({
    text, retrievedAt: cutoff, sha256: createHash("sha256").update(text).digest("hex"),
  }), () => cutoff);
  return signals.find(signal => signal.id === "tff-options-13874A")!;
}

test("same-week CFTC open interest adds scoped futures options context without a vote", async () => {
  const signal = await spy([futures, combined]);
  assert.equal(signal.status, "available");
  assert.deepEqual(signal.instruments, ["MARKET", "SPY"]);
  assert.deepEqual(signal.directionalInstruments, []);
  assert.deepEqual(signal.scores, { daily: null, weekly: null, monthly: null });
  assert.deepEqual(signal.series, [{ date: "2026-11-03", value: 956063 }]);
  assert.deepEqual(signal.metrics.map(m => m.value), [956063, 1986532, 2942595]);
  assert.doesNotThrow(() => validateFuturesOptions(signal));
  assert.throws(() => validateFuturesOptions({ ...signal, scores: { ...signal.scores, daily: 1 } }));
  assert.throws(() => validateFuturesOptions({ ...signal, series: [{ ...signal.series[0], value: 0 }] }));
  const future = "2026-11-11";
  assert.throws(() => validateFuturesOptions({
    ...signal,
    source: { ...signal.source, observedAt: future },
    series: [{ ...signal.series[0], date: future }],
    metrics: signal.metrics.map(metric => ({ ...metric, date: future })),
  }));
});

test("incomplete, incomparable and conflicting CFTC pairs withhold the observation", async () => {
  for (const rows of [
    [futures],
    [futures, { ...combined, contract_units: "(OTHER UNIT)" }],
    [futures, combined, { ...combined, open_interest_all: "3000000" }],
    [futures, { ...combined, open_interest_all: "1986531" }],
    [futures, combined, { ...combined, report_date_as_yyyy_mm_dd: "2026-11-09T00:00:00.000" }],
  ]) {
    const signal = await spy(rows);
    assert.equal(signal.status, "unavailable");
    assert.equal(signal.series.length, 0);
  }
  const zero = await spy([futures, { ...combined, open_interest_all: futures.open_interest_all }]);
  assert.equal(zero.status, "available");
  assert.equal(zero.series[0]?.value, 0);
});
