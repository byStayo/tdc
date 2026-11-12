import { FAMILIES } from "./registry.ts";
import { HORIZONS, INSTRUMENTS } from "./types.ts";

export const MARKETPARQUET_AGGREGATE_FILE = "marketparquet-validation.json";
export const MARKETPARQUET_SOURCE = "https://marketparquet.com/data/etfs";

const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const day = (value: unknown): value is string => typeof value === "string" &&
  /^\d{4}-\d\d-\d\d$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
const score = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * The public file is an exact allowlist of cohort and family totals. Any
 * other key fails, so price rows, single-outcome returns, training features
 * and model weights cannot enter it through a later change.
 */
export function validateMarketParquetAggregate(report: unknown, editions: Iterable<string>): void {
  const fail = (): never => { throw new Error("MarketParquet public aggregate is outside its reviewed schema"); };
  if (!exact(report, ["schemaVersion", "source", "engineVersion", "edition", "through", "scoringPolicy",
    "minimumTestLabels", "missingCompletedSessions", "multiSessionReviewedThrough", "cohorts", "families"])) return fail();
  const symbols = INSTRUMENTS.filter(symbol => symbol !== "MARKET");
  const { cohorts, families } = report;
  if (report.schemaVersion !== 1 || report.source !== MARKETPARQUET_SOURCE ||
      typeof report.engineVersion !== "string" || !/^consensus-rules-\d+\.\d+\.\d+$/.test(report.engineVersion) ||
      typeof report.edition !== "string" || !new Set(editions).has(report.edition) ||
      !day(report.through) || !day(report.multiSessionReviewedThrough) ||
      typeof report.scoringPolicy !== "string" || !/^[a-z0-9-]{1,80}$/.test(report.scoringPolicy) ||
      !count(report.minimumTestLabels) || !count(report.missingCompletedSessions) ||
      !Array.isArray(cohorts) || cohorts.length !== symbols.length * HORIZONS.length ||
      !Array.isArray(families) || families.length !== FAMILIES.length) return fail();
  for (const [index, cohort] of cohorts.entries()) {
    if (!exact(cohort, ["instrument", "horizon", "resolved", "calls", "abstentions", "minimumSamples", "eligibility", "holdout"]) ||
        cohort.instrument !== symbols[Math.floor(index / HORIZONS.length)] ||
        cohort.horizon !== HORIZONS[index % HORIZONS.length] ||
        ![cohort.resolved, cohort.calls, cohort.abstentions, cohort.minimumSamples].every(count) ||
        (cohort.calls as number) + (cohort.abstentions as number) !== cohort.resolved ||
        !["insufficient_data", "ready"].includes(cohort.eligibility as string)) return fail();
    const { holdout } = cohort;
    if (holdout !== null && (!exact(holdout, ["testLabels", "candidateBrier", "baseRateBrier", "coinBrier", "passed"]) ||
        !count(holdout.testLabels) || holdout.testLabels < (report.minimumTestLabels as number) ||
        ![holdout.candidateBrier, holdout.baseRateBrier, holdout.coinBrier].every(score) ||
        typeof holdout.passed !== "boolean")) return fail();
  }
  for (const [index, family] of families.entries())
    if (!exact(family, ["family", "pairedVotes", "pairedObservations"]) || family.family !== FAMILIES[index].id ||
        !count(family.pairedVotes) || !count(family.pairedObservations)) return fail();
}
