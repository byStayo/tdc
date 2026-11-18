import assert from "node:assert/strict";
import test from "node:test";
import { extendedResearchSession, extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { technicalMomentumRows } from "../scripts/research-technical-momentum.ts";

test("technical features use completed full sessions and label the target after its own close", () => {
  const dates = extendedResearchSessions("2025-10-20", "2026-02-02");
  const before = "2026-11-03T06:28:30.460Z";
  const prices = dates.map((day, index) => ({ ...extendedResearchSession(day)!,
    open: Math.exp(index / 100 - 0.004), close: Math.exp(index / 100) }));
  const training = technicalMomentumRows("SPY", prices, before);
  const first = training[0];
  assert.equal(first.id, `SPY:${dates[21]}`);
  assert.equal(first.labelKnownAt, prices[21].closeAt);
  assert.equal(first.issuedAt, dates[21] + "T13:00:00.000Z");
  for (const [index, expected] of [0.004, 0.05, 0.105, 0.01].entries())
    assert.ok(Math.abs(first.features[index] - expected) < 1e-10);

  const edited = prices.slice();
  edited[21] = { ...edited[21], close: edited[21].open * 0.99 };
  const changed = technicalMomentumRows("SPY", edited, before)[0];
  assert.equal(changed.up, 0);
  assert.deepEqual(changed.features, first.features);

  const halfDay = dates.indexOf("2025-11-28");
  const ineligible = new Set(dates.slice(halfDay, halfDay + 22).map(date => `SPY:${date}`));
  assert.ok(!training.some(row => ineligible.has(row.id)));
  assert.throws(() => technicalMomentumRows("SPY", [...prices.slice(0, 8), ...prices.slice(9)], before),
    /needs contiguous valid sessions/);
});
