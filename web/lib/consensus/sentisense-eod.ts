import { verifyExpectedSessions } from "./exchange-calendar.ts";
import { newYorkDate, newYorkTimestamp } from "./time.ts";

export const SENTISENSE_EOD_SOURCE = "https://sentisense.ai/docs/api/stocks/#get-chart";

type ChartBar = { session: string; open: number; close: number };
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** Chart labels are presentation strings. Only the New York timestamp identifies a session. */
export function parseSentiSenseEod(value: unknown, expected: string[], today: string) {
  if (!expected.length || verifyExpectedSessions(expected).length !== expected.length ||
      expected.at(-1)! >= today || !Array.isArray(value) || !value.length || value.length > 260)
    throw new Error("SentiSense chart needs a bounded reviewed range of completed sessions");
  let previous = "";
  let ignoredToday = false;
  const bars: ChartBar[] = [];
  for (const point of value) {
    if (!point || typeof point !== "object") throw new Error("Invalid SentiSense chart row");
    const { timestamp, open, high, low, close, volume, session, adjusted } = point;
    if (!Number.isSafeInteger(timestamp) || !Number.isFinite(new Date(timestamp).getTime()))
      throw new Error("Invalid SentiSense chart timestamp");
    const at = new Date(timestamp).toISOString();
    const day = newYorkDate(at);
    if (at !== newYorkTimestamp(day.replaceAll("-", "") + "T000000") || day <= previous || day > today)
      throw new Error("SentiSense chart timestamps must be ordered New York midnights");
    previous = day;
    if (day === today) {
      ignoredToday = true;
      continue;
    }
    if (!positive(open) || !positive(high) || !positive(low) || !positive(close) ||
        low > Math.min(open, close) || high < Math.max(open, close) ||
        !Number.isSafeInteger(volume) || volume < 0 || session !== null || adjusted !== true)
      throw new Error("Invalid split-adjusted SentiSense daily bar");
    bars.push({ session: day, open, close });
  }
  const selected = bars.filter(row => row.session >= expected[0]);
  if (selected.length !== expected.length || selected.some((row, i) => row.session !== expected[i]))
    throw new Error("SentiSense chart differs from the reviewed completed sessions");
  return { bars: selected, ignoredToday, firstReturnedSession: bars[0]?.session,
    containsHistoricalShortSession: bars.some(row => row.session === "2025-11-28") };
}
