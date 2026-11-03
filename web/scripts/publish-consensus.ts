import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { collectSnapshot } from "../lib/consensus/collector.ts";
import { publishSnapshot } from "../lib/consensus/history.ts";
import { forecastSnapshot } from "../lib/consensus/model.ts";
import { freezeConsensus } from "../lib/consensus/as-issued.ts";
import type { ActiveModel } from "../lib/consensus/model.ts";
import { retainLastKnown } from "../lib/consensus/last-known.ts";
import { attachReview } from "../lib/consensus/reviewed.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let previous: Snapshot | null = null;
try {
  previous = JSON.parse(
    await readFile(resolve(root, "lib/consensus/current.json"), "utf8"),
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const reviewOnly = process.argv.includes("--review-only"),
  now = new Date().toISOString();
if (reviewOnly && !previous)
  throw new Error(
    "A review-only publication requires an existing source snapshot",
  );
let snapshot: Snapshot = reviewOnly
  ? { ...previous!, id: now.replace(/[:.]/g, "-"), issuedAt: now, cutoff: now }
  : await collectSnapshot();
if (!reviewOnly && previous) snapshot = retainLastKnown(snapshot, previous);
const review = JSON.parse(
  await readFile(
    resolve(root, "lib/consensus/reviewed-developments.json"),
    "utf8",
  ),
);
snapshot = attachReview(snapshot, review);
snapshot = freezeConsensus(snapshot);
const registry = JSON.parse(
  await readFile(resolve(root, "lib/consensus/models.json"), "utf8"),
) as { models: ActiveModel[] };
snapshot.forecasts = forecastSnapshot(snapshot, registry.models);
await mkdir(resolve(root, ".consensus"), { recursive: true });
await writeFile(
  resolve(root, ".consensus/last-collection.json"),
  JSON.stringify(snapshot, null, 2),
);
if (process.argv.includes("--publish")) {
  const result = await publishSnapshot(root, snapshot);
  console.log(
    JSON.stringify({
      ...result,
      available: snapshot.signals.filter(
        (signal) => signal.status === "available",
      ).length,
      unavailable: snapshot.signals.filter(
        (signal) => signal.status !== "available",
      ).length,
    }),
  );
} else
  console.log(
    JSON.stringify({
      draft: ".consensus/last-collection.json",
      signals: snapshot.signals.length,
      available: snapshot.signals.filter(
        (signal) => signal.status === "available",
      ).length,
    }),
  );
