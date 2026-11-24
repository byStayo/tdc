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
const CALENDARS = [EXCHANGE_CALENDAR, EXCHANGE_CALENDAR_2027] as const;
export const REVIEWED_EXCHANGE_THROUGH = EXCHANGE_CALENDAR_2027.through;

const CLOSED = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25",
]);
const EARLY = new Set(["2026-11-27", "2026-12-24"]);

export function hasReviewedCalendar(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || publicDate(day) !== day)
    throw new Error("Exchange calendar date is invalid");
  return CALENDARS.some(calendar => day >= calendar.from && day <= calendar.through);
}

/** Record every reviewed calendar used by an outcome or capture window. */
export function exchangeCalendarVersion(from: string, through: string): string {
  if (!hasReviewedCalendar(from) || !hasReviewedCalendar(through) || from > through)
    throw new Error("Exchange calendar has no reviewed coverage for this range");
  return CALENDARS.filter(calendar => from <= calendar.through && through >= calendar.from)
    .map(calendar => calendar.id).join("+");
}

export function exchangeSession(day: string): { session: string; openAt: string; closeAt: string } | null {
  if (!hasReviewedCalendar(day))
    throw new Error("Exchange calendar has no reviewed coverage for this date");
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6 || CLOSED.has(day)) return null;
  const compact = day.replaceAll("-", "");
  return { session: day, openAt: newYorkTimestamp(`${compact}T093000`)!, closeAt: newYorkTimestamp(`${compact}T${EARLY.has(day) ? "130000" : "160000"}`)! };
}

export function exchangeSessions(from: string, through: string): string[] {
  exchangeSession(from);
  exchangeSession(through);
  if (from > through) throw new Error("Exchange calendar range is reversed");
  const result: string[] = [];
  for (let at = Date.parse(from); at <= Date.parse(through); at += 86400000) {
    const day = new Date(at).toISOString().slice(0, 10);
    if (exchangeSession(day)) result.push(day);
  }
  return result;
}

export function verifyExpectedSessions(sessions: string[]): string[] {
  if (!sessions.length || sessions.some((day, i) => { hasReviewedCalendar(day); return i > 0 && day <= sessions[i - 1]; }))
    throw new Error("Exchange calendar must be ordered and unique");
  const from = sessions[0] < EXCHANGE_CALENDAR.from ? EXCHANGE_CALENDAR.from : sessions[0];
  const through = sessions.at(-1)! > REVIEWED_EXCHANGE_THROUGH ? REVIEWED_EXCHANGE_THROUGH : sessions.at(-1)!;
  const reviewed = sessions.filter(hasReviewedCalendar);
  if (from <= through && JSON.stringify(reviewed) !== JSON.stringify(exchangeSessions(from, through)))
    throw new Error("Exchange calendar differs from the independent reviewed schedule");
  return reviewed;
}
