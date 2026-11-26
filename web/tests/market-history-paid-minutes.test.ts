import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareMarketHistoryBoundary, contiguousTltWindows } from "../lib/consensus/market-history-boundaries.ts";
import { adjustETFPrices } from "../lib/consensus/corporate-adjustment.ts";
import { cachedPaidMinute, collectPaidMinutes, paidMinutePlan, readPaidMinuteBoundary, type PaidMinuteEntitlement } from "../lib/consensus/market-history-paid-minutes.ts";

const asOf = "2026-11-24T06:00:00.000Z";
const now = () => asOf;
const authorized: PaidMinuteEntitlement = { paidMinutes: "owner-activated", apiKey: "synthetic-fixture", maxBars: 800, maxRequests: 5 };
const first = "2026-10-30", second = "2026-11-02", half = "2025-11-28";
function fixture(day: string) {
  const p = paidMinutePlan(day);
  const rows = Array.from({ length: p.count }, (_, i) => ({
    timestamp: new Date(p.first + i * 60_000).toISOString(),
    symbol: "TLT", symbol_id: 11418, open: 100, high: 101, low: 99, close: 100.5, vwap: 100, volume: 1200,
    trade_count: 20, is_gap: false, gap_fill_method: 0
  }));
  const text = rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  return {
    source: p.source, status: 200, text, sha256: createHash("sha256").update(text).digest("hex"), headers: {
      date: new Date(asOf).toUTCString(), "content-type": "application/x-ndjson", "x-feed": "consolidated",
      "x-session": "exchange America/New_York 00:00", "x-data-through": p.clock.closeAt, "x-row-count": String(p.count),
      "x-bars-charged": String(p.maximumBars), "x-bars-paid-remaining": "9000", "x-bars-remaining": "9000"
    }
  };
}
function server(days: string[], statusPaid = "10000") {
  const requests: string[] = [];
  const pages = new Map(days.map(d => { const f = fixture(d); return [f.source, f]; }));
  const fetcher: typeof fetch = async (input, init) => {
    const u = String(input);
    requests.push(u);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer " + authorized.apiKey);
    if (u.startsWith("https://getmarkethistory.com/query/v1/fee-rules?"))
      return new Response("{}", { headers: { "x-bars-paid-remaining": statusPaid, "x-bars-remaining": "10000", "x-cap-remaining": "10000" } });
    const page = pages.get(u);
    assert.ok(page);
    return new Response(page.text, { headers: page.headers });
  };
  return { fetcher, requests };
}
async function privateFixture(fn: (directory: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "consensus-private-minute-test-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("paid targets request exactly the native core grid across DST and the shortened close", () => {
  const plans = [first, second, half].map(paidMinutePlan);
  assert.deepEqual(plans.map(p => [p.clock.openAt.slice(11, 16), p.last.slice(11, 16), p.count, p.maximumBars]),
    [["13:30", "19:59", 390, 400], ["14:30", "20:59", 390, 400], ["14:30", "17:59", 210, 300]]);
  for (const p of plans) {
    const q = new URL(p.source).searchParams;
    assert.equal(q.get("start"), p.clock.openAt);
    assert.equal(q.get("end"), p.last);
    assert.equal(Number(q.get("limit")), p.count + 1);
    const b = readPaidMinuteBoundary(p.day, fixture(p.day), asOf);
    const ref = { session: p.day, open: 100, close: 100.5 };
    assert.equal(compareMarketHistoryBoundary(b, ref, ref, ref, true), p.count === 210 ? "short_session_auction_missing" : "matched");
    assert.equal(compareMarketHistoryBoundary(b, ref, ref, ref, true, ref), "matched");
    assert.equal(compareMarketHistoryBoundary(b, ref, { ...ref, close: 100 }, ref, true, ref), "split_basis");
    assert.equal(compareMarketHistoryBoundary(b, { ...ref, open: 100.1 }, { ...ref, open: 100.1 }, ref, true, ref), "open_difference");
  }
  const windows = [first, second].map(day => ({
    day, status: "matched", boundary: readPaidMinuteBoundary(day, fixture(day), asOf),
    raw: { session: day, open: 100, close: 100.5 }
  }));
  const cash = [{ session: second, amount: 1 }];
  assert.equal(contiguousTltWindows(windows.slice(1), cash).length, 0);
  const [window] = contiguousTltWindows(windows, cash);
  const adjusted = adjustETFPrices(window.map(r => ({ ...paidMinutePlan(r.day).clock, open: r.boundary.open!, close: r.boundary.close! })), cash, []);
  assert.equal(adjusted[0].close, 99.5);
});

test("source validation rejects shifted and missing minutes, venue/adjustment substitutions, partial deliveries and wrong billing", () => {
  const f = fixture(half);
  for (const override of [{ "x-bars-charged": "400" }, { "x-next-cursor": "more" }, { "x-feed": "iex" }, { "x-limit-clamped": "true" },
  { "x-session": "UTC 00:00" }, { "x-row-count": "209" }, { "x-data-through": "2025-11-28T17:58:00Z" }])
    assert.throws(() => readPaidMinuteBoundary(half, { ...f, headers: { ...f.headers, ...override } as typeof f.headers }, asOf), /incomplete/);
  assert.throws(() => readPaidMinuteBoundary(half, { ...f, source: f.source.replace("raw", "splits") }, asOf), /incomplete/);
  assert.throws(() => readPaidMinuteBoundary(half, { ...f, sha256: "0".repeat(64) }, asOf), /incomplete/);
  assert.throws(() => readPaidMinuteBoundary(half, f, "2025-11-28T19:00:00.000Z"), /incomplete/);
  for (const text of [f.text.replace("14:30:00", "14:31:00"), f.text.replace('"is_gap":false', '"is_gap":true'), f.text.replace("11418", "11419"),
  f.text.slice(f.text.indexOf("\n") + 1)])
    assert.throws(() => readPaidMinuteBoundary(half, { ...f, text, sha256: createHash("sha256").update(text).digest("hex") }, asOf), /minute/);
});

test("offline reads and invalid owner rights spend nothing; a full batch must fit before the first network call", async () => privateFixture(async dir => {
  const { fetcher, requests } = server([first, second]);
  assert.equal(await cachedPaidMinute(dir, first, asOf), null);
  await assert.rejects(collectPaidMinutes(dir, [first], { ...authorized, paidMinutes: "" as "owner-activated" }, false, { fetcher, now }), /owner-activated/);
  await assert.rejects(collectPaidMinutes(dir, [first, second], { ...authorized, maxBars: 700 }, false, { fetcher, now }), /exceeds/);
  await assert.rejects(collectPaidMinutes(dir, [first, second], { ...authorized, maxRequests: 2 }, false, { fetcher, now }), /exceeds/);
  await assert.rejects(collectPaidMinutes(dir, ["2026-11-23"], authorized, false, { fetcher, now }), /delay/);
  assert.deepEqual(requests, []);
  const free = server([first], "0");
  await assert.rejects(collectPaidMinutes(dir, [first], authorized, false, { fetcher: free.fetcher, now }), /prepaid/);
  assert.equal(free.requests.length, 1);
}));

test("qualified minute originals are private, reusable and require zero additional requests", async () => privateFixture(async dir => {
  const { fetcher, requests } = server([first, second]);
  await collectPaidMinutes(dir, [first, second], authorized, false, { fetcher, now });
  assert.equal(requests.length, 3);
  assert.ok(await cachedPaidMinute(dir, first, asOf));
  assert.equal((await stat(join(dir, "TLT-" + first + ".json"))).mode & 0o077, 0);
  await collectPaidMinutes(dir, [first, second], authorized, false, { fetcher, now });
  assert.equal(requests.length, 3);
  const budget = JSON.parse(await readFile(join(dir, "spend.json"), "utf8"));
  assert.deepEqual(budget.attempts.map((a: { maximumBars: number }) => a.maximumBars), [0, 400, 400]);
}));

test("a timeout consumes its full reservation and a retry must fit the cumulative budget", async () => privateFixture(async dir => {
  const mock = server([first]);
  let barCalls = 0;
  const fail: typeof fetch = async (url, opt) => {
    if (String(url).includes("/bars/")) { barCalls++; throw new Error("lost connection"); }
    return mock.fetcher(url, opt);
  };
  await assert.rejects(collectPaidMinutes(dir, [first], authorized, false, { fetcher: fail, now }), /connection failed/);
  assert.equal(barCalls, 1);
  await assert.rejects(collectPaidMinutes(dir, [first], authorized, false, { fetcher: fail, now }), /retry/);
  await assert.rejects(collectPaidMinutes(dir, [first], { ...authorized, maxBars: 700 }, true, { fetcher: fail, now }), /exceeds/);
  assert.equal(mock.requests.length, 1);
  await collectPaidMinutes(dir, [first], authorized, true, { fetcher: mock.fetcher, now });
  assert.equal(mock.requests.length, 3);
  const budget = JSON.parse(await readFile(join(dir, "spend.json"), "utf8"));
  assert.deepEqual(budget.attempts.map((a: { maximumBars: number }) => a.maximumBars), [0, 400, 0, 400]);
}));

test("overlapping collectors cannot dispatch a second billable attempt", async () => privateFixture(async dir => {
  const mock = server([first]); let started!: () => void, resume!: () => void;
  const inFlight = new Promise<void>(ok => { started = ok; }); const wait = new Promise<void>(ok => { resume = ok; });
  const fetcher: typeof fetch = async (url, opts) => {
    if (String(url).includes("/bars/")) { started(); await wait; }
    return mock.fetcher(url, opts);
  };
  const firstWorker = collectPaidMinutes(dir, [first], authorized, false, { now, fetcher });
  await inFlight;
  try {
    await assert.rejects(collectPaidMinutes(dir, [first], authorized, true, { fetcher, now }), /lock is busy/);
    assert.equal(mock.requests.length, 1);
  } finally { resume(); await firstWorker; }
  assert.equal(mock.requests.length, 2);
}));

test("missing or inconsistent budget history cannot reset the amount available to another run", async () => privateFixture(async dir => {
  const { fetcher, requests } = server([first, second]);
  await collectPaidMinutes(dir, [first], authorized, false, { fetcher, now });
  const path = join(dir, "spend.json");
  const b = JSON.parse(await readFile(path, "utf8"));
  b.attempts[1].maximumBars = 0;
  await writeFile(path, JSON.stringify(b));
  await assert.rejects(collectPaidMinutes(dir, [second], authorized, false, { fetcher, now }), /reservation differs/);
  await rm(path);
  await assert.rejects(collectPaidMinutes(dir, [second], authorized, false, { fetcher, now }), /Missing spend journal/);
  assert.equal(requests.length, 2);
}));
