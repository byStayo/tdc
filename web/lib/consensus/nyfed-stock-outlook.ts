import { publicDate } from "../public-normalization.ts";
import type { PublicDocument } from "./calendars.ts";
import { sourceFailureKind } from "./source-failure.ts";
import type { Signal } from "./types.ts";

export const NYFED_STOCK_OUTLOOK_ID = "nyfed-sce-stock-outlook";
export const NYFED_SCE_INDEX = "https://www.newyorkfed.org/microeconomics/sce";
export const NYFED_SCE_ATTRIBUTION =
  "Source: Survey of Consumer Expectations, ©2013-2020 Federal Reserve Bank of New York. The SCE data are available without charge at https://www.newyorkfed.org/microeconomics/sce and may be used subject to license terms posted there. The New York Fed disclaims any responsibility for this analysis and interpretation of Survey of Consumer Expectations data.";
const usage =
  "Terms: https://www.newyorkfed.org/privacy/termsofuse. The Daily Consensus extracted and reformatted the published reading.";
const months = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const strip = (html: string) => html.replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
const releasePattern = /^https:\/\/www\.newyorkfed\.org\/newsevents\/news\/research\/(20\d{2})\/(20\d{2})(\d{2})(\d{2})$/;

function releaseDate(url: string): string {
  const parts = url.match(releasePattern);
  if (!parts || parts[1] !== parts[2]) throw new Error("Invalid New York Fed release link");
  const date = parts.slice(2).join("-");
  if (!publicDate(date)) throw new Error("Invalid New York Fed release date");
  return date;
}

export function latestNyFedStockRelease(html: string): string {
  const origin = new URL(NYFED_SCE_INDEX).origin;
  const urls = new Set<string>();
  for (const [, href] of html.matchAll(/\bhref=["']((?:https:\/\/www\.newyorkfed\.org)?\/newsevents\/news\/research\/20\d{2}\/20\d{6})["']/g)) {
    const url = new URL(href, origin).href;
    releaseDate(url);
    urls.add(url);
  }
  if (urls.size !== 1) throw new Error("Expected one dated Survey of Consumer Expectations release");
  return [...urls][0];
}

export function parseNyFedStockOutlook(html: string, published: string) {
  const plain = strip(html);
  const month = new RegExp(`findings from the (${months.join("|")}) (20\\d{2})\\s*survey\\b`, "i");
  const period = plain.match(month);
  if (!period) throw new Error("Missing Survey of Consumer Expectations reference month");
  const monthNumber = months.findIndex(name => name.toLowerCase() === period[1].toLowerCase()) + 1;
  const observedAt = new Date(Date.UTC(Number(period[2]), monthNumber, 0)).toISOString().slice(0, 10);
  if (observedAt >= published || Date.parse(published) - Date.parse(observedAt) > 45 * 86400000)
    throw new Error("Survey period and publication date do not agree");

  const definition = /mean perceived probability that U\.S\. stock prices will be higher 12 months from now/i;
  const rows = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map(match => strip(match[1])).filter(item => definition.test(item));
  if (rows.length !== 1) throw new Error("Missing or ambiguous stock outlook reading");
  const value = Number(rows[0].match(/\b(?:to|at) (\d+(?:\.\d+)?)%(?:\.|,|$)/i)?.[1]);
  if (!Number.isFinite(value) || value < 0 || value > 100)
    throw new Error("Invalid household stock outlook probability");
  const movement = rows[0].match(/\b(increased|decreased|rose|fell|declined) by (\d+(?:\.\d+)?) percentage points?\b/i);
  return {
    observedAt,
    value,
    change: movement ? Number(movement[2]) * (/^(?:increased|rose)$/i.test(movement[1]) ? 1 : -1) : null,
  };
}

function baseline(now: string): Signal {
  return {
    id: NYFED_STOCK_OUTLOOK_ID,
    family: "retail",
    title: "Household expectations for U.S. stock prices",
    shortLabel: "Household stock outlook",
    instruments: ["MARKET", "SPY", "QQQ", "IWM", "DIA"],
    directionalInstruments: [],
    status: "unavailable",
    summary: "No verified household stock outlook reading was returned.",
    source: {
      name: "New York Fed · Survey of Consumer Expectations",
      url: NYFED_SCE_INDEX,
      retrievedAt: now,
      observedAt: null,
      releasedAt: null,
      frequency: "monthly survey",
      attribution: NYFED_SCE_ATTRIBUTION,
      usage,
      sha256: null,
    },
    methodology: "Use the published mean household probability of higher U.S. stock prices in 12 months. The reference month ends on the observation date. Record the separately dated press release and include the reported monthly change when stated.",
    limitation: "A monthly household survey about a 12-month expectation. It does not measure ETF positions or next-session direction.",
    series: [],
    metrics: [],
    scores: { daily: null, weekly: null, monthly: null },
    staleAfterDays: 70,
    unit: "%",
  };
}

export async function collectNyFedStockOutlook(
  read: (url: string) => Promise<PublicDocument>,
  now = new Date().toISOString(),
): Promise<Signal> {
  const base = baseline(now);
  try {
    const index = await read(NYFED_SCE_INDEX);
    const url = latestNyFedStockRelease(index.text);
    const releasedAt = releaseDate(url);
    if (releasedAt > index.retrievedAt.slice(0, 10)) throw new Error("Future-dated New York Fed release");
    const document = await read(url);
    const { observedAt, value, change } = parseNyFedStockOutlook(document.text, releasedAt);
    const signal: Signal = {
      ...base,
      status: "available",
      summary: `Households assigned a mean ${value.toFixed(1)}% chance that U.S. stocks would be higher in a year.`,
      source: { ...base.source, url, observedAt, releasedAt, retrievedAt: document.retrievedAt, sha256: document.sha256 },
      series: [{ date: observedAt, value }],
      metrics: change === null ? [] : [{ label: "Reported monthly change", value: change, unit: "pp", date: observedAt }],
    };
    validateNyFedStockOutlook(signal);
    return signal;
  } catch (error) {
    return { ...base, failureKind: sourceFailureKind(error) };
  }
}

export function validateNyFedStockOutlook(signal: Signal) {
  if (signal.id !== NYFED_STOCK_OUTLOOK_ID) return;
  const { source } = signal;
  const base = baseline(source.retrievedAt);
  if (signal.family !== "retail" ||
      signal.instruments.join(",") !== base.instruments.join(",") ||
      signal.directionalInstruments?.length !== 0 || Object.values(signal.scores).some(score => score !== null) ||
      source.attribution !== NYFED_SCE_ATTRIBUTION || source.usage !== usage ||
      source.frequency !== base.source.frequency || signal.staleAfterDays !== base.staleAfterDays || signal.unit !== "%")
    throw new Error("Invalid New York Fed stock-outlook admission");
  if (signal.status === "unavailable") {
    if (source.url !== NYFED_SCE_INDEX || source.observedAt !== null || source.releasedAt !== null ||
        source.sha256 !== null || signal.series.length || signal.metrics.length)
      throw new Error("Unavailable New York Fed stock outlook has readings");
    return;
  }
  const [point] = signal.series;
  if (signal.status !== "available" || signal.series.length !== 1 || !point ||
      point.date !== source.observedAt || !publicDate(point.date) ||
      !Number.isFinite(point.value) || point.value < 0 || point.value > 100 ||
      source.releasedAt !== releaseDate(source.url) || point.date >= source.releasedAt ||
      source.releasedAt > source.retrievedAt.slice(0, 10) ||
      signal.metrics.length > 1 || signal.metrics.some(metric => metric.label !== "Reported monthly change" ||
        metric.date !== point.date || metric.unit !== "pp" || !Number.isFinite(metric.value) ||
        point.value - metric.value < 0 || point.value - metric.value > 100))
    throw new Error("Invalid New York Fed stock-outlook reading");
}
