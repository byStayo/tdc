import assert from "node:assert/strict";
import test from "node:test";
import { optionPositionTargets, pairedOptionReports } from "../scripts/research-cftc-option-positioning.ts";

test("CFTC options benchmark assigns one full target after the posting proxy", () => {
  const dates = ["2023-05-09", "2023-05-16", "2023-06-13", "2023-06-20",
    "2025-09-23", "2025-09-30", "2025-12-23", "2025-12-30"];
  const rows = dates.flatMap((date, index) => ["Combined", "FutOnly"].map(type => ({
    cftc_contract_market_code: "13874A",
    report_date_as_yyyy_mm_dd: date + "T00:00:00.000",
    market_and_exchange_names: "S&P 500",
    contract_units: "test units",
    open_interest_all: type === "Combined" ? "200" : "100",
    asset_mgr_positions_long: String((type === "Combined" ? 6 : 2) * (index + 1)),
    asset_mgr_positions_short: "1",
    futonly_or_combined: type,
  })));
  const targets = optionPositionTargets(pairedOptionReports(rows, "13874A"));
  assert.deepEqual([...targets.keys()], ["2023-05-30"]);
  const target = targets.get("2023-05-30")!;
  assert.equal(target.availabilityProxy, "2023-05-26");
  assert.equal(target.futuresChange, 0.02);
  assert.ok(Math.abs(target.optionsChange - 0.04) < 1e-10);
  assert.throws(() => pairedOptionReports(rows.slice(1), "13874A"), /Inconsistent CFTC/);
});
