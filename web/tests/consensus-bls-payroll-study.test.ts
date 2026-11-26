import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseKibotDaily } from "../lib/consensus/kibot-bls-study-v1.ts";
import { payrollImprovementInterval, payrollStudySession, registeredPayrollClock, replayBlsPayrollNewsStudy } from "../scripts/research-bls-payroll-news.ts";

test("the payroll study retains the exact daily price parser registered before scoring", async () => {
  const bytes = await readFile(new URL("../lib/consensus/kibot-bls-study-v1.ts", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "7092fbefd09d6a8aaf4b2e2699fc01738c8352b36d638436b59cda7a9e99def1");
  const [bar] = parseKibotDaily("11/02/2026,10,12,9,11,200", ["2026-11-02"]);
  assert.deepEqual([bar.session, bar.open, bar.close], ["2026-11-02", 10, 11]);
});

test("the registered clock reproduces all 306 prelaunch dates in 2026 after the production calendar advances", async () => {
  const original = await readFile(new URL("../lib/consensus/exchange-calendar-bls-study-v1.ts", import.meta.url));
  assert.equal(createHash("sha256").update(original).digest("hex"), "3835dd790c5a80b45436329ae26f0d46cbacf419a14de8ad1d708635b08a129b");
  const hash = createHash("sha256");
  let sessions = 0;
  for (let at = Date.parse("2026-01-01"); at < Date.parse("2026-11-03"); at += 86400000) {
    const day = new Date(at).toISOString().slice(0, 10), clock = payrollStudySession(day, {});
    if (clock) sessions++;
    hash.update(JSON.stringify([day, clock]) + "\n");
  }
  assert.equal(sessions, 210);
  assert.equal(hash.digest("hex"), "f7488570ecbfade90b71d512d708445906e4f32286d7c241e1abd6d5363292bc");
  assert.throws(() => payrollStudySession("2026-11-03", {}), /registered prelaunch/);
  assert.throws(() => payrollStudySession("2028-02-01", {}), /registered prelaunch/);
});

test("an incomplete older source calendar fails the historical replay before scoring", () => {
  assert.throws(() => registeredPayrollClock({}), /registered historical session clocks differ/);
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
