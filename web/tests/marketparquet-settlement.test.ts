import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { digest } from "../lib/consensus/history.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { KIBOT_PRICE_CITATION } from "../lib/consensus/kibot.ts";
import { FIRST_RATE_SOURCE } from "../lib/consensus/firstrate.ts";
import { dailySessionOutcomes } from "../lib/consensus/outcome-coverage-audit.ts";
import { loadEvaluationOutcomes, outcomeIndex } from "../lib/consensus/outcome-ledger.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import type { Snapshot } from "../lib/consensus/types.ts";
import { ETF_SYMBOLS, MARKETPARQUET_SOURCE, type MarketParquetDay, type ReferenceBars } from "../lib/consensus/marketparquet.ts";
import { authenticatedFreeMarketHistoryResponse } from "../lib/consensus/market-history-hourly-access.ts";
import { evaluateOutcome } from "../lib/consensus/evaluation.ts";
import { collectMarketParquetDaily, loadMarketParquetDaily, registerMarketParquetDaily } from "../lib/consensus/marketparquet-daily.ts";
import { marketHistoryActionCachePath, sealMarketHistoryActionCapture, type MarketHistoryActionCapture } from "../lib/consensus/market-history-actions.ts";
import { marketParquetHourlyWindows, verifyMarketParquetHorizonSigns, type MarketParquetIssuerCash } from "../lib/consensus/marketparquet-market-history.ts";
import { writeHourlyFixtures } from "./fixtures/firstrate-hourly-controls.ts";
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

const loginBody = "200 OK\nAuthorizations\n=====================\nAll Stocks,1/1/1998,1\n";
function subscriber(capturedAt: string) {
  return { user: "test-paid-user", password: "test-paid-secret", proof: { source: "https://api.kibot.com/?action=login",
    capturedAt, body: loginBody, sha256: hash(loginBody) } };
}

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
  const account = subscriber(legacy.reconciledAt);
  const observed = await settlement.collectLicensedControls(calendar, account, async input => {
    const url = new URL(input), params = url.searchParams, symbol = params.get("symbol")!;
    assert.equal(url.origin, "https://api.kibot.com");
    assert.equal(params.get("unadjusted"), "1");
    assert.equal(params.get("user"), account.user);
    assert.equal(params.get("password"), account.password);
    const iso = (day: string) => day.slice(6) + "-" + day.slice(0, 2) + "-" + day.slice(3, 5);
    const first = calendar.indexOf(iso(params.get("startdate")!)), last = calendar.indexOf(iso(params.get("enddate")!));
    assert.ok(first >= 0 && last >= first);
    const csv = rows.slice(first, last + 1).join("\n");
    assert.ok(Buffer.byteLength(csv) < 64 * 1024);
    datesBySymbol.set(symbol, [...(datesBySymbol.get(symbol) ?? []), ...calendar.slice(first, last + 1)]);
    return new Response(csv);
  });
  const receipt = { ...legacy, schemaVersion: 3 as const, reference: { source: KIBOT_PRICE_CITATION, subscriber: account.proof,
    capturedAt: legacy.reconciledAt, chunks: observed.chunks } };
  assert.ok(observed.chunks.length > 1);
  const root = await mkdtemp(join(tmpdir(), "marketparquet-controls-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await settlement.recordLicensedSettlement(join(root, ".consensus/private-marketparquet"), receipt, legacy.reconciledAt);
  const verify = { through: legacy.through, reviewedAt: legacy.reconciledAt, ledgerSha256: receipt.ledgerSha256 };
  const verified = await settlement.loadLicensedSettlement(root, legacy.reconciledAt, verify);
  assert.deepEqual(await settlement.loadLicensedSettlement(root, legacy.reconciledAt, { ...verify, ledgerSha256: hash("other") }), []);
  const bad = structuredClone(receipt); bad.reference.subscriber.body = "200 OK";
  assert.throws(() => settlement.licensedSettlementPrices(bad, legacy.reconciledAt), /verified subscriber/);
  const v2 = { ...legacy, schemaVersion: 2 as const, reference: { source: KIBOT_PRICE_CITATION,
    capturedAt: legacy.reconciledAt, chunks: observed.chunks } };
  assert.equal(settlement.licensedSettlementPrices(v2, legacy.reconciledAt).length, 5);
  await assert.rejects(settlement.recordLicensedSettlement(join(root, ".consensus/private-marketparquet"), v2, legacy.reconciledAt),
    /verified subscriber/);
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
  await assert.rejects(settlement.recordLicensedSettlement(dir, receipt, reviewed), /verified subscriber/);
  await durableJSON(join(dir, "settlements", digest(receipt) + ".json"), receipt, true);
  await assert.rejects(settlement.recordLicensedSettlement(dir, receipt, reviewed), /verified subscriber/);
  await durableJSON(join(dir, "settlement-review.json"), { schemaVersion: 1, through, reviewedAt: reviewed, sha256: digest(receipt) });
  await settlement.recordLicensedSettlement(dir, receipt, reviewed);
  assert.deepEqual(await settlement.loadLicensedSettlement(root, reviewed,
    { through: receipt.through, reviewedAt: reviewed, ledgerSha256: receipt.ledgerSha256 }), []);
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
  const credentials = { user: "test-subscriber", password: "test-password" };
  const syntheticControl = clock + "const rows=" + JSON.stringify(receipt.reference.csv) +
    ";globalThis.fetch=async input=>{const url=new URL(input),p=url.searchParams;if(url.hostname!=='api.kibot.com'" +
    "||p.get('user')!=='test-subscriber'||p.get('password')!=='test-password')throw Error('Unexpected control');" +
    "if(p.get('action')==='login')return new Response(" + JSON.stringify(loginBody) + ");" +
    "if(p.get('unadjusted')!=='1')throw Error('Missing basis');return new Response(rows[p.get('symbol')])};";
  const reconcile = (...extra: string[]) => execFileSync(process.execPath, ["--experimental-strip-types", "--import",
    "data:text/javascript," + encodeURIComponent(syntheticControl), "scripts/reconcile-marketparquet.ts", "--licensed", "--record-review", ...extra],
    { cwd: root, encoding: "utf8", stdio: "pipe", env: { ...process.env, KIBOT_PRODUCTION_USER: undefined, KIBOT_PRODUCTION_PASSWORD: undefined } });
  assert.throws(() => reconcile(), /verified subscriber/);
  assert.throws(() => reconcile("--reference", empty), /verified production control/);
  await durableJSON(join(root, ".consensus/private-kibot/production-credentials.json"), credentials);
  const reconciliation = reconcile();
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

test("a chosen native hourly comparator seals every ordinary session and replays originals without network", async t => {
  const root = await mkdtemp(join(tmpdir(), "marketparquet-native-controls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = exchangeSessions("2026-09-22", "2026-11-20");
  const windows = marketParquetHourlyWindows(sessions);
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.flat(), sessions);
  const { ledger } = proof(sessions);
  const vendor = join(root, ".consensus/private-marketparquet");
  await mkdir(vendor, { recursive: true, mode: 0o700 });
  await durableJSON(join(vendor, "licensed.json"), ledger);
  await mkdir(join(root, "scripts"));
  await copyFile(new URL("../scripts/reconcile-marketparquet.ts", import.meta.url), join(root, "scripts/reconcile-marketparquet.ts"));
  await symlink(new URL("../lib/", import.meta.url), join(root, "lib"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  const noHttp = "data:text/javascript," + encodeURIComponent("globalThis.fetch = async () => { throw new Error('unexpected outbound request') }");
  const run = (args: string[], provider?: string) => execFileSync(process.execPath, [
    "--disable-warning=ExperimentalWarning", "--experimental-strip-types", "--import", noHttp,
    join(root, "scripts/reconcile-marketparquet.ts"), "--licensed", "--record-review", ...args,
  ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MARKETPARQUET_CONTROL: provider ?? "", MARKET_HISTORY_KEY: "" } });
  for (const days of windows) {
    const rows = days.map(day => ({ ...exchangeSession(day)!, open: 100, close: 101 }));
    for (const symbol of ETF_SYMBOLS) await writeHourlyFixtures(root, symbol, rows);
  }

  // The independent original initially omits the TLT issuer payment. The same paid original stays bound to the chosen comparator after failure.
  assert.throws(() => run(["--control", "market-history"]), /corporate-action|corporate actions|free Market History/i);
  assert.throws(() => run(["--control", "kibot"]), /source was already fixed/);
  const otherPackaging = structuredClone(ledger);
  otherPackaging.bars[0].sha256 = hash("unrelated ETF metadata changed");
  otherPackaging.licensedCapture.downloads[0].sha256 = otherPackaging.bars[0].sha256;
  await assert.rejects(settlement.reserveMarketParquetControl(vendor, otherPackaging, "kibot"), /source was already fixed/);
  await assert.rejects(readFile(join(vendor, "settlement-review.json")), { code: "ENOENT" });
  const nativeActions = marketHistoryActionCachePath(root, "TLT", windows[0][0], windows[0].at(-1)!);
  const saved = JSON.parse(await readFile(nativeActions, "utf8")).capture as MarketHistoryActionCapture;
  saved.raw = JSON.stringify({ id: "native-TLT", symbol: "TLT", cusip: "464287432", ex_date: sessions[1],
    type: "cash_dividends", rate: 0.4, source: null }) + "\n";
  saved.sha256 = hash(saved.raw);
  saved.headers["x-row-count"] = "1";
  saved.headers["x-bars-charged"] = "1000";
  await durableJSON(nativeActions, sealMarketHistoryActionCapture(saved));
  const result = JSON.parse(run([], "market-history"));
  assert.deepEqual([result.mode, result.passed, result.reviewRecorded, result.journalEligible],
    ["licensed", true, true, true]);
  const pointerText = await readFile(join(vendor, "settlement-review.json"), "utf8");
  const pointer = JSON.parse(pointerText);
  const receipt = JSON.parse(await readFile(join(vendor, "settlements", pointer.sha256 + ".json"), "utf8"));
  assert.equal(receipt.schemaVersion, 4);
  assert.equal(receipt.reference.source, "https://getmarkethistory.com/docs/bars/");
  assert.deepEqual(receipt.reference.chunks.map((chunk: { funds: { symbol: string }[] }) => chunk.funds.map(f => f.symbol)),
    windows.map(() => [...ETF_SYMBOLS]));
  assert.equal(JSON.stringify(receipt.reference).includes("Authorization"), false);
  const bound = { through: pointer.through, reviewedAt: pointer.reviewedAt, ledgerSha256: receipt.ledgerSha256 };
  const verified = await settlement.loadLicensedSettlement(root, pointer.reviewedAt, bound);
  assert.equal(verified.length, 5);
  assert.equal(verified.find(row => row.instrument === "TLT")!.sessions[0].open, 100 * (101 - 0.4) / 101);
  const controlStore = join(root, ".consensus/private-market-history/firstrate-controls");
  const final = windows.at(-1)!;
  for (const basis of ["raw", "splits"]) {
    const closeFile = join(controlStore, ["QQQ", final[0], final.at(-1), basis, "close"].join("-") + ".json");
    const original = JSON.parse(await readFile(closeFile, "utf8"));
    const lines = original.text.trim().split("\n").map((line: string) => JSON.parse(line));
    lines.at(-1).close = 100.74;
    original.text = lines.map((line: object) => JSON.stringify(line)).join("\n") + "\n";
    original.sha256 = hash(original.text);
    await durableJSON(closeFile, original);
  }
  try {
    run(["--control", "market-history"]);
    assert.fail("A discrepant day must withhold the native review");
  } catch (error) {
    const failure = error as { status: number; stdout: string };
    assert.equal(failure.status, 2);
    const rejected = JSON.parse(failure.stdout);
    assert.equal(rejected.passed, false);
    assert.equal(rejected.reviewRecorded, false);
    assert.equal(rejected.verifiedThrough, sessions.at(-2));
    assert.equal(rejected.symbols.find((row: { symbol: string }) => row.symbol === "QQQ").differing[0], sessions.at(-1));
  }
  assert.equal(await readFile(join(vendor, "settlement-review.json"), "utf8"), pointerText);

  const file = join(controlStore, ["SPY", windows[0][0], windows[0].at(-1), "raw", "open"].join("-") + ".json");
  const original = JSON.parse(await readFile(file, "utf8"));
  original.headers["x-bars-remaining"] = "2999";
  await durableJSON(file, original);
  await assert.rejects(settlement.loadLicensedSettlement(root, pointer.reviewedAt, bound), /originals differ/);
  const incomplete = structuredClone(receipt);
  incomplete.reference.chunks.pop();
  await assert.rejects(settlement.recordLicensedSettlement(vendor, incomplete, pointer.reviewedAt), /originals differ/);
  assert.equal(await readFile(join(vendor, "settlement-review.json"), "utf8"), pointerText);
});

test("short sessions and skipped dates are ineligible before any native comparator request", () => {
  const dates = exchangeSessions("2026-11-23", "2026-11-30");
  assert.throws(() => marketParquetHourlyWindows(dates), /shortened session 2026-11-27/);
  assert.throws(() => marketParquetHourlyWindows(dates.filter(day => day !== "2026-11-27")), /every exchange session/);
  assert.throws(() => marketParquetHourlyWindows([]), /every exchange session/);
});

test("native controls with agreeing daily signs can disagree over a weekly or monthly holding period", () => {
  const dates = exchangeSessions("2026-09-22", "2026-10-23").slice(0, 21);
  for (const span of [5, 21]) {
    const { ledger } = proof(dates.slice(0, span));
    const cash = Object.fromEntries(ETF_SYMBOLS.map(s => [s, []])) as unknown as MarketParquetIssuerCash;
    const refs = Object.fromEntries(ETF_SYMBOLS.map(s => [s, ledger.bars.map(file => ({
      session: file.session, ...file.bars[s],
    }))])) as ReferenceBars;
    const last = ledger.bars[span - 1].bars.QQQ;
    last.open = 99.9;
    last.close = 100.002;
    Object.assign(refs.QQQ[span - 1], { open: 99.9, close: 99.998 });
    if (span === 21) {
      // The final five-session return remains positive in both series. Only the 21-session endpoints disagree.
      ledger.bars[span - 5].bars.QQQ.open = 99.9;
      refs.QQQ[span - 5].open = 99.9;
    }
    assert.throws(() => verifyMarketParquetHorizonSigns(ledger.bars, refs, cash),
      new RegExp("horizon direction differs for QQQ from " + dates[0] + " through " + dates[span - 1]));
    refs.QQQ[span - 1].close = 100.001;
    assert.doesNotThrow(() => verifyMarketParquetHorizonSigns(ledger.bars, refs, cash));
  }
});

test("prospective daily approvals survive a mismatched fund, a missing older vendor file and a shortened session", async t => {
  const root = await mkdtemp(join(tmpdir(), "marketparquet-daily-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-19T19:00:00.000Z") });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network"); });
  const policy = await registerMarketParquetDaily(root);
  assert.equal(policy.registeredAt, "2026-11-19T19:00:00.000Z");
  const store = join(root, ".consensus/private-marketparquet");
  const makeLedger = (through: string) => {
    const { ledger } = proof(exchangeSessions("2026-11-18", through));
    for (const row of ledger.distributions) { row.cash = []; row.actionsSha256 = hash(""); }
    return ledger;
  };
  for (const day of ["2026-11-20", "2026-11-25", "2026-11-30"]) {
    for (const symbol of ETF_SYMBOLS) {
      const close = day === "2026-11-20" && symbol === "QQQ" ? 100.73 : 101;
      await writeHourlyFixtures(root, symbol, [{ ...exchangeSession(day)!, open: 100, close }]);
    }
  }
  t.mock.timers.setTime(Date.parse("2026-11-20T23:30:00.000Z"));
  const initially = await collectMarketParquetDaily(root, makeLedger("2026-11-20"), policy);
  assert.equal(initially.accepted.length, 4);
  assert.deepEqual(initially.withheld, [{ symbol: "QQQ", day: "2026-11-20", reason: "price_difference" }]);
  assert.equal((await registerMarketParquetDaily(root)).registeredAt, policy.registeredAt);

  t.mock.timers.setTime(Date.parse("2026-11-30T23:30:00.000Z"));
  const latest = makeLedger("2026-11-30"), missing = "2026-11-19";
  latest.bars = latest.bars.filter(row => row.session !== missing);
  latest.licensedCapture.downloads = latest.licensedCapture.downloads.filter(row => row.session !== missing);
  await durableJSON(join(store, "licensed.json"), latest);
  await mkdir(join(root, "scripts"));
  await copyFile(new URL("../scripts/reconcile-marketparquet.ts", import.meta.url), join(root, "scripts/reconcile-marketparquet.ts"));
  await symlink(new URL("../lib/", import.meta.url), join(root, "lib"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  const setClock = "const Real=Date, now=" + Date.now() +
    "; globalThis.Date=class extends Real { constructor(...a){super(...(a.length?a:[now]))} static now(){return now} }; globalThis.fetch=async()=>{throw Error('Unexpected network')}";
  const run = () => execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types",
    "--import", "data:text/javascript," + encodeURIComponent(setClock), join(root, "scripts/reconcile-marketparquet.ts"),
    "--licensed", "--record-review"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MARKETPARQUET_CONTROL: "", MARKET_HISTORY_KEY: "" } });
  // The cumulative paid archive fails. The separately frozen daily lane has already committed its qualified funds.
  const report = JSON.parse(run());
  assert.deepEqual(report.multiSession, { status: "withheld", reason: "incomplete_archive_calendar" });
  assert.deepEqual(report.daily.shortenedSessions, ["2026-11-27"]);
  assert.equal(report.shouldRunProspectiveEvaluation, true);
  assert.equal(report.daily.accepted.length, 10);
  const asOf = new Date().toISOString(), prices = await loadMarketParquetDaily(root, asOf);
  assert.equal(prices.length, 14);
  assert.ok(prices.every(series => series.sessions.length === 1 && series.expectedSessions.length === 2 && series.expectedSessions[0] < series.sessions[0].session));
  assert.deepEqual(prices.filter(series => series.sessions[0].session === "2026-11-30").map(row => row.instrument).sort(), [...ETF_SYMBOLS].sort());
  assert.ok(prices.every(row => row.sessions[0].session !== "2026-11-27" && row.sessions[0].session > "2026-11-19"));
  assert.equal(prices.find(row => row.instrument === "QQQ" && row.sessions[0].session === "2026-11-20"), undefined);
  assert.equal((await settlement.defaultEvaluationPrices(root, asOf)).length, prices.length);
  const issue = "2026-11-29T23:00:00.000Z";
  const snapshot: Snapshot = { schemaVersion: 1, origin: "prospective", id: issue.replace(/[:.]/g, "-"), issuedAt: issue,
    cutoff: issue, engineVersion: "consensus-rules-2.0.0", signals: missingSignals(issue), catalysts: [], sourcesAttempted: 1, collectionErrors: [] };
  const mondayQqq = prices.find(row => row.instrument === "QQQ" && row.sessions[0].session === "2026-11-30")!;
  assert.equal(evaluateOutcome(snapshot, mondayQqq, "daily", asOf)?.instrument, "QQQ");
  assert.ok(prices.every(row => evaluateOutcome(snapshot, row, "weekly", asOf) === null && evaluateOutcome(snapshot, row, "monthly", asOf) === null));
  assert.deepEqual(await settlement.loadLicensedSettlement(root, asOf), []);
});

test("a bounded native review relinquishes its lock deadline during provider backoff", async () => {
  const deadline = new AbortController();
  let requests = 0;
  const source = "https://getmarkethistory.com/query/v1/fee-rules?dataset=stocks%2Fus";
  const result = authenticatedFreeMarketHistoryResponse(source, "synthetic-free-key", async () => {
    requests++;
    setImmediate(() => deadline.abort());
    return new Response(null, { status: 429, headers: { "retry-after": "60" } });
  }, deadline.signal);
  await assert.rejects(result);
  assert.equal(requests, 1);
});
