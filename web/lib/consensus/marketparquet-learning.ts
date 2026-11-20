import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digest } from "./history.ts";
import { outcomeTrainingRow, selectScoredOutcomes } from "./evaluation.ts";
import { planCandidate, type ReadyCandidate, type TrainingRow, type evaluateCandidate } from "./learning.ts";
import { LEARNING_POLICY, MINIMUM_TEST_LABELS, PROSPECTIVE_MINIMUM, resamplesForAlpha,
  type EvaluationReservation, type PromotionEvidence } from "./learning-audit.ts";
import { permitsModelInputs } from "./model.ts";
import { MARKETPARQUET_SOURCE } from "./marketparquet-aggregate.ts";
import { loadEvaluationOutcomes } from "./outcome-ledger.ts";
import type { Horizon, Instrument, Outcome, Snapshot } from "./types.ts";

type Candidate = Extract<ReturnType<typeof evaluateCandidate>, { status: "evaluated" }>;
export type MarketParquetHoldout = { testLabels: number; candidateBrier: number; baseRateBrier: number; coinBrier: number; passed: boolean };
type SavedResult = { engineVersion: string; datasetHash: string; attempt: number;
  candidate: Candidate; gate: PromotionEvidence; summary: MarketParquetHoldout };
type CanonicalResult = Candidate & { instrument: Instrument; horizon: Horizon; promotionEvidence: PromotionEvidence | null };

async function optionalJSON<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Validate existing evidence without fitting, scoring labels or repeating a test. */
function matchingSummary(candidate: Candidate, gate: PromotionEvidence, plan: ReadyCandidate,
  reservation: EvaluationReservation): MarketParquetHoldout | null {
  if (!candidate || !gate || candidate.status !== "evaluated" || candidate.engineVersion !== reservation.engineVersion ||
      candidate.datasetHash !== reservation.datasetHash || candidate.samples !== plan.samples || candidate.minimum !== plan.minimum ||
      JSON.stringify(candidate.split) !== JSON.stringify({ train: plan.split.train.length, validation: plan.split.validation.length,
        test: plan.split.test.length, trainEnds: plan.split.train.at(-1)!.labelKnownAt,
        testStarts: reservation.testStarts, testEnds: reservation.consumedThrough }) ||
      gate.policy !== LEARNING_POLICY || gate.engineVersion !== reservation.engineVersion || gate.attempt !== reservation.attempt ||
      gate.alpha !== reservation.alpha || gate.incumbentId !== reservation.incumbentId ||
      gate.consumedThrough !== reservation.consumedThrough || gate.nonOverlappingTestLabels !== reservation.testIds.length ||
      gate.candidateModelHash !== digest(candidate.model) || typeof candidate.promoted !== "boolean" || typeof gate.passes !== "boolean" ||
      ![candidate.candidateBrier, candidate.baseRateBrier, candidate.coinBrier,
        ...(reservation.incumbentId ? [candidate.incumbentBrier] : [])].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1))
    return null;
  const baselines = ["base-rate", "coin", ...(reservation.incumbentId ? ["incumbent"] : [])];
  if (!Array.isArray(gate.comparisons) || gate.comparisons.length !== baselines.length ||
      baselines.some(name => gate.comparisons.filter(item => item?.baseline === name).length !== 1) ||
      gate.comparisons.some(item => !Number.isFinite(item.meanImprovement) || Math.abs(item.meanImprovement) > 1 ||
        !Array.isArray(item.interval95) || item.interval95.length !== 2 || !item.interval95.every(Number.isFinite) ||
        item.interval95[0] > item.interval95[1] || !Number.isFinite(item.pValue) || item.pValue < 1 / (item.resamples + 1) || item.pValue > 1 ||
        item.resamples !== resamplesForAlpha(reservation.alpha) || item.blockLength !== Math.ceil(Math.cbrt(reservation.testIds.length)) ||
        Math.abs(item.meanImprovement - ((item.baseline === "coin" ? candidate.coinBrier :
          item.baseline === "base-rate" ? candidate.baseRateBrier : candidate.incumbentBrier!) - candidate.candidateBrier)) > 1e-12) ||
      gate.passes !== gate.comparisons.every(item => item.meanImprovement > .01 && item.interval95[0] > 0 && item.pValue <= reservation.alpha))
    return null;
  const passed = candidate.promoted && gate.passes;
  if (passed && !(candidate.candidateBrier < candidate.baseRateBrier - .01 && candidate.candidateBrier < candidate.coinBrier - .01)) return null;
  return { testLabels: reservation.testIds.length, candidateBrier: candidate.candidateBrier,
    baseRateBrier: candidate.baseRateBrier, coinBrier: candidate.coinBrier, passed };
}

/** Caller holds the publication lock and has verified the evaluation release manifest. */
export async function marketParquetHoldouts(root: string, snapshots: Snapshot[], reservations: EvaluationReservation[]) {
  const state = await optionalJSON<{ artifacts: Record<string, string> }>(resolve(root, "lib/consensus/evaluation-state.json"));
  const artifacts: CanonicalResult[] = [];
  for (const [path, sha256] of Object.entries(state?.artifacts ?? {})) {
    if (!/^public\/consensus\/models\/[A-Za-z0-9_-]+\.json$/.test(path)) continue;
    const artifact = await optionalJSON<CanonicalResult>(resolve(root, path));
    if (artifact?.status === "evaluated" && digest(artifact) === sha256) artifacts.push(artifact);
  }
  const byId = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
  let canonical: Outcome[] = [];
  if (artifacts.length) {
    // A public checkout can verify artifacts without holding the private journal.
    // Missing or unverifiable attribution keeps the source-specific score pending.
    try { canonical = selectScoredOutcomes(await loadEvaluationOutcomes(root)).selected; }
    catch { /* Counts and eligibility do not depend on a reusable model summary. */ }
  }
  return async (instrument: Instrument, horizon: Horizon, rows: TrainingRow[], engineVersion: string, datasetHash: string): Promise<MarketParquetHoldout | null> => {
    const matching = reservations.filter(r => r.instrument === instrument && r.horizon === horizon &&
      r.engineVersion === engineVersion && r.datasetHash === datasetHash).sort((a, b) => b.attempt - a.attempt);
    for (const reservation of matching) {
      const preceding = reservations.find(r => r.instrument === instrument && r.horizon === horizon && r.attempt === reservation.attempt - 1);
      const plan = planCandidate(rows, reservation.reservedAt, { engineVersion, consumedThrough: preceding?.consumedThrough,
        minimumSamples: PROSPECTIVE_MINIMUM, minimumTestSamples: MINIMUM_TEST_LABELS, nonOverlappingTest: true });
      if (plan.status !== "ready" || plan.datasetHash !== datasetHash ||
          JSON.stringify(plan.split.test.map(({ id, issuedAt, labelKnownAt }) => ({ id, issuedAt, labelKnownAt }))) !== JSON.stringify(reservation.testWindows) ||
          JSON.stringify(plan.split.test.map(row => row.id)) !== JSON.stringify(reservation.testIds)) continue;
      const saved = await optionalJSON<SavedResult>(resolve(root, ".consensus/private-marketparquet", `validation-${instrument}-${horizon}.json`));
      if (saved?.engineVersion === engineVersion && saved.datasetHash === datasetHash && saved.attempt === reservation.attempt) {
        const summary = matchingSummary(saved.candidate, saved.gate, plan, reservation);
        if (summary && JSON.stringify(saved.summary) === JSON.stringify(summary)) return summary;
      }
      const cohort = canonical.filter(row => row.engineVersion === engineVersion && row.instrument === instrument && row.horizon === horizon);
      if (cohort.some(row => !byId.has(row.snapshotId))) continue;
      const eligible = cohort.filter(row => permitsModelInputs(byId.get(row.snapshotId)!, instrument, horizon));
      // Training hashes omit price-source names. Equal signs from another feed
      // must not become MarketParquet model performance by association.
      if (!eligible.length || eligible.some(row => row.source !== MARKETPARQUET_SOURCE) ||
          planCandidate(eligible.map(row => outcomeTrainingRow(row, byId.get(row.snapshotId)!)), reservation.reservedAt,
            { engineVersion }).datasetHash !== datasetHash) continue;
      for (const artifact of artifacts) {
        if (artifact.instrument !== instrument || artifact.horizon !== horizon || artifact.engineVersion !== engineVersion ||
            artifact.datasetHash !== datasetHash || artifact.promotionEvidence?.attempt !== reservation.attempt) continue;
        const summary = matchingSummary(artifact, artifact.promotionEvidence, plan, reservation);
        if (summary) return summary;
      }
    }
    return null;
  };
}
