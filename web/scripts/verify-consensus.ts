import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import type { Outcome } from "../lib/consensus/types.ts";
import { outcomeWindowSessions, performance } from "../lib/consensus/evaluation.ts";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { readReservations, validateActiveModelTree } from "../lib/consensus/learning-audit.ts";
import { assertEvaluationReleaseState } from "../lib/consensus/evaluation-transaction.ts";
import { asIssuedConsensus } from "../lib/consensus/as-issued.ts";
import { FAMILIES } from "../lib/consensus/registry.ts";
import { HORIZONS, INSTRUMENTS } from "../lib/consensus/types.ts";
import type { PerformanceReport } from "../lib/consensus/performance-types.ts";

const args = process.argv.slice(2);
const audit = args[0] === "--audit";
const requireComplete = args[1] === "--require-complete";
if (args.length && (!audit || args.length !== (requireComplete ? 2 : 1)))
  throw new Error("Usage: verify-consensus.ts [--audit [--require-complete]]");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { current, history } = await verifyPublicationTree(root);
await assertEvaluationReleaseState(root);
const outcomes: Outcome[] = JSON.parse(
  await readFile(resolve(root, "public/consensus/outcomes.json"), "utf8"),
);
for (const row of outcomes) {
  if (history.find(entry => entry.id === row.snapshotId)?.engineVersion !== row.engineVersion)
    throw new Error("Outcome engine version differs from its immutable edition");
}
performance(outcomes, 2, current.engineVersion);
const registry = JSON.parse(
  await readFile(resolve(root, "lib/consensus/models.json"), "utf8"),
);
const reservations = await readReservations(root);
for (const model of registry.models) {
  if (model.engineVersion !== current.engineVersion) throw new Error("Active model engine version differs from current edition");
  await validateActiveModelTree(root, model, reservations);
  const archived = JSON.parse(
    await readFile(
      resolve(root, "public/consensus/models", `active-${model.id}.json`),
      "utf8",
    ),
  );
  if (digest(archived) !== digest(model))
    throw new Error("Active model has no matching archived version");
}
const integrity = {
  snapshots: history.length,
  signals: current.signals.length,
  outcomes: outcomes.length,
  activeModels: registry.models.length,
  integrity: "verified",
};
if (!audit) {
  console.log(JSON.stringify(integrity));
} else {
  const daily = asIssuedConsensus(current, "MARKET", "daily");
  const voting = new Set(daily.families.filter(family => family.score !== null).map(family => family.id));
  const missingFamilies = FAMILIES.filter(family => !voting.has(family.id)).map(family => family.id);
  const report: PerformanceReport = JSON.parse(await readFile(resolve(root, "lib/consensus/performance.json"), "utf8"));
  const missingModels = INSTRUMENTS.filter(instrument => instrument !== "MARKET")
    .flatMap(instrument => HORIZONS
      .filter(horizon => !registry.models.some((model: { instrument: string; horizon: string }) =>
        model.instrument === instrument && model.horizon === horizon))
      .map(horizon => ({ instrument, horizon })));
  const pendingTargets = report.pending?.length ?? null;
  const reviewedSessions = exchangeSessions(EXCHANGE_CALENDAR.from, EXCHANGE_CALENDAR.through);
  const issued = new Map(history.map(entry => [entry.id, entry.issuedAt]));
  const now = new Date().toISOString();
  const pendingByStatus = { priceEvidenceDue: 0, awaitingHorizon: 0, calendarCoverageMissing: 0 };
  for (const target of report.pending ?? []) {
    const issuedAt = issued.get(target.snapshotId);
    const horizon = HORIZONS.find(value => value === target.horizon);
    if (!issuedAt || !horizon) throw new Error("Pending outcome does not match an issued target");
    const exitDay = outcomeWindowSessions(issuedAt, horizon, reviewedSessions).at(-1);
    if (!exitDay) pendingByStatus.calendarCoverageMissing++;
    else if (exchangeSession(exitDay)!.closeAt > now) pendingByStatus.awaitingHorizon++;
    else pendingByStatus.priceEvidenceDue++;
  }
  // New editions naturally have pending outcomes until their horizons close.
  const ready = !missingFamilies.length && !missingModels.length && outcomes.length > 0 &&
    pendingTargets !== null && !pendingByStatus.priceEvidenceDue && !pendingByStatus.calendarCoverageMissing;
  console.log(JSON.stringify({
    ...integrity,
    edition: current.id,
    marketDaily: {
      observationCoverage: daily.coverage,
      directionalCoverage: daily.directionalCoverage,
      expectedFamilies: FAMILIES.length,
      votingFamilies: FAMILIES.filter(family => voting.has(family.id)).map(family => family.id),
      missingFamilies,
    },
    evaluation: { pendingTargets, pendingByStatus, missingModels },
    coverageAndModelGates: ready ? "complete" : "open",
  }, null, 2));
  if (requireComplete && !ready) process.exitCode = 2;
}
