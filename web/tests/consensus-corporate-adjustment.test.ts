import test from "node:test";
import assert from "node:assert/strict";
import { exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { adjustETFPrices } from "../lib/consensus/corporate-adjustment.ts";

const rows = [
  { ...exchangeSession("2026-10-30")!, open: 81.86, close: 81.84 },
  { ...exchangeSession("2026-11-02")!, open: 81.83, close: 81.73 },
  { ...exchangeSession("2026-11-03")!, open: 40.71, close: 40.55 },
];
test("cash dividends and subsequent splits adjust both endpoints before their ex-date", () => {
  const dividend = { session: "2026-11-02", amount: 0.343177 };
  const split = { session: "2026-11-03", ratio: 2 };
  const adjusted = adjustETFPrices(rows, [dividend], [split]);
  const factor = (81.84 - dividend.amount) / 81.84 / 2;
  assert.equal(adjusted[0].open, rows[0].open * factor);
  assert.equal(adjusted[0].close, rows[0].close * factor);
  assert.equal(adjusted[1].close, rows[1].close / 2);
  assert.deepEqual(adjusted[2], rows[2]);
});

test("invalid or ambiguous actions cannot change adjusted prices", () => {
  assert.throws(() => adjustETFPrices(rows, [{session:"2026-11-02",amount:82}], []), /dividend/);
  assert.throws(() => adjustETFPrices(rows, [{session:"2026-11-01",amount:1}], []), /session/);
  assert.throws(() => adjustETFPrices(rows, [{session:"2026-11-02",amount:1}], [{session:"2026-11-02",ratio:2}]), /same session/);
  assert.throws(() => adjustETFPrices(rows, [], [{session:"2026-11-03",ratio:0}]), /split/);
});
