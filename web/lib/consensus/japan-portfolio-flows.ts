import { createHash } from "node:crypto";
import { publicDate } from "../public-normalization.ts";
import { policyCsv } from "./policy.ts";
import { sourceFailureKind } from "./source-failure.ts";
import type { Signal } from "./types.ts";

export const JAPAN_PORTFOLIO_FLOWS_ID = "japan-mof-equity-flows";
export const JAPAN_PORTFOLIO_FLOWS_URL = "https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/week.csv";
const releaseSchedule = "https://www.mof.go.jp/english/policy/international_policy/reference/itn_transactions_in_securities/schedule.htm";
const licence = "https://www.digital.go.jp/en/resources/open_data/public_data_license_v1.0";
const title = "International Transactions in Securities (Weekly; based on reports from designated major investors)";
const equity = "Equity and investment fund shares";
const unit = "100 million JPY";
const frequency = "weekly designated-investor transactions";
const staleAfterDays = 21;
const metricLabels = ["Residents' net foreign equity and fund purchases", "Nonresidents' net Japan equity and fund purchases"] as const;
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const attribution = "Ministry of Finance Japan, International Transactions in Securities. Dates and rows selected and labels adapted by The Daily Consensus.";
const usage = "Public Data License 1.0 (" + licence + "). Attributed reuse and adaptation permitted. Publication does not imply endorsement by the Ministry.";

interface JapanPortfolioDocument {
  bytes: Uint8Array;
  retrievedAt: string;
}

function date(year: number, month: number, day: number): string {
  const value = [String(year), String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
  if (!publicDate(value)) throw new Error("Invalid Japan portfolio flow date");
  return value;
}

function isoTimestamp(value: string): boolean {
  return !!publicDate(value) && new Date(value).toISOString() === value;
}

function scheduledAvailability(vintage: string): string {
  return new Date(vintage + "T08:50:00+09:00").toISOString();
}

function periodStartAndEnd(period: string) {
  const match = /^(20\d{2})\.(\d{1,2})\.(\d{1,2})\s*~\s*(?:(20\d{2})\.)?(\d{1,2})\.(\d{1,2})$/.exec(period);
  if (!match) throw new Error("Unexpected Japan portfolio flow period");
  const [, year, startMonth, startDay, endingYear, endMonth, endDay] = match;
  const start = date(Number(year), Number(startMonth), Number(startDay));
  const end = date(endingYear ? Number(endingYear) : Number(year) + (Number(endMonth) < Number(startMonth) ? 1 : 0), Number(endMonth), Number(endDay));
  if (Date.parse(end) - Date.parse(start) !== 6 * 86_400_000)
    throw new Error("Japan portfolio flow period is not one full week");
  return { start, end };
}

function integer(cell: string): number {
  const number = Number(cell.replaceAll(",", ""));
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(cell) || !Number.isSafeInteger(number))
    throw new Error("Invalid Japan portfolio flow amount");
  return number;
}

function netFlow(row: string[], acquisition: number): number {
  const [buy, sell, net] = row.slice(acquisition, acquisition + 3).map(integer);
  if (buy < 0 || sell < 0 || Math.abs(buy - sell - net) > 1)
    throw new Error("Japan portfolio net flow does not reconcile to the gross amounts");
  return net;
}

function readLatest(bytes: Uint8Array, latestPermittedAt: string) {
  if (!bytes.length || bytes.byteLength > 500_000) throw new Error("Invalid Japan portfolio CSV size");
  const text = new TextDecoder("shift_jis", { fatal: true }).decode(bytes);
  const rows = policyCsv(text).map(row => row.map(cell => cell.normalize("NFKC").trim()));
  const header = rows.find(row => row[0] === title);
  const stamp = /^Final Update\s+([A-Za-z]+)\s+(\d{1,2})\s*,\s*(20\d{2})$/.exec(header?.[19] ?? "");
  const month = stamp && months.indexOf(stamp[1]) + 1;
  if (!stamp || !month || !rows.some(row => row[19] === "Unit: 100 million Yen"))
    throw new Error("Missing Japan portfolio vintage or currency units");
  const vintageAt = date(Number(stamp[3]), month, Number(stamp[2]));
  if (scheduledAvailability(vintageAt) > latestPermittedAt)
    throw new Error("Japan portfolio file precedes its scheduled release");
  const geography = rows.findIndex(row => row[1] === "1. Portfolio Investment Assets" && row[12] === "2. Portfolio Investment Liabilities");
  const category = rows.findIndex(row => row[1] === equity && row[12] === equity);
  const measures = rows.findIndex(row => [1, 12].every(column =>
    row[column] === "Acquisition" && row[column + 1] === "Disposition" && row[column + 2] === "Net"));
  if (!header || header.length !== 23 || geography < 0 || category <= geography || measures <= category)
    throw new Error("Unexpected Japan portfolio geography, equity or measure columns");
  const candidates = rows.slice(measures + 1).filter(row => /^20\d{2}\./.test(row[0]));
  if (!candidates.length) throw new Error("Japan portfolio weekly rows missing");
  let observedAt = "";
  let lastRow: string[] = [];
  for (const row of candidates) {
    if (row.length !== 23) throw new Error("Unexpected Japan portfolio weekly row width");
    const period = periodStartAndEnd(row[0].replaceAll("〜", "~"));
    if (period.start <= observedAt || period.end > vintageAt)
      throw new Error("Japan portfolio weekly dates overlap, are unordered, or are future-dated");
    observedAt = period.end;
    lastRow = row;
  }
  return { observedAt, vintageAt, residentsNet: netFlow(lastRow, 1), nonresidentsNet: netFlow(lastRow, 12) };
}

export async function collectJapanPortfolioFlows(
  read: (url: string) => Promise<JapanPortfolioDocument>,
  cutoff?: string,
): Promise<Signal> {
  const base: Signal = {
    id: JAPAN_PORTFOLIO_FLOWS_ID, title: "Japan · cross-border equity flows", shortLabel: "Japan equity flows",
    family: "international", instruments: ["MARKET"], directionalInstruments: [], status: "unavailable",
    summary: "Japan's Ministry of Finance did not return a usable weekly equity observation.",
    source: { name: "Japan Ministry of Finance · International Transactions in Securities", url: JAPAN_PORTFOLIO_FLOWS_URL,
      observedAt: null, releasedAt: null, retrievedAt: cutoff ?? new Date().toISOString(), sha256: null, frequency, attribution, usage },
    methodology: "Read the latest completed weekly row for residents' net purchases of foreign equity and investment-fund shares and nonresidents' net purchases of Japanese equity and fund shares. Positive amounts represent net acquisition. The week-end observation date and file update date are distinct. Require the Ministry's 8:50 a.m. Tokyo release boundary (" + releaseSchedule + ").",
    limitation: "Based on designated Japanese major investors, including banks, securities firms, insurers and fund managers. The CSV can revise prior periods and does not give its original release timestamp. Equity and fund shares include more than listed stocks. Japan provides part of international coverage. No forecast vote.",
    series: [], metrics: [], scores: { daily: null, weekly: null, monthly: null }, staleAfterDays, unit,
  };
  try {
    const document = await read(JAPAN_PORTFOLIO_FLOWS_URL);
    if (!isoTimestamp(document.retrievedAt) || (cutoff !== undefined && (!isoTimestamp(cutoff) || document.retrievedAt > cutoff)))
      throw new Error("Invalid Japan portfolio retrieval time");
    const { observedAt, vintageAt, residentsNet, nonresidentsNet } = readLatest(document.bytes, document.retrievedAt);
    return { ...base, status: "available",
      summary: "Week ended " + observedAt + ": residents' net foreign equity and fund purchases " + residentsNet.toLocaleString("en-US") + " and nonresidents' net Japan purchases " + nonresidentsNet.toLocaleString("en-US") + " (100 million JPY).",
      source: { ...base.source, retrievedAt: document.retrievedAt, observedAt, vintageAt,
        sha256: createHash("sha256").update(document.bytes).digest("hex") },
      series: [{ date: observedAt, value: residentsNet }],
      metrics: metricLabels.map((label, i) => ({ label, unit, date: observedAt, value: i === 0 ? residentsNet : nonresidentsNet })),
    };
  } catch (error) {
    return { ...base, failureKind: sourceFailureKind(error) };
  }
}

export function validateJapanPortfolioFlows(signal: Signal): void {
  if (signal.id !== JAPAN_PORTFOLIO_FLOWS_ID) return;
  const { source, series, metrics } = signal;
  if (signal.family !== "international" || signal.instruments.join() !== "MARKET" ||
      !signal.directionalInstruments || signal.directionalInstruments.length ||
      Object.values(signal.scores).some(score => score !== null) ||
      signal.unit !== unit || signal.staleAfterDays !== staleAfterDays || source.frequency !== frequency ||
      source.url !== JAPAN_PORTFOLIO_FLOWS_URL || source.releasedAt !== null ||
      source.attribution !== attribution || source.usage !== usage || !isoTimestamp(source.retrievedAt))
    throw new Error("Invalid Japan portfolio source scope, rights or voting contract");
  if (signal.status === "unavailable") {
    if (series.length || metrics.length || source.observedAt || source.vintageAt || source.sha256)
      throw new Error("Unavailable Japan portfolio source contains observations");
    return;
  }
  const { observedAt, vintageAt, sha256 } = source;
  if (!observedAt || !vintageAt || publicDate(observedAt) !== observedAt || publicDate(vintageAt) !== vintageAt ||
      observedAt > vintageAt || scheduledAvailability(vintageAt) > source.retrievedAt || !/^[0-9a-f]{64}$/.test(sha256 ?? "") ||
      series.length !== 1 || series[0].date !== observedAt || metrics.length !== 2 ||
      metrics.some((metric, i) => metric.label !== metricLabels[i] || metric.unit !== unit || metric.date !== observedAt || !Number.isSafeInteger(metric.value)) ||
      series[0].value !== metrics[0].value)
    throw new Error("Invalid Japan portfolio source dates or observations");
}
