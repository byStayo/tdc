import assert from "node:assert/strict";
import test from "node:test";
import { auditOutcomeCoverage as coverageAt, dailySessionOutcomes as sessionAt, recentDailySettlements } from "../lib/consensus/outcome-coverage-audit.ts";
import { SESSION_HORIZONS } from "../lib/consensus/evaluation.ts";
import { planCandidate } from "../lib/consensus/learning.ts";
import { MINIMUM_TEST_LABELS, PROSPECTIVE_MINIMUM } from "../lib/consensus/learning-audit.ts";
import { missingSignals } from "../lib/consensus/registry.ts";
import { HORIZONS, INSTRUMENTS, type Outcome, type Snapshot } from "../lib/consensus/types.ts";

const funds = INSTRUMENTS.filter(instrument => instrument !== "MARKET");
const engine = "consensus-rules-2.0.0";
const afterClose = "2026-11-19T22:00:00.000Z";
const auditOutcomeCoverage = (s: Snapshot[], o: Parameters<typeof coverageAt>[1], p: Parameters<typeof coverageAt>[2], e: string, t: string) =>
  coverageAt(s, o, p, e, { asOf: t, ledgerObservedAt: t });
const dailySessionOutcomes = (s: Snapshot[], o: Outcome[], day: string, e: string, t: string) =>
  sessionAt(s, o, day, e, { asOf: t, ledgerObservedAt: t });
function edition(issuedAt: string): Snapshot {
  return { schemaVersion: 1, id: issuedAt.replace(/[:.]/g, "-"), issuedAt, cutoff: issuedAt,
    engineVersion: engine, origin: "prospective", signals: [], catalysts: [], sourcesAttempted: 0, collectionErrors: [] };
}
const evening = edition("2026-11-19T03:34:00.000Z");
const targets = (snapshot: Snapshot) => HORIZONS.flatMap(horizon =>
  funds.map(instrument => ({ snapshotId: snapshot.id, instrument, horizon })));

test("public settlement status excludes superseded forecasts, other horizons and sessions still open", () => {
  const morning = edition("2026-11-19T13:00:00.000Z");
  const atBell = edition("2026-11-19T14:30:00.000Z");
  const history = [atBell, evening, morning].map(({ id, issuedAt, engineVersion }) => ({ id, issuedAt, engineVersion, sha256: "test" }));
  const daily = { snapshotId: morning.id, engineVersion: engine, horizon: "daily" as const, instrument: "TLT" as const };
  const identities = [daily, { ...daily, snapshotId: evening.id, instrument: "SPY" as const },
    { ...daily, horizon: "weekly" as const, instrument: "QQQ" as const },
    { ...daily, engineVersion: "other", instrument: "IWM" as const }];
  assert.deepEqual(recentDailySettlements(history, identities, atBell.issuedAt), []);
  assert.deepEqual(recentDailySettlements(history, identities, afterClose), [
    { session: "2026-11-19", edition: morning.id, settled: ["TLT"] },
  ]);
  assert.equal(recentDailySettlements(history, [], afterClose)[0].settled.length, 0);
});

test("the session report shows only that session's last pre-open edition and distinguishes settlement from a call", () => {
  const morning = edition("2026-11-19T13:00:00.000Z");
  const atBell = edition("2026-11-19T14:30:00.000Z");
  const editions = [atBell, evening, morning];
  const session = "2026-11-19";
  const closed = "2026-11-19T21:00:00.000Z";
  const rows: Outcome[] = funds.map(instrument => ({ snapshotId: morning.id, instrument, horizon: "daily",
    issuedAt: morning.issuedAt, engineVersion: engine, entryAt: atBell.issuedAt, exitAt: closed,
    entry: 100, exit: 101, returnPct: 1, predictedScore: null, predictedProbability: null, abstained: true,
    directionCorrect: null, source: "https://example.test", adjustment: "total-return-adjusted" }));
  const priorRows = rows.map(row => ({ ...row, snapshotId: evening.id, issuedAt: evening.issuedAt }));
  assert.equal(dailySessionOutcomes(editions, [], session, engine, evening.issuedAt).edition, evening.id);
  assert.equal(dailySessionOutcomes(editions, [], session, engine, atBell.issuedAt).stage, "awaiting_close");
  assert.equal(dailySessionOutcomes(editions, [], session, engine, evening.issuedAt).stage, "awaiting_open");
  assert.equal(dailySessionOutcomes(editions, [], session, engine, evening.issuedAt).funds[0].asIssuedCall, "withheld");
  const partial = dailySessionOutcomes(editions, [...priorRows, ...rows.slice(0, 4)], session, engine, afterClose);
  assert.equal(partial.edition, morning.id);
  assert.equal(partial.eligibleOutcomes, 4);
  assert.equal(partial.funds[4].actualDirection, null);
  assert.equal(partial.funds[4].status, "awaiting_approved_prices");
  const full = dailySessionOutcomes(editions, rows, session, engine, afterClose);
  assert.equal(full.eligibleOutcomes, 5);
  assert.equal(full.stage, "settled");
  assert.equal(full.funds[4].actualDirection, "up");
  assert.equal(full.funds[4].asIssuedCall, "withheld");
  assert.equal(full.funds[4].directionCorrect, null);
  assert.ok(!Object.hasOwn(full.funds[4], "entry") && !Object.hasOwn(full.funds[4], "exit"));
  assert.throws(() => dailySessionOutcomes(editions, rows, session, engine, morning.issuedAt), /unsettled/);
  assert.throws(() => dailySessionOutcomes(editions, [rows[0], rows[0]], session, engine, closed), /Duplicate/);
  assert.throws(() => dailySessionOutcomes(editions, [{ ...rows[0], exitAt: atBell.issuedAt }], session, engine, closed), /session clock/);
  assert.throws(() => dailySessionOutcomes(editions, [{ ...rows[0], predictedScore: -0.5, abstained: false }],
    session, engine, closed), /issued call/);
  const differentEngine = dailySessionOutcomes(editions, rows, session, "other-engine", afterClose);
  assert.equal(differentEngine.eligibleOutcomes, 0);
  assert.equal(differentEngine.funds[0].inputEligible, false);
  assert.equal(dailySessionOutcomes([], [], session, engine, afterClose).stage, "no_edition");
  assert.throws(() => dailySessionOutcomes([], [], "2026-11-26", engine, afterClose), /exchange session/);
});

test("the as-of audit counts the visible editions and still rejects an unknown target", () => {
  const later = edition("2026-11-19T13:00:00.000Z");
  const allPending = [...targets(evening), ...targets(later)];
  const asOf = "2026-11-19T11:00:00.000Z";
  const audit = auditOutcomeCoverage([evening, later], [], allPending, engine, asOf);
  assert.equal(audit.expectedTargets, 15);
  assert.equal(audit.pendingByStatus.awaitingHorizon, 15);
  assert.equal(audit.eligibleFiveEtfDaily.firstOutstanding?.edition, evening.id);
  assert.throws(() => auditOutcomeCoverage([evening, later], [],
    [...allPending, { ...targets(evening)[0], snapshotId: "unissued" }], engine, asOf), /never issued/);
  assert.throws(() => auditOutcomeCoverage([evening], [{ ...targets(evening)[0], snapshotId: "unissued" }], [],
    engine, asOf), /never issued/);
});

test("a historical as-of needs dated ledger evidence and a completed exchange-calendar window", () => {
  const later = { asOf: "2026-11-19T20:00:00.000Z", ledgerObservedAt: afterClose };
  assert.throws(() => sessionAt([evening], [], "2026-11-19", engine, later), /ledger.*as-of/i);
  assert.throws(() => coverageAt([evening], [], targets(evening), engine, later), /ledger.*as-of/i);
  const beyondCalendar = edition("2027-11-24T22:00:00.000Z");
  assert.throws(() => auditOutcomeCoverage([beyondCalendar], targets(beyondCalendar), [], engine,
    "2027-11-24T22:01:00.000Z"), /reviewed exit/);
});

test("a missing matured target is visible even if the evaluator forgets to list it", () => {
  const all = targets(evening);
  const daily = all.filter(row => row.horizon === "daily");
  const later = all.filter(row => row.horizon !== "daily");
  const four = daily.filter(row => row.instrument !== "TLT");
  const audit = auditOutcomeCoverage([evening], four, later, engine, afterClose);
  assert.equal(audit.expectedTargets, 15);
  assert.equal(audit.unaccountedTargets, 1);
  assert.deepEqual(audit.unaccountedExamples, [evening.id + ":TLT:daily"]);
  assert.deepEqual(audit.pendingByStatus, { priceEvidenceDue: 1, awaitingHorizon: 10, calendarCoverageMissing: 0 });
  assert.equal(audit.priceDueByInstrument.TLT.daily, 1);
  assert.equal(audit.eligibleFiveEtfDaily.completedSessions, 0);
  assert.deepEqual(audit.eligibleFiveEtfDaily.firstOutstanding?.outstanding, ["TLT"]);
  const complete = auditOutcomeCoverage([evening], daily, later, engine, afterClose);
  assert.equal(complete.unaccountedTargets, 0);
  assert.equal(complete.eligibleFiveEtfDaily.firstCompleted?.session, "2026-11-19");
  assert.deepEqual(complete.eligibleFiveEtfDaily.firstCompleted?.resolved, funds);
});

test("a superseded edition cannot establish the five-fund milestone", () => {
  const morning = edition("2026-11-19T13:00:00.000Z");
  const restricted = missingSignals(morning.issuedAt)[0];
  morning.signals = [{ ...restricted, instruments: ["TLT"], status: "available",
    scores: { daily: 0.5, weekly: null, monthly: null }, source: { ...restricted.source,
      url: "https://fred.stlouisfed.org/series/DGS10", observedAt: "2026-11-18T21:00:00.000Z" } }];
  const all = targets(evening);
  const resolved = all.filter(row => row.horizon === "daily");
  const pending = [...all.filter(row => row.horizon !== "daily"), ...targets(morning)];
  const audit = auditOutcomeCoverage([morning, evening], resolved, pending, engine, afterClose);
  assert.deepEqual(audit.eligibleFiveEtfDaily, { completedSessions: 0, firstCompleted: null, firstOutstanding: null });
  const beforeOpen = auditOutcomeCoverage([evening], [], all, engine, morning.issuedAt);
  assert.equal(beforeOpen.eligibleFiveEtfDaily.firstOutstanding?.entryOpenReached, false);
  assert.equal(beforeOpen.pendingByStatus.priceEvidenceDue, 0);
});

test("overlaps, duplicate identities, non-issued targets and pre-close resolutions fail the audit", () => {
  const all = targets(evening);
  assert.throws(() => auditOutcomeCoverage([evening], [all[0]], all, engine, afterClose), /also reported pending/);
  assert.throws(() => auditOutcomeCoverage([evening], [], [...all, all[0]], engine, afterClose), /Duplicate pending/);
  assert.throws(() => auditOutcomeCoverage([evening], [], [{ ...all[0], instrument: "UNKNOWN" }], engine, afterClose), /never issued/);
  assert.throws(() => auditOutcomeCoverage([evening], [all[0]], [], engine, evening.issuedAt), /before its scheduled close/);
});

test("first-test sample floors follow the released planner for one eligible issue per trading session", () => {
  // One index step stands for one trading session. No model fit, prices or live reservations are involved.
  const instant = (session: number, hour: number) => new Date(Date.UTC(1970, 0, 1 + session, hour)).toISOString();
  for (const [horizon, span] of Object.entries(SESSION_HORIZONS)) {
    const testLength = 1 + (MINIMUM_TEST_LABELS - 1) * span;
    const minimum = Math.max(PROSPECTIVE_MINIMUM, (testLength - 1) * 5 + 1);
    for (const count of [minimum - 1, minimum]) {
      const rows = Array.from({ length: count }, (_, i) => ({ id: String(i), engineVersion: engine,
        issuedAt: instant(i, 8), labelKnownAt: instant(i + span - 1, 16), features: [0], up: (i % 2) as 0 | 1 }));
      const plan = planCandidate(rows, instant(count + span, 8), { minimumSamples: PROSPECTIVE_MINIMUM,
        minimumTestSamples: MINIMUM_TEST_LABELS, nonOverlappingTest: true });
      assert.equal(plan.status === "ready", count === minimum, `${horizon} with ${count} completed rows`);
      if (plan.status === "ready") assert.equal(plan.split.test.length, MINIMUM_TEST_LABELS);
    }
  }
});
