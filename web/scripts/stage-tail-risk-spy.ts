import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  TAIL_RISK_RESEARCH,
  type DatedStudyRow,
} from "../lib/consensus/kibot-research.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";

const run = promisify(execFile);
const scripts = fileURLToPath(new URL("./", import.meta.url));
const firstForecast = "2026-11-03T06:28:30.460Z";
const frozenResult =
  "ea372ecadb1c6310df4c30815039eb95a40d222e4306353853e19b46d636320a";
const round = (value: number) => Number(value.toFixed(4));
type Result = {
  method: string;
  before: string;
  summary: {
    eligible: number;
    excludedMissing: number;
    training: number;
    validation: number;
    test: number;
    model: number;
    control: number;
    baseRate: number;
    coin: number;
    coefficient: number;
    intervals: { twoSided95: [number, number]; correctedLower: number }[];
    passes: boolean;
  };
};

/** Rebuild the private computation twice. Only the registered counts and rounded aggregate statistics leave this function. */
export async function readTailRiskStudy(
  root: string,
  firstIssue: string,
): Promise<DatedStudyRow> {
  if (firstIssue !== firstForecast)
    throw Error("TAIL study requires the same first prospective forecast");
  const shared = resolve(root, ".consensus"),
    folder = resolve(shared, "private-tail-risk-spy");
  const original = resolve(folder, "result.json");
  const result = await readResearchReceipt<Result>(original);
  if (
    !result ||
    createHash("sha256")
      .update(await readFile(original))
      .digest("hex") !== frozenResult ||
    result.method !== TAIL_RISK_RESEARCH.id ||
    result.before !== firstIssue
  )
    throw Error("Sealed TAIL research result differs");
  const options = { timeout: 45_000, maxBuffer: 16_384 };
  const [registered, independent] = await Promise.all([
    run(
      process.execPath,
      [
        resolve(scripts, "research-tail-risk-spy.ts"),
        "--replay",
        shared,
        folder,
      ],
      options,
    ),
    run(
      "python3",
      ["-B", resolve(scripts, "verify-tail-risk-spy.py"), folder],
      options,
    ),
  ]);
  const summary = result.summary,
    check = JSON.parse(independent.stdout);
  assert.deepEqual(JSON.parse(registered.stdout), summary);
  assert.deepEqual(check.split, [
    summary.training,
    summary.validation,
    summary.test,
  ]);
  assert(
    check.pairs === summary.eligible &&
      check.excluded === 0 &&
      check.passed === summary.passes &&
      Math.abs(check.independentBrier - summary.model) < 1e-12 &&
      Math.abs(check.matchedBrier - summary.control) < 1e-12,
  );
  const bounds = summary.intervals[0].twoSided95;
  return {
    studyId: TAIL_RISK_RESEARCH.id,
    family: TAIL_RISK_RESEARCH.family,
    instrument: "SPY",
    timingBasis: "historical-reconstruction",
    samples: summary.eligible,
    testSamples: summary.test,
    modelBrier: round(summary.model),
    controlBrier: round(summary.control),
    baseRateBrier: round(summary.baseRate),
    coinBrier: summary.coin,
    coefficientSign:
      summary.coefficient < 0
        ? "negative"
        : summary.coefficient > 0
          ? "positive"
          : "zero",
    excludedTargetOverlap: 137,
    excludedInputOverlap: 96,
    controlImprovement95: [round(bounds[0]), round(bounds[1])],
    clearedMargin: summary.passes,
  };
}
