import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { collectMarketHistoryPriceControls, readMarketHistoryPriceControl } from "../lib/consensus/market-history-price-controls.ts";
import { authenticatedFreeMarketHistoryResponse } from "../lib/consensus/market-history-hourly-access.ts";
import { reconcileFirstRateRows } from "../lib/consensus/firstrate.ts";
import { hourlyFixture } from "./fixtures/firstrate-hourly-controls.ts";

const symbol = "SPY", day = "2026-11-19", days = [day], asOf = "2026-11-20T00:00:00.000Z";
const sessions = [{ ...exchangeSession(day)!, open: 100.05, close: 101.25 }];

test("opening and closing grids retain their actual adjustment and reject a missing split or changed original", () => {
  const raw = { opening: hourlyFixture(symbol, sessions, "raw", "Asia/Kolkata"), closing: hourlyFixture(symbol, sessions, "raw", "exchange") };
  const splits = { opening: hourlyFixture(symbol, sessions, "splits", "Asia/Kolkata", 0.5), closing: hourlyFixture(symbol, sessions, "splits", "exchange", 0.5) };
  assert.deepEqual(readMarketHistoryPriceControl(symbol, days, raw, "raw", asOf).sessions, sessions);
  assert.throws(() => readMarketHistoryPriceControl(symbol, days, raw, "splits", asOf), /provenance|delivery/);
  const other = readMarketHistoryPriceControl(symbol, days, splits, "splits", asOf);
  assert.throws(() => reconcileFirstRateRows(symbol, sessions, sessions, other.sessions), /split-basis/);
  assert.throws(() => readMarketHistoryPriceControl(symbol, days, { ...raw, closing: { ...raw.closing, sha256: "0".repeat(64) } }, "raw", asOf), /hash/);
});

test("an undelivered catalogue consumes zero credits; all four verified responses replay offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "consensus-independent-controls-"));
  try {
    const calls: URL[] = []; let through = day + "T20:59:00Z";
    const fetcher: typeof fetch = async (request, init) => {
      const url = new URL(String(request)); calls.push(url);
      assert.equal(url.origin, "https://getmarkethistory.com");
      if (url.pathname.startsWith("/api/")) {
        assert.equal(new Headers(init?.headers).get("authorization"), null);
        return Response.json({ dataset: "stocks/us", ticker: symbol, contract: { status: "active" },
          bars: { timeframes: [{ timeframe: "1m", feed: "consolidated", venue: "US consolidated tape", last: through }] } });
      }
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-test-account");
      if (url.pathname.endsWith("/fee-rules")) return new Response("ok", { headers: { "x-bars-remaining": "3000", "x-bars-paid-remaining": "0" } });
      const adjust = url.searchParams.get("adjust"), grid = url.searchParams.get("tz");
      assert(adjust === "raw" || adjust === "splits"); assert(grid === "exchange" || grid === "Asia/Kolkata");
      const sample = hourlyFixture(symbol, sessions, adjust, grid);
      return new Response(sample.text, { headers: sample.headers });
    };
    const options = { fetcher, environmentKey: "synthetic-test-account", asOf };
    await assert.rejects(collectMarketHistoryPriceControls(root, symbol, days, false, options), /has not delivered/);
    assert.equal(calls.length, 1);
    through = day + "T22:58:00Z";
    const fresh = await collectMarketHistoryPriceControls(root, symbol, days, false, options);
    assert.equal(calls.filter(url => url.pathname.endsWith("/1h")).length, 4);
    assert.equal(calls.filter(url => url.pathname.endsWith("/fee-rules")).length, 1);
    assert.notEqual(fresh.proof.raw, fresh.proof.splits);
    const offline = { ...options, fetcher: async () => { throw new Error("Unexpected network"); } };
    assert.deepEqual(await collectMarketHistoryPriceControls(root, symbol, days, true, offline), fresh);
    const path = join(root, ".consensus/private-market-history/firstrate-controls", [symbol, day, day, "splits", "open"].join("-") + ".json");
    const spoiled = JSON.parse(await readFile(path, "utf8")); spoiled.text = spoiled.text.replace("100.05", "100.06");
    await writeFile(path, JSON.stringify(spoiled), { mode: 0o600 });
    await assert.rejects(collectMarketHistoryPriceControls(root, symbol, days, true, offline), /hash/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("respects one bounded free-source retry and a second refusal", async () => {
  const source = "https://getmarkethistory.com/query/v1/corporate-actions";
  let requests = 0;
  const deliver = () => authenticatedFreeMarketHistoryResponse(source, "test-only", async () => ++requests === 2
    ? new Response("ok") : new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }));
  assert.equal(await (await deliver()).text(), "ok");
  assert.equal(requests, 2);
  await assert.rejects(deliver(), /429/);
  assert.equal(requests, 4);
});
