import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import type { SessionPrice } from "../lib/consensus/evaluation.ts";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { collectKibotSeries, isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import {
  HISTORICAL_RESEARCH_CALENDAR, historicalResearchSession, historicalResearchSessions,
} from "../lib/consensus/research-session-calendar.ts";
import { INSTRUMENTS } from "../lib/consensus/types.ts";

const METHOD = "prelaunch-sentisense-skew-v1";
const CAPTURE_DAY = "2026-11-18";
const SOURCE_THROUGH = "2026-11-17";
const FORECAST_BOUNDARY = "2026-11-03T06:28:30.460Z";
const SESSION_LAG = 5;
const HISTORY_ROWS = 252;
const MAX_CAPTURE_BYTES = 512 * 1024;
const FUNDS = INSTRUMENTS.filter(symbol => symbol !== "MARKET");
type Fund = (typeof FUNDS)[number];

const root = fileURLToPath(new URL("../", import.meta.url));
const receiptDirectory = resolve(root, ".consensus/private-sentisense");
const resultDirectory = resolve(root, ".consensus/private-family-research");
const destination = resolve(resultDirectory, `${METHOD}.json`);

const sessionClock = (day: string) => day < EXCHANGE_CALENDAR.from
  ? historicalResearchSession(day) : exchangeSession(day);
const sessions = [...historicalResearchSessions(2025), ...exchangeSessions(EXCHANGE_CALENDAR.from, SOURCE_THROUGH)];
const sessionIndex = new Map(sessions.map((day, index) => [day, index]));

type HistoryCapture = {
  capturedAt?: unknown;
  sha256?: unknown;
  data?: {
    ticker?: unknown;
    window?: unknown;
    series?: { date?: unknown; skew25d?: unknown }[];
  };
};

async function readCapture(ticker: Fund, filenames: string[]) {
  const pattern = new RegExp(`^${ticker}-${CAPTURE_DAY.replaceAll("-", "")}T\\d{6}Z\\.json$`);
  const matching = filenames.filter(name => pattern.test(name));
  if (matching.length !== 1) throw new Error(`Expected one ${CAPTURE_DAY} options receipt for ${ticker}`);
  const path = resolve(receiptDirectory, matching[0]);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_CAPTURE_BYTES) throw new Error(`Invalid ${ticker} receipt size or type`);
  const bytes = await readFile(path);
  if (bytes.byteLength !== metadata.size) throw new Error(`Options receipt changed while reading ${ticker}`);
  const capture: HistoryCapture | null = JSON.parse(bytes.toString("utf8"));
  const date = capture?.capturedAt;
  const { ticker: returnedTicker, window, series } = capture?.data ?? {};
  if (typeof date !== "string" || !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== CAPTURE_DAY ||
      typeof capture?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(capture.sha256) ||
      returnedTicker !== ticker || window !== "1y" || !Array.isArray(series) || series.length !== HISTORY_ROWS) {
    throw new Error(`Invalid options history receipt for ${ticker}`);
  }
  const skewByDate = new Map<string, number>();
  let previous = "";
  for (const point of series) {
    if (typeof point?.date !== "string" || point.date <= previous || !sessionIndex.has(point.date) ||
        typeof point.skew25d !== "number" || !Number.isFinite(point.skew25d)) {
      throw new Error(`Invalid or unordered skew observation for ${ticker}`);
    }
    previous = point.date;
    skewByDate.set(point.date, point.skew25d);
  }
  if (previous !== SOURCE_THROUGH || Date.parse(date) <= Date.parse(sessionClock(previous)!.closeAt)) {
    throw new Error(`Unexpected final options observation or capture instant for ${ticker}`);
  }
  return {
    ticker, skewByDate, provenance: {
      capturedAt: date, sourceSha256: capture.sha256, receiptSha256: createHash("sha256").update(bytes).digest("hex"),
      firstSession: skewByDate.keys().next().value!, lastSession: previous, datedRows: skewByDate.size,
    },
  };
}

export function skewStudyRows(ticker: Fund, prices: SessionPrice[], skewByDate: ReadonlyMap<string, number>) {
  const rows: TrainingRow[] = [];
  let excludedShortSessions = 0;
  let missingFeatureSessions = 0;
  let previous = "";
  for (const bar of prices) {
    const index = sessionIndex.get(bar.session);
    const clock = index === undefined ? null : sessionClock(bar.session);
    if (index === undefined || !clock || bar.session <= previous || bar.openAt !== clock.openAt ||
        bar.closeAt !== clock.closeAt || bar.closeAt >= FORECAST_BOUNDARY) {
      throw new Error("Price label is unordered, outside the reviewed session, or overlaps the public archive");
    }
    previous = bar.session;
    if (!isFullKibotSession(bar.openAt, bar.closeAt)) {
      excludedShortSessions++;
      continue;
    }
    // The exchange calendar, including short sessions, defines the delay even when a provider row is absent.
    const featureSession = sessions[index - SESSION_LAG];
    const signedSkew = skewByDate.get(featureSession);
    if (signedSkew === undefined) {
      missingFeatureSessions++;
      continue;
    }
    rows.push({
      id: `${ticker}:${bar.session}:${featureSession}`, engineVersion: METHOD,
      issuedAt: bar.openAt, labelKnownAt: bar.closeAt, features: [signedSkew], up: bar.close > bar.open ? 1 : 0,
    });
  }
  return { rows, excludedShortSessions, missingFeatureSessions };
}

type StudyResult = {
  method: string;
  forecastBoundary: string;
  firstTargetSession: string;
  lastTargetSession: string;
  funds: {
    ticker: Fund;
    pairedSessions: number;
    excludedShortSessions: number;
    missingFeatureSessions: number;
    evaluation: ReturnType<typeof trainCandidate>;
  }[];
};

function printSummary(result: StudyResult, status: string) {
  console.log(JSON.stringify({
    status, method: METHOD, forecastBoundary: result.forecastBoundary,
    firstTargetSession: result.firstTargetSession, lastTargetSession: result.lastTargetSession,
    funds: result.funds.map(({ ticker, pairedSessions, excludedShortSessions, missingFeatureSessions, evaluation }) => ({
      ticker, pairedSessions, excludedShortSessions, missingFeatureSessions,
      evaluation: evaluation.status, clearedResearchMargin: evaluation.promoted,
      testSessions: evaluation.status === "evaluated" ? evaluation.split.test : 0,
    })),
  }, null, 2));
}

async function main() {
  if (process.argv.length !== 2) throw new Error("This frozen sensitivity screen accepts no overrides");
  const unlock = await acquirePublicationLock(root, "private-sentisense-skew-research");
  let failure: { error: unknown } | undefined;
  try {
    const { snapshots } = await verifyPublicationTree(root);
    if (snapshots.map(snapshot => snapshot.issuedAt).sort()[0] !== FORECAST_BOUNDARY) {
      throw new Error("Verified archive does not match the frozen prelaunch boundary");
    }
    let saved: StudyResult | undefined;
    try {
      saved = JSON.parse(await readFile(destination, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (saved) {
      if (saved.method !== METHOD || saved.forecastBoundary !== FORECAST_BOUNDARY) {
        throw new Error("Saved sensitivity screen differs from the frozen design");
      }
      printSummary(saved, "existing-private-screen");
      return;
    }

    const filenames = await readdir(receiptDirectory);
    const captures = await Promise.all(FUNDS.map(ticker => readCapture(ticker, filenames)));
    const latestStart = captures.map(({ provenance }) => provenance.firstSession).sort().at(-1)!;
    const targetSessions = sessions.slice(sessionIndex.get(latestStart)! + SESSION_LAG)
      .filter(date => sessionClock(date)!.closeAt < FORECAST_BOUNDARY);
    if (!targetSessions.length) throw new Error("No reviewed target sessions within the frozen window");
    const matches = [];
    for (const { ticker, skewByDate, provenance } of captures) {
      const prices = await collectKibotSeries(ticker, targetSessions, { unadjusted: true, sessionClock });
      matches.push({ ticker, provenance, priceSha256: prices.sha256,
        ...skewStudyRows(ticker, prices.sessions, skewByDate) });
    }
    const report = {
      method: METHOD, createdAt: new Date().toISOString(), forecastBoundary: FORECAST_BOUNDARY,
      firstTargetSession: targetSessions[0], lastTargetSession: targetSessions.at(-1)!,
      source: "https://sentisense.ai/docs/api/options/", priceSource: KIBOT_PRICE_CITATION,
      calendars: [HISTORICAL_RESEARCH_CALENDAR, EXCHANGE_CALENDAR], lagInExchangeSessions: SESSION_LAG,
      policy: "Raw signed 25-delta put IV minus call IV from the exact session five exchange sessions before the target. A short session counts in the lag and is excluded from target labels. The label is an increase from the unadjusted regular-session open to close. Use the existing purged chronological screen and its Brier comparisons.",
      limitations: [
        "This is a private retrospective sensitivity screen using options history first captured on 2026-11-18. The five-session lag accommodates documented revisions through four later sessions and does not prove historical release time, availability or vintage.",
        "The scheduled target open anchors the chronological split. It is not an actual issue time. This screen cannot establish prospective results, independent incremental value or production activation eligibility.",
      ],
      funds: matches.map(({ rows, ...evidence }) => ({ ...evidence, pairedSessions: rows.length,
        evaluation: trainCandidate(rows, FORECAST_BOUNDARY) })),
    };
    await durableDirectory(resultDirectory, 0o700);
    await durableJSON(destination, report, true);
    printSummary(report, "saved-private-screen");
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishPublicationLock(unlock, failure);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
