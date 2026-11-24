import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extendedResearchSession } from "../lib/consensus/extended-research-calendar.ts";
import { exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { readNasdaqHistoricalControl } from "../lib/consensus/kibot-session-witnesses.ts";
import { importMarketHistoryHours, type DeliveredMarketHistoryHours } from "../lib/consensus/market-history-closes.ts";
import { marketHistoryBoundaries, compareMarketHistoryBoundary, freeMarketHistoryBalance, type MarketHistoryGrid } from "../lib/consensus/market-history-boundaries.ts";
import { prepareTltBoundaryQualification } from "../lib/consensus/market-history-boundary-preparation.ts";
import { fetchFreeTltHours } from "../lib/consensus/market-history-hourly-access.ts";

const days = ["2025-10-31", "2025-11-03", "2025-11-28"];
const clocks = days.map(day => extendedResearchSession(day)!);
const cutoff = "2025-11-29T12:00:00.000Z";
function delivery(grid: MarketHistoryGrid, stamps: string[], value: number): DeliveredMarketHistoryHours {
  const text = stamps.map(timestamp => JSON.stringify({ timestamp, symbol: "TLT", symbol_id: 11418,
    open: value, high: value + 1, low: value - 1, close: value + 0.25, volume: 1000, vwap: value,
    trade_count: 5, is_gap: false, gap_fill_method: 0 })).join("\n") + "\n";
  const url = new URL("https://getmarkethistory.com/query/v1/bars/stocks/us/TLT/1h");
  url.search = new URLSearchParams({ start: days[0], end: days[2], tz: grid, feed: "consolidated", adjust: "raw" }).toString();
  return { source: url.href, status: 200, text, sha256: createHash("sha256").update(text).digest("hex"),
    headers: { date: new Date(cutoff).toUTCString(), "content-type": "application/x-ndjson",
      "x-session": grid === "exchange" ? "exchange America/New_York 00:00" : "Asia/Kolkata 00:00",
      "x-feed": "consolidated", "x-data-through": "2025-11-28T23:00:00Z",
      "x-row-count": String(stamps.length), "x-bars-charged": "100" } };
}
const opens = delivery("Asia/Kolkata", ["2025-10-31T13:30:00Z", "2025-11-03T14:30:00Z", "2025-11-28T14:30:00Z"], 90);
const closes = delivery("exchange", ["2025-10-31T19:00:00Z", "2025-11-03T20:00:00Z", "2025-11-28T17:00:00Z"], 91);

test("UTC boundaries follow both daylight-saving regimes and the shortened regular session", () => {
  const result = marketHistoryBoundaries(opens, closes, clocks, cutoff);
  assert.deepEqual(result.map(r => [r.session, r.open, r.close, r.earlyClose]), [
    [days[0], 90, 91.25, false], [days[1], 90, 91.25, false], [days[2], 90, 91.25, true],
  ]);
  assert.equal(result[2].closingBucket, "2025-11-28T17:00:00.000Z");
  assert.equal(result[2].openingBucket, "2025-11-28T14:30:00.000Z");
});

test("the private collector can only spend confirmed monthly free bars within a key's cap", () => {
  const free = new Headers({ "x-bars-remaining": "250000", "x-bars-paid-remaining": "0" });
  assert.equal(freeMarketHistoryBalance(free), 250000);
  free.set("x-cap-remaining", "300");
  assert.equal(freeMarketHistoryBalance(free), 300);
  free.delete("x-bars-paid-remaining");
  assert.throws(() => freeMarketHistoryBalance(free), /free-only/);
  free.set("x-bars-paid-remaining", "500");
  assert.throws(() => freeMarketHistoryBalance(free), /free-only/);
});

test("signed collection requests both real query formats from a free-only balance, with no credential in either receipt", async () => {
  const paths: string[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(url.origin, "https://getmarkethistory.com");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
    const balance = { "x-bars-remaining": "10000", "x-bars-paid-remaining": "0" };
    if (url.pathname === "/query/v1/fee-rules") return new Response("[]", { headers: balance });
    const bundle = url.searchParams.get("tz") === "Asia/Kolkata" ? opens : closes;
    return new Response(bundle.text, { headers: { ...bundle.headers, ...balance } });
  };
  const account = { key: "fixture-token" };
  const a = await fetchFreeTltHours(days[0], days[2], "Asia/Kolkata", account, fake);
  const b = await fetchFreeTltHours(days[0], days[2], "exchange", account, fake);
  assert.equal(marketHistoryBoundaries(a, b, clocks, cutoff).length, 3);
  assert.deepEqual(paths, ["/query/v1/fee-rules", "/query/v1/bars/stocks/us/TLT/1h", "/query/v1/bars/stocks/us/TLT/1h"]);
  assert.equal(JSON.stringify([a, b]).includes(account.key), false);
  let requests = 0;
  await assert.rejects(fetchFreeTltHours(days[0], days[2], "exchange", { key: "fixture-token" }, async () => {
    requests++; return new Response("[]", { headers: { "x-bars-remaining": "500", "x-bars-paid-remaining": "300" } });
  }), /free-only/);
  assert.equal(requests, 1);
});

test("daily preparation skips all requests without a key; activating a key selects only market-delivered closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tlt-preparation-"));
  const cutoff = "2026-11-23T22:30:00.000Z";
  let calls = 0;
  const fake: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "https://getmarkethistory.com/api/v1/stocks/us/TLT");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json({ dataset: "stocks/us", ticker: "TLT", contract: { exchange: "NASDAQ", status: "active" },
      bars: { timeframes: [{ timeframe: "1m", feed: "consolidated", venue: "US consolidated tape",
        last: "2026-11-21T00:59:00Z", updated: "2026-11-23T05:27:36Z" }] } });
  };
  const run = async (from: string, through: string) => {
    calls++;
    assert.equal(through, "2026-11-20");
    return { from, through, sessions: exchangeSessions(from, through).length, matched: 1, completeHourlyGrids: 2,
      adjustedSessions: 0, settlementSessions: 0, receipt: "d".repeat(64), scope: "private-source-qualification" };
  };
  try {
    const options = { cutoff, fetcher: fake, environmentKey: "" };
    assert.equal((await prepareTltBoundaryQualification(root, run, options)).status, "awaiting_free_account");
    assert.equal(calls, 0);
    await durableJSON(join(root, ".consensus/private-market-history/credentials.json"), { apiKey: "fixture-token" }, true);
    const result = await prepareTltBoundaryQualification(root, run, options);
    assert.equal(calls, 2);
    assert.equal(result.status, "candidate_pending");
    assert.equal(result.expected, "2026-11-23");
    assert.equal(result.through, "2026-11-20");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one original Nasdaq response reconciles a dated range, preserves absent sessions and rejects out-of-range rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tlt-range-"));
  const range = { from: "2025-11-25", through: "2025-11-28" };
  let requests = 0;
  const payload = (date: string) => ({ date, open: "$90", close: "$91", low: "$89", high: "$92" });
  const rows = [payload("11/28/2025"), payload("11/25/2025")];
  const fetcher = async (url: string) => {
    requests++;
    assert.equal(new URL(url).searchParams.get("limit"), "50");
    return Response.json({ status: { rCode: 200 }, data: { symbol: "TLT", tradesTable: {
      headers: { date: "Date", open: "Open", close: "Close/Last", high: "High", low: "Low" }, rows } } });
  };
  try {
    const first = await readNasdaqHistoricalControl(dir, "TLT", range.from, true, fetcher, extendedResearchSession, range);
    const last = await readNasdaqHistoricalControl(dir, "TLT", range.through, false, fetcher, extendedResearchSession, range);
    assert.equal(requests, 1);
    assert.equal(first.stamp.sha256, last.stamp.sha256);
    await assert.rejects(readNasdaqHistoricalControl(dir, "TLT", "2025-11-26", false, fetcher, extendedResearchSession, range), /no historical ETF row/);
    rows.push(payload("11/24/2025"));
    await assert.rejects(readNasdaqHistoricalControl(join(dir, "bad"), "TLT", range.from, true, fetcher, extendedResearchSession, range),
      /out-of-range/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("wrong session headers, a provider ignoring tz, and partially published bars cannot settle", () => {
  assert.throws(() => importMarketHistoryHours(opens, "TLT", cutoff), /delivery/);
  assert.throws(() => marketHistoryBoundaries({ ...opens, headers: { ...opens.headers,
    "x-session": "exchange America/New_York 00:00" } }, closes, clocks, cutoff), /delivery/);
  const wrongGrid = delivery("Asia/Kolkata", ["2025-11-03T14:00:00Z"], 90);
  assert.throws(() => marketHistoryBoundaries(wrongGrid, closes, clocks, cutoff), /hourly/);
  const wrongDay = delivery("Asia/Kolkata", ["2025-10-31T12:30:00Z", "2025-11-03T15:30:00Z"], 90);
  assert.ok(marketHistoryBoundaries(wrongDay, closes, clocks, cutoff).every(r => r.open === null));
  const partial = { ...closes, headers: { ...closes.headers, "x-data-through": "2025-11-28T17:59:59Z" } };
  assert.equal(marketHistoryBoundaries(opens, partial, clocks, cutoff).at(-1)!.close, null);
  const mismatch = { ...opens, source: opens.source.replace(days[0], "2025-10-28") };
  assert.throws(() => marketHistoryBoundaries(mismatch, closes, clocks, cutoff), /range/);
});

test("session comparisons withhold missing cash coverage, split differences, direction flips and auction differences", () => {
  const [bar] = marketHistoryBoundaries(opens, closes, clocks, cutoff);
  const ref = { session: days[0], open: 90, close: 91.25 };
  assert.equal(compareMarketHistoryBoundary(bar, ref, ref, ref, true), "matched");
  assert.equal(compareMarketHistoryBoundary(bar, ref, ref, ref, false), "issuer_pending");
  assert.equal(compareMarketHistoryBoundary(bar, ref, { ...ref, open: 89.5 }, ref, true), "split_basis");
  assert.equal(compareMarketHistoryBoundary(bar, ref, ref, undefined, true), "reference_missing");
  assert.equal(compareMarketHistoryBoundary({ ...bar, open: 89 }, ref, ref, ref, true), "open_difference");
  assert.equal(compareMarketHistoryBoundary({ ...bar, close: 92 }, ref, ref, ref, true), "close_difference");
  assert.equal(compareMarketHistoryBoundary({ ...bar, open: 90, close: 90.01 }, { ...ref, close: 89.99 },
    { ...ref, close: 89.99 }, { ...ref, close: 89.99 }, true), "direction_difference");
  const shortened = marketHistoryBoundaries(opens, closes, clocks, cutoff)[2], shortRef = { ...ref, session: days[2] };
  assert.equal(compareMarketHistoryBoundary(shortened, shortRef, shortRef, shortRef, true), "short_session_auction_missing");
  assert.equal(compareMarketHistoryBoundary(shortened, shortRef, shortRef, shortRef, true,
    { ...shortRef, close: shortRef.close + 0.01 }), "short_session_auction_difference");
  assert.equal(compareMarketHistoryBoundary(shortened, shortRef, shortRef, shortRef, true, shortRef), "matched");
});
