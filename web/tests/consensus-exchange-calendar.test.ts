import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EXCHANGE_CALENDAR, exchangeSession, exchangeSessions, verifyExpectedSessions } from "../lib/consensus/exchange-calendar.ts";
import { evaluateOutcome, type PriceEvidence } from "../lib/consensus/evaluation.ts";
import type { Snapshot } from "../lib/consensus/types.ts";
const snapshot: Snapshot = JSON.parse(await readFile(new URL("../public/consensus/2026-11-03T08-48-02-469Z.json", import.meta.url), "utf8"));

test("official 2026 equity closures, early closes and Eastern DST are independent of prices", () => {
  for (const day of ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25", "2026-11-07"])
    assert.equal(exchangeSession(day), null);
  assert.equal(exchangeSession("2026-11-27")!.closeAt, "2026-11-27T18:00:00.000Z");
  assert.equal(exchangeSession("2026-12-24")!.closeAt, "2026-12-24T18:00:00.000Z");
  assert.equal(exchangeSession("2026-07-02")!.closeAt, "2026-07-02T20:00:00.000Z");
  assert.equal(exchangeSession("2026-10-30")!.openAt, "2026-10-30T13:30:00.000Z");
  assert.equal(exchangeSession("2026-11-02")!.openAt, "2026-11-02T14:30:00.000Z");
  assert.throws(() => exchangeSession("2027-01-04"), /reviewed coverage/);
  assert.throws(() => exchangeSession("2026-02-30"), /reviewed coverage/);
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
