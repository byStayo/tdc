import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, cp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chronologicalSplit, planCandidate, evaluateCandidate } from "../lib/consensus/learning.ts";
import type { TrainingRow } from "../lib/consensus/learning.ts";
import { readReservations, reserveEvaluation, validateReservations, attemptAlpha,
  pairedLossEvidence, promotionEvidence, validateActivePromotion } from "../lib/consensus/learning-audit.ts";
import type { ActiveModel } from "../lib/consensus/model.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { digest } from "../lib/consensus/history.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import type { Snapshot, HistoryEntry, Outcome } from "../lib/consensus/types.ts";

// Deliberately learnable and noisy synthetic fixtures; none are published as real model evidence.
const asOf = "2030-01-01T00:00:00.000Z";
const policy = { minimumSamples: 500, minimumTestSamples: 100, nonOverlappingTest: true };
const rows = (count: number, horizon = 1): TrainingRow[] => Array.from({ length: count }, (_, i) => ({
  id: `synthetic-${i}`,
  issuedAt: new Date(Date.UTC(2020, 0, i + 1, 12)).toISOString(),
  labelKnownAt: new Date(Date.UTC(2020, 0, i + horizon, 21)).toISOString(),
  features: [i % 2 ? 1 : -1], up: (i % 2) as 0 | 1,
}));

test("the 250 to 251-row reuse probe is refused after a failed/aborted reserved attempt", async () => {
  const earlier = chronologicalSplit(rows(250)).test;
  assert.equal(chronologicalSplit(rows(251)).test.filter((row) => earlier.some((old) => old.id === row.id)).length, 50);
  assert.equal(planCandidate(rows(250), asOf, policy).status, "insufficient_data");
  const root = await mkdtemp(join(tmpdir(), "tdc-learning-audit-"));
  try {
    const plan = planCandidate(rows(500), asOf, policy);
    assert.equal(plan.status, "ready");
    if (plan.status !== "ready") throw new Error("fixture plan");
    const first = await reserveEvaluation(root, [], plan, "SPY", "daily", asOf);
    // Simulate a crash immediately after reservation, with no model or result saved.
    const restored = await readReservations(root);
    assert.deepEqual(restored, [first]);
    assert.equal(planCandidate(rows(501), asOf, { ...policy, consumedThrough: restored[0].consumedThrough }).status, "insufficient_data");
    await assert.rejects(reserveEvaluation(root, [], plan, "SPY", "daily", asOf), /EEXIST/);
    const next = planCandidate(rows(601), asOf, { ...policy, consumedThrough: first.consumedThrough });
    assert.equal(next.status, "ready");
    if (next.status !== "ready") throw new Error("fixture next plan");
    assert.ok(next.split.test.every((row) => !first.testIds.includes(row.id) && row.issuedAt > first.consumedThrough));
    const second = await reserveEvaluation(root, restored, next, "SPY", "daily", asOf);
    assert.equal(second.attempt, 2);
    assert.ok(second.alpha < first.alpha);
    assert.throws(() => validateReservations([first, { ...second, testStarts: first.testStarts }]), /Invalid or reused/);
    assert.throws(() => validateReservations([first, { ...second, testIds: first.testIds }]), /Invalid or reused/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("overlapping weekly/monthly outcomes do not count as 100 fresh test windows", () => {
  assert.equal(planCandidate(rows(500, 5), asOf, policy).status, "insufficient_data");
  assert.equal(planCandidate(rows(500, 21), asOf, policy).status, "insufficient_data");
  const weekly = planCandidate(rows(2500, 5), asOf, policy);
  assert.equal(weekly.status, "ready");
  if (weekly.status === "ready") {
    assert.equal(weekly.split.test.length, 100);
    assert.ok(weekly.split.test.every((row, i, all) => !i || row.issuedAt > all[i - 1].labelKnownAt));
    assert.ok(weekly.split.train.every((row) => row.labelKnownAt < weekly.split.validation[0].issuedAt));
    assert.ok(weekly.split.validation.every((row) => row.labelKnownAt < weekly.split.test[0].issuedAt));
  }
});

test("paired uncertainty rejects a noisy 0.015 improvement, retains deterministic strong evidence", () => {
  const noisy = pairedLossEvidence(Array.from({ length: 100 }, (_, i) => i < 50 ? 0.6 : -0.57), "fixed-noisy-fixture");
  assert.ok(noisy.meanImprovement > 0.01);
  assert.ok(noisy.interval95[0] < 0);
  assert.ok(noisy.pValue > attemptAlpha(1));
  const strong = pairedLossEvidence(Array(100).fill(0.2), "fixed-strong-fixture");
  assert.ok(strong.interval95[0] > 0.19);
  assert.ok(strong.pValue < attemptAlpha(1));
  assert.deepEqual(pairedLossEvidence(Array(100).fill(0.2), "fixed-strong-fixture"), strong);
  assert.ok(pairedLossEvidence(Array(100).fill(0), "null-fixture").pValue > 0.9);
  assert.throws(() => pairedLossEvidence([0.2], "too-small"), /100/);
  const totalBudget = Array.from({ length: 10000 }, (_, i) => attemptAlpha(i + 1)).reduce((a, b) => a + b, 0) * 15;
  assert.ok(totalBudget < 0.05 && totalBudget > 0.049);
});

test("activation needs matched reservation and improvements over every baseline including incumbent", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-learning-gate-"));
  try {
    const plan = planCandidate(rows(500), asOf, policy);
    if (plan.status !== "ready") throw new Error("fixture plan");
    const reservation = await reserveEvaluation(root, [], plan, "QQQ", "daily", asOf);
    const result = evaluateCandidate(plan);
    const gate = promotionEvidence(plan, result.model, reservation);
    assert.equal(gate.passes, true);
    assert.equal(promotionEvidence(plan, result.model, reservation, result.model).passes, false);
    assert.throws(() => promotionEvidence(plan, result.model, { ...reservation, datasetHash: "0".repeat(64) }), /differs/);
    const model: ActiveModel = {
      id: "synthetic", instrument: "QQQ", horizon: "daily", trainedAt: asOf,
      labelsThrough: gate.consumedThrough, datasetHash: plan.datasetHash,
      samples: plan.samples, featureSchema: "family-score-plus-observation-mask-v1",
      model: result.model, testBrier: result.candidateBrier, baselineBrier: result.coinBrier,
      testSamples: result.split.test, promotionEvidence: gate,
    };
    assert.doesNotThrow(() => validateActivePromotion(model, [reservation]));
    assert.throws(() => validateActivePromotion(model, []), /promotion evidence/);
    assert.throws(() => validateActivePromotion({ ...model, promotionEvidence: undefined }, [reservation]), /promotion evidence/);
    assert.throws(() => validateActivePromotion({ ...model, promotionEvidence: { ...gate, passes: false } }, [reservation]), /promotion evidence/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the actual evaluator persists test consumption, keeps incumbent status distinct and refuses a lost audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-evaluator-fixture-"));
  try {
    await cp(new URL("../lib", import.meta.url), join(root, "lib"), { recursive: true });
    await mkdir(join(root, "scripts"));
    await cp(new URL("../scripts/evaluate-consensus.ts", import.meta.url), join(root, "scripts/evaluate-consensus.ts"));
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    const directory = join(root, "public/consensus");
    await mkdir(directory, { recursive: true });
    const index: HistoryEntry[] = [], outcomes: Outcome[] = [];
    for (const row of rows(500)) {
      const score = row.up ? 1 : -1;
      const base = missingSignals(row.issuedAt)[0];
      const snapshot: Snapshot = {
        schemaVersion: 1, origin: "prospective", id: row.issuedAt.replace(/[:.]/g, "-"),
        issuedAt: row.issuedAt, cutoff: row.issuedAt, engineVersion: "consensus-rules-1.1.0",
        signals: [{ ...base, id: "synthetic-rate", family: "rates", title: "Synthetic test signal",
          status: "available", scores: { daily: score, weekly: null, monthly: null },
          series: [{ date: row.issuedAt.slice(0, 10), value: score }],
          source: { ...base.source, name: "Synthetic fixture", observedAt: row.issuedAt.slice(0, 10), sha256: "a".repeat(64) } }],
        catalysts: [], collectionErrors: [], sourcesAttempted: 1,
      };
      index.push({ id: snapshot.id, issuedAt: snapshot.issuedAt, engineVersion: snapshot.engineVersion, sha256: digest(snapshot) });
      await writeFile(join(directory, `${snapshot.id}.json`), JSON.stringify(snapshot));
      outcomes.push({ snapshotId: snapshot.id, instrument: "SPY", horizon: "daily", issuedAt: row.issuedAt,
        entryAt: row.issuedAt.replace("T12:", "T14:"), exitAt: row.labelKnownAt,
        entry: 100, exit: 100 + score * 2, returnPct: score * 2,
        predictedScore: score, predictedProbability: null, abstained: true, directionCorrect: null,
        source: "https://example.com/synthetic-fixture", adjustment: "split-adjusted" });
    }
    await writeFile(join(directory, "index.json"), JSON.stringify(index));
    await writeFile(join(directory, "outcomes.json"), JSON.stringify(outcomes));
    await writeFile(join(root, "lib/consensus/models.json"), '{"schemaVersion":1,"models":[],"note":"Synthetic test only"}');
    const run = () => promisify(execFile)(process.execPath, ["--experimental-strip-types", "scripts/evaluate-consensus.ts"], { cwd: root });
    await run();
    const first = await readReservations(root);
    assert.equal(first.length, 1);
    const registry = JSON.parse(await readFile(join(root, "lib/consensus/models.json"), "utf8"));
    assert.equal(registry.models.length, 1);
    validateActivePromotion(registry.models[0], first);
    await run();
    assert.deepEqual(await readReservations(root), first);
    const report = JSON.parse(await readFile(join(root, "lib/consensus/performance.json"), "utf8"));
    const cohort = report.learning.find((item: { instrument: string; horizon: string }) => item.instrument === "SPY" && item.horizon === "daily");
    assert.equal(cohort.promoted, false);
    assert.equal(cohort.activeModelId, registry.models[0].id);
    assert.equal(cohort.status, "insufficient_data");
    assert.deepEqual(JSON.parse(await readFile(join(directory, "outcomes.json"), "utf8")), outcomes);
    await rm(join(directory, "evaluations"), { recursive: true });
    await assert.rejects(run(), /missing its durable test reservation/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
