import { INSTRUMENTS, type Instrument } from "./types.ts";

export const QUARTERLY_PRICE_FILE = "/research/etf-price-check-2026-09.json";
type Checks = { checked: number; passed: number };
type Windows = Checks & { withDividend: number; changedByDividend: number };
export type QuarterlyPriceCheck = {
  method: "quarterly-etf-price-qualification-v1"; from: string; through: string;
  funds: { symbol: Exclude<Instrument, "MARKET">; daily: Checks; weekly: Windows; monthly: Windows; dividends: Checks }[];
};

function fields(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.split(" ").sort().join(","))
    throw new Error("Unexpected fields in the public price comparison");
}
function count(value: unknown, limit: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > limit)
    throw new Error("Invalid count in the public price comparison");
  return value;
}

/** This fixed study includes all 23 sessions and every overlapping window, including failures. */
export function validateQuarterlyPriceCheck(value: unknown): asserts value is QuarterlyPriceCheck {
  fields(value, "method from through funds");
  if (value.method !== "quarterly-etf-price-qualification-v1" || value.from !== "2026-08-31" || value.through !== "2026-10-01")
    throw new Error("Unrecognized price comparison period");
  const funds = INSTRUMENTS.filter(fund => fund !== "MARKET");
  if (!Array.isArray(value.funds) || value.funds.length !== funds.length) throw new Error("Five ETF comparisons are required");
  for (const [index, row] of value.funds.entries()) {
    fields(row, "symbol daily weekly monthly dividends");
    if (row.symbol !== funds[index]) throw new Error("Unexpected ETF in the public price comparison");
    for (const [name, expected] of [["daily", 23], ["weekly", 19], ["monthly", 3]] as const) {
      const result = row[name];
      fields(result, name === "daily" ? "checked passed" : "checked passed withDividend changedByDividend");
      if (result.checked !== expected) throw new Error("Missing sessions or windows in the public price comparison");
      count(result.passed, expected);
      if (name !== "daily") count(result.changedByDividend, count(result.withDividend, expected));
    }
    fields(row.dividends, "checked passed");
    count(row.dividends.passed, count(row.dividends.checked, 23));
  }
}
