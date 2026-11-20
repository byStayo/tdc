import { publicDate } from "../public-normalization.ts";
import { EXCHANGE_CALENDAR, exchangeSession } from "./exchange-calendar.ts";
import { HISTORICAL_RESEARCH_CALENDAR, historicalResearchSession } from "./research-session-calendar.ts";
import { newYorkTimestamp } from "./time.ts";

/** Older review scope is separate from both saved research and as-issued calendars. */
export const EARLIER_RESEARCH_CALENDAR = {
  id: "nyse-group-core-research-2016-2021-v1",
  from: "2016-01-01", through: "2021-12-31",
  sources: [
    "https://ir.theice.com/press/news-details/2014/NYSE-Group-2016-Holiday-Calendar-and-Early-Closings/default.aspx",
    "https://ir.theice.com/press/news-details/2016/NYSE-Group-announces-2018-and-2019-holiday-and-early-closings-calendar/default.aspx",
    "https://ir.theice.com/press/news-details/2018/New-York-Stock-Exchange-to-Honor-President-George-H-W-Bush/default.aspx",
    "https://ir.theice.com/press/news-details/2019/NYSE-Group-Announces-2020-2021-and-2022-Holiday-and-Early-Closings-Calendar/default.aspx",
    "https://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2018-98",
    "https://www.nasdaqtrader.com/content/technicalsupport/2021tradingcalendar.pdf",
    "https://listingcenter.nasdaq.com/assets/rulebook/nasdaq/filings/SR-NASDAQ-2021-093.pdf",
    "https://www.sec.gov/Archives/edgar/data/1604813/000089418918006329/trimtabs_485b.htm",
    "https://www.cboe.com/markets/us/equities/market-statistics/historical-market-volume",
  ],
};
const holidays = new Set([
  "2016-01-01", "2016-01-18", "2016-02-15", "2016-03-25", "2016-05-30", "2016-07-04", "2016-09-05", "2016-11-24", "2016-12-26",
  "2017-01-02", "2017-01-16", "2017-02-20", "2017-04-14", "2017-05-29", "2017-07-04", "2017-09-04", "2017-11-23", "2017-12-25",
  "2018-01-01", "2018-01-15", "2018-02-19", "2018-03-30", "2018-05-28", "2018-07-04", "2018-09-03", "2018-11-22", "2018-12-05", "2018-12-25",
  "2019-01-01", "2019-01-21", "2019-02-18", "2019-04-19", "2019-05-27", "2019-07-04", "2019-09-02", "2019-11-28", "2019-12-25",
  "2020-01-01", "2020-01-20", "2020-02-17", "2020-04-10", "2020-05-25", "2020-07-03", "2020-09-07", "2020-11-26", "2020-12-25",
  "2021-01-01", "2021-01-18", "2021-02-15", "2021-04-02", "2021-05-31", "2021-07-05", "2021-09-06", "2021-11-25", "2021-12-24",
]);
const early = new Set([
  "2016-11-25", "2017-07-03", "2017-11-24", "2018-07-03", "2018-11-23", "2018-12-24",
  "2019-07-03", "2019-11-29", "2019-12-24", "2020-11-27", "2020-12-24", "2021-11-26",
]);
export const EXTENDED_CALENDAR_IDS = [EARLIER_RESEARCH_CALENDAR.id, HISTORICAL_RESEARCH_CALENDAR.id, EXCHANGE_CALENDAR.id];

export function extendedResearchSession(day: string): ReturnType<typeof exchangeSession> {
  if (publicDate(day) !== day || day < EARLIER_RESEARCH_CALENDAR.from || day > EXCHANGE_CALENDAR.through)
    throw new Error("Date outside the extended research calendar");
  if (day >= EXCHANGE_CALENDAR.from) return exchangeSession(day);
  if (day > EARLIER_RESEARCH_CALENDAR.through) return historicalResearchSession(day);
  const weekday = new Date(day + "T12:00:00Z").getUTCDay();
  if (weekday === 0 || weekday === 6 || holidays.has(day)) return null;
  const compact = day.replaceAll("-", "");
  return { session: day, openAt: newYorkTimestamp(compact + "T093000")!,
    closeAt: newYorkTimestamp(compact + (early.has(day) ? "T130000" : "T160000"))! };
}

export function extendedResearchSessions(from: string, through: string): string[] {
  extendedResearchSession(from);
  extendedResearchSession(through);
  if (from > through) throw new Error("Research calendar range is reversed");
  const days: string[] = [];
  for (let time = Date.parse(from); time <= Date.parse(through); time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    if (extendedResearchSession(day)) days.push(day);
  }
  return days;
}
