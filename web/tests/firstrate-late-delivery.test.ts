import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { FIRST_RATE_SYMBOLS, confirmFirstRateHoldingPeriods, loadFirstRateTechnicals, prepareFirstRate } from "../lib/consensus/firstrate.ts";
import { writeHourlyFixtures } from "./fixtures/firstrate-hourly-controls.ts";
import { digest } from "../lib/consensus/history.ts";
import { evaluateOutcome } from "../lib/consensus/evaluation.ts";
import { defaultEvaluationPrices } from "../lib/consensus/marketparquet-settlement.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "daily-consensus-late-firstrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("Fixtures must run offline"); });
  t.after(() => assert.equal(network.mock.callCount(), 0));
  const scripts = join(root, "scripts");
  const privateDir = join(root, ".consensus/private-firstrate");
  await mkdir(scripts);
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  await writeFile(join(scripts, "collect-firstrate-inputs.py"), [
    "import json, pathlib, sys",
    "base = pathlib.Path(__file__).parent",
    "with (base/'attempts.jsonl').open('a') as log: print(json.dumps(sys.argv[1:]), file=log)",
    "with (pathlib.Path(__file__).parent/(sys.argv[1]+'.json')).open() as fixture: print(fixture.read())",
  ].join("\n"));
  const from = "2026-11-03";
  async function sample(day: string, available: readonly string[], retainOriginals = false) {
    const rows = exchangeSessions(from, day).map((session, i) => ({ ...exchangeSession(session)!, open: 100 + i, close: 101 + i }));
    const stamp = day + "T22:00:00.000Z";
    const samples = FIRST_RATE_SYMBOLS.filter(ticker => available.includes(ticker)).map(symbol => ({
      symbol, url: `https://frd001.s3.us-east-2.amazonaws.com/frd_sample_etf_${symbol}.zip`,
      sha256: digest([symbol, day]), basis: "split-adjusted", capturedAt: stamp, modifiedAt: stamp,
      rows: rows.map(({ session, open, close }) => ({ session, open, close })), regularMinutes: [],
    }));
    const sampleFailures = FIRST_RATE_SYMBOLS.filter(ticker => !available.includes(ticker)).map(symbol => ({ symbol, kind: "unavailable", reason: "file delayed" }));
    const issuers = samples.length ? [...FIRST_RATE_SYMBOLS, "TLT"].map(symbol =>
      ({ symbol, source: "https://example.test/issuer", sha256: digest([symbol, day]), capturedAt: stamp, cash: [] })) : [];
    await writeFile(join(scripts, day + ".json"), JSON.stringify({ samples, sampleFailures, issuers }));
    if (retainOriginals) {
      const captured = join(privateDir, "captures", day);
      await mkdir(captured, { recursive: true, mode: 0o700 });
      const names = [...available.map(fund => "sample-" + fund), ...issuers.map(issuer => "issuer-" + issuer.symbol)];
      for (const name of names) for (const ext of [".bin", ".json"])
        await writeFile(join(captured, name + ext), "{}", {mode: 0o600});
    }
    for (const symbol of FIRST_RATE_SYMBOLS.filter(fund => available.includes(fund))) await writeHourlyFixtures(root, symbol, rows);
  }
  const stored = async () => JSON.parse(await readFile(join(privateDir, "approved.json"), "utf8")).approval;
  async function attempts(): Promise<string[][]> {
    return (await readFile(join(scripts, "attempts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  }
  return { root, scripts, privateDir, sample, stored, attempts };
}

test("a late old file advances its ETF without rolling back other ETFs or their newer issuer review", async t => {
  const { root, sample, stored } = await fixture(t);
  await sample("2026-11-10", FIRST_RATE_SYMBOLS);
  await prepareFirstRate(root, false, "2026-11-11T13:00:00.000Z");
  await sample("2026-11-11", []);
  await sample("2026-11-12", ["SPY", "IWM", "DIA"]);
  await prepareFirstRate(root, false, "2026-11-12T22:05:00.000Z");
  const initial = await stored();
  await sample("2026-11-11", ["QQQ"]);
  await prepareFirstRate(root, false, "2026-11-12T23:05:00.000Z");
  const corrected = await stored();
  assert.equal(corrected.through, "2026-11-12");
  assert.deepEqual(corrected.issuers, initial.issuers);
  for (const symbol of FIRST_RATE_SYMBOLS) {
    const current = corrected.symbols.find((row: { symbol: string }) => row.symbol === symbol);
    const previous = initial.symbols.find((row: { symbol: string }) => row.symbol === symbol);
    if (symbol === "QQQ") {
      assert.equal(previous.reviewedThrough, "2026-11-10");
      assert.equal(current.reviewedThrough, "2026-11-11");
      assert.deepEqual(current.rows.slice(0, -1), previous.rows);
    } else assert.deepEqual(current, previous);
  }
});

test("normal FirstRate settlement replays rolling controls, isolates a weekly sign reversal and preserves the daily price", async t => {
  const { root, scripts, sample } = await fixture(t);
  const comparisonStore = join(root, ".consensus/private-market-history/firstrate-controls");
  const exit = "2026-11-19", issue = "2026-11-13", asOf = "2026-11-20T13:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: new Date(asOf) });
  for (const [from, through] of [["2026-11-03", "2026-11-12"], ["2026-11-11", exit]]) {
    await sample(through, ["SPY"]);
    const sessions = exchangeSessions(from, through).map(day => ({ ...exchangeSession(day)!,
      open: day === exit ? 95 : 100, close: day === exit ? 100.01 : 101 }));
    const file = join(scripts, through + ".json");
    const fixture = JSON.parse(await readFile(file, "utf8"));
    fixture.samples[0].rows = sessions.map(({ session, open, close }) => ({ session, open, close }));
    await writeFile(file, JSON.stringify(fixture));
    await writeHourlyFixtures(root, "SPY", sessions.map(row => row.session === exit ? { ...row, close: 99.99 } : row));
    await prepareFirstRate(root, true, through + "T23:30:00.000Z");
  }
  const snapshot = JSON.parse(await readFile(new URL("../public/consensus/2026-11-03T08-48-02-469Z.json", import.meta.url), "utf8"));
  const [prices] = await defaultEvaluationPrices(root, asOf);
  const forecast = (day: string) => ({ ...snapshot, issuedAt: day + "T12:00:00.000Z" });
  assert.equal(evaluateOutcome(forecast(issue), prices, "weekly", asOf), null);
  assert.ok(evaluateOutcome(forecast(exit), prices, "daily", asOf));
  assert.ok(evaluateOutcome(forecast("2026-11-10"), prices, "weekly", asOf));
  // A changed older original withholds its crossing windows while the current daily receipt still works.
  await writeFile(join(comparisonStore, "SPY-2026-11-03-2026-11-12-raw-open.json"), "{}");
  t.mock.method(console, "warn", () => {});
  const [damaged] = await defaultEvaluationPrices(root, asOf);
  assert.equal(evaluateOutcome(forecast("2026-11-10"), damaged, "weekly", asOf), null);
  assert.ok(evaluateOutcome(forecast(exit), damaged, "daily", asOf));
});

test("a legacy price archive gains weekly eligibility only at its independent review, and damage to one fund stays local", async t => {
  const { root, sample, privateDir } = await fixture(t);
  const through = "2026-11-12", initialAt = "2026-11-13T13:00:00.000Z", reviewedAt = "2026-11-16T13:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: new Date(initialAt) });
  await sample(through, FIRST_RATE_SYMBOLS);
  await prepareFirstRate(root, true);
  const pointer = join(privateDir, "approved.json");
  const legacy = JSON.parse(await readFile(pointer, "utf8")).approval;
  for (const fund of legacy.symbols) { delete fund.proof.marketHistory; delete fund.proof.actions; }
  for (const name of await readdir(join(privateDir, "approvals"))) await rm(join(privateDir, "approvals", name));
  const stored = JSON.stringify({ approval: legacy, sha256: digest(legacy) });
  await writeFile(pointer, stored);
  await writeFile(join(privateDir, "approvals", through + ".json"), stored, { mode: 0o600 });
  const before = await defaultEvaluationPrices(root, initialAt);
  const originalTechnicals = await loadFirstRateTechnicals(root, initialAt);
  assert.ok(originalTechnicals.length > 0);
  assert.ok(before.length === 4 && before.every(p => p.confirmedHoldingPeriods?.weekly.length === 0));
  t.mock.timers.setTime(Date.parse(reviewedAt));
  assert.deepEqual((await confirmFirstRateHoldingPeriods(root, true)).confirmed, FIRST_RATE_SYMBOLS);
  const after = await defaultEvaluationPrices(root, reviewedAt);
  assert.ok(after.length === 4 && after.every(p => p.confirmedHoldingPeriods?.weekly.includes(through)));
  assert.deepEqual(await defaultEvaluationPrices(root, initialAt), before);
  assert.deepEqual(await loadFirstRateTechnicals(root, initialAt), originalTechnicals);
  assert.deepEqual(await defaultEvaluationPrices(root, "2026-11-01T12:00:00.000Z"), []);
  assert.equal((await confirmFirstRateHoldingPeriods(root, true)).status, "already_reviewed");
  // Now exercise a normal new approval independently of the historical supplement.
  await sample("2026-11-13", FIRST_RATE_SYMBOLS);
  await prepareFirstRate(root, true, "2026-11-13T23:15:00.000Z");
  await writeFile(join(root, ".consensus/private-market-history/firstrate-controls", "DIA-2026-11-03-2026-11-13-raw-open.json"), "{}");
  const warnings: string[] = [];
  assert.deepEqual((await defaultEvaluationPrices(root, reviewedAt, message => warnings.push(message))).map(p => p.instrument), ["SPY", "QQQ", "IWM"]);
  assert.ok(warnings.some(message => message.includes("DIA withheld")));
});

test("Wednesday reconciles Monday for four funds even with Tuesday delayed and no valid TLT settlement", async t => {
  const { root, privateDir, sample, attempts } = await fixture(t);
  const wednesday = "2026-11-25T12:48:00.000Z";
  const monday = "2026-11-23";
  const tuesday = "2026-11-24";
  await sample("2026-11-20", FIRST_RATE_SYMBOLS);
  await prepareFirstRate(root, true, "2026-11-20T23:30:00.000Z");
  await sample(monday, FIRST_RATE_SYMBOLS, true);
  await sample(tuesday, []);
  const review = await prepareFirstRate(root, false, wednesday);
  assert.ok("caughtUpSession" in review);
  assert.equal(review.caughtUpSession, monday);
  assert.equal(review.awaitingSession, tuesday);
  assert.ok("reviewed" in review);
  assert.deepEqual(review.reviewed, FIRST_RATE_SYMBOLS);
  const calls = await attempts();
  assert.deepEqual(calls.slice(1).map(args => [args[0], args.includes("--cached-only")]), [[monday, true], [tuesday, false]]);

  const tltStore = join(root, ".consensus/private-market-history/tlt-settlement/settlements");
  await mkdir(tltStore, { recursive: true, mode: 0o700 });
  await writeFile(join(tltStore, monday + "_" + monday + "_" + "a".repeat(64) + ".json"), "{}", { mode: 0o600 });
  const warnings: string[] = [];
  const prices = await defaultEvaluationPrices(root, wednesday, warning => warnings.push(warning));
  assert.deepEqual(prices.map(p => p.instrument), FIRST_RATE_SYMBOLS);
  assert.ok(warnings.some(warning => warning.includes("TLT settlement withheld")));
  const issue = "2026-11-23T13:00:00.000Z";
  const snapshot: Snapshot = { schemaVersion: 1, origin: "prospective", id: issue.replace(/[:.]/g, "-"),
    issuedAt: issue, cutoff: issue, engineVersion: "consensus-rules-2.0.0", signals: missingSignals(issue),
    sourcesAttempted: 1, catalysts: [], collectionErrors: [] };
  for (const price of prices) {
    const outcome = evaluateOutcome(snapshot, price, "daily", wednesday);
    assert.equal(outcome?.entryAt, exchangeSession(monday)!.openAt);
    assert.equal(outcome?.abstained, true);
    assert.equal(evaluateOutcome(snapshot, price, "weekly", wednesday), null);
  }
  const pointer = join(privateDir, "approved.json");
  const exact = await readFile(pointer);
  const archive = await readdir(join(privateDir, "approvals"));
  await assert.rejects(prepareFirstRate(root, false, wednesday), /could not verify a sample for 2026-11-24/);
  assert.deepEqual(await readFile(pointer), exact);
  assert.deepEqual(await readdir(join(privateDir, "approvals")), archive);
  assert.deepEqual(await defaultEvaluationPrices(root, wednesday, () => {}), prices);
});

test("the first weekday after Thanksgiving gives each fund its oldest retained unreviewed original", async t => {
  const { root, sample, stored, attempts } = await fixture(t);
  const mondayAfterThanksgiving = "2026-11-30T12:48:00.000Z";
  await sample("2026-11-19", FIRST_RATE_SYMBOLS);
  await prepareFirstRate(root, true, "2026-11-19T23:30:00.000Z");
  await sample("2026-11-20", ["QQQ"], true);
  await sample("2026-11-23", FIRST_RATE_SYMBOLS, true);
  await sample("2026-11-25", []);
  await sample("2026-11-27", []);
  await prepareFirstRate(root, false, mondayAfterThanksgiving);
  const calls = await attempts();
  assert.deepEqual(calls.slice(1).map(args => [args[0], args.includes("--cached-only")]), [
    ["2026-11-20", true], ["2026-11-23", true], ["2026-11-27", false],
  ]);
  const first = await stored();
  for (const fund of first.symbols)
    assert.equal(fund.reviewedThrough, fund.symbol === "QQQ" ? "2026-11-20" : "2026-11-23");
  await prepareFirstRate(root, false, mondayAfterThanksgiving);
  const next = await stored();
  for (const fund of next.symbols) {
    assert.equal(fund.reviewedThrough, "2026-11-23");
    if (fund.symbol !== "QQQ") assert.deepEqual(fund, first.symbols.find((row: {symbol: string}) => row.symbol === fund.symbol));
  }
});

test("a damaged prior QQQ control stays held across live and cached preparation while other complete funds advance", async t => {
  const { root, privateDir, sample, stored } = await fixture(t);
  const morning = "2026-11-18T12:48:00.000Z";
  await sample("2026-11-13", FIRST_RATE_SYMBOLS);
  await prepareFirstRate(root, true, "2026-11-13T23:30:00.000Z");
  await sample("2026-11-16", FIRST_RATE_SYMBOLS, true);
  await sample("2026-11-17", FIRST_RATE_SYMBOLS, true);
  const path = join(root, ".consensus/private-market-history/firstrate-controls/QQQ-2026-11-03-2026-11-16-raw-open.json");
  const exact = await readFile(path);
  const changed = JSON.parse(exact.toString());
  changed.sha256 = "0".repeat(64);
  await writeFile(path, JSON.stringify(changed));
  const run = await prepareFirstRate(root, false, morning);
  assert.ok("heldForEarlierCapture" in run && "delayedFailures" in run);
  assert.deepEqual(run.heldForEarlierCapture, { QQQ: "2026-11-16" });
  assert.ok(run.delayedFailures?.some(row => row.symbol === "QQQ" && row.kind === "integrity"));
  const partial = await stored();
  for (const fund of partial.symbols) assert.equal(fund.reviewedThrough, fund.symbol === "QQQ" ? "2026-11-13" : "2026-11-17");
  const originalApproval = await readFile(join(privateDir, "approved.json"));
  const replay = await prepareFirstRate(root, true, morning);
  assert.equal(replay.status, "awaiting_earlier_verification");
  assert.deepEqual(await readFile(join(privateDir, "approved.json")), originalApproval);
  await writeFile(path, exact);
  await prepareFirstRate(root, true, morning);
  const repaired = await stored();
  for (const fund of repaired.symbols) {
    assert.equal(fund.reviewedThrough, "2026-11-17");
    if (fund.symbol !== "QQQ") assert.deepEqual(fund, partial.symbols.find((row: {symbol: string}) => row.symbol === fund.symbol));
  }
});

test("a current file cannot skip over a second retained original when controls were several sessions late", async t => {
  const { root, sample, stored } = await fixture(t);
  await sample("2026-11-12", FIRST_RATE_SYMBOLS);
  await prepareFirstRate(root, true, "2026-11-12T23:30:00.000Z");
  for (const session of ["2026-11-13", "2026-11-16", "2026-11-17"]) await sample(session, FIRST_RATE_SYMBOLS, true);
  const morning = "2026-11-18T12:48:00.000Z";
  const one = await prepareFirstRate(root, false, morning);
  assert.equal((await stored()).through, "2026-11-13");
  assert.ok("heldForEarlierCapture" in one);
  assert.deepEqual(one.heldForEarlierCapture, Object.fromEntries(FIRST_RATE_SYMBOLS.map(fund => [fund, "2026-11-16"])));
  await prepareFirstRate(root, true, morning);
  assert.equal((await stored()).through, "2026-11-17");
});

test("a dated QQQ price disagreement remains withheld while a later independently verified session settles", async t => {
  const { root, scripts, sample, stored } = await fixture(t);
  const older = "2026-11-16", latest = "2026-11-17";
  await sample("2026-11-13", FIRST_RATE_SYMBOLS);
  await prepareFirstRate(root, true, "2026-11-13T23:30:00.000Z");
  await sample(older, FIRST_RATE_SYMBOLS, true);
  await sample(latest, FIRST_RATE_SYMBOLS, true);
  const earlierPath = join(scripts, older + ".json"), latestPath = join(scripts, latest + ".json");
  const earlier = JSON.parse(await readFile(earlierPath, "utf8"));
  earlier.samples.find((row: {symbol: string}) => row.symbol === "QQQ").rows.at(-1).close += 2;
  await writeFile(earlierPath, JSON.stringify(earlier));
  const current = JSON.parse(await readFile(latestPath, "utf8"));
  const qqq = current.samples.find((row: {symbol: string}) => row.symbol === "QQQ");
  qqq.rows = qqq.rows.slice(-1);
  await writeFile(latestPath, JSON.stringify(current));
  await writeHourlyFixtures(root, "QQQ", [{...exchangeSession(latest)!, ...qqq.rows[0]}]);
  const result = await prepareFirstRate(root, false, "2026-11-18T12:48:00.000Z");
  assert.ok("delayedFailures" in result);
  assert.ok(result.delayedFailures?.some(row => row.symbol === "QQQ" && row.kind === "disagreement"));
  const receipt = (await stored()).symbols.find((row: {symbol: string}) => row.symbol === "QQQ");
  assert.equal(receipt.reviewedThrough, latest);
  assert.ok(receipt.rows.some((row: {session: string}) => row.session === latest));
  assert.ok(!receipt.rows.some((row: {session: string}) => row.session === older));
  assert.deepEqual(receipt.withheld, [{session: older, reason: "price"}]);
});
