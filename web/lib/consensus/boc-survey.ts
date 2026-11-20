import { publicDate } from "../public-normalization.ts";
import type { PublicDocument } from "./calendars.ts";
import { sourceFailureKind } from "./source-failure.ts";
import type { Signal } from "./types.ts";

export const BOC_SURVEY_ID = "boc-market-participants-survey";
export const BOC_SURVEY_INDEX = "https://www.bankofcanada.ca/publications/market-participants-survey/";
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const plain = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();

function latestRelease(html: string, cutoff: string) {
  const candidates = [...new Set([...html.matchAll(
    /\bhref=["'](https:\/\/www\.bankofcanada\.ca\/(20\d{2})\/(0[1-9]|1[0-2])\/market-participants-survey-(?:first|second|third|fourth)-quarter-of-20\d{2}\/)["']/g,
  )].filter(match => match[2] + "-" + match[3] <= cutoff.slice(0, 7)).map(match => match[1]))].sort();
  const release = candidates.at(-1);
  if (!release || candidates.at(-2)?.split("/").slice(3, 5).join("/") === release.split("/").slice(3, 5).join("/"))
    throw new Error("Missing or ambiguous Bank of Canada survey release");
  return release;
}

function surveyReading(html: string, cutoff: string) {
  const releasedAt = html.match(/<meta\s+name=["']publication_date["']\s+content=["'](20\d{2}-\d\d-\d\d)["']/)?.[1];
  const range = plain(html).match(/survey conducted from [A-Z][a-z]+ \d{1,2}(?:, 20\d{2})? to ([A-Z][a-z]+) (\d{1,2}), (20\d{2})\./);
  const month = range ? months.indexOf(range[1]) + 1 : 0;
  const observedAt = range && month ? [range[3], String(month).padStart(2, "0"), range[2].padStart(2, "0")].join("-") : "";
  if (!releasedAt || !publicDate(releasedAt) || !publicDate(observedAt) || observedAt > releasedAt || releasedAt > cutoff.slice(0, 10))
    throw new Error("Invalid Bank of Canada survey dates");

  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(match => match[1]).filter(table => {
    const caption = plain(table.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] ?? "");
    return /^2\.1 What is your forecast for the Bank of Canada[’']s policy interest rate\?$/.test(caption);
  });
  if (tables.length !== 1) throw new Error("Missing or duplicate survey policy-rate table");
  const table = tables[0];
  const heading = plain(table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1] ?? "");
  if (heading !== "Policy interest rate (%) 25th percentile of responses Median of responses 75th percentile of responses Number of responses")
    throw new Error("Unexpected survey policy-rate table headings");

  let year = "";
  const yearEnd: { year: string; lower: number; median: number; upper: number; count: number }[] = [];
  const body = table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
  for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const label = plain(row[1].match(/<th\b[^>]*>([\s\S]*?)<\/th>/i)?.[1] ?? "");
    if (/^20\d{2}$/.test(label)) { year = label; continue; }
    if (!["December", "Q4"].includes(label) || !year || year < releasedAt.slice(0, 4)) continue;
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => plain(match[1]));
    if (cells.length !== 4 || cells.some(cell => !/^-?\d+(?:\.\d+)?$/.test(cell)))
      throw new Error("Unexpected survey year-end row");
    const [lower, median, upper, count] = cells.map(Number);
    if (lower < -10 || lower > median || median > upper || upper > 50 || !Number.isSafeInteger(count) || count < 1 || count > 500)
      throw new Error("Inconsistent survey rate distribution");
    yearEnd.push({ year, lower, median, upper, count });
  }
  const chosen = yearEnd.sort((a,b) => a.year.localeCompare(b.year))[0];
  if (!chosen || yearEnd[1]?.year === chosen.year) throw new Error("Missing or ambiguous survey year-end forecast");
  return { ...chosen, observedAt, releasedAt };
}

export async function collectBocSurvey(read: (url: string) => Promise<PublicDocument>, now = new Date().toISOString()): Promise<Signal> {
  const base: Signal = {
    id: BOC_SURVEY_ID, title: "Bank of Canada · market participants survey", shortLabel: "Canada policy survey",
    family: "international", instruments: ["MARKET"], directionalInstruments: [], status: "unavailable",
    summary: "No verified Bank of Canada survey release was returned.",
    source: { name: "Bank of Canada · Market Participants Survey", url: BOC_SURVEY_INDEX, retrievedAt: now, observedAt: null,
      releasedAt: null, frequency: "quarterly survey", attribution: "Bank of Canada, Market Participants Survey",
      usage: "Reused with attribution under https://www.bankofcanada.ca/terms/; year-end row selected and reformatted by The Daily Consensus.", sha256: null },
    methodology: "Select the nearest reported calendar year-end on or after the publication year from the policy-rate forecast table. Use the survey fieldwork end as the observation date and the official publication date separately.",
    limitation: "A small survey of market participants. It provides neither an official policy target nor traded event probabilities. No directional vote.",
    series: [], metrics: [], scores: { daily: null, weekly: null, monthly: null }, staleAfterDays: 150, unit: "%",
  };
  try {
    const index = await read(BOC_SURVEY_INDEX);
    const url = latestRelease(index.text, index.retrievedAt);
    const page = await read(url);
    const row = surveyReading(page.text, page.retrievedAt);
    if (!url.includes("/" + row.releasedAt.slice(0, 7).replace("-", "/") + "/"))
      throw new Error("Survey release date differs from its source path");
    return { ...base, status: "available",
      summary: "December " + row.year + " median policy-rate expectation: " + row.median.toFixed(2) + "% from " + row.count + " responses.",
      source: { ...base.source, url, observedAt: row.observedAt, releasedAt: row.releasedAt, retrievedAt: page.retrievedAt, sha256: page.sha256 },
      series: [{ date: row.observedAt, value: row.median }],
      metrics: [
        { label: "25th percentile", value: row.lower, unit: "%", date: row.observedAt },
        { label: "75th percentile", value: row.upper, unit: "%", date: row.observedAt },
        { label: "Responses", value: row.count, unit: "participants", date: row.observedAt },
      ],
    };
  } catch (error) {
    return { ...base, failureKind: sourceFailureKind(error) };
  }
}
