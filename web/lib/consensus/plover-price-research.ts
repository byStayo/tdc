import { createHash } from "node:crypto";
import { adjustETFPrices, type CashDistribution } from "./corporate-adjustment.ts";
import { extendedResearchSessions } from "./extended-research-calendar.ts";
import { boundaryClock, compareMarketHistoryBoundary, contiguousTltWindows } from "./market-history-boundaries.ts";
import { sourceChunk, sourceResponse } from "./source-failure.ts";
import { newYorkTimestamp } from "./time.ts";

export const PLOVER_ORIGIN = "https://ploveranalytics.com";
const credit = "Source: Databento (EQUS.SUMMARY, EQUS.MINI, XNAS.ITCH, XNYS.PILLAR). Market data provided by Databento.";
const MAX_BYTES = 130_000;
const DAY = 86_400_000;
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const fp = (value: string | undefined) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function ploverDelayPassed(day: string, at: string) {
  // Databento relays the final NLS+ summary at about 20:15 New York, including on a market half-day.
  const finalSummary = newYorkTimestamp(day.replaceAll("-", "") + "T201500")!;
  return Date.parse(at) >= Date.parse(finalSummary) + DAY;
}
type Symbol = "SPY" | "QQQ" | "IWM" | "DIA" | "TLT";
type Pair = { session: string; open: number; close: number };
type Ref = Pair & { sha256: string };
type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };
export type PloverCapture = { source: string; capturedAt: string; sha256: string; body: string };
export type TltResearchControls = { from: string; through: string; scope: string; issuer: string | null;
  distributions: CashDistribution[]; review: { day: string; raw: Ref | null; split: Ref | null; listed: Ref | null; issuerCovered: boolean; auction?: Pair }[] };

export function ploverDays(from: string, through: string) {
  if (![from, through].every(day => /^\d{4}-\d\d-\d\d$/.test(day) && Number.isFinite(Date.parse(day)) &&
      new Date(day).toISOString().slice(0, 10) === day) || from < "2024-07-01" || from > through ||
      Date.parse(through) - Date.parse(from) > 35 * DAY) throw new Error("Plover requires at most 36 dates from the EQUS.SUMMARY period");
  const days = extendedResearchSessions(from, through);
  if (!days.length) throw new Error("Plover range contains no exchange session");
  return days;
}

export function ploverSource(symbol: Symbol, from: string, through: string) {
  ploverDays(from, through);
  if (!["SPY", "QQQ", "IWM", "DIA", "TLT"].includes(symbol)) throw new Error("Unsupported Plover ETF");
  return PLOVER_ORIGIN + "/api/v1/us/prices/" + symbol + "?" + new URLSearchParams({ start: from, end: through, limit: "40" });
}

export async function capturePlover(symbol: Symbol, from: string, through: string, fetcher = fetch): Promise<PloverCapture> {
  const source = ploverSource(symbol, from, through);
  const response = await sourceResponse(fetcher, source, { headers: { Accept: "application/json" }, credentials: "omit",
    redirect: "error", signal: AbortSignal.timeout(12_000) });
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json"))
    throw new Error("Plover did not return a native JSON response");
  const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await sourceChunk(reader);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BYTES) throw new Error("Plover response exceeds its bounded window");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  return { source, capturedAt: new Date().toISOString(), sha256: sha(bytes), body: bytes.toString("base64") };
}

export function decodePlover(capture: PloverCapture, symbol: Symbol, from: string, through: string, asOf: string): Bar[] {
  const days = new Set(ploverDays(from, through)), bytes = Buffer.from(capture.body, "base64");
  if (capture.source !== ploverSource(symbol, from, through) || !fp(capture.sha256) || !bytes.length || bytes.length > MAX_BYTES ||
      bytes.toString("base64") !== capture.body || sha(bytes) !== capture.sha256 || !Number.isFinite(Date.parse(capture.capturedAt)) ||
      new Date(capture.capturedAt).toISOString() !== capture.capturedAt || !Number.isFinite(Date.parse(asOf)) ||
      Date.parse(capture.capturedAt) > Date.parse(asOf)) throw new Error("Invalid Plover source receipt");
  const series = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const note = series.provenance?.note;
  if (series.symbol !== symbol || series.start !== from || series.end !== through || !Array.isArray(series.bars) ||
      series.count !== series.bars.length || series.count > days.size || series.provenance?.trust !== "official" ||
      series.provenance.credit !== credit || series.provenance.url !== "https://databento.com/equities" ||
      typeof note !== "string" || !note.includes("EQUS.SUMMARY from 1 July 2024") || !note.includes("bars are as delivered") ||
      !note.includes("one-day delay")) throw new Error("Plover response identity, coverage or price provenance changed");
  let prior = "";
  for (const row of series.bars as Bar[]) {
    if (!row || !days.has(row.date) || row.date <= prior || ![row.open, row.close, row.high, row.low].every(n => Number.isFinite(n) && n > 0) ||
        row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close) || !Number.isSafeInteger(row.volume) || row.volume <= 0)
      throw new Error("Invalid Plover dated OHLCV row");
    if (!ploverDelayPassed(row.date, capture.capturedAt)) throw new Error("Plover daily row precedes the stated redistribution delay");
    prior = row.date;
  }
  return series.bars;
}

/** Numerical source comparisons only. This format is never accepted by the model or the public settlement ledger. */
export function comparePloverTlt(bars: Bar[], refs: TltResearchControls, from: string, through: string) {
  const days = ploverDays(from, through);
  if (refs.scope !== "private-source-qualification" || refs.from !== from || refs.through !== through ||
      !Array.isArray(refs.review) || refs.review.length !== days.length || refs.review.some((r, i) => r.day !== days[i]) ||
      !Array.isArray(refs.distributions) || (!fp(refs.issuer ?? undefined) && (refs.distributions.length || refs.review.some(r => r.issuerCovered))))
    throw new Error("Plover review needs the matching private source controls");
  const byDay = new Map(bars.map(row => [row.date, row]));
  const review = refs.review.map(r => {
    const clock = boundaryClock(r.day)!, row = byDay.get(r.day);
    const boundary = { ...clock, open: row?.open ?? null, close: row?.close ?? null, openingBucket: null, closingBucket: null,
      earlyClose: Date.parse(clock.closeAt) - Date.parse(clock.openAt) < 6.5 * 3_600_000 };
    const checked = (ref: Ref | null) => ref && fp(ref.sha256) ? ref : undefined;
    // Nasdaq Historical and EQUS.SUMMARY can share exchange data. The separate raw/split Kibot comparisons are mandatory.
    const status = compareMarketHistoryBoundary(boundary, checked(r.raw), checked(r.split), checked(r.listed) ?? r.auction, r.issuerCovered, r.auction);
    return { day: r.day, status, boundary, raw: checked(r.raw) ?? null };
  });
  const windows = contiguousTltWindows(review, refs.distributions);
  const cashCheckedWindows = windows.map(window => {
    const first = window[0].day, last = window.at(-1)!.day;
    const cash = refs.distributions.filter(d => d.session >= first && d.session <= last);
    const adjusted = adjustETFPrices(window.map(r => ({ ...boundaryClock(r.day)!, open: r.boundary.open!, close: r.boundary.close! })), cash, []);
    return { from: first, through: last, sessions: adjusted.length, exDates: cash.map(d => d.session) };
  });
  return { scope: "private-price-comparison" as const, instrument: "TLT", from, through, deliveryCount: bars.length,
    days: review.map(({ day, status }) => ({ day, status })), cashCheckedWindows };
}
