import { publicDate } from "../public-normalization.ts";
import { newYorkTimestamp } from "./time.ts";

// Retrospective calendar for price-source qualification and private research.
// The as-issued evaluator continues to use its existing calendar.
export const HISTORICAL_RESEARCH_CALENDAR = {
  id: "nyse-nasdaq-core-research-2022-2025-v1",
  years: [2022, 2023, 2024, 2025] as const,
  sources: [
    "https://ir.theice.com/press/news-details/2021/NYSE-Group-Announces-2022-2023-and-2024-Holiday-and-Early-Closings-Calendar/default.aspx",
    "https://ir.theice.com/press/news-details/2024/NYSE-Group-Announces-2025-2026-and-2027-Holiday-and-Early-Closings-Calendar/default.aspx",
    "https://ir.theice.com/press/news-details/2024/The-New-York-Stock-Exchange-Will-Close-Markets-on-January-9-to-Honor-the-Passing-of-Former-President-Jimmy-Carter-on-National-Day-of-Mourning/default.aspx",
    "https://www.nasdaqtrader.com/content/technicalsupport/2022tradingcalendar.pdf",
    "https://www.nasdaqtrader.com/content/technicalsupport/2023tradingcalendar.pdf",
    "https://www.nasdaqtrader.com/content/technicalsupport/2024tradingcalendar.pdf",
    "https://www.nasdaqtrader.com/content/technicalsupport/2025tradingcalendar.pdf",
    "https://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2024-87",
    "https://www.nasdaqtrader.com/TraderNews.aspx?id=UTP2025-30",
  ],
};
const holidays = new Set([
  "2022-01-17", "2022-02-21", "2022-04-15", "2022-05-30", "2022-06-20",
  "2022-07-04", "2022-09-05", "2022-11-24", "2022-12-26",
  "2023-01-02", "2023-01-16", "2023-02-20", "2023-04-07", "2023-05-29",
  "2023-06-19", "2023-07-04", "2023-09-04", "2023-11-23", "2023-12-25",
  "2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27",
  "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25",
  "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
]);
const early = new Set([
  "2022-11-25", "2023-07-03", "2023-11-24", "2024-07-03", "2024-11-29", "2024-12-24",
  "2025-07-03", "2025-11-28", "2025-12-24",
]);

export function historicalResearchSession(day: string): { session: string; openAt: string; closeAt: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || publicDate(day) !== day ||
      !HISTORICAL_RESEARCH_CALENDAR.years.some(year => day.startsWith(year + "-")))
    throw new Error("Date outside reviewed historical research calendar");
  const weekday = new Date(day + "T12:00:00Z").getUTCDay();
  if (weekday === 0 || weekday === 6 || holidays.has(day)) return null;
  const compact = day.replaceAll("-", "");
  return {
    session: day,
    openAt: newYorkTimestamp(compact + "T093000")!,
    closeAt: newYorkTimestamp(compact + (early.has(day) ? "T130000" : "T160000"))!,
  };
}

export function historicalResearchSessions(year: (typeof HISTORICAL_RESEARCH_CALENDAR.years)[number]): string[] {
  const days: string[] = [];
  for (let date = Date.UTC(year, 0, 1); date < Date.UTC(year + 1, 0, 1); date += 86_400_000) {
    const day = new Date(date).toISOString().slice(0, 10);
    if (historicalResearchSession(day)) days.push(day);
  }
  return days;
}
