import assert from "node:assert/strict";
import test from "node:test";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import {
  firstRatePriceEvidence, FIRST_RATE_SOURCE, FIRST_RATE_SYMBOLS, reconcileFirstRateRows,
} from "../lib/consensus/firstrate.ts";

const price = (day: string, open: number, close: number) => ({ ...exchangeSession(day)!, open, close });

test("FirstRate withholds a directional disagreement and a short session while keeping verified full dates", () => {
  const raw = [price("2026-11-25", 100, 99.99), price("2026-11-27", 100, 101), price("2026-11-30", 100, 102)];
  const candidate = [{ ...raw[0], close: 100 }, raw[1], raw[2]];
  const result = reconcileFirstRateRows("DIA", candidate, raw, raw);
  assert.deepEqual(result.rows, [raw[2]]);
  assert.deepEqual(result.withheld, [
    { session: "2026-11-25", reason: "direction" },
    { session: "2026-11-27", reason: "short-session" },
  ]);
  assert.deepEqual(reconcileFirstRateRows("DIA", candidate, raw, raw, [raw[0]]), result);
  assert.deepEqual(reconcileFirstRateRows("DIA", candidate, raw, raw, [candidate[0]]).rows, [candidate[0], raw[2]]);
  assert.throws(() => reconcileFirstRateRows("DIA", candidate, raw, [price("2026-11-25", 50, 50), ...raw.slice(1)]), /split-basis/);
});

test("FirstRate cash adjustment uses the prior regular close and preserves missing calendar dates", () => {
  const rows = [
    price("2026-11-23", 100, 100),
    price("2026-11-24", 99, 100),
    price("2026-11-30", 105, 106),
  ];
  const capturedAt = "2026-12-01T12:00:00.000Z";
  const approval: Parameters<typeof firstRatePriceEvidence>[0] = {
    schemaVersion: 1,
    source: FIRST_RATE_SOURCE,
    from: "2026-11-23",
    through: "2026-11-30",
    approvedAt: capturedAt,
    issuers: ([...FIRST_RATE_SYMBOLS, "TLT"] as const).map(symbol => ({
      symbol, source: "https://example.test/issuer", sha256: "a".repeat(64), capturedAt,
      cash: [{ session: "2026-11-24", amount: 1 }],
    })),
    symbols: FIRST_RATE_SYMBOLS.map(symbol => ({
      symbol,
      rows,
      withheld: [{ session: "2026-11-27", reason: "short-session" }],
      proof: { source: { symbol, url: FIRST_RATE_SOURCE, capturedAt, modifiedAt: capturedAt,
        sha256: "a".repeat(64), basis: "split-adjusted" }, comparison: [], splitComparison: [], listingReferences: [] },
    })),
  };
  const [result] = firstRatePriceEvidence(approval);
  assert.equal(result.adjustment, "total-return-adjusted");
  assert.deepEqual(result.expectedSessions, ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-30"]);
  assert.deepEqual(result.sessions, [{ ...rows[0], open: 99, close: 99 }, rows[1], rows[2]]);
});
