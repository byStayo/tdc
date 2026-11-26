import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { REVIEWED_ISSUERS } from "../lib/consensus/issuer-context.ts";
import {
  REVENUE_ISSUERS, pairIssuerRevenue, readIssuerRevenue, resultsFilings,
  type ResultsFiling,
} from "../lib/consensus/issuer-revenue.ts";
import { originalExhibit } from "../lib/consensus/issuer-results-source.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { collectKibotSeries, isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { planCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { historicalResearchSession, historicalResearchSessions } from "../lib/consensus/research-session-calendar.ts";
import { newYorkDate } from "../lib/consensus/time.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { fetchText, PROJECT_ROOT } from "./collect-editorial-evidence.ts";

const METHOD = "prelaunch-original-issuer-revenue-v1";
const FROM = "2025-02-01";
const SEC_REUSE = "https://www.sec.gov/about/webmaster-frequently-asked-questions";
const directory = resolve(PROJECT_ROOT, ".consensus/private-issuer-revenue");
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type Document = Awaited<ReturnType<typeof fetchText>> & { url: string };

async function load<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

async function sec(url: string): Promise<Document> {
  await setTimeout(180);
  return { url, ...await fetchText(url, fetch) };
}

async function readOriginal(filing: ResultsFiling) {
  const receipt = await originalExhibit(filing, sec, directory);
  return {
    ...readIssuerRevenue(filing, receipt.original.text),
    index: { url: receipt.index.url, sha256: receipt.index.sha256 },
    source: { url: receipt.original.url, retrievedAt: receipt.original.retrievedAt, sha256: receipt.original.sha256 },
  };
}

async function capture() {
  await durableDirectory(directory, 0o700);
  const filingsThrough = new Date().toISOString();
  const catalogs = [];
  const releases = [];
  for (const ticker of REVENUE_ISSUERS) {
    const cik = REVIEWED_ISSUERS[ticker].cik.padStart(10, "0");
    const catalog = await sec(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const filings = resultsFilings(ticker, JSON.parse(catalog.text), FROM, filingsThrough);
    catalogs.push({ ticker, url: catalog.url, sha256: catalog.sha256, filings: filings.length });
    for (const filing of filings) releases.push(await readOriginal(filing));
  }
  const pairs = pairIssuerRevenue(releases);
  const digest = hash(JSON.stringify(releases));
  const path = resolve(directory, `comparisons-${digest}.json`);
  if (!await load(path)) {
    try {
      await durableJSON(path, { method: METHOD, collectedAt: new Date().toISOString(), secReuse: SEC_REUSE, catalogs, releases, pairs }, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return { pairs, output: path, releases: releases.length };
}

async function study(pairs: Awaited<ReturnType<typeof capture>>["pairs"]) {
  const { snapshots } = await verifyPublicationTree(PROJECT_ROOT);
  const beforeFirstPublicForecast = snapshots.map(snapshot => snapshot.issuedAt).sort()[0];
  if (!beforeFirstPublicForecast || !beforeFirstPublicForecast.startsWith("2026-"))
    throw new Error("Expected a verified first public forecast in the reviewed 2026 calendar");
  const priorDates = historicalResearchSessions(2025);
  const recentDates = exchangeSessions("2026-01-01", newYorkDate(beforeFirstPublicForecast));
  const scheduled = [...priorDates, ...recentDates];
  const instrumentTargets = (["SPY", "QQQ", "DIA"] as const).map(instrument => ({
    instrument,
    targets: pairs.flatMap(pair => {
      if (!(REVIEWED_ISSUERS[pair.ticker].instruments as readonly string[]).includes(instrument)) return [];
      const date = scheduled.find(day => day > pair.afterDate);
      if (!date) return [];
      const session = date < "2026-01-01" ? historicalResearchSession(date)! : exchangeSession(date)!;
      return session.closeAt < beforeFirstPublicForecast && isFullKibotSession(session.openAt, session.closeAt)
        ? [{ pair, session }] : [];
    }),
  }));
  const input = JSON.stringify({ beforeFirstPublicForecast, instrumentTargets });
  const destination = resolve(directory, `${METHOD}-${hash(input)}.json`);
  const saved = await load<{ cohorts: unknown[] }>(destination);
  if (saved) return { status: "reused_private_study", cohorts: saved.cohorts, beforeFirstPublicForecast, output: destination };

  const cohorts = [];
  const priceHashes: Record<string, string> = {};
  for (const { instrument, targets } of instrumentTargets) {
    const dates = targets.map(target => target.session.session);
    // Omit shared target sessions; neither issuer gets credit for the same label.
    const distinct = new Set(dates.filter((date, index) => dates.indexOf(date) === index && dates.lastIndexOf(date) === index));
    const bars = new Map<string, { open: number; close: number }>();
    for (const [days, sessionClock] of [[priorDates, historicalResearchSession], [recentDates, exchangeSession]] as const) {
      const admitted = days.filter(date => distinct.has(date));
      if (!admitted.length) continue;
      const span = days.filter(date => date >= admitted[0] && date <= admitted.at(-1)!);
      const report = await collectKibotSeries(instrument, span, { unadjusted: true, sessionClock });
      priceHashes[`${instrument}:${span[0]}:${span.at(-1)}`] = report.sha256;
      for (const bar of report.sessions) bars.set(bar.session, bar);
    }
    const rows: TrainingRow[] = targets.filter(target => distinct.has(target.session.session)).map(({ pair, session }) => {
      const bar = bars.get(session.session)!;
      return {
        id: `${instrument}:${pair.actual.accession}:${session.session}`,
        engineVersion: METHOD, issuedAt: session.openAt, labelKnownAt: session.closeAt,
        features: [pair.deviationPercent],
        up: bar.close > bar.open ? 1 : 0,
      };
    });
    const plan = planCandidate(rows, beforeFirstPublicForecast);
    cohorts.push({ instrument, eligiblePrelaunchSessions: plan.samples, minimum: plan.minimum, status: plan.status });
  }
  await durableJSON(destination, { method: METHOD, beforeFirstPublicForecast, priceSource: KIBOT_PRICE_CITATION, priceHashes, cohorts }, true);
  return { status: "saved_private_study", cohorts, beforeFirstPublicForecast, output: destination };
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--collect-only"))
  throw new Error("Usage: npm run consensus:research-issuer-revenue -- [--collect-only]");
const { pairs, releases, output } = await capture();
const yieldCounts = {
  status: "captured_private_originals", releases, comparisons: pairs.length,
  above: pairs.filter(pair => pair.rangeStatus === "above").length,
  within: pairs.filter(pair => pair.rangeStatus === "within").length,
  below: pairs.filter(pair => pair.rangeStatus === "below").length,
  latestReport: pairs.at(-1)?.afterDate ?? null, output,
};
console.log(JSON.stringify({ ...yieldCounts, ...(args.length ? {} : { research: await study(pairs) }) }, null, 2));
