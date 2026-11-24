import test from "node:test";
import assert from "node:assert/strict";
import { payrollImprovementInterval, replayBlsPayrollNewsStudy } from "../scripts/research-bls-payroll-news.ts";

test("keeps BLS research out of prospective forecast periods and rejects live re-fetching", async () => {
  await assert.rejects(replayBlsPayrollNewsStudy(false), /cached originals/);
  await assert.rejects(replayBlsPayrollNewsStudy(true, "2026-11-20T14:00:00.000Z"), /registered first forecast/);
});

test("BLS confidence interval preserves the sign and ordering of paired error differences", () => {
  const sample = [-0.04, -0.03, -0.02, -0.01, 0.005, 0.008, 0.001];
  const interval = payrollImprovementInterval(sample);
  assert.deepEqual(payrollImprovementInterval(sample), interval);
  assert(interval[0] < interval[1] && interval[0] >= Math.min(...sample) && interval[1] <= Math.max(...sample));
  assert.deepEqual(payrollImprovementInterval([0.25, 0.25, 0.25, 0.25]), [0.25, 0.25]);
  assert.throws(() => payrollImprovementInterval([0, 1]));
  assert.throws(() => payrollImprovementInterval([0, NaN, 1]));
});
