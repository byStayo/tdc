import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectOptionActivity, optionSampleExpiry, validateOptionActivity } from "../lib/consensus/option-activity.ts";
import { currentOptionActivity, latestOptionSession } from "../lib/consensus/option-activity-clock.ts";

const now = "2026-11-24T01:30:00.000Z";
const previous = "2026-11-19";
const session = "2026-11-20";
const expiry = "2026-12-18";

test("standard monthly window rolls an exchange holiday back and honors the 21-day boundary", () => {
  assert.equal(optionSampleExpiry(session), expiry);
  assert.equal(optionSampleExpiry("2027-02-25"), "2027-03-19");
  assert.equal(optionSampleExpiry("2026-05-29"), "2026-07-17"); // June expiry rolls back for Juneteenth, leaving only 20 days.
  assert.equal(optionSampleExpiry("2026-05-28"), "2026-06-18");
});

function fixture(invalidMultiplier = false) {
  const seen: string[] = [];
  const fetcher = async (url: string) => {
    seen.push(url);
    const u = new URL(url);
    assert.equal(u.origin, "https://getmarkethistory.com");
    const ticker = u.pathname.split("/").at(-1)!;
    if (ticker === "stats") return Response.json({ datasets: ["options/us", "stocks/us"].map(dataset => ({
      dataset, timeframes: [{ timeframe: "1m", last: session + "T21:14:00Z" }],
    })) });
    const right = (symbol: string) => symbol.includes("18C") ? "call" : "put";
    const id = (symbol: string) => symbol === "SPY" ? 7 : Number(symbol.slice(-8)) + (right(symbol) === "call" ? 1 : 2);
    if (ticker === "symbols") {
      const prefix = u.searchParams.get("prefix")!;
      const symbols = prefix.startsWith("SPY") ? ["00099000", "00101000", "00100000"].map((strike, i) => ({
        symbol: prefix + strike, symbol_id: id(prefix + strike), first_timestamp: (i === 2 ? session : previous) + "T16:00:00Z",
        covered_through: "2026-11-21",
      })) : [];
      return Response.json({ truncated: false, count: symbols.length, symbols });
    }
    if (u.pathname.includes("/bars/")) {
      const symbol = u.pathname.split("/").at(-2)!;
      const date = symbol === "SPY" ? previous : session;
      const line = JSON.stringify({ timestamp: date + "T05:00:00Z", symbol, symbol_id: id(symbol), close: 100,
        volume: symbol === "SPY" ? 1000 : right(symbol) === "put" ? 30 : 50, is_gap: false, gap_fill_method: 0, trade_count: 5 });
      return new Response(line, { headers: { "content-type": "application/x-ndjson", "x-data-through": session + "T21:10:00Z",
        "x-feed": "consolidated", "x-preview-limit": "100", "x-row-count": "1", "x-session": "venue America/New_York 00:00" } });
    }
    return Response.json({ ticker, dataset: "options/us", contract: { asset_class: "option", underlying: "SPY", expiration: expiry,
      type: right(ticker), exchange: "OPRA", style: "american", size: invalidMultiplier ? 10 : 100, strike: Number(ticker.slice(-8)) / 1000 },
      bars: { timeframes: [{ timeframe: "1m", feed: "consolidated", venue: "US listed options (OPRA)", updated: "2026-11-23T06:00:00Z" }] } });
  };
  return { seen, fetcher };
}

test("free route produces only a rounded share, pins the original pair and keeps missing listings explicit", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
  const dir = await mkdtemp(join(tmpdir(), "tdc-opra-"));
  try {
    const { seen, fetcher } = fixture();
    const sample = await collectOptionActivity(dir, fetcher, now);
    validateOptionActivity(sample, now);
    const row = sample.rows[0];
    assert.equal(row.status, "observed");
    if (row.status !== "observed") throw new Error("Expected a matched observation");
    assert.equal(row.putPercent, 38);
    assert.equal(sample.rows.filter(row => row.status === "unlisted").length, 4);
    assert.equal(seen.some(url => url.endsWith("C00100000/1d")), false); // This strike first traded on observation day.
    assert.ok(seen.some(url => url.endsWith("C00099000/1d"))); // Equidistant prior strikes select the lower.
    const path = join(dir, session, "SPY.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const retry = fixture();
    assert.deepEqual(await collectOptionActivity(dir, retry.fetcher, now), sample);
    assert.ok(retry.seen.every(url => !url.includes("SPY")));
    assert.throws(() => validateOptionActivity({ ...sample, rows: [{ ...row, volume: 30 }, ...sample.rows.slice(1)] } as typeof sample, now));
    assert.throws(() => validateOptionActivity(sample, "2026-11-23T13:00:00.000Z"));
    const corrupted = JSON.parse(await readFile(path, "utf8"));
    corrupted.put.volume += 7;
    await writeFile(path, JSON.stringify(corrupted));
    await assert.rejects(collectOptionActivity(dir, fetcher, now, sample), /Changed as-issued options receipt/);
    corrupted.put.contract = corrupted.call.contract;
    await writeFile(path, JSON.stringify(corrupted));
    await assert.rejects(collectOptionActivity(dir, fetcher, now), /Invalid private options contract evidence/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a nonstandard multiplier or transport failure never becomes a zero-volume observation", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
  const dir = await mkdtemp(join(tmpdir(), "tdc-opra-"));
  try {
    const { fetcher } = fixture(true);
    const sample = await collectOptionActivity(dir, url => url.includes("QQQ") ? Promise.resolve(new Response(null, { status: 503 })) : fetcher(url), now);
    assert.deepEqual(sample.rows.slice(0, 2), [{ symbol: "SPY", status: "unavailable" }, { symbol: "QQQ", status: "unavailable" }]);
    assert.equal(sample.rows[2].status, "unlisted");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Tuesday morning can use the Friday delivery; an old carried sample cannot accumulate later outcome pairs", async t => {
  const tuesday = "2026-11-24T13:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(tuesday) });
  const dir = await mkdtemp(join(tmpdir(), "tdc-opra-"));
  try {
    const sample = await collectOptionActivity(dir, fixture().fetcher, tuesday);
    assert.equal(sample.session, session);
    assert.equal(sample.rows[0].status, "observed");
    assert.equal(currentOptionActivity(sample.session, tuesday), true);
    assert.equal(currentOptionActivity(sample.session, "2026-12-01T13:00:00.000Z"), false);
    assert.equal(latestOptionSession(tuesday, Date.parse("2026-11-23T21:14:00Z")), "2026-11-23");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
