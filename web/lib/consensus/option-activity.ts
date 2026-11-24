import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { exchangeSession } from "./exchange-calendar.ts";
import { OCC_VOLUME_SYMBOLS, previousOccSession } from "./occ-volume.ts";
import { latestOptionSession } from "./option-activity-clock.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { sourceChunk, sourceResponse } from "./source-failure.ts";
import { newYorkDate, newYorkTimestamp } from "./time.ts";

const API = "https://getmarkethistory.com/api/v1/";
export const OPTION_ACTIVITY_SOURCE = "https://getmarkethistory.com/docs/bars/";
const METHOD = "opra-matched-monthly-volume-v1";
const DAY = 86_400_000;
type Fund = typeof OCC_VOLUME_SYMBOLS[number];
type Read = (url: string, init?: RequestInit) => Promise<Response>;
type Observed = { symbol: Fund; status: "observed"; putPercent: number; capturedAt: string; receipt: string };
type Missing = { symbol: Fund; status: "unlisted" | "unavailable" };
export type OptionActivity = { method: typeof METHOD; source: typeof OPTION_ACTIVITY_SOURCE; session: string;
  expiry: string; rows: (Observed | Missing)[] };
type ContractRow = { symbol: string; symbol_id: number; covered_through: string; first_timestamp: string };
type Leg = { contract: string; symbolId: number; volume: number; catalogHash: string; metadataHash: string; barsHash: string };
type Pair = { method: typeof METHOD; session: string; expiry: string; symbol: Fund; capturedAt: string;
  anchor: { session: string; close: number; barsHash: string }; strike: number; call: Leg; put: Leg };

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const isHash = (value: string) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isTime = (value: string) => typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const midnight = (day: string) => newYorkTimestamp(day.replaceAll("-", "") + "T000000")!;
const listKeys = (value: object) => Object.keys(value).sort().join(",");
const dateOnly = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** First standard third-Friday expiry at least 21 days ahead. Holiday expiries roll to the prior exchange session. */
export function optionSampleExpiry(session: string) {
  const first = Date.parse(session);
  for (let ms = first + 21 * DAY; ms <= first + 60 * DAY; ms += DAY) {
    const date = new Date(ms);
    if (date.getUTCDay() !== 5 || date.getUTCDate() < 15 || date.getUTCDate() > 21) continue;
    let expiry = ms;
    while (!exchangeSession(dateOnly(expiry))) expiry -= DAY;
    if (expiry >= first + 21 * DAY) return dateOnly(expiry);
  }
  throw new Error("No reviewed standard monthly expiration");
}

async function delivery(path: string, fetcher: Read) {
  const bars = path.startsWith("bars/");
  const response = await sourceResponse(fetcher, API + path, { credentials: "omit", redirect: "error",
    signal: AbortSignal.timeout(15000), headers: { Accept: bars ? "application/x-ndjson" : "application/json" } });
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const mime = bars ? "application/x-ndjson" : "application/json";
    if (!response.headers.get("content-type")?.toLowerCase().includes(mime) ||
        (response.headers.has("x-bars-charged") && response.headers.get("x-bars-charged") !== "0"))
      throw new Error("Unexpected keyless response");
    for (;;) {
      const chunk = await sourceChunk(reader);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 500000) throw new Error("Response exceeds the options sample limit");
      chunks.push(chunk.value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  return { text, sha256: hash(text), headers: response.headers };
}

async function dailyBar(asset: "stocks" | "options", symbol: string, session: string, fetcher: Read) {
  const doc = await delivery(`bars/${asset}/us/${symbol}/1d`, fetcher);
  const headers = doc.headers;
  const lines = doc.text.trim().split(/\r?\n/);
  const target = Date.parse(midnight(session));
  const through = Date.parse(headers.get("x-data-through") ?? "");
  if (headers.get("x-feed") !== "consolidated" || headers.get("x-session") !== "venue America/New_York 00:00" ||
      headers.get("x-row-count") !== String(lines.length) || Number(headers.get("x-preview-limit")) !== 100 ||
      lines.length > 100 || !Number.isFinite(through) || through < target || through > Date.now())
    throw new Error("Unverified consolidated daily sample");
  const rows = lines.map(line => JSON.parse(line));
  const matches = rows.filter(row => Date.parse(row.timestamp) === target);
  if (matches.length !== 1 || matches[0].symbol !== symbol || matches[0].is_gap !== false || matches[0].gap_fill_method !== 0 ||
      !Number.isSafeInteger(matches[0].symbol_id) || matches[0].symbol_id <= 0 || !Number.isSafeInteger(matches[0].trade_count) ||
      matches[0].trade_count < 1 || !Number.isFinite(matches[0].close) || matches[0].close <= 0 ||
      !Number.isFinite(matches[0].volume) || matches[0].volume <= 0 ||
      (asset === "options" && !Number.isSafeInteger(matches[0].volume)))
    throw new Error("Missing or invalid target-session trade bar");
  return { bar: matches[0], sha256: doc.sha256 };
}

async function strikeList(prefix: string, fetcher: Read) {
  const query = new URLSearchParams({ dataset: "options/us", timeframe: "1m", prefix, limit: "1000" });
  const doc = await delivery("symbols?" + query, fetcher);
  const catalog = JSON.parse(doc.text);
  const rows: ContractRow[] = catalog.symbols;
  if (!Array.isArray(rows) || rows.length !== catalog.count || rows.length > 1000 || catalog.truncated !== false ||
      new Set(rows.map(row => row.symbol)).size !== rows.length ||
      rows.some(row => !row.symbol.startsWith(prefix) || !/^\d{8}$/.test(row.symbol.slice(prefix.length)) ||
        !Number.isSafeInteger(row.symbol_id) || row.symbol_id <= 0 || !Number.isFinite(Date.parse(row.first_timestamp)) ||
        !/^\d{4}-\d\d-\d\d$/.test(row.covered_through)))
    throw new Error("Incomplete options catalog or wrong contract identity");
  return { rows, sha256: doc.sha256 };
}

async function observe(symbol: Fund, session: string, expiry: string, fetcher: Read): Promise<Pair | Missing> {
  const root = symbol + expiry.replaceAll("-", "").slice(2);
  const [calls, puts] = await Promise.all([strikeList(root + "C", fetcher), strikeList(root + "P", fetcher)]);
  if (!calls.rows.length && !puts.rows.length) return { symbol, status: "unlisted" };
  const anchorDay = previousOccSession(midnight(session));
  const anchor = await dailyBar("stocks", symbol, anchorDay, fetcher);
  const eligible = (row: ContractRow) => Date.parse(row.first_timestamp) < Date.parse(midnight(session)) &&
    row.covered_through > session;
  const putByStrike = new Map(puts.rows.filter(eligible).map(row => [row.symbol.slice(-8), row]));
  const candidates = calls.rows.filter(row => eligible(row) && putByStrike.has(row.symbol.slice(-8)));
  const strike = (row: ContractRow) => Number(row.symbol.slice(-8)) / 1000;
  candidates.sort((a, b) => Math.abs(strike(a) - anchor.bar.close) - Math.abs(strike(b) - anchor.bar.close) || strike(a) - strike(b));
  const selected = candidates[0];
  if (!selected) throw new Error("No matching contracts with prior trading history");
  async function leg(row: ContractRow, side: "call" | "put", catalogHash: string): Promise<Leg> {
    const [info, day] = await Promise.all([delivery("options/us/" + row.symbol, fetcher), dailyBar("options", row.symbol, session, fetcher)]);
    const meta = JSON.parse(info.text), contract = meta.contract;
    const tape = meta.bars?.timeframes?.find((item: { timeframe: string }) => item.timeframe === "1m");
    const updated = Date.parse(tape?.updated ?? "");
    if (meta.dataset !== "options/us" || meta.ticker !== row.symbol || contract?.underlying !== symbol ||
        contract.type !== side || contract.exchange !== "OPRA" || contract.size !== 100 || contract.style !== "american" ||
        contract.asset_class !== "option" || contract.expiration !== expiry || contract.strike !== strike(row) ||
        tape?.feed !== "consolidated" || tape.venue !== "US listed options (OPRA)" || day.bar.symbol_id !== row.symbol_id ||
        !Number.isFinite(updated) || updated < Date.parse(midnight(dateOnly(Date.parse(session) + DAY))) || updated > Date.now())
      throw new Error("Contract terms or completed provider delivery do not match");
    return { contract: row.symbol, symbolId: row.symbol_id, volume: day.bar.volume, catalogHash, metadataHash: info.sha256, barsHash: day.sha256 };
  }
  const [call, put] = await Promise.all([leg(selected, "call", calls.sha256), leg(putByStrike.get(selected.symbol.slice(-8))!, "put", puts.sha256)]);
  return { method: METHOD, symbol, session, expiry, capturedAt: new Date().toISOString(), strike: strike(selected),
    anchor: { session: anchorDay, close: anchor.bar.close, barsHash: anchor.sha256 }, call, put };
}

function summarize(pair: Pair, symbol: Fund, session: string, expiry: string): Observed {
  if (pair.method !== METHOD || pair.symbol !== symbol || pair.session !== session || pair.expiry !== expiry ||
      !isTime(pair.capturedAt) || newYorkDate(pair.capturedAt) <= session || pair.capturedAt > new Date().toISOString() ||
      !Number.isFinite(pair.strike) || pair.strike <= 0 || !Number.isFinite(pair.anchor?.close) || pair.anchor.close <= 0 ||
      pair.anchor.session !== previousOccSession(midnight(session)) || !isHash(pair.anchor.barsHash))
    throw new Error("Invalid private options sample");
  const root = symbol + expiry.replaceAll("-", "").slice(2);
  const strike = String(Math.round(pair.strike * 1000)).padStart(8, "0");
  for (const [side, leg] of [["C", pair.call], ["P", pair.put]] as const) {
    if (leg?.contract !== root + side + strike || !Number.isSafeInteger(leg.symbolId) || leg.symbolId <= 0 ||
        !Number.isSafeInteger(leg.volume) || leg.volume <= 0 || ![leg.catalogHash, leg.metadataHash, leg.barsHash].every(isHash))
      throw new Error("Invalid private options contract evidence");
  }
  const total = pair.call.volume + pair.put.volume;
  if (!Number.isSafeInteger(total) || pair.call.symbolId === pair.put.symbolId) throw new Error("Invalid matched volume");
  return { symbol, status: "observed", putPercent: Math.round(100 * (pair.put.volume / total)),
    capturedAt: pair.capturedAt, receipt: hash(JSON.stringify(pair)) };
}

export async function collectOptionActivity(directory: string, fetcher: Read = fetch, now = new Date().toISOString(),
  previouslyIssued?: OptionActivity): Promise<OptionActivity> {
  let through = Date.parse(now) - 2 * DAY;
  try {
    const stats = JSON.parse((await delivery("stats", fetcher)).text);
    const last = ["options/us", "stocks/us"].map(id => {
      const dataset = stats.datasets.filter((item: { dataset: string }) => item.dataset === id);
      const frames = dataset.length === 1 ? dataset[0].timeframes.filter((frame: { timeframe: string }) => frame.timeframe === "1m") : [];
      const at = frames?.length === 1 ? Date.parse(frames[0].last) : NaN;
      if (!Number.isFinite(at) || at > Date.parse(now)) throw new Error("Invalid consolidated dataset watermark");
      return at;
    });
    through = Math.min(...last);
  } catch { /* Per-contract delivery and trade checks still apply at the documented 48-hour delay. */ }
  const session = latestOptionSession(now, through), expiry = optionSampleExpiry(session);
  const folder = resolve(directory, session);
  await durableDirectory(folder, 0o700);
  async function collect(symbol: Fund): Promise<Observed | Missing> {
    const file = resolve(folder, symbol + ".json");
    const issued = previouslyIssued?.session === session ? previouslyIssued.rows.find(row => row.symbol === symbol) : undefined;
    const cached = async () => {
      const pair = await readResearchReceipt<Pair>(file);
      if (!pair) return null;
      const row = summarize(pair, symbol, session, expiry);
      if (issued?.status === "observed" && row.receipt !== issued.receipt) throw new Error("Changed as-issued options receipt");
      return row;
    };
    const saved = await cached();
    if (saved) return saved;
    if (issued?.status === "observed") throw new Error("Missing as-issued options receipt");
    let result: Pair | Missing;
    try { result = await observe(symbol, session, expiry, fetcher); }
    catch (error) {
      console.error(`Market History options ${symbol} ${session}: ${error instanceof Error ? error.message : "source unavailable"}`);
      return { symbol, status: "unavailable" };
    }
    if ("status" in result) return result;
    const row = summarize(result, symbol, session, expiry);
    try { await durableJSON(file, result, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const concurrent = await cached();
      if (!concurrent) throw new Error("Concurrent options receipt disappeared");
      return concurrent;
    }
    return row;
  }
  const rows = await Promise.all(OCC_VOLUME_SYMBOLS.map(collect));
  return { method: METHOD, source: OPTION_ACTIVITY_SOURCE, session, expiry, rows };
}

/** Archives expose only dated whole-percent shares and opaque private evidence identifiers. */
export function validateOptionActivity(activity: OptionActivity, cutoff: string) {
  if (listKeys(activity) !== "expiry,method,rows,session,source" || activity.method !== METHOD || activity.source !== OPTION_ACTIVITY_SOURCE ||
      !exchangeSession(activity.session) || activity.session >= newYorkDate(cutoff) || activity.expiry !== optionSampleExpiry(activity.session) ||
      !Array.isArray(activity.rows) || activity.rows.length !== OCC_VOLUME_SYMBOLS.length) throw new Error("Invalid options activity scope");
  for (const [i, row] of activity.rows.entries()) {
    if (row.symbol !== OCC_VOLUME_SYMBOLS[i]) throw new Error("Invalid options activity fund");
    if (row.status === "observed") {
      if (listKeys(row) !== "capturedAt,putPercent,receipt,status,symbol" || !Number.isInteger(row.putPercent) ||
          row.putPercent < 0 || row.putPercent > 100 || !isHash(row.receipt) || !isTime(row.capturedAt) ||
          row.capturedAt > cutoff || newYorkDate(row.capturedAt) <= activity.session) throw new Error("Invalid archived options observation");
    } else if (listKeys(row) !== "status,symbol" || !["unlisted", "unavailable"].includes(row.status)) throw new Error("Invalid options availability");
  }
}
