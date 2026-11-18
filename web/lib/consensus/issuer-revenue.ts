import { normalizeCik, publicDate, secDocumentUrl } from "../public-normalization.ts";
import { REVIEWED_ISSUERS } from "./issuer-context.ts";
import { newYorkDate } from "./time.ts";

export const REVENUE_ISSUERS = ["AMD", "NVDA"] as const;
export type RevenueIssuer = (typeof REVENUE_ISSUERS)[number];
type FiscalQuarter = { year: number; quarter: number };
export type ResultsFiling = {
  ticker: RevenueIssuer;
  accession: string;
  reportDate: string;
  filingDate: string;
  acceptedAt: string;
};

const QUARTERS = ["first", "second", "third", "fourth"];
const MONTH_DATE = /(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/;

function plain(html: string) {
  return html.replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/[’']|&rsquo;|&#8217;|&#x2019;/gi, "'")
    .replace(/&#(36|37|44|46|58);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&bull;|&#8226;|&#x2022;/gi, "•")
    .replace(/\s+/g, " ").trim();
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

export function resultsFilings(ticker: RevenueIssuer, payload: unknown, from: string, through: string): ResultsFiling[] {
  const cik = normalizeCik(REVIEWED_ISSUERS[ticker].cik);
  if (!payload || typeof payload !== "object" ||
      normalizeCik((payload as { cik?: unknown }).cik) !== cik)
    throw new Error(`SEC submissions issuer mismatch for ${ticker}`);
  const recent = (payload as { filings?: { recent?: Record<string, unknown> } }).filings?.recent;
  const fields = ["accessionNumber", "filingDate", "reportDate", "acceptanceDateTime", "form", "items"] as const;
  const arrays = fields.map(field => recent?.[field]);
  if (!arrays.every(Array.isArray) || !arrays[0].length ||
      !arrays.every(values => values.length === arrays[0].length))
    throw new Error(`Missing SEC submissions columns for ${ticker}`);
  const [accessions, filingDates, reportDates, acceptedDates, forms, items] = arrays;
  const result: ResultsFiling[] = [];
  const throughDate = newYorkDate(through);
  for (const [index, accession] of accessions.entries()) {
    if (forms[index] !== "8-K" || typeof items[index] !== "string" ||
        !items[index].split(",").some((item: string) => item.trim() === "2.02")) continue;
    const filingDate = publicDate(filingDates[index]);
    if (!filingDate) throw new Error(`Invalid SEC filing date for ${ticker}`);
    if (filingDate < from || filingDate > throughDate) continue;
    const reportDate = publicDate(reportDates[index]);
    const acceptedAt = acceptedDates[index];
    if (!reportDate || !timestamp(acceptedAt) || acceptedAt > through || reportDate > filingDate ||
        typeof accession !== "string" ||
        !new RegExp(`^${cik}-\\d{2}-\\d{6}$`).test(accession))
      throw new Error(`Invalid SEC results accession for ${ticker}`);
    result.push({ ticker, accession, reportDate, filingDate, acceptedAt });
  }
  if (!result.length || result.length > 36 || new Set(result.map(row => row.accession)).size !== result.length)
    throw new Error(`Unexpected SEC results filing count for ${ticker}`);
  return result.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
}

export function filingIndex(filing: ResultsFiling) {
  const { cik } = REVIEWED_ISSUERS[filing.ticker];
  const url = secDocumentUrl(cik, filing.accession, filing.accession + "-index.htm");
  if (!url) throw new Error("Invalid issuer results index");
  return url;
}

export function exhibitURL(filing: ResultsFiling, indexHtml: string): string {
  const matches = Array.from(indexHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi))
    .filter(match => /<td\b[^>]*>\s*EX-99\.1\s*<\/td>/i.test(match[1]));
  const links = Array.from((matches.length === 1 ? matches[0][1] : "").matchAll(/\bhref="([^"]+)"/g));
  if (links.length !== 1) throw new Error(`Expected one original EX-99.1 for ${filing.accession}`);
  const index = filingIndex(filing);
  const base = index.slice(0, index.lastIndexOf("/") + 1);
  const exhibit = new URL(links[0][1], base).href;
  if (!exhibit.startsWith(base) || !/^[\w.-]+\.htm$/i.test(exhibit.slice(base.length)) || exhibit === index)
    throw new Error(`Unexpected EX-99.1 URL for ${filing.accession}`);
  return exhibit;
}

function fiscalQuarter(ordinal: string, year: string): FiscalQuarter {
  return { year: Number(year), quarter: QUARTERS.indexOf(ordinal.toLowerCase()) + 1 };
}

function quarterOrdinal(period: FiscalQuarter) {
  return period.year * 4 + period.quarter;
}

export function readIssuerRevenue(filing: ResultsFiling, document: string) {
  const text = plain(document);
  const nvidia = filing.ticker === "NVDA";
  const lead = text.slice(0, 1200);
  const heading = nvidia
    ? /NVIDIA Announces Financial Results for (First|Second|Third|Fourth) Quarter (?:and )?Fiscal (\d{4})/i.exec(lead)
    : /AMD Reports (First|Second|Third|Fourth) Quarter (?:and Full Year )?(\d{4}) Financial Results/i.exec(lead);
  if (!heading) throw new Error(`Unreviewed quarterly release format for ${filing.accession}`);
  const period = fiscalQuarter(heading[1], heading[2]);
  const statement = nvidia
    ? /NVIDIA CORPORATION CONDENSED CONSOLIDATED STATEMENTS OF INCOME \(In millions, except per share data\) \(Unaudited\) Three Months Ended (.{1,260}?) Revenue \$\s*([\d,]+)\s/i.exec(text)
    : /ADVANCED MICRO DEVICES, INC\. CONDENSED CONSOLIDATED STATEMENTS OF OPERATIONS \(Millions except per share amounts and percentages\) \(Unaudited\) Three Months Ended (.{1,380}?) Net revenue \$\s*([\d,]+)\s/i.exec(text);
  const ended = MONTH_DATE.exec(nvidia ? (/\bended\s+[A-Z][a-z]+ \d{1,2}, \d{4}/.exec(lead)?.[0] ?? "") : statement?.[1] ?? "")?.[0];
  const day = ended ? new Date(ended + " UTC") : null;
  const periodEnd = day && Number.isFinite(day.getTime()) ? day.toISOString().slice(0, 10) : null;
  const actualMillions = Number(statement?.[2].replaceAll(",", ""));
  if (!periodEnd || periodEnd >= filing.reportDate || !Number.isSafeInteger(actualMillions) || actualMillions <= 0)
    throw new Error(`Missing quarter date or financial-statement revenue for ${filing.accession}`);

  const currentOutlook = /\bCurrent Outlook\b\s*(.{1,1900}?)(?:\bAMD Teleconference\b)/i.exec(text)?.[1] ?? "";
  const guidanceText = nvidia
    ? /NVIDIA's outlook for the (first|second|third|fourth) quarter of fiscal (\d{4})(?:, which includes an additional week,)? is as follows:\s*•?\s*Revenue is expected to be \$([\d.]+) billion, plus or minus (\$[\d.]+ (?:million|billion)|[\d.]+%)/i.exec(text)
    : /For the (first|second|third|fourth) quarter of (\d{4}), AMD expects revenue to be approximately \$([\d.]+) billion, plus or minus (\$[\d.]+ (?:million|billion)|[\d.]+%)/i.exec(currentOutlook);
  if (!guidanceText) throw new Error(`Missing original next-quarter management range for ${filing.accession}`);
  const guidancePeriod = fiscalQuarter(guidanceText[1], guidanceText[2]);
  const midpointMillions = Number(guidanceText[3]) * 1000;
  const tolerance = guidanceText[4].toLowerCase();
  const value = Number(/[\d.]+/.exec(tolerance)?.[0]);
  const radius = tolerance.endsWith("%") ? midpointMillions * (value / 100)
    : value * (tolerance.endsWith("billion") ? 1000 : 1);
  if (quarterOrdinal(guidancePeriod) !== quarterOrdinal(period) + 1 ||
      !Number.isFinite(radius) || !(radius > 0 && radius < midpointMillions))
    throw new Error(`Inconsistent next-quarter management range for ${filing.accession}`);
  return {
    ...filing, period, periodEnd, actualMillions,
    guidance: {
      period: guidancePeriod, midpointMillions,
      lowMillions: Number((midpointMillions - radius).toFixed(6)),
      highMillions: Number((midpointMillions + radius).toFixed(6)),
      tolerance,
    },
  };
}

type Release = ReturnType<typeof readIssuerRevenue>;

export function pairIssuerRevenue(releases: Release[]) {
  const byQuarter = new Map<string, Release>();
  for (const release of releases) {
    const key = `${release.ticker}:${quarterOrdinal(release.period)}`;
    if (byQuarter.has(key)) throw new Error(`Duplicate original earnings release for ${key}`);
    byQuarter.set(key, release);
  }
  return releases.flatMap(actual => {
    const prior = byQuarter.get(`${actual.ticker}:${quarterOrdinal(actual.period) - 1}`);
    if (!prior || quarterOrdinal(prior.guidance.period) !== quarterOrdinal(actual.period)) return [];
    if (prior.acceptedAt >= actual.acceptedAt || prior.periodEnd >= actual.periodEnd ||
        prior.filingDate >= actual.periodEnd)
      throw new Error(`Guidance was not issued before the reported quarter end for ${actual.accession}`);
    const { lowMillions, highMillions, midpointMillions } = prior.guidance;
    const amount = actual.actualMillions;
    const rangeStatus = amount > highMillions ? "above" : amount < lowMillions ? "below" : "within";
    const deviationPercent = 100 * (amount / midpointMillions - 1);
    // SEC acceptance can precede public dissemination. Historical research
    // waits until an exchange session after all the recorded release dates.
    const afterDate = [actual.reportDate, actual.filingDate, newYorkDate(actual.acceptedAt)].sort().at(-1)!;
    return [{ ticker: actual.ticker, actual, prior, rangeStatus, deviationPercent, afterDate }];
  }).sort((a, b) => a.afterDate.localeCompare(b.afterDate));
}
