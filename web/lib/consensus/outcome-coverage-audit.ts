import { asIssuedOutcomeCall, outcomeKey, outcomeWindowSessions } from "./evaluation.ts";
import { EXCHANGE_CALENDAR, REVIEWED_EXCHANGE_THROUGH, exchangeSession, availableExchangeSessions } from "./exchange-calendar.ts";
import { permitsModelInputs } from "./model.ts";
import { HORIZONS, INSTRUMENTS, type HistoryEntry, type Instrument, type Outcome, type Snapshot } from "./types.ts";

const funds = INSTRUMENTS.filter(symbol => symbol !== "MARKET");
type Target = Pick<Outcome, "snapshotId" | "instrument" | "horizon">;
type PendingTarget = { snapshotId: string; instrument: string; horizon: string };
type LedgerClock = { asOf: string; ledgerObservedAt: string };

function verifyLedgerClock({ asOf, ledgerObservedAt }: LedgerClock) {
  for (const stamp of [asOf, ledgerObservedAt]) {
    if (!Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString() !== stamp)
      throw new Error("Audit clocks must be canonical UTC timestamps");
  }
  if (ledgerObservedAt > asOf) throw new Error("The supplied ledger was observed after the requested as-of time");
}

function latestDailyEditions<T extends Pick<HistoryEntry, "issuedAt">>(snapshots: T[], sessions: string[]) {
  const editions = new Map<string, T>();
  for (const snapshot of snapshots) {
    const [session] = outcomeWindowSessions(snapshot.issuedAt, "daily", sessions);
    if (!session) continue;
    const previous = editions.get(session);
    if (!previous || previous.issuedAt < snapshot.issuedAt) editions.set(session, snapshot);
  }
  return editions;
}

export interface DailySettlementStatus {
  session: string;
  edition: string;
  settled: Exclude<Instrument, "MARKET">[];
}

/** The board uses only published identities for the winning pre-open edition. */
export function recentDailySettlements(history: HistoryEntry[], identities: Pick<Outcome, "snapshotId" | "instrument" | "horizon" | "engineVersion">[],
  evaluatedAt: string): DailySettlementStatus[] {
  verifyLedgerClock({ asOf: evaluatedAt, ledgerObservedAt: evaluatedAt });
  const calendar = availableExchangeSessions(EXCHANGE_CALENDAR.from, REVIEWED_EXCHANGE_THROUGH);
  const daily = new Set(identities.filter(row => row.horizon === "daily")
    .map(row => `${row.snapshotId}:${row.engineVersion}:${row.instrument}`));
  const selected = latestDailyEditions(history.filter(edition => edition.issuedAt <= evaluatedAt), calendar);
  return [...selected]
    .filter(([day]) => exchangeSession(day)!.closeAt <= evaluatedAt)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 3)
    .map(([session, edition]) => ({
      session, edition: edition.id,
      settled: funds.filter(symbol => daily.has(`${edition.id}:${edition.engineVersion}:${symbol}`)),
    }));
}

/** Owner-facing daily settlement. Read the verified ledger and omit individual prices from the report. */
export function dailySessionOutcomes(snapshots: Snapshot[], outcomes: Outcome[], session: string, engine: string, time: LedgerClock) {
  verifyLedgerClock(time);
  const { asOf, ledgerObservedAt } = time;
  const clock = exchangeSession(session);
  if (!clock) throw new Error("The requested date is not an exchange session");
  const sessions = availableExchangeSessions(EXCHANGE_CALENDAR.from, session);
  const issued = latestDailyEditions(snapshots.filter(snapshot => snapshot.issuedAt <= asOf), sessions).get(session);
  const phase = asOf < clock.openAt ? "awaiting_open" : asOf < clock.closeAt ? "awaiting_close" : "awaiting_approved_prices";
  const selected = outcomes.filter(row => row.snapshotId === issued?.id && row.horizon === "daily");
  const byFund = new Map(selected.map(row => [row.instrument, row]));
  if (byFund.size !== selected.length) throw new Error("Duplicate daily outcome for the selected edition");
  for (const row of selected) {
    if (asOf < clock.closeAt) throw new Error("Recorded outcome found for an unsettled session");
    if (row.entryAt !== clock.openAt || row.exitAt !== clock.closeAt || row.issuedAt !== issued!.issuedAt ||
        row.engineVersion !== issued!.engineVersion) throw new Error("Recorded outcome differs from the edition or session clock");
  }
  const results = funds.map(instrument => {
    const row = byFund.get(instrument);
    const inputEligible = !!issued && issued.engineVersion === engine && permitsModelInputs(issued, instrument, "daily");
    const actualDirection = !row ? null : row.returnPct > 0 ? "up" : row.returnPct < 0 ? "down" : "flat";
    const decision = issued ? asIssuedOutcomeCall(issued, instrument, "daily") : null;
    if (row && decision && (row.abstained !== !decision.called ||
        (decision.called && (!Number.isFinite(row.predictedScore) || row.predictedScore !== decision.score))))
      throw new Error("Recorded outcome differs from the issued call");
    return { instrument, inputEligible, status: row ? "resolved" : issued ? phase : "no_edition",
      actualDirection, returnPct: row?.returnPct ?? null, asIssuedCall: decision?.call ?? null, directionCorrect: row?.directionCorrect ?? null };
  });
  return { session, asOf, ledgerObservedAt, openAt: clock.openAt, closeAt: clock.closeAt, edition: issued?.id ?? null,
    stage: !issued ? "no_edition" : results.every(row => row.status === "resolved") ? "settled" : phase,
    eligibleOutcomes: results.filter(row => row.inputEligible && row.status === "resolved").length, funds: results };
}

/** Check every issued target even when the evaluator's pending list omits one. */
export function auditOutcomeCoverage(
  snapshots: Snapshot[], outcomes: Target[], pending: PendingTarget[] | undefined,
  currentEngine: string, time: LedgerClock,
) {
  verifyLedgerClock(time);
  const { asOf } = time;
  const sessions = availableExchangeSessions(EXCHANGE_CALENDAR.from, REVIEWED_EXCHANGE_THROUGH);
  const byId = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
  const visible = snapshots.filter(snapshot => snapshot.issuedAt <= asOf);
  function visibleTargets(rows: PendingTarget[], name: string) {
    const keys = new Set<string>();
    for (const row of rows) {
      const key = [row.snapshotId, row.instrument, row.horizon].join(":");
      const snapshot = byId.get(row.snapshotId);
      if (!snapshot || !funds.some(symbol => symbol === row.instrument) || !HORIZONS.some(horizon => horizon === row.horizon))
        throw new Error(`${name} target was never issued: ${key}`);
      if (snapshot.issuedAt > asOf) continue;
      if (keys.has(key)) throw new Error(`Duplicate ${name.toLowerCase()} outcome target`);
      keys.add(key);
    }
    return keys;
  }
  const resolved = visibleTargets(outcomes, "Resolved");
  const reported = visibleTargets(pending ?? [], "Pending");

  const pendingByStatus = { priceEvidenceDue: 0, awaitingHorizon: 0, calendarCoverageMissing: 0 };
  const priceDueByInstrument = Object.fromEntries(funds.map(symbol => [symbol, { daily: 0, weekly: 0, monthly: 0 }]));
  let unaccountedTargets = 0;
  const unaccountedExamples: string[] = [];
  for (const snapshot of visible) {
    for (const horizon of HORIZONS) {
      const dates = outcomeWindowSessions(snapshot.issuedAt, horizon, sessions);
      const last = dates.at(-1);
      const status = !last ? "calendarCoverageMissing" : exchangeSession(last)!.closeAt > asOf
        ? "awaitingHorizon" : "priceEvidenceDue";
      for (const instrument of funds) {
        const key = outcomeKey({ snapshotId: snapshot.id, instrument, horizon });
        const listedPending = reported.delete(key);
        if (resolved.has(key)) {
          if (listedPending) throw new Error(`Resolved target also reported pending: ${key}`);
          if (status === "awaitingHorizon") throw new Error(`Target resolved before its scheduled close: ${key}`);
          if (status === "calendarCoverageMissing") throw new Error(`Resolved target lacks a reviewed exit: ${key}`);
          continue;
        }
        if (!listedPending) {
          unaccountedTargets++;
          if (unaccountedExamples.length < 5) unaccountedExamples.push(key);
        }
        pendingByStatus[status]++;
        if (status === "priceEvidenceDue") priceDueByInstrument[instrument][horizon]++;
      }
    }
  }
  if (reported.size) throw new Error(`Pending target was never issued: ${reported.values().next().value}`);

  // Select the last edition before the entry open before inspecting either rights or outcomes.
  type DailySession = { session: string; edition: string; closeAt: string; entryOpenReached: boolean;
    resolved: string[]; outstanding: string[] };
  let firstCompleted: DailySession | null = null;
  let firstOutstanding: DailySession | null = null;
  let completedSessions = 0;
  for (const [session, snapshot] of [...latestDailyEditions(visible, sessions)].sort(([a], [b]) => a.localeCompare(b))) {
    if (snapshot.engineVersion !== currentEngine || !funds.every(symbol => permitsModelInputs(snapshot, symbol, "daily"))) continue;
    const checked = funds.filter(instrument => resolved.has(outcomeKey({ snapshotId: snapshot.id, instrument, horizon: "daily" })));
    const clock = exchangeSession(session)!;
    const candidate = { session, edition: snapshot.id, closeAt: clock.closeAt, entryOpenReached: asOf >= clock.openAt,
      resolved: checked, outstanding: funds.filter(symbol => !checked.includes(symbol)) };
    if (checked.length === funds.length) {
      completedSessions++;
      firstCompleted ??= candidate;
    } else {
      firstOutstanding ??= candidate;
    }
  }
  return { expectedTargets: visible.length * funds.length * HORIZONS.length,
    unaccountedTargets, unaccountedExamples,
    pendingByStatus, priceDueByInstrument, eligibleFiveEtfDaily: { completedSessions, firstCompleted, firstOutstanding } };
}
