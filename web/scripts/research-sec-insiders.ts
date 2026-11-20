import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { collectKibotSeries, isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { REVIEWED_ISSUERS, type ReviewedTicker } from "../lib/consensus/issuer-context.ts";
import { HISTORICAL_RESEARCH_CALENDAR, historicalResearchSession, historicalResearchSessions } from "../lib/consensus/research-session-calendar.ts";
import type { SessionPrice } from "../lib/consensus/evaluation.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";
import { publicDate } from "../lib/public-normalization.ts";

const METHOD = "prelaunch-sec-form4-net-value-v1";
export const INSIDER_FROM = "2024-01-01";
export const INSIDER_THROUGH = "2025-12-31";
export const INSIDER_YEARS = [2024, 2025] as const;
const INSTRUMENTS = ["SPY", "QQQ", "DIA"] as const;
export const INSIDER_QUARTERS = INSIDER_YEARS.flatMap(year => [1, 2, 3, 4].map(quarter => `${year}q${quarter}`));
export const INSIDER_DATASET = "https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets";
export const INSIDER_ARCHIVE_BASE = "https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/";
const root = fileURLToPath(new URL("../", import.meta.url));
export const INSIDER_RESEARCH_DIRECTORY = resolve(root, ".consensus/private-insider-research");
const run = promisify(execFile);
type ResearchInstrument = (typeof INSTRUMENTS)[number];
type Event = {
  accession: string; transaction: string; ticker: ReviewedTicker;
  filingDate: string; transactionDate: string; signedCents: number;
};
type Quarter = {
  quarter: string; source: string; sha256: string; parsedAt: string;
  originalForms: number; events: Event[]; excluded: Record<string, number>;
};

export async function readInsiderResearchJSON<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

export async function collectInsiderArchive(quarter: string, breadth = false): Promise<unknown> {
  const result = await run("python3", [resolve(root, "scripts/collect-sec-insider-quarter.py"), quarter, ...(breadth ? ["--breadth"] : [])],
    { cwd: root, timeout: 75_000, maxBuffer: 4_000_000 });
  return JSON.parse(result.stdout);
}

function validateQuarter(receipt: Quarter, quarter: string) {
  if (receipt.quarter !== quarter || receipt.source !== INSIDER_ARCHIVE_BASE + quarter + "_form345.zip" ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256) || !Number.isSafeInteger(receipt.originalForms) ||
      receipt.originalForms <= 0 || !Array.isArray(receipt.events) ||
      receipt.events.some(row => !Object.hasOwn(REVIEWED_ISSUERS, row.ticker) ||
        !/^\d{10}-\d{2}-\d{6}$/.test(row.accession) || !/^\d+$/.test(row.transaction) ||
        publicDate(row.filingDate) !== row.filingDate || publicDate(row.transactionDate) !== row.transactionDate ||
        row.transactionDate > row.filingDate || !Number.isSafeInteger(row.signedCents) || row.signedCents === 0))
    throw new Error(`Invalid original Form 4 receipt for ${quarter}`);
}

async function readQuarter(quarter: string): Promise<Quarter> {
  const path = resolve(INSIDER_RESEARCH_DIRECTORY, quarter + ".json");
  const cached = await readInsiderResearchJSON<Quarter>(path);
  if (cached) {
    validateQuarter(cached, quarter);
    return cached;
  }
  const captured = await collectInsiderArchive(quarter) as Quarter;
  validateQuarter(captured, quarter);
  await durableJSON(path, captured, true);
  return captured;
}

export function pricedInsiderRows(
  features: Map<string, number>, sessions: SessionPrice[], instrument: string,
  beforeFirstPublicForecast: string, method: string,
): TrainingRow[] {
  return sessions.flatMap(bar => {
    const value = features.get(bar.session);
    if (value === undefined || bar.closeAt >= beforeFirstPublicForecast || !isFullKibotSession(bar.openAt, bar.closeAt)) return [];
    return [{
      id: `${instrument}:${bar.session}`, engineVersion: method,
      issuedAt: newYorkTimestamp(bar.session.replaceAll("-", "") + "T080000")!,
      labelKnownAt: bar.closeAt, features: [value], up: (bar.close > bar.open ? 1 : 0) as 0 | 1,
    }];
  });
}

export function insiderTrainingRows(
  events: Event[], expected: string[], sessions: SessionPrice[],
  instrument: ResearchInstrument, beforeFirstPublicForecast: string,
): TrainingRow[] {
  const net = new Map<string, number>();
  for (const event of events) {
    if (event.filingDate < INSIDER_FROM || event.filingDate > INSIDER_THROUGH ||
        !(REVIEWED_ISSUERS[event.ticker].instruments as readonly string[]).includes(instrument)) continue;
    // Bulk SEC files give a filing date. Wait for the next scheduled NY session.
    const next = expected.find(day => day > event.filingDate);
    if (!next || (instrument === "DIA" && event.ticker === "NVDA" && next < "2024-11-08")) continue;
    const amount = (net.get(next) ?? 0) + event.signedCents;
    if (!Number.isSafeInteger(amount)) throw new Error("Unsafe summed filing notional");
    net.set(next, amount);
  }
  // Retain the sign while compressing large USD notionals.
  const features = new Map([...net].map(([session, cents]) => [session, Math.asinh(cents / 100_000_000)]));
  return pricedInsiderRows(features, sessions, instrument, beforeFirstPublicForecast, METHOD);
}

async function main() {
  if (process.argv.length !== 2) throw new Error("This study uses a fixed issuer panel and accepts no overrides");
  const unlock = await acquirePublicationLock(root, "private-original-form4-study");
  let failure: { error: unknown } | undefined;
  try {
    const { snapshots } = await verifyPublicationTree(root);
    const beforeFirstPublicForecast = snapshots.map(snapshot => snapshot.issuedAt).sort()[0];
    if (!beforeFirstPublicForecast || beforeFirstPublicForecast <= INSIDER_THROUGH + "T23:59:59.999Z")
      throw new Error("Historical study would overlap as-issued outcomes");
    const path = resolve(INSIDER_RESEARCH_DIRECTORY, METHOD + ".json");
    const saved = await readInsiderResearchJSON<{ method: string; beforeFirstPublicForecast: string; calendar: string; summary: unknown }>(path);
    if (saved) {
      if (saved.method !== METHOD || saved.beforeFirstPublicForecast !== beforeFirstPublicForecast ||
          saved.calendar !== HISTORICAL_RESEARCH_CALENDAR.id)
        throw new Error("Saved study differs from its frozen archive boundary");
      console.log(JSON.stringify({ status: "reused_private_study", summary: saved.summary }, null, 2));
      return;
    }

    await durableDirectory(INSIDER_RESEARCH_DIRECTORY, 0o700);
    const receipts: Quarter[] = [];
    for (const quarter of INSIDER_QUARTERS) receipts.push(await readQuarter(quarter));
    const events = receipts.flatMap(row => row.events);
    if (new Set(events.map(row => row.accession + ":" + row.transaction)).size !== events.length)
      throw new Error("Repeated original transaction between SEC archives");
    const calendar = INSIDER_YEARS.map(year => historicalResearchSessions(year));
    const expected = calendar.flat();
    const results = [];
    for (const instrument of INSTRUMENTS) {
      const samples: SessionPrice[] = [];
      const priceHashes = [];
      for (const dates of calendar) {
        const capture = await collectKibotSeries(instrument, dates, { unadjusted: true, sessionClock: historicalResearchSession });
        samples.push(...capture.sessions);
        priceHashes.push(capture.sha256);
      }
      const rows = insiderTrainingRows(events, expected, samples, instrument, beforeFirstPublicForecast);
      results.push({ instrument, priceSessions: samples.length, priceHashes, result: trainCandidate(rows, beforeFirstPublicForecast) });
    }
    const summary = {
      from: INSIDER_FROM, through: INSIDER_THROUGH, archives: receipts.length, beforeFirstPublicForecast,
      originalForms: receipts.reduce((total, value) => total + value.originalForms, 0),
      selectedTransactions: events.length, selectedPurchaseRows: events.filter(row => row.signedCents > 0).length,
      cohorts: results.map(({ instrument, priceSessions, result }) => ({
        instrument, priceSessions, samples: result.samples, status: result.status,
        ...(result.status === "evaluated" ? {
          testSamples: result.split.test, candidateBrier: result.candidateBrier,
          baseRateBrier: result.baseRateBrier, coinBrier: result.coinBrier, clearedResearchMargin: result.promoted,
        } : {}),
      })),
    };
    await durableJSON(path, {
      method: METHOD, beforeFirstPublicForecast, summary, dataset: INSIDER_DATASET, calendar: HISTORICAL_RESEARCH_CALENDAR.id,
      priceSource: KIBOT_PRICE_CITATION, results,
      archives: receipts.map(({ quarter, source, sha256, parsedAt, originalForms, excluded }) =>
        ({ quarter, source, sha256, parsedAt, originalForms, excluded })),
      policy: "Use original Form 4 direct common-share P/S rows with matching sides and explicitly unchecked plan and swap indicators. Sum signed approximate USD notionals from filings before the next scheduled full session. Keep late corrections separate. Fit one signed log-like feature on distinct event sessions before the first public forecast.",
      limits: "Filing dates provide a conservative day-level proxy for dissemination. P/S includes private transactions. An unchecked 10b5-1 field can omit legacy plans. Fixed issuer set and raw same-session internal price research supply no prospective promotion.",
    }, true);
    console.log(JSON.stringify({ status: "saved_private_study", summary }, null, 2));
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishPublicationLock(unlock, failure);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
