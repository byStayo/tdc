import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BOC_DECISION_RESEARCH,
  isBocDecisionStudyRow,
  type BocDecisionStudyRow,
} from "../lib/consensus/boc-decision-study.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";

const run = promisify(execFile);
const scripts = fileURLToPath(new URL("./", import.meta.url));
const firstForecast = "2026-11-03T06:28:30.460Z";
const resultSHA256 = "263fa0a62b17744f36be161f9dfcddca349f3c474cc71882c57c20494863f18b";
const sourceSHA256 = "63821a4c810efb89b6eb912b5f32c5d7014e478e3fbe80f260c760dd5f97d449";
const round = (measure: number) => Number(measure.toFixed(4));

type Result = {
  method: string;
  before: string;
  cohort: string;
  paired: number;
  train: number;
  validation: number;
  test: number;
  strictDaily: number;
  model: number;
  control: number;
  base: number;
  coin: number;
  easingCoefficient: number;
  uncertainty: { twoSided95: [number, number] }[];
  clear: boolean;
  missing: string[];
};

function close(actual: number, expected: number) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) < 1e-12;
}

/** Check the original release dates and run both research implementations offline. */
export async function readBocDecisionStudy(webRoot: string, firstIssue: string): Promise<BocDecisionStudyRow> {
  if (firstIssue !== firstForecast) throw Error("Canadian policy study requires the original prospective cutoff");
  const controls = resolve(webRoot, ".consensus");
  const directory = resolve(controls, "private-boc-decisions-tlt");
  const file = resolve(directory, "result.json");
  const recorded = await readResearchReceipt<Result>(file);
  if (!recorded || createHash("sha256").update(await readFile(file)).digest("hex") !== resultSHA256 ||
      recorded.method !== BOC_DECISION_RESEARCH.id || recorded.before !== firstIssue ||
      recorded.cohort !== sourceSHA256 || recorded.missing.length) {
    throw Error("Canadian policy study lost its sealed original or its source cutoff changed");
  }
  const limits = { timeout: 35_000, maxBuffer: 16_384 };
  const [source, program, independent] = await Promise.all([
    run("python3", ["-B", resolve(scripts, "qualify-boc-decisions.py"),
      "--root", directory, "--external", controls], limits),
    run(process.execPath, [resolve(scripts, "research-boc-decisions-tlt.ts"),
      directory, controls, "--cached"], limits),
    run("python3", ["-B", resolve(scripts, "verify-boc-decisions-tlt.py"), directory, controls], limits),
  ]);
  const sourceReport = JSON.parse(source.stdout.trim().split(/\r?\n/).at(-1)!);
  const full = JSON.parse(program.stdout);
  const second = JSON.parse(independent.stdout);
  assert.equal(sourceReport.sourceCohortSHA256, sourceSHA256);
  assert.deepEqual(sourceReport.nativeTargetMismatches, []);
  assert.equal(sourceReport.eligible, second.sample);
  assert.equal(sourceReport.strictDaily, second.strictDaily);
  assert.equal(sourceReport.excluded, second.priorOverlap);
  assert.deepEqual(second.split, [recorded.train, recorded.validation, recorded.test]);
  assert.deepEqual(second.changedInEachFold, [29, 2, 4]);
  assert.equal(second.passed, recorded.clear);
  assert.equal(full.clear, recorded.clear);
  for (const metric of ["model", "control", "base", "coin", "easingCoefficient"] as const) {
    assert(close(second[metric], recorded[metric]) && close(full[metric], recorded[metric]));
  }
  const [lower, upper] = recorded.uncertainty[0].twoSided95;
  assert(close(second.marketChangeVsControl95[0], lower));
  assert(close(second.marketChangeVsControl95[1], upper));
  assert(recorded.easingCoefficient > 0);
  const row: BocDecisionStudyRow = {
    studyId: BOC_DECISION_RESEARCH.id,
    family: BOC_DECISION_RESEARCH.family,
    instrument: BOC_DECISION_RESEARCH.instrument,
    timingBasis: BOC_DECISION_RESEARCH.timingBasis,
    samples: recorded.paired,
    testSamples: recorded.test,
    modelBrier: round(recorded.model),
    controlBrier: round(recorded.control),
    baseRateBrier: round(recorded.base),
    coinBrier: recorded.coin,
    coefficientSign: "positive",
    scheduledDecisions: second.scheduled,
    dailyHistoryEligible: second.strictDaily,
    excludedOverlap: second.priorOverlap,
    testRateChanges: second.changedInEachFold[2],
    controlImprovement95: [round(lower), round(upper)],
    clearedMargin: recorded.clear,
  };
  if (!isBocDecisionStudyRow(row)) throw Error("Canadian policy aggregate differs from the verified disclosure");
  return row;
}
