import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BOC_DECISION_RESEARCH, isBocDecisionStudyRow } from "../lib/consensus/boc-decision-study.ts";
import { kibotHistorySource } from "../lib/consensus/kibot.ts";
import { agreeingCanadianOutcome, selectCanadianStudyPrices } from "../scripts/research-boc-decisions-tlt.ts";
import { readBocDecisionStudy } from "../scripts/stage-boc-decisions-tlt.ts";
import { researchStudyFor, validateKibotResearch } from "../lib/consensus/kibot-research.ts";
import { assertRetainedStudyRows } from "../scripts/stage-kibot-research.ts";

const published = {
  studyId: BOC_DECISION_RESEARCH.id, family: "international", instrument: "TLT", timingBasis: "dated-release",
  samples: 139, testSamples: 28, coefficientSign: "positive",
  modelBrier: 0.2408, controlBrier: 0.2440, baseRateBrier: 0.2452, coinBrier: 0.25,
  controlImprovement95: [-0.0111, 0.0210], scheduledDecisions: 152, dailyHistoryEligible: 88,
  excludedOverlap: 13, testRateChanges: 4, clearedMargin: false,
};

test("public historical row restricts scope, overlap, treatment incidence and private data", () => {
  assert(isBocDecisionStudyRow(published));
  for (const edit of [
    { dailyHistoryEligible: 139 }, { testRateChanges: 28 }, { samples: 152 }, { excludedOverlap: 0 },
    { symbol: "TLT" }, { prices: [100] }, { coefficient: .37 }, { clearedMargin: true },
    { controlImprovement95: [0, .021] }, { modelBrier: 0.24081035 }, { family: "events" },
  ]) assert(!isBocDecisionStudyRow({ ...published, ...edit }));
});

test("version fourteen appends the Canadian decision study while version thirteen retains exactly 35 entries", async () => {
  const origin = new URL("../public/consensus/", import.meta.url);
  const [first] = JSON.parse(await readFile(new URL("index.json", origin), "utf8"));
  const live = JSON.parse(await readFile(new URL("kibot-research.json", origin), "utf8"));
  const previous = { ...live, schemaVersion: 13, studies: live.studies.slice(0, 35) };
  const next = { ...previous, schemaVersion: 14, studies: [...previous.studies, published] };
  validateKibotResearch(previous, first);
  validateKibotResearch(next, first);
  assertRetainedStudyRows(previous, next);
  assert.equal(researchStudyFor(next.studies[35]), BOC_DECISION_RESEARCH);
  assert.throws(() => validateKibotResearch({ ...next, schemaVersion: 13 }, first));
  assert.throws(() => validateKibotResearch({ ...previous, schemaVersion: 14 }, first));
  assert.throws(() => validateKibotResearch({ ...next, studies: [...previous.studies, { ...published, open: 100 }] }, first));
});

test("only the genuine TLT basis and the selected historical row enter the price comparison", () => {
  const csv = "02/25/2020,not-selected\n02/26/2020,100,104,99,103,10000";
  const date = "2020-02-26";
  const clock = (day: string) => {
    assert.equal(day, date);
    return { session: day, openAt: day + "T14:30:00.000Z", closeAt: day + "T21:00:00.000Z" };
  };
  const proof = {
    basis: "raw" as const, ticker: "TLT" as const, from: "2020-02-25", through: date,
    sourceSHA256: createHash("sha256").update(csv).digest("hex"),
    source: kibotHistorySource("TLT", "2020-02-25", date, "raw"), status: 200, receivedAt: "2026-11-24T12:00:00.000Z",
  };
  const retained = selectCanadianStudyPrices(proof, csv, new Set([date]), clock);
  assert.deepEqual([...retained], [[date, { open: 100, close: 103 }]]);
  assert.throws(() => selectCanadianStudyPrices({ ...proof, basis: "splits" }, csv, new Set([date]), clock));
  assert.throws(() => selectCanadianStudyPrices(proof, csv.replace("103", "102"), new Set([date]), clock));
});

test("both native bases must produce the same direction and within-day ratio", () => {
  const raw = { open: 100, close: 101 };
  assert.equal(agreeingCanadianOutcome(raw, { open: 50, close: 50.5 }), 1);
  assert.equal(agreeingCanadianOutcome(raw, { open: 100, close: 99 }), null);
  assert.equal(agreeingCanadianOutcome(raw, { open: 50, close: 55 }), null);
  assert.equal(agreeingCanadianOutcome(raw, undefined), null);
});

test("staging refuses any alternative first public forecast before looking at data", async () => {
  await assert.rejects(readBocDecisionStudy("/no-private-data", "2026-11-04T08:00:00.000Z"), /original prospective cutoff/);
});
