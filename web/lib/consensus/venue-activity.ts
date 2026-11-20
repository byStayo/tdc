import { publicDate } from "../public-normalization.ts";
import { newYorkDate } from "./time.ts";
import type { ReviewedSource } from "./reviewed.ts";

export interface VenueComparison {
  sourceId: string;
  current: number;
  previous: number;
}

/** Operator-reported quarterly figures. Individual ETF reports use an external reader. */
export interface VenueActivity {
  periodEnd: string;
  priorPeriodEnd: string;
  nasdaqTrfShare: VenueComparison;
  bidsTouchedMillions: VenueComparison;
}

function hasFields(value: unknown, fields: string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

export function validateVenueActivity(activity: VenueActivity | undefined, sources: ReviewedSource[]): void {
  if (activity === undefined) return;
  if (!hasFields(activity, ["periodEnd", "priorPeriodEnd", "nasdaqTrfShare", "bidsTouchedMillions"]))
    throw new Error("Invalid quarterly venue activity");
  const end = activity.periodEnd;
  if (typeof end !== "string" || !/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(end) ||
      publicDate(end) !== end || activity.priorPeriodEnd !== `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`)
    throw new Error("Venue comparisons require the same quarter one year apart");

  const specs = [
    { pair: activity.nasdaqTrfShare, cap: 100,
      document: new RegExp(`^https://www\\.sec\\.gov/Archives/edgar/data/1120193/\\d{18}/ndaq-${end.replaceAll("-", "")}\\.htm$`) },
    { pair: activity.bidsTouchedMillions, cap: Infinity,
      document: /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/1374310\/\d{18}\/cboe-\d{8}xex991\.htm$/ },
  ];
  for (const { pair, cap, document } of specs) {
    if (!hasFields(pair, ["sourceId", "current", "previous"]))
      throw new Error("Invalid venue comparison fields");
    const filing = sources.find(source => source.id === pair.sourceId);
    if (!filing || !document.test(filing.url))
      throw new Error("Venue activity requires its dated operator filing");
    const filingDay = filing.publishedAt.length === 10 ? filing.publishedAt : newYorkDate(filing.publishedAt);
    const lagDays = (Date.parse(filingDay) - Date.parse(end)) / 86_400_000;
    if (!Number.isFinite(lagDays) || lagDays < 0 || lagDays > 92)
      throw new Error("Venue filing falls outside the quarter's reporting window");
    if (pair === activity.bidsTouchedMillions && !filing.url.endsWith(`/cboe-${filingDay.replaceAll("-", "")}xex991.htm`))
      throw new Error("BIDS venue activity requires the exhibit dated for this filing");
    if (![pair.current, pair.previous].every(value => Number.isFinite(value) && value >= 0 && value <= cap))
      throw new Error("Invalid venue activity measure");
  }
}
