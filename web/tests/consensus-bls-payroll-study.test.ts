import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseKibotDaily } from "../lib/consensus/kibot-bls-study-v1.ts";
import { payrollImprovementInterval, replayBlsPayrollNewsStudy } from "../scripts/research-bls-payroll-news.ts";

test("the payroll study retains the exact daily price parser registered before scoring", async () => {
  const bytes = await readFile(new URL("../lib/consensus/kibot-bls-study-v1.ts", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "7092fbefd09d6a8aaf4b2e2699fc01738c8352b36d638436b59cda7a9e99def1");
  const [bar] = parseKibotDaily("11/02/2026,10,12,9,11,200", ["2026-11-02"]);
  assert.deepEqual([bar.session, bar.open, bar.close], ["2026-11-02", 10, 11]);
});

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
