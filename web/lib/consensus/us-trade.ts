import { publicDate } from "../public-normalization.ts";
import type { PublicDocument } from "./calendars.ts";
import { sourceFailureKind, SourceMissingError } from "./source-failure.ts";
import { newYorkTimestamp } from "./time.ts";
import type { Signal } from "./types.ts";

export const TRADE_ID = "census-bea-monthly-exports";
export const CENSUS_TRADE = "https://www.census.gov/foreign-trade/current/index.html";
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const usMonth = "(" + months.join("|") + ")";
const calendarDate = "(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),?\\s+" + usMonth + "\\s+(\\d{1,2}),\\s*(20\\d{2})";
const periodPattern = new RegExp("U\\.S\\.\\s+International Trade in Goods and Services[,\\s]+" + usMonth + "(\\s+and Annual)?\\s+(20\\d{2})\\b", "i");
const releasePattern = new RegExp("(?:FOR|UNTIL)\\s+(?:IMMEDIATE\\s+)?RELEASE\\s+AT\\s+8:30\\s+A\\.?M\\.?,?\\s+(EST|EDT|ET),?\\s+" + calendarDate, "i");
const censusDatePattern = new RegExp("FOR IMMEDIATE RELEASE:\\s+" + calendarDate, "i");
const unit = "USD billion";
const changeLabel = "Change in exports from the previous month";
const attribution = "U.S. Census Bureau and U.S. Bureau of Economic Analysis, U.S. International Trade in Goods and Services.";
const usage = "Federal statistical release in the public domain. https://www.bea.gov/help/faq/147";

export function tradeText(body: string) {
  return body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ").replace(/\s+/g, " ").trim();
}

function monthNumber(name: string) {
  const index = months.findIndex(month => name.toLowerCase() === month.toLowerCase());
  if (index < 0) throw new Error("Unrecognized FT900 month");
  return index + 1;
}

function dated(weekday: string, month: string, day: string, year: string) {
  const iso = [year, String(monthNumber(month)).padStart(2, "0"), day.padStart(2, "0")].join("-");
  if (publicDate(iso) !== iso || new Date(iso).toUTCString().slice(0, 3).toLowerCase() !== weekday.slice(0, 3).toLowerCase())
    throw new Error("FT900 release day and weekday disagree");
  return iso;
}

function releaseClock(match: RegExpMatchArray) {
  const day = dated(match[2], match[3], match[4], match[5]);
  const releasedAt = newYorkTimestamp(day.replaceAll("-", "") + "T083000")!;
  const zone = match[1].toUpperCase();
  if (zone !== "ET" && zone !== (releasedAt.slice(11, 13) === "13" ? "EST" : "EDT"))
    throw new Error("FT900 release time zone disagrees with New York");
  return releasedAt;
}

export function tradeReleaseTime(text: string) {
  const clocks = new Set([...text.matchAll(new RegExp(releasePattern.source, "gi"))].map(releaseClock));
  if (clocks.size !== 1) throw new Error("Expected one FT900 8:30 a.m. release clock");
  return [...clocks][0];
}

export function tradePeriod(text: string) {
  const period = periodPattern.exec(text);
  if (!period || (period[2] && monthNumber(period[1]) !== 12)) throw new Error("Missing FT900 statistical month");
  return period[3] + "-" + String(monthNumber(period[1])).padStart(2, "0");
}

function periodEnd(period: string) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period)) throw new Error("Invalid FT900 reference month");
  return new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)), 0)).toISOString().slice(0, 10);
}

export function beaTradeUrls(period: string, day: string) {
  const end = periodEnd(period);
  if (publicDate(day) !== day || end >= day || Date.parse(day) - Date.parse(end) > 110 * 86_400_000)
    throw new Error("FT900 publication does not follow the statistical month");
  const base = "https://www.bea.gov/news/" + day.slice(0, 4) + "/us-international-trade-goods-and-services-";
  const year = period.slice(0, 4), month = months[Number(period.slice(5)) - 1].toLowerCase();
  const original = base + month + "-" + year;
  if (period === "2018-11") return [original + "-0"];
  return month === "december" ? [base + "december-and-annual-" + year, original] : [original];
}

export function reportedExports(text: string, period: string) {
  periodEnd(period);
  const month = Number(period.slice(5));
  const amount = "\\$(\\d{1,4}\\.\\d) billion";
  const prior = months[(month + 10) % 12];
  const row = new RegExp("\\b" + months[month - 1] + " exports were " + amount + ", " + amount +
    " (more|less) than " + prior + " exports\\b", "gi");
  const matches = [...text.matchAll(row)];
  if (!matches.length) throw new Error("Missing exact monthly export level and change");
  const figures = matches.map(m => ({ level: Number(m[1]), change: Number(m[2]) * (m[3].toLowerCase() === "less" ? -1 : 1) }));
  const first = figures[0];
  if (first.level <= 0 || first.level - first.change <= 0 || figures.some(f => f.level !== first.level || f.change !== first.change))
    throw new Error("Conflicting monthly export observations");
  return first;
}

function baseline(now: string): Signal {
  return {
    id: TRADE_ID, family: "international", title: "U.S. exports of goods and services", shortLabel: "U.S. exports",
    instruments: ["MARKET", "DIA"], directionalInstruments: [], status: "unavailable",
    summary: "The monthly U.S. export release is awaiting verification.",
    source: { name: "U.S. Census Bureau and BEA · FT900", url: CENSUS_TRADE, retrievedAt: now, observedAt: null,
      releasedAt: null, frequency: "monthly", attribution, usage, sha256: null },
    methodology: "Match the seasonally adjusted, balance-of-payments export total and its change in the Census and BEA releases for the same month. The export amount is in current U.S. dollars. The observation date is month-end.",
    limitation: "Prior months can be revised. Export receipts measure cross-border demand for U.S. goods and services. Their relationship to the next DIA session requires separate testing.",
    unit, staleAfterDays: 80, metrics: [], series: [], scores: { daily: null, weekly: null, monthly: null },
  };
}

export async function collectUsTrade(read: (url: string) => Promise<PublicDocument>, now = new Date().toISOString()) {
  const base = baseline(now);
  try {
    const census = await read(CENSUS_TRADE);
    const landing = tradeText(census.text);
    const announced = censusDatePattern.exec(landing);
    if (!announced) throw new Error("Missing Census publication date");
    const day = dated(announced[1], announced[2], announced[3], announced[4]);
    const story = landing.slice(announced.index);
    const period = tradePeriod(story);
    const [primary, monthly] = beaTradeUrls(period, day);
    const corroboration = reportedExports(story, period);
    let url = primary;
    const bea = await read(url).catch(error => {
      if (!monthly || !(error instanceof SourceMissingError)) throw error;
      url = monthly;
      return read(url);
    });
    const text = tradeText(bea.text);
    // A subsequently corrected release can retain the first issue's embargo header.
    // Use an explicit review of the affected fields and correction time before reuse.
    const correction = /\b(?:errata|correction notice|this release (?:was|has been) corrected)\b/i;
    if (correction.test(story) || correction.test(text)) throw new Error("FT900 correction requires a dated review");
    const releasedAt = tradeReleaseTime(text);
    const figures = reportedExports(text, period);
    if (tradePeriod(text) !== period || releasedAt.slice(0, 10) !== day ||
        [census.retrievedAt, bea.retrievedAt].some(clock => !Number.isFinite(Date.parse(clock)) || clock < releasedAt) ||
        figures.level !== corroboration.level || figures.change !== corroboration.change)
      throw new Error("Census and BEA export releases differ");
    const observedAt = periodEnd(period);
    const signal: Signal = { ...base, status: "available",
      summary: months[Number(period.slice(5)) - 1] + " exports totaled $" + figures.level.toFixed(1) + " billion.",
      source: { ...base.source, url, sha256: bea.sha256, releasedAt, observedAt,
        retrievedAt: bea.retrievedAt > census.retrievedAt ? bea.retrievedAt : census.retrievedAt },
      series: [{ date: observedAt, value: figures.level }],
      metrics: [{ label: "Exports of goods and services", unit, date: observedAt, value: figures.level },
        { label: changeLabel, unit, date: observedAt, value: figures.change }] };
    validateUsTrade(signal);
    return signal;
  } catch (error) {
    return { ...base, failureKind: sourceFailureKind(error) };
  }
}

export function validateUsTrade(signal: Signal) {
  if (signal.id !== TRADE_ID) return;
  const s = signal.source, base = baseline(s.retrievedAt);
  if (signal.family !== base.family || signal.instruments.join() !== base.instruments.join() ||
      signal.directionalInstruments?.length !== 0 || Object.values(signal.scores).some(value => value !== null) ||
      signal.unit !== unit || signal.staleAfterDays !== base.staleAfterDays || s.frequency !== base.source.frequency ||
      s.name !== base.source.name || s.usage !== usage || s.attribution !== attribution) throw new Error("Invalid FT900 scope");
  if (signal.status === "unavailable") {
    if (s.url !== CENSUS_TRADE || s.observedAt !== null || s.releasedAt !== null || s.sha256 !== null || signal.series.length || signal.metrics.length)
      throw new Error("Unexpected unavailable FT900 reading");
    return;
  }
  const p = signal.series[0], [level, change] = signal.metrics;
  const period = s.observedAt?.slice(0, 7), day = s.releasedAt?.slice(0, 10);
  if (signal.status !== "available" || !period || !day || s.observedAt !== periodEnd(period) ||
      !beaTradeUrls(period, day).includes(s.url) || s.releasedAt !== newYorkTimestamp(day.replaceAll("-", "") + "T083000") ||
      !s.releasedAt || s.releasedAt > s.retrievedAt || !/^[a-f0-9]{64}$/.test(s.sha256 ?? "") ||
      signal.series.length !== 1 || p.date !== s.observedAt || signal.metrics.length !== 2 ||
      level.label !== "Exports of goods and services" || level.value !== p.value || change.label !== changeLabel ||
      !signal.metrics.every(m => m.date === p.date && m.unit === unit && Number.isFinite(m.value) &&
        Math.round(m.value * 10) / 10 === m.value) || p.value <= 0 || p.value - change.value <= 0)
    throw new Error("Invalid FT900 export reading");
}
