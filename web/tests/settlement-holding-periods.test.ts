import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateOutcome, type PriceEvidence } from "../lib/consensus/evaluation.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { adjustETFPrices } from "../lib/consensus/corporate-adjustment.ts";
import { compareHoldingPeriods, confirmedHoldingPeriods } from "../lib/consensus/holding-periods.ts";
import { firstRateControlSeries, priorFirstRateHoldingSources, type FirstRateHoldingSource } from "../lib/consensus/firstrate-holding-periods.ts";
import type { Snapshot } from "../lib/consensus/types.ts";

const snapshot: Snapshot = JSON.parse(readFileSync(new URL("../public/consensus/2026-11-03T08-48-02-469Z.json", import.meta.url), "utf8"));
const days = exchangeSessions("2026-11-12", "2026-11-19");
const sessions = days.map(day => ({ ...exchangeSession(day)!, open: 100, close: 101 }));
const evidence: PriceEvidence = { instrument: "DIA", source: "https://firstratedata.com/",
  adjustment: "total-return-adjusted", expectedSessions: days, sessions };
const now = "2026-11-20T13:00:00.000Z";
const issued = (day: string) => ({ ...snapshot, issuedAt: day + "T12:00:00.000Z" });

test("settlement honors the exact independently confirmed holding period and preserves daily and neighboring targets", () => {
  const checked = { ...evidence, confirmedHoldingPeriods: { weekly: [days[5]], monthly: [] } };
  assert.equal(evaluateOutcome(issued(days[0]), checked, "weekly", now), null);
  assert.ok(evaluateOutcome(issued(days[0]), checked, "daily", now));
  assert.ok(evaluateOutcome(issued(days[1]), checked, "weekly", now));
});

test("an overlapping source revision cannot erase the original holding-period evidence", () => {
  const prior: FirstRateHoldingSource = { provider: "market-history", from: days[0], through: days[4], raw: ["a".repeat(64)],
    splits: ["b".repeat(64)], approvedAt: now };
  const replacement = { ...prior, through: days[5], raw: ["c".repeat(64)] };
  assert.deepEqual(priorFirstRateHoldingSources([prior], replacement), [prior]);
  assert.deepEqual(priorFirstRateHoldingSources([prior], { ...prior, approvedAt: "2026-11-21T13:00:00.000Z" }), []);
});

test("a dividend uses each source's own prior close and a distribution on entry belongs to neither return", () => {
  const primary = sessions.map(row => ({ ...row, open: 100, close: 100.1 }));
  primary[4] = { ...primary[4], open: 99, close: 99.51 };
  const reference = primary.map((row, index) => index === 4 ? { ...row, close: 99.49 } : row);
  const cash = [{ session: days[2], amount: 0.5 }];
  const adjusted = adjustETFPrices(primary, cash, []);
  const comparison = compareHoldingPeriods(days, primary, reference, cash);
  assert.deepEqual(comparison[0], { horizon: "weekly", from: days[0], through: days[4], cashBasisVerified: true,
    vendorDirection: "up", referenceDirection: "down" });
  assert.deepEqual(confirmedHoldingPeriods(days, primary, [primary, reference], cash, adjusted).weekly, [days[5]]);
  const differentPrior = primary.map((row, index) => index === 1 ? { ...row, close: row.close + 0.26 } : row);
  assert.equal(compareHoldingPeriods(days, primary, differentPrior, cash)[0].cashBasisVerified, false);
  assert.equal(compareHoldingPeriods(days, primary, reference, [{ session: days[0], amount: 3 }])[0].vendorDirection, "down");
});

test("a missing middle session withholds crossing monthly targets and separate providers cannot be spliced", () => {
  const calendar = exchangeSessions("2026-11-03", "2026-12-04");
  const primary = calendar.map(day => ({ ...exchangeSession(day)!, open: 100, close: 101 }));
  const left = primary.slice(0, 10), right = primary.slice(10);
  assert.deepEqual(confirmedHoldingPeriods(calendar, primary, [left, right], [], primary).monthly, []);
  const joined = firstRateControlSeries([{ provider: "market-history", rows: left }, { provider: "market-history", rows: right }]);
  assert.deepEqual(confirmedHoldingPeriods(calendar, primary, joined.references, [], primary).monthly, calendar.slice(20));
  const missing = primary.filter((_, i) => i !== 1);
  assert.deepEqual(confirmedHoldingPeriods(calendar, primary, [missing], [], primary).monthly, calendar.slice(22));
  const revised = firstRateControlSeries([{ provider: "market-history", rows: primary },
    { provider: "market-history", rows: [{ ...primary[5], open: 99.99 }] }, { provider: "market-history", rows: primary }]);
  assert.deepEqual([...revised.disputed], [calendar[5]]);
  assert.equal(revised.references[0].some(row => row.session === calendar[5]), false);
});
