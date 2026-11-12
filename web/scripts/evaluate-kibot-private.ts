import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { evaluateOutcome, outcomeKey, outcomeTrainingRow, selectScoredOutcomes } from "../lib/consensus/evaluation.ts";
import { EXCHANGE_CALENDAR } from "../lib/consensus/exchange-calendar.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { collectKibotPrices } from "../lib/consensus/kibot.ts";
import { planCandidate } from "../lib/consensus/learning.ts";
import { MINIMUM_TEST_LABELS, PROSPECTIVE_MINIMUM, readReservations } from "../lib/consensus/learning-audit.ts";
import { ENGINE_VERSION } from "../lib/consensus/registry.ts";
import { newYorkDate } from "../lib/consensus/time.ts";
import { HORIZONS, INSTRUMENTS } from "../lib/consensus/types.ts";
import type { Outcome } from "../lib/consensus/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-kibot");
const path = resolve(directory, "evaluation.json");
const release = await acquirePublicationLock(root, "private-kibot-evaluation");
let failure: { error: unknown } | undefined;
try {
  const now = new Date().toISOString();
  const { snapshots } = await verifyPublicationTree(root);
  const reservations = await readReservations(root);
  const byId = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
  const collectionStart = [newYorkDate(snapshots[0].issuedAt), EXCHANGE_CALENDAR.from,
    new Date(Date.parse(newYorkDate(now)) - 90 * 86400000).toISOString().slice(0, 10)].sort().at(-1)!;
  let outcomes: Outcome[] = [];
  try {
    const saved = JSON.parse(await readFile(path, "utf8"));
    if (saved.schemaVersion !== 2 || !Array.isArray(saved.outcomes) ||
        saved.outcomes.some((row: Outcome) => row.horizon !== "daily" ||
          byId.get(row.snapshotId)?.engineVersion !== row.engineVersion))
      throw new Error("Private outcome ledger differs from verified history");
    outcomes = saved.outcomes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const before = outcomes.length;
  const existing = new Set(outcomes.map(outcomeKey));
  if (existing.size !== outcomes.length) throw new Error("Duplicate private outcome");

  const { evidence, hashes, through } = await collectKibotPrices(collectionStart, now);
  // Guest adjustment data can lag issuer distributions. The common price
  // adjustment factor cancels between the open and close of the same session.
  for (const snapshot of snapshots)
    for (const prices of evidence) {
      if (existing.has(outcomeKey({ snapshotId: snapshot.id, instrument: prices.instrument, horizon: "daily" }))) continue;
      const row = evaluateOutcome(snapshot, prices, "daily", now);
      if (row) outcomes.push(row);
    }
  const selected = selectScoredOutcomes(outcomes).selected;
  const cohorts = [];
  for (const instrument of INSTRUMENTS.filter(symbol => symbol !== "MARKET"))
    for (const horizon of HORIZONS) {
      const rows = selected.filter(row => row.instrument === instrument && row.horizon === horizon &&
        row.engineVersion === ENGINE_VERSION).map(row => outcomeTrainingRow(row, byId.get(row.snapshotId)!));
      const consumedThrough = reservations.filter(record => record.instrument === instrument && record.horizon === horizon)
        .sort((a, b) => b.attempt - a.attempt)[0]?.consumedThrough;
      const plan = planCandidate(rows, now, {
        engineVersion: ENGINE_VERSION, consumedThrough,
        minimumSamples: PROSPECTIVE_MINIMUM, minimumTestSamples: MINIMUM_TEST_LABELS, nonOverlappingTest: true,
      });
      // Internal-only data cannot activate the public model. Leave eligible holdouts uninspected.
      cohorts.push({ instrument, horizon, samples: plan.samples, minimum: plan.minimum, status: plan.status });
    }
  const summary = {
    through, sourceSymbols: evidence.length, sessionsPerSymbol: evidence[0].sessions.length,
    added: outcomes.length - before, resolved: outcomes.length, selected: selected.length,
    pending: snapshots.length * evidence.length * HORIZONS.length - outcomes.length,
    candidatesEligible: cohorts.filter(cohort => cohort.status === "ready").length,
    trained: 0,
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, randomUUID() + ".tmp");
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({
        schemaVersion: 2, evaluatedAt: now, collectionStart, hashes, summary, cohorts, outcomes,
      }, null, 2) + "\n");
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
  console.log(JSON.stringify(summary));
} catch (error) {
  failure = { error };
  throw error;
} finally {
  await finishPublicationLock(release, failure);
}
