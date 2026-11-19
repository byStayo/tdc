import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { publicDate } from "../lib/public-normalization.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { extendedResearchSession, extendedResearchSessions, EXTENDED_CALENDAR_IDS } from "../lib/consensus/extended-research-calendar.ts";
import { treasuryYieldPoints } from "../lib/consensus/fed-market-data.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { ETF_SYMBOLS } from "../lib/consensus/marketparquet.ts";
import { collectResearchPrices, readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const METHOD = "prelaunch-sec-form-d-initial-private-fund-sales-v1";
const FIRST_PRICE = "2022-01-03", LAST_PRICE = "2026-11-02", LAST_TARGET = "2026-09-30";
const FIRST_FILING = "2021-10-01", LAST_FILING = "2026-09-29";
const DAY_MS = 86_400_000;
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-form-d");
type FilingDay = { date: string; original: number; selected: number; dollars: number };
type FilingCorpus = { from: string; through: string; totalSubmissions: number; originalFilings: number; selectedFilings: number;
  proofs: { quarter: string; url: string; retrievedAt: string; sha256: string; bytes: number }[]; days: FilingDay[] };

export function formDFilingFeatures(day: string, filings: Map<string, FilingDay>) {
  const issueDay = Date.parse(day);
  const weeks = Array.from({ length: 9 }, (_, week) => {
    let original = 0, dollars = 0;
    for (let offset = 1; offset <= 7; offset++) {
      const filingDate = new Date(issueDay - (week * 7 + offset) * DAY_MS).toISOString().slice(0, 10);
      const row = filings.get(filingDate);
      original += row?.original ?? 0;
      dollars += row?.dollars ?? 0;
    }
    return { original: Math.log1p(original), dollars: Math.log1p(dollars / 1_000_000) };
  });
  const previous = weeks.slice(1);
  return {
    original: weeks[0].original - previous.reduce((sum, week) => sum + week.original, 0) / previous.length,
    dollars: weeks[0].dollars - previous.reduce((sum, week) => sum + week.dollars, 0) / previous.length,
  };
}

async function savedTreasuryRates() {
  const points: { date: string; value: number }[] = [];
  const sources: { source: string; sha256: string }[] = [];
  for (const year of [2022, 2023, 2024, 2025, 2026]) {
    const receipt = await readResearchReceipt<{ source: string; xml: string; sha256: string }>(
      resolve(root, ".consensus/private-ads", `treasury-${year}.json`));
    const source = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`;
    if (!receipt || receipt.source !== source || createHash("sha256").update(receipt.xml).digest("hex") !== receipt.sha256)
      throw new Error(`Missing verified original Treasury series for ${year}`);
    points.push(...treasuryYieldPoints(receipt.xml, year, `${year}-12-31`).DGS10);
    sources.push({ source, sha256: receipt.sha256 });
  }
  return { yields: new Map(points.map(row => [row.date, row.value])), sources };
}

async function run() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === "--cached-only"))
    throw new Error("Use --cached-only to reuse verified Form D quarters offline");
  const unlock = await acquirePublicationLock(root, "private-sec-form-d-research");
  let failure: { error: unknown } | undefined;
  try {
    const { history } = await verifyPublicationTree(root);
    const before = history[0]?.issuedAt;
    if (!before || before <= extendedResearchSession(LAST_TARGET)!.closeAt)
      throw new Error("Form D experiment overlaps the public forecasts");
    const output = resolve(directory, `${METHOD}.json`);
    const saved = await readResearchReceipt<{ method: string; before: string; summary: unknown }>(output);
    if (saved) {
      if (saved.method !== METHOD || saved.before !== before) throw new Error("Form D study has a different archive boundary");
      console.log(JSON.stringify({ status: "reused", summary: saved.summary }));
      return;
    }

    const corpus: FilingCorpus = JSON.parse(execFileSync("python3", ["-B", resolve(root, "scripts/collect-sec-form-d.py"), ...args],
      { encoding: "utf8", timeout: 180_000, maxBuffer: 400_000 }));
    if (corpus.from !== FIRST_FILING || corpus.through !== LAST_FILING || corpus.proofs.length !== 20 ||
        !corpus.selectedFilings || corpus.days.some((row, i) => publicDate(row.date) !== row.date ||
          row.date < FIRST_FILING || row.date > LAST_FILING || (i > 0 && row.date <= corpus.days[i - 1].date) ||
          ![row.original, row.selected, row.dollars].every(x => Number.isSafeInteger(x) && x >= 0) || row.selected > row.original))
      throw new Error("Form D corpus does not cover the fixed research range and valid aggregates");
    const filings = new Map(corpus.days.map(row => [row.date, row]));
    const { yields, sources: treasury } = await savedTreasuryRates();
    const sessions = extendedResearchSessions(FIRST_PRICE, LAST_PRICE);
    const targets = sessions.flatMap((day, index) => {
      if (index < 2 || day > LAST_TARGET) return [];
      const previous = sessions[index - 1], earlier = sessions[index - 2];
      const clock = extendedResearchSession(day)!, priorClock = extendedResearchSession(previous)!;
      const y = yields.get(previous), oldYield = yields.get(earlier);
      if (y === undefined || oldYield === undefined || !isFullKibotSession(clock.openAt, clock.closeAt) ||
          !isFullKibotSession(priorClock.openAt, priorClock.closeAt)) return [];
      return [{ day, previous, yieldChangeBps: (y - oldYield) * 100, ...formDFilingFeatures(day, filings) }];
    });
    const cohorts = [];
    for (const instrument of ETF_SYMBOLS) {
      const receipts = await collectResearchPrices(resolve(root, ".consensus/private-technical-momentum"), instrument, sessions,
        { cachedOnly: true });
      const prices = new Map(receipts.flatMap(receipt => receipt.sessions.map(bar => [bar.session, bar] as const)));
      const rows = targets.map((target): TrainingRow => {
        const issuedAt = newYorkTimestamp(target.day.replaceAll("-", "") + "T080000")!;
        const price = prices.get(target.day), prior = prices.get(target.previous);
        if (!price || !prior || prior.closeAt >= issuedAt || issuedAt >= price.openAt || price.closeAt >= before)
          throw new Error(`Missing or mistimed Form D price evidence for ${instrument} on ${target.day}`);
        return { id: `${instrument}:${target.day}`, issuedAt, labelKnownAt: price.closeAt, engineVersion: METHOD,
          features: [Math.log(prior.close / prior.open), target.yieldChangeBps, target.original,
            instrument === "TLT" ? -target.dollars : target.dollars], up: price.close > price.open ? 1 : 0 };
      });
      const reference = trainCandidate(rows.map(row => ({ ...row, features: row.features.slice(0, 3) })), before);
      const candidate = trainCandidate(rows, before);
      cohorts.push({ instrument, priceHashes: receipts.map(row => row.sha256), rows, reference, candidate });
    }
    const summary = { quarters: corpus.proofs.length, totalSubmissions: corpus.totalSubmissions, originalFilings: corpus.originalFilings,
      selectedFilings: corpus.selectedFilings, firstTarget: targets[0].day, lastTarget: targets.at(-1)!.day,
      cohorts: cohorts.map(({ instrument, reference, candidate }) => ({ instrument, samples: candidate.samples,
        status: candidate.status, ...(reference.status === "evaluated" && candidate.status === "evaluated" ? {
          test: candidate.split.test, firstTestAt: candidate.split.testStarts.slice(0, 10), candidateBrier: candidate.candidateBrier,
          referenceBrier: reference.candidateBrier, baseRateBrier: candidate.baseRateBrier, coinBrier: candidate.coinBrier,
          clearsResearchMargin: candidate.promoted && candidate.model.weights[3] > 0 &&
            candidate.candidateBrier < reference.candidateBrier - 0.01,
        } : {}) })) };
    await durableJSON(output, { method: METHOD, before, summary, filingDigest: digest(corpus), sec: corpus.proofs, treasury,
      prices: KIBOT_PRICE_CITATION, calendars: EXTENDED_CALENDAR_IDS, targets, cohorts,
      basis: "Net change in log reported initial private-equity and venture fund sales, comparing seven calendar days ending before the issue date with the prior eight seven-day blocks. Uses original filing dates as day-level availability proxies. Controls for prior-session price direction, the official Treasury 10-year change and the equivalent surprise in all original Form D filings. Uses full-session as-traded open-to-close outcomes from the fixed period before the first archived forecast." }, true);
    console.log(JSON.stringify({ status: "saved_private_study", summary }));
  } catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(unlock, failure); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
