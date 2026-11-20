import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { publicBytes } from "../lib/consensus/collector.ts";
import { extendedResearchSession, extendedResearchSessions, EXTENDED_CALENDAR_IDS } from "../lib/consensus/extended-research-calendar.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { ETF_SYMBOLS } from "../lib/consensus/marketparquet.ts";
import { collectResearchPrices, readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-nyfed-nowcast");
const METHOD = "prelaunch-nyfed-nowcast-revisions-2023-2026-v1";
const LAUNCH = "2023-09-08", THROUGH = "2026-10-30", LAST_TARGET = "2026-11-02";
const PAGE = "https://www.newyorkfed.org/research/policy/nowcast/";
const FILE = "https://www.newyorkfed.org/medialibrary/Research/Interactives/Data/NowCast/downloads/New-York-Fed-Staff-Nowcast_download_data";
const dayMs = 86_400_000;
// Veterans Day observed is a federal holiday while the cash exchanges remain open.
const FED_ONLY_CLOSURES = new Set(["2023-11-10"]);
type Workbook = { source: string; sha256: string; capturedAt: string; base64: string };
export type Forecast = { date: string; quarters: Record<string, number> };

function quarter(day: string) {
  return `${day.slice(0, 4)}Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`;
}

export function nowcastTargets(forecasts: Forecast[]) {
  const scheduled = extendedResearchSessions(LAUNCH, LAST_TARGET);
  const targets = new Map<string, { observed: string; previous: string; quarter: string; delta: number }>();
  let previous: Forecast | undefined;
  for (const forecast of forecasts) {
    if (forecast.date < LAUNCH || forecast.date > THROUGH || FED_ONLY_CLOSURES.has(forecast.date)) continue;
    const publication = extendedResearchSession(forecast.date);
    if (!publication || !isFullKibotSession(publication.openAt, publication.closeAt) || new Date(forecast.date).getUTCDay() !== 5) continue;
    const period = quarter(forecast.date);
    const current = forecast.quarters[period], prior = previous?.quarters[period];
    const target = scheduled.find(day => day > forecast.date);
    if (target && previous && Number.isFinite(current) && prior !== undefined && Number.isFinite(prior) &&
        Date.parse(forecast.date) - Date.parse(previous.date) <= 14 * dayMs) {
      const clock = extendedResearchSession(target)!;
      if (isFullKibotSession(clock.openAt, clock.closeAt))
        targets.set(target, { observed: forecast.date, previous: previous.date, quarter: period, delta: current - prior });
    }
    previous = forecast;
  }
  return targets;
}

async function run() {
  if (process.argv.length !== 2) throw new Error("The Nowcast screen uses frozen dates and accepts no overrides");
  const unlock = await acquirePublicationLock(root, "private-nowcast-growth-study");
  let failure: { error: unknown } | undefined;
  try {
    const { history } = await verifyPublicationTree(root);
    const before = history[0]?.issuedAt;
    if (!before || before <= `${LAST_TARGET}T21:00:00.000Z`) throw new Error("Staff Nowcast research overlaps public forecasts");
    const output = resolve(directory, `${METHOD}.json`);
    const result = await readResearchReceipt<{ method: string; before: string; summary: unknown }>(output);
    if (result) {
      if (result.method !== METHOD || result.before !== before) throw new Error("Saved study has a different archive boundary");
      console.log(JSON.stringify({ status: "reused_private_study", summary: result.summary }));
      return;
    }
    await durableDirectory(directory, 0o700);
    const workbookPath = resolve(directory, "chart-workbook.json");
    const cachedWorkbook = await readResearchReceipt<Workbook>(workbookPath);
    let workbook = cachedWorkbook;
    if (!workbook) {
      const { bytes, sha256, retrievedAt } = await publicBytes(FILE);
      workbook = { source: FILE, sha256, capturedAt: retrievedAt, base64: bytes.toString("base64") };
    }
    const bytes = Buffer.from(workbook.base64, "base64");
    if (workbook.source !== FILE || !Number.isFinite(Date.parse(workbook.capturedAt)) || createHash("sha256").update(bytes).digest("hex") !== workbook.sha256)
      throw new Error("Staff Nowcast archive source or hash differs");
    const forecasts = JSON.parse(execFileSync("python3", [resolve(root, "scripts/read-nyfed-nowcast.py")],
      { input: bytes, encoding: "utf8", timeout: 5_000, maxBuffer: 1_000_000 })) as Forecast[];
    if (!forecasts.some(row => row.date === LAUNCH) || !forecasts.some(row => row.date === THROUGH))
      throw new Error("Official chart workbook lacks both declared boundary dates");
    if (!cachedWorkbook) await durableJSON(workbookPath, workbook, true);
    const targets = nowcastTargets(forecasts);
    const cohorts = [];
    for (const instrument of ETF_SYMBOLS) {
      const sources = await collectResearchPrices(directory, instrument, [...targets.keys()]);
      const pairs = sources.flatMap(source => source.sessions).flatMap(bar => {
        const feature = targets.get(bar.session);
        if (!feature || bar.closeAt >= before) return [];
        const training: TrainingRow = { id: `${instrument}:${bar.session}`, engineVersion: METHOD,
          issuedAt: newYorkTimestamp(bar.session.replaceAll("-", "") + "T080000")!, labelKnownAt: bar.closeAt,
          features: [instrument === "TLT" ? -feature.delta : feature.delta], up: bar.close > bar.open ? 1 : 0 };
        return [{ ...feature, training }];
      });
      cohorts.push({ instrument, priceHashes: sources.map(source => source.sha256), pairs,
        result: trainCandidate(pairs.map(pair => pair.training), before) });
    }
    const summary = { chartDates: forecasts.filter(row => row.date >= LAUNCH && row.date <= THROUGH).length, datedRevisions: targets.size,
      cohorts: cohorts.map(({ instrument, result }) => ({ instrument, samples: result.samples, status: result.status,
        ...(result.status === "evaluated" ? { test: result.split.test, candidateBrier: result.candidateBrier,
          baseRateBrier: result.baseRateBrier, coinBrier: result.coinBrier,
          clearsResearchMargin: result.promoted && result.model.weights[0] > 0 } : {}) })) };
    await durableJSON(output, { method: METHOD, before, launch: LAUNCH, through: THROUGH, summary, cohorts,
      calendars: EXTENDED_CALENDAR_IDS, source: { publisher: PAGE, sha256: workbook.sha256, capturedAt: workbook.capturedAt }, priceSource: KIBOT_PRICE_CITATION,
      policy: "Use the signed change between consecutive eligible workbook Fridays for the same calendar quarter, with a positive expected relation for equities and a negative one for TLT. Full sessions only and the next scheduled session fixes the label target. Workbook dates inferred from the official Friday schedule give a timing proxy. This archive-based screen cannot establish original publication timestamps or actual as-issued feature vintages." }, true);
    console.log(JSON.stringify({ status: "saved_private_study", summary }));
  } catch (error) { failure = { error }; throw error; }
  finally { await finishPublicationLock(unlock, failure); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
