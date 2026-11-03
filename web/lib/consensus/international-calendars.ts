import { publicDate } from "../public-normalization.ts";
import type { Catalyst } from "./types.ts";
import { eventUpcoming, type CalendarZone } from "./time.ts";

export const INTERNATIONAL_CALENDARS = {
  boe: "https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates",
  ecb: "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html",
  boj: "https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm",
};
const plain = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
function date(year: number, month: string, day: string): string | null {
  const i = months.findIndex((m) =>
    m.startsWith(month.toLowerCase().replace(/\.$/, "")),
  );
  if (i < 0 || month.length < 3) return null;
  return publicDate(
    `${year}-${String(i + 1).padStart(2, "0")}-${day.padStart(2, "0")}`,
  );
}
function upcoming(event: Catalyst, cutoff: string): boolean {
  return eventUpcoming(event.at, cutoff, 70, event.dateZone);
}
function event(
  id: string,
  at: string,
  title: string,
  source: string,
  url: string,
  dateZone: CalendarZone,
  importance: "major" | "context" = "major",
): Catalyst {
  return {
    id: `${id}-${at}`,
    at,
    title,
    source,
    url,
    dateZone,
    importance,
    kind: "scheduled",
  };
}
export function boeEvents(html: string, cutoff: string): Catalyst[] {
  const events = new Map<string, Catalyst>();
  for (const section of html.matchAll(
    /<h2\b[^>]*>\s*(\d{4}) confirmed dates\s*<\/h2>[\s\S]*?<table\b[^>]*>([\s\S]*?)<\/table>/gi,
  )) {
    for (const row of section[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
        (m) => plain(m[1]),
      );
      const match = cells[0]?.match(
        /^(?:Monday|Tuesday|Wednesday|Thursday|Friday) (\d{1,2}) ([A-Za-z]+)$/,
      );
      if (
        cells.length !== 2 ||
        !match ||
        !/MPC Summary and minutes/i.test(cells[1])
      )
        continue;
      const at = date(+section[1], match[2], match[1]);
      if (!at) continue;
      const item = event(
        "boe-decision",
        at,
        `Bank of England policy decision${/Monetary Policy Report/i.test(cells[1]) ? " · Monetary Policy Report" : ""}`,
        "Bank of England",
        INTERNATIONAL_CALENDARS.boe,
        "Europe/London",
      );
      if (upcoming(item, cutoff)) events.set(item.id, item);
    }
  }
  return [...events.values()].sort((a, b) => a.at.localeCompare(b.at));
}
export function ecbEvents(html: string, cutoff: string): Catalyst[] {
  const events = new Map<string, Catalyst>();
  for (const row of html.matchAll(
    /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi,
  )) {
    const day = plain(row[1]).match(/^(\d{2})\/(\d{2})\/(\d{4})$/),
      title = plain(row[2]);
    if (
      !day ||
      !/Governing Council of the ECB: monetary policy meeting/i.test(title) ||
      !/\(Day 2\)/i.test(title) ||
      !/press conference/i.test(title)
    )
      continue;
    const at = publicDate(`${day[3]}-${day[2]}-${day[1]}`);
    if (!at) continue;
    const item = event(
      "ecb-decision",
      at,
      "ECB monetary policy decision · press conference",
      "European Central Bank",
      INTERNATIONAL_CALENDARS.ecb,
      "Europe/Berlin",
    );
    if (upcoming(item, cutoff)) events.set(item.id, item);
  }
  return [...events.values()].sort((a, b) => a.at.localeCompare(b.at));
}
function japanDate(
  text: string,
  year: number,
  conclusion = false,
): string | null {
  const cleaned = plain(text)
    .replace(/\[PDF[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = cleaned.match(
    /^([A-Za-z]+)\.?\s+(\d{1,2})(?:\s*,\s*(?:([A-Za-z]+)\.?\s+)?(\d{1,2}))?(?:\s*,\s*(\d{4}))?$/,
  );
  if (!match || (!conclusion && match[4])) return null;
  const start = date(year, match[1], match[2]);
  const end = date(
    match[5] ? +match[5] : year,
    match[3] ?? match[1],
    match[4] ?? match[2],
  );
  if (
    !start ||
    !end ||
    end < start ||
    (conclusion && Date.parse(end) - Date.parse(start) > 3 * 86400000)
  )
    return null;
  return end;
}
export function bojEvents(html: string, cutoff: string): Catalyst[] {
  const events = new Map<string, Catalyst>();
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const year = table[1].match(
      /<caption\b[^>]*>\s*Table\s*:\s*(\d{4})\s*<\/caption>/i,
    );
    const heads = [...table[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(
      (m) => plain(m[1]),
    );
    if (
      !year ||
      heads.join("|") !==
        "Date of MPM|Release Schedule|Outlook Report (The Bank's View)|Summary of Opinions|MPM Minutes"
    )
      continue;
    for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
        (m) => m[1],
      );
      if (cells.length !== 4) continue;
      const meeting = japanDate(cells[0], +year[1], true);
      if (!meeting) continue;
      const item = event(
        "boj-decision",
        meeting,
        "Bank of Japan policy meeting concludes",
        "Bank of Japan",
        INTERNATIONAL_CALENDARS.boj,
        "Asia/Tokyo",
      );
      if (upcoming(item, cutoff)) events.set(item.id, item);
      for (const [index, kind, label] of [
        [2, "opinions", "summary of opinions"],
        [3, "minutes", "meeting minutes"],
      ] as const) {
        const at = japanDate(cells[index], +year[1]);
        // Do not invent a year rollover or an announcement time from a general convention.
        if (
          !at ||
          at < meeting ||
          Date.parse(at) - Date.parse(meeting) > 120 * 86400000
        )
          continue;
        const release = event(
          `boj-${kind}-${meeting}`,
          at,
          `BoJ ${label} · ${meeting} meeting`,
          "Bank of Japan",
          INTERNATIONAL_CALENDARS.boj,
          "Asia/Tokyo",
          "context",
        );
        if (upcoming(release, cutoff)) events.set(release.id, release);
      }
    }
  }
  return [...events.values()].sort((a, b) => a.at.localeCompare(b.at));
}
