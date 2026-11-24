import { createHash } from "node:crypto";
import { join } from "node:path";
import { immutableSourceReceipt } from "../publication-storage.ts";
import { publicDate } from "../public-normalization.ts";
import type { PublicDocument } from "./calendars.ts";
import { exchangeSession, hasReviewedCalendar } from "./exchange-calendar.ts";
import { digest } from "./history.ts";
import { policyCsv } from "./policy.ts";
import { collectPrimaryDealerPositions, dealerSourceHash, PRIMARY_DEALER_POSITION_ID, validatePrimaryDealerPositions, verifyDealerOriginals, type DealerReceipt } from "./primary-dealer-positions.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { newYorkDate, newYorkTimestamp } from "./time.ts";
import type { Signal } from "./types.ts";

export const DEALER_DIRECTORY = ".consensus/private-primary-dealer-positions";
export const DEALER_ROSTER = "https://www.newyorkfed.org/markets/primarydealers";
const long = "PDPOSGSC-G21", adjacent = "PDPOSGSC-G11L21";
const dayMs = 86_400_000;
const millis = (s: string) => Date.parse(s);
const stamp = (s: string) => Number.isFinite(millis(s)) && new Date(s).toISOString() === s;
const day = (s: string) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && publicDate(s) === s;
const sha = (s: string) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
type Week = { week: string; seriesSha: string; sourceSha: string; nativeAt: string };
const weekPath = (dir: string, week: string) => join(dir, "study-weeks", week + ".json");
const rosterPath = (dir: string, week: string) => join(dir, "study-panels", week + ".json");

/** Four explicitly reported fields from the same table and same reporting date, in USD millions. */
export function dealerBuckets(csv: string, week: string) {
  const [header, ...rows] = policyCsv(csv);
  if (!day(week) || header?.join("|") !== "As Of Date|Time Series|Value (millions)") throw Error("Unknown dealer table date or units");
  const values = [long, long + "C", adjacent, adjacent + "C"].map(key => {
    const matches = rows.filter(row => row[1] === key);
    if (matches.length !== 1 || matches[0].length !== 3 || matches[0][0] !== week ||
        !/^-?\d+$/.test(matches[0][2]) || !Number.isSafeInteger(Number(matches[0][2])))
      throw Error("Dealer bucket missing, duplicated, suppressed or on another reporting date");
    return Number(matches[0][2]);
  });
  return { long: values[0], longChange: values[1], adjacent: values[2], adjacentChange: values[3] };
}

const anchor = "2026-10-16";
function englishDate(text: string) {
  const date = /^(\w+) (\d{1,2}), (\d{4})$/.exec(text.trim());
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  if (!date) throw Error("Unknown dealer roster date");
  const name = date[1].toLowerCase();
  const month = months.findIndex(m => name === m || name === m.slice(0, 3) || (m === "september" && name === "sept")) + 1;
  const result = date[3] + "-" + String(month).padStart(2, "0") + "-" + date[2].padStart(2, "0");
  if (!month || !day(result)) throw Error("Invalid dealer roster date");
  return result;
}

/** Fail closed on a new unrecognized entry. An announcement can have a different effective date. */
export function dealerPanelChanges(html: string) {
  const table = /<div\s+id="additions-and-removals"\s*>\s*<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
  const body = table && /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(table)?.[1];
  if (!body || !table.includes("Additions and Removals")) throw Error("Official dealer panel table is missing");
  const marks: string[] = [];
  let last = "9999-12-31";
  for (const block of body.split(/<tr\b[^>]*>/i).slice(1)) {
    const row = block.split(/<\/tr>/i)[0];
    if (/class="tablDate"[^>]*>\s*\d{4}\s*<\/td>\s*<td>\s*<\/td>/i.test(row)) continue;
    const notice = /class="dirColL"[^>]*>\s*<div>([^<]+)<\/div>/i.exec(row)?.[1];
    const link = /<a\b[^>]*href="(\/newsevents\/news\/markets\/\d{4}\/[a-z\d-]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!notice || !link) throw Error("Unrecognized New York Fed dealer panel entry");
    const date = englishDate(notice), copy = link[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const effective = [...copy.matchAll(/\beffective\s+([A-Z][a-z]+ \d{1,2}, \d{4})\b/gi)];
    if (date > last || effective.length !== 1 || !/\b(added|withdrawn|removed)\b/i.test(copy))
      throw Error("Unverified effective date or change in the dealer panel");
    marks.push(englishDate(effective[0][1]));
    if (date === anchor && marks.at(-1) === anchor && link[1] === "/newsevents/news/markets/2026/an261016p" &&
        copy.includes("NatWest Markets Securities Inc.")) return marks;
    last = date;
  }
  throw Error("Dealer roster lacks its independently verified historical anchor");
}

/** First eligible 07:48 New York decision after actual native custody. A late control cannot move the target. */
export function dealerTarget(week: string, nativeAt: string) {
  if (!day(week) || !stamp(nativeAt)) return null;
  const first = newYorkDate(nativeAt), lag = (millis(first) - millis(week)) / dayMs;
  if (lag < 8 || lag > 14) return null;
  for (let i = lag; i <= 15; i++) {
    const session = new Date(millis(week) + i * dayMs).toISOString().slice(0, 10);
    if (!hasReviewedCalendar(session)) return null;
    const clock = exchangeSession(session), cutoff = newYorkTimestamp(session.replaceAll("-", "") + "T074800")!;
    if (clock && millis(clock.closeAt) - millis(clock.openAt) === 390 * 60_000 && nativeAt < cutoff) return { session, cutoff };
  }
  return null;
}

function checkWeek(ref: Week, week: string) {
  if (!ref || ref.week !== week || !day(week) || !sha(ref.sourceSha) || !sha(ref.seriesSha) || !stamp(ref.nativeAt))
    throw Error("Invalid first weekly dealer reference");
}
async function original(dir: string, ref: Week, week: string, asOf: string) {
  checkWeek(ref, week);
  const received = await readResearchReceipt<DealerReceipt>(join(dir, ref.seriesSha + ".json"));
  if (!received) throw Error("Missing original weekly dealer evidence");
  const series = verifyDealerOriginals(received, asOf);
  if (series[1].date !== week || digest(series) !== ref.seriesSha || dealerSourceHash(received) !== ref.sourceSha ||
      [received.history.retrievedAt, received.weekly.retrievedAt].sort()[1] !== ref.nativeAt)
    throw Error("Dealer week differs from its first native release");
  return { series, received };
}

/** An older native receipt may predate installation of the week index. Use it only as the prior balance. */
async function precedingWeek(dir: string, current: Week, previous: string, now: string) {
  const old = await readResearchReceipt<Week>(weekPath(dir, previous));
  if (old) {
    checkWeek(old, previous);
    return old;
  }
  const { received } = await original(dir, current, current.week, now);
  const history: { asofdate: string; value: string }[] = JSON.parse(received.history.text).pd.timeseries;
  if (history.length < 3) return null;
  const earlierSeries = history.slice(-3, -1).map(r => ({date: r.asofdate, value: Number(r.value)}));
  const seriesSha = digest(earlierSeries);
  const prior = await readResearchReceipt<DealerReceipt>(join(dir, seriesSha + ".json"));
  if (!prior) return null;
  const actual = verifyDealerOriginals(prior, now);
  const nativeAt = [prior.history.retrievedAt, prior.weekly.retrievedAt].sort()[1];
  if (digest(actual) !== seriesSha || actual[1].date !== previous || nativeAt >= current.nativeAt) return null;
  const ref: Week = { week: previous, seriesSha, sourceSha: dealerSourceHash(prior), nativeAt };
  return immutableSourceReceipt(join(dir, "study-weeks"), previous + ".json", async () => ref, row => checkWeek(row, previous));
}

function reference(signal: Signal, cutoff: string): Week {
  validatePrimaryDealerPositions(signal, cutoff);
  if (signal.id !== PRIMARY_DEALER_POSITION_ID || signal.status !== "available" || !signal.source.vintageAt || !signal.source.sha256)
    throw Error("No available dealer week");
  return { week: signal.series[1].date, seriesSha: digest(signal.series), sourceSha: signal.source.sha256, nativeAt: signal.source.vintageAt };
}
type Roster = { url: string; sourceSha: string; original: PublicDocument };
function checkRoster(roster: Roster, current: Week, asOf: string) {
  if (roster.url !== DEALER_ROSTER || roster.sourceSha !== current.sourceSha || !stamp(roster.original.retrievedAt) ||
      roster.original.retrievedAt < current.nativeAt || roster.original.retrievedAt > asOf ||
      createHash("sha256").update(roster.original.text).digest("hex") !== roster.original.sha256)
    throw Error("Dealer roster bytes, issue identity or receipt clock changed");
  return dealerPanelChanges(roster.original.text);
}

/** Save one source index per original reporting week. The existing collector retains both raw native documents. */
export async function captureDealerStudySources(dir: string, signal: Signal, read: (url: string) => Promise<PublicDocument>,
  now = () => new Date().toISOString()) {
  const current = reference(signal, now());
  const saved = await immutableSourceReceipt(join(dir, "study-weeks"), current.week + ".json", async () => {
    await original(dir, current, current.week, now());
    // Bind even a first release with a suppressed adjacent bucket. A later correction is not a new week.
    return current;
  }, row => checkWeek(row, current.week));
  if (digest(saved) !== digest(current)) return "already_observed_week";
  const target = dealerTarget(current.week, current.nativeAt);
  if (!target || now() >= target.cutoff) return "source_indexed";
  const previous = signal.series[0].date;
  if (!await precedingWeek(dir, current, previous, now())) return "awaiting_previous_original";
  await immutableSourceReceipt(join(dir, "study-panels"), current.week + ".json", async () => {
      const fresh = await original(dir, current, current.week, now());
      dealerBuckets(fresh.received.weekly.text, current.week);
      return {url: DEALER_ROSTER, sourceSha: current.sourceSha, original: await read(DEALER_ROSTER)};
    },
    row => { checkRoster(row, current, now()); });
  return "source_indexed";
}

export async function collectDealerPositionsWithStudy(read: (url: string) => Promise<PublicDocument>, directory?: string,
  now = () => new Date().toISOString()) {
  const signal = await collectPrimaryDealerPositions(read, directory, now);
  if (directory && signal.status === "available") {
    try { await captureDealerStudySources(directory, signal, read, now); }
    catch (error) { console.error("Private weekly dealer comparison unavailable.", error instanceof Error ? error.message : String(error)); }
  }
  return signal;
}

export async function replayDealerStudySources(dir: string, signal: Signal, session: string, cutoff: string) {
  const current = reference(signal, cutoff), target = dealerTarget(current.week, current.nativeAt);
  if (target?.session !== session) return null;
  const saved = await readResearchReceipt<Week>(weekPath(dir, current.week));
  const previous = signal.series[0].date, prior = await readResearchReceipt<Week>(weekPath(dir, previous));
  const roster = await readResearchReceipt<Roster>(rosterPath(dir, current.week));
  if (!saved || digest(saved) !== digest(current) || !prior || !roster || prior.nativeAt >= current.nativeAt) return null;
  const asOf = cutoff < target.cutoff ? cutoff : target.cutoff;
  if (roster.original.retrievedAt >= target.cutoff || roster.original.retrievedAt > cutoff) return null;
  const changes = checkRoster(roster, current, asOf);
  if (previous < anchor || changes.some(d => previous < d && d <= current.week)) return null;
  const latest = await original(dir, current, current.week, asOf), older = await original(dir, prior, previous, asOf);
  const c = dealerBuckets(latest.received.weekly.text, current.week), p = dealerBuckets(older.received.weekly.text, previous);
  if (latest.series[0].date !== previous || latest.series[0].value !== p.long ||
      c.long - p.long !== c.longChange || c.adjacent - p.adjacent !== c.adjacentChange) return null;
  return { candidate: -c.longChange / 1000, control: c.adjacentChange / 1000, nativeAt: current.nativeAt,
    sourceSeal: digest({current, prior, rosterSha: roster.original.sha256, rosterAt: roster.original.retrievedAt}) };
}
