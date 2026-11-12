import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  rename,
  readdir,
} from "node:fs/promises";
import { resolve } from "node:path";
import { acquirePublicationLock, finishPublicationLock } from "../publication-lock.ts";
import { durableJSON, durableDirectory, syncDirectory } from "../publication-storage.ts";
import { assertNoPendingEvaluation } from "./evaluation-transaction.ts";
import { FAMILIES } from "./registry.ts";
import { MARKETPARQUET_AGGREGATE_FILE, validateMarketParquetAggregate } from "./marketparquet-aggregate.ts";
import { publicDate } from "../public-normalization.ts";
import { validateSourceCitation } from "./source-citation.ts";
import { INSTRUMENTS, HORIZONS } from "./types.ts";
import { CALENDAR_ZONES } from "./time.ts";
import { holdingsSignal, validateHoldings } from "./holdings.ts";
import { validatePrivateCredit } from "./private-credit.ts";
import { validateAnalystRatings } from "./analyst-ratings.ts";
import { validateEtfFlows } from "./etf-flows.ts";
import { validateFuturesOptions } from "./futures-options.ts";
import { validateTaiwan } from "./taiwan.ts";
import { freezeConsensus, validateConsensusRecords, versionedScoringPolicy } from "./as-issued.ts";
import type { Snapshot, HistoryEntry } from "./types.ts";
import {
  reviewedSignals,
  reviewedPolicySignals,
  reviewedEarningsCalendar,
  validateReview,
} from "./reviewed.ts";

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const date = (value: unknown) =>
  typeof value === "string" && !!publicDate(value);
const instant = (value: unknown) =>
  date(value) &&
  typeof value === "string" &&
  new Date(value).toISOString() === value;
export function validateSnapshot(snapshot: Snapshot, mode: "candidate" | "archive" = "candidate"): void {
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.origin !== "prospective" ||
    !/^[0-9TZ-]{20,30}$/.test(snapshot.id) ||
    !instant(snapshot.issuedAt) ||
    !instant(snapshot.cutoff) ||
    snapshot.cutoff > snapshot.issuedAt ||
    !snapshot.engineVersion
  )
    throw new Error("Invalid publication identity");
  if (
    !Array.isArray(snapshot.signals) ||
    !snapshot.signals.length ||
    new Set(snapshot.signals.map((s) => s.id)).size !== snapshot.signals.length
  )
    throw new Error("Signals must have unique identities");
  // Preserve the exact first Taiwan archive; its complete licence notice is supplied
  // separately at /consensus/ATTRIBUTION.txt and in the rendered source panel.
  // No new candidate or altered copy can use the earlier attribution format.
  const legacyTaiwanAttribution = mode === "archive" &&
    snapshot.id === "2026-11-04T22-24-25-360Z" &&
    digest(snapshot) === "cbfa41bc9745578cb32c7d6a5f872b29c4b10664d1df729f0114826ae7be973e";
  for (const signal of snapshot.signals) {
    validatePrivateCredit(signal);
    validateAnalystRatings(signal);
    validateEtfFlows(signal);
    validateFuturesOptions(signal);
    validateTaiwan(signal, legacyTaiwanAttribution);
    if (
      !FAMILIES.some((family) => family.id === signal.family) ||
      !signal.instruments.length ||
      signal.instruments.some((symbol) => !INSTRUMENTS.includes(symbol)) ||
      !signal.title ||
      !signal.methodology ||
      !signal.limitation
    )
      throw new Error(`Invalid signal contract: ${signal.id}`);
    if (
      !["available", "unavailable", "stale", "not_formed"].includes(
        signal.status,
      ) ||
      (signal.failureKind !== undefined &&
        !["transport", "validation"].includes(signal.failureKind)) ||
      !instant(signal.source.retrievedAt) ||
      Date.parse(signal.source.retrievedAt) > Date.parse(snapshot.cutoff)
    )
      throw new Error(`Invalid signal availability: ${signal.id}`);
    validateSourceCitation(signal.source.url);
    if (
      signal.status === "available" &&
      (!date(signal.source.observedAt) ||
        !signal.source.sha256 ||
        !/^[a-f0-9]{64}$/.test(signal.source.sha256))
    )
      throw new Error(`Available signal lacks provenance: ${signal.id}`);
    if (
      signal.source.observedAt &&
      Date.parse(signal.source.observedAt) > Date.parse(snapshot.cutoff)
    )
      throw new Error("Future observation");
    if (signal.directionalInstruments && (
      !Array.isArray(signal.directionalInstruments) ||
      new Set(signal.directionalInstruments).size !== signal.directionalInstruments.length ||
      signal.directionalInstruments.some(instrument => !signal.instruments.includes(instrument))
    )) throw new Error("Invalid directional instrument scope");
    for (const horizon of HORIZONS) {
      const score = signal.scores[horizon];
      if (
        score !== null &&
        (!Number.isFinite(score) ||
          Math.abs(score) > 1 ||
          signal.status !== "available")
      )
        throw new Error("Invalid directional score");
    }
    if (
      signal.series.some(
        (point, i) =>
          !date(point.date) ||
          Date.parse(point.date) > Date.parse(snapshot.cutoff) ||
          !Number.isFinite(point.value) ||
          (i > 0 && point.date <= signal.series[i - 1].date),
      )
    )
      throw new Error(
        `Unordered, duplicate, future or invalid series: ${signal.id}`,
      );
    if (
      signal.metrics.some(
        (metric) =>
          !Number.isFinite(metric.value) ||
          !date(metric.date) ||
          Date.parse(metric.date) > Date.parse(snapshot.cutoff),
      )
    )
      throw new Error("Invalid metric");
  }
  for (const catalyst of snapshot.catalysts) {
    validateSourceCitation(catalyst.url);
    if (
      !date(catalyst.at) ||
      !catalyst.title ||
      (catalyst.dateZone !== undefined &&
        (catalyst.at.length !== 10 ||
          !CALENDAR_ZONES.includes(catalyst.dateZone)))
    )
      throw new Error("Invalid catalyst");
    if (
      catalyst.kind === "release" &&
      Date.parse(catalyst.at) > Date.parse(snapshot.cutoff)
    )
      throw new Error("Future release");
  }
  if (snapshot.news) {
    const news = snapshot.news;
    const signal = snapshot.signals.find(
      (item) => item.id === "gdelt-finance-news",
    );
    const archiveURL = new URL(news.sourceUrl);
    if (
      !signal ||
      signal.status !== "available" ||
      signal.source.sha256 !== news.sourceHash ||
      !instant(news.batchAt) ||
      news.batchAt > snapshot.cutoff ||
      news.batchAt !== signal.source.observedAt ||
      archiveURL.protocol !== "https:" ||
      archiveURL.hostname !== "data.gdeltproject.org" ||
      archiveURL.search ||
      archiveURL.username ||
      archiveURL.password ||
      archiveURL.port ||
      !/^\/gdeltv2\/\d{14}\.gkg\.csv\.zip$/.test(archiveURL.pathname) ||
      !/^[a-f0-9]{64}$/.test(news.sourceHash) ||
      !Array.isArray(news.stories) ||
      news.stories.length !== news.storyCount ||
      news.storyCount < 1 ||
      news.positive + news.negative + news.balanced !== news.storyCount ||
      [
        news.positive,
        news.negative,
        news.balanced,
        news.matchedArticles,
        news.rowsScanned,
        news.publishers,
      ].some((value) => !Number.isInteger(value) || value < 0) ||
      news.matchedArticles < news.storyCount ||
      news.rowsScanned < news.matchedArticles ||
      news.meanTone === null ||
      !Number.isFinite(news.meanTone) ||
      Math.abs(news.meanTone) > 100 ||
      new Set(news.stories.map((story) => story.id)).size !== news.storyCount ||
      new Set(news.stories.map((story) => story.domain)).size !==
        news.publishers
    )
      throw new Error("Invalid news sample or provenance");
    for (const story of news.stories) {
      const url = new URL(story.url);
      if (
        !story.title ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        url.hostname.replace(/^www\./, "") !== story.domain ||
        story.batchAt !== news.batchAt ||
        !Number.isFinite(story.tone) ||
        Math.abs(story.tone) > 100 ||
        !Number.isInteger(story.mentions) ||
        story.mentions < 1 ||
        (story.publishedAt !== null &&
          (!instant(story.publishedAt) || story.publishedAt > snapshot.cutoff))
      )
        throw new Error("Invalid sampled news story");
    }
  }
  for (const forecast of snapshot.forecasts ?? []) {
    if (
      !INSTRUMENTS.includes(forecast.instrument) ||
      !HORIZONS.includes(forecast.horizon) ||
      !Number.isFinite(forecast.probabilityUp) ||
      forecast.probabilityUp <= 0 ||
      forecast.probabilityUp >= 1 ||
      !date(forecast.trainedAt) ||
      forecast.trainedAt > snapshot.cutoff ||
      !forecast.modelId ||
      forecast.engineVersion !== snapshot.engineVersion ||
      forecast.target !== "next-session-open-to-horizon-close" ||
      forecast.priceAdjustment !== "total-return-adjusted"
    )
      throw new Error("Invalid as-issued model forecast");
  }
  validateConsensusRecords(snapshot, mode === "candidate");
  const holdingSignals = snapshot.signals.filter(
    (s) => s.id.startsWith("sec-holdings-") && s.status === "available",
  );
  if (snapshot.holdings) {
    validateHoldings(snapshot.holdings, snapshot.cutoff);
    if (mode === "candidate" && (
      holdingSignals.length !== snapshot.holdings.length ||
      snapshot.holdings.some((item) => {
        const signal = holdingSignals.find(
          (s) => s.id === `sec-holdings-${item.id}`,
        );
        return (
          !signal ||
          JSON.stringify({ ...signal, collectionNote: undefined }) !==
            JSON.stringify(holdingsSignal(item))
        );
      })
    ))
      throw new Error("Institutional holdings and signal evidence disagree");
  } else if (holdingSignals.length)
    throw new Error("Institutional holdings require original report evidence");
  const reviews = snapshot.signals.filter((signal) =>
    signal.id.startsWith("review-"),
  );
  const policyReviews = snapshot.signals.filter((signal) =>
    signal.id.startsWith("policy-reviewed-"),
  );
  const issuerReviews = snapshot.signals.filter((s) =>
    s.id.startsWith("issuer-calendar-"),
  );
  const issuerCatalysts = snapshot.catalysts.filter((c) =>
    c.id.startsWith("issuer-earnings-"),
  );
  if (snapshot.review) {
    validateReview(snapshot.review, snapshot.cutoff);
    if (mode === "candidate" && (
      JSON.stringify(reviews) !==
      JSON.stringify(reviewedSignals(snapshot.review, snapshot.cutoff))
    ))
      throw new Error("Reviewed evidence and signal provenance disagree");
    if (mode === "candidate" && (
      JSON.stringify(policyReviews) !==
      JSON.stringify(reviewedPolicySignals(snapshot.review, snapshot.cutoff))
    ))
      throw new Error("Reviewed policy and source provenance disagree");
    const issuerCalendar = mode === "candidate" ? reviewedEarningsCalendar(
      snapshot.review,
      snapshot.cutoff,
    ) : null;
    if (issuerCalendar && (
      JSON.stringify(issuerReviews) !==
        JSON.stringify(issuerCalendar.signals) ||
      JSON.stringify(issuerCatalysts) !==
        JSON.stringify(issuerCalendar.catalysts)
    ))
      throw new Error(
        "Reviewed issuer calendar and source provenance disagree",
      );
  } else if (
    reviews.length ||
    policyReviews.length ||
    issuerReviews.length ||
    issuerCatalysts.length
  )
    throw new Error("Reviewed signals require their saved evidence packet");
  if (mode === "candidate" && snapshot.engineVersion === "consensus-rules-2.0.0" &&
      JSON.stringify(snapshot.signals) !== JSON.stringify(versionedScoringPolicy(snapshot).signals))
    throw new Error("Signals do not match the recorded directional policy");
}
export function observationDigest(snapshot: Snapshot): string {
  // A refetch alone must not create a new edition. Source revision or engine change does.
  return digest({
    engine: snapshot.engineVersion,
    signals: snapshot.signals.map((signal) => ({
      ...signal,
      summary: signal.status === "unavailable" ? null : signal.summary,
      collectionNote: undefined,
      metrics: signal.metrics.map((metric) => ({
        ...metric,
        date:
          signal.source.frequency === "scheduled events" ? null : metric.date,
      })),
      source: {
        ...signal.source,
        observedAt:
          signal.source.frequency === "scheduled events"
            ? null
            : signal.source.observedAt,
        retrievedAt: null,
        sha256: null,
      },
    })),
    catalysts: snapshot.catalysts,
    forecasts: snapshot.forecasts ?? [],
    news: snapshot.news ?? null,
    holdings:
      snapshot.holdings?.map((item) => ({
        ...item,
        current: { ...item.current, retrievedAt: null, hashes: null },
        previous: { ...item.previous, retrievedAt: null, hashes: null },
      })) ?? [],
    review: snapshot.review
      ? {
          ...snapshot.review,
          reviewedAt: null,
          sources: snapshot.review.sources.map((source) => ({
            ...source,
            retrievedAt: null,
            sha256: null,
          })),
        }
      : null,
  });
}
async function optionalJSON<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function indexedPublications(root: string): Promise<{ history: HistoryEntry[]; snapshots: Snapshot[] }> {
  const archive = resolve(root, "public/consensus");
  const history = await optionalJSON<HistoryEntry[]>(resolve(archive, "index.json")) ?? [];
  if (!Array.isArray(history) || new Set(history.map(entry => entry.id)).size !== history.length)
    throw new Error("Invalid or duplicate history index");
  const snapshots: Snapshot[] = [];
  for (const [i, entry] of history.entries()) {
    if (!/^[0-9TZ-]{20,30}$/.test(entry.id) || !instant(entry.issuedAt) ||
        (i > 0 && entry.issuedAt <= history[i - 1].issuedAt))
      throw new Error("Invalid or nonchronological history index");
    const snapshot = await optionalJSON<Snapshot>(resolve(archive, `${entry.id}.json`));
    if (!snapshot) throw new Error("Indexed immutable archive is missing");
    validateSnapshot(snapshot, "archive");
    if (digest(snapshot) !== entry.sha256 || snapshot.id !== entry.id ||
        snapshot.issuedAt !== entry.issuedAt || snapshot.engineVersion !== entry.engineVersion)
      throw new Error("Immutable history failed verification");
    snapshots.push(snapshot);
  }
  return { history, snapshots };
}

async function unindexedFiles(root: string, history: HistoryEntry[]): Promise<string[]> {
  // The aggregate validation report is a reviewed public file beside the editions.
  const known = new Set(["index.json", "outcomes.json", "outcome-selection.json", MARKETPARQUET_AGGREGATE_FILE,
    ...history.map(entry => `${entry.id}.json`)]);
  try {
    return (await readdir(resolve(root, "public/consensus"), { withFileTypes: true }))
      .filter(entry => !known.has(entry.name) && (entry.name.endsWith(".json") || entry.name.endsWith(".tmp")))
      .map(entry => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Read-only build guard; recovery belongs to the locked publisher. */
export async function verifyPublicationTree(root: string): Promise<{ current: Snapshot; history: HistoryEntry[]; snapshots: Snapshot[] }> {
  await assertNoPendingEvaluation(root);
  const { history, snapshots } = await indexedPublications(root);
  const orphans = await unindexedFiles(root, history);
  if (orphans.length) throw new Error(`Unindexed publication files: ${orphans.join(", ")}`);
  const aggregate = await optionalJSON<unknown>(resolve(root, "public/consensus", MARKETPARQUET_AGGREGATE_FILE));
  if (aggregate !== null) validateMarketParquetAggregate(aggregate, history.map(entry => entry.id));
  const current = await optionalJSON<Snapshot>(resolve(root, "lib/consensus/current.json"));
  if (!current || !history.length || history.at(-1)!.id !== current.id || digest(current) !== history.at(-1)!.sha256)
    throw new Error("Current edition differs from its immutable archive");
  validateSnapshot(current, "archive");
  return { current, history, snapshots };
}

/** Called only while holding the shared publication lock. Never rewrite archives. */
async function reconcilePublication(root: string): Promise<{ current: Snapshot | null; history: HistoryEntry[] }> {
  const { history, snapshots } = await indexedPublications(root);
  const currentPath = resolve(root, "lib/consensus/current.json");
  let current = await optionalJSON<Snapshot>(currentPath);
  if (current) {
    validateSnapshot(current, "archive");
    const indexed = history.find(entry => entry.id === current!.id);
    if (!indexed || digest(current) !== indexed.sha256)
      throw new Error("Current edition is not a verified indexed archive; recovery stopped");
  }
  const orphans = await unindexedFiles(root, history);
  if (orphans.length) {
    const archive = resolve(root, "public/consensus");
    const quarantine = resolve(root, ".consensus/publication-quarantine", randomUUID());
    await durableDirectory(quarantine, 0o700);
    const records = [];
    for (const name of orphans) {
      let validation = "valid unindexed edition; not committed to the publication index";
      try {
        const orphan = JSON.parse(await readFile(resolve(archive, name), "utf8")) as Snapshot;
        validateSnapshot(orphan, "archive");
        if (name !== `${orphan.id}.json`) throw new Error("Incomplete temporary publication file");
      } catch (error) { validation = error instanceof Error ? error.message : "Invalid unindexed file"; }
      // Preserve bytes privately rather than treating an uncommitted candidate as issued.
      await rename(resolve(archive, name), resolve(quarantine, name));
      await syncDirectory(quarantine);
      await syncDirectory(archive);
      records.push({ name, validation });
    }
    await durableJSON(resolve(quarantine, "manifest.json"), { recoveredAt: new Date().toISOString(), files: records });
  }
  const latest = snapshots.at(-1);
  if (latest && current?.id !== latest.id) {
    await durableJSON(currentPath, latest);
    current = latest;
  }
  return { current, history };
}

export type PublicationStep = "archive" | "index" | "current";
export async function publishCollectedSnapshot(
  root: string,
  draft: Snapshot,
  expectedHash: string,
  expectedCurrentId: string | null,
  issuedAt = new Date().toISOString(),
) {
  if (digest(draft) !== expectedHash) throw new Error("Reviewed collection hash changed");
  if (!instant(issuedAt) || !instant(draft.cutoff) || draft.issuedAt > issuedAt ||
      draft.cutoff > issuedAt || Date.parse(issuedAt) - Date.parse(draft.cutoff) > 4 * 3600000)
    throw new Error("Publication requires a recent reviewed collection");
  return publishSnapshot(root, { ...draft, issuedAt, id: issuedAt.replace(/[:.]/g, "-") }, { expectedCurrentId });
}

export async function publishSnapshot(
  root: string,
  snapshot: Snapshot,
  options: { afterStep?: (step: PublicationStep) => void | Promise<void>; expectedCurrentId?: string | null } = {},
): Promise<{ changed: boolean; id: string; sha256: string }> {
  validateSnapshot(snapshot);
  const currentPath = resolve(root, "lib/consensus/current.json"),
    archive = resolve(root, "public/consensus"),
    indexPath = resolve(archive, "index.json");
  const release = await acquirePublicationLock(root, "consensus");
  let failure: {error: unknown} | undefined;
  try {
    await assertNoPendingEvaluation(root);
    const { current: prior, history: index } = await reconcilePublication(root);
    if (options.expectedCurrentId !== undefined && (prior?.id ?? null) !== options.expectedCurrentId)
      throw new Error("Current edition changed after collection; review a new draft");
    if (prior && observationDigest(prior) === observationDigest(snapshot))
      return { changed: false, id: prior.id, sha256: digest(prior) };
    if (prior && snapshot.issuedAt <= prior.issuedAt)
      throw new Error("New edition must follow the current issue time");
    snapshot = freezeConsensus(snapshot);
    validateSnapshot(snapshot);
    const path = resolve(archive, `${snapshot.id}.json`),
      hash = digest(snapshot);
    if (index.some((entry) => entry.id === snapshot.id))
      throw new Error("Duplicate history entry");
    await durableJSON(path, snapshot, true);
    await options.afterStep?.("archive");
    await durableJSON(indexPath, [
      ...index,
      {
        id: snapshot.id,
        issuedAt: snapshot.issuedAt,
        sha256: hash,
        engineVersion: snapshot.engineVersion,
      },
    ]);
    await options.afterStep?.("index");
    await durableJSON(currentPath, snapshot);
    await options.afterStep?.("current");
    return { changed: true, id: snapshot.id, sha256: hash };
  } catch (error) {
    failure = {error};
    throw error;
  } finally {
    await finishPublicationLock(release, failure);
  }
}
