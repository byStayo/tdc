import type { PublicDocument } from "./calendars.ts";
import type { Point, Signal } from "./types.ts";
import { privateCreditVintage } from "./private-credit.ts";
import { sourceFailureKind } from "./source-failure.ts";
import { newYorkDate } from "./time.ts";

export const HOUSEHOLD_EQUITY_ID = "fed-household-equity-transactions";
export const HOUSEHOLD_EQUITY_CURRENT = "https://www.federalreserve.gov/releases/z1/current/html/S1M_t.htm";
export const HOUSEHOLD_EQUITY_DATED = "https://www.federalreserve.gov/releases/z1/20260911/html/S1M_t.htm";
export const HOUSEHOLD_EQUITY_SERIES = "FA153064105.Q";
export const HOUSEHOLD_EQUITY_UNIT = "$bn SAAR";
const RELEASE = "2026-09-11", QUARTER = "2026:Q2", OBSERVED = "2026-06-30";
const ATTRIBUTION = "Board of Governors of the Federal Reserve System, Financial Accounts of the United States";
const USAGE = "Board-produced public-domain data, with source attribution. No third-party microdata, Board seal or endorsement is reproduced.";
const METHODOLOGY = "FA153064105.Q: household-and-nonprofit net corporate-equity asset transactions, calculated residually from total equity assets less other identified sectors. Billions of dollars at a seasonally adjusted annual rate (SAAR), not cash moved during the quarter or a change in market value. Only the latest quarter of the reviewed original release is admitted. No directional vote.";
const LIMITATION = "Combined households and nonprofit institutions, private-equity funds and personal trusts; a residual national-account estimate, not retail brokerage orders, all individual investors or ETF clicks. Includes directly held corporate equities and the fund shares defined by the Fed. The September 11, 2026 release separates hedge funds and revises the household definition from 2012Q4. Earlier current-vintage rows are not earlier publication observations.";
const plain = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
const attr = (s: string, key: string) => s.match(new RegExp(`(?:^|\\s)${key}=["']([^"']*)["']`, "i"))?.[1];
const instant = (s: string) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;

/** Reuse the existing reviewed Z.1 release gate, without using private-credit data or its input lag. */
export function householdEquityTable(html: string, cutoff: string) {
  const releaseDate = privateCreditVintage(html, cutoff);
  if (releaseDate !== RELEASE || newYorkDate(cutoff) <= releaseDate)
    throw new Error("Household-equity date-only publication requires a subsequent New York date");
  const text = plain(html);
  if (!/S1M\.t Households and nonprofit organizations/.test(text) ||
      !/Sector includes domestic hedge funds \(through 2012q3\), private equity funds, and personal trusts\./.test(text) ||
      !/Directly held corporate equities, including shares of closed-end funds, exchange-traded funds/.test(text))
    throw new Error("Household-equity sector definition or method break is missing");
  const tables = [...html.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)].filter(m => attr(m[1], "id") === "s1mt");
  if (tables.length !== 1) throw new Error("Missing or duplicate household-equity transaction table");
  const table = tables[0][2], head = table.match(/<thead>([\s\S]*?)<\/thead>/i)?.[1];
  if (!head) throw new Error("Missing household-equity period header");
  const periods = new Map<string, string>(), dates = new Set<string>();
  for (const m of head.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/gi)) {
    const id = attr(m[1], "id");
    if (!id || !/^t\d+$/.test(id)) continue;
    const label = plain(m[2]);
    if (/^20\d{2}$/.test(label)) continue;
    const match = /^(20\d{2}):Q([1-4])$/.exec(label);
    if (!match) throw new Error("Invalid household-equity quarter");
    const day = `${match[1]}-${["03-31", "06-30", "09-30", "12-31"][Number(match[2]) - 1]}`;
    if (day >= releaseDate || day > cutoff.slice(0, 10) || periods.has(id) || dates.has(day))
      throw new Error("Future or duplicate household-equity quarter");
    periods.set(id, day); dates.add(day);
  }
  const window = [...periods.values()];
  if (window.length !== 6 || window.at(-1) !== OBSERVED || window.some((d, i) => i > 0 &&
      (d <= window[i - 1] || Date.parse(d) - Date.parse(window[i - 1]) > 93 * 86400000)))
    throw new Error("Unreviewed or incomplete household-equity quarter window");
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].filter(m =>
    [...m[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].some(cell => plain(cell[1]) === "FA153064105"));
  if (rows.length !== 1) throw new Error("Missing or duplicate household-equity series");
  const values = new Map<string, number>();
  for (const cell of rows[0][1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
    const keys = (attr(cell[1], "headers") ?? "").split(/\s+/).filter(k => periods.has(k));
    if (!keys.length) continue;
    const value = plain(cell[2]);
    if (keys.length !== 1 || values.has(keys[0])) throw new Error("Ambiguous or duplicate household-equity cell");
    if (!/^-?\d+\.\d$/.test(value) || !Number.isFinite(Number(value))) throw new Error("Invalid household-equity transaction value");
    values.set(keys[0], Number(value));
  }
  if (values.size !== periods.size) throw new Error("Incomplete household-equity series");
  return { releaseDate, points: [...periods].map(([key, date]): Point => ({ date, value: values.get(key)! })) };
}

function baseline(retrievedAt: string): Signal {
  return {
    id: HOUSEHOLD_EQUITY_ID, family: "retail", title: "Household and nonprofit equity transactions", shortLabel: "Household equity transactions",
    instruments: ["MARKET", "SPY", "QQQ", "IWM", "DIA"], directionalInstruments: [], status: "unavailable",
    summary: "Verified household-and-nonprofit equity transactions are unavailable.",
    source: { name: "Federal Reserve · Financial Accounts S1M.t", url: HOUSEHOLD_EQUITY_CURRENT, retrievedAt,
      observedAt: null, releasedAt: null, frequency: "quarterly", attribution: ATTRIBUTION, usage: USAGE, sha256: null },
    methodology: METHODOLOGY, limitation: LIMITATION, series: [], metrics: [],
    scores: { daily: null, weekly: null, monthly: null }, staleAfterDays: 210, unit: HOUSEHOLD_EQUITY_UNIT,
  };
}

export async function collectHouseholdEquity(
  read: (url: string) => Promise<PublicDocument>, now = () => new Date().toISOString(), previous?: Signal,
): Promise<Signal> {
  const base = baseline(now());
  try {
    const current = householdEquityTable((await read(HOUSEHOLD_EQUITY_CURRENT)).text, now());
    const doc = await read(HOUSEHOLD_EQUITY_DATED), dated = householdEquityTable(doc.text, now());
    if (JSON.stringify(current) !== JSON.stringify(dated)) throw new Error("Current and dated household-equity evidence disagree");
    if (!/^[a-f0-9]{64}$/.test(doc.sha256) || !instant(doc.retrievedAt) || doc.retrievedAt > now() || newYorkDate(doc.retrievedAt) <= RELEASE)
      throw new Error("Invalid household-equity source provenance");
    const point = dated.points.at(-1)!;
    let firstObservedAt = doc.retrievedAt, firstObservedSHA256 = doc.sha256;
    if (previous?.householdEquity) {
      validateHouseholdEquity(previous);
      if (previous.status === "available" && previous.source.releasedAt === RELEASE &&
          JSON.stringify(previous.series) === JSON.stringify([point])) {
        ({ firstObservedAt, firstObservedSHA256 } = previous.householdEquity);
      }
    }
    const signal: Signal = {
      ...base, status: "available", summary: `The Fed estimated ${point.value.toFixed(1)} $bn SAAR of household-and-nonprofit corporate-equity transactions for the quarter ended ${OBSERVED}.`,
      source: { ...base.source, url: HOUSEHOLD_EQUITY_DATED, retrievedAt: doc.retrievedAt, observedAt: OBSERVED, releasedAt: RELEASE, sha256: doc.sha256 },
      series: [point], metrics: [{ label: "Net corporate-equity asset transactions", ...point, unit: HOUSEHOLD_EQUITY_UNIT }],
      householdEquity: { reviewVersion: "fed-household-equity-v1", seriesId: HOUSEHOLD_EQUITY_SERIES, quarter: QUARTER,
        publicationClock: "date-only", firstObservedAt, firstObservedSHA256,
        methodBreakRelease: RELEASE, revisedDefinitionFrom: "2012-10-01" },
    };
    validateHouseholdEquity(signal);
    return signal;
  } catch (error) {
    return { ...base, failureKind: sourceFailureKind(error),
      summary: `Household-equity source withheld: ${error instanceof Error ? error.message : "source failure"}.` };
  }
}

export function validateHouseholdEquity(signal: Signal): void {
  if (signal.id !== HOUSEHOLD_EQUITY_ID) {
    if (signal.householdEquity) throw new Error("Household-equity metadata attached to another signal");
    return;
  }
  const base = baseline(signal.source.retrievedAt), source = signal.source;
  if (signal.family !== "retail" || signal.title !== base.title || signal.shortLabel !== base.shortLabel ||
      signal.instruments.join(",") !== base.instruments.join(",") || signal.directionalInstruments?.length !== 0 ||
      Object.values(signal.scores).some(score => score !== null) || signal.unit !== HOUSEHOLD_EQUITY_UNIT ||
      signal.staleAfterDays !== base.staleAfterDays || signal.methodology !== METHODOLOGY || signal.limitation !== LIMITATION ||
      source.name !== base.source.name || source.attribution !== ATTRIBUTION || source.usage !== USAGE || source.frequency !== "quarterly")
    throw new Error("Invalid household-equity nonvoting admission or definition");
  if (signal.status === "unavailable") {
    if (signal.householdEquity || signal.series.length || signal.metrics.length || source.url !== HOUSEHOLD_EQUITY_CURRENT ||
        source.observedAt !== null || source.releasedAt !== null || source.sha256 !== null)
      throw new Error("Unavailable household-equity source contains observations");
    return;
  }
  const meta = signal.householdEquity, point = signal.series[0], metric = signal.metrics[0];
  if (signal.status !== "available" || !meta || meta.reviewVersion !== "fed-household-equity-v1" ||
      meta.seriesId !== HOUSEHOLD_EQUITY_SERIES || meta.quarter !== QUARTER || meta.publicationClock !== "date-only" ||
      meta.methodBreakRelease !== RELEASE || meta.revisedDefinitionFrom !== "2012-10-01" ||
      !instant(meta.firstObservedAt) || !/^[a-f0-9]{64}$/.test(meta.firstObservedSHA256) ||
      !instant(source.retrievedAt) || meta.firstObservedAt > source.retrievedAt || newYorkDate(meta.firstObservedAt) <= RELEASE ||
      source.url !== HOUSEHOLD_EQUITY_DATED || source.releasedAt !== RELEASE || source.observedAt !== OBSERVED ||
      !source.sha256 || !/^[a-f0-9]{64}$/.test(source.sha256) || signal.series.length !== 1 || !point ||
      point.date !== OBSERVED || !Number.isFinite(point.value) || signal.metrics.length !== 1 || !metric ||
      metric.date !== point.date || metric.value !== point.value || metric.label !== "Net corporate-equity asset transactions" || metric.unit !== HOUSEHOLD_EQUITY_UNIT)
    throw new Error("Household-equity vintage, clock, units or evidence mismatch");
}
