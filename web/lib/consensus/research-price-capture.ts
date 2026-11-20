import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { durableJSON } from "../publication-storage.ts";
import { type SessionPrice } from "./evaluation.ts";
import { extendedResearchSession, extendedResearchSessions } from "./extended-research-calendar.ts";
import { exchangeSession, exchangeSessions } from "./exchange-calendar.ts";
import { digest } from "./history.ts";
import { collectKibotSeries } from "./kibot.ts";
import type { Instrument } from "./types.ts";

type ETF = Exclude<Instrument, "MARKET">;
export type ResearchPriceReceipt = {
  instrument: ETF; from: string; through: string; sha256: string; priceDigest: string; sessions: SessionPrice[];
};

export async function readResearchReceipt<T>(file: string): Promise<T | null> {
  let stat;
  try { stat = await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.mode & 0o077 || !stat.size || stat.size > 4_000_000)
    throw new Error("Research requires a bounded owner-only receipt");
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/** Fetch the full calendar between the first and last requested outcome in each year. */
export async function collectResearchPrices(
  directory: string, instrument: ETF, targets: string[],
  { splitAdjusted = false, cachedOnly = false, reviewedExchangeCalendar = false } = {},
) {
  const session = reviewedExchangeCalendar ? exchangeSession : extendedResearchSession;
  const sessions = reviewedExchangeCalendar ? exchangeSessions : extendedResearchSessions;
  const ordered = [...targets].sort();
  const years = [...new Set(ordered.map(day => day.slice(0, 4)))];
  const receipts: ResearchPriceReceipt[] = [];
  for (const year of years) {
    const intents = ordered.filter(day => day.startsWith(year));
    const dates = sessions(intents[0], intents.at(-1)!);
    const from = dates[0], through = dates.at(-1)!;
    if (!from || !through) throw new Error("Private prices need a reviewed research range");
    const basis = splitAdjusted ? "splits" : "raw";
    const path = resolve(directory, `${instrument}-${year}-${from}-${through}-${basis}.json`);
    const stored = await readResearchReceipt<ResearchPriceReceipt>(path);
    let receipt: ResearchPriceReceipt;
    if (stored) receipt = stored;
    else {
      if (cachedOnly) throw new Error(`Missing private ${basis} comparison for ${instrument} through ${through}`);
      const source = await collectKibotSeries(instrument, dates, {
        unadjusted: !splitAdjusted, splitAdjusted, sessionClock: session,
      });
      receipt = { instrument, from, through, ...source, priceDigest: digest(source.sessions) };
    }
    if (receipt.instrument !== instrument || receipt.from !== from || receipt.through !== through || !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
        !Array.isArray(receipt.sessions) || receipt.sessions.length !== dates.length || digest(receipt.sessions) !== receipt.priceDigest ||
        receipt.sessions.some((bar, i) => {
          const clock = session(dates[i])!;
          return bar.session !== dates[i] || bar.openAt !== clock.openAt || bar.closeAt !== clock.closeAt ||
            ![bar.open, bar.close].every(price => Number.isFinite(price) && price > 0);
        })) throw new Error(`The ${instrument} ${year} prices differ from the reviewed private capture`);
    if (!stored) await durableJSON(path, receipt, true);
    receipts.push(receipt);
  }
  return receipts;
}
