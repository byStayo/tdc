import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { asIssuedConsensus } from "../lib/consensus/as-issued.ts";
import { planCandidate } from "../lib/consensus/learning.ts";
import type { TrainingRow } from "../lib/consensus/learning.ts";
import { forecastSnapshot } from "../lib/consensus/model.ts";
import type { ActiveModel } from "../lib/consensus/model.ts";
import { reserveEvaluation, validateReservations, attemptAlpha } from "../lib/consensus/learning-audit.ts";
import { editionTiming } from "../lib/consensus/edition-timing.ts";
import type { Snapshot, HistoryEntry } from "../lib/consensus/types.ts";

const read = async (id: string): Promise<Snapshot> => JSON.parse(await readFile(new URL(`../public/consensus/${id}.json`, import.meta.url), "utf8"));
const legacy = await read("2026-11-03T08-48-02-469Z");
const current = await read("2026-11-03T14-51-40-702Z");
const history: HistoryEntry[] = JSON.parse(await readFile(new URL("../public/consensus/index.json", import.meta.url), "utf8"));
const features = (snapshot: Snapshot) => asIssuedConsensus(snapshot, "SPY", "monthly").families.flatMap(f => [f.score ?? 0, f.score === null ? 0 : 1]);

test("the real v1/v2 editions have incompatible feature meanings and cannot train together", () => {
  const old = features(legacy), latest = features(current);
  for (const index of [18, 19, 20, 28]) assert.notEqual(old[index], latest[index]);
  const rows: TrainingRow[] = [legacy, current].map(snapshot => ({
    id: snapshot.id, engineVersion: snapshot.engineVersion, issuedAt: snapshot.issuedAt,
    labelKnownAt: "2026-12-04T21:00:00.000Z", features: features(snapshot), up: 1,
  }));
  assert.throws(() => planCandidate(rows, "2027-01-01T00:00:00.000Z"), /one declared engine version/);
  assert.throws(() => planCandidate([rows[0]], "2027-01-01T00:00:00.000Z", {engineVersion: current.engineVersion}), /one declared engine version/);
  const active: ActiveModel = {
    id: "synthetic-old-version", engineVersion: legacy.engineVersion, instrument: "SPY", horizon: "monthly",
    trainedAt: "2026-11-02T12:00:00.000Z", labelsThrough: "2026-10-30T20:00:00.000Z", datasetHash: "a".repeat(64),
    samples: 500, featureSchema: "family-score-plus-observation-mask-v1", priceAdjustment: "total-return-adjusted",
    model: {intercept:0, weights:old.map(()=>0), means:old.map(()=>0), scales:old.map(()=>1), regularization:1},
    testBrier:.25, baselineBrier:.25, testSamples:100,
  };
  assert.equal(forecastSnapshot(legacy, [active])[0].engineVersion, legacy.engineVersion);
  assert.throws(() => forecastSnapshot(current, [active]), /feature contract/);
});

test("changing feature versions cannot reset the attempt budget or reuse consumed outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-version-budget-"));
  const rows = (count: number, engineVersion: string): TrainingRow[] => Array.from({length:count}, (_, i) => ({
    id:`synthetic-${engineVersion}-${i}`, engineVersion,
    issuedAt:new Date(Date.UTC(2020,0,i+1,12)).toISOString(),
    labelKnownAt:new Date(Date.UTC(2020,0,i+1,21)).toISOString(), features:[i%2], up:(i%2) as 0|1,
  }));
  const asOf="2030-01-01T00:00:00.000Z", policy={minimumSamples:500, minimumTestSamples:100, nonOverlappingTest:true};
  try {
    const firstPlan=planCandidate(rows(500,legacy.engineVersion),asOf,policy);
    if(firstPlan.status!=="ready") throw Error("fixture");
    const first=await reserveEvaluation(root,[],firstPlan,"SPY","daily",asOf);
    const reused=planCandidate(rows(500,current.engineVersion),asOf,policy);
    if(reused.status!=="ready") throw Error("fixture");
    await assert.rejects(reserveEvaluation(root,[first],reused,"SPY","daily",asOf),/Invalid or reused/);
    assert.equal(planCandidate(rows(501,current.engineVersion),asOf,{...policy,consumedThrough:first.consumedThrough}).status,"insufficient_data");
    const next=planCandidate(rows(601,current.engineVersion),asOf,{...policy,consumedThrough:first.consumedThrough});
    if(next.status!=="ready") throw Error("fixture");
    const second=await reserveEvaluation(root,[first],next,"SPY","daily",asOf);
    assert.equal(second.attempt,2); assert.equal(second.alpha,attemptAlpha(2));
    assert.equal(second.engineVersion,current.engineVersion);
    assert.doesNotThrow(()=>validateReservations([first,second]));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("methodology reissues display genuine source checks without changing saved evidence", () => {
  const bytes=JSON.stringify(current), timing=editionTiming(current,history);
  assert.equal(timing.methodologyReissue,true);
  assert.equal(timing.latestSourceCheck,"2026-11-03T08:45:01.550Z");
  assert.equal(timing.ruleLabel,"rules 2.0.0");
  assert.equal(editionTiming(legacy,history).methodologyReissue,false);
  const fresh=structuredClone(current);
  fresh.signals.find(s=>s.source.sha256)!.source.retrievedAt=current.issuedAt;
  assert.equal(editionTiming(fresh,history).methodologyReissue,false);
  const missing=structuredClone(current);
  missing.signals.forEach(s=>s.source.sha256=null);
  assert.deepEqual(editionTiming(missing,history), {latestSourceCheck:null,methodologyReissue:false,ruleLabel:"rules 2.0.0"});
  assert.equal(JSON.stringify(current),bytes);
});
