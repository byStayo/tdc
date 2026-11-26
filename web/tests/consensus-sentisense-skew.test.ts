import assert from "node:assert/strict";
import test from "node:test";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { historicalResearchSession } from "../lib/consensus/research-session-calendar.ts";
import { skewStudyRows } from "../scripts/research-sentisense-skew.ts";

test("skew uses the exact fifth reviewed session across a holiday, including short sessions in the lag", () => {
  const bars = ["2025-11-28", "2025-12-04", "2025-12-05", "2025-12-08"].map((date, index) => ({
    ...historicalResearchSession(date)!, open: 100, close: index % 2 === 0 ? 99 : 101,
  }));
  const skew = new Map([
    ["2025-11-25", 0.99], ["2025-11-26", -0.03], ["2025-11-28", 0], ["2025-12-02", 0.04],
  ]);

  const result = skewStudyRows("SPY", bars, skew);
  assert.equal(result.excludedShortSessions, 1);
  assert.equal(result.missingFeatureSessions, 1);
  assert.deepEqual(result.rows.map(({ id, features, up }) => ({ id, features, up })), [
    { id: "SPY:2025-12-04:2025-11-26", features: [-0.03], up: 1 },
    { id: "SPY:2025-12-05:2025-11-28", features: [0], up: 0 },
  ]);
});

test("skew screen rejects outcome clocks at and after the first public forecast", () => {
  const bar = { ...exchangeSession("2026-11-03")!, open: 100, close: 101 };
  assert.throws(() => skewStudyRows("SPY", [bar], new Map()), /overlaps the public archive/);
});
