import {
  readFile,
  writeFile,
  mkdir,
  rename,
  readdir,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { acquirePublicationLock } from "../lib/publication-lock.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";
import { assertCommittedReservations } from "../lib/consensus/learning-audit.ts";
import { asIssuedConsensus } from "../lib/consensus/as-issued.ts";
import { digest, validateSnapshot } from "../lib/consensus/history.ts";
import { evaluateOutcome, performance, selectScoredOutcomes } from "../lib/consensus/evaluation.ts";
import type { PriceEvidence } from "../lib/consensus/evaluation.ts";
import { planCandidate, evaluateCandidate } from "../lib/consensus/learning.ts";
import type { TrainingRow } from "../lib/consensus/learning.ts";
import { readReservations, reserveEvaluation, promotionEvidence, LEARNING_POLICY,
  PROSPECTIVE_MINIMUM, MINIMUM_TEST_LABELS, validateActiveModelTree } from "../lib/consensus/learning-audit.ts";
import type { ActiveModel } from "../lib/consensus/model.ts";
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
const argument = process.argv.indexOf("--prices"),
  supplied: PriceEvidence[] =
    argument < 0
      ? []
      : JSON.parse(await readFile(resolve(process.argv[argument + 1]), "utf8"));
if (
  !Array.isArray(supplied) ||
  new Set(supplied.map((item) => item.instrument)).size !== supplied.length ||
  supplied.some((item) => !INSTRUMENTS.includes(item.instrument))
)
  throw new Error("One verified price evidence set per instrument required");
const release = await acquirePublicationLock(root, "evaluation");
try {
  await assertCommittedReservations(root);
  let outcomes: Outcome[] = [];
  try {
    outcomes = JSON.parse(
      await readFile(resolve(dir, "outcomes.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = (row: Outcome) =>
    `${row.snapshotId}:${row.instrument}:${row.horizon}`;
  for (const snapshot of snapshots)
    for (const prices of supplied)
      for (const horizon of HORIZONS) {
        const row = evaluateOutcome(snapshot, prices, horizon, now);
        if (row && !outcomes.some((previous) => key(previous) === key(row)))
          outcomes.push(row);
      }
  const selection = selectScoredOutcomes(outcomes),
    metrics = performance(outcomes),
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
  for (const model of registry.models) await validateActiveModelTree(root, model, reservations);
  for (const instrument of INSTRUMENTS.filter((symbol) => symbol !== "MARKET"))
    for (const horizon of HORIZONS) {
      const sample = outcomes.filter(
          (row) => row.instrument === instrument && row.horizon === horizon,
        ),
        stats = performance(sample);
      cohorts.push({
        instrument,
        horizon,
        resolved: stats.resolved,
        calls: stats.calls,
        accuracy: stats.accuracy,
        meanSignedReturnPct: stats.meanSignedReturnPct,
        meanBuyHoldReturnPct: stats.meanBuyHoldReturnPct,
        brier: stats.brier,
      });
      const trainingRows: TrainingRow[] = [];
      // Training and reported performance use exactly the same predeclared edition.
      for (const row of selection.selected.filter((item) =>
        item.instrument === instrument && item.horizon === horizon,
      )) {
        const snapshot = snapshots.find((item) => item.id === row.snapshotId);
        if (!snapshot) throw new Error("Outcome references missing snapshot");
        const consensus = asIssuedConsensus(
          snapshot,
          instrument,
          horizon,
        );
        const features = consensus.families.flatMap((family) => [
          family.score ?? 0,
          family.score === null ? 0 : 1,
        ]);
        trainingRows.push({
          id: key(row),
          issuedAt: snapshot.issuedAt,
          labelKnownAt: row.exitAt,
          features,
          up: row.returnPct > 0 ? 1 : 0,
        });
      }
      const incumbent = registry.models.find(
          (model) =>
            model.instrument === instrument && model.horizon === horizon,
        );
      const prior = reservations.filter((record) => record.instrument === instrument && record.horizon === horizon)
        .sort((a, b) => b.attempt - a.attempt)[0];
      const plan = planCandidate(trainingRows, now, {
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
      const contextHash = digest({ datasetHash: result.datasetHash, policy: LEARNING_POLICY, priceAdjustment: OUTCOME_PRICE_BASIS,
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
        await writeFile(
          resolve(dir, "models", `active-${active.id}.json`),
          `${JSON.stringify(active, null, 2)}\n`,
          { flag: "wx" },
        );
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
      try {
        await writeFile(
          resolve(dir, artifact),
          `${JSON.stringify({ ...result, promoted: promote, promotionEvidence: gate, instrument, horizon, priceAdjustment: OUTCOME_PRICE_BASIS, evaluatedAt: now, activated: promote, featureSchema: "family-score-plus-observation-mask-v1" }, null, 2)}\n`,
          { flag: "wx" },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      learning.push({
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
    generatedAt: now,
    status: supplied.length ? "tracking" : "awaiting_price_evidence",
    resolved: metrics.resolved,
    calls: metrics.calls,
    abstentions: metrics.abstentions,
    accuracy: metrics.accuracy,
    brier: metrics.brier,
    scoringPolicy: selection.policy,
    superseded: metrics.superseded,
    cohorts,
    learning,
    note: "Raw provider prices stay private. The outcome audit ledger is never rewritten. Scoring and training select the last edition before each entry open, separately per instrument and horizon. Superseded editions are retained. Promotion requires 100 non-overlapping, previously uninspected test labels, a durable reservation even for failures, baseline improvement and a paired block-bootstrap gate adjusted across cohorts and repeated attempts. Overlapping horizons are not a portfolio.",
  };
  for (const [path, content] of [
    [resolve(dir, "outcomes.json"), outcomes],
    [resolve(dir, "outcome-selection.json"), { policy: selection.policy, superseded: selection.superseded }],
    [registryPath, registry],
    [resolve(root, "lib/consensus/performance.json"), report],
  ] as const) {
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(content, null, 2)}\n`);
    await rename(temp, path);
  }
  console.log(
    JSON.stringify({
      status: report.status,
      resolved: report.resolved,
      calls: report.calls,
      candidates: learning.length,
      trained: learning.filter((item) => item.status === "evaluated").length,
    }),
  );
} finally {
  await release();
}
