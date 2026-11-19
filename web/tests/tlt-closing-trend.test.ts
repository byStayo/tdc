import assert from "node:assert/strict";
import test from "node:test";
import { tltCloseSignal, validateTltCloseSignal } from "../lib/consensus/tlt-close-signal.ts";

test("closing trend publishes rounded TLT percentages with no opening mark or direction", () => {
  const signal = tltCloseSignal("2026-11-16", [0.0123, -3.149, 0.321], "2026-11-18T09:00:00.000Z", "a".repeat(64));
  assert.deepEqual(signal.metrics.map(m => m.value), [0, -3.1, 0.3]);
  assert.deepEqual(signal.instruments, ["TLT"]);
  assert.equal(signal.source.observedAt, "2026-11-16T21:00:00.000Z");
  for (const mutated of [
    { ...signal, scores: { ...signal.scores, daily: 0.2 } }, { ...signal, directionalInstruments: ["TLT" as const] },
    { ...signal, metrics: [{ ...signal.metrics[0], open: 100 }] },
    { ...signal, series: [{ ...signal.series[0], close: 98.75 }] }, { ...signal, bars: [{ open: 100 }] },
    { ...signal, source: { ...signal.source, rawBars: [{ close: 98.75 }] } },
    { ...signal, source: { ...signal.source, observedAt: "2026-11-16T20:00:00.000Z" } },
  ]) assert.throws(() => validateTltCloseSignal(mutated), /Invalid closing-hour/);
});

test("pending Nasdaq shortened sessions break each public TLT lookback that crosses them", () => {
  const retrieved = "2026-12-03T14:00:00.000Z", hash = "b".repeat(64);
  for (const [day, values] of [["2026-11-27", [1]], ["2026-11-30", [1]], ["2026-12-01", [1, 5]]] as const)
    assert.throws(() => tltCloseSignal(day, [...values], retrieved, hash), /full sessions/);
  assert.doesNotThrow(() => tltCloseSignal("2026-12-01", [1], retrieved, hash));
});
