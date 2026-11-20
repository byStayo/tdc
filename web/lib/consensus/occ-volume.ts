import { createHash } from "node:crypto";
import { exchangeSession, hasReviewedCalendar } from "./exchange-calendar.ts";
import { newYorkDate } from "./time.ts";

export const OCC_VOLUME_SYMBOLS = ["SPY", "QQQ", "IWM", "DIA", "TLT"] as const;
export const OCC_VOLUME_DOCUMENTATION = "https://www.theocc.com/market-data/market-data-reports/other-market-data-info/batch-processing/volume-query-batch-processing";
const OCC_VOLUME_URL = "https://marketdata.theocc.com/volume-query";
const MAX_REPORT_BYTES = 64 * 1024;
const DAY_MS = 86_400_000;

type OccVolumeSymbol = typeof OCC_VOLUME_SYMBOLS[number];
export interface OccVolumeReport {
  symbol: OccVolumeSymbol;
  url: string;
  retrievedAt: string;
  sha256: string;
  rows: number;
  customerCalls: number;
  customerPuts: number;
}

export interface OccVolumeCapture {
  schemaVersion: 1;
  activityDate: string;
  capturedAt: string;
  documentation: typeof OCC_VOLUME_DOCUMENTATION;
  reports: OccVolumeReport[];
}

function canonicalInstant(value: string) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

/** Use the last trading date strictly before today. A clearing report is not guaranteed at the closing bell. */
export function previousOccSession(now: string): string {
  if (!canonicalInstant(now) || !hasReviewedCalendar(newYorkDate(now)))
    throw new Error("OCC capture time is outside the reviewed exchange calendar");
  let candidate = Date.parse(newYorkDate(now)) - DAY_MS;
  for (;;) {
    const day = new Date(candidate).toISOString().slice(0, 10);
    if (!hasReviewedCalendar(day)) throw new Error("No prior OCC session within the reviewed calendar");
    if (exchangeSession(day)) return day;
    candidate -= DAY_MS;
  }
}

export function occVolumeURL(symbol: OccVolumeSymbol, day: string) {
  if (!OCC_VOLUME_SYMBOLS.includes(symbol) || !exchangeSession(day))
    throw new Error("Expected one of the five ETFs and a reviewed exchange session");
  const url = new URL(OCC_VOLUME_URL);
  url.search = new URLSearchParams({
    reportDate: day.replaceAll("-", ""),
    format: "csv",
    volumeQueryType: "O",
    symbolType: "U",
    symbol,
    reportType: "D",
    accountType: "C",
    productKind: "ALL",
    porc: "BOTH",
  }).toString();
  return url.href;
}

function columns(line: string) {
  // The report contains only delimited identifiers, dates and integers. A
  // quoted comma or an escaped quote is outside this documented record layout.
  return line.split(",").map((value) => value.trim().replace(/^"([^"]*)"$/, "$1"));
}

export function parseOccCustomerVolume(csv: string, symbol: OccVolumeSymbol, day: string) {
  if (!exchangeSession(day)) throw new Error("OCC volume requires a reviewed exchange session");
  const lines = csv.trim().split(/\r?\n/);
  const header = columns(lines[0]).join(",").toLowerCase();
  if (header !== "quantity,underlying,symbol,actype,porc,exchange,actdate")
    throw new Error("OCC response is an error or has an unexpected CSV header");
  const reportedDate = `${day.slice(5, 7)}/${day.slice(8)}/${day.slice(0, 4)}`;
  const seen = new Set<string>();
  let customerCalls = 0, customerPuts = 0;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const fields = columns(line);
    const [quantity, underlying, root, accountType, side, exchange, activityDate, expiry] = fields;
    // OCC documents an optional contract date in position 8, although the
    // header names only the first seven positions. The all-expiries query
    // must not be replaced by an expiry-filtered or mixed-scope response.
    if (fields.length < 7 || fields.length > 8 || expiry)
      throw new Error("OCC response is not the all-expiries volume report");
    if (underlying !== symbol || accountType !== "C" || activityDate !== reportedDate ||
        !/^[A-Z0-9]{1,12}$/.test(root) || !/^[A-Z0-9]{1,12}$/.test(exchange) ||
        (side !== "C" && side !== "P") || !/^\d+$/.test(quantity))
      throw new Error("OCC response has the wrong ETF, date, account or row values");
    const key = `${root}:${side}:${exchange}`;
    if (seen.has(key)) throw new Error("Duplicate OCC customer volume row");
    seen.add(key);
    if (side === "C") customerCalls += Number(quantity);
    else customerPuts += Number(quantity);
  }
  if (!validTotals(customerCalls, customerPuts) || seen.size < 2)
    throw new Error("OCC response lacks complete positive customer put and call totals");
  return { rows: seen.size, customerCalls, customerPuts };
}

function validTotals(calls: number, puts: number) {
  return Number.isSafeInteger(calls) && calls > 0 &&
    Number.isSafeInteger(puts) && puts > 0 &&
    Number.isSafeInteger(calls + puts);
}

async function readBoundedReport(response: Response): Promise<Buffer> {
  if (!response.body) throw new Error("OCC returned no report body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REPORT_BYTES) throw new Error("OCC report exceeded the size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

export async function collectOccVolume(
  activityDate: string,
  fetchReport = fetch,
  clock = () => new Date().toISOString(),
): Promise<OccVolumeCapture> {
  if (activityDate !== previousOccSession(clock()))
    throw new Error("OCC collection requires the immediately preceding reviewed exchange date");
  const reports: OccVolumeReport[] = [];
  for (const symbol of OCC_VOLUME_SYMBOLS) {
    const url = occVolumeURL(symbol, activityDate);
    try {
      const response = await fetchReport(url, {
        headers: {
          Accept: "text/csv, application/octet-stream",
          "User-Agent": "The Daily Consensus source research support@thedailyconsensus.com",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`OCC returned HTTP ${response.status}`);
      }
      const bytes = await readBoundedReport(response);
      const retrievedAt = clock();
      const csv = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      reports.push({
        symbol, url, retrievedAt, sha256: createHash("sha256").update(bytes).digest("hex"),
        ...parseOccCustomerVolume(csv, symbol, activityDate),
      });
    } catch (error) {
      throw new Error(`${symbol} ${activityDate} volume capture failed: ${(error as Error).message}`);
    }
  }
  return validateOccVolumeCapture({
    schemaVersion: 1, activityDate, capturedAt: reports.at(-1)!.retrievedAt,
    documentation: OCC_VOLUME_DOCUMENTATION, reports,
  }, activityDate);
}

export function validateOccVolumeCapture(
  capture: OccVolumeCapture,
  expectedDate: string,
): OccVolumeCapture {
  if (capture?.schemaVersion !== 1 || capture.activityDate !== expectedDate ||
      capture.documentation !== OCC_VOLUME_DOCUMENTATION ||
      !canonicalInstant(capture.capturedAt) ||
      capture.activityDate !== previousOccSession(capture.capturedAt) ||
      !Array.isArray(capture.reports) || capture.reports.length !== OCC_VOLUME_SYMBOLS.length)
    throw new Error("Invalid OCC research capture");
  for (const [index, symbol] of OCC_VOLUME_SYMBOLS.entries()) {
    const report = capture.reports[index];
    if (!report || report.symbol !== symbol || report.url !== occVolumeURL(symbol, expectedDate) ||
        !canonicalInstant(report.retrievedAt) || report.retrievedAt > capture.capturedAt ||
        (index > 0 && report.retrievedAt < capture.reports[index - 1].retrievedAt) ||
        previousOccSession(report.retrievedAt) !== expectedDate ||
        typeof report.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(report.sha256) ||
        !Number.isSafeInteger(report.rows) || report.rows < 2 ||
        !validTotals(report.customerCalls, report.customerPuts))
      throw new Error(`Invalid OCC report receipt for ${symbol}`);
  }
  if (capture.reports.at(-1)!.retrievedAt !== capture.capturedAt)
    throw new Error("OCC capture time does not match its last response");
  return capture;
}

export function occCapturePrecedesOutcome(capture: OccVolumeCapture, cutoff: string, entryAt: string) {
  return canonicalInstant(cutoff) && canonicalInstant(entryAt) &&
    cutoff < entryAt && capture.capturedAt <= cutoff &&
    capture.activityDate === previousOccSession(entryAt);
}
