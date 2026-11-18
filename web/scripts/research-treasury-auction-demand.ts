import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import type { SessionPrice } from "../lib/consensus/evaluation.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { collectKibotSeries, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import {
  HISTORICAL_RESEARCH_CALENDAR,
  historicalResearchSession,
  historicalResearchSessions,
} from "../lib/consensus/research-session-calendar.ts";
import {
  collectTreasuryAuctionDemand,
  collectTreasuryAuctionRelease,
  TREASURY_AUCTION_DATASET,
  type TreasuryAuctionDemand,
} from "../lib/consensus/treasury-auction-demand.ts";

const METHOD = "prelaunch-tlt-auction-demand-v1";
const FROM = "2022-01-01";
const THROUGH = "2025-12-31";
const PRIOR_AUCTIONS = 3;
const FULL_SESSION_MS = 6.5 * 3_600_000;
const root = fileURLToPath(new URL("../", import.meta.url));
const destination = resolve(root, ".consensus/private-family-research", METHOD + ".json");

export function auctionDemandRows(
  results: TreasuryAuctionDemand[],
  sessions: SessionPrice[],
  beforeFirstPublicForecast: string,
) {
  const byDate = new Map<string, TrainingRow[]>();
  const sharesByTenor = new Map<number, { auctionDate: string; availableAt: string; share: number }[]>();
  for (const result of results) {
    if (result.release.status !== "timestamped") continue;
    const { availableAt } = result.release;
    const previous = sharesByTenor.get(result.tenor) ?? [];
    const baseline = previous.filter(row => row.auctionDate < result.auctionDate && row.availableAt < availableAt)
      .slice(-PRIOR_AUCTIONS);
    previous.push({ auctionDate: result.auctionDate, availableAt, share: result.indirectShare });
    sharesByTenor.set(result.tenor, previous);
    const target = sessions.find(session => session.session > result.auctionDate);
    if (baseline.length !== PRIOR_AUCTIONS || !target ||
        availableAt >= target.openAt || target.closeAt >= beforeFirstPublicForecast ||
        Date.parse(target.closeAt) - Date.parse(target.openAt) !== FULL_SESSION_MS) continue;
    const recentMean = baseline.reduce((sum, row) => sum + row.share, 0) / PRIOR_AUCTIONS;
    const row: TrainingRow = {
      id: `TLT:${result.auctionDate}:${target.session}`,
      engineVersion: METHOD,
      issuedAt: availableAt,
      labelKnownAt: target.closeAt,
      features: [result.indirectShare - recentMean],
      up: target.close > target.open ? 1 : 0,
    };
    const sameTarget = byDate.get(target.session) ?? [];
    sameTarget.push(row);
    byDate.set(target.session, sameTarget);
  }
  const rows = [...byDate.values()].filter(matches => matches.length === 1).map(matches => matches[0]);
  return { rows, sharedTargetSessions: byDate.size - rows.length };
}

function summary(saved: {
  beforeFirstPublicForecast: string;
  cataloguedAuctions: number;
  confirmedReleases: number;
  priceSessions: number;
  sharedTargetSessions: number;
  results: ReturnType<typeof trainCandidate>;
}, status: string) {
  const { results } = saved;
  return {
    status, method: METHOD, from: FROM, through: THROUGH,
    forecastBoundary: saved.beforeFirstPublicForecast,
    cataloguedAuctions: saved.cataloguedAuctions,
    confirmedReleases: saved.confirmedReleases,
    priceSessions: saved.priceSessions,
    sharedTargetSessions: saved.sharedTargetSessions,
    distinctSamples: results.samples,
    result: results.status,
    ...(results.status === "evaluated" ? {
      split: { train: results.split.train, validation: results.split.validation, test: results.split.test },
      candidateBrier: results.candidateBrier,
      baseRateBrier: results.baseRateBrier,
      coinBrier: results.coinBrier,
      clearedResearchMargin: results.promoted,
    } : {}),
  };
}

async function main() {
  if (process.argv.length !== 2) throw new Error("This historical research run uses a frozen policy and accepts no overrides");
  const unlock = await acquirePublicationLock(root, "treasury-auction-demand-research");
  let failure: { error: unknown } | undefined;
  try {
    const { snapshots } = await verifyPublicationTree(root);
    const beforeFirstPublicForecast = snapshots.map(snapshot => snapshot.issuedAt).sort()[0];
    if (!beforeFirstPublicForecast || beforeFirstPublicForecast <= THROUGH + "T23:59:59.999Z")
      throw new Error("This research window overlaps published forecasts");
    let existing;
    try {
      existing = JSON.parse(await readFile(destination, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      if (existing.method !== METHOD || existing.beforeFirstPublicForecast !== beforeFirstPublicForecast ||
          existing.calendar.id !== HISTORICAL_RESEARCH_CALENDAR.id)
        throw new Error("Saved auction study differs from the frozen method or archive");
      console.log(JSON.stringify(summary(existing, "reused-private-study"), null, 2));
      return;
    }

    const reads = await collectTreasuryAuctionDemand(FROM, THROUGH);
    const releases: TreasuryAuctionDemand[] = [];
    for (let i = 0; i < reads.length; i += 3) {
      const batch = await Promise.all(reads.slice(i, i + 3).map(row => collectTreasuryAuctionRelease(row)));
      releases.push(...batch);
    }
    const bars: SessionPrice[] = [];
    const priceHashes: Record<number, string> = {};
    for (const year of HISTORICAL_RESEARCH_CALENDAR.years) {
      const report = await collectKibotSeries("TLT", historicalResearchSessions(year), {
        unadjusted: true, sessionClock: historicalResearchSession,
      });
      bars.push(...report.sessions);
      priceHashes[year] = report.sha256;
    }
    const { rows, sharedTargetSessions } = auctionDemandRows(releases, bars, beforeFirstPublicForecast);
    const results = trainCandidate(rows, beforeFirstPublicForecast);
    const saved = {
      method: METHOD,
      createdAt: new Date().toISOString(),
      beforeFirstPublicForecast,
      calendar: HISTORICAL_RESEARCH_CALENDAR,
      priceSource: KIBOT_PRICE_CITATION,
      auctionSource: TREASURY_AUCTION_DATASET,
      catalog: reads[0]?.source,
      cataloguedAuctions: reads.length,
      confirmedReleases: releases.filter(row => row.release.status === "timestamped").length,
      priceSessions: bars.length,
      sharedTargetSessions,
      priceHashes,
      receipts: releases.map(row => ({
        date: row.auctionDate, cusip: row.cusip, tenor: row.tenor,
        release: row.release,
      })),
      policy: "Compare indirect competitive award share to the mean of the three previously verified auctions of the same original tenor. Pair one auction with the next scheduled full NY session if the official receipt predates its open. Omit shared target sessions.",
      limitation: "Private pre-launch research with archived official result receipts and raw same-session TLT outcomes. This test neither compares incremental performance against live rate-family forecasts nor uses prospective test reservations.",
      results,
    };
    await durableJSON(destination, saved, true);
    console.log(JSON.stringify(summary(saved, "saved-private-study"), null, 2));
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishPublicationLock(unlock, failure);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
