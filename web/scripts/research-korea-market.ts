import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { publicDate } from "../lib/public-normalization.ts";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { publicText } from "../lib/consensus/collector.ts";
import type { SessionPrice } from "../lib/consensus/evaluation.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { collectKibotSeries, isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { policyCsv } from "../lib/consensus/policy.ts";
import { HISTORICAL_RESEARCH_CALENDAR, historicalResearchSession, historicalResearchSessions } from "../lib/consensus/research-session-calendar.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-korea-market");
const METHOD = "prelaunch-kosdaq-kospi-iwm-v1";
const FROM = "2024-01-01", THROUGH = "2025-12-31";
const YEARS = [2024, 2025] as const;
const USD_FROM = "2023-12-20";
const ECB_USD = `https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=${USD_FROM}&endPeriod=${THROUGH}&format=csvdata`;
const MOFE_CATALOGUE = "https://www.data.go.kr/data/3034223/fileData.do";
const SHA256 = /^[0-9a-f]{64}$/;
const dayMs = 86_400_000;

export type KoreaBulletin = {
  id: string; postingDate: string; observationDate: string; source: string; sha256: string;
  kospi: { prior: number; close: number }; kosdaq: { prior: number; close: number };
};
type Capture = { schemaVersion: 1; from: string; through: string; rows: KoreaBulletin[];
  summary: { indexEntries: number; processed: number; accepted: number; pending: number; complete: boolean;
    archiveVintage: { savedAfterPostingDate: number; savedBetweenObservationAndPosting: number;
      savedBeforeObservationDate: number; missingLastSaved: number } } };
type Fix = { date: string; value: number };
type FxReference = Awaited<ReturnType<typeof publicText>> & { source: string };
type PriceReference = Awaited<ReturnType<typeof collectKibotSeries>> & { instrument: "IWM"; source: string; calendar: string };
type KoreaFeature = KoreaBulletin & { availableAt: string; issuedAt: string; spread: number };

function validBulletin(row: KoreaBulletin) {
  if (!row || typeof row.id !== "string" || !row.id || !SHA256.test(row.sha256) ||
      publicDate(row.postingDate) !== row.postingDate || publicDate(row.observationDate) !== row.observationDate ||
      row.postingDate < FROM || row.postingDate > THROUGH || row.observationDate > row.postingDate ||
      !row.kospi || !row.kosdaq || ![row.kospi.prior, row.kospi.close, row.kosdaq.prior, row.kosdaq.close]
        .every(value => Number.isFinite(value) && value > 0)) return false;
  const url = new URL(row.source);
  return url.protocol === "https:" && ["mofe.go.kr", "www.mofe.go.kr", "moef.go.kr", "www.moef.go.kr"].includes(url.hostname) &&
    !url.username && !url.password && !url.port;
}

/** Pick original observations by their first evidenced posting date. One observation is used once. */
export function koreaFeatures(rows: KoreaBulletin[], sessions: string[]): Map<string, KoreaFeature> {
  const originals = new Map<string, KoreaBulletin[]>();
  for (const row of [...rows].sort((a, b) => a.postingDate.localeCompare(b.postingDate) || a.id.localeCompare(b.id))) {
    const group = originals.get(row.observationDate);
    if (!group) originals.set(row.observationDate, [row]);
    else if (group[0].postingDate === row.postingDate) group.push(row);
  }
  const targets = sessions.flatMap(day => {
    const clock = historicalResearchSession(day);
    return clock && isFullKibotSession(clock.openAt, clock.closeAt)
      ? [{ day, issuedAt: newYorkTimestamp(day.replaceAll("-", "") + "T080000")! }] : [];
  });
  const byTarget = new Map<string, KoreaFeature>();
  for (const group of originals.values()) {
    const [row] = group;
    if (group.some(other => other.kospi.prior !== row.kospi.prior || other.kospi.close !== row.kospi.close ||
        other.kosdaq.prior !== row.kosdaq.prior || other.kosdaq.close !== row.kosdaq.close)) continue;
    // End of the posted Seoul date is 00:00 KST the next day, 15:00 UTC.
    const availableAt = `${row.postingDate}T15:00:00.000Z`;
    const target = targets.find(day => day.issuedAt > availableAt);
    if (!target) continue;
    const previous = byTarget.get(target.day);
    if (previous && previous.observationDate > row.observationDate) continue;
    byTarget.set(target.day, {
      ...row, availableAt, issuedAt: target.issuedAt,
      spread: 10_000 * (Math.log(row.kosdaq.close / row.kosdaq.prior) - Math.log(row.kospi.close / row.kospi.prior)),
    });
  }
  return byTarget;
}

export function ecbUsdFixes(text: string): Fix[] {
  const [header, ...rows] = policyCsv(text);
  const fields = ["KEY", "TIME_PERIOD", "OBS_VALUE", "OBS_STATUS"].map(name => header?.indexOf(name) ?? -1);
  if (fields.some(i => i < 0) || !rows.length) throw new Error("ECB response lacks daily USD fix fields");
  const [k, d, v, s] = fields;
  let previous = "";
  return rows.map(row => {
    const date = row[d], value = Number(row[v]);
    if (row[k] !== "EXR.D.USD.EUR.SP00.A" || publicDate(date) !== date || date <= previous ||
        date < USD_FROM || date > THROUGH || !Number.isFinite(value) || value <= 0 || row[s] !== "A")
      throw new Error("ECB USD fix series is incomplete or out of order");
    previous = date;
    return { date, value };
  });
}

export function koreaTrainingPairs(features: Map<string, KoreaFeature>, bars: SessionPrice[], fixes: Fix[], before: string) {
  return bars.flatMap(bar => {
    const feature = features.get(bar.session);
    if (!feature || bar.closeAt >= before || !isFullKibotSession(bar.openAt, bar.closeAt)) return [];
    // ECB publishes around 16:00 Central European time. The latest strictly earlier
    // calendar date is a conservative eligibility bound for the 08:00 NY forecast.
    const last = fixes.findLastIndex(rate => rate.date < bar.session);
    if (last < 1 || Date.parse(bar.session) - Date.parse(fixes[last].date) > 7 * dayMs ||
        Date.parse(fixes[last].date) - Date.parse(fixes[last - 1].date) > 7 * dayMs) return [];
    const fx = 10_000 * Math.log(fixes[last].value / fixes[last - 1].value);
    const training: TrainingRow = {
      id: `IWM:${bar.session}`, engineVersion: METHOD, issuedAt: feature.issuedAt, labelKnownAt: bar.closeAt,
      features: [fx, feature.spread], up: bar.close > bar.open ? 1 : 0,
    };
    return [{ training, bulletinId: feature.id, availableAt: feature.availableAt,
      fxDates: [fixes[last - 1].date, fixes[last].date] }];
  });
}

async function getCachedStudy(file: string) {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > 2_000_000) throw new Error("Invalid saved private Korean research file");
  return JSON.parse(await readFile(file, "utf8"));
}

async function researchReferences() {
  await durableDirectory(directory, 0o700);
  const fxPath = resolve(directory, "ecb-usd-eur-2024-2025.json");
  const storedFX = await getCachedStudy(fxPath) as FxReference | null;
  const fx = storedFX ?? { source: ECB_USD, ...await publicText(ECB_USD) };
  if (fx.source !== ECB_USD || !Number.isFinite(Date.parse(fx.retrievedAt)) ||
      createHash("sha256").update(fx.text).digest("hex") !== fx.sha256) throw new Error("ECB capture differs from the saved source receipt");
  const fixes = ecbUsdFixes(fx.text);
  if (!storedFX) await durableJSON(fxPath, fx, true);
  const priceSources: PriceReference[] = [];
  for (const year of YEARS) {
    const calendar = HISTORICAL_RESEARCH_CALENDAR.id;
    const days = historicalResearchSessions(year);
    const pricePath = resolve(directory, `iwm-${year}-raw.json`);
    const storedPrice = await getCachedStudy(pricePath) as PriceReference | null;
    const price: PriceReference = storedPrice ?? { instrument: "IWM", source: KIBOT_PRICE_CITATION, calendar,
      ...await collectKibotSeries("IWM", days, { unadjusted: true, sessionClock: historicalResearchSession }) };
    if (price.instrument !== "IWM" || price.source !== KIBOT_PRICE_CITATION || price.calendar !== calendar || !SHA256.test(price.sha256) ||
        !Array.isArray(price.sessions) || price.sessions.length !== days.length || price.sessions.some((bar, i) => {
          const clock = historicalResearchSession(days[i])!;
          return bar.session !== days[i] || bar.openAt !== clock.openAt || bar.closeAt !== clock.closeAt ||
            ![bar.open, bar.close].every(value => Number.isFinite(value) && value > 0);
        })) throw new Error("IWM capture differs from its reviewed research calendar");
    if (!storedPrice) await durableJSON(pricePath, price, true);
    priceSources.push(price);
  }
  return { fx, fixes, priceSources };
}

async function main() {
  const referencesOnly = process.argv[2] === "--prepare-references" && process.argv.length === 3;
  if (process.argv.length !== 2 && !referencesOnly) throw new Error("Usage: consensus:research-korea [--prepare-references]");
  const unlock = await acquirePublicationLock(root, "private-korea-market-study");
  let failure: { error: unknown } | undefined;
  try {
    const { history } = await verifyPublicationTree(root);
    const before = history[0]?.issuedAt;
    if (!before || before <= `${THROUGH}T23:59:59.999Z`) throw new Error("The historical study overlaps the public forecast archive");
    if (referencesOnly) {
      const { fixes, priceSources } = await researchReferences();
      console.log(JSON.stringify({ status: "private_references_ready", fxFixes: fixes.length,
        iwmPriceSessions: priceSources.reduce((total, source) => total + source.sessions.length, 0) }));
      return;
    }
    const output = resolve(directory, `${METHOD}.json`);
    const kept = await getCachedStudy(output);
    if (kept) {
      if (kept.method !== METHOD || kept.beforeFirstPublicForecast !== before || kept.calendar !== HISTORICAL_RESEARCH_CALENDAR.id)
        throw new Error("Saved Korea study differs from the frozen calendar or archive boundary");
      console.log(JSON.stringify({ status: "reused_private_study", ...kept.summary }));
      return;
    }
    const { stdout } = await promisify(execFile)("python3", [resolve(root, "scripts/collect-mofe-market-bulletins.py"), "--cached-only"],
      { cwd: root, maxBuffer: 2_000_000 });
    const capture = JSON.parse(stdout) as Capture;
    const vintage = capture.summary?.archiveVintage;
    if (capture.schemaVersion !== 1 || capture.from !== FROM || capture.through !== THROUGH ||
        capture.summary?.complete !== true || capture.summary.pending !== 0 ||
        !Number.isSafeInteger(capture.summary.indexEntries) || capture.summary.indexEntries !== capture.summary.processed ||
        !vintage || Object.values(vintage).some(count => !Number.isSafeInteger(count) || count < 0) ||
        Object.values(vintage).reduce((sum, count) => sum + count, 0) !== capture.summary.accepted ||
        !Array.isArray(capture.rows) || capture.rows.length !== capture.summary.accepted ||
        !capture.rows.length || capture.rows.length > 600 || new Set(capture.rows.map(row => row.id)).size !== capture.rows.length ||
        !capture.rows.every(validBulletin)) throw new Error("Complete, validated 2024–25 MOFE receipts are required before inspecting the holdout");

    const yearSessions = YEARS.map(historicalResearchSessions);
    const features = koreaFeatures(capture.rows, yearSessions.flat());
    const { fx: fxSource, fixes, priceSources } = await researchReferences();
    const pairs = koreaTrainingPairs(features, priceSources.flatMap(source => source.sessions), fixes, before);
    const combinedRows = pairs.map(pair => pair.training);
    const fx = trainCandidate(combinedRows.map(row => ({ ...row, features: [row.features[0]] })), before);
    const korea = trainCandidate(combinedRows.map(row => ({ ...row, features: [row.features[1]] })), before);
    const combined = trainCandidate(combinedRows, before);
    const summary = {
      archiveEntries: capture.summary.indexEntries, acceptedBulletins: capture.rows.length,
      archiveVintage: vintage,
      datedFeatures: features.size, fxFixes: fixes.length, instrument: "IWM", pairedSessions: pairs.length,
      testSessions: combined.status === "evaluated" ? combined.split.test : 0,
      brier: fx.status === "evaluated" && korea.status === "evaluated" && combined.status === "evaluated" ? {
        fx: fx.candidateBrier, korea: korea.candidateBrier, combined: combined.candidateBrier,
        trainingBaseRate: combined.baseRateBrier, coin: combined.coinBrier,
      } : null,
      clearsResearchMargin: fx.status === "evaluated" && korea.status === "evaluated" && combined.status === "evaluated" &&
        korea.promoted && korea.model.weights[0] > 0 && combined.promoted && combined.model.weights[1] > 0 &&
        combined.candidateBrier < fx.candidateBrier - 0.01,
    };
    await durableDirectory(directory, 0o700);
    await durableJSON(output, {
      method: METHOD, beforeFirstPublicForecast: before, calendar: HISTORICAL_RESEARCH_CALENDAR.id, summary,
      bulletins: { source: MOFE_CATALOGUE, sha256: digest(capture.rows), capture: capture.summary },
      fx: { source: ECB_USD, sha256: fxSource.sha256, retrievedAt: fxSource.retrievedAt, revision: "latest-vintage" },
      pricing: { source: KIBOT_PRICE_CITATION, hashes: priceSources.map(row => row.sha256), basis: "private unadjusted same-session IWM" },
      pairs, results: { fx, korea, combined },
      methodNote: "A positive KOSDAQ-minus-KOSPI spread predicts IWM up. Test its own and incremental Brier improvement of over 0.01 against base, 50/50 and the identical-date ECB comparison. Latest-vintage archive reconstruction. HWP save times and the current ECB history cannot establish as-issued file vintages. The outcome period predates the first public forecast.",
    }, true);
    console.log(JSON.stringify({ status: "saved_private_study", ...summary }));
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    await finishPublicationLock(unlock, failure);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
