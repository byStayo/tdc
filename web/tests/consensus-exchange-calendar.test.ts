import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { availableExchangeSessions, EXCHANGE_CALENDAR, exchangeCalendarVersion, exchangeSession, exchangeSessions, hasReviewedCalendar, hasReviewedCalendarRange, trailingExchangeSessions, verifyExpectedSessions } from "../lib/consensus/exchange-calendar.ts";
import { evaluateOutcome, outcomeWindowSessions, type PriceEvidence } from "../lib/consensus/evaluation.ts";
import { performance } from "../lib/consensus/evaluation.ts";
import { freezeConsensus } from "../lib/consensus/as-issued.ts";
import { latestFirstRateSession } from "../lib/consensus/firstrate.ts";
import { scheduledPreopenSession } from "../lib/consensus/preopen-receipt.ts";
import { ordinaryDailyTarget } from "../lib/consensus/kibot-eod-primary.ts";
import { FAMILIES } from "../lib/consensus/registry.ts";
import type { Snapshot } from "../lib/consensus/types.ts";
const snapshot: Snapshot = JSON.parse(await readFile(new URL("../public/consensus/2026-11-03T08-48-02-469Z.json", import.meta.url), "utf8"));

test("outcome readiness distinguishes a future exit from an uncovered horizon", () => {
  const sessions = exchangeSessions("2026-11-25", "2026-12-31");
  const issued = "2026-11-27T14:30:00.000Z";
  assert.deepEqual(outcomeWindowSessions(issued, "daily", sessions), ["2026-11-30"]);
  assert.deepEqual(outcomeWindowSessions("2026-11-27T14:29:59.999Z", "daily", sessions), ["2026-11-27"]);
  assert.equal(outcomeWindowSessions(issued, "weekly", sessions).at(-1), "2026-12-04");
  assert.deepEqual(outcomeWindowSessions("2026-12-31T14:30:00.000Z", "weekly", sessions), []);
});

test("official 2026 equity closures, early closes and Eastern DST are independent of prices", () => {
  for (const day of ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25", "2026-11-07"])
    assert.equal(exchangeSession(day), null);
  assert.equal(exchangeSession("2026-11-27")!.closeAt, "2026-11-27T18:00:00.000Z");
  assert.equal(exchangeSession("2026-12-24")!.closeAt, "2026-12-24T18:00:00.000Z");
  assert.equal(exchangeSession("2026-07-02")!.closeAt, "2026-07-02T20:00:00.000Z");
  assert.equal(exchangeSession("2026-10-30")!.openAt, "2026-10-30T13:30:00.000Z");
  assert.equal(exchangeSession("2026-11-02")!.openAt, "2026-11-02T14:30:00.000Z");
  const privateCopy = exchangeSession("2026-11-02")!;
  privateCopy.closeAt = "changed by a caller";
  assert.equal(exchangeSession("2026-11-02")!.closeAt, "2026-11-02T21:00:00.000Z");
  assert.throws(() => exchangeSession("2026-02-30"), /invalid/);
});

test("2027 coverage uses official full closures and stops at the first unresolved special close", () => {
  for (const day of ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
    "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25"]) {
    assert.equal(exchangeSession(day), null);
  }
  assert.equal(exchangeSession("2027-03-12")!.openAt, "2027-03-12T14:30:00.000Z");
  assert.equal(exchangeSession("2027-03-15")!.openAt, "2027-03-15T13:30:00.000Z");
  assert.equal(exchangeSession("2027-07-02")!.closeAt, "2027-07-02T20:00:00.000Z");
  assert.throws(() => exchangeSession("2027-11-26"), /reviewed coverage/);
});

test("the calendar inventory preserves both original identifiers and leaves four unconfirmed days without clocks", () => {
  assert.equal(exchangeCalendarVersion("2026-12-31", "2027-01-04"),
    "us-equities-core-2026-reviewed-2026-11-03-v1+us-equities-core-2027-through-thanksgiving-reviewed-2026-11-18-v1");
  for (const gap of ["2027-11-26", "2027-12-31", "2028-07-03", "2028-11-24"]) {
    assert.equal(hasReviewedCalendar(gap), false);
    assert.throws(() => exchangeSession(gap), /no reviewed coverage/);
  }
  for (const holiday of ["2027-12-24", "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29",
    "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25"])
    assert.equal(exchangeSession(holiday), null);
  assert.equal(exchangeSession("2028-03-10")!.openAt, "2028-03-10T14:30:00.000Z");
  assert.equal(exchangeSession("2028-03-13")!.closeAt, "2028-03-13T20:00:00.000Z");
  assert.equal(exchangeSession("2028-11-06")!.closeAt, "2028-11-06T21:00:00.000Z");
  assert.throws(() => exchangeSession("2029-01-01"), /no reviewed coverage/);
});

test("each new interval restarts its prior-session lookback and cannot settle through a gap", () => {
  const boundaries = [
    ["2027-11-24", "2027-11-29", "2027-11-30"],
    ["2027-12-30", "2028-01-03", "2028-01-04"],
    ["2028-06-30", "2028-07-05", "2028-07-06"],
    ["2028-11-22", "2028-11-27", "2028-11-28"],
  ];
  for (const [last, first, second] of boundaries) {
    assert.equal(hasReviewedCalendarRange(last, first), false);
    assert.throws(() => exchangeCalendarVersion(last, first), /no reviewed coverage/);
    assert.throws(() => exchangeSessions(last, first), /no reviewed coverage/);
    assert.deepEqual(trailingExchangeSessions(last, first), [first]);
    assert.deepEqual(trailingExchangeSessions(last, second), [first, second]);
    const dates = availableExchangeSessions(last, second);
    assert.deepEqual(dates, [last, first, second]);
    assert.throws(() => verifyExpectedSessions(dates), /contiguous reviewed coverage/);
    assert.deepEqual(verifyExpectedSessions(dates, { separateIntervals: true }), dates);
    assert.throws(() => verifyExpectedSessions([last, second], { separateIntervals: true }), /independent reviewed schedule/);
    assert.deepEqual(outcomeWindowSessions(exchangeSession(last)!.closeAt, "daily", dates), []);
    assert.deepEqual(outcomeWindowSessions(exchangeSession(first)!.closeAt, "daily", dates), [second]);
    assert.throws(() => latestFirstRateSession(exchangeSession(first)!.openAt), /no reviewed coverage/);
    const source = latestFirstRateSession(exchangeSession(second)!.openAt);
    assert.equal(source, first);
    // A second prior NAV for the control also needs a verified intervening session.
    assert.throws(() => latestFirstRateSession(exchangeSession(source)!.openAt), /no reviewed coverage/);
    assert.equal(scheduledPreopenSession(exchangeSession(last)!.closeAt, first + "T12:00:00.000Z"), null);
    assert.equal(scheduledPreopenSession(first + "T11:30:00.000Z", first + "T12:00:00.000Z"), first);
    assert.equal(ordinaryDailyTarget(exchangeSession(last)!.closeAt, "daily"), null);
    assert.equal(ordinaryDailyTarget(last + "T12:00:00.000Z", "daily"), last);
  }
  assert.throws(() => verifyExpectedSessions(["2027-11-24", "2027-11-26"]), /contiguous reviewed coverage/);
});

test("a price ledger with multiple independent intervals settles a new daily outcome and withholds long horizons spanning a gap", () => {
  const dates = availableExchangeSessions("2027-11-01", "2027-12-30");
  const values: PriceEvidence = { instrument: "SPY", source: "https://example.com/fixture", adjustment: "total-return-adjusted",
    expectedSessions: dates, sessions: dates.map(day => ({ ...exchangeSession(day)!, open: 100, close: 101 })) };
  const issued = (day: string) => ({ ...snapshot, issuedAt: day+"T12:00:00.000Z", id: day+"T12-00-00-000Z" });
  assert.equal(evaluateOutcome(issued("2027-11-24"), values, "weekly", "2028-01-01T00:00:00.000Z"), null);
  assert.equal(evaluateOutcome(issued("2027-11-08"), values, "monthly", "2028-01-01T00:00:00.000Z"), null);
  const settled = evaluateOutcome(issued("2027-11-30"), values, "daily", "2028-01-01T00:00:00.000Z");
  assert.equal(settled?.entryAt, "2027-11-30T14:30:00.000Z");
  assert.equal(settled?.calendarVersion, "us-equities-core-2027-late-ordinary-reviewed-2026-11-24-v1");
});

test("the 500th potential ordinary-session pair is backed by two clocks within one independently reviewed interval", () => {
  const all = availableExchangeSessions("2026-11-20", "2028-12-31");
  const ordinary = (day: string) => {
    const clock = exchangeSession(day)!;
    return Date.parse(clock.closeAt) - Date.parse(clock.openAt) === 390 * 60_000;
  };
  const targets = all.filter((day, i) => day >= "2026-11-24" && hasReviewedCalendarRange(all[i - 1], day) && ordinary(day) && ordinary(all[i - 1]));
  assert.equal(targets.filter(day => day <= "2027-11-25").length, 248);
  assert.equal(targets.length, 516);
  assert.equal(targets[299], "2028-02-15");
  assert.equal(targets[499], "2028-12-06");
  const twoPriors = all.filter((day, i) => day >= "2026-11-24" && hasReviewedCalendarRange(all[i - 2], day) &&
    all.slice(i - 2, i + 1).every(ordinary));
  assert.equal(twoPriors.length, 510);
  assert.equal(twoPriors[499], "2028-12-14");
});

test("a cross-year outcome keeps both reviewed calendar identifiers", () => {
  const dates = exchangeSessions("2026-12-01", "2027-01-07");
  const row: Snapshot = { ...snapshot, id: "2026-12-03T12-00-00-000Z", issuedAt: "2026-12-03T12:00:00.000Z" };
  const evidence: PriceEvidence = { instrument: "QQQ", source: "https://example.com/fixture",
    adjustment: "total-return-adjusted", expectedSessions: dates,
    sessions: dates.map(day => ({ ...exchangeSession(day)!, open: 100, close: 101 })) };
  const monthly = evaluateOutcome(row, evidence, "monthly", "2027-01-05T12:00:00.000Z");
  assert.equal(monthly?.entryAt, "2026-12-03T14:30:00.000Z");
  assert.equal(monthly?.exitAt, "2027-01-04T21:00:00.000Z");
  assert.match(monthly!.calendarVersion!, /^us-equities-core-2026-.+\+us-equities-core-2027-/);
  assert.equal(evaluateOutcome(row, evidence, "monthly", "2027-01-04T20:59:59.999Z"), null);
  assert.equal(evaluateOutcome(row, { ...evidence, sessions: evidence.sessions.filter(bar => bar.session !== "2027-01-04") },
    "monthly", "2027-01-05T12:00:00.000Z"), null);
});

test("out-of-coverage horizons remain pending without blocking covered rows in the same evidence", () => {
  const dates = [...exchangeSessions("2027-11-01", "2027-11-25"), "2027-11-26"];
  const evidence: PriceEvidence = { instrument: "SPY", source: "https://example.com/fixture", adjustment: "total-return-adjusted", expectedSessions: dates,
    sessions: dates.map(day => ({ ...(day !== "2027-11-26" ? exchangeSession(day)! :
      { session: day, openAt: `${day}T14:30:00.000Z`, closeAt: `${day}T18:00:00.000Z` }), open: 100, close: 101 })) };
  const issued = (day: string): Snapshot => ({ ...snapshot, id:`${day}T12-00-00-000Z`, issuedAt:`${day}T12:00:00.000Z` });
  const now = "2027-11-29T22:00:00.000Z";
  assert.ok(evaluateOutcome(issued("2027-11-03"), evidence, "daily", now));
  assert.ok(evaluateOutcome(issued("2027-11-03"), evidence, "weekly", now));
  assert.equal(evaluateOutcome(issued("2027-11-03"), evidence, "monthly", now), null);
  assert.ok(evaluateOutcome(issued("2027-11-24"), evidence, "daily", now));
  assert.equal(evaluateOutcome(issued("2027-11-24"), evidence, "weekly", now), null);
  assert.equal(evaluateOutcome(issued("2027-11-26"), evidence, "daily", now), null);
  assert.throws(() => evaluateOutcome(issued("2027-11-03"), { ...evidence, expectedSessions: dates.filter(day => day !== "2027-11-10"), sessions:evidence.sessions.filter(row=>row.session!=="2027-11-10") }, "daily", now), /independent reviewed schedule/);
});

test("a price-derived calendar cannot omit sessions or insert exchange holidays", () => {
  const dates = exchangeSessions("2026-11-02", "2026-11-09");
  verifyExpectedSessions(dates);
  assert.throws(() => verifyExpectedSessions(dates.filter(day => day !== "2026-11-04")), /independent reviewed schedule/);
  assert.throws(() => verifyExpectedSessions(["2026-11-25", "2026-11-26", "2026-11-27"]), /independent reviewed schedule/);
  const evidence: PriceEvidence = { instrument: "SPY", source: "https://example.com/fixture", adjustment: "total-return-adjusted", expectedSessions: dates,
    sessions: dates.map((day, i) => ({ ...exchangeSession(day)!, open: 100, close: 100 + i })) };
  const result = evaluateOutcome(snapshot, evidence, "weekly", "2026-11-10T00:00:00.000Z")!;
  assert.equal(result.entryAt, "2026-11-03T14:30:00.000Z");
  assert.equal(result.exitAt, "2026-11-09T21:00:00.000Z");
  assert.equal(result.calendarVersion, EXCHANGE_CALENDAR.id);
  assert.equal(evaluateOutcome(snapshot, { ...evidence, sessions: evidence.sessions.filter(row => row.session !== "2026-11-04") }, "weekly", "2026-11-10T00:00:00.000Z"), null);
  assert.throws(() => evaluateOutcome(snapshot, { ...evidence, expectedSessions: dates.filter(day => day !== "2026-11-04"), sessions: evidence.sessions.filter(row => row.session !== "2026-11-04") }, "weekly", "2026-11-10T00:00:00.000Z"), /independent reviewed schedule/);
});

test("outcomes require the official early close, not a normal-day close supplied by a price file", () => {
  const early: Snapshot = { ...snapshot, id: "2026-11-27T12-00-00-000Z", issuedAt: "2026-11-27T12:00:00.000Z" };
  const evidence: PriceEvidence = { instrument: "TLT", source: "https://example.com/fixture", adjustment: "total-return-adjusted", expectedSessions: ["2026-11-25", "2026-11-27"],
    sessions: [{ ...exchangeSession("2026-11-27")!, open: 100, close: 101 }] };
  assert.equal(evaluateOutcome(early, evidence, "daily", "2026-11-27T17:59:00.000Z"), null);
  assert.equal(evaluateOutcome(early, evidence, "daily", "2026-11-27T18:01:00.000Z")!.exitAt, "2026-11-27T18:00:00.000Z");
  evidence.sessions[0].closeAt = "2026-11-27T21:00:00.000Z";
  assert.throws(() => evaluateOutcome(early, evidence, "daily", "2026-11-27T22:00:00.000Z"), /Invalid price session/);
});

test("forecast calibration is measured during rule abstention, while complete evidence can receive a model direction label",()=>{
  const dates=exchangeSessions("2026-11-02","2026-11-04");
  const evidence:PriceEvidence={instrument:"SPY",source:"https://example.com/fixture",adjustment:"total-return-adjusted",expectedSessions:dates,sessions:dates.map(day=>({...exchangeSession(day)!,open:100,close:101}))};
  const forecast={engineVersion:snapshot.engineVersion,instrument:"SPY" as const,horizon:"daily" as const,modelId:"synthetic-qualified-model",trainedAt:"2026-11-01T00:00:00.000Z",target:"next-session-open-to-horizon-close" as const,priceAdjustment:"total-return-adjusted" as const,probabilityUp:.8};
  const withheld=evaluateOutcome({...snapshot,forecasts:[forecast]},evidence,"daily","2026-11-05T00:00:00.000Z")!;
  assert.equal(withheld.abstained,true);assert.equal(withheld.directionCorrect,null);assert.ok(Math.abs(performance([withheld]).brier!-.04)<1e-12);
  const base=snapshot.signals.find(s=>s.status==="available")!;
  const complete=freezeConsensus({...snapshot,signals:FAMILIES.map(f=>({...base,id:`fixture-${f.id}`,family:f.id,instruments:["SPY"],directionalInstruments:["SPY"],scores:{daily:.5,weekly:.5,monthly:.5}})),consensus:undefined,forecasts:[forecast]});
  const called=evaluateOutcome(complete,evidence,"daily","2026-11-05T00:00:00.000Z")!;
  assert.equal(called.abstained,false);assert.equal(called.directionCorrect,true);assert.ok(Math.abs(called.predictedScore!-.6)<1e-12);
});
