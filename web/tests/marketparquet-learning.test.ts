import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateCandidate, planCandidate } from "../lib/consensus/learning.ts";
import { promotionEvidence, readReservations, reserveEvaluation } from "../lib/consensus/learning-audit.ts";
import { marketParquetHoldouts } from "../lib/consensus/marketparquet-learning.ts";

test("reuses an exact historical vendor summary without changing its result or reservation and rejects unrelated evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-vendor-saved-result-"));
  try {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: `synthetic-${i}:SPY:daily`, engineVersion: "consensus-rules-2.0.0",
      issuedAt: new Date(Date.UTC(2020, 0, i + 1, 12)).toISOString(), labelKnownAt: new Date(Date.UTC(2020, 0, i + 1, 21)).toISOString(),
      features: [i % 2 ? 1 : -1], up: (i % 2) as 0 | 1 }));
    const now = "2024-01-01T00:00:00.000Z";
    const plan = planCandidate(rows, now, { minimumSamples: 500, minimumTestSamples: 100, nonOverlappingTest: true });
    if (plan.status !== "ready") throw Error("Synthetic plan is not ready");
    const reservation = await reserveEvaluation(root, [], plan, "SPY", "daily", now);
    const candidate = evaluateCandidate(plan);
    if (candidate.status !== "evaluated") throw Error("Synthetic candidate did not evaluate");
    const gate = promotionEvidence(plan, candidate.model, reservation);
    const summary = { testLabels: 100, candidateBrier: candidate.candidateBrier, baseRateBrier: candidate.baseRateBrier,
      coinBrier: candidate.coinBrier, passed: true };
    assert.ok(candidate.promoted && gate.passes);
    const saved = { engineVersion: plan.engineVersion, datasetHash: plan.datasetHash, attempt: 1, candidate, gate, summary };
    const vendor = join(root, ".consensus/private-marketparquet"), path = join(vendor, "validation-SPY-daily.json");
    await mkdir(vendor, { mode: 0o700 });
    const bytes = JSON.stringify(saved);
    await writeFile(path, bytes, { mode: 0o600 });
    const lookup = await marketParquetHoldouts(root, [], [reservation]);
    assert.deepEqual(await lookup("SPY", "daily", rows, plan.engineVersion, plan.datasetHash), summary);
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.deepEqual(await readReservations(root), [reservation]);
    assert.equal(await lookup("QQQ", "daily", rows, plan.engineVersion, plan.datasetHash), null);
    assert.equal(await lookup("SPY", "weekly", rows, plan.engineVersion, plan.datasetHash), null);
    assert.equal(await lookup("SPY", "daily", rows, "other-engine", plan.datasetHash), null);
    assert.equal(await lookup("SPY", "daily", rows, plan.engineVersion, "f".repeat(64)), null);
    const cases: ((value: typeof saved) => void)[] = [
      value => { value.attempt = 2; },
      value => { value.engineVersion = "other-engine"; },
      value => { value.datasetHash = "f".repeat(64); },
      value => { value.candidate.split.testStarts = rows[0].issuedAt; },
      value => { value.candidate.split.test = 99; },
      value => { value.gate.attempt = 2; },
      value => { value.gate.engineVersion = "other-engine"; },
      value => { value.gate.candidateModelHash = "f".repeat(64); },
      value => { value.gate.comparisons[0].meanImprovement = 0; },
      value => { value.gate.passes = false; },
      value => { value.summary.candidateBrier = .2; },
    ];
    for (const mutate of cases) {
      const altered = structuredClone(saved); mutate(altered);
      await writeFile(path, JSON.stringify(altered));
      assert.equal(await lookup("SPY", "daily", rows, plan.engineVersion, plan.datasetHash), null);
    }
    const changed = structuredClone(reservation); changed.testWindows[0].id = "unrelated";
    const mismatchedWindows = await marketParquetHoldouts(root, [], [changed]);
    await writeFile(path, bytes);
    assert.equal(await mismatchedWindows("SPY", "daily", rows, plan.engineVersion, plan.datasetHash), null);
    assert.deepEqual(await readReservations(root), [reservation]);
    assert.equal(await readFile(path, "utf8"), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
