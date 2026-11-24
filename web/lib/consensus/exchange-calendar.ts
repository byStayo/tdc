import { publicDate } from "../public-normalization.ts";
import { newYorkTimestamp } from "./time.ts";

/** Original 2026 evidence. Keep this identifier and scope stable for saved outcomes. */
export const EXCHANGE_CALENDAR = {
  id: "us-equities-core-2026-reviewed-2026-11-03-v1",
  from: "2026-01-01", through: "2026-12-31", reviewedOn: "2026-11-03",
  sources: ["https://www.nyse.com/trade/hours-calendars", "https://www.nasdaq.com/market-activity/stock-market-holiday-schedule"],
  note: "NYSE and Nasdaq scheduled core equity sessions only. Exceptional closures require a separately reviewed revision. Other years fail closed.",
} as const;

const EXCHANGE_CALENDAR_2027 = {
  id: "us-equities-core-2027-through-thanksgiving-reviewed-2026-11-18-v1",
  from: "2027-01-01", through: "2027-11-25", reviewedOn: "2026-11-18",
  sources: [
    "https://www.nyse.com/trade/hours-calendars",
    "https://www.cboe.com/us/equities/holidays/csv/",
    "https://listingcenter.nasdaq.com/rulebook/nasdaq/rules/nasdaq-general-3",
    "https://listingcenter.nasdaq.com/assets/RuleBook/Nasdaq/rules/Nasdaq%20Equity%201.html",
  ],
  note: "NYSE and Cboe publish dated closures. Nasdaq General 3 Rule 1030 and Equity 1 set ordinary business days and core hours. November 26 requires a Nasdaq short-session notice.",
} as const;
// Nasdaq specifies its own special hours. Each segment ends before a date whose
// common core-market close remains unconfirmed. See docs/US_EQUITY_CALENDAR_REVIEW.md.
const ORDINARY_SEGMENTS = [
  { id: "us-equities-core-2027-late-ordinary-reviewed-2026-11-24-v1", from: "2027-11-27", through: "2027-12-30" },
  { id: "us-equities-core-2028-h1-ordinary-reviewed-2026-11-24-v1", from: "2028-01-01", through: "2028-07-02" },
  { id: "us-equities-core-2028-summer-fall-reviewed-2026-11-24-v1", from: "2028-07-04", through: "2028-11-23" },
  { id: "us-equities-core-2028-winter-reviewed-2026-11-24-v1", from: "2028-11-25", through: "2028-12-31" },
] as const;
const CALENDARS = [EXCHANGE_CALENDAR, EXCHANGE_CALENDAR_2027, ...ORDINARY_SEGMENTS] as const;
export const REVIEWED_EXCHANGE_THROUGH = ORDINARY_SEGMENTS[3].through;

const CLOSED = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19",
  "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
]);
const EARLY = new Set(["2026-11-27", "2026-12-24"]);

export function hasReviewedCalendar(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || publicDate(day) !== day)
    throw new Error("Exchange calendar date is invalid");
  return CALENDARS.some(calendar => day >= calendar.from && day <= calendar.through);
}

/** A scheduled date whose common listing-market status or exact hours are still unresolved. */
export function isUnresolvedExchangeDate(day: string): boolean {
  return !hasReviewedCalendar(day) && day >= EXCHANGE_CALENDAR.from && day <= REVIEWED_EXCHANGE_THROUGH;
}

// The two original versions cover adjacent years. Later versions are separated by real gaps.
const CONTIGUOUS = [
  { from: EXCHANGE_CALENDAR.from, through: EXCHANGE_CALENDAR_2027.through },
  ...ORDINARY_SEGMENTS,
] as const;

export function hasReviewedCalendarRange(from: string, through: string): boolean {
  return hasReviewedCalendar(from) && hasReviewedCalendar(through) && from <= through &&
    CONTIGUOUS.some(interval => interval.from <= from && through <= interval.through);
}

/** Record every reviewed calendar used by an outcome or capture window. */
export function exchangeCalendarVersion(from: string, through: string): string {
  if (!hasReviewedCalendarRange(from, through))
    throw new Error("Exchange calendar has no reviewed coverage for this range");
  return CALENDARS.filter(calendar => from <= calendar.through && through >= calendar.from)
    .map(calendar => calendar.id).join("+");
}

function scheduledWeekday(day: string) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !CLOSED.has(day);
}

interface SessionClock { session: string; openAt: string; closeAt: string }
const clocks = new Map<string, SessionClock>();
export function exchangeSession(day: string): SessionClock | null {
  if (!hasReviewedCalendar(day)) throw new Error("Exchange calendar has no reviewed coverage for this date");
  const cached = clocks.get(day);
  if (cached) return { ...cached };
  if (!scheduledWeekday(day)) return null;
  const compact = day.replaceAll("-", "");
  const clock = { session: day, openAt: newYorkTimestamp(`${compact}T093000`)!,
    closeAt: newYorkTimestamp(`${compact}T${EARLY.has(day) ? "130000" : "160000"}`)! };
  clocks.set(day, clock);
  return { ...clock };
}

export function exchangeSessions(from: string, through: string): string[] {
  if (from > through) throw new Error("Exchange calendar range is reversed");
  if (!hasReviewedCalendarRange(from, through)) throw new Error("Exchange calendar has no reviewed coverage for this range");
  const result: string[] = [];
  for (let at = Date.parse(from); at <= Date.parse(through); at += 86400000) {
    const day = new Date(at).toISOString().slice(0, 10);
    if (scheduledWeekday(day)) result.push(day);
  }
  return result;
}

/** Inventory only. A forecast, price or corporate-action window must still fit one contiguous interval. */
export function availableExchangeSessions(from: string, through: string): string[] {
  hasReviewedCalendar(from);
  hasReviewedCalendar(through);
  if (from > through) throw new Error("Exchange calendar range is reversed");
  return CONTIGUOUS.flatMap(interval => {
    const start = interval.from > from ? interval.from : from;
    const end = interval.through < through ? interval.through : through;
    return start <= end ? exchangeSessions(start, end) : [];
  });
}

/** Only recent consecutive sessions can support a trailing feature, previous-session check or new price capture. */
export function trailingExchangeSessions(from: string, through: string): string[] {
  hasReviewedCalendar(from);
  hasReviewedCalendar(through);
  if (from > through) throw new Error("Exchange calendar range is reversed");
  const interval = CONTIGUOUS.find(row => row.from <= through && through <= row.through);
  return interval ? exchangeSessions(from < interval.from ? interval.from : from, through) : [];
}

export function verifyExpectedSessions(sessions: string[], { separateIntervals = false } = {}): string[] {
  if (!sessions.length || sessions.some((day, i) => { hasReviewedCalendar(day); return i > 0 && day <= sessions[i - 1]; }))
    throw new Error("Exchange calendar must be ordered and unique");
  const from = sessions[0] < EXCHANGE_CALENDAR.from ? EXCHANGE_CALENDAR.from : sessions[0];
  const through = sessions.at(-1)! > REVIEWED_EXCHANGE_THROUGH ? REVIEWED_EXCHANGE_THROUGH : sessions.at(-1)!;
  const reviewed = sessions.filter(hasReviewedCalendar);
  if (!separateIntervals && (sessions.some(isUnresolvedExchangeDate) ||
      (reviewed.length && !hasReviewedCalendarRange(reviewed[0], reviewed.at(-1)!))))
    throw new Error("Exchange calendar has no contiguous reviewed coverage for this range");
  if (from <= through && JSON.stringify(reviewed) !== JSON.stringify(availableExchangeSessions(from, through)))
    throw new Error("Exchange calendar differs from the independent reviewed schedule");
  return reviewed;
}
