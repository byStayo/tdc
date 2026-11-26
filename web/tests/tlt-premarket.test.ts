import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { replaceFirstRatePremarket } from "../lib/consensus/firstrate-premarket.ts";
import { prepareMarketHistoryRanges } from "../lib/consensus/market-history-ranges.ts";
import { etfHourSource } from "../lib/consensus/market-history-hourly-access.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { loadTltPremarket, prepareTltPremarket } from "../lib/consensus/market-history-premarket.ts";
import { tltPremarketClocks, validateTltPremarket } from "../lib/consensus/tlt-premarket-signal.ts";
import { missingSignals } from "../lib/consensus/registry.ts";

const friday = "2026-11-27", monday = "2026-11-30T12:45:00.000Z", nextOpen = "2026-11-30T14:30:00.000Z";
const privateDir = ".consensus/private-market-history/tlt-premarket-v1";
const controls = () => ({
  paid: false, late: false, missingFirst: false, witnessedGap: false,
  missingLast: false, badCount: false, differentSplit: false, differentInterior: false, partialHour: false, requests: [] as string[]
});

function host(options = controls(), day = friday, at = monday) {
  const c = tltPremarketClocks(day), date = new Date(at).toUTCString(), through = new Date(Date.parse(exchangeSession(day)!.closeAt) + 4 * 3_600_000).toISOString();
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(input.toString());
    assert.equal(u.origin, "https://getmarkethistory.com");
    options.requests.push(u.pathname);
    const json = (body: unknown, more: Record<string, string> = {}) => new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json", date, ...more }
    });
    if (u.pathname === "/api/v1/stocks/us/TLT") {
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      return json({
        dataset: "stocks/us", ticker: "TLT", contract: { exchange: "NASDAQ", status: "active" },
        bars: { timeframes: [{ timeframe: "1m", feed: "consolidated", venue: "US consolidated tape", last: options.late ? "2026-11-24T20:59:00Z" : through, updated: at }] }
      });
    }
    if (u.pathname.endsWith("/gaps")) {
      assert.equal(u.searchParams.get("timeframe"), "1m");
      const a = c.first + (options.missingFirst ? 0 : options.missingLast ? 329 : 50) * 60000;
      const start = new Date(a).toISOString(), end = new Date(a + 60000).toISOString();
      return json({
        ticker: "TLT", dataset: "stocks/us", feed: "consolidated", timeframe: "1m", reliable: true, witness: "iex",
        start: u.searchParams.get("start"), end: u.searchParams.get("end"), bars: 330, present: options.badCount ? 328 : 329,
        missing: { venue_break: 0, market_wide: 0, this_ticker: 1, traded: options.witnessedGap ? 1 : 0 },
        ranges: [{ start, end, bars: 1, kind: "this_ticker", traded: options.witnessedGap ? 1 : 0 }]
      });
    }
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
    const balance = { "x-bars-remaining": "10000", "x-bars-paid-remaining": options.paid ? "20" : "0" };
    if (u.pathname.endsWith("/fee-rules")) return json({}, balance);
    assert.equal(u.pathname, "/query/v1/bars/stocks/us/TLT/1h");
    const half = u.searchParams.get("tz") === "Asia/Kolkata";
    const prices = Array.from({ length: 12 }, (_, i) => i).filter(i => !options.partialHour || half || i !== 1).map(i => {
      const shift = options.differentSplit && u.searchParams.get("adjust") === "splits" ? 3 : 0;
      // The 09:00-09:59 bar contains a deliberately dissimilar regular-session print and must be excluded.
      const shiftInterior = options.differentInterior && !half && i === 2 && u.searchParams.get("adjust") === "raw" ? 0.1 : 0;
      const price = (half && i === 4 ? 100.455 : !half && i === 5 ? 900 : 100) + shift + shiftInterior;
      return {
        symbol: "TLT", symbol_id: 11418, timestamp: new Date(c.first + (i + (half ? 0.5 : 0)) * 3600000).toISOString(),
        open: price, high: price + 1, low: price - 1, close: price, volume: 20, trade_count: 3, vwap: price, is_gap: false, gap_fill_method: 0
      };
    });
    return new Response(prices.map(x => JSON.stringify(x)).join("\n"), {
      status: 200, headers: {
        ...balance, date,
        "content-type": "application/x-ndjson", "x-feed": "consolidated", "x-row-count": String(prices.length),
        "x-data-through": through, "x-bars-charged": "100", "x-session": half ? "Asia/Kolkata 00:00" : "exchange America/New_York 00:00"
      }
    });
  };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "tlt-premarket-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const options = (f: typeof fetch, at = monday) => ({ live: true, environmentKey: "fixture-key", fetcher: f, clock: () => at });

test("a short Friday can supply verified prior premarket on Monday, with no regular-hour prices and immutable replay", async t => {
  const root = await fixture(t), c = controls();
  assert.equal((await prepareTltPremarket(root, options(host(c)))).status, "available");
  assert.equal(c.requests.filter(k => k.startsWith("/query/v1/bars")).length, 4);
  const sealed = await loadTltPremarket(root, monday); assert.ok(sealed);
  assert.deepEqual(sealed.metrics.map(m => m.value), [0.5, 329]); assert.deepEqual(sealed.directionalInstruments, []);
  assert.equal(sealed.scores.weekly, null); assert.equal(sealed.status, "available"); validateTltPremarket(sealed, monday);
  assert.deepEqual((await prepareTltPremarket(root, options(async () => { throw Error("unexpected repeat request"); }))).status, "cached");
  assert.equal(await loadTltPremarket(root, "2026-11-30T12:44:59.000Z"), null);
  assert.equal((await loadTltPremarket(root, nextOpen))?.status, "stale");
  const merged = replaceFirstRatePremarket(missingSignals(monday), [sealed], monday);
  assert.ok(!merged.find(x => x.id === "previous-premarket-bars")!.instruments.includes("TLT"));
  assert.ok(merged.find(x => x.id === "premarket-bars")!.instruments.includes("TLT"));
  assert.equal(merged.filter(x => x.id === sealed.id).length, 1);
  assert.throws(() => validateTltPremarket({ ...sealed, metrics: [...sealed.metrics, { label: "raw", value: 1, date: friday, unit: "USD" }] }, monday));
  const files = await readdir(join(root, privateDir, "objects")); const path = join(root, privateDir, "objects", files[0]);
  const native = JSON.parse(await readFile(path, "utf8")); native.text += " "; native.sha256 = createHash("sha256").update(native.text).digest("hex");
  await writeFile(path, JSON.stringify(native), { mode: 0o600 }); await assert.rejects(loadTltPremarket(root, monday), /changed/);
});

test("adjacent weekdays make zero network requests and a late discovery cannot backdate Friday", async t => {
  const root = await fixture(t), offline: typeof fetch = async () => { throw Error("network should be idle"); };
  assert.equal((await prepareTltPremarket(root, options(offline, "2026-11-24T12:48:00.000Z"))).status, "source_delay");
  assert.equal((await prepareTltPremarket(root, options(offline, nextOpen))).status, "expired");
  assert.equal((await prepareTltPremarket(root, { ...options(offline), live: false })).status, "skipped_public_only");
  assert.equal(tltPremarketClocks("2026-10-30").expires, "2026-11-02T14:30:00.000Z");
  assert.equal(tltPremarketClocks("2026-11-25").expires, "2026-11-27T14:30:00.000Z");
  const c = controls(); c.late = true; await assert.rejects(prepareTltPremarket(root, options(host(c))), /not yet delivered/);
  assert.equal(c.requests.length, 1); assert.equal(await loadTltPremarket(root, monday), null);
});

test("a missing boundary minute, recorded source gap, inconsistent total or price basis suppresses only TLT", async t => {
  for (const key of ["missingFirst", "missingLast", "witnessedGap", "badCount", "differentSplit", "differentInterior", "partialHour", "paid"] as const) {
    const root = await fixture(t), c = controls(); c[key] = true;
    await assert.rejects(prepareTltPremarket(root, options(host(c))));
    assert.equal(await loadTltPremarket(root, monday), null);
    if (key === "paid") assert.equal(c.requests.some(k => k.startsWith("/query/v1/bars")), false);
    if (key === "differentSplit") {
      c[key] = false; assert.equal((await prepareTltPremarket(root, options(host(c)))).status, "available");
    }
  }
});

test("a capture that crosses the next opening expires without an approval", async t => {
  const root = await fixture(t); let at = monday;
  const underlying = host();
  const fetcher: typeof fetch = async (u, o) => { const r = await underlying(u, o); if (String(u).includes("adjust=splits") && String(u).includes("tz=exchange")) at = nextOpen; return r; };
  assert.equal((await prepareTltPremarket(root, { ...options(fetcher), clock: () => at })).status, "expired");
  assert.equal(await loadTltPremarket(root, nextOpen), null);
});

test("ordinary Friday reuses the four range originals with only two unmetered discovery calls", async t => {
  const root = await fixture(t), day = "2026-11-20", at = "2026-11-23T12:44:00.000Z", c = controls(), source = host(c, day, at);
  for (const grid of ["Asia/Kolkata", "exchange"] as const)
    for (const basis of ["raw", "splits"] as const) {
      const url = etfHourSource("TLT", day, day, grid, basis), r = await source(url, { headers: { authorization: "Bearer fixture-key" } });
      const text = await r.text(), delivery = {
        source: url, status: 200, headers: Object.fromEntries(r.headers), text,
        sha256: createHash("sha256").update(text).digest("hex")
      };
      await durableJSON(join(root, ".consensus/private-market-history/regular-session-ranges-v1/legs",
        "TLT-" + day + "-" + day + "-" + basis + "-" + (grid === "exchange" ? "close" : "open") + ".json"), delivery, true);
    }
  await prepareMarketHistoryRanges(root, { live: false, clock: () => at });
  c.requests.length = 0;
  const prepared = await prepareTltPremarket(root, { ...options(source, at), environmentKey: "" });
  assert.equal(prepared.status, "available");
  assert.deepEqual(c.requests, ["/api/v1/stocks/us/TLT", "/api/v1/stocks/us/TLT/gaps"]);
  assert.equal((await loadTltPremarket(root, at))?.metrics[0]?.value, 0.5);
});

test("competing reviews share no price requests and an insufficient allowance sends none", async t => {
  const root = await fixture(t);
  let unblock!: () => void, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const wait = new Promise<void>(resolve => { unblock = resolve; });
  const c = controls(), source = host(c);
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).includes("/gaps?")) { enter(); await wait; }
    return source(url, init);
  };
  const run = prepareTltPremarket(root, options(fetcher));
  await entered;
  try {
    await assert.rejects(prepareTltPremarket(root, options(fetcher)), /lock|another/i);
  } finally { unblock(); }
  assert.equal((await run).status, "available");
  assert.equal(c.requests.filter(k => k.startsWith("/query/v1/bars")).length, 4);

  const empty = await fixture(t), small = controls(), ordinary = host(small);
  const limited: typeof fetch = async (url, init) => {
    const res = await ordinary(url, init);
    if (String(url).includes("/fee-rules")) res.headers.set("x-bars-remaining", "399");
    return res;
  };
  await assert.rejects(prepareTltPremarket(empty, options(limited)), /insufficient/i);
  assert.equal(small.requests.some(k => k.startsWith("/query/v1/bars")), false);
});
