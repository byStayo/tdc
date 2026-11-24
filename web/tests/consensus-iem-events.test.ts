import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { IEM_ELECTION_RESEARCH, researchStudyFor, validateKibotResearch, type DatedStudyRow } from "../lib/consensus/kibot-research.ts";
import { iemUncertainty } from "../scripts/research-iem-events.ts";
import { readIemElectionStudy } from "../scripts/stage-iem-events.ts";
import { assertRetainedStudyRows } from "../scripts/stage-kibot-research.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const reviewed: DatedStudyRow = {
  studyId: IEM_ELECTION_RESEARCH.id, family: "events", instrument: "SPY", timingBasis: "historical-reconstruction",
  samples: 214, trainSamples: 131, validationSamples: 51, testSamples: 32, test2020Samples: 24, test2024Samples: 8,
  controlImprovement95: [-0.0024, 0.0028], campaignControlP: 1, comparisonCount: 384, adjustedControlP: 1,
  coefficientSign: "negative", modelBrier: 0.2508, controlBrier: 0.2499, baseRateBrier: 0.2510, coinBrier: 0.25, clearedMargin: false,
};

test("version ten preserves every v9 study and permits only the reviewed election aggregate", async () => {
  const [first] = JSON.parse(await readFile(new URL("../public/consensus/index.json", import.meta.url), "utf8"));
  const latest = JSON.parse(await readFile(new URL("../public/consensus/kibot-research.json", import.meta.url), "utf8"));
  const earlier = { ...latest, schemaVersion: 9, studies: latest.studies.slice(0, 30) };
  const updated = { ...earlier, schemaVersion: 10, studies: [...earlier.studies, reviewed] };
  validateKibotResearch(earlier, first);
  validateKibotResearch(updated, first);
  assertRetainedStudyRows(earlier, updated);
  assert.equal(JSON.stringify(earlier.daily), JSON.stringify(updated.daily));
  assert.equal(JSON.stringify(earlier.studies), JSON.stringify(updated.studies.slice(0, 30)));
  assert.equal(researchStudyFor(reviewed).id, IEM_ELECTION_RESEARCH.id);
  assert.equal(researchStudyFor(updated.studies[22]).id, "prelaunch-spy-fomc-eve-2016-2025-v1");
  for (const incorrect of [
    { entryPrice: 1 }, { prices: [] }, { days: [] }, { candidates: [] }, { sourceQuote: "" },
    { family: "retail" }, { timingBasis: "dated-release" }, { testSamples: 43 }, { trainSamples: 130 },
    { test2024Samples: 9 }, { comparisonCount: 96 }, { campaignControlP: 0.05 }, { adjustedControlP: 0.95 },
    { controlBrier: 0.249891 }, { controlImprovement95: [1, -1] }, { clearedMargin: true },
  ]) {
    const bad = { ...updated, studies: [...earlier.studies, { ...reviewed, ...incorrect }] };
    assert.throws(() => validateKibotResearch(bad, first));
  }
  assert.throws(() => validateKibotResearch({ ...updated, schemaVersion: 9 }, first));
  assert.throws(() => validateKibotResearch({ ...earlier, schemaVersion: 10 }, first));
  await assert.rejects(readIemElectionStudy(root, "2026-11-04T00:00:00.000Z"), /first prospective/);
});

test("the exact two-campaign permutation has a one-quarter floor and the bootstrap preserves campaigns", () => {
  const flat = iemUncertainty(Array(24).fill(0), Array(8).fill(0));
  assert.deepEqual(flat, { pairedImprovement: 0, interval95: [0, 0], oneSidedCycleSignFlipP: 1, correctedP: 1 });
  const different = iemUncertainty(Array(24).fill(0.125), Array(8).fill(0.25));
  assert.deepEqual(different, { pairedImprovement: 0.15625, interval95: [0.15625, 0.15625], oneSidedCycleSignFlipP: 0.25, correctedP: 1 });
  assert.throws(() => iemUncertainty(Array(23).fill(0), Array(9).fill(0)));
  assert.throws(() => iemUncertainty(Array(24).fill(NaN), Array(8).fill(0)));
});
