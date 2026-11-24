import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EARNINGS_ID, earningsInput, replayEarningsSource, registerEarningsStudy } from "../lib/consensus/prospective-earnings.ts";
import { earningsSource } from "./fixtures/earnings-source.ts";
import { recordPreopenReceipt } from "../lib/consensus/preopen-receipt.ts";
import { digest } from "../lib/consensus/history.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { recordProspectiveFamilyFeatures, readProspectiveFamilyFeatures } from "../lib/consensus/prospective-family-features.ts";
import { prospectiveFamilyPairCounts } from "../lib/consensus/prospective-family-outcomes.ts";
import { SCORING_POLICY } from "../lib/consensus/evaluation.ts";
import type { Signal } from "../lib/consensus/types.ts";
import { earningsStudy } from "../lib/consensus/earnings-study.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { exchangeCalendarVersion, exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";
import { FIRST_RATE_SOURCE } from "../lib/consensus/firstrate.ts";
import { nativeStudyIntake, stageNativeStudyIntake } from "../lib/consensus/secondary-studies.ts";

test("an intraday design registers at the real clock and a later call cannot backdate it", async t => {
  const root = await mkdtemp(join(tmpdir(), "earnings-prospective-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T19:00:00.000Z") });
  const first = await registerEarningsStudy(root);
  assert.equal(first.registeredAt, "2026-11-24T19:00:00.000Z");
  t.mock.timers.setTime(Date.parse("2026-11-25T12:00:00.000Z"));
  assert.deepEqual(await registerEarningsStudy(root), first);
  const stored = JSON.parse(await readFile(join(root, ".consensus/private-prospective-earnings/v2/registration.json"), "utf8"));
  assert.equal(stored.registeredAt, "2026-11-24T19:00:00.000Z");
});

test("a prior or different-date issuer cannot erase a valid pinned event on replay; distinct release dates stay distinct", async t => {
  const root = await mkdtemp(join(tmpdir(), "earnings-independent-dates-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T19:00:00.000Z") });
  await registerEarningsStudy(root);
  const signals = [await earningsSource(root), await earningsSource(root, "NVDA", "2026-12-01")];
  t.mock.timers.setTime(Date.parse("2026-12-02T13:05:00.000Z"));
  const first = await published(root, "2026-12-02", signals);
  const sealed = await recordProspectiveFamilyFeatures(root, "2026-12-02", first.id, "earnings");
  assert.equal(sealed.available, 1);
  const a = await readProspectiveFamilyFeatures(root, undefined, "earnings");
  assert.equal(a.rows.length, 1); assert.equal(a.rows[0].proofs.length, 4);
  assert.match(a.rows[0].eventId, /^AMD:/);
  t.mock.timers.setTime(Date.parse("2026-12-03T13:05:00.000Z"));
  const second = await published(root, "2026-12-03", signals);
  assert.equal((await recordProspectiveFamilyFeatures(root, "2026-12-03", second.id, "earnings")).available, 1);
  const b = await readProspectiveFamilyFeatures(root, undefined, "earnings");
  assert.equal(b.rows.length, 2); assert.match(b.rows[1].eventId, /^NVDA:/);
  assert.notEqual(b.rows[0].eventId, b.rows[1].eventId);
});

test("old results with a newly filed confirmation cannot enroll, and a shortened target never rolls forward", async t => {
  const root = await mkdtemp(join(tmpdir(), "earnings-clock-exclusions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T19:00:00.000Z") });
  const reg = await registerEarningsStudy(root);
  const older = await earningsSource(root, "AMD", "2026-11-23");
  assert.deepEqual(await earningsInput(root, [older], "2026-11-25", "2026-11-25T13:00:00.000Z", reg.registeredAt), { reason: "release-predates-registration" });
  const another = await mkdtemp(join(tmpdir(), "earnings-short-target-"));
  t.after(() => rm(another, { recursive: true, force: true }));
  const short = await earningsSource(another, "AMD", "2026-11-24");
  assert.deepEqual(await earningsInput(another, [short], "2026-11-27", "2026-11-27T13:00:00.000Z", reg.registeredAt), { reason: "short-earnings-target" });
  assert.deepEqual(await earningsInput(another, [short], "2026-11-30", "2026-11-30T13:00:00.000Z", reg.registeredAt), { reason: "outside-earnings-release-target" });
});

test("changed original bytes or a future first capture cannot become a valid earnings feature", async t => {
  const root = await mkdtemp(join(tmpdir(), "earnings-source-rejections-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signal = await earningsSource(root);
  const original = await replayEarningsSource(root, signal, "2026-12-02T13:00:00.000Z");
  assert.equal(original.proofs.length, 4);
  await assert.rejects(replayEarningsSource(root, signal, "2026-11-30T13:00:00.000Z"), /clock|capture/);
  const path = join(root, ".consensus/private-issuer-revenue", signal.issuerGuidance!.results.accession + ".json");
  const native = JSON.parse(await readFile(path, "utf8")); native.original.text = native.original.text.replace("13,377", "13,378");
  await writeFile(path, JSON.stringify(native), { mode: 0o600 });
  await assert.rejects(replayEarningsSource(root, signal, "2026-12-02T13:00:00.000Z", original.proofs), /Changed pinned/);
  await assert.rejects(replayEarningsSource(root, signal, "2026-12-02T13:00:00.000Z"), /do not reproduce/);
});

test("an earlier-dated guidance exhibit first captured after the actual release cannot enroll", async t => {
  const root = await mkdtemp(join(tmpdir(), "earnings-late-guidance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signal = await earningsSource(root, "AMD", "2026-11-30", true);
  assert.deepEqual(await earningsInput(root, [signal], "2026-12-02", "2026-12-02T13:00:00.000Z", "2026-11-24T19:00:00.000Z"),
    { reason: "guidance-not-pinned-before-results" });
});

async function published(root: string, day: string, signals: Signal[]) {
  const issue = day + "T13:01:00.000Z", witness = day + "T13:02:00.000Z", id = issue.replace(/[:.]/g, "-");
  const snapshot = { schemaVersion: 1, origin: "prospective", id, issuedAt: issue, cutoff: issue, engineVersion: "consensus-rules-2.0.0", signals, catalysts: [], sourcesAttempted: 1, collectionErrors: [] };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  await mkdir(join(root, "public/consensus"), { recursive: true });
  await writeFile(join(root, "public/consensus", id + ".json"), bytes);
  const index = Buffer.from(JSON.stringify([{ id, issuedAt: issue, engineVersion: snapshot.engineVersion, sha256: digest(snapshot) }]));
  await writeFile(join(root, "public/consensus/index.json"), index);
  await writeFile(join(root, "public/consensus/outcomes.json"), "[]");
  await recordPreopenReceipt(root, day, id, bytes, index, witness);
  return snapshot;
}

test("two verified issuers on one date seal one QQQ feature, then reach only the protected first-settlement reader", async t => {
  const root = await mkdtemp(join(tmpdir(), "earnings-first-settlement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T19:00:00.000Z") });
  await registerEarningsStudy(root);
  await earningsStudy.register(root);
  const signals = await Promise.all([earningsSource(root), earningsSource(root, "NVDA")]);
  t.mock.timers.setTime(Date.parse("2026-12-02T13:05:00.000Z"));
  const snapshot = await published(root, "2026-12-02", signals);
  const sealed = await recordProspectiveFamilyFeatures(root, "2026-12-02", snapshot.id, "earnings");
  assert.equal(sealed.available, 1);
  assert.equal((await earningsStudy.enroll(root, "2026-12-02", snapshot.id)).enrolled, 1);
  const features = await readProspectiveFamilyFeatures(root, undefined, "earnings");
  assert.equal(features.rows.length, 1);
  assert.equal(features.rows[0].id, EARNINGS_ID);
  assert.ok(Math.abs(features.rows[0].candidate - 2.9) < 1e-10);
  assert.ok(Math.abs(features.rows[0].control - 1.0986122886681096) < 1e-12);
  assert.equal(features.rows[0].proofs.length, 8);
  let opened = 0;
  const identity = { snapshotId: snapshot.id, instrument: "QQQ", horizon: "daily", engineVersion: snapshot.engineVersion } as const;
  const selection = { policy: SCORING_POLICY, superseded: [] };
  const evidence = { clockSlots: ["2026-12-02T21:03:00.000Z"], readLabels: async (requests: { slot: number }[]) => {
    opened++;
    return new Map(requests.map(r => [r.slot, { status: "paired" as const, up: 1 as const }]));
  } };
  const report = await prospectiveFamilyPairCounts(features, [snapshot], [identity], selection, [], "2026-12-02T21:05:00.000Z", evidence, "earnings");
  assert.equal(report.paired, 1); assert.equal(opened, 1);
  assert.equal(report.training, "collection_only");
  const reserved = [{ instrument: "QQQ", horizon: "weekly", consumedThrough: "2026-12-07T21:00:00.000Z", testWindows: [{ issuedAt: "2026-11-30T13:00:00.000Z", labelKnownAt: "2026-12-07T21:00:00.000Z" }] }];
  const protectedResult = await prospectiveFamilyPairCounts(features, [snapshot], [identity], selection, reserved as never, "2026-12-02T21:05:00.000Z", evidence, "earnings");
  assert.equal(protectedResult.paired, 0); assert.equal(opened, 1);
  t.mock.timers.setTime(Date.parse("2026-12-02T21:05:00.000Z"));
  const tx = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", clock = exchangeSession("2026-12-02")!;
  await durableJSON(join(root, ".consensus/evaluation-transaction.json"), { schemaVersion: 1, id: tx, synthetic: true }, true);
  let signs = 0;
  const settlement = { snapshotId: snapshot.id, instrument: "QQQ" as const, horizon: "daily" as const,
    issuedAt: snapshot.issuedAt, entryAt: clock.openAt, exitAt: clock.closeAt, source: FIRST_RATE_SOURCE,
    adjustment: OUTCOME_PRICE_BASIS, calendarVersion: exchangeCalendarVersion("2026-12-02", "2026-12-02"),
    direction: () => { signs++; return 1 as const; } };
  await earningsStudy.stage(root, tx, [{ ...settlement, source: "manual" }], [snapshot], []);
  assert.equal(signs, 0);
  const history = JSON.parse(await readFile(join(root, "public/consensus/index.json"), "utf8"));
  const plan = nativeStudyIntake(0, history, []);
  const fresh = { ...settlement, engineVersion: snapshot.engineVersion, entry: 100, exit: 101,
    get returnPct() { signs++; return 1; }, predictedScore: null, predictedProbability: null, abstained: true, directionCorrect: null };
  await stageNativeStudyIntake(root, tx, plan, [fresh]);
  await stageNativeStudyIntake(root, tx, plan, [fresh]);
  assert.equal(signs, 1);
  const intake = JSON.parse(await readFile(join(root, ".consensus/private-prospective-earnings/v2/study/QQQ/admissions", snapshot.id + ".json"), "utf8"));
  assert.equal(intake.value.source, FIRST_RATE_SOURCE);
});

test("a real after-open recorder cannot create a session seal, and registration policy edits fail closed", async t => {
  const root = await mkdtemp(join(tmpdir(), "earnings-preopen-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T19:00:00.000Z") });
  await registerEarningsStudy(root); await earningsStudy.register(root);
  await assert.rejects(recordProspectiveFamilyFeatures(root, "2026-11-24", "2026-11-24T13-04-12-171Z", "earnings"), /real same-day wall clock/);
  assert.equal((await earningsStudy.enroll(root, "2026-11-24", "2026-11-24T13-04-12-171Z")).status, "outside_preopen");
  const path = join(root, ".consensus/private-prospective-earnings/v2/registration.json");
  const changed = JSON.parse(await readFile(path, "utf8")); changed.policy.rules[0].expectedSign = -1;
  await writeFile(path, JSON.stringify(changed), { mode: 0o600 });
  await assert.rejects(registerEarningsStudy(root), /registration changed/);
});
