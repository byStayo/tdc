import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { QUARTERLY_PRICE_FILE, validateQuarterlyPriceCheck } from "../lib/consensus/quarterly-price-check.ts";

const shipped = JSON.parse(await readFile(new URL("../public" + QUARTERLY_PRICE_FILE, import.meta.url), "utf8"));

test("the price comparison preserves every ETF and overlapping window and allows real failures", () => {
  validateQuarterlyPriceCheck(shipped);
  const missed = structuredClone(shipped);
  missed.funds[1].monthly.passed = 0;
  validateQuarterlyPriceCheck(missed);
  missed.funds[1].monthly.checked--;
  assert.throws(() => validateQuarterlyPriceCheck(missed), /Missing sessions/);
  assert.throws(() => validateQuarterlyPriceCheck({ ...shipped, funds: shipped.funds.slice(1) }), /Five ETF/);
});

test("the public comparison rejects private additions and impossible dividend counts", () => {
  const changed = structuredClone(shipped);
  changed.funds[4].weekly.changedByDividend = changed.funds[4].weekly.withDividend + 1;
  assert.throws(() => validateQuarterlyPriceCheck(changed), /Invalid count/);
  changed.funds[0].daily.open = 1;
  assert.throws(() => validateQuarterlyPriceCheck(changed), /Unexpected fields/);
  assert.throws(() => validateQuarterlyPriceCheck({ ...shipped, sources: [] }), /Unexpected fields/);
});
