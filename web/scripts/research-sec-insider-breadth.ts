import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { collectKibotSeries, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate } from "../lib/consensus/learning.ts";
import { HISTORICAL_RESEARCH_CALENDAR, historicalResearchSession, historicalResearchSessions } from "../lib/consensus/research-session-calendar.ts";
import { publicDate } from "../lib/public-normalization.ts";
import {
  collectInsiderArchive, INSIDER_ARCHIVE_BASE, INSIDER_DATASET, INSIDER_FROM, INSIDER_QUARTERS,
  INSIDER_RESEARCH_DIRECTORY, INSIDER_THROUGH, INSIDER_YEARS, pricedInsiderRows, readInsiderResearchJSON,
} from "./research-sec-insiders.ts";

const METHOD = "prelaunch-sec-form4-issuer-breadth-v1";
const INSTRUMENTS = ["SPY", "QQQ", "IWM", "DIA"] as const;
const root = fileURLToPath(new URL("../", import.meta.url));
type IssuerDay = { cik: string; filingDate: string; netCents: number };
type Receipt = {
  quarter: string; source: string; sha256: string; parsedAt: string; originalForms: number;
  selectedTransactions: number; selectedPurchaseRows: number; accessions: string[];
  issuerDays: IssuerDay[];
};

async function breadthQuarter(quarter: string) {
  const path = resolve(INSIDER_RESEARCH_DIRECTORY, "breadth-" + quarter + ".json");
  const saved = await readInsiderResearchJSON<Receipt>(path);
  const report = saved ?? await collectInsiderArchive(quarter, true) as Receipt;
  if (report.quarter !== quarter || report.source !== INSIDER_ARCHIVE_BASE + quarter + "_form345.zip" ||
      !/^[a-f0-9]{64}$/.test(report.sha256) ||
      ![report.originalForms, report.selectedTransactions].every(n => Number.isSafeInteger(n) && n > 0) ||
      !Number.isSafeInteger(report.selectedPurchaseRows) || report.selectedPurchaseRows < 0 ||
      report.selectedPurchaseRows > report.selectedTransactions ||
      !Array.isArray(report.accessions) || report.accessions.some(item => !/^\d{10}-\d{2}-\d{6}$/.test(item)) ||
      !Array.isArray(report.issuerDays) || report.issuerDays.some(item =>
        !/^[1-9]\d{0,9}$/.test(item.cik) || publicDate(item.filingDate) !== item.filingDate ||
        !Number.isSafeInteger(item.netCents)))
    throw new Error("Invalid SEC breadth receipt for " + quarter);
  if (!saved) await durableJSON(path, report, true);
  return report;
}

export function issuerBreadth(issuerDays: IssuerDay[], schedule: string[]) {
  const byTarget = new Map<string, Map<string, number>>();
  const assignments = new Map<string, string | undefined>();
  for (const item of issuerDays) {
    if (item.filingDate < INSIDER_FROM || item.filingDate > INSIDER_THROUGH) continue;
    if (!assignments.has(item.filingDate)) assignments.set(item.filingDate, schedule.find(day => day > item.filingDate));
    const session = assignments.get(item.filingDate);
    if (!session) continue;
    let issuers = byTarget.get(session);
    if (!issuers) byTarget.set(session, issuers = new Map());
    const net = (issuers.get(item.cik) ?? 0) + item.netCents;
    if (!Number.isSafeInteger(net)) throw new Error("Invalid aggregated issuer notional");
    issuers.set(item.cik, net);
  }
  const features = new Map<string, number>();
  for (const [session, issuers] of byTarget) {
    const nonzero = [...issuers.values()].filter(amount => amount !== 0);
    if (nonzero.length) features.set(session, nonzero.reduce((sum, amount) => sum + Math.sign(amount), 0) / nonzero.length);
  }
  return features;
}

async function main() {
  if (process.argv.length !== 2) throw new Error("The broad Form 4 study accepts no overrides");
  const unlock = await acquirePublicationLock(root, "private-form4-issuer-breadth");
  let failure: { error: unknown } | undefined;
  try {
    const { snapshots } = await verifyPublicationTree(root);
    const beforeFirstPublicForecast = snapshots.map(snapshot => snapshot.issuedAt).sort()[0];
    if (!beforeFirstPublicForecast || beforeFirstPublicForecast <= INSIDER_THROUGH + "T23:59:59.999Z")
      throw new Error("The declared research period would overlap as-issued forecasts");
    const path = resolve(INSIDER_RESEARCH_DIRECTORY, METHOD + ".json");
    const saved = await readInsiderResearchJSON<{ method: string; beforeFirstPublicForecast: string; calendar: string; summary: unknown }>(path);
    if (saved) {
      if (saved.method !== METHOD || saved.beforeFirstPublicForecast !== beforeFirstPublicForecast ||
          saved.calendar !== HISTORICAL_RESEARCH_CALENDAR.id)
        throw new Error("Saved breadth study differs from its frozen calendar or archive boundary");
      console.log(JSON.stringify({ status: "reused_private_study", summary: saved.summary }, null, 2));
      return;
    }
    await durableDirectory(INSIDER_RESEARCH_DIRECTORY, 0o700);
    const receipts: Receipt[] = [];
    for (const quarter of INSIDER_QUARTERS) receipts.push(await breadthQuarter(quarter));
    const accessions = receipts.flatMap(receipt => receipt.accessions);
    if (new Set(accessions).size !== accessions.length) throw new Error("Repeated original Form 4 between archives");
    const calendar = INSIDER_YEARS.map(year => historicalResearchSessions(year));
    const issuerDays = receipts.flatMap(receipt => receipt.issuerDays);
    const features = issuerBreadth(issuerDays, calendar.flat());
    const results = [];
    for (const instrument of INSTRUMENTS) {
      const sources = [];
      for (const dates of calendar)
        sources.push(await collectKibotSeries(instrument, dates, { unadjusted: true, sessionClock: historicalResearchSession }));
      const rows = pricedInsiderRows(features, sources.flatMap(source => source.sessions), instrument, beforeFirstPublicForecast, METHOD);
      results.push({ instrument, priceHashes: sources.map(source => source.sha256), result: trainCandidate(rows, beforeFirstPublicForecast) });
    }
    const summary = {
      from: INSIDER_FROM, through: INSIDER_THROUGH, archives: receipts.length, distinctFilings: accessions.length,
      distinctIssuers: new Set(issuerDays.map(row => row.cik)).size,
      transactions: receipts.reduce((sum, row) => sum + row.selectedTransactions, 0),
      sessionsWithEvidence: features.size,
      cohorts: results.map(({ instrument, result }) => ({
        instrument, samples: result.samples, status: result.status,
        ...(result.status === "evaluated" ? {
          testSamples: result.split.test, candidateBrier: result.candidateBrier,
          baseRateBrier: result.baseRateBrier, coinBrier: result.coinBrier, clearedResearchMargin: result.promoted,
        } : {}),
      })),
    };
    await durableJSON(path, {
      method: METHOD, beforeFirstPublicForecast, summary, dataset: INSIDER_DATASET, calendar: HISTORICAL_RESEARCH_CALENDAR.id,
      priceSource: KIBOT_PRICE_CITATION, results,
      archives: receipts.map(({ quarter, source, sha256, parsedAt }) => ({ quarter, source, sha256, parsedAt })),
      policy: "Use all qualifying original direct common-stock P/S filings, grouped by issuer CIK at the next scheduled session after the filing date. Take positive minus negative nonzero issuers divided by nonzero issuers. Test one market-wide feature independently on the four equity ETFs, without price or universe data selected from later dates.",
      limits: "Filing dates give day-level availability. Reported notional can be rounded. This is filing breadth, with no assumption of ETF holdings or open-market-only trades. Private before-launch study leaves prospective holds, public votes and model registry separate.",
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
