import { publicDate } from "../public-normalization.ts";
import { exchangeSession, hasReviewedCalendar } from "./exchange-calendar.ts";
import { newYorkDate } from "./time.ts";
import { INSTRUMENTS } from "./types.ts";
import type { HistoryEntry } from "./types.ts";

export const KIBOT_RESEARCH_FILE = "kibot-research.json";
export const KIBOT_RESEARCH_LICENSE = "https://www.kibot.com/license.html";
export const KIBOT_RESEARCH_SYMBOLS = INSTRUMENTS.filter(symbol => symbol !== "MARKET");

export const KIBOT_LEGACY_RESEARCH_STUDIES = [
  { id: "prelaunch-family-screen-v1", family: "technicals", label: "Price trend and momentum", size: 5 },
  { id: "prelaunch-family-screen-v1", family: "institutions", label: "CFTC positioning", size: 5 },
  { id: "prelaunch-scheduled-events-v1", family: "events", label: "FOMC dates and options expiries", size: 5 },
  { id: "prelaunch-gdelt-news-v1", family: "news", label: "GDELT finance-news tone", size: 4 },
  { id: "prelaunch-tlt-auction-demand-v1", family: "rates", label: "Treasury auction demand", size: 1 },
] as const;

export const FT900_RESEARCH = {
  id: "prelaunch-ft900-exports-dia-v1", family: "international", label: "U.S. exports and the euro–dollar rate",
  policySha256: "6f0d082ab9781009179f04a14f17226699f5fd744155750659e15d91508f8bbd",
  census: "https://www.census.gov/foreign-trade/Press-Release/ft900_index.html",
  ecb: "https://data.ecb.europa.eu/data/datasets/EXR/EXR.D.USD.EUR.SP00.A",
} as const;
export const SPY_CLOSE_LOCATION_RESEARCH = {
  id: "prelaunch-spy-close-location-2025-v1", family: "technicals", label: "Closing position in the daily range",
  bars: "https://getmarkethistory.com/docs/bars/", delivery: "https://getmarkethistory.com/docs/reliability/",
  terms: "https://getmarkethistory.com/docs/terms/",
} as const;
export const KIBOT_RESEARCH_STUDIES = [...KIBOT_LEGACY_RESEARCH_STUDIES, FT900_RESEARCH, SPY_CLOSE_LOCATION_RESEARCH] as const;

type Symbol = typeof KIBOT_RESEARCH_SYMBOLS[number];
type StudyMetrics = {
  samples: number; testSamples: number; modelBrier: number; baseRateBrier: number; clearedMargin: boolean;
};
export type Ft900StudyRow = StudyMetrics & {
  family: "international"; instrument: "DIA"; fxOnlyBrier: number; coinBrier: number;
  exportCoefficientSign: "positive" | "negative" | "zero";
};
export type SpyCloseLocationStudyRow = StudyMetrics & {
  studyId: typeof SPY_CLOSE_LOCATION_RESEARCH.id; family: "technicals"; instrument: "SPY";
  returnOnlyBrier: number; coinBrier: number;
};
type LegacyStudyRow = StudyMetrics & {
  family: typeof KIBOT_LEGACY_RESEARCH_STUDIES[number]["family"]; instrument: Symbol;
};

export interface KibotResearch {
  schemaVersion: 1 | 2 | 3 | 4;
  source: typeof KIBOT_RESEARCH_LICENSE;
  firstEdition: string;
  through: string;
  daily: { instrument: Symbol; sessions: number; calls: number; eligibleSessions?: number }[];
  studies: (LegacyStudyRow | Ft900StudyRow | SpyCloseLocationStudyRow)[];
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const brier = (value: unknown): value is number =>
  typeof value === "number" && value >= 0 && value <= 1 && Number(value.toFixed(4)) === value;

const studyKeys = ["family", "instrument", "samples", "testSamples", "modelBrier", "baseRateBrier", "clearedMargin"];

function validMetrics(row: Record<string, unknown>) {
  return count(row.samples) && count(row.testSamples) && row.samples >= 120 && row.testSamples >= 20 &&
    row.testSamples < row.samples && brier(row.modelBrier) && brier(row.baseRateBrier) && typeof row.clearedMargin === "boolean";
}

function isFt900Row(row: unknown): row is Ft900StudyRow {
  if (!exact(row, [...studyKeys, "fxOnlyBrier", "coinBrier", "exportCoefficientSign"]) || !validMetrics(row) ||
      row.family !== FT900_RESEARCH.family || row.instrument !== "DIA" || !brier(row.fxOnlyBrier) || row.coinBrier !== 0.25 ||
      !brier(row.modelBrier) || !brier(row.baseRateBrier) ||
      (row.exportCoefficientSign !== "positive" && row.exportCoefficientSign !== "negative" && row.exportCoefficientSign !== "zero")) return false;
  // Private staging uses full precision. A gap within 0.0001 of the boundary can round either way.
  const edge = Math.round(10000 * (Math.min(row.fxOnlyBrier, row.baseRateBrier, row.coinBrier) - row.modelBrier));
  if (row.clearedMargin) return row.exportCoefficientSign === "positive" && edge >= 100;
  return row.exportCoefficientSign !== "positive" || edge <= 100;
}

export function researchStudyFor(row: KibotResearch["studies"][number]) {
  if ("studyId" in row) return SPY_CLOSE_LOCATION_RESEARCH;
  if (row.family === FT900_RESEARCH.family) return FT900_RESEARCH;
  return KIBOT_LEGACY_RESEARCH_STUDIES.find(study => study.family === row.family)!;
}

function isSpyCloseLocationRow(row: unknown): row is SpyCloseLocationStudyRow {
  if (!exact(row, [...studyKeys, "studyId", "returnOnlyBrier", "coinBrier"]) || !validMetrics(row) ||
      row.studyId !== SPY_CLOSE_LOCATION_RESEARCH.id || row.family !== SPY_CLOSE_LOCATION_RESEARCH.family ||
      row.instrument !== "SPY" || !brier(row.returnOnlyBrier) || row.coinBrier !== 0.25 || !brier(row.baseRateBrier) ||
      !brier(row.modelBrier)) return false;
  // Staging additionally checks the unrounded errors and positive-coefficient requirement.
  const edge = Math.round(10000 * (Math.min(row.returnOnlyBrier, row.baseRateBrier, row.coinBrier) - row.modelBrier));
  return !row.clearedMargin || edge >= 100;
}

/** Only aggregate counts and rounded research errors are public. */
export function validateKibotResearch(value: unknown, firstEdition: HistoryEntry | undefined): asserts value is KibotResearch {
  const fail = (): never => { throw new Error("Kibot research report is outside its reviewed aggregate schema"); };
  if (!exact(value, ["schemaVersion", "source", "firstEdition", "through", "daily", "studies"]) ||
      ![1, 2, 3, 4].includes(value.schemaVersion as number) || value.source !== KIBOT_RESEARCH_LICENSE ||
      !firstEdition || value.firstEdition !== firstEdition.id ||
      typeof value.through !== "string" || publicDate(value.through) !== value.through ||
      !hasReviewedCalendar(value.through) || !exchangeSession(value.through) || value.through < newYorkDate(firstEdition.issuedAt) ||
      !Array.isArray(value.daily) || value.daily.length !== KIBOT_RESEARCH_SYMBOLS.length ||
      !Array.isArray(value.studies))
    return fail();

  const legacyCount = KIBOT_LEGACY_RESEARCH_STUDIES.reduce((sum, study) => sum + study.size, 0);
  const hasFt900 = value.schemaVersion === 3 || value.schemaVersion === 4;
  const hasCloseLocation = value.schemaVersion === 4;
  if (value.studies.length !== legacyCount + Number(hasFt900) + Number(hasCloseLocation) ||
      (hasFt900 && !isFt900Row(value.studies[legacyCount])) ||
      (hasCloseLocation && !isSpyCloseLocationRow(value.studies[legacyCount + 1]))) return fail();
  const dailyKeys = ["instrument", "sessions", "calls"];
  if (value.schemaVersion !== 1) dailyKeys.push("eligibleSessions");
  for (const [index, row] of value.daily.entries()) {
    if (!exact(row, dailyKeys) || row.instrument !== KIBOT_RESEARCH_SYMBOLS[index] ||
        !count(row.sessions) || !count(row.calls) || row.calls > row.sessions) return fail();
    if (value.schemaVersion !== 1 && (!count(row.eligibleSessions) || row.eligibleSessions > row.sessions)) return fail();
  }
  let offset = 0;
  for (const study of KIBOT_LEGACY_RESEARCH_STUDIES) {
    const symbols = study.family === "rates" ? ["TLT"] : KIBOT_RESEARCH_SYMBOLS.slice(0, study.size);
    const rows = hasFt900 ? value.studies.slice(offset, offset + symbols.length) : value.studies.filter(row => row?.family === study.family);
    if (rows.length !== symbols.length) return fail();
    for (const [index, row] of rows.entries()) {
      if (!exact(row, studyKeys) || !validMetrics(row) || row.family !== study.family || row.instrument !== symbols[index] ||
          !brier(row.modelBrier) || !brier(row.baseRateBrier) || typeof row.clearedMargin !== "boolean" ||
          (row.clearedMargin && Number((row.modelBrier + 0.01).toFixed(4)) > Math.min(0.25, row.baseRateBrier))) return fail();
    }
    offset += symbols.length;
  }
}
