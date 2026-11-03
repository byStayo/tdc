import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, validateSnapshot } from "../lib/consensus/history.ts";
import type { Snapshot, HistoryEntry } from "../lib/consensus/types.ts";
import { performance } from "../lib/consensus/evaluation.ts";
import { readReservations, validateActiveModelTree } from "../lib/consensus/learning-audit.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const current: Snapshot = JSON.parse(
  await readFile(resolve(root, "lib/consensus/current.json"), "utf8"),
);
const history: HistoryEntry[] = JSON.parse(
  await readFile(resolve(root, "public/consensus/index.json"), "utf8"),
);
validateSnapshot(current, "archive");
if (
  !history.length ||
  new Set(history.map((entry) => entry.id)).size !== history.length ||
  history.at(-1)?.id !== current.id
)
  throw new Error("History index does not end at the current edition");
for (const [i, entry] of history.entries()) {
  if (i && entry.issuedAt <= history[i - 1].issuedAt)
    throw new Error("History is not chronological");
  const snapshot: Snapshot = JSON.parse(
    await readFile(
      resolve(root, "public/consensus", `${entry.id}.json`),
      "utf8",
    ),
  );
  validateSnapshot(snapshot, "archive");
  if (
    digest(snapshot) !== entry.sha256 ||
    snapshot.id !== entry.id ||
    snapshot.issuedAt !== entry.issuedAt ||
    snapshot.engineVersion !== entry.engineVersion
  )
    throw new Error("Immutable history failed verification");
}
if (digest(current) !== history.at(-1)!.sha256)
  throw new Error("Current edition differs from its immutable archive");
const outcomes = JSON.parse(
  await readFile(resolve(root, "public/consensus/outcomes.json"), "utf8"),
);
performance(outcomes);
const registry = JSON.parse(
  await readFile(resolve(root, "lib/consensus/models.json"), "utf8"),
);
const reservations = await readReservations(root);
for (const model of registry.models) {
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
