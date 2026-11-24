import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { durableJSON } from "../lib/publication-storage.ts";
import { ETF_CASH_SOURCES } from "../lib/consensus/corporate-adjustment.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { evaluateOutcome, outcomeTrainingRow, performance } from "../lib/consensus/evaluation.ts";
import { digest } from "../lib/consensus/history.ts";
import { kibotCashBoundary, kibotOneDayEvidence, kibotPrimaryPolicy, kibotPrimaryPriceCheck,
  kibotSelectedTarget, prepareKibotPrimary, readKibotPrimaryPrices, readKibotPrimarySession, registerKibotPrimary } from "../lib/consensus/kibot-eod-primary.ts";
import { kibotCandidateSummary, kibotCommitment, KIBOT_SUBSCRIBER_EOD_SOURCE, publicEvaluationMetrics, subscriberTestCount } from "../lib/consensus/kibot-eod-disclosure.ts";
import { loadEvaluationOutcomes } from "../lib/consensus/outcome-ledger.ts";
import { evaluateCandidate, planCandidate } from "../lib/consensus/learning.ts";
import { readReservations, reserveEvaluation, promotionEvidence } from "../lib/consensus/learning-audit.ts";
import { missingSignals, ENGINE_VERSION } from "../lib/consensus/registry.ts";
import type { Outcome, Snapshot } from "../lib/consensus/types.ts";
import { writeHourlyFixtures } from "./fixtures/firstrate-hourly-controls.ts";

const day = "2026-11-19", clock = exchangeSession(day)!;
const bar = { ...clock, open: 100, close: 101 };
const sha = (input: string) => createHash("sha256").update(input).digest("hex");
const emptyPolicy = { method: "kibot-subscriber-eod-v1-market-history-consolidated" as const,
  registeredAt: "2026-11-19T13:00:00.000Z", commitment: "a".repeat(64), changes: [],
  authorization: { source: "synthetic-clock-only", capturedAt: "", body: "", sha256: "" } };
const edition = (at: string): Snapshot => ({ schemaVersion: 1, id: at.replace(/[:.]/g, "-"),
  origin: "prospective", engineVersion: ENGINE_VERSION, issuedAt: at, cutoff: at,
  signals: missingSignals(at), catalysts: [], sourcesAttempted: 1, collectionErrors: [] });

test("the explicit source governs only eligible daily opens and preserves the full-day and individual cash controls", () => {
  assert.equal(kibotSelectedTarget(emptyPolicy, "2026-11-18T23:30:00.000Z", "daily"), day);
  assert.equal(kibotSelectedTarget(emptyPolicy, "2026-11-18T13:30:00.000Z", "daily"), null);
  assert.equal(kibotSelectedTarget({ ...emptyPolicy, registeredAt: clock.openAt }, "2026-11-19T13:00:00.000Z", "daily"), null);
  assert.equal(kibotSelectedTarget(emptyPolicy, "2026-11-26T21:00:00.000Z", "daily"), null);
  assert.equal(kibotSelectedTarget(emptyPolicy, "2026-11-18T23:30:00.000Z", "weekly"), null);
  assert.equal(kibotPrimaryPriceCheck(day, bar, bar, { ...bar, open: 100.04 }), false);
  assert.equal(kibotPrimaryPriceCheck(day, bar, { ...bar, close: 101.0001 }, bar), false);
  assert.equal(kibotPrimaryPriceCheck(day, { ...bar, close: 100.001 }, { ...bar, close: 100.001 }, { ...bar, close: 99.999 }), false);
  assert.equal(kibotCashBoundary(0.2, bar, bar, { ...bar, close: 101.11 }), false);
  assert.equal(kibotCashBoundary(0.2, bar, bar, { ...bar, close: 101.09 }), true);
  const snapshot = edition("2026-11-18T23:01:00.000Z"), evidence = kibotOneDayEvidence("TLT", bar);
  const after = "2026-12-31T23:00:00.000Z";
  assert.ok(evaluateOutcome(snapshot, evidence, "daily", after));
  assert.equal(evaluateOutcome(snapshot, evidence, "weekly", after), null);
  assert.equal(evaluateOutcome(snapshot, evidence, "monthly", after), null);
});

test("whole scheduled and evaluator entry points require paid delivery, independently recheck originals, and retain private labels", async t => {
  const root = await mkdtemp(join(tmpdir(), "tdc-kibot-primary-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(emptyPolicy.registeredAt) });
  for (const name of ["KIBOT_PRODUCTION_USER", "KIBOT_PRODUCTION_PASSWORD"]) {
    const old = process.env[name];
    delete process.env[name];
    t.after(() => { if (old !== undefined) process.env[name] = old; });
  }
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    assert.equal(url.host, "api.kibot.com");
    assert.equal(url.searchParams.get("user"), "synthetic-owner");
    requests.push(url.searchParams.get("action")!);
    if (url.searchParams.get("action") === "login")
      return new Response("200 OK\nAuthorizations\n=====================\nAll Stocks,1/1/1998,1\n");
    assert.equal(url.searchParams.get("symbol"), "SPY");
    return new Response("11/19/2026,100,102,99,101,2500\n");
  });
  assert.equal((await prepareKibotPrimary(root)).status, "not_selected");
  const credentials = join(root, ".consensus/private-kibot/production-credentials.json");
  await assert.rejects(registerKibotPrimary(root), /verified subscriber/);
  await durableJSON(credentials, { user: "guest", password: "guest" });
  await assert.rejects(registerKibotPrimary(root), /verified subscriber/);
  assert.equal(await kibotPrimaryPolicy(root), null);
  assert.equal(requests.length, 0);
  await durableJSON(credentials, { user: "synthetic-owner", password: "synthetic-only" });
  const policy = await registerKibotPrimary(root);
  assert.ok(policy);
  assert.deepEqual(policy, await registerKibotPrimary(root));
  await assert.rejects(registerKibotPrimary(root, "resume-default"), /clock has not advanced/);
  assert.deepEqual(await kibotPrimaryPolicy(root), policy);
  assert.deepEqual(requests, ["login"]);
  t.mock.timers.setTime(Date.parse(day + "T13:01:00.000Z"));
  await registerKibotPrimary(root, "resume-default");
  t.mock.timers.setTime(Date.parse(day + "T13:02:00.000Z"));
  await registerKibotPrimary(root);
  const changeFile = join(root, ".consensus/private-kibot/production-daily/changes/000002.json");
  const firstDecision = await readFile(changeFile);
  await rm(changeFile);
  await assert.rejects(kibotPrimaryPolicy(root), /anchored count/);
  assert.equal((await prepareKibotPrimary(root)).status, "awaiting_completed_ordinary_session");
  assert.deepEqual(await readFile(changeFile), firstDecision);
  assert.equal(kibotSelectedTarget(await kibotPrimaryPolicy(root), "2026-11-18T23:00:00.000Z", "daily"), day);
  t.mock.timers.setTime(Date.parse(day + "T23:10:00.000Z"));

  const scripts = join(root, "scripts"), pub = join(root, "public/consensus"), library = join(root, "lib/consensus");
  for (const path of [scripts, pub, library]) await mkdir(path, { recursive: true });
  // Share source modules; the fixture owns every mutable output and source document.
  const sourceLib = new URL("../lib/", import.meta.url);
  for (const [source, target] of [[sourceLib, join(root, "lib")], [new URL("consensus/", sourceLib), library]] as const)
    for (const file of (await readdir(source)).filter(name => name.endsWith(".ts")))
      await symlink(new URL(file, source), join(target, file));
  for (const file of ["issuer_corporate_actions.py", "evaluate-consensus.ts"])
    await copyFile(new URL("../scripts/" + file, import.meta.url), join(scripts, file));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await durableJSON(join(library, "models.json"), { schemaVersion: 1, models: [] });
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const issuerDir = join(root, ".consensus/private-kibot/sources", day, "issuer-post-close");
  for (const symbol of ["SPY", "QQQ", "IWM", "DIA", "TLT"] as const) {
    const path = join(issuerDir, symbol, "issuer-" + symbol);
    const original = symbol === "SPY" ? JSON.stringify([{ exDate: "09/18/2026", dividend: 1.888834,
      shortTeamCapital: "-", longTeamCapital: "-" }]) : "intentionally-invalid-test-payload";
    const url = ETF_CASH_SOURCES[symbol];
    await durableJSON(path + ".json", { url, responseUrl: url, sha256: sha(original), capturedAt: day + "T22:05:00.000Z" });
    await writeFile(path + ".bin", original, { mode: 0o600 });
  }
  await writeHourlyFixtures(root, "SPY", [bar]);
  const prepared = await prepareKibotPrimary(root);
  assert.deepEqual(prepared.accepted, [{ symbol: "SPY", day }]);
  assert.equal(prepared.withheld?.length, 4);
  assert.ok(prepared.withheld.every(row => row.reason === "issuer_original"));
  assert.deepEqual(requests, ["login", "login", "login", "history", "login", "history"]);
  const currentPolicy = await kibotPrimaryPolicy(root);
  const verified = await readKibotPrimaryPrices(root, currentPolicy, new Date().toISOString());
  assert.deepEqual(verified, [{ ...kibotOneDayEvidence("SPY", bar), approvedAt: new Date().toISOString() }]);
  const approvals = join(root, ".consensus/private-kibot/production-daily/approvals");
  const unrelated = join(approvals, "2026-11-20-QQQ.json");
  await writeFile(unrelated, "intentionally malformed unrequested approval", { mode: 0o600 });
  assert.deepEqual(await readKibotPrimarySession(root, "SPY", day, new Date().toISOString(), new Set([day])), verified[0]);
  assert.equal(await readKibotPrimarySession(root, "QQQ", "2026-11-20", new Date().toISOString(), new Set([day])), null);
  assert.equal(await readKibotPrimarySession(root, "SPY", day, new Date().toISOString(), new Set()), null);
  await rm(unrelated);
  const approvedPath = join(approvals, day + "-SPY.json");
  const original = JSON.parse(await readFile(approvedPath, "utf8"));
  const exDateFixture = { ...original.value, proof: { ...original.value.proof, controlDays: ["2026-11-18", day] } };
  await durableJSON(approvedPath, { value: exDateFixture, sha256: digest(exDateFixture) });
  assert.equal(await readKibotPrimarySession(root, "SPY", day, new Date().toISOString(), new Set([day])), null);
  await durableJSON(approvedPath, original);
  const snapshot = edition("2026-11-18T23:30:00.000Z");
  await durableJSON(join(pub, snapshot.id + ".json"), snapshot);
  await durableJSON(join(pub, "index.json"), [{ id: snapshot.id, issuedAt: snapshot.issuedAt,
    engineVersion: snapshot.engineVersion, sha256: digest(snapshot) }]);
  await durableJSON(join(pub, "outcomes.json"), []);
  // An individually supplied unlicensed control on the same day must never replace the chosen primary.
  const alternative = { ...verified[0], instrument: "QQQ", source: "https://example.com/synthetic-alternative" };
  const argsPath = join(root, "alternate.json");
  await durableJSON(argsPath, [alternative]);
  const offlineClock = "const D=Date;globalThis.Date=class extends D {constructor(...a){super(...(a.length?a:['2026-12-01T23:00:00.000Z']));}static now(){return D.parse('2026-12-01T23:00:00.000Z');}};globalThis.fetch=()=>{throw Error('unexpected network')}";
  const run = () => execFileSync(process.execPath, ["--experimental-strip-types", "--import", "data:text/javascript," + encodeURIComponent(offlineClock),
    "scripts/evaluate-consensus.ts", "--prices", argsPath],
    { cwd: root, encoding: "utf8", stdio: "pipe" });
  assert.equal(JSON.parse(run()).resolved, 1);
  const outcomes = await loadEvaluationOutcomes(root);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].source, KIBOT_SUBSCRIBER_EOD_SOURCE);
  assert.equal(outcomes[0].entry, bar.open);
  assert.equal(outcomeTrainingRow(outcomes[0], snapshot).up, 1);
  const summary = JSON.parse(await readFile(join(library, "performance.json"), "utf8"));
  const model = summary.learning.find((row: { instrument: string; horizon: string }) =>
    row.instrument === "SPY" && row.horizon === "daily");
  assert.equal(model.samples, 1);
  const publicCandidate = JSON.parse(await readFile(join(pub, model.artifact), "utf8"));
  assert.equal(publicCandidate.scope, "kibot-subscriber-aggregate");
  assert.equal(publicCandidate.datasetHash, undefined);
  const privateCandidate = join(root, ".consensus/private-kibot/production-daily/candidates", model.artifact.slice(7));
  assert.equal((await stat(privateCandidate)).mode & 0o777, 0o600);
  const privateResult = JSON.parse(await readFile(privateCandidate, "utf8"));
  assert.equal(privateResult.datasetHash, await kibotCommitment(root, privateResult.unblindedDatasetHash));
  const sourceClockRow = { ...outcomeTrainingRow(outcomes[0], snapshot), labelKnownAt: verified[0].approvedAt };
  assert.equal(privateResult.unblindedDatasetHash, sha(JSON.stringify([sourceClockRow])));
  assert.ok(sourceClockRow.labelKnownAt > outcomes[0].exitAt);
  const marker = await readFile(join(library, "evaluation-state.json"), "utf8");
  assert.ok(!marker.includes("private-kibot") && !marker.includes(privateResult.unblindedDatasetHash));
  assert.equal(JSON.parse(run()).resolved, 1);
  for (const source of [KIBOT_SUBSCRIBER_EOD_SOURCE, "https://www.kibot.com/api/history-request.html",
    "https://api.kibot.com/?action=history&interval=daily"]) {
    await durableJSON(argsPath, [{ ...alternative, source }]);
    assert.throws(run, /original local subscriber approval/);
  }
  await durableJSON(argsPath, [alternative]);
  const packet = join(root, ".consensus/private-kibot/production-daily/prices", "subscriber-SPY-2026-" + day + "-" + day + "-raw.json");
  const damaged = JSON.parse(await readFile(packet, "utf8"));
  damaged.paid.csv = damaged.paid.csv.replace("101", "100");
  await durableJSON(packet, damaged);
  assert.equal((await readKibotPrimaryPrices(root, currentPolicy, new Date().toISOString(), () => {})).length, 0);
  assert.equal(JSON.parse(run()).resolved, 1);
  const retained = JSON.parse(await readFile(join(library, "performance.json"), "utf8"));
  assert.equal(retained.learning.find((r: { instrument: string; horizon: string }) => r.instrument === "SPY" && r.horizon === "daily").status,
    "awaiting_native_replay");
  assert.deepEqual(await loadEvaluationOutcomes(root), outcomes);
  t.mock.timers.setTime(Date.parse("2026-11-20T13:00:00.000Z"));
  const retired = await registerKibotPrimary(root, "resume-default");
  assert.equal(kibotSelectedTarget(retired, snapshot.issuedAt, "daily"), day);
  assert.equal(kibotSelectedTarget(retired, "2026-11-20T13:00:00.000Z", "daily"), null);
  t.mock.timers.setTime(Date.parse("2026-11-20T22:00:00.000Z"));
  const resumed = await registerKibotPrimary(root);
  assert.equal(kibotSelectedTarget(resumed, "2026-11-20T13:00:00.000Z", "daily"), null);
  assert.equal(kibotSelectedTarget(resumed, "2026-11-20T21:00:00.000Z", "daily"), "2026-11-23");
  const commitment = join(root, ".consensus/private-kibot/production-daily/dataset-commitment.json");
  await durableJSON(commitment, "f".repeat(64));
  await assert.rejects(kibotPrimaryPolicy(root), /source choice/);
  const sessions = exchangeSessions("2026-11-18", "2026-11-25");
  await durableJSON(argsPath, [{ ...alternative, expectedSessions: sessions, sessions: sessions.map(d => ({ ...exchangeSession(d)!, open: 100, close: 101 })) }]);
  assert.equal(JSON.parse(run()).resolved, 2);
  const isolated = await loadEvaluationOutcomes(root);
  assert.deepEqual(isolated.map(row => [row.instrument, row.horizon]), [["SPY", "daily"], ["QQQ", "weekly"]]);
  await rm(join(root, ".consensus/private-kibot/production-daily/policy.json"));
  await assert.rejects(kibotPrimaryPolicy(root), /Missing primary choice/);
  assert.equal(JSON.parse(run()).resolved, 2);
});

test("private prospective fitting retains the full test, and public summaries expose only batch error and gate results", async t => {
  const rows = Array.from({ length: 500 }, (_, i) => {
    const start = Date.UTC(2024, 0, 1 + i);
    return { id: "fixture-" + i, engineVersion: ENGINE_VERSION, issuedAt: new Date(start).toISOString(),
      labelKnownAt: new Date(start + 6 * 3_600_000).toISOString(), features: [i % 2, 1], up: i % 2 as 0 | 1 };
  });
  const plan = planCandidate(rows, "2026-11-24T00:00:00.000Z", { engineVersion: ENGINE_VERSION,
    minimumSamples: 500, minimumTestSamples: 100, nonOverlappingTest: true });
  assert.ok(plan.status === "ready");
  const root = await mkdtemp(join(tmpdir(), "tdc-paid-candidate-frozen-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reservation = await reserveEvaluation(root, [], plan, "SPY", "daily", "2026-11-24T00:00:00.000Z");
  const result = evaluateCandidate(plan);
  const gate = promotionEvidence(plan, result.model, reservation);
  assert.equal(gate.passes, true);
  assert.equal((await readReservations(root)).length, 1);
  const repeated = planCandidate(rows, "2026-11-24T01:00:00.000Z", { engineVersion: ENGINE_VERSION,
    minimumSamples: 500, minimumTestSamples: 100, nonOverlappingTest: true, consumedThrough: reservation.consumedThrough });
  assert.equal(repeated.status, "insufficient_data");
  const paid = new Set(plan.split.test.map(row => row.id));
  const shared = kibotCandidateSummary(result, gate.passes, reservation.attempt, subscriberTestCount(plan, paid));
  assert.deepEqual(Object.keys(shared).sort(), ["activated", "attempt", "baseRateBrier", "candidateBrier", "coinBrier",
    "incumbentBrier", "licensedTest", "minimum", "passedStatisticalGates", "samples", "scope", "source", "status", "test", "train", "validation"].sort());
  assert.ok("candidateBrier" in shared);
  assert.equal(shared.test, 100);
  assert.equal(shared.candidateBrier, Number(result.candidateBrier.toFixed(4)));
  assert.throws(() => kibotCandidateSummary({ ...result, split: { ...result.split, test: 1 } }, true, 1, 1), /reserved/);
  const onePrivate = new Set([plan.split.test[0].id, plan.split.train[0].id]);
  const mixed = kibotCandidateSummary(result, true, reservation.attempt, subscriberTestCount(plan, onePrivate));
  assert.ok("licensedTest" in mixed && mixed.licensedTest === 1);
  assert.ok(!("candidateBrier" in mixed) && !("incumbentBrier" in mixed) && !("baseRateBrier" in mixed));
  assert.ok(!("passedStatisticalGates" in mixed));
  const target = evaluateOutcome(edition("2026-11-18T23:00:00.000Z"), kibotOneDayEvidence("SPY", bar), "daily", "2026-11-20T00:00:00.000Z")!;
  const full: Outcome = { ...target, predictedScore: 0.8, predictedProbability: 0.9, abstained: false, directionCorrect: true };
  const redacted = publicEvaluationMetrics([full], ENGINE_VERSION);
  assert.equal(redacted.calls, 1);
  for (const key of ["accuracy", "brier", "meanSignedReturnPct", "meanBuyHoldReturnPct"] as const) assert.equal(redacted[key], null);
  const permitted = [{ ...full, source: "https://example.com/unrestricted-fixture" }];
  assert.deepEqual(publicEvaluationMetrics(permitted, ENGINE_VERSION), performance(permitted, 2, ENGINE_VERSION));
});
