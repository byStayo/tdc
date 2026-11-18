import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { publicDate } from "../lib/public-normalization.ts";
import type { SessionPrice } from "../lib/consensus/evaluation.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { planCandidate, trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { NYFED_SCE_ATTRIBUTION, NYFED_SCE_INDEX } from "../lib/consensus/nyfed-stock-outlook.ts";
import { EXTENDED_CALENDAR_IDS, extendedResearchSession, extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { collectResearchPrices, readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { newYorkDate, newYorkTimestamp } from "../lib/consensus/time.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-nyfed-outlook");
const STUDY = "prelaunch-nyfed-stock-outlook-2016-2026-v1";
const INDEX_FROM = "2014-01-01", INDEX_THROUGH = "2026-10-31", FIRST_SERIES_PUBLICATION = "2016-02-25";
const SHA = /^[0-9a-f]{64}$/;
const INSTRUMENTS = ["SPY", "QQQ", "IWM", "DIA"] as const;
type Instrument = typeof INSTRUMENTS[number];
export type RetailReading = {
  id: string; referenceMonthEnd: string; publicationDate: string;
  meanHigherStockPricesPercent: number; source: string; sha256: string;
};
type Capture = { schemaVersion: 1; from: string; through: string; rows: RetailReading[];
  summary: { indexEntries: number; processed: number; accepted: number; pending: number; complete: boolean } };
type Candidate = ReturnType<typeof trainCandidate>;

function validReading(row: RetailReading) {
  if (!row || !row.id || !SHA.test(row.sha256) || publicDate(row.referenceMonthEnd) !== row.referenceMonthEnd ||
      publicDate(row.publicationDate) !== row.publicationDate || row.publicationDate < FIRST_SERIES_PUBLICATION ||
      row.publicationDate > INDEX_THROUGH || row.referenceMonthEnd >= row.publicationDate ||
      !Number.isFinite(row.meanHigherStockPricesPercent) || row.meanHigherStockPricesPercent < 0 || row.meanHigherStockPricesPercent > 100) return false;
  const next = new Date(Date.parse(row.referenceMonthEnd) + 86_400_000).toISOString();
  if (next.slice(8, 10) !== "01" || Date.parse(row.publicationDate) - Date.parse(row.referenceMonthEnd) > 45 * 86_400_000) return false;
  const url = new URL(row.source);
  return url.origin === "https://www.newyorkfed.org" && url.pathname.startsWith("/newsevents/news/research/") && !url.search && !url.hash;
}

/** One observation per original release. A release date alone only supports a subsequent morning. */
export function retailTargets(readings: RetailReading[], lastDay: string) {
  const dates = extendedResearchSessions(FIRST_SERIES_PUBLICATION, lastDay);
  const targets = new Map<string, RetailReading>();
  for (const reading of readings) {
    const day = dates.find(session => session > reading.publicationDate);
    if (!day) continue;
    const bounds = extendedResearchSession(day)!;
    if (!isFullKibotSession(bounds.openAt, bounds.closeAt)) continue;
    const previous = targets.get(day);
    if (!previous || reading.referenceMonthEnd > previous.referenceMonthEnd) targets.set(day, reading);
  }
  return targets;
}

export function buildRetailRows(targets: Map<string, RetailReading>, sessions: SessionPrice[], symbol: Instrument, before: string) {
  return sessions.flatMap(bar => {
    const point = targets.get(bar.session);
    if (!point || !isFullKibotSession(bar.openAt, bar.closeAt) || bar.closeAt >= before) return [];
    const row: TrainingRow = { id: `${symbol}:${bar.session}`, engineVersion: STUDY,
      issuedAt: newYorkTimestamp(bar.session.replaceAll("-", "") + "T080000")!, labelKnownAt: bar.closeAt,
      features: [point.meanHigherStockPricesPercent], up: bar.close > bar.open ? 1 : 0 };
    return [{ row, sourceId: point.id, observedAt: point.referenceMonthEnd, published: point.publicationDate }];
  });
}

async function main() {
  if (process.argv.length !== 2) throw new Error("The retail study uses a frozen archive period and accepts no overrides");
  const unlock = await acquirePublicationLock(root, "private-nyfed-retail-study");
  let failure: { error: unknown } | undefined;
  try {
    const { history } = await verifyPublicationTree(root);
    const before = history[0]?.issuedAt;
    if (!before || newYorkDate(before) <= INDEX_THROUGH) throw new Error("Retail study overlaps an issued edition");
    const output = resolve(directory, `${STUDY}.json`);
    const saved = await readResearchReceipt<{ method: string; beforeFirstPublicForecast: string; summary: unknown }>(output);
    if (saved) {
      if (saved.method !== STUDY || saved.beforeFirstPublicForecast !== before) throw new Error("Saved survey study has a different archive boundary");
      console.log(JSON.stringify({ status: "reused_private_study", summary: saved.summary }));
      return;
    }
    const { stdout } = await promisify(execFile)("python3", [resolve(root, "scripts/collect-nyfed-outlook-releases.py"), "--cached-only"],
      { cwd: root, maxBuffer: 2_000_000 });
    const capture = JSON.parse(stdout) as Capture;
    if (capture.schemaVersion !== 1 || capture.from !== INDEX_FROM || capture.through !== INDEX_THROUGH ||
        capture.summary?.complete !== true || capture.summary.pending !== 0 || capture.summary.indexEntries !== capture.summary.processed ||
        !Array.isArray(capture.rows) || capture.rows.length !== capture.summary.accepted || capture.rows.length > 155 ||
        !capture.rows.every(validReading) || new Set(capture.rows.map(row => row.referenceMonthEnd)).size !== capture.rows.length)
      throw new Error("The complete original NY Fed release scan is required before fitting the retail study");
    // The outcome from the first public forecast's own New York date does not enter research.
    const lastDay = new Date(Date.parse(newYorkDate(before)) - 86_400_000).toISOString().slice(0, 10);
    const targets = retailTargets(capture.rows, lastDay);
    const floor = planCandidate([], before).minimum;
    const results: { instrument: Instrument; hashes: string[]; pairs: ReturnType<typeof buildRetailRows>; result: Candidate }[] = [];
    if (targets.size >= floor) {
      for (const instrument of INSTRUMENTS) {
        const sources = await collectResearchPrices(directory, instrument, [...targets.keys()]);
        const pairs = buildRetailRows(targets, sources.flatMap(price => price.sessions), instrument, before);
        results.push({ instrument, hashes: sources.map(price => price.sha256), pairs, result: trainCandidate(pairs.map(pair => pair.row), before) });
      }
    }
    const summary = {
      releasesScanned: capture.summary.indexEntries, originalStockReadings: capture.rows.length, possibleSamplesPerCohort: targets.size,
      minimum: floor, status: results.length ? "tested_historical_cohorts" : "below_minimum_before_price_collection",
      cohorts: results.map(({ instrument, result }) => ({ instrument, samples: result.samples, status: result.status,
        ...(result.status === "evaluated" ? { test: result.split.test, candidateBrier: result.candidateBrier,
          baseRateBrier: result.baseRateBrier, coinBrier: result.coinBrier,
          clearsResearchMargin: result.promoted && result.model.weights[0] > 0 } : {}) })),
    };
    await durableDirectory(directory, 0o700);
    await durableJSON(output, { method: STUDY, beforeFirstPublicForecast: before, calendars: EXTENDED_CALENDAR_IDS, summary,
      source: { url: NYFED_SCE_INDEX, attribution: NYFED_SCE_ATTRIBUTION, sha256: digest(capture.rows), capture: capture.summary },
      prices: KIBOT_PRICE_CITATION, results,
      policy: "One dated original monthly published mean, first subsequent scheduled full session if the next session is full, and one equity outcome per release. A higher household mean is the predeclared positive-direction candidate. No repeated carry-forward observations across trading days. Historical private research ending before the first as-issued forecast.",
    }, true);
    console.log(JSON.stringify({ status: "saved_private_study", summary }));
  } catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(unlock, failure); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
