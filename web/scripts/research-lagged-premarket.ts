import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquirePublicationLock, finishPublicationLock } from "../lib/publication-lock.ts";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { collectKibotSeries, isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { ETF_SYMBOLS } from "../lib/consensus/marketparquet.ts";
import { HISTORICAL_RESEARCH_CALENDAR, historicalResearchSession, historicalResearchSessions } from "../lib/consensus/research-session-calendar.ts";
import { sourceChunk, sourceResponse } from "../lib/consensus/source-failure.ts";
import { newYorkTimestamp } from "../lib/consensus/time.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".consensus/private-market-history");
const METHOD = "prelaunch-lagged-premarket-2025-v1";
const YEAR = 2025;
const MAX_BYTES = 2_000_000;
const SOURCES = "https://getmarkethistory.com/docs/bars/#free-sample";
const dayMs = 86_400_000;
type Instrument = typeof ETF_SYMBOLS[number];
type Hour = { timestamp: string; open: number; close: number; trade_count: number; symbol: Instrument; is_gap: boolean };
type Capture = { source: string; sha256: string; capturedAt: string; through: string; count: number; text: string };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function readPrivate<T>(file: string): Promise<T | null> {
  let stat;
  try { stat = await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > 2 * MAX_BYTES) throw new Error("Invalid private Market History receipt");
  return JSON.parse(await readFile(file, "utf8")) as T;
}

function previewUrl(symbol: Instrument) {
  return `https://getmarkethistory.com/api/v1/bars/stocks/us/${symbol}/1h?start=2025-01-01&end=2025-12-31&limit=5000`;
}

function parseHours(capture: Capture, symbol: Instrument): Map<string, Hour> {
  const hours = new Map<string, Hour>();
  if (capture.source !== previewUrl(symbol) || sha256(capture.text) !== capture.sha256 ||
      !Number.isFinite(Date.parse(capture.capturedAt)) || !Number.isFinite(Date.parse(capture.through)) ||
      !Number.isInteger(capture.count) || capture.count < 1 || capture.count > 5000) throw new Error("Invalid dated preview provenance");
  let previous = "";
  for (const line of capture.text.trim().split(/\r?\n/)) {
    const bar = JSON.parse(line) as Hour;
    if (!bar || bar.symbol !== symbol || !/^2025-\d\d-\d\dT\d\d:00:00Z$/.test(bar.timestamp) ||
        !Number.isFinite(Date.parse(bar.timestamp)) || new Date(bar.timestamp).toISOString() !== bar.timestamp.replace("Z", ".000Z") || bar.timestamp <= previous ||
        bar.is_gap !== false || ![bar.open, bar.close].every(value => Number.isFinite(value) && value > 0) ||
        !Number.isSafeInteger(bar.trade_count) || bar.trade_count <= 0) throw new Error(`Invalid ${symbol} UTC preview bar`);
    hours.set(new Date(bar.timestamp).toISOString(), bar);
    previous = bar.timestamp;
  }
  if (hours.size !== capture.count || !previous.startsWith("2025-12-31"))
    throw new Error("Market History preview is incomplete");
  return hours;
}

async function captureHours(symbol: Instrument) {
  const file = resolve(directory, `${symbol}-${YEAR}-1h.json`);
  const cached = await readPrivate<Capture>(file);
  if (cached) return { capture: cached, hours: parseHours(cached, symbol) };
  const source = previewUrl(symbol);
  const response = await sourceResponse(fetch, source, { redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/x-ndjson", "User-Agent": "The Daily Consensus research https://thedailyconsensus.com" } });
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (response.headers.get("x-feed") !== "consolidated" || response.headers.has("x-next-cursor"))
      throw new Error("The requested year must be one complete consolidated preview page");
    for (;;) {
      const chunk = await sourceChunk(reader);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) throw new Error("Market History preview exceeded its size bound");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  const capture = { source, sha256: sha256(text), capturedAt: new Date().toISOString(), text,
    through: response.headers.get("x-data-through") ?? "", count: Number(response.headers.get("x-row-count")) };
  const hours = parseHours(capture, symbol);
  await durableJSON(file, capture, true);
  return { capture, hours };
}

function sessionFeatures(hours: Map<string, Hour>, days: string[]) {
  const full = days.filter(day => {
    const bounds = historicalResearchSession(day)!;
    return isFullKibotSession(bounds.openAt, bounds.closeAt);
  });
  const cutoffs = full.map(day => ({ day, issuedAt: newYorkTimestamp(day.replaceAll("-", "") + "T074800")! }));
  const features = new Map<string, { observed: string; scheduledAvailableAt: string; issuedAt: string; value: number }>();
  let complete = 0;
  for (const day of full) {
    const compact = day.replaceAll("-", "");
    const bars = ["T040000", "T050000", "T060000"].map(clock => hours.get(newYorkTimestamp(compact + clock)!));
    if (bars.some(bar => !bar)) continue;
    complete++;
    // Study the movement within one premarket session on one raw price basis.
    // Use the first nightly 03:00 UTC refresh strictly after the 48-hour lag and
    // the end of extended-hours trading. This is a historical availability proxy.
    const earliest = Date.parse(newYorkTimestamp(compact + "T200000")!) + 2 * dayMs;
    const refresh = Math.floor(earliest / dayMs) * dayMs + 3 * 3_600_000;
    const scheduledAvailableAt = new Date(refresh <= earliest ? refresh + dayMs : refresh).toISOString();
    const target = cutoffs.find(row => row.issuedAt > scheduledAvailableAt);
    if (!target) continue;
    features.set(target.day, { observed: day, issuedAt: target.issuedAt, scheduledAvailableAt,
      value: 10_000 * Math.log(bars[2]!.close / bars[0]!.open) });
  }
  return { complete, features };
}

if (process.argv.length !== 2) throw new Error("This study has a frozen year and no overrides");
const unlock = await acquirePublicationLock(root, "private-lagged-premarket-study");
let failure: { error: unknown } | undefined;
try {
  const { history } = await verifyPublicationTree(root);
  const beforeFirstPublicForecast = history[0]?.issuedAt;
  if (!beforeFirstPublicForecast || beforeFirstPublicForecast <= "2025-12-31T23:59:59.999Z")
    throw new Error("The research period would overlap public outcomes");
  const path = resolve(directory, `${METHOD}.json`);
  const saved = await readPrivate<{ method: string; beforeFirstPublicForecast: string; summary: unknown }>(path);
  if (saved) {
    if (saved.method !== METHOD || saved.beforeFirstPublicForecast !== beforeFirstPublicForecast)
      throw new Error("Saved lagged study differs from its fixed archive boundary");
    console.log(JSON.stringify({ status: "reused_private_study", summary: saved.summary }));
  } else {
    await durableDirectory(directory, 0o700);
    const days = historicalResearchSessions(YEAR);
    const outcomes = [];
    for (const symbol of ETF_SYMBOLS) {
      const { capture, hours } = await captureHours(symbol);
      const { complete, features } = sessionFeatures(hours, days);
      const prices = await collectKibotSeries(symbol, days, { unadjusted: true, sessionClock: historicalResearchSession });
      const pairs = prices.sessions.flatMap(bar => {
        const feature = features.get(bar.session);
        if (!feature || bar.closeAt >= beforeFirstPublicForecast) return [];
        const row: TrainingRow = { id: `${symbol}:${bar.session}`, engineVersion: METHOD,
          issuedAt: feature.issuedAt, labelKnownAt: bar.closeAt, features: [feature.value], up: bar.close > bar.open ? 1 : 0 };
        return [{ row, observed: feature.observed, scheduledAvailableAt: feature.scheduledAvailableAt }];
      });
      const result = trainCandidate(pairs.map(pair => pair.row), beforeFirstPublicForecast);
      outcomes.push({ symbol, complete, hourlyRows: hours.size, marketHistoryHash: capture.sha256,
        asTradedPriceHash: prices.sha256, pairs, result });
    }
    const summary = outcomes.map(({ symbol, complete, hourlyRows, result }) => ({ symbol, complete, hourlyRows,
      samples: result.samples, status: result.status, ...(result.status === "evaluated" ? {
        test: result.split.test, brier: result.candidateBrier, baseRateBrier: result.baseRateBrier, coin: result.coinBrier,
        clearsResearchMargin: result.promoted,
      } : {}) }));
    await durableJSON(path, { method: METHOD, beforeFirstPublicForecast, summary, outcomes,
      calendar: HISTORICAL_RESEARCH_CALENDAR.id, premarketSource: SOURCES, priceSource: KIBOT_PRICE_CITATION,
      policy: "Movement from the 04:00 bar open to 06:00 bar close on the same completed New York premarket session. Latest eligible feature once per 07:48 cutoff, after a scheduled nightly refresh with a 48-hour delay from extended-hours close. This latest-vintage reconstruction has no as-issued receipts or production use.",
    }, true);
    console.log(JSON.stringify({ status: "saved_private_study", summary }));
  }
} catch (error) {
  failure = { error };
  throw error;
} finally { await finishPublicationLock(unlock, failure); }
