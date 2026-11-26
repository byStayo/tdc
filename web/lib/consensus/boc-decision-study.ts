export const BOC_DECISION_RESEARCH = {
  id: "prelaunch-tlt-canadian-policy-change-v1-bank-effective-register",
  family: "international",
  instrument: "TLT",
  samples: 139,
  expectedSign: "positive",
  timingBasis: "dated-release",
  label: "Canadian rate decisions and long U.S. Treasuries",
  controlLabel: "Prior Canadian and U.S. policy-rate changes",
  source: "https://www.bankofcanada.ca/rates/interest-rates/key-interest-rates/",
  usControl: "https://www.federalreserve.gov/monetarypolicy/openmarket.htm",
  rights: "https://www.bankofcanada.ca/terms/",
} as const;

export type BocDecisionStudyRow = {
  studyId: typeof BOC_DECISION_RESEARCH.id;
  family: typeof BOC_DECISION_RESEARCH.family;
  instrument: typeof BOC_DECISION_RESEARCH.instrument;
  timingBasis: typeof BOC_DECISION_RESEARCH.timingBasis;
  samples: number;
  testSamples: number;
  modelBrier: number;
  controlBrier: number;
  baseRateBrier: number;
  coinBrier: number;
  coefficientSign: "positive";
  controlImprovement95: [number, number];
  scheduledDecisions: number;
  dailyHistoryEligible: number;
  excludedOverlap: number;
  testRateChanges: number;
  clearedMargin: boolean;
};

const scalarFields = {
  studyId: BOC_DECISION_RESEARCH.id,
  family: BOC_DECISION_RESEARCH.family,
  instrument: BOC_DECISION_RESEARCH.instrument,
  timingBasis: BOC_DECISION_RESEARCH.timingBasis,
  samples: BOC_DECISION_RESEARCH.samples,
  testSamples: 28,
  modelBrier: 0.2408,
  controlBrier: 0.2440,
  baseRateBrier: 0.2452,
  coinBrier: 0.25,
  coefficientSign: "positive",
  scheduledDecisions: 152,
  dailyHistoryEligible: 88,
  excludedOverlap: 13,
  testRateChanges: 4,
  clearedMargin: false,
} as const;

/** Only the exact permitted and independently replayed rounded release can leave private storage. */
export function isBocDecisionStudyRow(value: unknown): value is BocDecisionStudyRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== Object.keys(scalarFields).length + 1) return false;
  if (!Object.entries(scalarFields).every(([key, expected]) =>
    Object.hasOwn(candidate, key) && candidate[key] === expected)) return false;
  const interval = candidate.controlImprovement95;
  return Array.isArray(interval) && interval.length === 2 &&
    interval[0] === -0.0111 && interval[1] === 0.0210;
}
