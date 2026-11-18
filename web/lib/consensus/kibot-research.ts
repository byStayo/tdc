import { publicDate } from "../public-normalization.ts";
import { exchangeSession, hasReviewedCalendar } from "./exchange-calendar.ts";
import { newYorkDate } from "./time.ts";
import { INSTRUMENTS } from "./types.ts";
import type { HistoryEntry } from "./types.ts";

export const KIBOT_RESEARCH_FILE = "kibot-research.json";
export const KIBOT_RESEARCH_LICENSE = "https://www.kibot.com/license.html";
export const KIBOT_RESEARCH_SYMBOLS = INSTRUMENTS.filter(symbol => symbol !== "MARKET");

export const KIBOT_RESEARCH_STUDIES = [
  { id: "prelaunch-family-screen-v1", family: "technicals", label: "Price trend and momentum", size: 5 },
  { id: "prelaunch-family-screen-v1", family: "institutions", label: "CFTC positioning", size: 5 },
  { id: "prelaunch-scheduled-events-v1", family: "events", label: "FOMC dates and options expiries", size: 5 },
  { id: "prelaunch-gdelt-news-v1", family: "news", label: "GDELT finance-news tone", size: 4 },
  { id: "prelaunch-tlt-auction-demand-v1", family: "rates", label: "Treasury auction demand", size: 1 },
] as const;

type Symbol = typeof KIBOT_RESEARCH_SYMBOLS[number];
export interface KibotResearch {
  schemaVersion: 1;
  source: typeof KIBOT_RESEARCH_LICENSE;
  firstEdition: string;
  through: string;
  daily: { instrument: Symbol; sessions: number; calls: number }[];
  studies: {
    family: typeof KIBOT_RESEARCH_STUDIES[number]["family"];
    instrument: Symbol;
    samples: number;
    testSamples: number;
    modelBrier: number;
    baseRateBrier: number;
    clearedMargin: boolean;
  }[];
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const brier = (value: unknown): value is number =>
  typeof value === "number" && value >= 0 && value <= 1 && Number(value.toFixed(4)) === value;

/** Only aggregate counts and rounded research errors are public. */
export function validateKibotResearch(value: unknown, firstEdition: HistoryEntry | undefined): asserts value is KibotResearch {
  const fail = (): never => { throw new Error("Kibot research report is outside its reviewed aggregate schema"); };
  if (!exact(value, ["schemaVersion", "source", "firstEdition", "through", "daily", "studies"]) ||
      value.schemaVersion !== 1 || value.source !== KIBOT_RESEARCH_LICENSE ||
      !firstEdition || value.firstEdition !== firstEdition.id ||
      typeof value.through !== "string" || publicDate(value.through) !== value.through ||
      !hasReviewedCalendar(value.through) || !exchangeSession(value.through) || value.through < newYorkDate(firstEdition.issuedAt) ||
      !Array.isArray(value.daily) || value.daily.length !== KIBOT_RESEARCH_SYMBOLS.length ||
      !Array.isArray(value.studies) || value.studies.length !== KIBOT_RESEARCH_STUDIES.reduce((sum, study) => sum + study.size, 0))
    return fail();

  for (const [index, row] of value.daily.entries()) {
    if (!exact(row, ["instrument", "sessions", "calls"]) || row.instrument !== KIBOT_RESEARCH_SYMBOLS[index] ||
        !count(row.sessions) || !count(row.calls) || row.calls > row.sessions) return fail();
  }
  for (const study of KIBOT_RESEARCH_STUDIES) {
    const symbols = study.family === "rates" ? ["TLT"] : KIBOT_RESEARCH_SYMBOLS.slice(0, study.size);
    const rows = value.studies.filter(row => row?.family === study.family);
    if (rows.length !== symbols.length) return fail();
    for (const [index, row] of rows.entries()) {
      if (!exact(row, ["family", "instrument", "samples", "testSamples", "modelBrier", "baseRateBrier", "clearedMargin"]) ||
          row.instrument !== symbols[index] || !count(row.samples) || !count(row.testSamples) ||
          row.samples < 120 || row.testSamples < 20 || row.testSamples >= row.samples ||
          !brier(row.modelBrier) || !brier(row.baseRateBrier) || typeof row.clearedMargin !== "boolean" ||
          (row.clearedMargin && Number((row.modelBrier + 0.01).toFixed(4)) > Math.min(0.25, row.baseRateBrier))) return fail();
    }
  }
}
