import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { strToU8, zipSync } from "fflate";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { loadFirstRatePremarket, prepareFirstRatePremarket } from "../lib/consensus/firstrate.ts";
import { loadDailySessionRanges, prepareFirstRateRanges } from "../lib/consensus/firstrate-ranges.ts";
import { digest } from "../lib/consensus/history.ts";
import { MARKET_HISTORY_ETF_IDS } from "../lib/consensus/market-history-boundaries.ts";
import { etfHourSource } from "../lib/consensus/market-history-hourly-access.ts";
import { loadTltPremarket, prepareTltPremarket } from "../lib/consensus/market-history-premarket.ts";
import { prepareMarketHistoryRanges } from "../lib/consensus/market-history-ranges.ts";
import { recordPreopenReceipt, verifyPreopenWithMorningConfirmation } from "../lib/consensus/preopen-receipt.ts";
import { newYorkDate } from "../lib/consensus/time.ts";
import { readPreviousPremarketFeature } from "../lib/consensus/previous-premarket-features.ts";
import { RANGE_POLICY_V2 } from "../lib/consensus/regular-session-range.ts";
import { tltPremarketClocks } from "../lib/consensus/tlt-premarket-signal.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

const day = "2026-11-20", target = "2026-11-23";
const tapeAt = target + "T12:20:00.000Z", rangeAt = target + "T12:23:00.000Z", cutoff = target + "T12:30:00.000Z";
const privateFR = ".consensus/private-firstrate", privateMH = ".consensus/private-market-history";
const header = "timestamp,open,high,low,close,volume\n";
const docs = "Two weeks of split-adjusted sample data. Timestamps run from the start of the period. " +
  "Timezone is US Eastern Time. Times with zero volume are omitted. https://firstratedata.com/about/license";
const sha = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");
const read = (root: string, snapshot: Snapshot) => readPreviousPremarketFeature(root, snapshot, "SPY", target);

async function put(path: string, data: object | string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof data === "string" || data instanceof Uint8Array ? data : JSON.stringify(data), { mode: 0o600 });
}
async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prospective-prior-premarket-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "scripts"));
  for (const script of ["collect-firstrate-inputs.py", "issuer_corporate_actions.py"])
    await copyFile(new URL("../scripts/" + script, import.meta.url), join(root, "scripts", script));
  return root;
}
async function sample(root: string, missingBoundary = false) {
  const minutes: string[] = [], five: string[] = [];
  for (let m = 240; m < 960; m++) {
    const stamp = day + " " + String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0") + ":00";
    const regular = m >= 570;
    const values = (last: number) => [100, regular ? 110 : 102, regular ? 90 : 98, regular ? 105 : last === 569 ? 98.753 : 100];
    if (!(m === 240 && missingBoundary)) minutes.push([stamp, ...values(m), 1].join(","));
    if (!(m % 5)) five.push([stamp, ...values(m + 4), m === 240 && missingBoundary ? 4 : 5].join(","));
  }
  const body = zipSync({ "_readme_documentation.txt": strToU8(docs), "SPY_1day_sample.csv": strToU8(header + day + ",100,110,90,105,1000"),
    "SPY_1min_sample.csv": strToU8(header + minutes.join("\n")), "SPY_5min_sample.csv": strToU8(header + five.join("\n")) });
  const base = join(root, privateFR, "captures", day, "sample-SPY");
  await put(base + ".bin", body);
  await put(base + ".json", { url: "https://frd001.s3.us-east-2.amazonaws.com/frd_sample_etf_SPY.zip", sha256: sha(body),
    lastModified: new Date(day + "T22:00:00Z").toUTCString(), capturedAt: day + "T23:00:00.000Z" });
}
async function archive(root: string, snapshot: Snapshot) {
  await put(join(root, "public/consensus", snapshot.id + ".json"), snapshot);
  return snapshot;
}
async function snapshot(root: string, releaseAt = cutoff) {
  const signals = await loadFirstRatePremarket(root, releaseAt);
  const tlt = await loadTltPremarket(root, releaseAt);
  if (tlt) signals.push(tlt);
  return archive(root, { schemaVersion: 1, id: releaseAt.replace(/[:.]/g, "-"), cutoff: releaseAt, issuedAt: releaseAt,
    engineVersion: "consensus-rules-2.0.0", origin: "prospective", signals, catalysts: [], sourcesAttempted: 2,
    collectionErrors: [], regularSessionRanges: await loadDailySessionRanges(root, releaseAt) });
}
async function qualifiedEquity(t: TestContext) {
  const root = await temporary(t);
  await sample(root);
  const prepared = await prepareFirstRatePremarket(root, () => tapeAt);
  assert.equal(prepared.funds.find(row => row.symbol === "SPY")?.status, "available");
  await prepareFirstRateRanges(root, () => rangeAt);
  return { root, issued: await snapshot(root) };
}

async function hourly(root: string, fund: "SPY" | "TLT", regularClose = 105, asOf = rangeAt) {
  const c = tltPremarketClocks(day), hour = 3_600_000;
  for (const basis of ["raw", "splits"] as const) for (const grid of ["exchange", "Asia/Kolkata"] as const) {
    const half = grid === "Asia/Kolkata", source = etfHourSource(fund, day, day, grid, basis);
    const rows = Array.from({ length: 12 }, (_, i) => {
      const close = i + (half ? 0.5 : 0) >= 5.5 ? regularClose : half && i === 4 ? 99.666 : 100;
      return { symbol: fund, symbol_id: MARKET_HISTORY_ETF_IDS[fund], timestamp: new Date(c.first + (i + (half ? 0.5 : 0)) * hour).toISOString(),
        open: 100, high: 110, low: 90, close, volume: 2, trade_count: 2, vwap: close, is_gap: false, gap_fill_method: 0 };
    });
    const text = rows.map(row => JSON.stringify(row)).join("\n");
    const delivery = { source, status: 200, sha256: sha(text), text, headers: { date: new Date(asOf).toUTCString(),
      "content-type": "application/x-ndjson", "x-feed": "consolidated", "x-row-count": "12",
      "x-bars-charged": "100", "x-bars-remaining": "11000", "x-bars-paid-remaining": "0",
      "x-session": half ? "Asia/Kolkata 00:00" : "exchange America/New_York 00:00", "x-data-through": day + "T23:59:59.000Z" } };
    await put(join(root, privateMH, "regular-session-ranges-v1/legs", [fund, day, day, basis, half ? "open" : "close"].join("-") + ".json"), delivery);
  }
  await prepareMarketHistoryRanges(root, { live: false, clock: () => asOf, fetcher: async () => { throw Error("unexpected network"); } });
}

test("sealed minute and five-minute tape with the same original regular range gives the two issued values and stable identity", async t => {
  const { root, issued } = await qualifiedEquity(t);
  const a = await read(root, issued);
  assert.equal(a.status, "available");
  if (a.status !== "available") return;
  assert.deepEqual([a.sourceSession, a.candidate, a.control, a.availableAt], [day, -1.2, 1, rangeAt]);
  assert.match(a.evidenceSha256, /^[a-f0-9]{64}$/);
  // Reordering serialized keys and reissuing identical native evidence must retain its evidence identity.
  const reissued = await snapshot(root, target + "T13:00:00.000Z");
  reissued.signals = reissued.signals.map(s => Object.fromEntries(Object.entries(s).reverse()) as typeof s);
  await archive(root, reissued);
  assert.deepEqual(await Promise.all([read(root, reissued), read(root, issued)]), [a, a]);
  assert.equal((await readPreviousPremarketFeature(root, issued, "QQQ", target)).status, "unavailable");
  assert.equal((await readPreviousPremarketFeature(root, issued, "TLT", target)).status, "unavailable");
  const missing = structuredClone(issued);
  delete missing.regularSessionRanges;
  assert.deepEqual(await read(root, missing), { status: "unavailable", reason: "as-issued-archive-unverified" });
  await archive(root, missing);
  assert.deepEqual(await read(root, missing), { status: "unavailable", reason: "fund-regular-range-not-issued" });
});

test("as-issued control, fund scope, dated prior session, immutable original and actual endpoints must agree", async t => {
  const { root, issued } = await qualifiedEquity(t);
  for (const mutate of [
    (s: Snapshot) => { s.regularSessionRanges!.rows[0].closeFifth = 3; },
    (s: Snapshot) => { s.regularSessionRanges!.rows[0].session = "2026-11-19"; },
    (s: Snapshot) => { s.signals[0].instruments = ["IWM"]; },
    (s: Snapshot) => { s.signals[0].metrics[0].value = 0; },
    (s: Snapshot) => { s.signals[0].series[0].date = "2026-11-19"; },
  ]) {
    const s = structuredClone(issued);
    mutate(s);
    assert.equal((await read(root, await archive(root, s))).status, "unavailable");
  }
  await archive(root, issued);
  await sample(root, true);
  assert.deepEqual(await read(root, issued), { status: "unavailable", reason: "native-premarket-not-verified-at-cutoff" });
});

test("a late or absent dedicated receipt never borrows a price approval; issue time, cutoff, calendar and shortenings fail closed", async t => {
  const { root, issued } = await qualifiedEquity(t);
  assert.equal((await readPreviousPremarketFeature(root, issued, "SPY", "2026-11-24")).status, "unavailable");
  for (const short of ["2026-11-26", "2026-11-27", "2026-11-30"]) {
    const at = short + "T12:00:00.000Z";
    const s = { ...issued, id: at.replace(/[:.]/g, "-"), cutoff: at, issuedAt: at };
    const r = await readPreviousPremarketFeature(root, await archive(root, s), "SPY", short);
    assert.deepEqual(r, { status: "unavailable", reason: short === "2026-11-30" ? "immediately-prior-session-is-not-ordinary" : "target-is-not-an-ordinary-session" });
  }
  const open = exchangeSession(target)!.openAt;
  const atOpen = { ...issued, id: open.replace(/[:.]/g, "-"), issuedAt: open };
  assert.deepEqual(await read(root, await archive(root, atOpen)), { status: "unavailable", reason: "edition-is-not-before-this-session-open" });
  const path = join(root, privateFR, "premarket-reviewed", day, "SPY.json");
  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.review.approvedAt = target + "T13:15:00.000Z";
  stored.sha256 = digest(stored.review);
  await put(path, stored);
  assert.deepEqual(await read(root, issued), { status: "unavailable", reason: "native-premarket-not-verified-at-cutoff" });
  await rm(path);
  await put(join(root, privateFR, "approved.json"), "this outcome file must never be opened");
  assert.deepEqual(await read(root, issued), { status: "unavailable", reason: "native-premarket-not-verified-at-cutoff" });
});

test("a later hourly review cannot change an earlier cutoff; independently verified same-session range disagreement withholds either source", async t => {
  const { root, issued } = await qualifiedEquity(t);
  const before = await read(root, issued);
  await hourly(root, "SPY", 92, target + "T12:31:00.000Z");
  assert.equal(before.status, "available");
  assert.deepEqual(await read(root, issued), before);
  const later = await snapshot(root, target + "T12:35:00.000Z");
  assert.equal(later.regularSessionRanges?.rows[0].closeFifth, 1);
  const disagreement = { status: "unavailable", reason: "regular-range-sources-disagree" };
  assert.deepEqual(await read(root, later), disagreement);
  later.regularSessionRanges = issued.regularSessionRanges;
  assert.deepEqual(await read(root, await archive(root, later)), disagreement);
});

test("TLT after an ordinary Friday replays its hourly originals, both boundary minutes, and v1 or v2 source attribution", async t => {
  const root = await temporary(t);
  // Sunday evening in New York is after the 48-hour provider embargo on Friday's tape.
  await hourly(root, "TLT", 105, target + "T01:23:00.000Z");
  const at = target + "T01:26:00.000Z";
  const mock: typeof fetch = async (input) => {
    const u = new URL(String(input));
    assert.equal(u.origin, "https://getmarkethistory.com");
    const body = u.pathname === "/api/v1/stocks/us/TLT" ? {
      dataset: "stocks/us", ticker: "TLT", contract: { exchange: "NASDAQ", status: "active" },
      bars: { timeframes: [{ timeframe: "1m", feed: "consolidated", venue: "US consolidated tape", last: day + "T23:59:59.000Z", updated: at }] },
    } : { ticker: "TLT", dataset: "stocks/us", feed: "consolidated", timeframe: "1m", reliable: true, witness: "iex",
      start: u.searchParams.get("start"), end: u.searchParams.get("end"), bars: 330, present: 330,
      missing: { venue_break: 0, market_wide: 0, this_ticker: 0, traded: 0 }, ranges: [] };
    return new Response(JSON.stringify(body), { headers: { date: new Date(at).toUTCString(), "content-type": "application/json" } });
  };
  const prepared = await prepareTltPremarket(root, { live: true, clock: () => at, environmentKey: "", fetcher: mock });
  assert.equal(prepared.status, "available");
  const issued = await snapshot(root);
  const r = await readPreviousPremarketFeature(root, issued, "TLT", target);
  assert.equal(r.status, "available");
  if (r.status !== "available") return;
  assert.deepEqual([r.candidate, r.control, r.availableAt], [-0.3, 1, at]);

  const sunday = await snapshot(root, target + "T01:29:00.000Z");
  assert.equal(newYorkDate(sunday.issuedAt), "2026-11-22");
  assert.deepEqual(await readPreviousPremarketFeature(root, sunday, "TLT", target), r);
  const bytes = await readFile(join(root, "public/consensus", sunday.id + ".json"));
  const index = Buffer.from(JSON.stringify([{ id: sunday.id, issuedAt: sunday.issuedAt, sha256: digest(sunday), engineVersion: sunday.engineVersion }]));
  const sundayClock = target + "T01:31:00.000Z", mondayClock = target + "T12:31:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: new Date(sundayClock) });
  await recordPreopenReceipt(root, target, sunday.id, bytes, index, sundayClock);
  const evening = await verifyPreopenWithMorningConfirmation(root, target, sunday.id, bytes, mondayClock);
  assert.notEqual(newYorkDate(evening.observedAt), target);
  t.mock.timers.setTime(Date.parse(mondayClock));
  await recordPreopenReceipt(root, target, sunday.id, bytes, index, mondayClock);
  const morning = await verifyPreopenWithMorningConfirmation(root, target, sunday.id, bytes, mondayClock);
  assert.equal(morning.observedAt, mondayClock);
  assert.equal(morning.archiveSha256, evening.archiveSha256);
  assert.deepEqual(await readPreviousPremarketFeature(root, sunday, "TLT", "2026-11-24"),
    { status: "unavailable", reason: "edition-cutoff-precedes-the-immediately-prior-close" });

  const row = issued.regularSessionRanges!.rows[0];
  issued.regularSessionRanges = { method: RANGE_POLICY_V2, rows: [{ ...row, source: "market-history" }] };
  assert.deepEqual(await readPreviousPremarketFeature(root, await archive(root, issued), "TLT", target), r);
  const path = join(root, privateMH, "tlt-premarket-v1", day + ".json");
  const saved = JSON.parse(await readFile(path, "utf8"));
  const map = JSON.parse(saved.review.minuteMap.text);
  map.present = 329;
  map.missing.this_ticker = 1;
  const first = tltPremarketClocks(day).first;
  map.ranges = [{ start: new Date(first).toISOString(), end: new Date(first + 60_000).toISOString(), kind: "this_ticker", bars: 1 }];
  saved.review.minuteMap.text = JSON.stringify(map);
  saved.review.minuteMap.sha256 = sha(saved.review.minuteMap.text);
  saved.sha256 = digest(saved.review);
  await put(path, saved);
  assert.deepEqual(await readPreviousPremarketFeature(root, issued, "TLT", target),
    { status: "unavailable", reason: "native-premarket-not-verified-at-cutoff" });
});
