import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateKibotResearch } from "../lib/consensus/kibot-research.ts";
import { refreshInflationAndMoney } from "../lib/consensus/collector.ts";
import { assertRetainedStudyRows } from "../scripts/stage-kibot-research.ts";

const json = async (path:string) => JSON.parse(await readFile(new URL(path,import.meta.url),"utf8"));
test("the two historical comparisons append to the earlier studies and exclude raw prices and incorrect sample claims",async()=>{
  const [first] = await json("../public/consensus/index.json");
  const shipped = await json("../public/consensus/kibot-research.json");
  const v11 = {...shipped,schemaVersion:11,studies:shipped.studies.slice(0,32)};
  const common = {timingBasis:"dated-release",coefficientSign:"negative",clearedMargin:false,coinBrier:.25};
  const uk = {...common,studyId:"ons-first-services-inflation-tlt-prelaunch-v1",family:"international",instrument:"TLT",
    samples:121,testSamples:25,modelBrier:.2623,controlBrier:.2622,baseRateBrier:.2632,controlImprovement95:[-.0037,.0030],
    priorStudySessions:70,priorStudyTestSessions:21};
  const retail = {...common,studyId:"prelaunch-fed-h6-retail-deposit-iwm-v1",family:"retail",instrument:"IWM",
    samples:136,testSamples:28,modelBrier:.2499,controlBrier:.2498,baseRateBrier:.2514,controlImprovement95:[-.0118,.0114],
    excludedPriorDates:32};
  const v12 = {...v11,schemaVersion:12,studies:[...v11.studies,uk,retail]};
  validateKibotResearch(v11,first);
  validateKibotResearch(v12,first);
  assertRetainedStudyRows(v11,v12);
  for (const tail of [[retail,uk],[{...uk,clearedMargin:true},retail],[uk,{...retail,excludedPriorDates:0}],
    [{...uk,priorStudyTestSessions:0},retail],[{...uk,price:120},retail],[uk,{...retail,controlImprovement95:[.01,0]}]]) {
    assert.throws(()=>validateKibotResearch({...v12,studies:[...v11.studies,...tail]},first));
  }
});

test("a scoped refresh keeps unrelated inputs, archive timing and existing errors in their own edition",async()=>{
  const previous = await json("../lib/consensus/current.json");
  const now = new Date(Date.parse(previous.issuedAt)+60000).toISOString();
  const fetcher = async()=>new Response("temporarily unavailable",{status:503});
  const snapshot = await refreshInflationAndMoney(previous,fetcher,undefined,()=>now);
  const ids = new Set(["ons-uk-cpi-services","fed-h6-retail-balances"]);
  assert.deepEqual(snapshot.signals.filter(s=>!ids.has(s.id)),previous.signals.filter((s:{id:string})=>!ids.has(s.id)));
  assert.deepEqual(snapshot.signals.filter(s=>ids.has(s.id)).map(s=>s.status),["unavailable","unavailable"]);
  assert.equal(snapshot.sourcesAttempted,2);
  assert.equal(snapshot.cutoff,now);
  assert.equal(snapshot.consensus,undefined);
  assert.equal(snapshot.forecasts,undefined);
  assert.equal(snapshot.signals.filter(s=>s.id==="fed-h6-retail-balances").length,1);
});
