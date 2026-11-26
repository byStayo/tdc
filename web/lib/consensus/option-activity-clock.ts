import { exchangeSession } from "./exchange-calendar.ts";
import { newYorkDate } from "./time.ts";

const DAY = 86_400_000;

/** Only complete exchange dates before today's New York date can supply this daily sample. */
export function latestOptionSession(cutoff: string, through: number): string {
  const before = Date.parse(newYorkDate(cutoff));
  for (let i = 1; i <= 10; i++) {
    const day = new Date(before - i * DAY).toISOString().slice(0, 10);
    const session = exchangeSession(day);
    if (session && Date.parse(session.closeAt) <= through) return day;
  }
  throw new Error("No recent completed exchange session in the options delivery window");
}

/** The provider documents a 48-hour publication delay for consolidated US equities and options. */
export function currentOptionActivity(session: string, cutoff: string): boolean {
  try { return session >= latestOptionSession(cutoff, Date.parse(cutoff) - 2 * DAY) && session < newYorkDate(cutoff); }
  catch { return false; }
}
