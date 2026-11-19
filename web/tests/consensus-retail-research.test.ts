import assert from "node:assert/strict";
import test from "node:test";
import { extendedResearchSession, extendedResearchSessions } from "../lib/consensus/extended-research-calendar.ts";
import { nowcastTargets } from "../scripts/research-nyfed-nowcast.ts";
import { buildRetailRows, retailTargets, type RetailReading } from "../scripts/research-nyfed-retail.ts";
import { adsTargets } from "../scripts/research-philly-ads.ts";

function point(publicationDate: string, referenceMonthEnd: string): RetailReading {
  return { id: publicationDate, publicationDate, referenceMonthEnd, meanHigherStockPricesPercent: 42.4,
    source: "https://www.newyorkfed.org/newsevents/news/research/2018/example", sha256: "a".repeat(64) };
}

test("retail research covers the 2018 mourning closure, Independence Day short session and 2021 year end", () => {
  assert.equal(extendedResearchSession("2018-12-05"), null);
  assert.equal(extendedResearchSession("2019-07-03")?.closeAt, "2019-07-03T17:00:00.000Z");
  assert.equal(extendedResearchSession("2021-12-31")?.closeAt, "2021-12-31T21:00:00.000Z");
  assert.deepEqual(extendedResearchSessions("2021-12-31", "2022-01-03"), ["2021-12-31", "2022-01-03"]);
  assert.throws(() => extendedResearchSession("2015-12-31"), /outside the extended research calendar/);
});

test("a dated retail observation has one target, and the next shortened session cannot move the label", () => {
  const december = point("2018-12-04", "2018-11-30");
  const targets = retailTargets([december, point("2019-07-02", "2019-06-30")], "2019-07-08");
  assert.deepEqual([...targets.keys()], ["2018-12-06"]);
  const prices = [
    { ...extendedResearchSession("2018-12-04")!, open: 100, close: 103 },
    { ...extendedResearchSession("2018-12-06")!, open: 100, close: 99 },
    { ...extendedResearchSession("2018-12-07")!, open: 100, close: 103 },
  ];
  const [pair] = buildRetailRows(targets, prices, "SPY", "2026-11-03T06:28:30.460Z");
  assert.equal(pair.row.id, "SPY:2018-12-06");
  assert.equal(pair.row.issuedAt, "2018-12-06T13:00:00.000Z");
  assert.equal(pair.row.up, 0);
  assert.equal(pair.observedAt, "2018-11-30");
  assert.equal(pair.published, "2018-12-04");
  assert.equal(buildRetailRows(targets, prices, "SPY", "2026-11-03T06:28:30.460Z").length, 1);
});

test("the Nowcast screen compares the same forecast quarter and skips the federal holiday row", () => {
  const targets = nowcastTargets([
    { date: "2023-09-01", quarters: { "2023Q3": 1 } },
    { date: "2023-09-08", quarters: { "2023Q3": 2 } },
    { date: "2023-09-15", quarters: { "2023Q3": 3 } },
    { date: "2023-09-29", quarters: { "2023Q3": 4, "2023Q4": 2 } },
    { date: "2023-10-06", quarters: { "2023Q4": 3 } },
    { date: "2023-11-03", quarters: { "2023Q4": 5 } },
    { date: "2023-11-10", quarters: { "2023Q4": 9 } },
    { date: "2023-11-17", quarters: { "2023Q4": 6 } },
  ]);
  assert.deepEqual([...targets.keys()], ["2023-09-18", "2023-10-02", "2023-10-09", "2023-11-20"]);
  assert.deepEqual(targets.get("2023-10-09"), { observed: "2023-10-06", previous: "2023-09-29", quarter: "2023Q4", delta: 1 });
  assert.equal(targets.get("2023-11-20")?.previous, "2023-11-03");
});

test("ADS targets use a later full session and the two exact prior Treasury observations", () => {
  const sessions = extendedResearchSessions("2025-11-24", "2026-11-02");
  const yields = new Map([["2025-11-25", 4], ["2025-11-26", 4.25], ["2026-10-29", 4], ["2026-10-30", 4.25]]);
  const updates = [
    { date: "2025-11-26", previous: "2025-11-25", observed: "2025-11-25", change: 0.125 },
    { date: "2026-10-30", previous: "2026-10-29", observed: "2026-10-28", change: 0.25 },
    { date: "2026-10-31", previous: "2026-10-30", observed: "2026-10-28", change: 0.5 },
  ];
  assert.deepEqual([...adsTargets(updates, sessions, yields)], [["2026-11-02", {
    ...updates[2], preceding: "2026-10-30", yieldChangeBps: 25,
  }]]);
  yields.delete("2026-10-29");
  assert.equal(adsTargets(updates, sessions, yields).size, 0);
});
