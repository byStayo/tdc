import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { durableJSON } from "../lib/publication-storage.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { digest } from "../lib/consensus/history.ts";
import { kibotHistorySource } from "../lib/consensus/kibot.ts";
import { loadTltClosingTrend, prepareTltClosingTrend, settledTltCloseSignal } from "../lib/consensus/tlt-close-preparation.ts";
import { pendingSettledTltInputs, tltCloseSignal, validateTltCloseSignal } from "../lib/consensus/tlt-close-signal.ts";
import { MARKET_HISTORY_SOURCE, type ReviewedTltSettlement } from "../lib/consensus/market-history-settlement.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";

test("after the anonymous hourly feed retires preparation reports only an unexpired pinned observation", async t => {
  const root = await mkdtemp(join(tmpdir(), "tlt-hourly-retirement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-20T12:00:00Z") });
  const requests = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request"); });
  const empty = { status: "waiting_for_free_hourly_access", through: null, retrievedAt: null, metrics: 0 };
  assert.deepEqual(await prepareTltClosingTrend(root), empty);

  const dir = join(root, ".consensus/private-market-history/tlt-closing-trend");
  const sessions = ["2026-11-16", "2026-11-17"].map((day, i) => ({
    ...exchangeSession(day)!, open: 100, close: 100 + i,
  }));
  const capturedAt = "2026-11-19T12:00:00.000Z", hash = "a".repeat(64);
  const from = sessions[0].session, through = sessions[1].session;
  const control = { instrument: "TLT", from, through, sessions, sha256: hash, priceDigest: digest(sessions) };
  for (const basis of ["raw", "splits"]) await durableJSON(join(dir, `TLT-2026-${from}-${through}-${basis}.json`), control);
  const body = sessions.map(row => JSON.stringify({ timestamp: row.session + "T20:00:00Z", symbol: "TLT",
    symbol_id: 11418, open: 100, high: 101, low: 99, close: row.close, volume: 100, vwap: 100,
    trade_count: 10, is_gap: false, gap_fill_method: 0 })).join("\n");
  const controls = [{ sha256: hash, priceDigest: control.priceDigest }];
  const review = { method: "tlt-consolidated-final-hour-v1", checkedAt: capturedAt,
    issuer: { through, issuer: { symbol: "TLT", sha256: hash, capturedAt, cash: [] } },
    capture: { source: `https://getmarkethistory.com/api/v1/bars/stocks/us/TLT/1h?start=${from}&end=${through}&adjust=raw&feed=consolidated`,
      text: body, sha256: createHash("sha256").update(body).digest("hex"), capturedAt, through: through + "T23:59:00Z", count: 2 },
    from, through, raw: controls, splits: controls };
  const receipt = digest(review), pointer = join(dir, "latest.json");
  await durableJSON(join(dir, receipt + ".json"), review, true);
  await durableJSON(pointer, { sha256: receipt });
  const original = await readFile(pointer);

  assert.deepEqual(await prepareTltClosingTrend(root, true), { ...empty, through, retrievedAt: capturedAt, metrics: 1 });
  t.mock.timers.setTime(Date.parse("2026-11-23T12:00:00Z"));
  assert.deepEqual(await prepareTltClosingTrend(root), empty);
  assert.deepEqual(await readFile(pointer), original);
  assert.equal(requests.mock.callCount(), 0);
});

test("preparation verifies, pins and replays an already delivered signed-in TLT hourly response", async t => {
  const root = await mkdtemp(join(tmpdir(), "tlt-hourly-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = "2026-11-20T12:00:00.000Z", captureTime = "2026-11-20T07:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  const requests = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request"); });
  const dir = join(root, ".consensus/private-market-history/tlt-closing-trend");
  const incoming = join(dir, "incoming-hourly.json"), pointer = join(dir, "latest.json");
  const from = "2026-10-15", through = "2026-11-19", hash = "b".repeat(64);
  const dates = exchangeSessions(from, through);
  const sessions = dates.map(day => ({ ...exchangeSession(day)!, open: 100, close: 100 }));
  const control = { instrument: "TLT", from: dates[0], through, sessions, sha256: hash, priceDigest: digest(sessions) };
  for (const basis of ["raw", "splits"]) await durableJSON(join(dir, `TLT-2026-${dates[0]}-${through}-${basis}.json`), control);
  const issuers = ["SPY", "QQQ", "DIA", "IWM", "TLT"].map(symbol => ({ symbol, sha256: hash, cash: [],
    capturedAt: "2026-11-19T22:00:00.000Z", source: symbol === "TLT"
      ? "https://www.ishares.com/us/products/239454/ishares-20-year-treasury-bond-etf?cid=synd" : "https://example.com/" }));
  const approval = { schemaVersion: 1, through, issuers, approvedAt: "2026-11-19T23:00:00.000Z" };
  await durableJSON(join(root, ".consensus/private-firstrate/approved.json"), { approval, sha256: digest(approval) });
  const body = sessions.map(row => JSON.stringify({ timestamp: new Date(Date.parse(row.closeAt) - 3_600_000).toISOString(),
    symbol: "TLT", symbol_id: 11418, open: 100, high: 101, low: 99, close: 100, volume: 100, vwap: 100,
    trade_count: 10, is_gap: false, gap_fill_method: 0 })).join("\n") + "\n";
  const headers = { "content-type": "application/x-ndjson", date: new Date(captureTime).toUTCString(),
    "x-feed": "consolidated", "x-data-through": through + "T23:59:00Z", "x-row-count": String(sessions.length),
    "x-bars-charged": "100", "x-session": "exchange America/New_York 00:00" };
  const source = `https://getmarkethistory.com/query/v1/bars/stocks/us/TLT/1h?start=${from}&end=${through}&adjust=raw&feed=consolidated&limit=5000`;
  const delivery = { source, status: 200, headers, text: body, sha256: createHash("sha256").update(body).digest("hex") };
  await durableJSON(incoming, delivery);
  assert.equal((await prepareTltClosingTrend(root)).status, "waiting_for_production_control");
  await assert.rejects(readFile(pointer));
  const login = "200 OK\nAuthorizations\n=====================\nAll Stocks,1/1/1998,1\n";
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const csv = dates.map(d => d.slice(5, 7) + "/" + d.slice(8) + "/" + d.slice(0, 4) + ",100,101,99,100,100").join("\n");
  for (const basis of ["raw", "splits"] as const) await durableJSON(join(dir, `subscriber-TLT-2026-${dates[0]}-${through}-${basis}.json`),
    { ...control, sha256: sha(csv), paid: { basis, csv, source: kibotHistorySource("TLT", dates[0], through, basis), capturedAt: captureTime,
      authorization: { source: "https://api.kibot.com/?action=login", capturedAt: captureTime, body: login, sha256: sha(login) } } });
  assert.equal((await prepareTltClosingTrend(root)).status, "verified_closing_trend");
  const original = await readFile(pointer);
  const reading = await loadTltClosingTrend(root, now);
  assert.equal(reading?.source.retrievedAt, captureTime);
  assert.equal(reading?.metrics.length, 3);
  assert.equal(reading?.series[0].date, through);
  for (const recheck of [false, true]) assert.equal((await prepareTltClosingTrend(root, recheck)).status, "reused");
  for (const invalid of [
    { ...delivery, source: source.replace("TLT/1h", "TLT/1d") }, { ...delivery, source: source.replace("TLT/1h", "QQQ/1h") },
    { ...delivery, source: source.replace("adjust=raw", "adjust=all") }, { ...delivery, source: source + "&adjust=raw" },
    { ...delivery, source: source + "&cursor=partial" }, { ...delivery, source: source + "&api_key=synthetic" },
    { ...delivery, source: source.replace("getmarkethistory.com", "example.com") },
    { ...delivery, status: 206 }, { ...delivery, sha256: "0".repeat(64) },
    { ...delivery, headers: { ...headers, "x-next-cursor": "page-two" } },
    { ...delivery, headers: { ...headers, "x-limit-clamped": "true" } },
    { ...delivery, headers: { ...headers, "x-row-count": String(sessions.length - 1) } },
    { ...delivery, headers: { ...headers, "x-feed": "iex" } },
    { ...delivery, headers: { ...headers, "x-session": "UTC" } },
    { ...delivery, headers: { ...headers, date: "Sat, 21 Nov 2026 07:00:00 GMT" } },
  ]) {
    await durableJSON(incoming, invalid);
    await assert.rejects(prepareTltClosingTrend(root, true));
  }
  assert.deepEqual(await readFile(pointer), original);
  assert.equal(requests.mock.callCount(), 0);
});

test("closing trend publishes rounded TLT percentages with no opening mark or direction", () => {
  const signal = tltCloseSignal("2026-11-16", [0.0123, -3.149, 0.321], "2026-11-18T09:00:00.000Z", "a".repeat(64));
  assert.deepEqual(signal.metrics.map(m => m.value), [0, -3.1, 0.3]);
  assert.deepEqual(signal.instruments, ["TLT"]);
  assert.equal(signal.source.observedAt, "2026-11-16T21:00:00.000Z");
  for (const mutated of [
    { ...signal, scores: { ...signal.scores, daily: 0.2 } }, { ...signal, directionalInstruments: ["TLT" as const] },
    { ...signal, metrics: [{ ...signal.metrics[0], open: 100 }] },
    { ...signal, series: [{ ...signal.series[0], close: 98.75 }] }, { ...signal, bars: [{ open: 100 }] },
    { ...signal, source: { ...signal.source, rawBars: [{ close: 98.75 }] } },
    { ...signal, source: { ...signal.source, observedAt: "2026-11-16T20:00:00.000Z" } },
  ]) assert.throws(() => validateTltCloseSignal(mutated), /Invalid closing-hour/);
});

test("pending Nasdaq shortened sessions break each public TLT lookback that crosses them", () => {
  const retrieved = "2026-12-03T14:00:00.000Z", hash = "b".repeat(64);
  for (const [day, values] of [["2026-11-27", [1]], ["2026-11-30", [1]], ["2026-12-01", [1, 5]]] as const)
    assert.throws(() => tltCloseSignal(day, [...values], retrieved, hash), /full sessions/);
  assert.doesNotThrow(() => tltCloseSignal("2026-12-01", [1], retrieved, hash));
});

test("native TLT trends need 2, 6 and 21 consecutive full closes from one approval", () => {
  const dates = exchangeSessions("2026-10-12", "2026-11-20").slice(-21);
  const retrievedAt = "2026-11-23T00:00:00.000Z", approvedAt = "2026-11-23T00:05:00.000Z";
  const root: ReviewedTltSettlement = {sha256: "1".repeat(64), retrievedAt, approvedAt,
    prices: {source: MARKET_HISTORY_SOURCE, instrument: "TLT", adjustment: OUTCOME_PRICE_BASIS, expectedSessions: dates,
      sessions: dates.map((day, i) => ({...exchangeSession(day)!, open: 100, close: 100+i}))}};
  const read = (rows: typeof root.prices.sessions) => settledTltCloseSignal({...root, prices: {...root.prices, sessions: rows}}, approvedAt);
  const rows = root.prices.sessions;
  assert.equal(read(rows.slice(-1)), null);
  for (const [size, horizons] of [[2,1],[5,1],[6,2],[16,2],[20,2],[21,3]])
    assert.equal(read(rows.slice(-size))!.metrics.length, horizons);
  assert.deepEqual(read(rows)!.metrics.map(m=>m.value), [0.8, 4.3, 20]);
  assert.equal(read(rows.filter(row=>row.session!==dates.at(-4)))!.metrics.length,1);
  const latestMissing = rows.at(-1)!;
  assert.equal(read([...rows.slice(0,-1), {...latestMissing,closeAt:"2026-11-20T22:00:00.000Z"}]),null);
  assert.equal(settledTltCloseSignal(root, "2026-11-25T21:00:00.001Z"), null);
  assert.equal(settledTltCloseSignal(root, "2026-11-23T00:04:59.999Z"), null);
  assert.equal(settledTltCloseSignal({...root,prices:{...root.prices,instrument:"SPY"}}, approvedAt), null);
  assert.equal(settledTltCloseSignal({...root,prices:{...root.prices,source:"https://other.example"}}, approvedAt), null);
  assert.equal(settledTltCloseSignal({...root,prices:{...root.prices,adjustment:"raw"}}, approvedAt), null);
  const check = read(rows.slice(-6))!;
  for (const change of [{approvedAt: "2026-11-22T23:00:00.000Z"}, {approvedAt: undefined}, {url:"https://getmarkethistory.com/docs/bars/"}])
    assert.throws(()=>validateTltCloseSignal({...check,source:{...check.source,...change}}, approvedAt),/Invalid closing-hour/);
  assert.throws(()=>validateTltCloseSignal(check,retrievedAt),/Invalid closing-hour/);
  assert.match(pendingSettledTltInputs(check, dates.at(-1)),/opening range and twenty-session trend/);
  assert.match(pendingSettledTltInputs(check, dates.at(-2)),/full-session range/);
  assert.doesNotMatch(pendingSettledTltInputs(check, dates.at(-1)),/opening price/);
  const shortDates=exchangeSessions("2026-11-19","2026-12-02");
  const december = {...root,approvedAt:"2026-12-03T00:00:00.000Z",retrievedAt:"2026-12-02T23:00:00.000Z",
    prices:{...root.prices,expectedSessions:shortDates,sessions:shortDates.map(day=>({...exchangeSession(day)!,open:100,close:100}))}};
  assert.equal(settledTltCloseSignal(december, december.approvedAt)!.metrics.length, 1);
});
