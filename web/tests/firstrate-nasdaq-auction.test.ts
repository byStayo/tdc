import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { FIRST_RATE_SYMBOLS, loadFirstRatePrices, prepareFirstRate, reconcileFirstRateRows } from "../lib/consensus/firstrate.ts";
import { readQqqAuction, qqqAuctionUrls } from "../lib/consensus/firstrate-nasdaq-auction.ts";
import { digest } from "../lib/consensus/history.ts";

const day = "2026-11-20";
const daily = { session: day, open: 100.01, close: 98.6 };
const raw = { ...exchangeSession(day)!, open: 100, close: 99 };
const core = { ...raw, minutes: 390 };
const urls = qqqAuctionUrls(day);
const nocp = { status: { rCode: 200 }, data: { headers: { date: "Trade Date", price: "Nasdaq Closing Price" },
  nocp: { nocpTable: [{ date: "11/20/2026", price: "$98.60" }], nocpChart: [{ x: Date.parse(day) / 1000,
    y: "98.60", z: { date: "Friday , Nov 20, 2026", details: "QQQ Close Price: $98.60" } }] } } };
const header = "Date      ,Symbol,ListingMarket,OpeningCross,ClosingCross,IntradayCross,";
const cross = header + "\n11/20/2026,QQQ   ,       ,    1000,     2000,    0,\n";
const fetcher = (official = JSON.stringify(nocp), volumes = cross) => async (url: string) =>
  new Response(url === urls.nocp ? official : url === urls.cross ? volumes : null,
    { status: [urls.nocp, urls.cross].includes(url) ? 200 : 404 });

test("a genuine Nasdaq closing cross explains an official daily close only when the full continuous session matches independent raw and split prices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "first-rate-nocp-"));
  try {
    const auction = (await readQqqAuction(dir, day, false, fetcher()))!;
    assert.equal(auction.officialClose, 98.6);
    assert.equal(auction.crossShares, 2000);
    assert.deepEqual(await readQqqAuction(dir, day, true), auction);
    const result = (bar = daily, minute = core, proofs = [auction], symbol: "QQQ" | "SPY" = "QQQ") =>
      reconcileFirstRateRows(symbol, [bar], [raw], [raw], [], [minute], proofs);
    const withheld = [{ session: day, reason: "price" }];
    assert.deepEqual(result().rows, [raw]);
    assert.deepEqual(result().regularMinuteSessions, [day]);
    assert.deepEqual(result(daily, core, []).withheld, withheld);
    assert.deepEqual(result(daily, core, [auction], "SPY").withheld, withheld);
    assert.deepEqual(result({ ...daily, open: 100.04 }).withheld, withheld);
    assert.deepEqual(result({ ...daily, close: 98.61 }).withheld, withheld);
    assert.deepEqual(result(daily, { ...core, open: 100.001 }).withheld, withheld);
    assert.deepEqual(result(daily, { ...core, close: 98.999 }).withheld, withheld);
    assert.deepEqual(result(daily, { ...core, minutes: 389 }).withheld, withheld);
    assert.deepEqual(result({ ...daily, close: 100.2 }, core, [{ ...auction, officialClose: 100.2 }]).withheld, withheld);
    assert.throws(() => reconcileFirstRateRows("QQQ", [daily], [raw], [{ ...raw, close: 98.9 }], [], [core], [auction]), /split-basis/);
    const path = join(dir, "nasdaq-QQQ-auction-" + day + ".json");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    receipt.cross.sha256 = "d".repeat(64);
    await writeFile(path, JSON.stringify(receipt));
    await assert.rejects(readQqqAuction(dir, day, true), /receipt/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the Nasdaq auction requires the exact ETF, both prices, a dated full-lot cross, and unique matching records", async () => {
  const official = JSON.stringify(nocp);
  for (const [json, csv] of [
    [official.replace("QQQ Close Price", "TLT Close Price"), cross],
    [official.replace("$98.60", "$98.61"), cross],
    [official.replace("Friday , Nov 20", "Thursday , Nov 19"), cross],
    [official, cross.replace("QQQ", "TQQQ")],
    [official, cross.replace("11/20", "11/19")],
    [official, cross.replace("2000", "99")],
    [official, cross + cross.split("\n")[1] + "\n"],
  ]) {
    const dir = await mkdtemp(join(tmpdir(), "first-rate-invalid-nocp-"));
    try {
      assert.equal(await readQqqAuction(dir, day, true), null);
      await assert.rejects(readQqqAuction(dir, day, false, fetcher(json, csv)), /Nasdaq/);
      assert.equal(await readQqqAuction(dir, day, true), null);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("normal preparation recovers a prior QQQ dispute from pinned inputs when the newest ZIP is late, and offline replay admits no substitute", async () => {
  const root = await mkdtemp(join(tmpdir(), "firstrate-qqq-replay-"));
  const originalFetch = globalThis.fetch;
  try {
    const privateDir = join(root, ".consensus/private-firstrate");
    const scripts = join(root, "scripts");
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    await mkdir(scripts);
    await writeFile(join(scripts, "collect-firstrate-inputs.py"), [
      "import pathlib, sys",
      "p = pathlib.Path(__file__).parent",
      "with (p/'calls.txt').open('a') as calls: print(' '.join(sys.argv[1:]),file=calls)",
      "print((p/(sys.argv[1]+'.json')).read_text())",
    ].join("\n"));
    const from = "2026-11-19", next = "2026-11-23", stamp = day + "T22:00:00.000Z";
    const prior = { ...exchangeSession(from)!, open: 100, close: 101 };
    const sample = { symbol: "QQQ", url: "https://frd001.s3.us-east-2.amazonaws.com/frd_sample_etf_QQQ.zip",
      sha256: digest("Friday archive"), basis: "split-adjusted", capturedAt: stamp, modifiedAt: stamp,
      rows: [prior, daily], regularMinutes: [core] };
    const issuers = [...FIRST_RATE_SYMBOLS, "TLT"].map(symbol => ({ symbol, source: "https://example.test/issuer",
      sha256: digest(symbol), capturedAt: stamp, cash: [] }));
    const failures = FIRST_RATE_SYMBOLS.map(symbol => ({ symbol, reason: "file delayed" }));
    await writeFile(join(scripts, day + ".json"), JSON.stringify({ samples: [sample], issuers,
      sampleFailures: failures.filter(row => row.symbol !== "QQQ") }));
    await writeFile(join(scripts, next + ".json"), JSON.stringify({ samples: [], issuers: [], sampleFailures: failures }));
    for (const basis of ["raw", "splits"]) await writeFile(join(privateDir, `QQQ-2026-${from}-${day}-${basis}.json`),
      JSON.stringify({ instrument: "QQQ", from, through: day, sha256: digest(basis),
        priceDigest: digest([prior, raw]), sessions: [prior, raw] }), { mode: 0o600 });
    let requests = 0;
    globalThis.fetch = async (input) => { requests++; return fetcher()(String(input)); };
    assert.equal((await prepareFirstRate(root, true, stamp)).status, "qualified");
    assert.equal((await prepareFirstRate(root, false, stamp, true)).status, "no_verified_disputes");
    assert.equal(requests, 0);
    const result = await prepareFirstRate(root, false, next + "T22:00:00.000Z");
    assert.equal(result.status, "qualified");
    assert.equal("awaitingSession" in result && result.awaitingSession, next);
    assert.equal(requests, 2);
    const [evidence] = await loadFirstRatePrices(root);
    assert.deepEqual(evidence.sessions, [prior, raw]);
    assert.equal((await prepareFirstRate(root, false, stamp, true)).status, "reused");
    assert.equal(requests, 2);
    const calls = (await readFile(join(scripts, "calls.txt"), "utf8")).trim().split("\n");
    assert.ok(calls.filter(call => call.startsWith(day)).slice(0, 3).every(call => call.includes("--cached-only")));
    const proof = JSON.parse(await readFile(join(privateDir, "approved.json"), "utf8")).approval.symbols[0].proof.minuteRepairs[0];
    assert.equal(proof.source.sha256, sample.sha256);
    assert.equal(proof.captureSession, day);
    assert.equal(proof.auction.nocp.source, urls.nocp);
    const file = join(privateDir, "nasdaq-QQQ-auction-" + day + ".json");
    const captured = JSON.parse(await readFile(file, "utf8"));
    captured.cross.sha256 = "0".repeat(64);
    await writeFile(file, JSON.stringify(captured));
    await assert.rejects(loadFirstRatePrices(root), /receipt/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
