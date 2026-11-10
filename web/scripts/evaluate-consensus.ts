import {
  readFile,
  mkdir,
  readdir,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { commitEvaluationTransaction, recoverEvaluationTransaction, type EvaluationWrite } from "../lib/consensus/evaluation-transaction.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";
import { assertCommittedReservations } from "../lib/consensus/learning-audit.ts";
import { digest, validateSnapshot } from "../lib/consensus/history.ts";
import { evaluateOutcome, outcomeKey, outcomeTrainingRow, performance, selectScoredOutcomes } from "../lib/consensus/evaluation.ts";
import type { PriceEvidence } from "../lib/consensus/evaluation.ts";
import { planCandidate, evaluateCandidate } from "../lib/consensus/learning.ts";
import type { TrainingRow } from "../lib/consensus/learning.ts";
import { readReservations, reserveEvaluation, promotionEvidence, LEARNING_POLICY,
  PROSPECTIVE_MINIMUM, MINIMUM_TEST_LABELS, validateActiveModelTree } from "../lib/consensus/learning-audit.ts";
import type { ActiveModel } from "../lib/consensus/model.ts";
import { ENGINE_VERSION } from "../lib/consensus/registry.ts";
import { HORIZONS, INSTRUMENTS } from "../lib/consensus/types.ts";
import type {
  HistoryEntry,
  Outcome,
  Snapshot,
} from "../lib/consensus/types.ts";
import type { PerformanceReport } from "../lib/consensus/performance-types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  dir = resolve(root, "public/consensus");
const now = new Date().toISOString();
const argument = process.argv.indexOf("--prices"),
  supplied: PriceEvidence[] =
    argument < 0
      ? []
      : JSON.parse(await readFile(resolve(process.argv[argument + 1]), "utf8"));
if (
  !Array.isArray(supplied) ||
  new Set(supplied.map((item) => item.instrument)).size !== supplied.length ||
  supplied.some((item) => !INSTRUMENTS.includes(item.instrument) || item.instrument === "MARKET")
)
  throw new Error("One verified price evidence set per instrument required");
const release = await acquirePublicationLock(root, "evaluation");
let failure: {error: unknown} | undefined;
try {
  if (await recoverEvaluationTransaction(root)) {
    console.log(JSON.stringify({ status: "recovered_evaluation_transaction", retrained: false }));
  } else {
    await assertCommittedReservations(root);
    const index: HistoryEntry[] = JSON.parse(
      await readFile(resolve(dir, "index.json"), "utf8"),
    );
    const snapshots = await Promise.all(
      index.map(async (entry) => {
        const snapshot: Snapshot = JSON.parse(
          await readFile(resolve(dir, `${entry.id}.json`), "utf8"),
        );
        validateSnapshot(snapshot, "archive");
        if (digest(snapshot) !== entry.sha256)
          throw new Error("Snapshot integrity failed");
        return snapshot;
      }),
    );
    const writes: EvaluationWrite[] = [];
    const pending: NonNullable<PerformanceReport["pending"]> = [];
    let outcomes: Outcome[] = [];
    try {
      outcomes = JSON.parse(
        await readFile(resolve(dir, "outcomes.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const snapshot of snapshots)
      for (const instrument of INSTRUMENTS.filter(symbol => symbol !== "MARKET"))
        for (const horizon of HORIZONS) {
          const target = { snapshotId: snapshot.id, instrument, horizon };
          const prices = supplied.find(item => item.instrument === instrument);
          const row = prices ? evaluateOutcome(snapshot, prices, horizon, now) : null;
          if (outcomes.some(previous => outcomeKey(previous) === outcomeKey(target))) continue;
          if (row) outcomes.push(row);
          else pending.push({ ...target, reason: prices
            ? "Awaiting verified prices or independently reviewed calendar coverage."
            : "No verified price evidence supplied for this instrument." });
        }
    for (const row of outcomes) {
      if (snapshots.find(s => s.id === row.snapshotId)?.engineVersion !== row.engineVersion)
        throw new Error("Outcome engine version differs from its immutable edition");
    }
    const selection = selectScoredOutcomes(outcomes),
      metrics = performance(outcomes, 2, ENGINE_VERSION),
      cohorts: PerformanceReport["cohorts"] = [],
      learning: PerformanceReport["learning"] = [];
    const registryPath = resolve(root, "lib/consensus/models.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      schemaVersion: number;
      models: ActiveModel[];
      note: string;
    };
    await mkdir(resolve(dir, "models"), { recursive: true });
    const reservations = await readReservations(root);
    // Never silently restart the holdout ledger after an earlier untracked evaluation.
    for (const name of (await readdir(resolve(dir, "models"))).filter((name) => name.endsWith(".json"))) {
      const saved = JSON.parse(await readFile(resolve(dir, "models", name), "utf8"));
      if (saved.status === "evaluated" && !saved.promotionEvidence)
        throw new Error("Legacy prospective test inspection requires an explicit audit migration before further evaluation");
      if (saved.promotionEvidence && !reservations.some((record) =>
        record.instrument === saved.instrument && record.horizon === saved.horizon &&
        record.attempt === saved.promotionEvidence.attempt && record.datasetHash === saved.datasetHash))
        throw new Error("Candidate is missing its durable test reservation");
    }
    for (const model of registry.models) {
      if (model.engineVersion !== ENGINE_VERSION) throw new Error("Deactivate incompatible incumbent before evaluating a new rule version");
      await validateActiveModelTree(root, model, reservations);
    }
    for (const instrument of INSTRUMENTS.filter((symbol) => symbol !== "MARKET"))
      for (const horizon of HORIZONS) {
        const sample = outcomes.filter(row => row.instrument === instrument && row.horizon === horizon);
        for (const engineVersion of [...new Set([ENGINE_VERSION, ...snapshots.map(s => s.engineVersion)])]) {
          const stats = performance(sample, 2, engineVersion);
          cohorts.push({instrument, horizon, engineVersion, resolved:stats.resolved, calls:stats.calls,
            accuracy:stats.accuracy, meanSignedReturnPct:stats.meanSignedReturnPct,
            meanBuyHoldReturnPct:stats.meanBuyHoldReturnPct, brier:stats.brier});
        }
        const trainingRows: TrainingRow[] = [];
        // Training and reported performance use exactly the same predeclared edition.
        for (const row of selection.selected.filter((item) =>
          item.instrument === instrument && item.horizon === horizon && item.engineVersion === ENGINE_VERSION,
        )) {
          const snapshot = snapshots.find((item) => item.id === row.snapshotId);
          if (!snapshot) throw new Error("Outcome references missing snapshot");
          trainingRows.push(outcomeTrainingRow(row, snapshot));
        }
        const incumbent = registry.models.find(
            (model) =>
              model.instrument === instrument && model.horizon === horizon,
          );
        const prior = reservations.filter((record) => record.instrument === instrument && record.horizon === horizon)
          .sort((a, b) => b.attempt - a.attempt)[0];
        const plan = planCandidate(trainingRows, now, {
          engineVersion: ENGINE_VERSION,
          consumedThrough: prior?.consumedThrough,
          minimumSamples: PROSPECTIVE_MINIMUM,
          minimumTestSamples: MINIMUM_TEST_LABELS,
          nonOverlappingTest: true,
        });
        // Reserve before fitting/evaluating: failed candidates and crashes consume their test window too.
        const reservation = plan.status === "ready"
          ? await reserveEvaluation(root, reservations, plan, instrument, horizon, now, incumbent) : null;
        if (reservation) reservations.push(reservation);
        const result = plan.status === "ready" ? evaluateCandidate(plan, incumbent?.model) : plan;
        const gate = plan.status === "ready" && result.status === "evaluated" && reservation
          ? promotionEvidence(plan, result.model, reservation, incumbent?.model) : null;
        const contextHash = digest({ datasetHash: result.datasetHash, policy: LEARNING_POLICY, engineVersion: ENGINE_VERSION, priceAdjustment: OUTCOME_PRICE_BASIS,
          priorAttempt: prior?.attempt ?? 0, incumbent: incumbent?.id ?? null });
        const artifact = `models/${instrument}-${horizon}-wf2-${contextHash.slice(0, 16)}.json`;
        const promote =
          result.status === "evaluated" &&
          result.promoted &&
          result.datasetHash !== incumbent?.datasetHash &&
          gate?.passes === true;
        if (promote && result.status === "evaluated") {
          const active: ActiveModel = {
            id: `${instrument}-${horizon}-${result.datasetHash.slice(0, 16)}`,
            instrument,
            horizon,
            engineVersion: ENGINE_VERSION,
            trainedAt: now,
            labelsThrough: gate!.consumedThrough,
            datasetHash: result.datasetHash,
            samples: result.samples,
            featureSchema: "family-score-plus-observation-mask-v1",
            priceAdjustment: OUTCOME_PRICE_BASIS,
            model: result.model,
            testBrier: result.candidateBrier,
            baselineBrier: Math.min(result.coinBrier, result.baseRateBrier),
            testSamples: result.split.test,
            promotionEvidence: gate!,
          };
          writes.push({ path: `public/consensus/models/active-${active.id}.json`, value: active, immutable: true });
          registry.models = [
            ...registry.models.filter(
              (model) =>
                model.instrument !== instrument || model.horizon !== horizon,
            ),
            active,
          ];
          registry.note =
            "Active models passed prospective chronological gates. Previous model artifacts remain available for rollback; as-issued forecasts retain their original model identity.";
        }
        try { await readFile(resolve(dir, artifact)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          writes.push({ path: `public/consensus/${artifact}`, immutable: true,
            value: { ...result, promoted: promote, promotionEvidence: gate, instrument, horizon, engineVersion: ENGINE_VERSION, priceAdjustment: OUTCOME_PRICE_BASIS, evaluatedAt: now, activated: promote, featureSchema: "family-score-plus-observation-mask-v1" } });
        }
        learning.push({
          engineVersion: ENGINE_VERSION,
          instrument,
          horizon,
          samples: result.samples,
          minimum: result.minimum,
          status: result.status,
          promoted: promote,
          activeModelId: registry.models.find((model) => model.instrument === instrument && model.horizon === horizon)?.id ?? null,
          reason: promote ? "Candidate passed the reserved prospective gates and is active for future publications."
            : gate && !gate.passes ? "Candidate failed the paired-loss uncertainty or repeated-comparison gate; its test window is consumed." : result.reason,
          artifact,
        });
      }
    const report: PerformanceReport = {
      engineVersion: ENGINE_VERSION,
      generatedAt: now,
      status: supplied.length ? "tracking" : "awaiting_price_evidence",
      resolved: metrics.resolved,
      calls: metrics.calls,
      abstentions: metrics.abstentions,
      accuracy: metrics.accuracy,
      brier: metrics.brier,
      scoringPolicy: selection.policy,
      superseded: metrics.superseded,
      pending,
      cohorts,
      learning,
      note: "Raw provider prices stay private. The outcome audit ledger is never rewritten. Scoring and training select the last edition before each entry open, separately per instrument and horizon. Superseded editions are retained. Performance is separated by engine version; training and activation require one version. Alpha budgets and consumed windows never restart on a methodology change. Promotion requires 100 non-overlapping, previously uninspected test labels, a durable reservation even for failures, baseline improvement and a paired block-bootstrap gate adjusted across cohorts and repeated attempts. Overlapping horizons are not a portfolio.",
    };
    writes.push(
      { path: "public/consensus/outcomes.json", value: outcomes },
      { path: "public/consensus/outcome-selection.json", value: { policy: selection.policy, superseded: selection.superseded } },
      { path: "lib/consensus/models.json", value: registry },
      { path: "lib/consensus/performance.json", value: report },
    );
    await commitEvaluationTransaction(root, writes);
    console.log(
      JSON.stringify({
        status: report.status,
        resolved: report.resolved,
        calls: report.calls,
        pending: pending.length,
        candidates: learning.length,
        trained: learning.filter((item) => item.status === "evaluated").length,
      }),
    );
  }
} catch (error) {
  failure = {error};
  throw error;
} finally {
  await finishPublicationLock(release, failure);
}
