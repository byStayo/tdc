import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { researchStudyFor, SPY_CLOSE_LOCATION_RESEARCH, validateKibotResearch, type Ft900StudyRow, type SpyCloseLocationStudyRow } from "../lib/consensus/kibot-research.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { assertRetainedStudyRows } from "../scripts/stage-kibot-research.ts";

test("the shipped research aggregate is anchored to the archive and rejects source values at every level", async () => {
  const root = new URL("../", import.meta.url);
  const { history } = await verifyPublicationTree(fileURLToPath(root));
  const report = JSON.parse(await readFile(new URL("public/consensus/kibot-research.json", root), "utf8"));
  validateKibotResearch(report, history[0]);
  const oldStudies = report.studies.filter(row => row.family !== "international" && !("studyId" in row));
  const versionOne = { ...report, schemaVersion: 1 as const, studies: oldStudies,
    daily: report.daily.map(({ instrument, sessions, calls }) => ({ instrument, sessions, calls })) };
  const versionTwo = { ...versionOne, schemaVersion: 2 as const, daily: versionOne.daily.map(row => ({ ...row, eligibleSessions: row.sessions })) };
  validateKibotResearch(versionOne, history[0]);
  validateKibotResearch(versionTwo, history[0]);
  for (const changed of [
    { ...versionOne, schemaVersion: 2 },
    { ...versionTwo, schemaVersion: 1 },
    ...[-1, 0.5, versionTwo.daily[0].sessions + 1].map(eligibleSessions => ({
      ...versionTwo, daily: [{ ...versionTwo.daily[0], eligibleSessions }, ...versionTwo.daily.slice(1)],
    })),
    { ...report, outcomes: [{ entry: 1, exit: 2 }] },
    { ...report, daily: [{ ...report.daily[0], returnPct: 0.2 }, ...report.daily.slice(1)] },
    ...[{ weights: [0.1] }, { modelBrier: 0.250012 }, { testSamples: 1 }].map(fields => ({
      ...report, studies: [{ ...report.studies[0], ...fields }, ...report.studies.slice(1)],
    })),
    { ...report, firstEdition: history[1].id },
  ]) {
    assert.throws(() => validateKibotResearch(changed, history[0]), /reviewed aggregate schema/);
  }
});

test("a version-three aggregate preserves the original rows and confines the matched FX comparison to DIA", async () => {
  const root = new URL("../", import.meta.url);
  const { history } = await verifyPublicationTree(fileURLToPath(root));
  const shipped = JSON.parse(await readFile(new URL("public/consensus/kibot-research.json", root), "utf8"));
  validateKibotResearch(shipped, history[0]);
  const legacy = { ...shipped, schemaVersion: 2 as const, studies: shipped.studies.filter(row => row.family !== "international" && !("studyId" in row)),
    daily: shipped.daily.map(row => ({ ...row, eligibleSessions: row.eligibleSessions ?? 0 })) };
  const specimen: Ft900StudyRow = { family: "international", instrument: "DIA", samples: 125, testSamples: 25,
    modelBrier: 0.2100, fxOnlyBrier: 0.2300, baseRateBrier: 0.2700, coinBrier: 0.25,
    exportCoefficientSign: "positive", clearedMargin: true };
  const publish = { ...legacy, schemaVersion: 3 as const, studies: [...legacy.studies, specimen] };
  validateKibotResearch(publish, history[0]);
  assertRetainedStudyRows(legacy, publish);
  assertRetainedStudyRows(publish, publish);
  const variants = [
    { releaseSHA256: "private" }, { originalPrices: [] }, { exportCoefficient: 0.5 }, { fxOnlyBrier: 0.230001 },
    { coinBrier: 0.24 }, { instrument: "SPY" }, { family: "fx" }, { exportCoefficientSign: ["positive"] },
    { exportCoefficientSign: "negative" }, { exportCoefficientSign: "zero" }, { clearedMargin: false },
    { fxOnlyBrier: 0.215 }, { baseRateBrier: 0.215 }, { modelBrier: 0.242, fxOnlyBrier: 0.3100 },
  ];
  for (const changed of [
    { ...publish, schemaVersion: 2 }, { ...legacy, schemaVersion: 3 }, { ...publish, studies: [specimen, ...legacy.studies] },
    ...variants.map(fields => ({ ...publish, studies: [...legacy.studies, { ...specimen, ...fields }] })),
  ]) assert.throws(() => validateKibotResearch(changed, history[0]), /reviewed aggregate schema/);
  // At a rounded margin of exactly .0100, only the full-precision private replay can choose the outcome.
  for (const clearedMargin of [true, false]) validateKibotResearch({ ...publish, studies: [...legacy.studies,
    { ...specimen, modelBrier: 0.22, clearedMargin }] }, history[0]);
  const weaker = { ...publish, studies: [...legacy.studies, { ...specimen, fxOnlyBrier: 0.21, clearedMargin: false }] };
  validateKibotResearch(weaker, history[0]);
  assert.throws(() => assertRetainedStudyRows(publish, weaker), /previously published/);
  const rewritten = { ...publish, studies: [{ ...legacy.studies[0], samples: legacy.studies[0].samples + 1 }, ...publish.studies.slice(1)] };
  assert.throws(() => assertRetainedStudyRows(legacy, rewritten), /previously published/);
});


test("version four adds the distinct matched SPY close-location study without rewriting the momentum or FT900 rows", async () => {
  const root = new URL("../", import.meta.url);
  const { history } = await verifyPublicationTree(fileURLToPath(root));
  const shipped = JSON.parse(await readFile(new URL("public/consensus/kibot-research.json", root), "utf8"));
  validateKibotResearch(shipped, history[0]);
  const v3 = { ...shipped, schemaVersion:3 as const, studies:shipped.studies.filter(row => !("studyId" in row)) };
  validateKibotResearch(v3, history[0]);
  const specimen: SpyCloseLocationStudyRow = {
    studyId: SPY_CLOSE_LOCATION_RESEARCH.id, family:"technicals", instrument:"SPY", samples:139, testSamples:28,
    modelBrier:0.2555, returnOnlyBrier:0.2569, baseRateBrier:0.2544, coinBrier:0.25, clearedMargin:false,
  };
  const v4 = { ...v3, schemaVersion:4 as const, studies:[...v3.studies,specimen] };
  validateKibotResearch(v4, history[0]);
  assertRetainedStudyRows(v3, v4);
  const momentum = v3.studies.find(row => row.family === "technicals" && row.instrument === "SPY");
  assert.ok(momentum);
  assert.notEqual(researchStudyFor(momentum).id, researchStudyFor(specimen).id);
  const from = (changes: Record<string, unknown>) => ({...v4, studies:[...v3.studies, {...specimen, ...changes}]});
  const invalid: unknown[] = [
    {...v4,schemaVersion:3}, {...v3,schemaVersion:4}, {...v4,studies:[...v3.studies.slice(0,-1),specimen,v3.studies.at(-1)]},
    {...v4,studies:[...v4.studies,specimen]},
    ...[{studyId:"prelaunch-family-screen-v1"}, {instrument:"QQQ"}, {family:"events"}, {returnOnlyBrier:0.25691},
      {coinBrier:0.2499}, {clearedMargin:true}, {sourceHashes:[]}, {prices:[]}, {coefficient:-0.03}, {fxOnlyBrier:0.2569}]
      .map(from),
  ];
  for (const wrong of invalid) assert.throws(() => validateKibotResearch(wrong,history[0]), /reviewed aggregate schema/);
  for (const clearedMargin of [true,false])
    validateKibotResearch(from({clearedMargin, modelBrier:0.24, returnOnlyBrier:0.25, baseRateBrier:0.27}),history[0]);
});
