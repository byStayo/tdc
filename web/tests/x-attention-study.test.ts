import assert from "node:assert/strict";
import test from "node:test";
import { attentionPoint } from "../scripts/research-x-attention.ts";

const ordinary = { SPY: [100, 50], QQQ: [100, 50], IWM: [100, 50], DIA: [100, 50], TLT: [100, 50] } as const;
function source() {
  return Object.fromEntries(["2024-09-02", "2024-08-26", "2024-08-19", "2024-08-12", "2024-08-05"]
    .map(date => [date, Object.fromEntries(Object.entries(ordinary).map(([fund, pair]) => [fund, [...pair] as [number, number]]))]));
}

test("Monday holiday is the prior UTC date and four earlier Mondays supply the comparison", () => {
  const days = source();
  days["2024-09-02"].SPY = [200, 80];
  const point = attentionPoint("2024-09-03", days, "2024-06-03");
  assert(typeof point === "object");
  assert.equal(point.inputDay, "2024-09-02");
  assert(Math.abs(point.values[0][0] - Math.log((200 / 600) / 0.2)) < 1e-12);
  assert(Math.abs(point.values[0][1] - Math.log((80 / 280) / 0.2)) < 1e-12);
  assert(Math.abs(point.values[4][1] - Math.log((50 / 280) / 0.2)) < 1e-12);
  days["2024-09-03"] = { SPY: [5_000, 3_000] };
  assert.deepEqual(attentionPoint("2024-09-03", days, "2024-06-03"), point);
});

test("all funds and all four comparators must have valid participation in a single collection regime", () => {
  const days = source();
  days["2024-08-12"].DIA = [100, 9];
  assert.equal(attentionPoint("2024-09-03", days, "2024-06-03"), "missing_or_small_group");
  days["2024-08-12"].DIA = [10, 11];
  assert.equal(attentionPoint("2024-09-03", days, "2024-06-03"), "missing_or_small_group");
  delete days["2024-08-05"];
  assert.equal(attentionPoint("2024-09-03", days, "2024-06-03"), "missing_or_small_group");
  assert.equal(attentionPoint("2024-06-04", {}, "2024-06-03"), "collection_changed_in_lookback");
  assert.equal(attentionPoint("2024-10-30", {}, "2024-06-03"), "outside_observation_period");
});
