import test from "node:test";
import assert from "node:assert/strict";
import { performance, selectScoredOutcomes } from "../lib/consensus/evaluation.ts";
import type { Outcome } from "../lib/consensus/types.ts";
import { performanceView } from "../lib/consensus/performance-view.ts";
import type { PerformanceReport } from "../lib/consensus/performance-types.ts";

// Synthetic outcomes only. No actual return or accuracy is claimed by these fixtures.
const outcome = (hour: number, overrides: Partial<Outcome> = {}): Outcome => ({
  snapshotId: `fixture-${hour}`,
  issuedAt: `2026-11-03T${String(hour).padStart(2, "0")}:00:00.000Z`,
  instrument: "SPY", horizon: "daily",
  entryAt: "2026-11-03T14:30:00.000Z", exitAt: "2026-11-03T21:00:00.000Z",
  entry: 100, exit: 102, returnPct: 2, predictedScore: 0.6,
  predictedProbability: 0.8, abstained: false, directionCorrect: true,
  source: "https://example.com/synthetic-price-fixture", adjustment: "total-return-adjusted",
  ...overrides,
});

test("eight pre-open editions count once; the last edition wins even when its forecast loses", () => {
  const rows = Array.from({ length: 8 }, (_, i) => outcome(i + 6));
  rows[7] = outcome(13, { predictedScore: -0.6, predictedProbability: 0.2, directionCorrect: false });
  const original = JSON.stringify(rows);
  const selected = selectScoredOutcomes(rows);
  assert.equal(selected.selected.length, 1);
  assert.equal(selected.selected[0].snapshotId, "fixture-13");
  assert.equal(selected.superseded.length, 7);
  assert.ok(selected.superseded.every((row) => row.selectedSnapshotId === "fixture-13"));
  assert.deepEqual(selectScoredOutcomes([...rows].reverse()).selected, selected.selected);
  const stats = performance(rows);
  assert.equal(stats.resolved, 1);
  assert.equal(stats.calls, 1);
  assert.equal(stats.accuracy, 0);
  assert.equal(stats.superseded, 7);
  assert.ok(Math.abs(stats.brier! - 0.64) < 1e-12);
  assert.equal(JSON.stringify(rows), original);
});

test("a later abstention cannot be replaced with an earlier successful call", () => {
  const rows = [outcome(6), outcome(13, { abstained: true, directionCorrect: null, predictedProbability: null })];
  const stats = performance(rows);
  assert.equal(stats.resolved, 1);
  assert.equal(stats.abstentions, 1);
  assert.equal(stats.calls, 0);
  assert.equal(stats.accuracy, null);
  assert.equal(stats.brier, null);
});

test("selection is separate for each instrument, horizon and entry session", () => {
  const rows = [outcome(6), outcome(13), outcome(13, { instrument: "QQQ" }),
    outcome(13, { horizon: "weekly", exitAt: "2026-11-09T21:00:00.000Z" }),
    outcome(14, { entryAt: "2026-11-04T14:30:00.000Z", exitAt: "2026-11-04T21:00:00.000Z" })];
  assert.equal(performance(rows).resolved, 4);
  assert.equal(selectScoredOutcomes(rows).superseded.length, 1);
  assert.throws(() => performance([rows[0], rows[0]]), /Duplicate/);
  assert.throws(() => performance([outcome(14, { issuedAt: "2026-11-03T14:30:00.000Z" })]), /timestamps/);
  assert.throws(() => performance([outcome(6), outcome(6, { snapshotId: "ambiguous" })]), /Ambiguous/);
});

test("MARKET performance is a labelled instrument summary for one horizon, never a missing-value zero", () => {
  const report: PerformanceReport = { generatedAt: "2026-11-03T21:10:00.000Z", status: "tracking",
    resolved: 999, calls: 999, abstentions: 0, accuracy: 1, brier: null, learning: [], note: "Synthetic fixture",
    cohorts: ["SPY", "QQQ", "IWM", "DIA", "TLT"].map((instrument, i) => ({
      instrument, horizon: "daily", resolved: 5, calls: i + 1, accuracy: i === 0 ? 0 : 1,
      meanSignedReturnPct: null, meanBuyHoldReturnPct: null, brier: null,
    })),
  };
  assert.deepEqual(performanceView(report, "MARKET", "daily"), { resolved: 25, calls: 15, accuracy: 14 / 15 });
  assert.deepEqual(performanceView(report, "SPY", "daily"), { resolved: 5, calls: 1, accuracy: 0 });
  assert.deepEqual(performanceView(report, "MARKET", "weekly"), { resolved: null, calls: null, accuracy: null });
  assert.deepEqual(performanceView(report, "SPY", "monthly"), { resolved: null, calls: null, accuracy: null });
});

test('outcome cohorts cannot mix or silently accept unadjusted split/dividend returns', () => {
  for (const adjustment of ['unadjusted','split-adjusted','unknown']) {
    assert.throws(()=>selectScoredOutcomes([outcome(6),outcome(7,{entryAt:'2026-11-04T14:30:00.000Z',exitAt:'2026-11-04T21:00:00.000Z',adjustment})]),/total-return-adjusted/);
  }
});
