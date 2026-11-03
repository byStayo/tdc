import { publicDate } from "../public-normalization.ts";
import { newYorkTimestamp } from "./time.ts";

/** Independently reviewed exchange facts, not dates inferred from price rows. */
export const EXCHANGE_CALENDAR = {
  id: "us-equities-core-2026-reviewed-2026-11-03-v1",
  from: "2026-01-01", through: "2026-12-31", reviewedOn: "2026-11-03",
  sources: ["https://www.nyse.com/trade/hours-calendars", "https://www.nasdaq.com/market-activity/stock-market-holiday-schedule"],
  note: "NYSE and Nasdaq scheduled core equity sessions only. Exceptional closures require a separately reviewed revision. Other years fail closed.",
} as const;
const CLOSED = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
]);
const EARLY = new Set(["2026-11-27", "2026-12-24"]);

export function exchangeSession(day: string): { session: string; openAt: string; closeAt: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || publicDate(day) !== day || day < EXCHANGE_CALENDAR.from || day > EXCHANGE_CALENDAR.through)
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

export function verifyExpectedSessions(sessions: string[]): void {
  if (!sessions.length || JSON.stringify(sessions) !== JSON.stringify(exchangeSessions(sessions[0], sessions.at(-1)!)))
    throw new Error("Exchange calendar differs from the independent reviewed schedule");
}
