import { createHash } from "node:crypto";
import type { CashDistribution } from "./corporate-adjustment.ts";
import { sourceChunk, sourceResponse } from "./source-failure.ts";

export type MarketHistoryHour = {
  timestamp: string; symbol: string; symbol_id: number;
  open: number; high: number; low: number; close: number; volume: number; vwap: number;
  trade_count: number; is_gap: boolean; gap_fill_method: number;
};
export type MarketHistoryCapture = {
  source: string; text: string; sha256: string; capturedAt: string; through: string; count: number;
  pages?: { source: string; status?: number; sha256: string; count: number; headers: Record<string, string | null> }[];
};
export type DeliveredMarketHistoryHours = { source: string; status: number; headers: Record<string, string>;
  text: string; sha256: string };
export type MarketHistoryGrid = "exchange" | "Asia/Kolkata";
export type CoreClock = { session: string; openAt: string; closeAt: string };
export type CoreClose = { session: string; closeAt: string; bucketAt: string; close: number; earlyClose: boolean };
const HOUR = 3_600_000;
const instant = (value: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));

/** The legacy anonymous hourly endpoint, retained for historical research captures. */
export async function fetchMarketHistoryHours(
  symbol: string, from: string, through: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<MarketHistoryCapture> {
  if (!/^[A-Z]{1,5}$/.test(symbol) || [from, through].some(day =>
    !/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day) || from > through ||
    Date.parse(through) - Date.parse(from) > 370 * 86_400_000)
    throw new Error("Market History requires a bounded dated hourly request");
  const source = new URL(`https://getmarkethistory.com/api/v1/bars/stocks/us/${symbol}/1h`);
  source.search = new URLSearchParams({ start: from, end: through, limit: "5000", feed: "consolidated", adjust: "raw" }).toString();
  let next = source.href, text = "", count = 0, dataThrough = "", bytes = 0;
  const seen = new Set<string>();
  const pages: NonNullable<MarketHistoryCapture["pages"]> = [];
  while (next) {
    if (seen.has(next) || pages.length >= 8) throw new Error("Market History pagination exceeds its bounded request");
    seen.add(next);
    const response = await sourceResponse(fetcher, next, { redirect: "error", credentials: "omit",
      signal: AbortSignal.timeout(30_000), headers: { Accept: "application/x-ndjson" } });
    const headers = Object.fromEntries(["content-type", "date", "x-feed", "x-row-count", "x-data-through",
      "x-preview-limit", "x-bars-charged", "x-next-cursor"].map(name => [name, response.headers.get(name)]));
    const rows = Number(headers["x-row-count"]);
    if (headers["x-feed"] !== "consolidated" || !headers["content-type"]?.includes("application/x-ndjson") ||
        !/^\d+$/.test(headers["x-row-count"] ?? "") || rows < 1 || rows + count > 5000 ||
        !instant(headers["x-data-through"] ?? "") ||
        (headers["x-bars-charged"] !== null && headers["x-bars-charged"] !== "0")) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Market History free consolidated response headers are invalid");
    }
    if (dataThrough && dataThrough !== headers["x-data-through"]) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Market History data timestamp changed during pagination");
    }
    dataThrough = headers["x-data-through"]!;
    const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const chunk = await sourceChunk(reader);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2_000_000) throw new Error("Market History hourly body exceeds the byte bound");
        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally { reader.releaseLock(); }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    if (body.trim().split(/\r?\n/).length !== rows) throw new Error("Market History page count differs from its header");
    pages.push({ source: next, sha256: createHash("sha256").update(body).digest("hex"), count: rows, headers });
    text += (text && !text.endsWith("\n") ? "\n" : "") + body;
    count += rows;
    const cursor = headers["x-next-cursor"];
    if (cursor) { const page = new URL(source); page.searchParams.set("cursor", cursor); next = page.href; }
    else next = "";
  }
  const capture = { source: source.href, text, sha256: createHash("sha256").update(text).digest("hex"),
    capturedAt: new Date().toISOString(), through: dataThrough, count, pages };
  parseMarketHistoryHours(capture, symbol);
  return capture;
}

function verifyDeliveredPage(capture: MarketHistoryCapture, url: URL, grid: MarketHistoryGrid) {
  const query = url.searchParams, keys = [...query.keys()];
  const page = capture.pages?.[0], headers = page?.headers;
  const from = query.get("start"), end = query.get("end");
  const gridMatches = grid === "exchange" ? [null, "exchange"].includes(query.get("tz")) : query.get("tz") === grid;
  const sessionHeader = grid === "exchange" ? "exchange America/New_York 00:00" : "Asia/Kolkata 00:00";
  if (!from || !end || ![from, end].every(day => /^\d{4}-\d\d-\d\d$/.test(day) && instant(day + "T00:00:00Z")) ||
      from > end || Date.parse(end) - Date.parse(from) > 370 * 86_400_000 || url.hash ||
      keys.length !== new Set(keys).size || keys.some(key => !["start", "end", "adjust", "feed", "limit", "format", "tz"].includes(key)) ||
      query.get("adjust") !== "raw" || query.get("feed") !== "consolidated" ||
      ![null, "jsonl"].includes(query.get("format")) || !gridMatches ||
      (query.has("limit") && (!/^[1-9]\d*$/.test(query.get("limit")!) || Number(query.get("limit")) < capture.count)) ||
      capture.pages?.length !== 1 || !page || !headers || page.status !== 200 || page.source !== capture.source ||
      page.sha256 !== capture.sha256 || page.count !== capture.count || headers["x-feed"] !== "consolidated" ||
      headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/x-ndjson" ||
      headers["x-session"] !== sessionHeader || headers["x-row-count"] !== String(capture.count) ||
      headers["x-data-through"] !== capture.through || headers["x-bars-charged"] !== String(Math.ceil(capture.count / 100) * 100) ||
      headers["x-next-cursor"] || headers["x-limit-clamped"] || /rel\s*=\s*"?next/i.test(headers.link ?? "") ||
      !headers.date || headers.date !== new Date(capture.capturedAt).toUTCString() ||
      Date.parse(headers.date) !== Date.parse(capture.capturedAt) || Buffer.byteLength(capture.text) > 2_000_000)
    throw new Error("Invalid or incomplete signed-in Market History hourly delivery");
}

/** Normalize an owner's completed HTTP response. The provider's Date is the original retrieval clock. */
export function importMarketHistoryHours(delivery: DeliveredMarketHistoryHours, symbol: string, cutoff: string,
  grid: MarketHistoryGrid = "exchange"): MarketHistoryCapture {
  const source = new URL(delivery.source);
  if (source.pathname !== `/query/v1/bars/stocks/us/${symbol}/1h` || typeof delivery.text !== "string")
    throw new Error("Expected a delivered signed-in Market History hourly response");
  const supplied = new Headers(delivery.headers);
  const headers = Object.fromEntries(["content-type", "date", "x-feed", "x-session", "x-row-count", "x-data-through",
    "x-bars-charged", "x-next-cursor", "x-limit-clamped", "link"].map(name => [name, supplied.get(name)]));
  const served = Date.parse(headers.date ?? "");
  if (!instant(cutoff) || !Number.isFinite(served) || served > Date.parse(cutoff)) throw new Error("Invalid Market History delivery date");
  const count = Number(headers["x-row-count"]), { text, sha256 } = delivery;
  const capture: MarketHistoryCapture = { source: delivery.source, text, sha256, count,
    capturedAt: new Date(served).toISOString(), through: headers["x-data-through"] ?? "",
    pages: [{ source: delivery.source, status: delivery.status, count, sha256, headers }] };
  parseMarketHistoryHours(capture, symbol, grid);
  return capture;
}

export function parseMarketHistoryHours(capture: MarketHistoryCapture, symbol: string, grid: MarketHistoryGrid = "exchange"): MarketHistoryHour[] {
  const url = new URL(capture.source);
  const delivered = url.pathname === `/query/v1/bars/stocks/us/${symbol}/1h`;
  if (url.origin !== "https://getmarkethistory.com" || url.username || url.password ||
      (!delivered && (grid !== "exchange" || url.pathname !== `/api/v1/bars/stocks/us/${symbol}/1h`)) ||
      ![null, "raw"].includes(url.searchParams.get("adjust")) ||
      ![null, "consolidated"].includes(url.searchParams.get("feed")) ||
      !instant(capture.capturedAt) || !instant(capture.through) || Date.parse(capture.through) > Date.parse(capture.capturedAt) ||
      !Number.isSafeInteger(capture.count) || capture.count < 1 || capture.count > 5000)
    throw new Error("Invalid Market History provenance");
  if (delivered) verifyDeliveredPage(capture, url, grid);
  if (createHash("sha256").update(capture.text).digest("hex") !== capture.sha256)
    throw new Error("Market History body hash differs from its receipt");
  const from = url.searchParams.get("start"), through = url.searchParams.get("end");
  const start = from ? Date.parse(from) : -Infinity;
  const end = through ? Date.parse(through) + (/^\d{4}-\d\d-\d\d$/.test(through) ? 86_400_000 - 1 : 0) : Infinity;
  let previous = -Infinity, identity: number | undefined;
  const rows = capture.text.trim().split(/\r?\n/).map(line => {
    const row = JSON.parse(line) as MarketHistoryHour;
    if (!row || row.symbol !== symbol || !instant(row.timestamp) ||
        Date.parse(row.timestamp) % HOUR !== (grid === "exchange" ? 0 : HOUR / 2) ||
        !Number.isSafeInteger(row.symbol_id) || row.symbol_id < 1 ||
        row.is_gap !== false || row.gap_fill_method !== 0 ||
        ![row.open, row.high, row.low, row.close, row.volume, row.vwap].every(value => Number.isFinite(value) && value > 0) ||
        row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close) ||
        !Number.isSafeInteger(row.trade_count) || row.trade_count < 1)
      throw new Error("Invalid Market History hourly bar");
    const at = Date.parse(row.timestamp);
    if (at <= previous) throw new Error("Market History hours must be ordered and unique");
    if (identity !== undefined && row.symbol_id !== identity)
      throw new Error("Market History instrument identity changed within one capture");
    if (at < start || at > end || at > Date.parse(capture.through))
      throw new Error("Market History bar is outside its captured range");
    previous = at;
    identity = row.symbol_id;
    return row;
  });
  if (rows.length !== capture.count) throw new Error("Market History row count differs from its receipt");
  return rows;
}

/** The last full hourly bucket ends exactly at the independently scheduled core close. */
export function coreSessionCloses(hours: MarketHistoryHour[], calendar: CoreClock[], dataThrough: string) {
  const byTime = new Map(hours.map(row => [Date.parse(row.timestamp), row]));
  const closes: CoreClose[] = [], missingSessions: string[] = [];
  for (const { session, openAt, closeAt } of calendar) {
    const end = Date.parse(closeAt), at = end - HOUR;
    const row = byTime.get(at);
    if (!row || end > Date.parse(dataThrough)) { missingSessions.push(session); continue; }
    closes.push({ session, closeAt, bucketAt: new Date(at).toISOString(), close: row.close,
      earlyClose: end - Date.parse(openAt) < 6.5 * HOUR });
  }
  return { closes, missingSessions };
}

export function closeMomentum(closes: CoreClose[], expectedSessions: string[], cash: CashDistribution[]) {
  const ordered = [...closes].sort((a, b) => a.session.localeCompare(b.session));
  if (new Set(ordered.map(row => row.session)).size !== ordered.length ||
      ordered.some(row => !expectedSessions.includes(row.session) || !Number.isFinite(row.close) || row.close <= 0) ||
      new Set(cash.map(row => row.session)).size !== cash.length ||
      cash.some(row => !Number.isFinite(row.amount) || row.amount <= 0))
    throw new Error("Invalid close-only adjustment inputs");
  const latest = ordered.at(-1);
  const byDate = new Map(ordered.map(row => [row.session, row]));
  const end = expectedSessions.indexOf(latest?.session ?? "");
  return [1, 5, 20].map(sessions => {
    const window = end >= sessions ? expectedSessions.slice(end - sessions, end + 1) : [];
    const contiguous = window.length === sessions + 1 && window.every(day => byDate.has(day));
    if (!contiguous) return { sessions, status: window.length ? "gap" as const : "insufficient" as const,
      from: window[0] ?? null, through: latest?.session ?? null,
      rawChangePct: null, issuerAdjustedChangePct: null, cashEffectBps: null, actions: [] };
    const first = byDate.get(window[0])!, last = latest!;
    let factor = 1;
    const actions = cash.filter(action => action.session > first.session && action.session <= last.session);
    for (const action of actions) {
      const prior = byDate.get(expectedSessions[expectedSessions.indexOf(action.session) - 1]);
      if (!window.includes(action.session) || !prior || action.amount >= prior.close)
        throw new Error("Cash adjustment lacks its contiguous prior close");
      factor *= (prior.close - action.amount) / prior.close;
    }
    const rawChangePct = (last.close / first.close - 1) * 100;
    const issuerAdjustedChangePct = (last.close / (first.close * factor) - 1) * 100;
    return { sessions, status: "contiguous" as const, from: first.session, through: last.session,
      rawChangePct, issuerAdjustedChangePct, cashEffectBps: (issuerAdjustedChangePct - rawChangePct) * 100,
      actions: actions.map(action => ({ ...action })) };
  });
}

export function reconcileCoreCloses(
  closes: CoreClose[], raw: { session: string; close: number }[], splits: { session: string; close: number }[],
  toleranceBps = 15,
) {
  if (!Number.isFinite(toleranceBps) || toleranceBps <= 0 || toleranceBps > 25 ||
      new Set(closes.map(row => row.session)).size !== closes.length)
    throw new Error("Invalid core close reconciliation");
  function compare(reference: { session: string; close: number }[]) {
    const byDate = new Map(reference.map(row => [row.session, row.close]));
    if (byDate.size !== reference.length || reference.some(row => !Number.isFinite(row.close) || row.close <= 0))
      throw new Error("Invalid independent close control");
    let compared = 0, matched = 0, maxErrorBps = 0;
    for (const row of closes) {
      const expected = byDate.get(row.session);
      if (expected === undefined) continue;
      const errorBps = Math.abs(row.close / expected - 1) * 10000;
      compared++;
      if (errorBps <= toleranceBps) matched++;
      maxErrorBps = Math.max(maxErrorBps, errorBps);
    }
    return { compared, matched, missing: closes.length - compared, maxErrorBps };
  }
  const rawResult = compare(raw), splitResult = compare(splits);
  return { toleranceBps, raw: rawResult, splits: splitResult,
    qualified: closes.length > 0 && rawResult.matched === closes.length && splitResult.matched === closes.length };
}
