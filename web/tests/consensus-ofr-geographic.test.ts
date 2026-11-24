import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateKibotResearch, OFR_GEOGRAPHIC_RESEARCH, researchStudyFor, type DatedStudyRow } from "../lib/consensus/kibot-research.ts";
import { assertRetainedStudyRows } from "../scripts/stage-kibot-research.ts";
import { readOfrGeographicStudy } from "../scripts/stage-ofr-geographic.ts";
import { regionalUncertainty } from "../scripts/research-ofr-geographic.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

const reviewed: DatedStudyRow = {
  studyId: OFR_GEOGRAPHIC_RESEARCH.id, family: "international", instrument: "DIA", timingBasis: "archived-before-cutoff",
  samples: 147, testSamples: 30, nativeSamples: 110, mirrorSamples: 37, deferredNativeSamples: 38, comparisonCount: 96,
  adjustedControlP: 1, modelBrier: 0.2743, controlBrier: 0.2705, baseRateBrier: 0.2686, coinBrier: 0.25,
  controlImprovement95: [-0.0119, 0.0048], coefficientSign: "positive", clearedMargin: false,
};

test("version nine appends the regional control without mixing it with the exports study or exposing private fields", async () => {
  const [first] = JSON.parse(await readFile(new URL("../public/consensus/index.json", import.meta.url), "utf8"));
  const original = JSON.parse(await readFile(new URL("../public/consensus/kibot-research.json", import.meta.url), "utf8"));
  const previous = { ...original, schemaVersion: 8, studies: original.studies.slice(0, 29) };
  const candidate = { ...previous, schemaVersion: 9, studies: [...previous.studies, reviewed] };
  validateKibotResearch(previous, first);
  validateKibotResearch(candidate, first);
  assertRetainedStudyRows(previous, candidate);
  assert.equal(researchStudyFor(reviewed).id, OFR_GEOGRAPHIC_RESEARCH.id);
  assert.equal(researchStudyFor(candidate.studies[20]).id, "prelaunch-ft900-exports-dia-v1");
  for (const incorrect of [
    { entryPrice: 1 }, { weights: [0.1] }, { sessions: ["2026-09-21"] }, { studyId: "OFR" }, { instrument: "SPY" },
    { nativeSamples: 109 }, { deferredNativeSamples: 37 }, { mirrorSamples: 39 }, { comparisonCount: 32 },
    { adjustedControlP: -0.1 }, { adjustedControlP: 0.01 }, { adjustedControlP: 0.20002 }, { controlBrier: 0.2704656 },
    { controlImprovement95: [0.05, -0.01] }, { clearedMargin: true }, { sample: 120 }, { nativeOnlySamples: 76 },
  ]) {
    assert.throws(() => validateKibotResearch({ ...candidate, studies: [...previous.studies, { ...reviewed, ...incorrect }] }, first));
  }
  assert.throws(() => validateKibotResearch({ ...candidate, schemaVersion: 8 }, first));
  assert.throws(() => validateKibotResearch({ ...previous, schemaVersion: 9 }, first));
  await assert.rejects(readOfrGeographicStudy(root, "2026-11-04T00:00:00.000Z"), /first prospective/);
});

test("regional block comparison is deterministic, respects the exact-test floor and handles equal per-day losses", () => {
  const zero = regionalUncertainty(Array(30).fill(0));
  assert.deepEqual([zero.improvement, zero.lower, zero.upper, zero.oneSidedP, zero.bonferroni96P], [0, 0, 0, 1, 1]);
  const gain = regionalUncertainty(Array(30).fill(0.125));
  assert.equal(gain.oneSidedP, 1 / 1024);
  assert.equal(gain.bonferroni96P, 96 / 1024);
  assert.equal(gain.lower, 0.125);
  assert.equal(gain.upper, 0.125);
  assert.throws(() => regionalUncertainty(Array(29).fill(0)));
});
