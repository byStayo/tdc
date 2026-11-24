import { createHash } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { collectResearchPrices, readResearchReceipt } from "../lib/consensus/research-price-capture.ts";
import { digest, verifyPublicationTree } from "../lib/consensus/history.ts";
import { HISTORICAL_RESEARCH_CALENDAR, historicalResearchSession, historicalResearchSessions } from "../lib/consensus/research-session-calendar.ts";
import { isFullKibotSession, KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { marketHistoryPreview } from "../lib/consensus/market-history-preview.ts";
import { newYorkDate, newYorkTimestamp } from "../lib/consensus/time.ts";
import { trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";

const web = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(web, ".consensus/private-spy-close-location");
const method = "prelaunch-spy-close-location-2025-v1";
const policy = {
  method, symbol: "SPY", family: "technicals", year: 2025,
  input: "Free Market History stocks/us daily dated preview, raw consolidated New York calendar-day OHLC. Include all trading hours in the day. Year 2025 only; check X-Session and exact NY midnight timestamps; no regular-session or vendor substitution.",
  selector: "Use each complete 2025 NYSE session at most once. End each source civil day at the next New York midnight. Wait 48 full hours, then the first strictly later scheduled 03:00 UTC refresh. The earliest subsequent scheduled target with a 07:48 New York cutoff may use it. When several source dates map to the same target use only the latest scheduled one. Exclude a shortened target or latest source, missing or invalid OHLC, zero source range, artificial or no-trade bars. No carry-forward and no reassigning excluded dates. Ignore non-NYSE calendar bars.",
  feature: "2*(close-low)/(high-low)-1 on the source's raw NY calendar day; positive incremental coefficient hypothesized. Control is ln(close/open) of exactly the same source bar. Combined [control, close location] against control alone, identical pairs.",
  target: "SPY full regular-session close above open (flat is zero). Cached verified unadjusted and split-only independent Kibot records must agree on the intraday direction; no public price rows. Only 2025 dates before the first as-issued forecast.",
  evaluation: "One matched purged chronological 60/20/20 trainCandidate run. At least 120 paired dates and 20 held out, positive close-location coefficient, candidate improves by strictly more than 0.01 Brier over control alone, training base rate and coin. No parameter variations, no prospective reservations.",
  priorExposure: "Same historical year and SPY was used in previously reviewed trend/momentum, scheduled-event, premarket, and closing-hour studies. The input and incremental hypothesis differ; this test does not provide independent prospective validation.",
  sources: ["https://getmarkethistory.com/docs/bars/", "https://getmarkethistory.com/docs/reliability/", "https://getmarkethistory.com/docs/terms/"],
  limitations: "Latest-vintage reconstruction of the provider's historical bars. Nightly timing is a conservative availability proxy, not proof the 2025 input was issued contemporaneously. No production settlement or model promotion.",
} as const;
const policySHA256 = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
const api = "https://getmarkethistory.com/api/v1/";
const start = "2025-01-01T05:00:00Z", end = "2026-01-01T05:00:00Z";
const dayMs = 86_400_000;
const stamp = (day: string, clock: string) => newYorkTimestamp(day.replaceAll("-", "") + "T" + clock)!;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
type Catalog = { source: string; capturedAt: string; sha256: string; text: string };
type Page = Catalog & { attemptedAt: string; headers: Record<string, string | null> };
type DailyBar = { timestamp: string; open: number; high: number; low: number; close: number; trade_count: number;
  volume: number; vwap: number; symbol: string; symbol_id: number; is_gap: boolean; gap_fill_method: number };
const fields = ["content-type", "date", "x-feed", "x-session", "x-row-count", "x-data-through", "x-format",
  "x-preview-limit", "x-preview-from", "x-next-cursor", "x-bars-charged", "link"];

async function register(requireExisting = false) {
  const file = resolve(directory, "policy.json");
  const stored = await readResearchReceipt<{ sha256: string; createdAt: string; spec: typeof policy }>(file);
  if (stored) {
    if (stored.sha256 !== policySHA256 || JSON.stringify(stored.spec) !== JSON.stringify(policy) || !Number.isFinite(Date.parse(stored.createdAt)))
      throw new Error("The saved SPY close-location hypothesis differs from its preregistration");
    return stored;
  }
  if (requireExisting) throw new Error("Offline SPY close-location replay requires the original preregistration");
  await durableDirectory(directory, 0o700);
  const seal = { sha256: policySHA256, createdAt: new Date().toISOString(), spec: policy };
  await durableJSON(file, seal, true);
  return seal;
}

async function catalogue(cached: boolean, seal: Awaited<ReturnType<typeof register>>) {
  const file = resolve(directory, "catalog.json");
  let saved = await readResearchReceipt<Catalog>(file);
  if (!saved) {
    if (cached) throw new Error("Cached SPY instrument catalogue is missing");
    const source = "stocks/us/SPY";
    const { text, sha256 } = await marketHistoryPreview(source, fetch);
    saved = { source: api + source, capturedAt: new Date().toISOString(), sha256, text };
    await durableJSON(file, saved, true);
  }
  const decoded = JSON.parse(saved.text);
  const frame = decoded.bars?.timeframes?.find((v: { timeframe: string; feed: string }) => v.timeframe === "1m" && v.feed === "consolidated");
  if (saved.source !== api + "stocks/us/SPY" || sha(saved.text) !== saved.sha256 || !Number.isFinite(Date.parse(saved.capturedAt)) ||
      Date.parse(saved.capturedAt) < Date.parse(seal.createdAt) || decoded.dataset !== "stocks/us" || decoded.ticker !== "SPY" ||
      decoded.contract?.exchange !== "ARCA" || decoded.contract?.asset_class !== "us_equity" || frame?.venue !== "US consolidated tape" ||
      !(Date.parse(frame.first) <= Date.parse(start)) || !(Date.parse(frame.last) >= Date.parse(end)) ||
      !String(decoded.freshness?.refresh).includes("published by about 07:00 UTC")) throw new Error("SPY source calendar or delivery schedule differs");
  const specification = {
    policySha256: seal.sha256, sourceCatalogSha256: saved.sha256, docSchedule: "The provider starts its nightly job at 03:00 UTC.",
    catalogSchedule: decoded.freshness.refresh,
    rule: "Wait until 07:00 UTC on the run date after the first strictly post-48h 03:00 UTC start; accept only when both 03:00 and 07:00 imply the same first 07:48 New York cutoff. This is a historical scheduled availability assumption; individual load clocks from 2025 are unavailable.",
  };
  const path = resolve(directory, "delivery-policy.json");
  let companion = await readResearchReceipt<typeof specification & { createdAt: string }>(path);
  if (!companion) {
    if (cached) throw new Error("Cached SPY delivery preregistration is missing");
    companion = { ...specification, createdAt: new Date().toISOString() };
    await durableJSON(path, companion, true);
  }
  const { createdAt, ...original } = companion;
  if (digest(original) !== digest(specification) || !Number.isFinite(Date.parse(createdAt)) ||
      Date.parse(createdAt) < Date.parse(saved.capturedAt)) throw new Error("SPY catalogue differs from the sealed delivery schedule");
  return { catalogHash: saved.sha256, deliverySeal: createdAt };
}

function pageRoute(cursor: string | null) {
  const params = new URLSearchParams({ start, end, tz: "exchange", limit: "1000" });
  if (cursor) params.set("cursor", cursor);
  return "bars/stocks/us/SPY/1d?" + params;
}

async function acquirePage(route: string) {
  const lastPath = resolve(directory, "preview-attempt.json");
  const last = await readResearchReceipt<{ attemptedAt: string }>(lastPath);
  if (last) {
    const prior = Date.parse(last.attemptedAt);
    if (!Number.isFinite(prior) || prior > Date.now() + 1_000) throw new Error("Invalid dated-preview attempt clock");
    const wait = 30_500 - (Date.now() - prior);
    if (wait > 0) await new Promise(done => setTimeout(done, wait));
  }
  const attemptedAt = new Date().toISOString();
  await durableJSON(lastPath, { attemptedAt });
  const received = await marketHistoryPreview(route, fetch);
  return { source: api + route, attemptedAt, capturedAt: new Date().toISOString(), sha256: received.sha256,
    headers: Object.fromEntries(fields.map(key => [key, received.headers.get(key)])), text: received.text };
}

export function parseRangePage(page: Page, expectedRoute: string, registeredAt: string) {
  const h = page.headers;
  const lines = page.text.trim().split("\n");
  if (page.source !== api + expectedRoute || sha(page.text) !== page.sha256 ||
      !Number.isFinite(Date.parse(registeredAt)) || !Number.isFinite(Date.parse(page.attemptedAt)) ||
      !Number.isFinite(Date.parse(page.capturedAt)) || Date.parse(page.attemptedAt) < Date.parse(registeredAt) ||
      Date.parse(page.capturedAt) < Date.parse(page.attemptedAt) || !h["content-type"]?.startsWith("application/x-ndjson") ||
      h["x-feed"] !== "consolidated" || h["x-format"] !== "jsonl" ||
      !["exchange America/New_York 00:00", "venue America/New_York 00:00"].includes(h["x-session"] ?? "") ||
      (h["x-bars-charged"] !== null && h["x-bars-charged"] !== "0") || h["x-row-count"] !== String(lines.length) ||
      lines.length > 1000 || !(Date.parse(h["x-data-through"] ?? "") >= Date.parse(end)) ||
      !(Date.parse(h["x-data-through"] ?? "") <= Date.parse(page.capturedAt)) ||
      !(Date.parse(h["x-preview-from"] ?? "") <= Date.parse(start)))
    throw new Error("Dated preview headers, source or time bounds are inconsistent");
  const bars = lines.map(line => JSON.parse(line) as DailyBar);
  for (const bar of bars) {
    if (bar.symbol !== "SPY" || !Number.isSafeInteger(bar.symbol_id) || bar.symbol_id < 1 || !Number.isFinite(Date.parse(bar.timestamp)))
      throw new Error("Invalid or ambiguous SPY identity");
    const instant = Date.parse(bar.timestamp);
    const day = newYorkDate(new Date(instant).toISOString());
    if (Date.parse(stamp(day, "000000")) !== instant || instant < Date.parse(start) || instant >= Date.parse(end))
      throw new Error("Source bar is outside a 2025 New York calendar-day boundary");
  }
  return bars;
}

async function dailyBars(cached: boolean, registeredAt: string) {
  const days = new Map<string, DailyBar>();
  const hashes: string[] = [];
  const tokens = new Set<string>();
  let cursor: string | null = null;
  let previous = "", id: number | undefined;
  do {
    const route = pageRoute(cursor);
    const filename = resolve(directory, "page-" + String(hashes.length).padStart(3, "0") + ".json");
    let page = await readResearchReceipt<Page>(filename);
    if (!page && cached) throw new Error("Cached SPY preview page is missing");
    const saved = !!page;
    page ??= await acquirePage(route);
    const bars = parseRangePage(page, route, registeredAt);
    for (const bar of bars) {
      const day = newYorkDate(new Date(bar.timestamp).toISOString());
      if (day <= previous || (id !== undefined && id !== bar.symbol_id))
        throw new Error("Repeated, unordered or inconsistent SPY preview");
      days.set(day, bar);
      previous = day; id = bar.symbol_id;
    }
    cursor = page.headers["x-next-cursor"];
    if (cursor && (tokens.has(cursor) || cursor.length > 2000 || hashes.length > 4)) throw new Error("Invalid dated preview cursor sequence");
    if (cursor) tokens.add(cursor);
    if (!saved) await durableJSON(filename, page, true);
    hashes.push(page.sha256);
  } while (cursor);
  return { days, hashes };
}

export function rangeDelivery(observed: string) {
  const following = new Date(Date.parse(observed) + dayMs).toISOString().slice(0, 10);
  const aged = Date.parse(stamp(following, "000000")) + 2 * dayMs;
  const nightly = Math.floor(aged / dayMs) * dayMs + 3 * 3_600_000;
  const startTime = nightly <= aged ? nightly + dayMs : nightly;
  return { dayEndedAt: stamp(following, "000000"), start: new Date(startTime).toISOString(),
    available: new Date(startTime + 4 * 3_600_000).toISOString() };
}

function reading(bar: DailyBar | undefined) {
  if (!bar || bar.is_gap !== false || bar.gap_fill_method !== 0 || !Number.isSafeInteger(bar.trade_count) || bar.trade_count < 1 ||
      !Number.isFinite(bar.volume) || bar.volume <= 0 || ![bar.open, bar.high, bar.low, bar.close].every(p => Number.isFinite(p) && p > 0) ||
      bar.high <= bar.low || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) return null;
  return { control: Math.log(bar.close / bar.open), location: 2 * (bar.close - bar.low) / (bar.high - bar.low) - 1 };
}

export function rangeFeatures(bars: Map<string, DailyBar>, sessions: string[]) {
  const cutoffs = sessions.map(day => ({ day, issuedAt: stamp(day, "074800") }));
  const schedule = new Map<string, { observed: string; issuedAt: string; dayEndedAt: string; available: string }>();
  for (const observed of sessions) {
    const { dayEndedAt, start: runAt, available } = rangeDelivery(observed);
    const started = cutoffs.find(point => point.issuedAt > runAt), delivered = cutoffs.find(point => point.issuedAt > available);
    if (started?.day !== delivered?.day) throw new Error("Provider job start and delivery estimate imply different pre-open dates");
    if (delivered) schedule.set(delivered.day, { observed, issuedAt: delivered.issuedAt, dayEndedAt, available });
  }
  const features = new Map<string, { observed: string; issuedAt: string; dayEndedAt: string; available: string; control: number; location: number }>();
  const excluded: Record<string, string> = {};
  for (const day of sessions) {
    const item = schedule.get(day);
    if (!item) { excluded[day] = "no newly available unique source day"; continue; }
    const origin = historicalResearchSession(item.observed), target = historicalResearchSession(day);
    if (!origin || !target || !isFullKibotSession(origin.openAt, origin.closeAt) || !isFullKibotSession(target.openAt, target.closeAt)) {
      excluded[day] = "shortened or unreviewed source or target"; continue;
    }
    const values = reading(bars.get(item.observed));
    if (!values) { excluded[day] = "missing, invalid or zero-range source bar"; continue; }
    features.set(day, { ...item, ...values });
  }
  return { features, excluded };
}

/** Rebuild the sealed historical cohort and both fits; cached replay never fetches or writes a receipt. */
export async function replaySpyCloseLocation(cached: boolean, sourcesOnly = false, expectedBefore?: string) {
  const seal = await register(cached);
  const { catalogHash, deliverySeal } = await catalogue(cached, seal);
  const { days, hashes } = await dailyBars(cached, deliverySeal);
  const sessions = historicalResearchSessions(2025);
  const { features, excluded } = rangeFeatures(days, sessions);
  const sourceSummary = { marketDays: sessions.length, previewBars: days.size, onCalendarBars: sessions.filter(d => days.has(d)).length,
    distinctFeatureTargets: features.size, exclusions: Object.values(excluded).reduce<Record<string, number>>((t, k) => { t[k] = (t[k] ?? 0) + 1; return t; }, {}) };
  const { history } = await verifyPublicationTree(web);
  const before = history[0]?.issuedAt;
  if (!before || (expectedBefore !== undefined && expectedBefore !== before) || before <= end)
    throw new Error("SPY technical cohort must precede the pinned first public forecast");
  if (features.size < 120 || sourcesOnly) return { sourceSummary, result: null };
  const output = resolve(directory, method + ".json");
  const prior = await readResearchReceipt<{ method: string; policySHA256: string; before: string }>(output);
  if (cached && !prior) throw new Error("Offline SPY close-location replay requires the original completed result");
  if (prior && (prior.method !== method || prior.policySHA256 !== seal.sha256 || prior.before !== before))
    throw new Error("Stored SPY close-location study has a different policy or forecast cutoff");
  const priceDirectory = resolve(web, ".consensus/private-technical-momentum");
  const priceLists = await Promise.all([false, true].map(splitAdjusted => collectResearchPrices(priceDirectory, "SPY", sessions,
    { splitAdjusted, cachedOnly: true })));
  const [raw, splits] = priceLists.map(list => new Map(list.flatMap(p => p.sessions.map(b => [b.session, b] as const))));
  const pairs = [...features].flatMap(([target, feature]) => {
    const bar = raw.get(target), split = splits.get(target);
    if (!bar || !split || bar.openAt !== split.openAt || bar.closeAt !== split.closeAt || bar.openAt <= feature.issuedAt || bar.closeAt >= before)
      throw new Error("SPY outcome clock or source receipt differs from the preregistered target");
    if (Math.sign(bar.close - bar.open) !== Math.sign(split.close - split.open)) {
      excluded[target] = "raw and split-only intraday direction differ"; return [];
    }
    const training: TrainingRow = { id: "SPY:" + target, engineVersion: method, issuedAt: feature.issuedAt, labelKnownAt: bar.closeAt,
      features: [feature.control, feature.location], up: bar.close > bar.open ? 1 : 0 };
    return [{ target, feature, training }];
  });
  const rows = pairs.map(p => p.training);
  const combined = trainCandidate(rows, before);
  const control = trainCandidate(rows.map(row => ({ ...row, features: [row.features[0]] })), before);
  const evaluated = combined.status === "evaluated" && control.status === "evaluated";
  if (evaluated && (digest(combined.split) !== digest(control.split) || combined.baseRateBrier !== control.baseRateBrier ||
      combined.coinBrier !== control.coinBrier)) throw new Error("SPY matched models used different test dates or baselines");
  const summary = { ...sourceSummary, pairedTargets: pairs.length, test: evaluated ? combined.split.test : null,
    heldOutFrom: evaluated ? combined.split.testStarts : null, heldOutThrough: evaluated ? combined.split.testEnds : null,
    combinedBrier: evaluated ? combined.candidateBrier : null, controlBrier: evaluated ? control.candidateBrier : null,
    trainingBaseBrier: evaluated ? combined.baseRateBrier : null, coinBrier: evaluated ? combined.coinBrier : null,
    locationCoefficient: evaluated ? combined.model.weights[1] : null,
    clearsResearchMargin: evaluated && combined.promoted && combined.model.weights[1] > 0 && combined.candidateBrier < control.candidateBrier - 0.01 };
  const result = { method, policySHA256, registeredAt: seal.createdAt, before, firstEdition: history[0].id, calendar: HISTORICAL_RESEARCH_CALENDAR.id,
    sources: { catalogHash, pageHashes: hashes, deliverySeal, priceSource: KIBOT_PRICE_CITATION, raw: priceLists[0].map(r => r.sha256),
      splits: priceLists[1].map(r => r.sha256) }, summary, excluded, pairs, combined, control };
  if (prior && digest(prior) !== digest(result)) throw new Error("SPY close-location replay differs from the first verified result");
  if (!prior) await durableJSON(output, result, true);
  return { sourceSummary, result };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(a => !["--register-only", "--sources-only", "--cached-only"].includes(a)) ||
      (args.includes("--register-only") && args.length !== 1)) throw new Error("Use --register-only, --sources-only or --cached-only");
  if (args.includes("--register-only")) {
    const { sha256, createdAt } = await register();
    console.log(JSON.stringify({ method, sha256, createdAt }));
  } else if (args.includes("--cached-only")) {
    const { sourceSummary, result } = await replaySpyCloseLocation(true, args.includes("--sources-only"));
    console.log(JSON.stringify(result?.summary ?? sourceSummary, null, 2));
  } else {
    await durableDirectory(directory, 0o700);
    const lock = resolve(directory, "study.lock");
    await mkdir(lock, { mode: 0o700 });
    try {
      const { sourceSummary, result } = await replaySpyCloseLocation(false, args.includes("--sources-only"));
      console.log(JSON.stringify(result?.summary ?? sourceSummary, null, 2));
    } finally { await rmdir(lock); }
  }
}
