import { publicDate } from "../public-normalization.ts";
import { exchangeSession, hasReviewedCalendar } from "./exchange-calendar.ts";
import { newYorkDate } from "./time.ts";

const millisPerDay = 86_400_000;
const fullDay = 390 * 60_000;

function nextDate(day: string) {
  return new Date(Date.parse(day) + millisPerDay).toISOString().slice(0, 10);
}

function firstFull(day: string) {
  for (let n = 0; n < 8; n++, day = nextDate(day)) {
    if (!hasReviewedCalendar(day)) return null;
    const c = exchangeSession(day);
    if (c && Date.parse(c.closeAt) - Date.parse(c.openAt) === fullDay) return c;
  }
  return null;
}

export function targetAfterAuction(day: string) {
  if (publicDate(day) !== day || !hasReviewedCalendar(day)) return null;
  return firstFull(nextDate(day));
}

export function nextEligibleMorning(now: string) {
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) return null;
  const day = newYorkDate(now),
    c = firstFull(day);
  return c && now < c.openAt ? c : c && firstFull(nextDate(day));
}
