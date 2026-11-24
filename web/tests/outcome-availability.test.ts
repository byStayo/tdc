import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitEvaluationTransaction, recoverEvaluationTransaction } from "../lib/consensus/evaluation-transaction.ts";
import { loadOutcomeAvailability, outcomeAvailability, PRIVATE_OUTCOME_AVAILABILITY, researchOutcomeAvailability, validateOutcomeAvailability } from "../lib/consensus/outcome-availability.ts";
import { outcomeIndex, PRIVATE_OUTCOME_LEDGER, PUBLIC_OUTCOME_INDEX } from "../lib/consensus/outcome-ledger.ts";
import { planCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import type { Outcome } from "../lib/consensus/types.ts";

const first: Outcome = {
  snapshotId: "2026-11-19T12-00-00-000Z", issuedAt: "2026-11-19T12:00:00.000Z", instrument: "SPY", horizon: "daily",
  engineVersion: "consensus-rules-2.0.0", entryAt: "2026-11-19T14:30:00.000Z", exitAt: "2026-11-19T21:00:00.000Z",
  entry: 100, exit: 101, predictedScore: null, predictedProbability: null, abstained: true, returnPct: 1, directionCorrect: null,
  source: "https://example.org/fixture", adjustment: "total-return-adjusted",
};
const second: Outcome = { ...first, instrument: "TLT" };
const friday = "2026-11-20T09:19:03.355Z", monday = "2026-11-23T13:08:59.505Z", tuesday = "2026-11-24T06:17:00.437Z";
const writes = (rows: Outcome[]) => [{ path: PRIVATE_OUTCOME_LEDGER, value: rows }, { path: PUBLIC_OUTCOME_INDEX, value: outcomeIndex(rows) }];

test("late settlements use the first journal proving the exact ETF outcome and retain the receipt over retries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "consensus-outcome-clocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(friday) });
  await commitEvaluationTransaction(root, writes([first]));
  t.mock.timers.setTime(Date.parse(monday));
  await commitEvaluationTransaction(root, writes([first, second]));
  t.mock.timers.setTime(Date.parse(tuesday));
  const rows = [first, second];
  const receipt = await loadOutcomeAvailability(root, rows, tuesday);
  assert.deepEqual(receipt.knownAt, [friday, monday]);
  await commitEvaluationTransaction(root, [...writes(rows), { path: PRIVATE_OUTCOME_AVAILABILITY, value: receipt }]);
  assert.deepEqual(await loadOutcomeAvailability(root, rows, tuesday), receipt);
  const file = join(root, PRIVATE_OUTCOME_AVAILABILITY), original = await readFile(file);
  await writeFile(file, JSON.stringify({ ...receipt, knownAt: [first.exitAt, monday] }));
  await assert.rejects(loadOutcomeAvailability(root, rows, tuesday));
  await writeFile(file, original);
  await unlink(file);
  await assert.rejects(loadOutcomeAvailability(root, rows, tuesday));
  await assert.rejects(commitEvaluationTransaction(root, writes(rows)), /differs from its completed transaction/);
});

test("interrupted clock publication replays the same evidence and preserves all settled clock prefixes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "consensus-outcome-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(tuesday) });
  const rows = [first, second];
  const clocks = outcomeAvailability(rows, [friday, monday]);
  const inputs = [...writes(rows), { path: PRIVATE_OUTCOME_AVAILABILITY, value: clocks }];
  await assert.rejects(commitEvaluationTransaction(root, inputs, path => {
    if (path === PRIVATE_OUTCOME_AVAILABILITY) throw Error("interrupted after clocks");
  }), /interrupted after clocks/);
  assert.equal(await recoverEvaluationTransaction(root), true);
  assert.deepEqual(await loadOutcomeAvailability(root, rows, tuesday), clocks);
  const changed = outcomeAvailability(rows, [first.exitAt, monday]);
  await assert.rejects(commitEvaluationTransaction(root, [...writes(rows), { path: PRIVATE_OUTCOME_AVAILABILITY, value: changed }]), /previously recorded/);
  await assert.rejects(commitEvaluationTransaction(root, writes(rows)), /previously recorded/);
  assert.equal(await recoverEvaluationTransaction(root), false);
});

test("an availability receipt cannot move to a different outcome, predate a close, or claim a future observation", () => {
  const rows = [first, second];
  const receipt = outcomeAvailability(rows, [friday, monday]);
  assert.doesNotThrow(() => validateOutcomeAvailability(receipt, rows, tuesday));
  assert.throws(() => validateOutcomeAvailability(receipt, [second, first], tuesday));
  assert.throws(() => outcomeAvailability(rows, [first.issuedAt, monday]));
  assert.throws(() => validateOutcomeAvailability(receipt, rows, friday));
});

test("one bulk delivery of 550 prior outcomes cannot supply a chronological training, validation and test split", () => {
  const rows: TrainingRow[] = Array.from({ length: 550 }, (_, i) => ({
    id: String(i), engineVersion: first.engineVersion, features: [i % 2], up: (i % 2) as 0 | 1,
    issuedAt: new Date(Date.UTC(2024, 0, 1 + i, 12)).toISOString(),
    labelKnownAt: new Date(Date.UTC(2024, 0, 2 + i, 3)).toISOString(),
  }));
  const gates = { minimumSamples: 500, minimumTestSamples: 100, nonOverlappingTest: true };
  const warm = planCandidate(rows, tuesday, gates);
  assert.equal(warm.status, "ready");
  const cold = planCandidate(rows.map(r => ({ ...r, labelKnownAt: monday })), tuesday, gates);
  assert.equal(cold.samples, 550);
  assert.equal(cold.status, "insufficient_data");
});

test("a research re-download preserves the clock of a matching row and restarts the clock for a correction", () => {
  const original = [first, second];
  const previous = { outcomes: original, availability: outcomeAvailability(original, [friday, monday]) };
  const corrected = [{ ...second, returnPct: 2 }, first];
  assert.deepEqual(researchOutcomeAvailability(corrected, tuesday, previous).knownAt, [tuesday, friday]);
  assert.deepEqual(researchOutcomeAvailability(original, tuesday, { outcomes: original }).knownAt, [tuesday, tuesday]);
});
