import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { digest } from "../lib/consensus/history.ts";
import { KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { FIRST_RATE_SOURCE } from "../lib/consensus/firstrate.ts";
import { dailySessionOutcomes } from "../lib/consensus/outcome-coverage-audit.ts";
import { loadEvaluationOutcomes, outcomeIndex } from "../lib/consensus/outcome-ledger.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import type { Snapshot } from "../lib/consensus/types.ts";
import { ETF_SYMBOLS, MARKETPARQUET_SOURCE, type MarketParquetDay } from "../lib/consensus/marketparquet.ts";
import * as settlement from "../lib/consensus/marketparquet-settlement.ts";

const dates = exchangeSessions("2026-11-19", "2026-11-30"), through = dates.at(-1)!;
const reviewed = "2026-11-30T22:10:00.000Z";
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const issuerURLs = {
  SPY: "https://www.ssga.com/bin/v1/ssmp/fund/dividend-distribution?country=us&language=en&role=intermediary&product=etfs&ticker=SPY",
  DIA: "https://www.ssga.com/bin/v1/ssmp/fund/dividend-distribution?country=us&language=en&role=intermediary&product=etfs&ticker=DIA",
  QQQ: "https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/46090E103/distribution?idType=cusip&productType=ETF",
  IWM: "https://www.ishares.com/us/products/239710/ishare",
  TLT: "https://www.ishares.com/us/products/239454/ishares-20-year-treasury-bond-etf?cid=synd",
};

function proof(sessions = dates, closing = 101) {
  const through = sessions.at(-1)!, captured = through + "T22:04:00.000Z", reviewed = through + "T22:10:00.000Z";
  const grant = JSON.stringify({ plan: "full", assets: [{ asset_type: "etf_daily", access: "full" }] });
  const bytes = Buffer.alloc(80);
  for (let i = 0; i < 5; i++) { bytes.writeDoubleBE(100, i * 16); bytes.writeDoubleBE(closing, i * 16 + 8); }
  const bars = sessions.map(session => ({ session, sha256: hash(session),
    bars: Object.fromEntries(ETF_SYMBOLS.map(symbol => [symbol, { open: 100, close: closing }])) as MarketParquetDay["bars"] }));
  const amount = Buffer.alloc(8); amount.writeDoubleBE(0.4);
  const distributions = ETF_SYMBOLS.map(symbol => ({ symbol, source: issuerURLs[symbol], responseUrl: issuerURLs[symbol],
    sha256: hash(symbol), capturedAt: through + "T22:03:00.000Z", actionsSha256: hash(symbol === "TLT" ? Buffer.concat([Buffer.from(sessions[1]), amount]) : ""),
    cash: symbol === "TLT" ? [{ session: sessions[1], amount: 0.4 }] : [] }));
  const ledger = { schemaVersion: 1, capturedAt: captured, expectedSessions: [...sessions], bars, distributions,
    licensedCapture: { entitlement: { source: "https://marketparquet.com/api/v1/assets",
      capturedAt: through + "T22:00:00.000Z", document: grant, sha256: hash(grant) },
    downloads: bars.map(file => ({ session: file.session, source: "https://marketparquet.com/api/v1/download/etf_daily/" + file.session,
      objectHost: "test.r2.cloudflarestorage.com", authorizedAt: through + "T22:01:00.000Z", retrievedAt: through + "T22:02:00.000Z",
      sha256: file.sha256, size: 23456, authorizationSha256: hash("grant" + file.session), pricesSha256: hash(bytes) })) } };
  const csv = sessions.map(day => day.slice(5, 7) + "/" + day.slice(8) + "/" + day.slice(0, 4) + `,100,102,99,${closing},1000`).join("\n");
  const controls = Object.fromEntries(ETF_SYMBOLS.map(symbol => [symbol, csv])) as Record<typeof ETF_SYMBOLS[number], string>;
  const ledgerText = JSON.stringify(ledger);
  const receipt = { schemaVersion: 1 as const, mode: "licensed", reconciledAt: reviewed, through, ledgerSha256: hash(ledgerText),
    ledgerText, earlyClosesVerified: sessions.filter(day => ["2026-11-27", "2026-12-24"].includes(day)), reference: { source: KIBOT_PRICE_CITATION, capturedAt: reviewed,
      hashes: Object.fromEntries(ETF_SYMBOLS.map(s => [s, hash(csv)])), csv: controls } };
  return { ledger, receipt };
}

test("reads a completed same-run paid five-ETF capture, with a reviewed short close and issuer ex-date", () => {
  const { receipt } = proof();
  const prices = settlement.licensedSettlementPrices(receipt, reviewed);
  assert.deepEqual(prices.map(row => row.instrument), ETF_SYMBOLS);
  const tlt = prices.find(row => row.instrument === "TLT")!;
  assert.ok(prices.every(row => row.source === MARKETPARQUET_SOURCE));
  assert.equal(tlt.sessions[0].open, 100 * (101 - 0.4) / 101);
  assert.equal(tlt.sessions[1].open, 100);
  assert.equal(tlt.sessions.find(row => row.session === "2026-11-27")?.closeAt, exchangeSession("2026-11-27")!.closeAt);
});

test("replays bounded independent responses across years and rejects a missing, overlapping or changed control chunk", async t => {
  const calendar = exchangeSessions("2026-01-02", "2027-11-24");
  const { receipt: legacy } = proof(calendar, 100.001);
  assert.ok(Date.parse(legacy.through) - Date.parse(calendar[0]) > 370 * 86_400_000);
  assert.throws(() => settlement.licensedSettlementPrices(legacy, legacy.reconciledAt), /control windows/);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(legacy.reconciledAt) });
  const rows = legacy.reference.csv.TLT.replaceAll(",100,", ",100." + "0".repeat(130) + ",").split("\n");
  assert.ok(Buffer.byteLength(rows.join("\n")) > 64 * 1024);
  const datesBySymbol = new Map<string, string[]>();
  const observed = await settlement.collectLicensedControls(calendar, async input => {
    const url = new URL(input), params = url.searchParams, symbol = params.get("symbol")!;
    assert.equal(url.origin, "https://api.kibot.com");
    assert.equal(params.get("unadjusted"), "1");
    const iso = (day: string) => day.slice(6) + "-" + day.slice(0, 2) + "-" + day.slice(3, 5);
    const first = calendar.indexOf(iso(params.get("startdate")!)), last = calendar.indexOf(iso(params.get("enddate")!));
    assert.ok(first >= 0 && last >= first);
    const csv = rows.slice(first, last + 1).join("\n");
    assert.ok(Buffer.byteLength(csv) < 64 * 1024);
    datesBySymbol.set(symbol, [...(datesBySymbol.get(symbol) ?? []), ...calendar.slice(first, last + 1)]);
    return new Response(csv);
  });
  const receipt = { ...legacy, schemaVersion: 2 as const, reference: { source: KIBOT_PRICE_CITATION,
    capturedAt: legacy.reconciledAt, chunks: observed.chunks } };
  assert.ok(observed.chunks.length > 1);
  const root = await mkdtemp(join(tmpdir(), "marketparquet-controls-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await settlement.recordLicensedSettlement(join(root, ".consensus/private-marketparquet"), receipt, legacy.reconciledAt);
  const verified = await settlement.loadLicensedSettlement(root, legacy.reconciledAt);
  for (const symbol of ETF_SYMBOLS) {
    assert.deepEqual(datesBySymbol.get(symbol), calendar);
    assert.deepEqual(observed.reference[symbol].map(row => row.session), calendar);
    assert.deepEqual(verified.find(row => row.instrument === symbol)!.sessions.map(row => row.session), calendar);
  }
  for (const mutate of [
    (parts: typeof observed.chunks) => { parts.splice(1, 1); },
    (parts: typeof observed.chunks) => { parts.splice(1, 0, parts[0]); },
    (parts: typeof observed.chunks) => { parts.at(-1)!.hashes.TLT = hash("other bytes"); },
    (parts: typeof observed.chunks) => { parts[1].capturedAt = calendar[0] + "T22:00:00.000Z"; },
    (parts: typeof observed.chunks) => {
      const last = parts.at(-1)!;
      last.csv.TLT = last.csv.TLT.replace(",100.001,", ",99.999,");
      last.hashes.TLT = hash(last.csv.TLT);
    },
  ]) {
    const changed = structuredClone(receipt);
    mutate(changed.reference.chunks);
    assert.throws(() => settlement.licensedSettlementPrices(changed, legacy.reconciledAt));
  }
});

test("independent proof withholds changed price values, public sample credentials, wrong issuer, stale/absent days and false direction", () => {
  for (const mutate of [
    (p: ReturnType<typeof proof>) => { p.ledger.bars[0].bars.TLT.close = 100.998; },
    (p: ReturnType<typeof proof>) => { Object.assign(p.ledger.bars[0].bars.TLT, { closeAt: "2026-11-19T20:00:00.000Z" }); },
    (p: ReturnType<typeof proof>) => { p.ledger.licensedCapture.entitlement.document = '{"plan":"free","assets":[]}'; p.ledger.licensedCapture.entitlement.sha256 = hash(p.ledger.licensedCapture.entitlement.document); },
    (p: ReturnType<typeof proof>) => { p.ledger.licensedCapture.downloads.pop(); },
    (p: ReturnType<typeof proof>) => { p.ledger.licensedCapture.downloads[0].source = "https://marketparquet.com/api/data/download/etf_daily/sample.parquet"; },
    (p: ReturnType<typeof proof>) => { p.ledger.expectedSessions.splice(2, 1); p.ledger.bars.splice(2, 1); p.ledger.licensedCapture.downloads.splice(2, 1); },
    (p: ReturnType<typeof proof>) => { p.ledger.distributions[0].source = issuerURLs.TLT; },
    (p: ReturnType<typeof proof>) => { p.ledger.distributions.find(s => s.symbol === "TLT")!.cash[0].amount = 0.01; },
    (p: ReturnType<typeof proof>) => { p.ledger.distributions[0].capturedAt = "2026-11-30T20:00:00.000Z"; },
    (p: ReturnType<typeof proof>) => { p.receipt.earlyClosesVerified = []; },
    (p: ReturnType<typeof proof>) => { p.receipt.reference.source = MARKETPARQUET_SOURCE; },
    (p: ReturnType<typeof proof>) => { p.receipt.reference.csv.TLT = p.receipt.reference.csv.TLT.replace(",101,", ",98,"); },
  ]) {
    const p = proof(); mutate(p);
    p.receipt.ledgerText = JSON.stringify(p.ledger); p.receipt.ledgerSha256 = hash(p.receipt.ledgerText);
    assert.throws(() => settlement.licensedSettlementPrices(p.receipt, reviewed));
  }
  assert.throws(() => settlement.licensedSettlementPrices(proof().receipt, "2026-11-30T20:00:00.000Z"));
});

test("default settlement ignores an unapproved sample, verifies the immutable receipt and reports corruption locally", async t => {
  const root = await mkdtemp(join(tmpdir(), "marketparquet-settlement-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, ".consensus/private-marketparquet");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const { receipt, ledger } = proof();
  await writeFile(join(dir, "sample.json"), JSON.stringify(ledger), { mode: 0o600 });
  await writeFile(join(dir, "licensed.json"), JSON.stringify(ledger), { mode: 0o600 });
  const warnings: string[] = [];
  assert.deepEqual(await settlement.defaultEvaluationPrices(root, reviewed, s => warnings.push(s)), []);
  await settlement.recordLicensedSettlement(dir, receipt, reviewed);
  assert.equal((await settlement.defaultEvaluationPrices(root, reviewed, s => warnings.push(s))).length, 5);
  assert.equal(warnings.length, 0);
  await assert.rejects(settlement.recordLicensedSettlement(dir, { ...receipt, reconciledAt: "2026-11-30T22:09:00.000Z",
    reference: { ...receipt.reference, capturedAt: "2026-11-30T22:08:00.000Z" } }, reviewed), /older/);
  const pointer = JSON.parse(await readFile(join(dir, "settlement-review.json"), "utf8"));
  assert.equal(pointer.sha256, digest(receipt));
  await writeFile(join(dir, "settlements", pointer.sha256 + ".json"), JSON.stringify({ ...receipt, through: dates[0] }));
  assert.deepEqual(await settlement.defaultEvaluationPrices(root, reviewed, s => warnings.push(s)), []);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /22:|,101,|api_key|Bearer/i);
});

test("the journalled evaluator selects complete vendor windows, retains settled rows and feeds daily reporting", async t => {
  const root = await mkdtemp(join(tmpdir(), "licensed-evaluator-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = join(root, "lib/consensus"), scripts = join(root, "scripts"), publicDir = join(root, "public/consensus");
  const privateDir = join(root, ".consensus"), vendor = join(privateDir, "private-marketparquet"), fr = join(privateDir, "private-firstrate");
  for (const d of [library, scripts, publicDir, vendor, fr]) await mkdir(d, { recursive: true, mode: 0o700 });
  const original = new URL("../lib/", import.meta.url);
  for (const [source, target] of [[original, join(root, "lib")], [new URL("consensus/", original), library]] as const)
    for (const name of (await readdir(source)).filter(n => n.endsWith(".ts")))
      await symlink(new URL(name, source), join(target, name));
  await copyFile(new URL("../scripts/evaluate-consensus.ts", import.meta.url), join(scripts, "evaluate-consensus.ts"));
  await copyFile(new URL("../scripts/reconcile-marketparquet.ts", import.meta.url), join(scripts, "reconcile-marketparquet.ts"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(library, "models.json"), '{"schemaVersion":1,"models":[]}');
  await writeFile(join(publicDir, "outcomes.json"), "[]");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const snapshots: Snapshot[] = [];
  async function edition(day: string) {
    const at = day + "T12:00:00.000Z";
    const snap: Snapshot = { schemaVersion: 1, origin: "prospective", engineVersion: "consensus-rules-2.0.0",
      id: at.replace(/[:.]/g, "-"), issuedAt: at, cutoff: at, signals: missingSignals(at), catalysts: [], sourcesAttempted: 1, collectionErrors: [] };
    snapshots.push(snap);
    await writeFile(join(publicDir, snap.id + ".json"), JSON.stringify(snap));
    await writeFile(join(publicDir, "index.json"), JSON.stringify(snapshots.map(s =>
      ({ id: s.id, issuedAt: s.issuedAt, engineVersion: s.engineVersion, sha256: digest(s) }))));
  }
  await edition(dates[0]);
  const { receipt, ledger } = proof();
  const approval = { schemaVersion: 1, source: FIRST_RATE_SOURCE, from: dates[0], through, approvedAt: reviewed,
    issuers: ledger.distributions, symbols: [{ symbol: "SPY", reviewedThrough: through, withheld: [], proof: { minuteRepairs: [] },
      rows: dates.slice(0, 2).map(day => ({ ...exchangeSession(day)!, open: 211.12345, close: 221.54321 })) }] };
  await writeFile(join(fr, "approved.json"), JSON.stringify({ approval, sha256: digest(approval) }), { mode: 0o600 });
  const testNow = "2026-12-01T18:00:00.000Z";
  const clock = "const D=Date; globalThis.Date=class extends D { constructor(...a){super(...(a.length?a:['" + testNow +
    "']));} static now(){return D.parse('" + testNow + "');} }; globalThis.fetch=async()=>{throw Error('Unexpected network request')};";
  const run = (...args: string[]) => execFileSync(process.execPath, ["--experimental-strip-types", "--import",
    "data:text/javascript," + encodeURIComponent(clock), "scripts/evaluate-consensus.ts", ...args], { cwd: root, encoding: "utf8" });
  const empty = join(root, "explicit-prices.json");
  await writeFile(empty, "[]", { mode: 0o600 });
  run("--prices", empty);
  assert.deepEqual(await loadEvaluationOutcomes(root), []);
  run();
  const existing = await loadEvaluationOutcomes(root);
  assert.deepEqual(existing.map(r => [r.instrument, r.horizon, r.source]), [["SPY", "daily", FIRST_RATE_SOURCE]]);
  await writeFile(join(vendor, "licensed.json"), receipt.ledgerText, { mode: 0o600 });
  const syntheticControl = clock + "const rows=" + JSON.stringify(receipt.reference.csv) +
    ";globalThis.fetch=async input=>{const url=new URL(input);if(url.hostname!=='api.kibot.com'||url.searchParams.get('unadjusted')!=='1')" +
    "throw Error('Unexpected control');return new Response(rows[url.searchParams.get('symbol')])};";
  const reconciliation = execFileSync(process.execPath, ["--experimental-strip-types", "--import",
    "data:text/javascript," + encodeURIComponent(syntheticControl), "scripts/reconcile-marketparquet.ts", "--licensed", "--record-review"],
  { cwd: root, encoding: "utf8" });
  assert.equal(JSON.parse(reconciliation).journalEligible, true);
  run();
  const accepted = await loadEvaluationOutcomes(root);
  assert.deepEqual(accepted.slice(0, 1), existing);
  const spyWeek = accepted.find(r => r.instrument === "SPY" && r.horizon === "weekly")!;
  assert.deepEqual([spyWeek.entry, spyWeek.exit, spyWeek.source], [100, 101, MARKETPARQUET_SOURCE]);
  const daily = dailySessionOutcomes(snapshots, accepted, dates[0], snapshots[0].engineVersion, { asOf: testNow, ledgerObservedAt: testNow });
  assert.equal(daily.eligibleOutcomes, 5);
  assert.deepEqual(JSON.parse(await readFile(join(publicDir, "outcomes.json"), "utf8")), outcomeIndex(accepted));
  assert.match(JSON.parse(await readFile(join(library, "performance.json"), "utf8")).note, /MarketParquet/);
  await edition(dates[1]);
  await writeFile(join(vendor, "settlement-review.json"), "{}");
  run();
  const retained = await loadEvaluationOutcomes(root);
  assert.deepEqual(retained.slice(0, accepted.length), accepted);
  assert.deepEqual(retained.slice(accepted.length).map(r => [r.instrument, r.horizon, r.source]), [["SPY", "daily", FIRST_RATE_SOURCE]]);
});
