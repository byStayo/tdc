import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { publicDate } from "../lib/public-normalization.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { publicBytes } from "../lib/consensus/collector.ts";
import { extendedResearchSession, extendedResearchSessions, EXTENDED_CALENDAR_IDS } from "../lib/consensus/extended-research-calendar.ts";
import { treasuryYieldPoints } from "../lib/consensus/fed-market-data.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { ETF_SYMBOLS } from "../lib/consensus/marketparquet.ts";
import { collectResearchPrices, readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const METHOD = "prelaunch-philly-ads-revisions-2022-2026-v1";
const FIRST_PRICE = "2022-01-03", LAST_TARGET = "2026-11-02", ARCHIVE_DAY = "2026-11-17";
const ARCHIVE_SHA256 = "73ad66b51c3d31937a019a4728d7066eb0498b8077e9706b549642889df1f03d";
const ARCHIVE_URL = "https://www.philadelphiafed.org/-/media/FRBP/Assets/Surveys-And-Data/ads/ads_all_vintages-zip.zip?la=en&sc_lang=en&hash=4E6B77E5055CA510D1E653F4DD7395C2";
const TREASURY = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve";
const years = [2022, 2023, 2024, 2025, 2026];
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-ads");
type Vintage = { date: string; previous: string; observed: string; change: number };
type Extract = { allVintages: number; allDailyRows: number; selectedVintages: number; firstVintage: string;
  lastVintage: string; updates: Vintage[] };
type Source = { source: string; sha256: string; bytes?: number; retrievedAt: string };
type Rates = Source & { xml: string };

export function adsTargets(updates: Vintage[], sessions: string[], yields: Map<string, number>) {
  const targets = new Map<string, Vintage & { preceding: string; yieldChangeBps: number }>();
  for (const update of updates) {
    const index = sessions.findIndex(day => day > update.date);
    if (index < 2) continue;
    const prior = sessions[index - 1], earlier = sessions[index - 2], target = sessions[index];
    if ([prior, target].some(day => {
      const clock = extendedResearchSession(day)!;
      return !isFullKibotSession(clock.openAt, clock.closeAt);
    })) continue;
    const lastYield = yields.get(prior), previousYield = yields.get(earlier);
    if (lastYield === undefined || previousYield === undefined) continue;
    targets.set(target, { ...update, preceding: prior, yieldChangeBps: (lastYield - previousYield) * 100 });
  }
  return targets;
}

async function rateReceipt(year: number) {
  const source = `${TREASURY}&field_tdr_date_value=${year}`;
  const file = resolve(directory, `treasury-${year}.json`);
  let receipt = await readResearchReceipt<Rates>(file);
  if (!receipt) {
    const capture = await publicBytes(source);
    receipt = { source, sha256: capture.sha256, xml: capture.bytes.toString("utf8"), retrievedAt: capture.retrievedAt };
    treasuryYieldPoints(receipt.xml, year, `${year}-12-31`);
    await durableJSON(file, receipt, true);
  }
  if (receipt.source !== source || createHash("sha256").update(receipt.xml).digest("hex") !== receipt.sha256)
    throw new Error("Treasury annual archive differs from its capture");
  return { source, sha256: receipt.sha256,
    points: treasuryYieldPoints(receipt.xml, year, `${year}-12-31`).DGS10 };
}

async function originalUpdates() {
  const prefix = `all-vintages-${ARCHIVE_DAY}`;
  const sourceProof = await readResearchReceipt<Source>(resolve(directory, `${prefix}.json`));
  if (!sourceProof || sourceProof.source !== ARCHIVE_URL || sourceProof.sha256 !== ARCHIVE_SHA256 ||
      sourceProof.bytes !== 170_801_033 || !Number.isFinite(Date.parse(sourceProof.retrievedAt)))
    throw new Error("Expected the pinned private Philadelphia Fed archive and receipt");
  const normalized = resolve(directory, `normalized-vintage-revisions-${ARCHIVE_DAY}.json`);
  const cached = await readResearchReceipt<{ sourceProof: Source; result: Extract }>(normalized);
  if (cached && digest(cached.sourceProof) !== digest(sourceProof)) throw new Error("ADS extraction has a different source proof");
  const result: Extract = cached?.result ?? JSON.parse(execFileSync("python3",
    ["-B", resolve(root, "scripts/read-philly-ads-vintages.py"), resolve(directory, `${prefix}.zip`), ARCHIVE_SHA256],
    { encoding: "utf8", timeout: 150_000, maxBuffer: 300_000 }));
  if (result.allVintages !== 1581 || result.allDailyRows !== 24358 || result.lastVintage !== ARCHIVE_DAY ||
      result.updates.length !== result.selectedVintages - 1 || result.updates.some((row, index) =>
        ![row.date, row.previous, row.observed].every(day => publicDate(day) === day) ||
        !Number.isFinite(row.change) || row.observed > row.previous || row.previous >= row.date ||
        (index > 0 && row.previous !== result.updates[index - 1].date)))
    throw new Error("ADS archive does not have the expected ordered original release comparisons");
  if (!cached) await durableJSON(normalized, { sourceProof, result }, true);
  return { sourceProof, result };
}

async function run() {
  if (process.argv.length !== 2) throw new Error("The fixed ADS research cohort accepts no overrides");
  const unlock = await acquirePublicationLock(root, "private-philly-ads-research");
  let failure: { error: unknown } | undefined;
  try {
    const { history } = await verifyPublicationTree(root);
    const before = history[0]?.issuedAt;
    if (!before || before <= extendedResearchSession(LAST_TARGET)!.closeAt)
      throw new Error("ADS experiment overlaps the public forecasts");
    const output = resolve(directory, `${METHOD}.json`);
    const saved = await readResearchReceipt<{ method: string; before: string; summary: unknown }>(output);
    if (saved) {
      if (saved.method !== METHOD || saved.before !== before) throw new Error("ADS benchmark has a different forecast boundary");
      console.log(JSON.stringify({ status: "reused", summary: saved.summary }));
      return;
    }

    const { sourceProof, result } = await originalUpdates();
    const rates = [];
    for (const year of years) rates.push(await rateReceipt(year));
    const sessions = extendedResearchSessions(FIRST_PRICE, LAST_TARGET);
    const yields = new Map(rates.flatMap(({ points }) => points.map(row => [row.date, row.value] as const)));
    const targets = adsTargets(result.updates, sessions, yields);
    const cohorts = [];
    for (const instrument of ETF_SYMBOLS) {
      const sources = await collectResearchPrices(resolve(root, ".consensus/private-technical-momentum"), instrument, sessions,
        { cachedOnly: true });
      const prices = new Map(sources.flatMap(receipt => receipt.sessions.map(bar => [bar.session, bar] as const)));
      const pairs = [...targets].map(([session, signal]) => {
        const label = prices.get(session), preceding = prices.get(signal.preceding);
        const issuedAt = newYorkTimestamp(session.replaceAll("-", "") + "T080000")!;
        if (!label || !preceding || preceding.closeAt >= issuedAt || issuedAt >= label.openAt || label.closeAt >= before)
          throw new Error(`Missing or mistimed ADS price evidence for ${instrument} on ${session}`);
        const row: TrainingRow = { id: `${instrument}:${session}`, engineVersion: METHOD,
          issuedAt, labelKnownAt: label.closeAt,
          features: [Math.log(preceding.close / preceding.open), signal.yieldChangeBps,
            instrument === "TLT" ? -signal.change : signal.change], up: label.close > label.open ? 1 : 0 };
        return { signal, row };
      });
      const observations = pairs.map(pair => pair.row);
      const reference = trainCandidate(observations.map(row => ({ ...row, features: row.features.slice(0, 2) })), before);
      const candidate = trainCandidate(observations, before);
      cohorts.push({ instrument, priceHashes: sources.map(row => row.sha256), pairs, reference, candidate });
    }
    const summary = { allVintages: result.allVintages, selectedVintages: result.selectedVintages,
      prelaunchRevisions: result.updates.filter(row => row.date < LAST_TARGET).length, pairedTargets: targets.size,
      cohorts: cohorts.map(({ instrument, reference, candidate }) => ({ instrument, samples: candidate.samples,
        status: candidate.status, ...(reference.status === "evaluated" && candidate.status === "evaluated" ? {
          test: candidate.split.test, startsTestAt: candidate.split.testStarts, referenceBrier: reference.candidateBrier,
          candidateBrier: candidate.candidateBrier, baseBrier: candidate.baseRateBrier, coinBrier: candidate.coinBrier,
          clearsResearchMargin: candidate.promoted && candidate.model.weights[2] > 0 &&
            candidate.candidateBrier < reference.candidateBrier - 0.01,
        } : {}) })) };
    await durableJSON(output, { method: METHOD, before, sourceProof, revisionsDigest: digest(result), summary, cohorts,
      calendars: EXTENDED_CALENDAR_IDS, priceSource: KIBOT_PRICE_CITATION,
      rateSources: rates.map(({ source, sha256 }) => ({ source, sha256 })),
      policy: "Change in the latest common historical observation between consecutive original ADS vintages. Use the next scheduled full cash session and one latest available revision per cutoff. Compare with the prior-session log body and original Treasury 10-year change from the two preceding cash sessions. Test the added revision on the same chronological dates with expected positive equity and negative TLT sign. Vintage dates support release-day sequencing without exact original intraday timestamps. Private retrospective research before the first public forecast." }, true);
    console.log(JSON.stringify({ status: "saved_private_study", summary }));
  } catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(unlock, failure); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
