import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { collectSnapshot, publicText } from "../lib/consensus/collector.ts";
import { refreshPrivateCredit } from "../lib/consensus/private-credit.ts";
import { refreshAnalystRatings } from "../lib/consensus/analyst-ratings.ts";
import { refreshEtfFlows } from "../lib/consensus/etf-flows.ts";
import { refreshTaiwan } from "../lib/consensus/taiwan.ts";
import { digest, publishCollectedSnapshot, publishSnapshot } from "../lib/consensus/history.ts";
import { forecastSnapshot } from "../lib/consensus/model.ts";
import { freezeConsensus } from "../lib/consensus/as-issued.ts";
import { applyScoringPolicy } from "../lib/consensus/scoring-policy.ts";
import { readReservations, reservationAnchors, validateActiveModelTree } from "../lib/consensus/learning-audit.ts";
import type { ActiveModel } from "../lib/consensus/model.ts";
import { retainLastKnown } from "../lib/consensus/last-known.ts";
import { attachReview } from "../lib/consensus/reviewed.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const draftPath = resolve(root, ".consensus/last-collection.json");
if (process.argv[2] === "--publish-collected") {
  const [hash, base] = process.argv.slice(3);
  if (process.argv.length !== 5 || !/^[a-f0-9]{64}$/.test(hash) || !/^(?:none|[0-9TZ-]{20,30})$/.test(base))
    throw new Error("Usage: --publish-collected REVIEWED_DRAFT_SHA256 BASE_EDITION");
  const draft: Snapshot = JSON.parse(await readFile(draftPath, "utf8"));
  console.log(JSON.stringify(await publishCollectedSnapshot(root, draft, hash, base === "none" ? null : base)));
  process.exit(0);
}

let previous: Snapshot | null = null;
try {
  previous = JSON.parse(
    await readFile(resolve(root, "lib/consensus/current.json"), "utf8"),
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const reviewOnly = process.argv.includes("--review-only"),
  privateCreditOnly = process.argv.includes("--private-credit-only"),
  analystOnly = process.argv.includes("--analysts-only"),
  taiwanOnly = process.argv.includes("--taiwan-only"),
  etfFlowsOnly = process.argv.includes("--etf-flows-only"),
  now = new Date().toISOString();
if ([reviewOnly, privateCreditOnly, taiwanOnly, analystOnly, etfFlowsOnly].filter(Boolean).length > 1) throw new Error("Select only one scoped publication mode");
if ((reviewOnly || privateCreditOnly || taiwanOnly || analystOnly || etfFlowsOnly) && !previous)
  throw new Error(
    "A scoped publication requires an existing source snapshot",
  );
let snapshot: Snapshot = reviewOnly
  ? { ...previous!, id: now.replace(/[:.]/g, "-"), issuedAt: now, cutoff: now }
  : privateCreditOnly ? await refreshPrivateCredit(previous!, publicText)
  : taiwanOnly ? await refreshTaiwan(previous!, publicText)
  : etfFlowsOnly ? await refreshEtfFlows(previous!, publicText)
  : analystOnly ? await refreshAnalystRatings(previous!, publicText) : await collectSnapshot();
if (!reviewOnly && previous) snapshot = retainLastKnown(snapshot, previous);
const review = JSON.parse(
  await readFile(
    resolve(root, "lib/consensus/reviewed-developments.json"),
    "utf8",
  ),
);
snapshot = attachReview(snapshot, review);
snapshot = applyScoringPolicy(snapshot);
snapshot = freezeConsensus(snapshot);
const registry = JSON.parse(
  await readFile(resolve(root, "lib/consensus/models.json"), "utf8"),
) as { models: ActiveModel[] };
const reservations = await readReservations(root);
snapshot.evaluationAnchors = reservationAnchors(reservations);
for (const model of registry.models) await validateActiveModelTree(root, model, reservations);
snapshot.forecasts = forecastSnapshot(snapshot, registry.models);
await mkdir(resolve(root, ".consensus"), { recursive: true });
await writeFile(
  draftPath,
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
      sha256: digest(snapshot),
      baseEdition: previous?.id ?? "none",
      signals: snapshot.signals.length,
      available: snapshot.signals.filter(
        (signal) => signal.status === "available",
      ).length,
    }),
  );
