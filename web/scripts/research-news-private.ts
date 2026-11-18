import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { collectKibotPrices } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { collectPremarketNewsBatch, type PremarketNewsBatch } from "../lib/consensus/news-research.ts";
import { newYorkDate } from "../lib/consensus/time.ts";
import type { HistoryEntry } from "../lib/consensus/types.ts";

const METHOD = "prelaunch-gdelt-news-v1";
const INSTRUMENTS = ["SPY", "QQQ", "IWM", "DIA"] as const;
const REGULAR_SESSION_MS = 6.5 * 60 * 60_000;
const MAX_SESSIONS = 260;
const MAX_TRANSPORT_RETRIES = 5;
const MAX_COLLECTION_MS = 12 * 60_000;
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-family-research");
const destination = resolve(directory, `${METHOD}.json`);

function historyBinding(history: HistoryEntry[]) {
  return {
    entries: history.length,
    sha256: createHash("sha256").update(JSON.stringify(history)).digest("hex"),
  };
}

function matchesReviewedHistory(reviewed: ReturnType<typeof historyBinding>, current: HistoryEntry[]) {
  // New editions may append to the already reviewed and unchanged archive.
  return reviewed?.entries > 0 && current.length >= reviewed.entries &&
    historyBinding(current.slice(0, reviewed.entries)).sha256 === reviewed.sha256;
}

async function readSaved(history: HistoryEntry[]) {
  let saved: ReturnType<typeof reportFor>;
  try {
    saved = JSON.parse(await readFile(destination, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (saved?.method !== METHOD || saved.beforeFirstPublicForecast !== history[0].issuedAt ||
      !matchesReviewedHistory(saved.reviewedHistory, history))
    throw new Error("Saved GDELT experiment differs from its frozen policy or reviewed archive");
  return saved;
}

async function collectBatches(days: string[]) {
  const deadline = AbortSignal.timeout(MAX_COLLECTION_MS);
  const batches: PremarketNewsBatch[] = [];
  let retries = 0;
  const fetchArchive = async (url: string, init?: RequestInit) => {
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) await response.body?.cancel().catch(() => undefined);
    return response;
  };
  for (const day of days) {
    if (batches.length) await delay(1_000, undefined, { signal: deadline });
    let batch = await collectPremarketNewsBatch(day, fetchArchive);
    if (batch.status === "source_transport" && batch.httpStatus !== 429 && retries < MAX_TRANSPORT_RETRIES) {
      retries++;
      await delay(5_000, undefined, { signal: deadline });
      batch = await collectPremarketNewsBatch(day, fetchArchive);
    }
    if (batch.status === "source_transport" || batch.status === "source_rejected")
      throw new Error(`GDELT ${batch.status} for ${day}${batch.httpStatus ? ` (HTTP ${batch.httpStatus})` : ""}`);
    batches.push(batch);
    if (batches.length % 50 === 0)
      console.error(`Checked ${batches.length} of ${days.length} canonical GDELT batches`);
  }
  return batches;
}

function reportFor(history: HistoryEntry[], bars: Awaited<ReturnType<typeof collectKibotPrices>>,
  batches: PremarketNewsBatch[], earlyCloses: string[]) {
  const cutoff = history[0].issuedAt;
  const available = new Map(batches.flatMap(batch => batch.status === "available" ? [[batch.session, batch] as const] : []));
  const experiments = INSTRUMENTS.map(instrument => {
    const prices = bars.evidence.find(item => item.instrument === instrument);
    if (!prices) throw new Error(`Missing private label evidence for ${instrument}`);
    const rows: TrainingRow[] = [];
    for (const session of prices.sessions) {
      const batch = available.get(session.session);
      if (!batch) continue;
      if (batch.availableAt >= batch.cutoff || batch.cutoff >= session.openAt || session.closeAt >= cutoff)
        throw new Error("Research row falls outside the frozen evidence or label cutoff");
      rows.push({
        id: `${instrument}:${session.session}`,
        engineVersion: METHOD,
        issuedAt: batch.cutoff,
        labelKnownAt: session.closeAt,
        features: [batch.tone],
        up: session.close > session.open ? 1 : 0,
      });
    }
    if (rows.length !== available.size) throw new Error(`Incomplete session join for ${instrument}`);
    return { instrument, result: trainCandidate(rows, cutoff) };
  });
  const coverage: Partial<Record<PremarketNewsBatch["status"], number>> = {};
  for (const batch of batches) coverage[batch.status] = (coverage[batch.status] ?? 0) + 1;
  return {
    method: METHOD,
    createdAt: new Date().toISOString(),
    beforeFirstPublicForecast: cutoff,
    firstPublicEdition: history[0],
    reviewedHistory: historyBinding(history),
    calendar: EXCHANGE_CALENDAR.id,
    through: bars.through,
    priceSource: bars.evidence[0].source,
    priceHashes: Object.fromEntries(INSTRUMENTS.map(instrument => [instrument, bars.hashes[instrument]])),
    feature: "Equally weighted publisher mean V2Tone from 50+ word, non-translated web records carrying the exact ECON_STOCKMARKET theme. At least 20 records and 10 publishers.",
    label: "Kibot guest daily close above the same session's open. A common price adjustment cancels within the session. Equal close and open is a zero label.",
    evidenceTiming: "Canonical 07:00 America/New_York GKG 2.1 archive only. Its HTTP Last-Modified must fall from 06:45 inclusive to 08:00 exclusive. Each eligible record ID and date match the batch.",
    evaluation: "Private chronological 60/20/20 screen with at least 120 samples and 20 test labels. Brier must improve by strictly more than 0.01 against both the coin and training base rate.",
    limitations: [
      "The archive Last-Modified is provider metadata. It does not independently timestamp each underlying article or prove the file was publicly retrievable then.",
      "The same global tone feature applies to each ETF. The four outcomes are correlated.",
      "Kibot guest bars and historical results are for private QA. Unverified early closes are excluded.",
    ],
    sessionsChecked: batches.length,
    excludedEarlyCloses: earlyCloses,
    coverage,
    batches,
    experiments,
  };
}

function printSummary(status: string, report: ReturnType<typeof reportFor>) {
  console.log(JSON.stringify({
    status,
    beforeFirstPublicForecast: report.beforeFirstPublicForecast,
    through: report.through,
    sessionsChecked: report.sessionsChecked,
    excludedEarlyCloses: report.excludedEarlyCloses,
    coverage: report.coverage,
    experiments: report.experiments.map(({ instrument, result }) => ({
      instrument,
      status: result.status,
      samples: result.samples,
      ...(result.status === "evaluated" ? {
        clearsBrierGate: result.promoted,
        testSamples: result.split.test,
        candidateBrier: result.candidateBrier,
        baseRateBrier: result.baseRateBrier,
        coinBrier: result.coinBrier,
      } : { reason: result.reason }),
    })),
  }, null, 2));
}

async function main() {
  if (process.argv.length !== 2) throw new Error("This fixed experiment accepts no overrides");
  const { history } = await verifyPublicationTree(root);
  const saved = await readSaved(history);
  if (saved) {
    printSummary("reused-private-experiment", saved);
    return;
  }

  const cutoff = history[0].issuedAt;
  const completed = exchangeSessions(EXCHANGE_CALENDAR.from, newYorkDate(cutoff))
    .map(day => exchangeSession(day)!)
    .filter(session => session.closeAt < cutoff);
  if (!completed.length || completed.length > MAX_SESSIONS)
    throw new Error("The prelaunch experiment requires a bounded, reviewed session window");
  const through = completed.at(-1)!.session;
  const eligible: string[] = [];
  const earlyCloses: string[] = [];
  for (const session of completed) {
    const regular = Date.parse(session.closeAt) - Date.parse(session.openAt) === REGULAR_SESSION_MS;
    (regular ? eligible : earlyCloses).push(session.session);
  }
  // The guest collector requests dates before the given local day. Supply the
  // day after the last independently reviewed and completed session.
  const priceCutoff = new Date(Date.parse(through) + 36 * 60 * 60_000).toISOString();
  const bars = await collectKibotPrices(EXCHANGE_CALENDAR.from, priceCutoff);
  if (bars.through !== through) throw new Error("Private labels differ from the reviewed session window");
  const batches = await collectBatches(eligible);

  const release = await acquirePublicationLock(root, "private-news-research-save");
  let failure: { error: unknown } | undefined;
  try {
    const { history: current } = await verifyPublicationTree(root);
    if (!matchesReviewedHistory(historyBinding(history), current))
      throw new Error("Reviewed publication history changed during GDELT collection");
    const alreadySaved = await readSaved(current);
    if (alreadySaved) {
      printSummary("reused-private-experiment", alreadySaved);
      return;
    }
    const report = reportFor(history, bars, batches, earlyCloses);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await durableJSON(destination, report, true);
    printSummary("saved-private-experiment", report);
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishPublicationLock(release, failure);
  }
}

await main();
