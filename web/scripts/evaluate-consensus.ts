import {
  readFile,
  writeFile,
  mkdir,
  open,
  unlink,
  rename,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { asIssuedConsensus } from "../lib/consensus/as-issued.ts";
import { digest, validateSnapshot } from "../lib/consensus/history.ts";
import { evaluateOutcome, performance } from "../lib/consensus/evaluation.ts";
import type { PriceEvidence } from "../lib/consensus/evaluation.ts";
import { trainCandidate } from "../lib/consensus/learning.ts";
import type { TrainingRow } from "../lib/consensus/learning.ts";
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
await mkdir(resolve(root, ".editorial"), { recursive: true });
const lockPath = resolve(root, ".editorial/publish.lock"),
  lock = await open(lockPath, "wx", 0o600);
try {
  await lock.writeFile(
    JSON.stringify({ kind: "evaluation", startedAt: now, pid: process.pid }),
  );
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
  const metrics = performance(outcomes),
    cohorts: PerformanceReport["cohorts"] = [],
    learning: PerformanceReport["learning"] = [];
  const registryPath = resolve(root, "lib/consensus/models.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
    schemaVersion: number;
    models: ActiveModel[];
    note: string;
  };
  await mkdir(resolve(dir, "models"), { recursive: true });
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
      const byEntry = new Map<string, TrainingRow>();
      // Multiple corrections before the same session cannot inflate training sample counts.
      for (const row of [...sample].sort((a, b) =>
        a.issuedAt.localeCompare(b.issuedAt),
      )) {
        if (byEntry.has(row.entryAt)) continue;
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
        byEntry.set(row.entryAt, {
          id: key(row),
          issuedAt: snapshot.issuedAt,
          labelKnownAt: row.exitAt,
          features,
          up: row.returnPct > 0 ? 1 : 0,
        });
      }
      const trainingRows = [...byEntry.values()],
        incumbent = registry.models.find(
          (model) =>
            model.instrument === instrument && model.horizon === horizon,
        );
      const result = trainCandidate(trainingRows, now, incumbent?.model),
        artifact = `models/${instrument}-${horizon}-${result.datasetHash.slice(0, 16)}.json`;
      const newLabels = incumbent
        ? trainingRows.filter(
            (row) => row.labelKnownAt > incumbent.labelsThrough,
          ).length
        : trainingRows.length;
      const promote =
        result.status === "evaluated" &&
        result.promoted &&
        result.datasetHash !== incumbent?.datasetHash &&
        newLabels >= 20;
      if (promote && result.status === "evaluated") {
        const active: ActiveModel = {
          id: `${instrument}-${horizon}-${result.datasetHash.slice(0, 16)}`,
          instrument,
          horizon,
          trainedAt: now,
          labelsThrough: trainingRows
            .map((row) => row.labelKnownAt)
            .sort()
            .at(-1)!,
          datasetHash: result.datasetHash,
          samples: result.samples,
          featureSchema: "family-score-plus-observation-mask-v1",
          model: result.model,
          testBrier: result.candidateBrier,
          baselineBrier: Math.min(result.coinBrier, result.baseRateBrier),
          testSamples: result.split.test,
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
          `${JSON.stringify({ ...result, instrument, horizon, evaluatedAt: now, activated: promote, featureSchema: "family-score-plus-observation-mask-v1" }, null, 2)}\n`,
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
        promoted: promote || !!incumbent,
        reason: result.reason,
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
    cohorts,
    learning,
    note: "Raw provider prices stay private. As-issued outcomes are never rewritten. Forecasts are evaluated per instrument and horizon; overlapping horizons are not a tradable portfolio. Candidate promotion requires chronological holdout gates and at least 20 newly resolved labels since the incumbent.",
  };
  for (const [path, content] of [
    [resolve(dir, "outcomes.json"), outcomes],
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
  await lock.close();
  await unlink(lockPath).catch(() => undefined);
}
