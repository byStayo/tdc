import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { effectiveStatus } from "../lib/consensus/engine.ts";
import { collectNyFedDeskSurvey, validateNyFedDeskSurvey, nyFedDeskFirstEligibleOpen } from "../lib/consensus/nyfed-desk-survey.ts";

const issued = "2026-11-24T03:11:00.000Z";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sourceLost = async () => { throw new Error("Unreachable synthetic source"); };

// Synthetic values deliberately differ from the live survey. No vendor source bytes are required.
async function reading() {
  const signal = await collectNyFedDeskSurvey(sourceLost, undefined, () => issued);
  const prefix = "https://www.newyorkfed.org/medialibrary/media/markets/survey/2026/oct-2026-";
  const e = {
    version:1 as const, distributed:"2026-10-14", responsesDue:"2026-10-19", elapsedMeetingTarget:"2026-10-28", minutesReleasedDate:"2026-11-18",
    publicationDay:"2026-11-19", officialPublicationTime:null, firstVerifiedBy:"2026-11-24T03:09:19.000Z",
    targetDate:"2026-12-31", respondents:50,
    bins:[{range:"<= 3.00%",meanProbabilityPct:20},{range:"3.01 - 4.00%",meanProbabilityPct:50},{range:">= 4.01%",meanProbabilityPct:30}],
    pdfUrl:prefix+"sme-results.pdf", workbookUrl:prefix+"data.xlsx", pdfSHA256:sha("test original"),workbookSHA256:sha("test native data"),receiptId:"",
  };
  e.receiptId=sha(JSON.stringify([[e.pdfUrl,e.pdfSHA256],[e.workbookUrl,e.workbookSHA256]]));
  signal.status="available";
  delete signal.failureKind;
  signal.nyFedDeskSurvey=e;
  signal.source={...signal.source,url:e.pdfUrl,observedAt:e.responsesDue,releasedAt:e.publicationDay,retrievedAt:e.firstVerifiedBy,sha256:e.pdfSHA256,
    attribution:"© 2026 Federal Reserve Bank of New York. Content from the New York Fed subject to the Terms of Use at newyorkfed.org. Markets Group, Survey of Market Expectations."};
  signal.summary="The combined panel of 50 assigned the highest mean probability, 50%, to 3.01 - 4.00% for the 2026-12-31 federal funds target midpoint.";
  signal.metrics=[...e.bins.map(b=>({label:"Year-end policy midpoint "+b.range,value:b.meanProbabilityPct,date:e.responsesDue,unit:"% probability"})),
    {label:"Combined survey respondents",value:50,date:e.responsesDue,unit:"respondents"}];
  return {signal,e};
}

test("an unverified NY Fed release provides no source value or directional score", async () => {
  const signal=await collectNyFedDeskSurvey(sourceLost,undefined,()=>issued);
  assert.equal(signal.status,"unavailable");
  validateNyFedDeskSurvey(signal,issued);
  signal.scores.daily=0;
  assert.throws(()=>validateNyFedDeskSurvey(signal,issued));
});

test("original fieldwork, date-only publication and first verification remain distinct", async () => {
  const {signal,e}=await reading();
  validateNyFedDeskSurvey(signal,issued);
  assert.throws(()=>validateNyFedDeskSurvey(signal,"2026-11-19T23:59:59.999Z"));
  signal.source.releasedAt=e.distributed;
  assert.throws(()=>validateNyFedDeskSurvey(signal,issued));
});

test("a release verified after the close cannot be assigned the earlier ETF session", async () => {
  const {signal,e}=await reading();
  assert.deepEqual(nyFedDeskFirstEligibleOpen(e.firstVerifiedBy), {session:"2026-11-24",openAt:"2026-11-24T14:30:00.000Z"});
  assert.deepEqual(nyFedDeskFirstEligibleOpen("2026-11-24T14:30:00.000Z"), {session:"2026-11-25",openAt:"2026-11-25T14:30:00.000Z"});
  signal.source.retrievedAt="2026-11-18T19:00:00.000Z";
  e.firstVerifiedBy=signal.source.retrievedAt;
  assert.throws(()=>validateNyFedDeskSurvey(signal,issued));
});

test("a scoped edition carries the old survey through its New York target boundary as stale", async () => {
  const {signal}=await reading();
  assert.equal(effectiveStatus(signal,"2026-12-31T04:59:59.999Z"),"available");
  assert.equal(effectiveStatus(signal,"2026-12-31T05:00:00.000Z"),"stale");
  validateNyFedDeskSurvey(signal,"2026-12-31T05:00:00.000Z");
  const marked={...signal,status:"stale" as const};
  validateNyFedDeskSurvey(marked,"2026-12-31T05:00:00.000Z");
  assert.throws(()=>validateNyFedDeskSurvey(marked,issued));
});

test("an overlapping bin, synthetic metric or removal of the reuse notice fails verification", async () => {
  const {signal,e}=await reading();
  e.bins[1].range="3.00 - 4.00%";
  assert.throws(()=>validateNyFedDeskSurvey(signal,issued),/gap or overlap/);
  e.bins[1].range="3.01 - 4.00%";
  signal.metrics[0].value=35;
  assert.throws(()=>validateNyFedDeskSurvey(signal,issued),/verified bins/);
  signal.metrics[0].value=20;
  signal.source.usage="";
  assert.throws(()=>validateNyFedDeskSurvey(signal,issued),/attribution/);
});

test("target-date expiry leaves other family records and old immutable editions unchanged", async () => {
  const {signal}=await reading();
  const unrelated={...signal,id:"unrelated-context-record"};
  assert.equal(effectiveStatus(unrelated,"2026-12-31T05:00:00.000Z"),"available");
  assert.equal(effectiveStatus(signal,issued),"available");
});
