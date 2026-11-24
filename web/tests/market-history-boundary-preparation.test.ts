import assert from "node:assert/strict";
import test from "node:test";
import type { PriceEvidence } from "../lib/consensus/evaluation.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { prepareTltBoundaryQualification } from "../lib/consensus/market-history-boundary-preparation.ts";
import { MARKET_HISTORY_SOURCE } from "../lib/consensus/market-history-settlement.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";

const friday = "2026-11-20", monday = "2026-11-23", originalStart = "2026-10-30";
const noRequest = async () => { throw Error("Unexpected authenticated qualification request"); };

function settlement(requestedThrough: string, first: string, last: string): PriceEvidence {
  return { instrument: "TLT", source: MARKET_HISTORY_SOURCE, adjustment: OUTCOME_PRICE_BASIS,
    expectedSessions: exchangeSessions(originalStart, requestedThrough),
    sessions: exchangeSessions(first, last).map(day => ({ ...exchangeSession(day)!, open: 10, close: 11 })) };
}
function options(delivered: string, runDay: string, proofs: PriceEvidence[]) {
  const last = exchangeSession(delivered)!.closeAt;
  const cutoff = runDay + "T22:40:00.000Z";
  const fetcher: typeof fetch = async (_input, init) => {
    assert.equal(init?.credentials, "omit");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return Response.json({ dataset: "stocks/us", ticker: "TLT", contract: { exchange: "NASDAQ", status: "active" },
      bars: { timeframes: [{ timeframe: "1m", feed: "consolidated", venue: "US consolidated tape", last, updated: last }] } });
  };
  return { cutoff, environmentKey: "fixture", fetcher, loadSettlements: async (_root: string, asOf: string) => {
    assert.equal(asOf, cutoff);
    return proofs;
  } };
}
function collector(calls: string[][]) {
  return async (from: string, through: string) => {
    calls.push([from, through]);
    return { scope: "private-source-qualification", from, through, completeHourlyGrids: 2, matched: 0,
      sessions: exchangeSessions(from, through).length, adjustedSessions: 0, settlementSessions: 0, receipt: "a".repeat(64) };
  };
}

test("a rotating preparation date reuses one fully revalidated settlement through a delayed catalogue close", async () => {
  const proof = settlement(monday, originalStart, friday);
  for (const runDay of [monday, "2026-11-24"]) {
    const result = await prepareTltBoundaryQualification(".", noRequest, options(friday, runDay, [proof]));
    assert.equal(result.status, "verified_private_settlement");
    assert.equal(result.reused, true);
    assert.equal(result.from, originalStart);
    assert.equal(result.through, friday);
    assert.equal(result.expected, runDay);
    assert.equal(result.settlementSessions, proof.sessions.length);
  }
});

test("the first newly delivered unsettled close reuses its exact previous hourly request dates", async () => {
  const calls: string[][] = [];
  await prepareTltBoundaryQualification(".", collector(calls), options(monday, "2026-11-24",
    [settlement(monday, originalStart, friday)]));
  assert.deepEqual(calls, [[originalStart, monday]]);
});

test("a hole or incompatible contiguous spans cannot qualify even when their request calendars cover every date", async () => {
  for (const secondStart of ["2026-11-12", "2026-11-13"]) {
    const calls: string[][] = [];
    const proofs = [settlement(monday, originalStart, "2026-11-11"), settlement(monday, secondStart, monday)];
    const result = await prepareTltBoundaryQualification(".", collector(calls), options(monday, "2026-11-24", proofs));
    assert.equal(result.status, "candidate_pending");
    assert.deepEqual(calls, [[originalStart, monday]]);
  }
});

test("a pending source or a failed proof keeps a stable retry window until the delivered close advances", async () => {
  const calls: string[][] = [];
  for (const runDay of [monday, "2026-11-24"]) {
    await prepareTltBoundaryQualification(".", collector(calls), options(friday, runDay, []));
  }
  assert.deepEqual(calls, [["2026-10-16", friday], ["2026-10-16", friday]]);
  const proof = settlement(monday, originalStart, friday), prior = structuredClone(proof);
  await assert.rejects(prepareTltBoundaryQualification(".", async () => { throw Error("rate limited"); },
    options(monday, "2026-11-24", [proof])), /rate limited/);
  assert.deepEqual(proof, prior);
});
