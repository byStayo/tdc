import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { G17_MANUFACTURING_RESEARCH, researchStudyFor, validateKibotResearch, type DatedStudyRow } from "../lib/consensus/kibot-research.ts";
import { readG17ManufacturingStudy } from "../scripts/research-g17-manufacturing.ts";
import { assertRetainedStudyRows } from "../scripts/stage-kibot-research.ts";

const row: DatedStudyRow = {
  studyId: G17_MANUFACTURING_RESEARCH.id, family: "news", instrument: "DIA", timingBasis: "dated-release",
  samples: 125, testSamples: 25, monthlyReleases: 129, multiplePreliminaryMonths: 1, unconfirmedClocks: 3,
  priorTechnicalSamples: 43, priorTechnicalTestSamples: 19, coefficientSign: "negative", controlImprovement95: [-0.0002, 0.0016],
  modelBrier: .2579, controlBrier: .2586, baseRateBrier: .2583, coinBrier: .25, clearedMargin: false,
};

test("v11 appends the dated DIA news screen and retains the 31 original studies, timing, overlap and four-decimal controls", async () => {
  const [first] = JSON.parse(await readFile(new URL("../public/consensus/index.json", import.meta.url), "utf8"));
  const shipped = JSON.parse(await readFile(new URL("../public/consensus/kibot-research.json", import.meta.url), "utf8"));
  const previous = { ...shipped, schemaVersion: 10, studies: shipped.studies.slice(0, 31) };
  validateKibotResearch(previous, first);
  const next = { ...previous, schemaVersion: 11, studies: [...previous.studies, row] };
  validateKibotResearch(next, first);
  assertRetainedStudyRows(previous, next);
  assert.equal(researchStudyFor(row), G17_MANUFACTURING_RESEARCH);
  for (const change of [{ instrument: "SPY" }, { family: "events" }, { timingBasis: "archived-before-cutoff" },
    { priorTechnicalTestSamples: 0 }, { priorTechnicalSamples: 19 }, { monthlyReleases: 126 }, { unconfirmedClocks: 2 },
    { multiplePreliminaryMonths: 0 }, { clearedMargin: true }, { controlImprovement95: [.01, -.01] },
    { controlBrier: .25865 }, { price: 100 }, { dates: ["2026-10-19"] }])
    assert.throws(() => validateKibotResearch({ ...next, studies: [...previous.studies, { ...row, ...change }] }, first));
  assert.throws(() => validateKibotResearch({ ...next, schemaVersion: 10 }, first));
  assert.throws(() => validateKibotResearch({ ...previous, schemaVersion: 11 }, first));
  assert.throws(() => validateKibotResearch({ ...next, studies: [row, ...previous.studies] }, first));
});

test("the private G.17 replay rejects a different first issue before opening any source or price file", async () => {
  await assert.rejects(() => readG17ManufacturingStudy("/missing", "2026-11-04T10:00:00.000Z"), /first issue/);
});
