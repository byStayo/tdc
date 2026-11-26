import { publicDate } from "../public-normalization.ts";

export function newYorkTimestamp(dateTime: string): string | null {
  const match = dateTime.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, se] = match,
    wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (!publicDate(`${y}-${mo}-${d}`) || +h > 23 || +mi > 59 || +se > 59)
    return null;
  let utc = wall;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(utc))
        .map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      +p.year,
      +p.month - 1,
      +p.day,
      +p.hour,
      +p.minute,
      +p.second,
    );
    if (represented === wall) return new Date(utc).toISOString();
    utc += wall - represented;
  }
  return null;
}

export function newYorkDate(at: string): string {
  return localDate(at, "America/New_York");
}

export const CALENDAR_ZONES = [
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
] as const;
export type CalendarZone = (typeof CALENDAR_ZONES)[number];
export function localDate(at: string, timeZone: CalendarZone): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const v = Object.fromEntries(p.map((part) => [part.type, part.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

export function eventUpcoming(
  at: string,
  cutoff: string,
  days = 70,
  dateZone: CalendarZone = "America/New_York",
): boolean {
  const day = localDate(cutoff, dateZone);
  if (at.length === 10)
    return (
      !!publicDate(at) &&
      at >= day &&
      Date.parse(at) <= Date.parse(day) + days * 86400000
    );
  return (
    Number.isFinite(Date.parse(at)) &&
    at >= cutoff &&
    Date.parse(at) <= Date.parse(cutoff) + days * 86400000
  );
}
