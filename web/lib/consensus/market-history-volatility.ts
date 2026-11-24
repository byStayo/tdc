import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { exchangeSession, trailingExchangeSessions } from "./exchange-calendar.ts";
import { marketHistoryPreview } from "./market-history-preview.ts";
import { readResearchReceipt } from "./research-price-capture.ts";
import { sourceChunk, sourceFailureKind, sourceResponse } from "./source-failure.ts";
import type { Instrument, Signal } from "./types.ts";

const documentation = "https://getmarkethistory.com/docs/guides/vix-historical-data/";
const dayMs = 86_400_000;
const calendarDays = 100;
const rankNames = ["lowest fifth", "second fifth", "middle fifth", "fourth fifth", "highest fifth"];
const indexes = {
  VIX: { id: 5, name: "S&P 500", catalog: "Volatility Index (S&P 500, 30-day)", scopes: ["MARKET","SPY"] },
  VXN: { id: 24, name: "Nasdaq-100", catalog: "Volatility Index (Nasdaq-100)", scopes: ["QQQ"] },
  RVX: { id: 3, name: "Russell 2000", catalog: "Volatility Index (Russell 2000)", scopes: ["IWM"] },
  VXD: { id: 14, name: "Dow Jones Industrial Average", catalog: "Volatility Index (DJIA)", scopes: ["DIA"] },
  VXTLT: { id: 26, name: "TLT", catalog: "Volatility Index (20+ Year Government Bond ETF)", scopes: ["TLT"] },
  VIX9D: { id: 10, catalog: "Volatility Index (S&P 500, 9-day)" },
  VIX3M: { id: 8, catalog: "Volatility Index (S&P 500, 3-month)" },
} as const;
const ranked = ["VIX", "VXN", "RVX", "VXD", "VXTLT"] as const;
type Rank = typeof ranked[number];
type Index = keyof typeof indexes;
type Measure = Rank | "spx-term";
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type Capture = { catalog: string; bars: string; rowCount: string | null; through: string | null; session: string | null;
  format: string | null; limit: string | null };
type Reading = { day: string; dates: string[]; closes: number[]; retrievedAt: string; vintageAt: string; sha256: string };
type Evidence = Omit<Reading, "closes" | "dates"> & { value: number };
const id = (measure: Measure) => "market-history-iv-" + measure.toLowerCase();
const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const instant = (time: string) => Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time;
const midnight = (s: string) => /^\d{4}-\d\d-\d\dT00:00:00Z$/.test(s) && new Date(s).toISOString() === s.replace("Z",".000Z");

export function volatilityWindow(symbol: Index, capture: Capture, retrievedAt: string): Reading {
  const meta = JSON.parse(capture.catalog), contract = meta.contract;
  const frames = meta.bars?.timeframes?.filter((frame: { timeframe: string }) => frame.timeframe === "1d");
  const frame = frames?.[0], dataset = indexes[symbol];
  const raw = capture.bars.trim().split(/\r?\n/);
  if (!instant(retrievedAt) || meta.ticker !== symbol || meta.dataset !== "volatility/us" ||
      contract?.asset_class !== "volatility" || contract.exchange !== "Cboe" || contract.country !== "US" ||
      contract.status !== "active" || contract.name !== dataset.catalog || frames?.length !== 1 ||
      frame.last !== capture.through || !midnight(frame.last) || !Number.isFinite(Date.parse(frame.updated)) ||
      Date.parse(frame.updated) < Date.parse(frame.last) + dayMs || Date.parse(frame.updated) > Date.parse(retrievedAt) ||
      capture.session !== "UTC 00:00" || capture.format !== "jsonl" || capture.limit !== "100" ||
      String(raw.length) !== capture.rowCount || raw.length > 100 || raw.length < 61)
    throw new Error("Volatility catalogue, observation window or preview headers differ");
  const prices = new Map<string, number>();
  let previous = "";
  for (const line of raw) {
    const bar = JSON.parse(line);
    if (bar.symbol !== symbol || bar.symbol_id !== dataset.id || !midnight(bar.timestamp) || bar.timestamp <= previous ||
        bar.is_gap !== false || bar.gap_fill_method !== 0 || bar.volume !== 0 || bar.trade_count !== 0 ||
        ![bar.open,bar.high,bar.low,bar.close].every(value => Number.isFinite(value) && value > 0) ||
        bar.high < Math.max(bar.close, bar.open) || bar.low > Math.min(bar.close, bar.open))
      throw new Error("Volatility preview contains an invalid index observation");
    prices.set(bar.timestamp.slice(0,10), bar.close);
    previous = bar.timestamp;
  }
  if (previous !== frame.last) throw new Error("Volatility preview and catalogue end on different dates");
  const start = new Date(Date.parse(previous) - calendarDays * dayMs).toISOString().slice(0,10);
  const dates = trailingExchangeSessions(start, previous.slice(0,10)).slice(-61);
  if (dates.length !== 61 || dates.some(date => !prices.has(date)))
    throw new Error("Incomplete 61-session volatility comparison");
  return { day: dates[60], dates, closes: dates.map(date => prices.get(date)!), retrievedAt,
    vintageAt: new Date(frame.updated).toISOString(), sha256: hash(capture) };
}

type CrossCheck = { through: string; rows: [string, number][]; sourceHash: string; rowsHash: string; verifiedAt: string };
type Receipt = { retrievedAt: string; capture: Capture; comparison: CrossCheck };

function verifyComparison(reading: Reading, check: CrossCheck) {
  if (check.through !== reading.day || !instant(check.verifiedAt) || check.verifiedAt < reading.retrievedAt ||
      !/^[a-f0-9]{64}$/.test(check.sourceHash) || !Array.isArray(check.rows) ||
      check.rowsHash !== hash(check.rows) || check.rows.length !== reading.dates.length ||
      check.rows.some(([date, close], i) => date !== reading.dates[i] || !Number.isFinite(close) ||
        Math.abs(close - reading.closes[i]) > 1e-8))
    throw new Error("Market History index closes differ from the Cboe source");
}

async function compareOriginal(symbol: Index, reading: Reading, fetcher: Fetcher): Promise<CrossCheck> {
  const url = "https://cdn-api.cboe.com/api/global/us_indices/daily_prices/" + symbol + "_History.csv";
  const response = await sourceResponse(fetcher, url, { credentials: "omit", redirect: "error",
    headers: { Accept: "text/csv" }, signal: AbortSignal.timeout(15000) });
  const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (response.headers.get("content-type")?.split(";")[0].trim() !== "text/csv")
      throw new Error("Expected an original Cboe volatility CSV");
    for (;;) {
      const part = await sourceChunk(reader);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2000000) throw new Error("Cboe reference exceeds its size bound");
      chunks.push(part.value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  const [header, ...lines] = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim().split(/\r?\n/);
  const expectedHeader = symbol === "VXTLT" ? "DATE,VXTLT" : "DATE,OPEN,HIGH,LOW,CLOSE";
  if (header.trim().toUpperCase() !== expectedHeader) throw new Error("Unexpected original index fields");
  const index = expectedHeader.split(",").length - 1;
  const dates = new Set(reading.dates);
  const rows: [string, number][] = [];
  for (const line of lines) {
    const fields = line.split(",");
    const [month, day, year] = fields[0].split("/");
    const date = year + "-" + month?.padStart(2, "0") + "-" + day?.padStart(2, "0");
    if (dates.has(date)) {
      if (fields.length !== index + 1 || !fields[index].trim()) throw new Error("Invalid Cboe comparison row");
      rows.push([date, Number(fields[index])]);
    }
  }
  const check = { through: reading.day, rows, sourceHash: createHash("sha256").update(bytes).digest("hex"),
    rowsHash: hash(rows), verifiedAt: new Date().toISOString() };
  verifyComparison(reading, check);
  return check;
}

async function collectIndex(symbol: Index, fetcher: Fetcher, directory?: string) {
  const [meta, bars] = await Promise.all([marketHistoryPreview("volatility/us/" + symbol, fetcher),
    marketHistoryPreview("bars/volatility/us/" + symbol + "/1d", fetcher)]);
  const h = bars.headers;
  const capture: Capture = { catalog: meta.text, bars: bars.text, rowCount: h.get("x-row-count"), through: h.get("x-data-through"),
    session: h.get("x-session"), format: h.get("x-format"), limit: h.get("x-preview-limit") };
  const retrievedAt = new Date().toISOString();
  const reading = volatilityWindow(symbol, capture, retrievedAt);
  const file = directory ? join(directory, reading.day, symbol + "-checked-" + reading.sha256 + ".json") : undefined;
  async function saved() {
    if (!file) return null;
    const prior = await readResearchReceipt<Receipt>(file);
    if (!prior) return null;
    const now = new Date().toISOString();
    if (prior.retrievedAt > now || prior.comparison?.verifiedAt > now || hash(prior.capture) !== reading.sha256)
      throw new Error("Volatility evidence differs from its private receipt");
    const original = volatilityWindow(symbol, prior.capture, prior.retrievedAt);
    verifyComparison(original, prior.comparison);
    return { ...original, retrievedAt: prior.comparison.verifiedAt };
  }
  const prior = await saved();
  if (prior) return prior;
  const comparison = await compareOriginal(symbol, reading, fetcher);
  if (directory && file) {
    await durableDirectory(join(directory, reading.day), 0o700);
    try { await durableJSON(file, { retrievedAt, capture, comparison }, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const concurrent = await saved();
      if (!concurrent) throw error;
      return concurrent;
    }
  }
  return { ...reading, retrievedAt: comparison.verifiedAt };
}

function signal(measure: Measure, retrievedAt: string, sample?: Evidence): Signal {
  const curve = measure === "spx-term";
  const name = curve ? "S&P 500" : indexes[measure].name;
  const title = name + (curve ? " volatility term structure" : " implied volatility");
  const instruments: Instrument[] = curve ? ["MARKET", "SPY"] : [...indexes[measure].scopes];
  const label = curve ? "Nine-day volatility relative to three-month volatility" : "Rank against the preceding 60 sessions";
  const unit = curve ? "band" : "of 5";
  let summary = title + " awaits a verified daily index observation.";
  if (sample) summary = curve
    ? "Nine-day S&P 500 implied volatility was " + ["below", "within 5% of", "above"][sample.value + 1] +
      " the three-month reading on " + sample.day + "."
    : name + " 30-day implied volatility ranked in the " + rankNames[sample.value - 1] + " of its recent range on " + sample.day + ".";
  return { id: id(measure), family: "options", title, shortLabel: title, instruments, directionalInstruments: [],
    status: sample ? "available" : "unavailable", summary,
    source: { name: "Market History · Cboe volatility indices", url: documentation, observedAt: sample?.day ?? null, releasedAt: null,
      retrievedAt, ...(sample ? { vintageAt: sample.vintageAt } : {}), sha256: sample?.sha256 ?? null, frequency: "daily index close",
      attribution: "Cboe volatility indices supplied by Market History. Calculations by The Daily Consensus.",
      usage: "Derived risk indicators under Market History’s data licence. https://getmarkethistory.com/docs/terms/" },
    methodology: curve
      ? "Compare VIX9D with VIX3M on the same completed U.S. equity session. A ratio below 0.95 is lower, above 1.05 is higher, and otherwise similar."
      : "Compare the " + measure + " close with the preceding 60 completed U.S. equity sessions. Count half of ties and report the resulting fifth of the distribution. Ignore index observations on U.S. equity holidays.",
    limitation: (measure === "VXTLT" ? "The index uses TLT options." : "The index readings use options on the underlying equity index.") +
      " Implied volatility measures expected variability. Price direction, strike skew and dealer gamma require separate evidence.",
    unit, staleAfterDays: 5, series: sample ? [{ date: sample.day, value: sample.value }] : [],
    metrics: sample ? [{ date: sample.day, value: sample.value, unit, label }] : [], scores: { daily: null, weekly: null, monthly: null } };
}

export async function collectMarketHistoryVolatility(fetcher: Fetcher, directory?: string): Promise<Signal[]> {
  const keys = [...ranked, "VIX9D", "VIX3M"] as const;
  const entries = await Promise.all(keys.map(async key => {
    try { return [key, { reading: await collectIndex(key, fetcher, directory) }] as const; }
    catch (error) { return [key, { failure: sourceFailureKind(error) }] as const; }
  }));
  const records = new Map<Index, { reading?: Reading; failure?: Signal["failureKind"] }>(entries);
  const now = new Date().toISOString();
  const observations = ranked.map(key => {
    const { reading, failure } = records.get(key)!;
    if (!reading) return { ...signal(key, now), failureKind: failure };
    const latest = reading.closes[60];
    const below = reading.closes.slice(0,60).reduce((n, price) => n + (price < latest ? 1 : price === latest ? 0.5 : 0), 0);
    return signal(key, reading.retrievedAt, { ...reading, value: Math.min(5, 1 + Math.floor(below / 12)) });
  });
  const short = records.get("VIX9D")!, long = records.get("VIX3M")!;
  const a = short.reading, b = long.reading;
  if (!a || !b || a.day !== b.day) {
    const failures = [short.failure, long.failure].filter(Boolean);
    observations.push({ ...signal("spx-term", now),
      failureKind: failures.length && failures.every(kind => kind === "transport") ? "transport" : "validation" });
  } else {
    // Decimal boundary ratios can round one binary floating-point step to either side.
    const ratio = a.closes[60] / b.closes[60];
    const tolerance = 4 * Number.EPSILON;
    const later = a.retrievedAt > b.retrievedAt ? a.retrievedAt : b.retrievedAt;
    observations.push(signal("spx-term", later, { day: a.day, retrievedAt: later, vintageAt: a.vintageAt > b.vintageAt ? a.vintageAt : b.vintageAt,
      value: ratio < 0.95 - tolerance ? -1 : ratio > 1.05 + tolerance ? 1 : 0, sha256: hash([a.sha256, b.sha256]) }));
  }
  return observations;
}

export function validateMarketHistoryVolatility(s: Signal) {
  if (!s.id.startsWith("market-history-iv-")) return;
  const measure = ([...ranked, "spx-term"] as const).find(item => id(item) === s.id);
  if (!measure) throw new Error("Unknown volatility indicator");
  const { collectionNote, failureKind, ...reading } = s;
  const { observedAt, vintageAt, retrievedAt, sha256 } = s.source;
  let sample: Evidence | undefined;
  if (s.status === "available") {
    const value = s.series[0]?.value;
    if (!observedAt || !exchangeSession(observedAt) || !vintageAt || !instant(vintageAt) || !instant(retrievedAt) ||
        Date.parse(vintageAt) < Date.parse(observedAt) + dayMs || vintageAt > retrievedAt || !/^[a-f0-9]{64}$/.test(sha256 ?? "") ||
        !Number.isInteger(value) || (measure === "spx-term" ? Math.abs(value) > 1 : value < 1 || value > 5))
      throw new Error("Invalid volatility observation, availability or band");
    sample = { day: observedAt, value, retrievedAt, vintageAt, sha256: sha256! };
  }
  if ((collectionNote !== undefined && collectionNote !== "Refresh unavailable. Showing the last verified observation with its original dates; normal stale-data limits still apply.") ||
      (failureKind !== undefined && (s.status !== "unavailable" || !["transport","validation"].includes(failureKind))) ||
      !isDeepStrictEqual(reading, signal(measure, retrievedAt, sample))) throw new Error("Volatility indicator differs from its public derived-only contract");
}
