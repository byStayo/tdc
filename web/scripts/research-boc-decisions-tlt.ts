import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { durableDirectory, durableJSON } from "../lib/publication-storage.ts";
import { kibotHistorySource, MAX_KIBOT_RESPONSE_BYTES, parseKibotDaily } from "../lib/consensus/kibot.ts";
import { chronologicalSplit, predict, trainCandidate, type TrainingRow } from "../lib/consensus/learning.ts";
import { readResearchReceipt } from "../lib/consensus/research-price-capture.ts";

const program = fileURLToPath(import.meta.url);
const web = fileURLToPath(new URL("../", import.meta.url));
const method = "prelaunch-tlt-canadian-policy-change-v1-bank-effective-register";
const before = "2026-11-03T06:28:30.460Z";
const pinnedCohort = "63821a4c810efb89b6eb912b5f32c5d7014e478e3fbe80f260c760dd5f97d449";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type Basis = "raw" | "splits";
type SourceDay = {day: string; sourceDay: string; issue: string; open: string; close: string; features: number[]};
type Cohort = {eligible: SourceDay[]; strictEligible: string[]; validationFrom: string; testFrom: string; inputs: {sourceProgram: string; policy: string; sourceSupplement: string; exchangeCalendar: string}};
type Proof = {ticker: "TLT"; basis: Basis; from: string; through: string; sourceSHA256: string; source: string; status: number; receivedAt: string};
type Day = {open: number; close: number};
type DayClock = (day: string) => {session: string; openAt: string; closeAt: string} | null;
type Complete = {proof: Proof; csv: string};

async function required<T>(path: string) {
  const receipt = await readResearchReceipt<T>(path);
  if (!receipt) throw Error("Missing private research receipt: " + path.split("/").at(-1));
  return receipt;
}

async function freeze(root: string, create: boolean) {
  const cohortPath = resolve(root, "source-cohort.json");
  assert.equal(digest(await readFile(cohortPath)), pinnedCohort, "Source cohort checksum changed");
  const cohort = await required<Cohort>(cohortPath);
  const checked = async (p: string) => digest(await readFile(resolve(web,p)));
  assert.equal(await checked("scripts/qualify-boc-decisions.py"), cohort.inputs.sourceProgram);
  assert.equal(await checked("scripts/boc-decisions-tlt-policy.json"), cohort.inputs.policy);
  assert.equal(await checked("scripts/boc-decisions-tlt-source-extension.json"), cohort.inputs.sourceSupplement);
  const registeredSource=await readFile(resolve(root,"transport-scoring-program.ts"),"utf8");
  assert.equal(digest(registeredSource),"699f4defdbd314a43163acd07e39ff4d09692878801f1fcbdf863922c97a49a4");
  const currentSource=await readFile(program,"utf8");
  // This type-only signature refines JavaScript Number(boolean) to its exact two possible values.
  const startMarker="\nexport function selectCanadianStudyPrices(";
  const typeOnly="export function agreeingCanadianOutcome(raw: Day | undefined, split: Day | undefined): 0 | 1 | null;\n";
  const computation=(source:string)=>source.slice(source.indexOf(startMarker)).replace(typeOnly,"");
  assert.equal(computation(currentSource),computation(registeredSource),"Registered market decoding, fit or runtime changed");
  const data = {method,before,cohort:pinnedCohort,script:digest(registeredSource),learning:await checked("lib/consensus/learning.ts"),
    kibot:await checked("lib/consensus/kibot.ts"),eligible:cohort.eligible.length,strict:cohort.strictEligible.length,
    validationFrom:cohort.validationFrom,testFrom:cohort.testFrom};
  assert.equal(data.eligible,139);
  assert.equal(data.strict,88);
  // The initial source-only reservation predates inspecting the larger input archive.
  // Only the input transport gained a second existing archive and bounded yearly batches.
  const previousBytes=await readFile(resolve(root,"scoring-reservation.json"));
  assert.equal(digest(previousBytes),"988a51cd48f470275c25765bfb2345e8a771ee49d0b6e41cf15704c36b7d4f37");
  const initial=JSON.parse(previousBytes.toString()) as {data:typeof data};
  const sealedCode=await readFile(resolve(root,"first-scoring-program.ts"),"utf8");
  assert.equal(digest(sealedCode),initial.data.script);
  assert.deepEqual({...initial.data,script:data.script},data);
  const fitBlock=(s:string)=>s.slice(s.indexOf("\nexport function decisionLossIntervals("),s.indexOf("\nif (process.argv[1]"));
  assert.equal(fitBlock(sealedCode),fitBlock(await readFile(program,"utf8")),"Original statistics and model changed");
  const path=resolve(root,"scoring-archive-supplement.json");
  const existing=await readResearchReceipt<{recordedAt:string;data:typeof data}>(path);
  if (existing) assert.deepEqual(existing.data,data,"Registered policy, scope, or fit changed");
  else {
    if (!create) throw Error("A separate source-only preregistration is required before price evaluation");
    await durableJSON(path,{recordedAt:new Date().toISOString(),data},true);
  }
  return cohort;
}

export function selectCanadianStudyPrices(proof: Proof, csv: string, selected: Set<string>, clock: DayClock) {
  assert.equal(proof.ticker,"TLT");
  assert(["raw","splits"].includes(proof.basis));
  assert(proof.from >= "2003-01-01" && proof.through <= "2021-12-31" && proof.from <= proof.through);
  assert.equal(proof.source,kibotHistorySource("TLT",proof.from,proof.through,proof.basis));
  assert.equal(proof.status,200);
  assert.equal(digest(csv),proof.sourceSHA256);
  const output = new Map<string,Day>();
  let prior="";
  for (const line of csv.trim().split(/\r?\n/)) {
    const meta=/^(\d{2})\/(\d{2})\/(\d{4}),/.exec(line);
    if (!meta) throw Error("Native quote receipt contains invalid date record");
    const key=meta[3]+"-"+meta[1]+"-"+meta[2];
    assert(key>=proof.from && key<=proof.through && prior<key,"Native quote date scope or ordering changed");
    prior=key;
    if (!selected.has(key)) continue;
    const [bar]=parseKibotDaily(line,[key],clock);
    output.set(key,{open:bar.open, close:bar.close});
  }
  return output;
}

export function agreeingCanadianOutcome(raw: Day | undefined, split: Day | undefined): 0 | 1 | null;
export function agreeingCanadianOutcome(raw: Day | undefined, split: Day | undefined) {
  if (!raw || !split) return null;
  if (![raw.open,raw.close,split.open,split.close].every(x=>Number.isFinite(x) && x>0)) throw Error("Invalid selected prices");
  const a = Math.log(raw.close/raw.open);
  const b = Math.log(split.close/split.open);
  if (Math.abs(a-b)>0.0001 || Math.sign(raw.close-raw.open)!==Math.sign(split.close-split.open)) return null;
  return Number(raw.close>raw.open);
}

async function preparePrices(root: string, external: string, rows: SourceDay[], live: boolean) {
  const selected=new Set(rows.map(row=>row.day));
  const byDay=new Map(rows.map(row=>[row.day,row]));
  const clock: DayClock = (day) => {
    const row=byDay.get(day);
    return row ? {session:day,openAt:new Date(row.open).toISOString(),closeAt:new Date(row.close).toISOString()} : null;
  };
  const values: Record<Basis,Map<string,Day>> = {raw:new Map(),splits:new Map()};
  const proofs: {scope:string; key:string; digest:string}[]=[];
  const incorporate=(proof:Proof,csv:string,scope:string,key:string)=>{
    const chosen=selectCanadianStudyPrices(proof,csv,selected,clock);
    if (!chosen.size) return;
    proofs.push({scope,key,digest:proof.sourceSHA256});
    for (const [day,bar] of chosen) {
      const existing=values[proof.basis].get(day);
      if (existing) assert.deepEqual(existing,bar,"Overlapping native bodies conflict for a retained target");
      values[proof.basis].set(day,bar);
    }
  };
  const original=resolve(external,"private-tlt-fomc-dissent/price-originals");
  for (const file of (await readdir(original)).sort()) {
    if (!/^20\d\d-.*-(raw|splits)\.json$/.test(file)) continue;
    const year=Number(file.slice(0,4));
    if (year<2003 || year>2021) continue;
    const proof=await required<Proof>(resolve(original,file));
    const csv=await readFile(resolve(original,file.replace(/\.json$/,".csv")),"utf8");
    incorporate(proof,csv,"external:private-tlt-fomc-dissent/price-originals",file);
  }
  // This archive has the same official raw/split API schema but predates storing the source URL.
  // Its producer derives the native URL from the five pinned request fields.
  const bls=resolve(external,"private-bls-payroll-news/prices");
  for (const key of (await readdir(bls)).sort()) {
    const match=/^TLT-(20\d\d)-(20\d\d-\d\d-\d\d)-(20\d\d-\d\d-\d\d)-(raw|splits)\.json$/.exec(key);
    if (!match || match[1] > "2021") continue;
    const basis=match[4] as Basis;
    const needed=new Set([...selected].filter(d=>d>=match[2] && d<=match[3] && !values[basis].has(d)));
    if (!needed.size) continue;
    const meta=await required<Omit<Proof,"source"|"status">>(resolve(bls,key));
    assert(meta.ticker==="TLT" && meta.from===match[2] && meta.through===match[3] && meta.basis===basis);
    const proof:Proof={...meta,status:200,source:kibotHistorySource("TLT",meta.from,meta.through,basis)};
    const text=await readFile(resolve(bls,key.replace(/\.json$/,".csv")),"utf8");
    incorporate(proof,text,"external:private-bls-payroll-news/prices",key);
  }
  const own=resolve(root,"prices");
  await durableDirectory(own);
  const unresolved: {year:string;dates:string[];basis:Basis}[]=[];
  for (const basis of ["raw","splits"] as const) {
    for (let year=2003;year<=2021;year++) {
      const dates=[...selected].filter(d=>d.startsWith(String(year)) && !values[basis].has(d)).sort();
      if (dates.length) unresolved.push({year:String(year),dates,basis});
    }
  }
  assert(unresolved.length<=38,"At most one free request per year and basis");
  for (const {year,dates,basis} of unresolved) {
    const from=dates[0], through=dates.at(-1)!;
    const file=year+"-"+from+"-"+through+"-"+basis+".json",path=resolve(own,file);
    let native=await readResearchReceipt<Complete>(path);
    if (!native) {
      if (!live) throw Error("Missing native bounded "+basis+" comparator through "+through);
      const source=kibotHistorySource("TLT",from,through,basis);
      const transport=new URL(source);
      transport.searchParams.set("user","guest");
      transport.searchParams.set("password","guest");
      const response=await fetch(transport,{redirect:"error",cache:"no-store",signal:AbortSignal.timeout(15_000)});
      if (response.status!==200 || !response.body) throw Error("Free private research source returned status "+response.status);
      const reader=response.body.getReader();
      const chunks:Uint8Array[]=[];
      let length=0;
      try {
        for (;;) {
          const {done,value}=await reader.read();
          if (done) break;
          length+=value.byteLength;
          if (length>MAX_KIBOT_RESPONSE_BYTES) throw Error("Response exceeds registered size");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(()=>undefined);
      }
      const bytes=Buffer.concat(chunks), csv=bytes.toString("utf8");
      const proof:Proof={ticker:"TLT",basis,from,through,sourceSHA256:digest(bytes),source,status:200,receivedAt:new Date().toISOString()};
      const relevant=selectCanadianStudyPrices(proof,csv,new Set(dates),clock);
      if (!relevant.size) throw Error("Bounded source provided no reserved dates");
      native={proof,csv};
      await durableJSON(path,native,true);
    }
    incorporate(native.proof,native.csv,"private-boc-decisions-tlt/prices",file);
  }
  return {values,proofs,extra:unresolved.length};
}

export function decisionLossIntervals(rows: [number,number,number][]) {
  assert(rows.length>=20);
  const draws: number[][]=[[],[],[]];
  let state=20261124;
  for (let draw=0;draw<100_000;draw++) {
    const sum=[0,0,0];
    for (let used=0;used<rows.length;used+=3) {
      state=(Math.imul(1664525,state)+1013904223)>>>0;
      const start=Math.floor(state/4294967296*(rows.length-2));
      for (let offset=0;offset<Math.min(3,rows.length-used);offset++) {
        for (let k=0;k<3;k++) sum[k]+=rows[start+offset][k];
      }
    }
    for (let k=0;k<3;k++) draws[k].push(sum[k]/rows.length);
  }
  return draws.map(draws=>{
    draws.sort((a,b)=>a-b);
    return {twoSided95:[draws[2499],draws[97499]],adjustedLower:draws[Math.floor(100_000*.05/(37*3))-1]};
  });
}

async function score(root:string,external:string,cohort:Cohort,live:boolean) {
  const {values,proofs,extra}=await preparePrices(root,external,cohort.eligible,live);
  const rows:TrainingRow[]=[];
  const missing:string[]=[];
  for (const row of cohort.eligible) {
    const up=agreeingCanadianOutcome(values.raw.get(row.day),values.splits.get(row.day));
    if (up===null) {missing.push(row.day);continue;}
    rows.push({id:"TLT:"+row.day,engineVersion:method,issuedAt:new Date(row.issue).toISOString(),
      labelKnownAt:new Date(row.close).toISOString(),features:row.features,up});
  }
  // Keep fold membership as pre-registered even if a quote is rejected.
  const split=chronologicalSplit(rows);
  const day=(r:TrainingRow)=>r.id.slice(4);
  assert(split.train.every(r=>day(r)<cohort.validationFrom));
  assert(split.validation.every(r=>day(r)>=cohort.validationFrom && day(r)<cohort.testFrom));
  assert(split.test.every(r=>day(r)>=cohort.testFrom));
  const combined=trainCandidate(rows,before);
  const control=trainCandidate(rows.map(r=>({...r,features:r.features.slice(0,2)})),before);
  if (combined.status!=="evaluated" || control.status!=="evaluated") throw Error("Source-backed cohort below the fixed historical minimum");
  const base=split.train.reduce((sum,r)=>sum+r.up,0)/split.train.length;
  const loss=(p:number,y:number)=>(p-y)**2;
  const comparison=split.test.map(r=>{
    const candidateLoss=loss(predict(combined.model,r.features),r.up);
    return [predict(control.model,r.features.slice(0,2)),base,0.5].map(p=>loss(p,r.up)-candidateLoss) as [number,number,number];
  });
  const uncertainty=decisionLossIntervals(comparison);
  const model=combined.candidateBrier;
  const baselines=[control.candidateBrier,combined.baseRateBrier,combined.coinBrier];
  const clear=combined.model.weights[2]>0 && baselines.every(x=>x-model>.01) && uncertainty.every(x=>x.adjustedLower>0);
  const result={method,before,cohort:pinnedCohort,scope:"registered private prelaunch international policy comparison",
    sourceOnly:cohort.eligible.length,strictDaily:cohort.strictEligible.length,paired:rows.length,
    train:split.train.length,validation:split.validation.length,test:split.test.length,
    additionalSingleDayReceipts:extra,missing,model,control:baselines[0],base:baselines[1],coin:baselines[2],
    easingCoefficient:combined.model.weights[2],clear,uncertainty,modelHash:combined.datasetHash,controlHash:control.datasetHash,
    inputHashes:proofs,reservation:digest(await readFile(resolve(root,"scoring-reservation.json")))};
  const path=resolve(root,"result.json");
  const existing=await readResearchReceipt<typeof result>(path);
  if (existing) assert.deepEqual(existing,result,"Sealed historical result changed");
  else await durableJSON(path,result,true);
  return result;
}

if (process.argv[1] && resolve(process.argv[1])===program) {
  const [root,external,mode]=process.argv.slice(2);
  if (!root || !external || !["--register","--evaluate","--cached"].includes(mode))
    throw Error("Usage: research-boc-decisions-tlt.ts private-root private-shared-root --register|--evaluate|--cached");
  const cohort=await freeze(resolve(root),mode==="--register");
  if (mode==="--register") console.log(JSON.stringify({method,sourceOnly:cohort.eligible.length,strict:cohort.strictEligible.length,cohort:pinnedCohort}));
  else {
    const result=await score(resolve(root),resolve(external),cohort,mode==="--evaluate");
    const {inputHashes,missing,...summary}=result;
    console.log(JSON.stringify({...summary,priceReceipts:inputHashes.length,missing:missing.length},null,2));
  }
}
