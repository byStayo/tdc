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
export const FOMC_EVE_RESEARCH = {
  id: "prelaunch-spy-fomc-eve-2016-2025-v1", family: "events", label: "Session before a scheduled Fed decision",
  schedule: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20240809a.htm",
  paper: "https://www.newyorkfed.org/research/staff_reports/sr512.html",
} as const;
export const QQQ_ISSUER_GUIDANCE_RESEARCH = {
  id: "prelaunch-qqq-original-revenue-guidance-v1", family: "earnings", label: "Revenue surprise against management guidance",
  sec: "https://www.sec.gov/search-filings/edgar-application-programming-interfaces",
  timing: "https://www.sec.gov/submit-filings/filer-support-resources/how-do-i-guides/determine-status-my-filing",
} as const;
export const TIC_TREASURY_RESEARCH = {
  id: "prelaunch-tlt-tic-treasury-demand-v1", family: "capital", instrument: "TLT",
  label: "Foreign purchases of U.S. Treasury bonds and notes", controlLabel: "Other long-term securities and reporting regime",
  samples: 126, expectedSign: "positive", timingBasis: "dated-release",
  source: "https://home.treasury.gov/data/treasury-international-capital-tic-system/release-dates-of-tic-data",
} as const;
export const SWVXX_FLOW_RESEARCH = {
  id: "prelaunch-spy-swvxx-retail-prime-flow-v1", family: "retail", instrument: "SPY",
  label: "Schwab retail money fund subscriptions and redemptions", controlLabel: "Seven-day fund yield",
  samples: 120, expectedSign: "negative", timingBasis: "dated-release",
  source: "https://www.sec.gov/data-research/sec-markets-data/dera-form-n-mfp-data-sets",
} as const;
export const VX_CURVE_RESEARCH = {
  id: "SPY-prior-CFE-VX-monthly-front-second-v1", family: "options", instrument: "SPY",
  label: "First and second monthly VIX futures", controlLabel: "Second monthly VIX future",
  samples: 247, expectedSign: "negative", timingBasis: "historical-reconstruction",
  source: "https://getmarkethistory.com/docs/guides/vix-historical-data/",
} as const;
export const BLS_PAYROLL_RESEARCH = {
  id: "prelaunch-tlt-original-bls-payroll-revisions-v1", family: "news", instrument: "TLT",
  label: "Revisions to the previous two months’ U.S. payrolls", controlLabel: "Newly reported payroll change only",
  samples: 134, expectedSign: "negative", timingBasis: "dated-release",
  source: "https://www.bls.gov/bls/news-release/empsit.htm",
} as const;
export const OFR_VOLATILITY_RESEARCH = {
  id: "ofr-volatility-contribution-prelaunch-v1-time-attested-four-decimal", family: "macro", instrument: "SPY",
  label: "Volatility’s contribution to global financial stress", controlLabel: "Change in the rest of the stress index",
  samples: 125, expectedSign: "positive", timingBasis: "archived-before-cutoff",
  source: "https://www.financialresearch.gov/financial-stress-index/",
  archive: "https://www.loc.gov/item/lcwaN0017866/",
  mirror: "https://github.com/oid87/PersonalFiance",
} as const;
export const OFR_GEOGRAPHIC_RESEARCH = {
  id: "prelaunch-ofr-international-stress-dia-v1-witnessed-maturity", family: "international", instrument: "DIA",
  label: "Financial stress outside the U.S.", controlLabel: "U.S. financial stress alone",
  samples: 147, expectedSign: "positive", timingBasis: "archived-before-cutoff",
  source: "https://www.financialresearch.gov/financial-stress-index/regions/",
  archive: "https://www.loc.gov/item/lcwaN0017866/",
} as const;
export const IEM_ELECTION_RESEARCH = {
  id: "prelaunch-iem-popular-vote-certainty-spy-v1", family: "events", instrument: "SPY",
  label: "Certainty about the U.S. presidential popular vote", controlLabel: "Expected vote-share margin alone",
  samples: 214, testSamples: 32, expectedSign: "positive", timingBasis: "historical-reconstruction",
  olderData: "https://doi.org/10.7910/DVN/MHUC8C", recentData: "https://doi.org/10.7910/DVN/C09NG6",
} as const;
export const G17_MANUFACTURING_RESEARCH = {
  id: "original-g17-manufacturing-dia-prelaunch-v1", family: "news", instrument: "DIA",
  label: "U.S. manufacturing output", controlLabel: "Total industrial production alone",
  samples: 125, expectedSign: "positive", timingBasis: "dated-release",
  source: "https://www.federalreserve.gov/releases/g17/default.htm",
  vintages: "https://www.federalreserve.gov/releases/g17/revhist.htm",
} as const;
const versionSevenStudies = [TIC_TREASURY_RESEARCH, SWVXX_FLOW_RESEARCH, VX_CURVE_RESEARCH] as const;
const versionEightStudies = [...versionSevenStudies, BLS_PAYROLL_RESEARCH, OFR_VOLATILITY_RESEARCH] as const;
const versionNineStudies = [...versionEightStudies, OFR_GEOGRAPHIC_RESEARCH] as const;
const versionTenStudies = [...versionNineStudies, IEM_ELECTION_RESEARCH] as const;
export const KIBOT_DATED_RESEARCH = [...versionTenStudies, G17_MANUFACTURING_RESEARCH] as const;
export const KIBOT_RESEARCH_STUDIES = [
  ...KIBOT_LEGACY_RESEARCH_STUDIES, FT900_RESEARCH, SPY_CLOSE_LOCATION_RESEARCH, FOMC_EVE_RESEARCH, QQQ_ISSUER_GUIDANCE_RESEARCH, ...KIBOT_DATED_RESEARCH,
] as const;

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
export type FomcEveStudyRow = StudyMetrics & {
  studyId: typeof FOMC_EVE_RESEARCH.id; family: "events"; instrument: "SPY"; testEves: number;
  returnOnlyBrier: number; coinBrier: number; eveCoefficientSign: "positive" | "negative" | "zero";
};
export type QqqIssuerGuidanceRow = StudyMetrics & {
  studyId: typeof QQQ_ISSUER_GUIDANCE_RESEARCH.id; family: "earnings"; instrument: "QQQ";
  ageOnlyBrier: number; coinBrier: number; earningsCoefficientSign: "positive" | "negative" | "zero";
  controlImprovement95: [number, number];
};
type StudyIdentity<T extends typeof KIBOT_DATED_RESEARCH[number]> = { studyId: T["id"]; family: T["family"]; instrument: T["instrument"] };
export type DatedStudyRow = StudyMetrics & { controlBrier: number; coinBrier: number; coefficientSign: "positive" | "negative" | "zero" } & (
  (StudyIdentity<typeof TIC_TREASURY_RESEARCH> & { timingBasis: "dated-release" }) |
  (StudyIdentity<typeof SWVXX_FLOW_RESEARCH> & { timingBasis: "dated-release"; controlImprovement95: [number, number] }) |
  (StudyIdentity<typeof BLS_PAYROLL_RESEARCH> & { timingBasis: "dated-release"; controlImprovement95: [number, number] }) |
  (StudyIdentity<typeof VX_CURVE_RESEARCH> & { timingBasis: "historical-reconstruction"; strictBeforeCutoff: number }) |
  (StudyIdentity<typeof OFR_VOLATILITY_RESEARCH> & { timingBasis: "archived-before-cutoff"; sourceBasis: "originals-and-four-decimal-mirror";
    nativeOnlySamples: number; nativeSamples: number; mirrorSamples: number; controlImprovement95: [number, number] }) |
  (StudyIdentity<typeof OFR_GEOGRAPHIC_RESEARCH> & { timingBasis: "archived-before-cutoff"; nativeSamples: number;
    mirrorSamples: number; deferredNativeSamples: number; controlImprovement95: [number, number]; adjustedControlP: number;
    comparisonCount: number }) |
  (StudyIdentity<typeof IEM_ELECTION_RESEARCH> & { timingBasis: "historical-reconstruction";
    trainSamples: number; validationSamples: number; test2020Samples: number; test2024Samples: number;
    controlImprovement95: [number, number]; campaignControlP: number; comparisonCount: number; adjustedControlP: number }) |
  (StudyIdentity<typeof G17_MANUFACTURING_RESEARCH> & { timingBasis: "dated-release"; monthlyReleases: number;
    multiplePreliminaryMonths: number; unconfirmedClocks: number; priorTechnicalSamples: number;
    priorTechnicalTestSamples: number; controlImprovement95: [number, number] })
);
type LegacyStudyRow = StudyMetrics & {
  family: typeof KIBOT_LEGACY_RESEARCH_STUDIES[number]["family"]; instrument: Symbol;
};

export interface KibotResearch {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  source: typeof KIBOT_RESEARCH_LICENSE;
  firstEdition: string;
  through: string;
  daily: { instrument: Symbol; sessions: number; calls: number; eligibleSessions?: number }[];
  studies: (LegacyStudyRow | Ft900StudyRow | SpyCloseLocationStudyRow | FomcEveStudyRow | QqqIssuerGuidanceRow | DatedStudyRow)[];
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
  if ("studyId" in row) return KIBOT_RESEARCH_STUDIES.find(study => study.id === row.studyId)!;
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

function isFomcEveRow(row: unknown): row is FomcEveStudyRow {
  if (!exact(row, [...studyKeys, "studyId", "returnOnlyBrier", "coinBrier", "eveCoefficientSign", "testEves"]) ||
      !validMetrics(row) || row.studyId !== FOMC_EVE_RESEARCH.id || row.family !== FOMC_EVE_RESEARCH.family ||
      row.instrument !== "SPY" || !count(row.samples) || row.samples > 160 || row.samples % 2 !== 0 || !count(row.testEves) ||
      !count(row.testSamples) || row.testSamples !== row.samples - Math.floor(row.samples * 0.8) ||
      row.testEves !== Math.ceil(row.testSamples / 2) || row.coinBrier !== 0.25 ||
      !brier(row.modelBrier) || !brier(row.baseRateBrier) || !brier(row.returnOnlyBrier) ||
      (row.eveCoefficientSign !== "positive" && row.eveCoefficientSign !== "negative" && row.eveCoefficientSign !== "zero")) return false;
  const edge = Math.round(10000 * (Math.min(row.returnOnlyBrier, row.baseRateBrier, row.coinBrier) - row.modelBrier));
  return row.clearedMargin ? row.eveCoefficientSign === "positive" && edge >= 100 : row.eveCoefficientSign !== "positive" || edge <= 100;
}

function isQqqIssuerGuidanceRow(row: unknown): row is QqqIssuerGuidanceRow {
  if (!exact(row, [...studyKeys, "studyId", "ageOnlyBrier", "coinBrier", "earningsCoefficientSign", "controlImprovement95"]) ||
      !validMetrics(row) || row.studyId !== QQQ_ISSUER_GUIDANCE_RESEARCH.id || row.family !== "earnings" || row.instrument !== "QQQ" ||
      !count(row.samples) || row.samples > 124 || row.testSamples !== row.samples - Math.floor(row.samples * 0.8) ||
      !brier(row.modelBrier) || !brier(row.baseRateBrier) || !brier(row.ageOnlyBrier) || row.coinBrier !== 0.25 ||
      (row.earningsCoefficientSign !== "positive" && row.earningsCoefficientSign !== "negative" && row.earningsCoefficientSign !== "zero"))
    return false;
  const interval = row.controlImprovement95;
  if (!Array.isArray(interval) || interval.length !== 2 || !interval.every(value => typeof value === "number" && brier(Math.abs(value))) ||
      interval[0] > interval[1]) return false;
  // The interval is descriptive. The registered decision uses the sign and all three unrounded comparisons.
  const edge = Math.round(10000 * (Math.min(row.ageOnlyBrier, row.baseRateBrier, row.coinBrier) - row.modelBrier));
  return row.clearedMargin ? row.earningsCoefficientSign === "positive" && edge >= 100 : row.earningsCoefficientSign !== "positive" || edge <= 100;
}

function isDatedStudyRow(row: unknown, study: typeof KIBOT_DATED_RESEARCH[number]): row is DatedStudyRow {
  const keys = [...studyKeys, "studyId", "controlBrier", "coinBrier", "coefficientSign", "timingBasis"];
  const hasInterval = study === SWVXX_FLOW_RESEARCH || study === BLS_PAYROLL_RESEARCH ||
    study === OFR_VOLATILITY_RESEARCH || study === OFR_GEOGRAPHIC_RESEARCH || study === IEM_ELECTION_RESEARCH ||
    study === G17_MANUFACTURING_RESEARCH;
  if (hasInterval) keys.push("controlImprovement95");
  if (study === VX_CURVE_RESEARCH) keys.push("strictBeforeCutoff");
  if (study === OFR_VOLATILITY_RESEARCH) keys.push("sourceBasis", "nativeOnlySamples", "nativeSamples", "mirrorSamples");
  if (study === OFR_GEOGRAPHIC_RESEARCH) keys.push("nativeSamples", "mirrorSamples", "deferredNativeSamples", "adjustedControlP", "comparisonCount");
  if (study === G17_MANUFACTURING_RESEARCH)
    keys.push("monthlyReleases", "multiplePreliminaryMonths", "unconfirmedClocks", "priorTechnicalSamples", "priorTechnicalTestSamples");
  if (study === IEM_ELECTION_RESEARCH)
    keys.push("trainSamples", "validationSamples", "test2020Samples", "test2024Samples", "campaignControlP", "comparisonCount", "adjustedControlP");
  if (!exact(row, keys) || !validMetrics(row) || row.studyId !== study.id || row.family !== study.family ||
      row.instrument !== study.instrument || !brier(row.modelBrier) || !brier(row.baseRateBrier) ||
      !brier(row.controlBrier) || row.coinBrier !== 0.25 || !["positive", "negative", "zero"].some(sign => sign === row.coefficientSign))
    return false;
  const samples = study.samples;
  const testSamples = study === IEM_ELECTION_RESEARCH ? study.testSamples : samples - Math.floor(samples * 0.8);
  if (row.samples !== samples || row.testSamples !== testSamples || row.timingBasis !== study.timingBasis) return false;
  if (study === IEM_ELECTION_RESEARCH && (row.trainSamples !== 131 || row.validationSamples !== 51 ||
      row.test2020Samples !== 24 || row.test2024Samples !== 8 || row.comparisonCount !== 384 ||
      !brier(row.campaignControlP) || ![0.25, 0.5, 0.75, 1].includes(row.campaignControlP) || row.adjustedControlP !== 1)) return false;
  if (study === G17_MANUFACTURING_RESEARCH && (row.monthlyReleases !== 129 || row.multiplePreliminaryMonths !== 1 ||
      row.unconfirmedClocks !== 3 || row.priorTechnicalSamples !== 43 || row.priorTechnicalTestSamples !== 19)) return false;
  if (study === VX_CURVE_RESEARCH && row.strictBeforeCutoff !== 4) return false;
  if (study === OFR_VOLATILITY_RESEARCH && (row.sourceBasis !== "originals-and-four-decimal-mirror" ||
      row.nativeOnlySamples !== 76 || row.nativeSamples !== 70 || row.mirrorSamples !== 55)) return false;
  if (study === OFR_GEOGRAPHIC_RESEARCH && (row.nativeSamples !== 110 || row.mirrorSamples !== 37 ||
      row.deferredNativeSamples !== 38 || row.comparisonCount !== 96 || !brier(row.adjustedControlP) ||
      row.adjustedControlP < Number((96 / 1024).toFixed(4)))) return false;
  let lowerBound: number | undefined;
  if (hasInterval) {
    const interval = row.controlImprovement95;
    if (!Array.isArray(interval) || interval.length !== 2 || !interval.every(v => typeof v === "number" && brier(Math.abs(v))) ||
        interval[0] > interval[1]) return false;
    lowerBound = interval[0];
  }
  const signMatches = row.coefficientSign === study.expectedSign;
  const edge = Math.round(10000 * (Math.min(row.controlBrier, row.baseRateBrier, row.coinBrier) - row.modelBrier));
  // Only the BLS study makes its interval a gate. Rounding a tiny positive or negative lower bound can yield zero.
  if (study === BLS_PAYROLL_RESEARCH && lowerBound !== undefined) {
    return row.clearedMargin ? signMatches && edge >= 100 && lowerBound >= 0 : !signMatches || edge <= 100 || lowerBound <= 0;
  }
  return row.clearedMargin ? signMatches && edge >= 100 : !signMatches || edge <= 100;
}

/** Only aggregate counts and rounded research errors are public. */
export function validateKibotResearch(value: unknown, firstEdition: HistoryEntry | undefined): asserts value is KibotResearch {
  const fail = (): never => { throw new Error("Kibot research report is outside its reviewed aggregate schema"); };
  if (!exact(value, ["schemaVersion", "source", "firstEdition", "through", "daily", "studies"]) ||
      ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(value.schemaVersion as number) || value.source !== KIBOT_RESEARCH_LICENSE ||
      !firstEdition || value.firstEdition !== firstEdition.id ||
      typeof value.through !== "string" || publicDate(value.through) !== value.through ||
      !hasReviewedCalendar(value.through) || !exchangeSession(value.through) || value.through < newYorkDate(firstEdition.issuedAt) ||
      !Array.isArray(value.daily) || value.daily.length !== KIBOT_RESEARCH_SYMBOLS.length ||
      !Array.isArray(value.studies))
    return fail();

  const legacyCount = KIBOT_LEGACY_RESEARCH_STUDIES.reduce((sum, study) => sum + study.size, 0);
  const hasFt900 = Number(value.schemaVersion) >= 3;
  const hasCloseLocation = Number(value.schemaVersion) >= 4;
  const hasFomcEve = Number(value.schemaVersion) >= 5;
  const hasIssuerGuidance = Number(value.schemaVersion) >= 6;
  const version = Number(value.schemaVersion);
  const newStudies = version === 11 ? KIBOT_DATED_RESEARCH : version === 10 ? versionTenStudies : version === 9 ? versionNineStudies : version === 8 ? versionEightStudies : version === 7 ? versionSevenStudies : [];
  const existing = legacyCount + Number(hasFt900) + Number(hasCloseLocation) + Number(hasFomcEve) + Number(hasIssuerGuidance);
  const studyRows = value.studies;
  if (studyRows.length !== existing + newStudies.length || newStudies.some((study, i) => !isDatedStudyRow(studyRows[existing + i], study)) ||
      (hasFt900 && !isFt900Row(value.studies[legacyCount])) ||
      (hasCloseLocation && !isSpyCloseLocationRow(value.studies[legacyCount + 1])) ||
      (hasFomcEve && !isFomcEveRow(value.studies[legacyCount + 2])) ||
      (hasIssuerGuidance && !isQqqIssuerGuidanceRow(value.studies[legacyCount + 3]))) return fail();
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
