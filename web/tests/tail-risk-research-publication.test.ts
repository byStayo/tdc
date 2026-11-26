import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  researchStudyFor,
  TAIL_RISK_RESEARCH,
  validateKibotResearch,
  type DatedStudyRow,
} from "../lib/consensus/kibot-research.ts";
import { assertRetainedStudyRows } from "../scripts/stage-kibot-research.ts";
import { readTailRiskStudy } from "../scripts/stage-tail-risk-spy.ts";

const report = new URL(
  "../public/consensus/kibot-research.json",
  import.meta.url,
);
const index = new URL("../public/consensus/index.json", import.meta.url);
const expected: DatedStudyRow = {
  studyId: TAIL_RISK_RESEARCH.id,
  family: "options",
  instrument: "SPY",
  timingBasis: "historical-reconstruction",
  samples: 258,
  testSamples: 52,
  modelBrier: 0.2584,
  controlBrier: 0.2568,
  baseRateBrier: 0.2592,
  coinBrier: 0.25,
  coefficientSign: "negative",
  excludedTargetOverlap: 137,
  excludedInputOverlap: 96,
  controlImprovement95: [-0.0092, 0.0043],
  clearedMargin: false,
};

test("version 13 appends one price-portfolio comparison, preserves all 34 earlier rows and permits rounded aggregate fields only", async () => {
  const [first] = JSON.parse(await readFile(index, "utf8"));
  const shipped = JSON.parse(await readFile(report, "utf8"));
  const previous = {
    ...shipped,
    schemaVersion: 12,
    studies: shipped.studies.slice(0, 34),
  };
  validateKibotResearch(previous, first);
  const upgraded = {
    ...previous,
    schemaVersion: 13,
    studies: [...previous.studies, expected],
  };
  validateKibotResearch(upgraded, first);
  assertRetainedStudyRows(previous, upgraded);
  assert.equal(researchStudyFor(expected), TAIL_RISK_RESEARCH);
  for (const override of [
    { clearedMargin: true },
    { excludedInputOverlap: 0 },
    { open: 500 },
    { modelBrier: 0.2583 },
    { timingBasis: "archived-before-cutoff" },
    { controlImprovement95: [0.0043, 0.02] },
  ]) {
    assert.throws(() =>
      validateKibotResearch(
        {
          ...upgraded,
          studies: [...previous.studies, { ...expected, ...override }],
        },
        first,
      ),
    );
  }
  assert.throws(() =>
    validateKibotResearch({ ...upgraded, schemaVersion: 12 }, first),
  );
  assert.throws(() =>
    validateKibotResearch({ ...previous, schemaVersion: 13 }, first),
  );
});

test("a different prospective launch cannot use the selected TAIL regression", async () => {
  await assert.rejects(
    readTailRiskStudy(".", "2026-11-04T13:00:00.000Z"),
    /same first prospective forecast/,
  );
});
