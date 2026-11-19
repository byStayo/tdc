import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { durableJSON } from "../lib/publication-storage.ts";
import { collectSnapshot, publicText } from "../lib/consensus/collector.ts";
import { refreshPrivateCredit } from "../lib/consensus/private-credit.ts";
import { refreshAnalystRatings } from "../lib/consensus/analyst-ratings.ts";
import { refreshEtfFlows } from "../lib/consensus/etf-flows.ts";
import { loadFirstRatePremarket, loadFirstRateTechnicals, replaceFirstRatePremarket, replaceTechnicalSignals } from "../lib/consensus/firstrate.ts";
import { loadTltClosingTrend } from "../lib/consensus/tlt-close-preparation.ts";
import { TLT_CLOSE_ID } from "../lib/consensus/tlt-close-signal.ts";
import { refreshTaiwan } from "../lib/consensus/taiwan.ts";
import { digest, publishCollectedSnapshot, publishSnapshot } from "../lib/consensus/history.ts";
import { forecastSnapshot, permitsModelInputs } from "../lib/consensus/model.ts";
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
  technicalsOnly = process.argv.includes("--technicals-only"),
  now = new Date().toISOString();
const scoped = [reviewOnly, privateCreditOnly, taiwanOnly, analystOnly, etfFlowsOnly, technicalsOnly].filter(Boolean).length;
if (scoped > 1) throw new Error("Select only one scoped publication mode");
if (scoped && !previous)
  throw new Error(
    "A scoped publication requires an existing source snapshot",
  );
let snapshot: Snapshot = reviewOnly || technicalsOnly
  ? { ...previous!, id: now.replace(/[:.]/g, "-"), issuedAt: now, cutoff: now }
  : privateCreditOnly ? await refreshPrivateCredit(previous!, publicText)
  : taiwanOnly ? await refreshTaiwan(previous!, publicText)
  : etfFlowsOnly ? await refreshEtfFlows(previous!, publicText)
  : analystOnly ? await refreshAnalystRatings(previous!, publicText) : await collectSnapshot(fetch, previous ?? undefined);
if (!scoped || technicalsOnly) {
  const readings = await loadFirstRateTechnicals(root, snapshot.cutoff).catch((error: Error) => {
    console.error(`FirstRate technical observations unavailable: ${error.message}`);
    return [];
  });
  const tlt = await loadTltClosingTrend(root, snapshot.cutoff).catch((error: Error) => {
    console.error(`TLT closing trend unavailable: ${error.message}`);
    return null;
  });
  const signals = replaceTechnicalSignals(snapshot.signals.filter(s => s.id !== TLT_CLOSE_ID), readings, snapshot.cutoff);
  const missing = signals.find(s => s.id === "daily-prices");
  if (tlt) {
    signals.push(tlt);
    if (missing?.instruments.includes("TLT")) {
      const others = missing.instruments.filter(symbol => symbol !== "TLT");
      const reason = "TLT’s closing trend is available. Its regular-session open and intraday range still need verified prices." +
        (others.length ? ` Full price-based technical readings are also pending for ${others.join(", ")}.` : "");
      const title = others.length ? "Incomplete regular-session price inputs" : "Regular-session open and range";
      Object.assign(missing, { title, shortLabel: title, summary: reason, limitation: reason, reason });
    }
  }
  snapshot = { ...snapshot, signals, sourcesAttempted: technicalsOnly ? 2 : snapshot.sourcesAttempted + 2,
    collectionErrors: [...snapshot.collectionErrors.filter(msg => !msg.startsWith("daily-prices:")),
      ...(missing ? [`daily-prices: ${missing.instruments.join(", ")}. ${missing.summary}`] : [])] };
}
const premarket = !scoped || technicalsOnly ? await loadFirstRatePremarket(root, snapshot.cutoff).catch(() => []) : undefined;
const withPremarket = replaceFirstRatePremarket(snapshot.signals, premarket, snapshot.cutoff);
if (withPremarket !== snapshot.signals) {
  const ids = ["premarket-bars", "previous-premarket-bars"];
  snapshot = { ...snapshot, signals: withPremarket,
    collectionErrors: [...snapshot.collectionErrors.filter(msg => !ids.some(id => msg.startsWith(id + ":"))),
      ...withPremarket.filter(s => ids.includes(s.id) && s.status === "unavailable")
        .map(s => `${s.id}: ${s.instruments.join(", ")}. ${s.summary}`)] };
}
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
snapshot.forecasts = forecastSnapshot(snapshot, registry.models.filter(model =>
  permitsModelInputs(snapshot, model.instrument, model.horizon)));
await durableJSON(draftPath, snapshot);
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
