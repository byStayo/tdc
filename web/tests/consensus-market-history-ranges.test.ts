import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { observationDigest } from "../lib/consensus/history.ts";
import { MARKET_HISTORY_ETF_IDS } from "../lib/consensus/market-history-boundaries.ts";
import type {
  DeliveredMarketHistoryHours,
  MarketHistoryAdjustment,
  MarketHistoryGrid,
  MarketHistoryHour,
} from "../lib/consensus/market-history-closes.ts";
import { etfHourSource } from "../lib/consensus/market-history-hourly-access.ts";
import {
  closeFifth,
  loadMarketHistoryRanges,
  prepareMarketHistoryRanges,
} from "../lib/consensus/market-history-ranges.ts";
import {
  type RangeFund,
  validateSessionRanges,
  visibleSessionRanges,
} from "../lib/consensus/regular-session-range.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

const clock = () => "2026-11-24T13:00:00.000Z";
const path = ".consensus/private-market-history",
  privateRange = path + "/regular-session-ranges-v1";
const grids = ["Asia/Kolkata", "exchange"] as const,
  bases = ["raw", "splits"] as const;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function temp(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "regular-range-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function store(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
}
type Change = {
  skipInterior?: string;
  different?: boolean;
  flat?: boolean;
  throughClock?: string;
  wrongSecurity?: boolean;
  paid?: boolean;
};
function delivery(
  fund: RangeFund,
  from: string,
  through: string,
  grid: MarketHistoryGrid,
  basis: MarketHistoryAdjustment,
  opts: Change = {},
): DeliveredMarketHistoryHours {
  const all: MarketHistoryHour[] = [];
  const hr = 3_600_000;
  for (const day of exchangeSessions(from, through)) {
    const session = exchangeSession(day)!,
      start = Date.parse(session.openAt),
      end = Date.parse(session.closeAt);
    if (end - start !== 6.5 * hr) continue;
    function bar(at: number, hi: number, lo: number, c: number) {
      if (opts.flat) {
        hi = 100;
        lo = 100;
        c = 100;
      }
      const adjusted = opts.different && basis === "splits" ? 1.1 : 1;
      all.push({
        symbol: fund,
        symbol_id: opts.wrongSecurity ? 45 : MARKET_HISTORY_ETF_IDS[fund],
        timestamp: new Date(at).toISOString(),
        open: c * adjusted,
        high: hi * adjusted,
        low: lo * adjusted,
        close: c * adjusted,
        volume: 10,
        trade_count: 2,
        vwap: c * adjusted,
        is_gap: false,
        gap_fill_method: 0,
      });
    }
    if (grid === "Asia/Kolkata") {
      bar(start - hr, 999, 1, 888);
      bar(start, 107, 99, 104);
      bar(start + hr, 108, 100, 105);
    } else {
      bar(start - hr / 2, 987, 3, 900);
      for (let j = 6; j >= 1; j--) {
        if (j === 3 && opts.skipInterior === day) continue;
        bar(end - hr * j, j === 3 ? 109 : 106, 100, 105);
      }
      bar(end, 999, 1, 888);
    }
  }
  const text = all.map((r) => JSON.stringify(r)).join("\n") + "\n",
    last = opts.throughClock ?? through + "T23:59:59.000Z";
  return {
    source: etfHourSource(fund, from, through, grid, basis),
    status: 200,
    sha256: sha(text),
    text,
    headers: {
      "content-type": "application/x-ndjson",
      date: new Date(clock()).toUTCString(),
      "x-session": grid === "exchange" ? "exchange America/New_York 00:00" : "Asia/Kolkata 00:00",
      "x-row-count": String(all.length),
      "x-feed": "consolidated",
      "x-data-through": last,
      "x-bars-charged": String(100 * Math.ceil(all.length / 100)),
      "x-bars-remaining": "80000",
      "x-bars-paid-remaining": opts.paid ? "100" : "0",
    },
  };
}
async function cached(
  root: string,
  fund: RangeFund,
  from: string,
  end: string,
  opts: Change = {},
  basisFilter?: MarketHistoryAdjustment,
  gridFilter?: MarketHistoryGrid,
) {
  for (const basis of basisFilter ? [basisFilter] : bases)
    for (const grid of gridFilter ? [gridFilter] : grids) {
      const n = [fund, from, end, basis, grid === "exchange" ? "close" : "open"].join("-") + ".json";
      await store(join(root, path, "firstrate-controls", n), delivery(fund, from, end, grid, basis, opts));
    }
}
const noNet: typeof fetch = async () => {
  throw Error("unexpected network call");
};
test("cached original grids yield independently dated coarse ranges, preserve privacy and expire after five days", async (t) => {
  const root = await temp(t);
  await cached(root, "SPY", "2026-11-16", "2026-11-23", {}, "raw");
  await cached(root, "SPY", "2026-11-20", "2026-11-23", {}, "splits");
  await cached(root, "TLT", "2026-11-17", "2026-11-20");
  await cached(root, "QQQ", "2026-11-20", "2026-11-23", { skipInterior: "2026-11-23" });
  await cached(root, "IWM", "2026-11-20", "2026-11-23", { different: true });
  await cached(root, "DIA", "2026-11-20", "2026-11-23", { flat: true });
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    throw Error("public-only tried authenticated or public network");
  };
  const update = await prepareMarketHistoryRanges(root, { live: false, fetcher, clock });
  assert.equal(calls, 0);
  assert.equal(update.mode, "cached-only");
  const rows = await loadMarketHistoryRanges(root, clock());
  assert.ok(rows);
  assert.deepEqual(
    rows.rows.map((x) => [x.fund, x.session, x.closeFifth]),
    [
      ["SPY", "2026-11-23", 4],
      ["QQQ", "2026-11-20", 4],
      ["TLT", "2026-11-20", 4],
    ],
  );
  validateSessionRanges(rows, clock());
  const leaked = { ...rows, rows: [{ ...rows.rows[0], rawClose: 105 }] };
  assert.throws(() => validateSessionRanges(leaked, clock()));
  assert.deepEqual(visibleSessionRanges(rows, "SPY", "weekly", clock()), []);
  assert.deepEqual(visibleSessionRanges(undefined, "TLT", "daily", clock()), []);
  assert.equal(visibleSessionRanges(rows, "TLT", "daily", "2026-11-25T21:00:00.001Z").length, 0);
  assert.equal(visibleSessionRanges(rows, "SPY", "daily", "2026-11-25T21:00:01.000Z").length, 1);
  for (const r of rows.rows)
    assert.deepEqual(Object.keys(r).sort(), [
      "closeFifth",
      "fund",
      "observedAt",
      "receiptSha256",
      "session",
      "verifiedAt",
    ]);
  const template = {
    engineVersion: "v",
    signals: [],
    catalysts: [],
    regularSessionRanges: rows,
  } as unknown as Snapshot;
  assert.equal(
    observationDigest(template),
    observationDigest({
      ...template,
      regularSessionRanges: {
        ...rows,
        rows: rows.rows.map((r) => ({ ...r, receiptSha256: "a".repeat(64) })),
      },
    }),
  );
  assert.notEqual(
    observationDigest(template),
    observationDigest({ ...template, regularSessionRanges: undefined }),
  );
  const retry = await prepareMarketHistoryRanges(root, { live: false, fetcher, clock });
  assert.deepEqual(retry.rows, update.rows);
  const r = JSON.parse(await readFile(join(root, privateRange, "reviews/QQQ/2026-11-20.json"), "utf8"));
  const native = join(root, privateRange, "objects", r.native[0] + ".json");
  const bad = JSON.parse(await readFile(native, "utf8"));
  bad.sha256 = "0".repeat(64);
  await writeFile(native, JSON.stringify(bad));
  assert.deepEqual(
    (await loadMarketHistoryRanges(root, clock()))?.rows.map((r) => r.fund),
    ["SPY", "TLT"],
  );
});
test("requires corresponding ranges on both clocks, a regular full session, correct independent source identity and free account", async (t) => {
  const root = await temp(t);
  await cached(root, "SPY", "2026-11-16", "2026-11-23", {}, "raw", "Asia/Kolkata");
  await cached(root, "SPY", "2026-11-17", "2026-11-23", {}, "raw", "exchange");
  await cached(root, "SPY", "2026-11-17", "2026-11-23", {}, "splits");
  await cached(root, "TLT", "2026-11-23", "2026-11-23", { wrongSecurity: true });
  await cached(root, "DIA", "2026-11-23", "2026-11-23", { paid: true });
  assert.deepEqual((await prepareMarketHistoryRanges(root, { live: false, clock, fetcher: noNet })).rows, []);
  const shortDay = "2026-11-27";
  const fake = {
    method: "regular-session-close-fifth-v1",
    url: "https://getmarkethistory.com/docs/guides/historical-stock-market-data/",
    attribution:
      "Market History consolidated US equities. Regular-session calculation by The Daily Consensus.",
    rows: [
      {
        fund: "SPY",
        session: shortDay,
        observedAt: exchangeSession(shortDay)!.closeAt,
        verifiedAt: shortDay + "T19:00:00.000Z",
        closeFifth: 2,
        receiptSha256: "e".repeat(64),
      },
    ],
  } as const;
  assert.throws(() => validateSessionRanges({ ...fake, rows: [...fake.rows] }, shortDay + "T23:00:00.000Z"));
  assert.equal(closeFifth(1.5, 1, 1.1), 2);
  assert.equal(closeFifth(1.5, 1, 1.5), 5);
  assert.equal(closeFifth(1.5, 1, 1), 1);
  assert.throws(() => closeFifth(1, 1, 1));
});
function provider(opts: { paid?: boolean; missing?: RangeFund } = {}) {
  const publicCalls: string[] = [],
    signed: string[] = [],
    fees: string[] = [];
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource)),
      fund = url.pathname.split("/")[6] as RangeFund;
    if (url.pathname.startsWith("/api/v1/stocks/us/")) {
      const s = url.pathname.split("/").at(-1)!;
      publicCalls.push(s);
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      return Response.json({
        dataset: "stocks/us",
        ticker: s,
        contract: { exchange: s === "QQQ" || s === "TLT" ? "NASDAQ" : "ARCA", status: "active" },
        bars: {
          timeframes: [
            {
              timeframe: "1m",
              feed: "consolidated",
              venue: "US consolidated tape",
              last: (s === "TLT" ? "2026-11-20" : "2026-11-23") + "T23:59:59Z",
              updated: "2026-11-24T07:00:00Z",
            },
          ],
        },
      });
    }
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture");
    if (url.pathname === "/query/v1/fee-rules") {
      fees.push(url.href);
      return new Response("", {
        headers: { "x-bars-remaining": "80000", "x-bars-paid-remaining": opts.paid ? "100" : "0" },
      });
    }
    signed.push(url.href);
    if (opts.missing === fund && url.searchParams.get("tz") === "exchange")
      return new Response("unavailable", { status: 503 });
    const p = url.searchParams,
      actual = delivery(
        fund,
        p.get("start")!,
        p.get("end")!,
        p.get("tz")! as MarketHistoryGrid,
        p.get("adjust")! as MarketHistoryAdjustment,
      );
    return new Response(actual.text, { headers: actual.headers });
  };
  return { fetcher, publicCalls, signed, fees };
}
test("weekday fetch is bounded, reuses each native leg, observes individual watermark, and refuses paid balance before charge", async (t) => {
  const root = await temp(t),
    bad = provider({ paid: true });
  let update = await prepareMarketHistoryRanges(root, {
    live: true,
    environmentKey: "fixture",
    clock,
    fetcher: bad.fetcher,
  });
  assert.equal(update.rows.length, 0);
  assert.equal(bad.signed.length, 0);
  assert.equal(bad.fees.length, 1);
  const p = provider(),
    opt = { live: true, environmentKey: "fixture", clock, fetcher: p.fetcher };
  update = await prepareMarketHistoryRanges(root, opt);
  assert.equal(p.publicCalls.length, 5);
  assert.equal(p.signed.length, 20);
  assert.equal(p.fees.length, 1);
  assert.equal(update.rows.length, 5);
  assert.equal(update.rows.find((r) => r.fund === "TLT")?.session, "2026-11-20");
  assert(update.rows.filter((r) => r.fund !== "TLT").every((r) => r.session === "2026-11-23"));
  for (const n of p.signed) {
    const q = new URL(n).searchParams;
    assert((Date.parse(q.get("end")!) - Date.parse(q.get("start")!)) / 86400000 <= 3);
  }
  await prepareMarketHistoryRanges(root, opt);
  assert.equal(p.signed.length, 20);
  assert.equal(p.fees.length, 1);
  assert.equal((await readdir(join(root, privateRange, "requests/2026-11-24"))).length, 20);
});
test("two concurrent preparations and an ambiguous failed range request cannot duplicate applied charges or suppress another fund", async (t) => {
  const root = await temp(t),
    p = provider({ missing: "QQQ" }),
    opt = { live: true, environmentKey: "fixture", clock, fetcher: p.fetcher };
  const attempts = await Promise.allSettled([
    prepareMarketHistoryRanges(root, opt),
    prepareMarketHistoryRanges(root, opt),
  ]);
  assert(attempts.some((a) => a.status === "fulfilled"));
  const before = [...p.signed];
  assert.equal(new Set(before).size, before.length);
  const result = await prepareMarketHistoryRanges(root, opt);
  assert.deepEqual(p.signed, before);
  assert.equal(result.rows.length, 4);
  assert(!result.rows.some((r) => r.fund === "QQQ"));
});
