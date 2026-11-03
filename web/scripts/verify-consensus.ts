import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import type { Outcome } from "../lib/consensus/types.ts";
import { performance } from "../lib/consensus/evaluation.ts";
import { readReservations, validateActiveModelTree } from "../lib/consensus/learning-audit.ts";
import { assertEvaluationReleaseState } from "../lib/consensus/evaluation-transaction.ts";

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
console.log(
  JSON.stringify({
    snapshots: history.length,
    signals: current.signals.length,
    outcomes: outcomes.length,
    activeModels: registry.models.length,
    integrity: "verified",
  }),
);
