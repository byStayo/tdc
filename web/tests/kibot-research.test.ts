import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BLS_PAYROLL_RESEARCH, OFR_VOLATILITY_RESEARCH, researchStudyFor, SPY_CLOSE_LOCATION_RESEARCH, validateKibotResearch, type Ft900StudyRow, type SpyCloseLocationStudyRow } from "../lib/consensus/kibot-research.ts";
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

test("version five distinguishes the SPY meeting-eve study and checks its direction and controls", async () => {
  const root = new URL("../", import.meta.url);
  const { history } = await verifyPublicationTree(fileURLToPath(root));
  const shipped = JSON.parse(await readFile(new URL("public/consensus/kibot-research.json", root), "utf8"));
  const v4 = { ...shipped, schemaVersion: 4 as const, studies: shipped.studies.slice(0, 22) };
  validateKibotResearch(v4, history[0]);
  const row = { studyId: "prelaunch-spy-fomc-eve-2016-2025-v1", family: "events", instrument: "SPY",
    samples: 160, testSamples: 32, testEves: 16, modelBrier: 0.2508, returnOnlyBrier: 0.2516,
    baseRateBrier: 0.2501, coinBrier: 0.25, eveCoefficientSign: "negative", clearedMargin: false };
  const v5 = { ...v4, schemaVersion: 5, studies: [...v4.studies, row] };
  validateKibotResearch(v5, history[0]);
  assert.equal(researchStudyFor(v5.studies[22]).id, row.studyId);
  assertRetainedStudyRows(v4, v5);
  for (const change of [{ instrument: "QQQ" }, { testEves: 32 }, { testEves: 17 }, { testSamples: 25 },
    { samples: 162 }, { samples: 159 }, { clearedMargin: true },
    { eveCoefficientSign: "unknown" }, { eveCoefficientSign: ["negative"] }, { eveCoefficientSign: [["positive"]], modelBrier: 0.20 },
    { eveCoefficientSign: "negative", clearedMargin: true, modelBrier: 0.21 },
    { sourcePrices: [12, 13] }, { returnOnlyBrier: 0.25163 }]) {
    assert.throws(() => validateKibotResearch({ ...v5, studies: [...v4.studies, { ...row, ...change }] }, history[0]));
  }
});

test("version six retains prior studies and bounds the QQQ earnings comparisons and interval", async () => {
  const root = new URL("../", import.meta.url);
  const { history } = await verifyPublicationTree(fileURLToPath(root));
  const shipped = JSON.parse(await readFile(new URL("public/consensus/kibot-research.json", root), "utf8"));
  const prior = { ...shipped, schemaVersion: 5, studies: shipped.studies.slice(0, 23) };
  validateKibotResearch(prior, history[0]);
  const row = { studyId: "prelaunch-qqq-original-revenue-guidance-v1", family: "earnings", instrument: "QQQ",
    samples: 124, testSamples: 25, modelBrier: 0.2599, ageOnlyBrier: 0.2643, baseRateBrier: 0.2518, coinBrier: 0.25,
    earningsCoefficientSign: "negative", controlImprovement95: [-0.0041, 0.0117], clearedMargin: false };
  const make = (changes: Record<string, unknown>) => ({ ...prior, schemaVersion: 6, studies: [...prior.studies, { ...row, ...changes }] });
  const report = make({});
  validateKibotResearch(report, history[0]);
  assert.equal(researchStudyFor(report.studies.at(-1)!).label, "Revenue surprise against management guidance");
  assertRetainedStudyRows(prior, report);
  for (const change of [{ instrument: "SPY" }, { samples: 125 }, { testSamples: 40 }, { clearedMargin: true },
    { earningsCoefficientSign: ["negative"] }, { ageOnlyBrier: 0.26432 }, { controlImprovement95: [0.02, -0.03] },
    { controlImprovement95: [-0.01, 0.02, 0.03] }, { controlImprovement95: [-2, 1] }, { underlyingPrices: [] }]) {
    assert.throws(() => validateKibotResearch(make(change), history[0]), /reviewed aggregate schema/);
  }
  assert.throws(() => validateKibotResearch({ ...report, schemaVersion: 5 }, history[0]));
});

test("version seven appends the three dated studies to the unchanged twenty-four historical rows and keeps versions one through six readable", async () => {
  const root = new URL("../",import.meta.url);
  const {history} = await verifyPublicationTree(fileURLToPath(root));
  const shipped = JSON.parse(await readFile(new URL("public/consensus/kibot-research.json",root),"utf8"));
  validateKibotResearch(shipped,history[0]);
  const v6 = {...shipped,schemaVersion:6 as const,studies:shipped.studies.slice(0,24)};
  const cases = [20,20,21,22,23,24];
  for (const [i,end] of cases.entries()) {
    const earlier = {...v6,schemaVersion:i+1,studies:v6.studies.slice(0,end),
      daily:i===0 ? v6.daily.map(({instrument,sessions,calls})=>({instrument,sessions,calls})) : v6.daily};
    validateKibotResearch(earlier,history[0]);
    assertRetainedStudyRows(earlier,v6);
  }
  const rows = [
    {studyId:"prelaunch-tlt-tic-treasury-demand-v1",family:"capital",instrument:"TLT",timingBasis:"dated-release",samples:126,testSamples:26,
      modelBrier:0.2512,controlBrier:0.2485,baseRateBrier:0.2473,coinBrier:0.25,coefficientSign:"positive",clearedMargin:false},
    {studyId:"prelaunch-spy-swvxx-retail-prime-flow-v1",family:"retail",instrument:"SPY",timingBasis:"dated-release",samples:120,testSamples:24,
      modelBrier:0.3223,controlBrier:0.3155,baseRateBrier:0.25,coinBrier:0.25,coefficientSign:"negative",clearedMargin:false,controlImprovement95:[-0.0114,-0.0009]},
    {studyId:"SPY-prior-CFE-VX-monthly-front-second-v1",family:"options",instrument:"SPY",timingBasis:"historical-reconstruction",samples:247,testSamples:50,
      modelBrier:0.2558,controlBrier:0.254,baseRateBrier:0.2518,coinBrier:0.25,coefficientSign:"negative",clearedMargin:false,strictBeforeCutoff:4},
  ];
  const v7 = {...v6,schemaVersion:7,studies:[...v6.studies,...rows]};
  validateKibotResearch(v7,history[0]);
  assertRetainedStudyRows(v6,v7);
  assert.deepEqual(v7.studies.slice(24).map(researchStudyFor).map(r=>r.id),rows.map(r=>r.studyId));
  const bad = (i:number,patch:Record<string,unknown>) => ({...v7,studies:[...v6.studies,...rows.map((r,j)=>j===i?{...r,...patch}:r)]});
  for (const altered of [
    {...v7,schemaVersion:6},{...v7,studies:v7.studies.slice(0,-1)},{...v7,studies:[...v6.studies,...rows.toReversed()]},
    bad(0,{controlBrier:0.24851}),bad(0,{samples:129}),bad(0,{instrument:"SPY"}),bad(0,{clearedMargin:true}),
    bad(0,{sourceHashes:[]}),bad(1,{controlImprovement95:[0.4,0.1]}),bad(1,{coefficientSign:["negative"]}),
    bad(1,{strictBeforeCutoff:120}),bad(1,{weeklyFlows:[]}),bad(2,{timingBasis:"dated-release"}),bad(2,{strictBeforeCutoff:247}),
    bad(2,{strictBeforeCutoff:3}),bad(2,{settlements:[]}),bad(2,{testSamples:49}),bad(2,{coinBrier:0.2499}),bad(2,{clearedMargin:true}),
  ]) assert.throws(()=>validateKibotResearch(altered,history[0]),/reviewed aggregate schema/);
  const changed = {...v7,studies:[{...v6.studies[0],samples:v6.studies[0].samples+1},...v7.studies.slice(1)]};
  assert.throws(()=>assertRetainedStudyRows(v6,changed),/previously published/);
});

test("version eight retains all twenty-seven earlier rows and appends the TLT payroll and mixed-source SPY volatility studies", async () => {
  const root = new URL("../", import.meta.url);
  const { history } = await verifyPublicationTree(fileURLToPath(root));
  const shipped = JSON.parse(await readFile(new URL("public/consensus/kibot-research.json", root), "utf8"));
  const previous = { ...shipped, schemaVersion: 7, studies: shipped.studies.slice(0, 27) };
  validateKibotResearch(previous, history[0]);
  const row = {
    studyId: BLS_PAYROLL_RESEARCH.id, family: "news", instrument: "TLT", timingBasis: "dated-release",
    samples: 134, testSamples: 27, modelBrier: 0.2579, controlBrier: 0.2505, baseRateBrier: 0.2473,
    coinBrier: 0.25, coefficientSign: "positive", controlImprovement95: [-0.0175, -0.0019], clearedMargin: false,
  };
  const ofr = {
    studyId: OFR_VOLATILITY_RESEARCH.id, family: "macro", instrument: "SPY", timingBasis: "archived-before-cutoff",
    sourceBasis: "originals-and-four-decimal-mirror", nativeOnlySamples: 76, nativeSamples: 70, mirrorSamples: 55,
    samples: 125, testSamples: 25, modelBrier: 0.2515, controlBrier: 0.2518, baseRateBrier: 0.2540,
    coinBrier: 0.25, coefficientSign: "positive", controlImprovement95: [-0.0020, 0.0019], clearedMargin: false,
  };
  const append = (changes: Record<string, unknown> = {}, ofrChanges: Record<string, unknown> = {}) => ({
    ...previous, schemaVersion: 8, studies: [...previous.studies, { ...row, ...changes }, { ...ofr, ...ofrChanges }],
  });
  const report = append();
  validateKibotResearch(report, history[0]);
  assertRetainedStudyRows(previous, report);
  assert.equal(researchStudyFor(report.studies.at(-2)!), BLS_PAYROLL_RESEARCH);
  assert.equal(researchStudyFor(report.studies.at(-1)!), OFR_VOLATILITY_RESEARCH);
  assert.equal(BLS_PAYROLL_RESEARCH.expectedSign, "negative");
  const substitutions = [
    { instrument: "DIA" }, { family: "rates" }, { samples: 135 }, { testSamples: 26 }, { timingBasis: "historical-reconstruction" },
    { studyId: "prelaunch-gdelt-news-v1" }, { coefficientSign: ["positive"] }, { coinBrier: 0.2499 }, { clearedMargin: true },
    { controlBrier: 0.25054 }, { controlImprovement95: [-0.01751, -0.0019] }, { controlImprovement95: [-0.0019, -0.0175] },
    { controlImprovement95: [NaN, 0.2] }, { controlImprovement95: [0.1] }, { strictBeforeCutoff: 134 },
    { modelWeights: [0.0603] }, { sourceHashes: [] }, { payrollChanges: [] }, { priceRows: [] },
  ];
  for (const change of substitutions) assert.throws(() => validateKibotResearch(append(change), history[0]), /reviewed aggregate schema/);
  for (const altered of [
    { ...previous, schemaVersion: 8 }, { ...report, schemaVersion: 7 }, { ...report, studies: [...report.studies, row] },
    { ...report, studies: [...previous.studies.slice(0, -1), row, previous.studies.at(-1)] },
    { ...report, studies: [...previous.studies, row] }, { ...report, studies: [...previous.studies, ofr] },
    { ...report, studies: [...previous.studies, ofr, row] },
  ]) assert.throws(() => validateKibotResearch(altered, history[0]), /reviewed aggregate schema/);
  const changedPrior = { ...report, studies: [{ ...previous.studies[0], samples: previous.studies[0].samples + 1 }, ...report.studies.slice(1)] };
  assert.throws(() => assertRetainedStudyRows(previous, changedPrior), /previously published/);
  const passed = { modelBrier: 0.21, clearedMargin: true, coefficientSign: "negative", controlImprovement95: [0.02, 0.06] };
  validateKibotResearch(append(passed), history[0]);
  for (const change of [
    { coefficientSign: "positive" }, { coefficientSign: "zero" }, { controlImprovement95: [-0.001, 0.06] }, { clearedMargin: false },
    { controlBrier: 0.2199 }, { baseRateBrier: 0.2199 }, { modelBrier: 0.2401, controlBrier: 0.27, baseRateBrier: 0.27 },
  ]) assert.throws(() => validateKibotResearch(append({ ...passed, ...change }), history[0]));
  validateKibotResearch(append({ ...passed, clearedMargin: false, controlImprovement95: [-0.001, 0.06] }), history[0]);
  // A lower 95% bound rounded to zero can have either sign at the precision used in the replay.
  for (const clearedMargin of [true, false]) validateKibotResearch(append({
    ...passed, clearedMargin, controlImprovement95: [0, 0.06],
  }), history[0]);

  for (const change of [
    { instrument: "TLT" }, { family: "rates" }, { sourceBasis: "originals-only" }, { timingBasis: "dated-release" },
    { nativeOnlySamples: 125 }, { nativeSamples: 76, mirrorSamples: 49 }, { mirrorSamples: 56 }, { samples: 126 }, { testSamples: 24 },
    { studyId: "ofr-volatility-contribution-spy-prelaunch-v1" }, { clearedMargin: true }, { rawVolatilityChanges: [] },
    { controlImprovement95: [0.01, -0.01] }, { controlImprovement95: [-0.01, 0.01001] }, { controlBrier: 0.25181 },
  ]) assert.throws(() => validateKibotResearch(append({}, change), history[0]), /reviewed aggregate schema/);
  // The OFR interval is descriptive. Its registered decision uses a positive coefficient on minus delta volatility and all three margins.
  validateKibotResearch(append({}, { modelBrier: 0.21, clearedMargin: true, controlImprovement95: [-0.01, 0.04] }), history[0]);
  assert.throws(() => validateKibotResearch(append({}, { modelBrier: 0.21, clearedMargin: true, coefficientSign: "negative" }), history[0]));
  assert.throws(() => validateKibotResearch(append({}, { modelBrier: 0.21, clearedMargin: false }), history[0]));
});
