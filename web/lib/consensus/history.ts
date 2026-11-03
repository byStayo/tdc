import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  open,
  unlink,
  link,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { FAMILIES } from "./registry.ts";
import { publicDate } from "../public-normalization.ts";
import { INSTRUMENTS, HORIZONS } from "./types.ts";
import type { Snapshot, HistoryEntry } from "./types.ts";
import { reviewedSignals, validateReview } from "./reviewed.ts";

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const date = (value: unknown) =>
  typeof value === "string" && !!publicDate(value);
const instant = (value: unknown) =>
  date(value) &&
  typeof value === "string" &&
  new Date(value).toISOString() === value;
export function validateSnapshot(snapshot: Snapshot): void {
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
  for (const signal of snapshot.signals) {
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
      !instant(signal.source.retrievedAt) ||
      Date.parse(signal.source.retrievedAt) > Date.parse(snapshot.cutoff)
    )
      throw new Error(`Invalid signal availability: ${signal.id}`);
    const url = new URL(signal.source.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      /(?:token|api_key|secret|password)=/i.test(url.search)
    )
      throw new Error("Unsafe public source URL");
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
    if (
      !date(catalyst.at) ||
      !catalyst.title ||
      new URL(catalyst.url).protocol !== "https:"
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
      forecast.target !== "next-session-open-to-horizon-close"
    )
      throw new Error("Invalid as-issued model forecast");
  }
  const reviews = snapshot.signals.filter((signal) =>
    signal.id.startsWith("review-"),
  );
  if (snapshot.review) {
    validateReview(snapshot.review, snapshot.cutoff);
    if (
      JSON.stringify(reviews) !==
      JSON.stringify(reviewedSignals(snapshot.review, snapshot.cutoff))
    )
      throw new Error("Reviewed evidence and signal provenance disagree");
  } else if (reviews.length)
    throw new Error("Reviewed signals require their saved evidence packet");
}
export function observationDigest(snapshot: Snapshot): string {
  // A refetch alone must not create a new edition. Source revision or engine change does.
  return digest({
    engine: snapshot.engineVersion,
    signals: snapshot.signals.map((signal) => ({
      ...signal,
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
async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
export async function publishSnapshot(
  root: string,
  snapshot: Snapshot,
): Promise<{ changed: boolean; id: string; sha256: string }> {
  validateSnapshot(snapshot);
  const currentPath = resolve(root, "lib/consensus/current.json"),
    archive = resolve(root, "public/consensus"),
    indexPath = resolve(archive, "index.json");
  await mkdir(resolve(root, ".editorial"), { recursive: true });
  const lockPath = resolve(root, ".editorial/publish.lock"),
    lock = await open(lockPath, "wx", 0o600);
  try {
    await lock.writeFile(
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        kind: "consensus",
      }),
    );
    let prior: Snapshot | null = null;
    try {
      prior = JSON.parse(await readFile(currentPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (prior && observationDigest(prior) === observationDigest(snapshot))
      return { changed: false, id: prior.id, sha256: digest(prior) };
    if (prior && snapshot.issuedAt <= prior.issuedAt)
      throw new Error("New edition must follow the current issue time");
    await mkdir(archive, { recursive: true });
    const path = resolve(archive, `${snapshot.id}.json`),
      temporary = `${path}.${randomUUID()}.tmp`,
      hash = digest(snapshot);
    // Hard-link creation is atomic and cannot overwrite an as-issued publication.
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
        flag: "wx",
      });
      await link(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    let index: HistoryEntry[] = [];
    try {
      index = JSON.parse(await readFile(indexPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (index.some((entry) => entry.id === snapshot.id))
      throw new Error("Duplicate history entry");
    await atomic(indexPath, [
      ...index,
      {
        id: snapshot.id,
        issuedAt: snapshot.issuedAt,
        sha256: hash,
        engineVersion: snapshot.engineVersion,
      },
    ]);
    await atomic(currentPath, snapshot);
    return { changed: true, id: snapshot.id, sha256: hash };
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}
