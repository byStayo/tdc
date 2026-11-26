import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { collectOnsInflation, onsHistoricalClock, onsPath, onsReleasePath, ONS_CODES, ONS_ORIGIN,
  validateOnsInflation, type OnsReader } from "../lib/consensus/ons-inflation.ts";
import type { PublicDocument } from "../lib/consensus/calendars.ts";
import { validateSourceCitation } from "../lib/consensus/source-citation.ts";

const time = "2026-11-24T12:50:12.000Z";
const clock = () => time;
const periods = ["July","August","September","October","October"];
const introductions = ["2026-08-19T06:00:00.000Z","2026-09-16T06:00:00.000Z",
  "2026-10-21T06:00:00.000Z","2026-11-18T07:00:00.000Z","2026-11-19T08:00:00.000Z"];
function doc(value:unknown):PublicDocument {
  const text = JSON.stringify(value);
  return { text,sha256:createHash("sha256").update(text).digest("hex"),retrievedAt:time };
}
function sources() {
  const responses = new Map<string,PublicDocument>();
  for (const [column,code] of ONS_CODES.entries()) {
    const root=onsPath(code);
    for (const [i,month] of periods.entries()) {
      const uri = i===4 ? root : root+"/previous/v"+(i+1);
      const date = "2026 "+month.slice(0,3).toUpperCase(), releaseDate=introductions[Math.min(i,3)];
      const value = [[3.0,3.2,3.5,3.6,4.9],[3.5,3.7,3.7,3.7,6.1]][column][i];
      responses.set(ONS_ORIGIN+uri+"/data",doc({uri,type:"timeseries",
        description:{cdid:code.toUpperCase(),datasetId:"MM23",date,unit:"%",releaseDate,
          title:column ? "CPI ANNUAL RATE: Services 2015=100" : "CPI ANNUAL RATE 00: ALL ITEMS 2015=100"},
        months:[{label:date,date,month,year:"2026",sourceDataset:"MM23",value:String(value),updateDate: releaseDate}],
        versions:introductions.slice(1,i+1).map((updateDate,n)=>({label:"v"+(n+1),uri:root+"/previous/v"+(n+1),updateDate}))}));
    }
  }
  for (const [key,i] of [["2026-09",2],["2026-10",3]] as const) {
    const uri=onsReleasePath(key);
    responses.set(ONS_ORIGIN+uri+"/data",doc({uri,description:{title:"Consumer price inflation, UK: "+periods[i]+" 2026",
      finalised:true,published:true,cancelled:false,release_date:introductions[i]}}));
  }
  const read:OnsReader=async url=>{const d=responses.get(url);if(!d)throw Error("Missing fixture");return d};
  return {responses,read};
}
test("the weekday source uses the first October release, the preceding September original and the publication calendar",async()=>{
  const s = await collectOnsInflation(sources().read,clock);
  assert.equal(s.status,"available");
  assert.deepEqual(s.metrics.map(m=>m.value),[3.6,3.7,.1,0]);
  assert.equal(s.source.releasedAt,introductions[3]);
  assert.equal(s.source.observedAt,"2026-10-31");
  assert.equal(s.onsInflation?.current.services.introducedAt,introductions[3]);
  assert(s.onsInflation?.current.services.uri.endsWith("/previous/v4"));
  validateOnsInflation(s,time);
  validateSourceCitation(s.source.url);
  assert.throws(()=>validateOnsInflation({...s,scores:{...s.scores,daily:1}},time));
  assert.throws(()=>validateOnsInflation({...s,metrics:[...s.metrics].reverse()},time));
  assert.throws(()=>validateOnsInflation(s,"2026-11-01T00:00:00.000Z"));
});
test("a contradictory source chain, changed original bytes, cancellation or late calendar withholds the ONS evidence",async()=>{
  for (const change of ["chain","hash","cancel","future"]) {
    const {responses,read}=sources();
    const url=ONS_ORIGIN+(change==="chain" || change==="hash" ? onsPath("d7nn")+"/previous/v4" : onsReleasePath("2026-10"))+"/data";
    const original=responses.get(url)!;
    if(change==="hash")responses.set(url,{...original,text:original.text+" "});
    else {
      const j=JSON.parse(original.text);
      if(change==="chain") j.versions[0].updateDate="2026-09-01T06:00:00.000Z";
      if(change==="cancel")j.description.cancelled=true;
      if(change==="future")j.description.release_date="2026-11-26T07:00:00.000Z";
      responses.set(url,doc(j));
    }
    const s=await collectOnsInflation(read,clock);
    assert.equal(s.status,"unavailable",change);
    assert.equal(s.metrics.length,0);validateOnsInflation(s,time);validateSourceCitation(s.source.url);
  }
});
test("London winter and summer time and the first pandemic release convention convert correctly",()=>{
  assert.equal(onsHistoricalClock("2018-01-16"),"2018-01-16T09:30:00.000Z");
  assert.equal(onsHistoricalClock("2018-06-13"),"2018-06-13T08:30:00.000Z");
  assert.equal(onsHistoricalClock("2020-03-25"),"2020-03-25T07:00:00.000Z");
  assert.equal(onsHistoricalClock("2026-06-17"),"2026-06-17T06:00:00.000Z");
});
