import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digest } from "../lib/consensus/history.ts";
import { SCORING_POLICY } from "../lib/consensus/evaluation.ts";
import { exchangeCalendarVersion, exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { ETF_CASH_SOURCES } from "../lib/consensus/corporate-adjustment.ts";
import { FIRST_RATE_SOURCE } from "../lib/consensus/firstrate.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";
import type { EvaluationReservation } from "../lib/consensus/learning-audit.ts";
import { COMPLETED_EVALUATIONS, EVALUATION_RELEASE_STATE, PRIVATE_OUTCOME_LEDGER, PUBLIC_OUTCOME_INDEX } from "../lib/consensus/outcome-ledger.ts";
import { PRIVATE_OUTCOME_AVAILABILITY } from "../lib/consensus/outcome-availability.ts";
import { durableJSON } from "../lib/publication-storage.ts";
import { familyTrainingPrefix, prospectiveFamilyPairCounts, prospectiveSelection } from "../lib/consensus/prospective-family-outcomes.ts";

type Inputs = Parameters<typeof prospectiveFamilyPairCounts>;
const stamp = "2026-11-24T11:00:00.000Z", witnessed = "2026-11-24T12:01:00.000Z", recorded="2026-11-24T12:02:00.000Z";
const after = "2026-11-24T21:01:00.000Z", day = "2026-11-24", engine = "consensus-rules-2.0.0";
const e = { id: "2026-11-24T12-00-00-000Z", cutoff:stamp, issuedAt:"2026-11-24T12:00:00.000Z",engineVersion:engine };
const identity = {snapshotId:e.id,instrument:"SPY",horizon:"daily",engineVersion:engine} as const;
const empty = {policy:SCORING_POLICY,superseded:[]};
const rule = "firstrate-five-session-momentum-v1";
const row = {id:rule,instrument:"SPY",family:"technicals",horizon:"daily",session:day,edition:e.id,
  eventId:"SPY/2026-11-23",observedThrough:"2026-11-23T21:00:00.000Z",availableAt:stamp,cutoff:stamp,issuedAt:e.issuedAt,witnessedAt:witnessed,recordedAt:recorded,
  sourceHashes:["c".repeat(64)],policySha256:"f".repeat(64),candidate:0.01,control:0.02} as const;
function features(rows: unknown[] = [row], edition = e.id, session = day): Inputs[0] {
  return {policySha256:row.policySha256,registeredAt:stamp,rows,missing:[],
    sessions:[{session,edition,status:"recorded",witnessedAt:witnessed,recordedAt:recorded,receipts:1}]} as unknown as Inputs[0];
}
type Fixture = Extract<Inputs[6], {clockSlots: unknown}>;
const forbidden: Fixture["readLabels"] = async () => { throw Error("Protected label reader invoked"); };
const neverRead: Fixture = {clockSlots:null, readLabels:forbidden};
const timely = "2026-11-24T21:00:45.000Z";
const fixture = (clocks: readonly string[] | null, readLabels = forbidden): Fixture => ({clockSlots:clocks,readLabels});
const reserved = (instrument: string, horizon: string, first: string, last: string) =>
  ({instrument,horizon,consumedThrough:last,testWindows:[{issuedAt:first,labelKnownAt:last}]}) as EvaluationReservation;

test("prospective uses the archive closed-session prefix and protects physical overlaps across horizons", () => {
  const a = Array.from({length:299},(_,i)=>({...e,issuedAt:new Date(Date.parse(stamp)+i).toISOString()}));
  assert.equal(familyTrainingPrefix(a,[],"SPY",e.issuedAt,after),"training_prefix");
  assert.equal(familyTrainingPrefix([...a,e],[],"SPY",e.issuedAt,after),"possible_validation_or_test");
  assert.equal(familyTrainingPrefix([...a,{...e,issuedAt:"2026-11-25T13:00:00.000Z"}],[],"SPY",e.issuedAt,after),"training_prefix");
  const monthly=reserved("SPY","monthly","2026-11-20T12:00:00.000Z","2026-12-21T21:00:00.000Z");
  assert.equal(familyTrainingPrefix([e],[monthly],"SPY",e.issuedAt,after),"reserved_window");
  assert.equal(familyTrainingPrefix([e],[monthly],"QQQ",e.issuedAt,after),"training_prefix");
  const later=reserved("SPY","weekly","2026-12-01T13:00:00.000Z","2026-12-07T21:00:00.000Z");
  assert.equal(familyTrainingPrefix([e],[later],"SPY",e.issuedAt,after),"consumed_window");
});

test("prospective counts all families and retrieves only selected, mature, unique source events with a true pre-open witness", async () => {
  const report=await prospectiveFamilyPairCounts(features([row,{...row}]),[e],[identity],empty,[],after,fixture([timely],async requests=>{
    assert.equal(requests.length,1);assert.deepEqual(requests[0].identity,identity);assert.equal(requests[0].closeAt,exchangeSession(day)!.closeAt);
    return new Map([[requests[0].slot,{status:"paired",up:1}]]);
  }));
  assert.equal(report.families.length,15); assert.equal(report.rules.length,6);
  assert.equal(report.paired,1);assert.equal(report.rules.find(r=>r.id===rule && r.instrument==="SPY")?.reasons.repeated_source_event,1);
  assert.equal(report.families.filter(f=>f.status==="no_registered_comparison").length,12);
  assert.ok(!JSON.stringify(report).includes(row.eventId)); assert.ok(!Object.hasOwn(report,"labels"));
  const waiting=await prospectiveFamilyPairCounts(features(),[e],[],empty,[],"2026-11-24T18:00:00.000Z",neverRead);
  assert.equal(waiting.mature,0); assert.equal(waiting.rules.find(r=>r.id===rule&&r.instrument==="SPY")?.reasons.awaiting_close,1);
  const missing=await prospectiveFamilyPairCounts(features(),[e],[],empty,[],after,neverRead);
  assert.equal(missing.mature,1);assert.equal(missing.prefixEligible,0);assert.equal(missing.paired,0);
  assert.equal(missing.rules.find(r=>r.id===rule&&r.instrument==="SPY")?.reasons.waiting_for_settlement,1);
  const excluded=await prospectiveFamilyPairCounts(features(),[e],[identity],empty,
    [reserved("SPY","weekly","2026-11-20T12:00:00.000Z",after)],after,neverRead);
  assert.equal(excluded.prefixEligible,0);
  await assert.rejects(()=>prospectiveFamilyPairCounts(features([{...row,recordedAt:after}]),[e],[identity],empty,[],after,neverRead),/pre-open/);
  await assert.rejects(()=>prospectiveFamilyPairCounts(features([{...row,availableAt:recorded}]),[e],[identity],empty,[],after,neverRead),/pre-open/);
  await assert.rejects(()=>prospectiveFamilyPairCounts({...features(),sessions:[]},[e],[identity],empty,[],after,neverRead),/pre-open/);
});

test("the host reader withholds a delayed, missing or future clock before opening any price file", async t => {
  const root = await mkdtemp(join(tmpdir(), "prospective-clock-window-"));
  t.after(() => rm(root, { recursive:true, force:true }));
  const tx = "30000000-0000-4000-8000-000000000000", index = [identity];
  for (const path of [".consensus/private-evaluation", COMPLETED_EVALUATIONS])
    await mkdir(join(root, path), {recursive:true, mode:0o700});
  await durableJSON(join(root, EVALUATION_RELEASE_STATE), {status:"complete", outcomeLedgerTransactionId:tx,
    hashes:{[PUBLIC_OUTCOME_INDEX]:digest(index)}});
  // No standalone private price ledger is created. Any attempted label access would fail this fixture.
  const opaque = ["sealed, intentionally unopened"], ledgerSha256 = digest(opaque);
  const save = async (at?: string) => {
    const writes: {path:string; value:unknown; after:string}[] = [
      {path:PUBLIC_OUTCOME_INDEX,value:index,after:digest(index)}, {path:PRIVATE_OUTCOME_LEDGER,value:opaque,after:ledgerSha256},
    ];
    if (at) {
      const clocks = {schemaVersion:1, ledgerSha256, knownAt:[at]};
      writes.push({path:PRIVATE_OUTCOME_AVAILABILITY,value:clocks,after:digest(clocks)});
      await durableJSON(join(root,PRIVATE_OUTCOME_AVAILABILITY),clocks);
    }
    await durableJSON(join(root,COMPLETED_EVALUATIONS,tx+".json"), {schemaVersion:1,id:tx,writes});
  };
  const edition = (at:string) => ({...e,id:at.replace(/[:.]/g,"-"),issuedAt:at,cutoff:at});
  const earlier = Array.from({length:298}, (_,i) => edition(new Date(Date.parse(stamp)+i).toISOString()));
  const later = edition(timely), archives = [...earlier, e, later];
  const audit = (history:typeof archives, holds:EvaluationReservation[]=[]) => prospectiveFamilyPairCounts(
    features(),history,index,empty,holds,after,{root, transaction:tx});
  const reasons = (report:Awaited<ReturnType<typeof audit>>) => report.rules.find(v=>v.id===rule && v.instrument==="SPY")!.reasons;
  await save();
  assert.deepEqual(reasons(await audit([e])), {awaiting_verified_label_clock:1});
  await save(after);
  assert.deepEqual(reasons(await audit([e])), {awaiting_verified_label_clock:1});
  await save("2026-11-24T22:10:00.000Z");
  assert.deepEqual(reasons(await audit([e])), {awaiting_verified_label_clock:1});
  await save(timely);
  const blocked = await audit(archives);
  assert.equal(blocked.mature,1);
  assert.equal(blocked.prefixEligible,0);
  assert.deepEqual(reasons(blocked), {possible_validation_or_test:1});
  const previous = exchangeSession(day)!.closeAt;
  assert.equal(familyTrainingPrefix(archives,[],"SPY",e.issuedAt,previous), "training_prefix");
  const weekly = reserved("SPY","weekly",timely,after);
  assert.equal(familyTrainingPrefix([e],[weekly],"SPY",e.issuedAt,previous), "consumed_window");
  assert.deepEqual(reasons(await audit([e],[weekly])), {reserved_window:1});
  await save("2026-11-24T20:59:59.000Z");
  await assert.rejects(audit([e]), /predates its exchange close/);

  // One millisecond before edition 300, a separately permitted, already witnessed label does pass.
  const before300 = new Date(Date.parse(timely)-1).toISOString();
  let requested = 0;
  const early = await prospectiveFamilyPairCounts(features(),archives,index,empty,[],after,fixture([before300],async requests => {
    requested += requests.length;
    return new Map([[requests[0].slot,{status:"paired",up:1}]]);
  }));
  assert.equal(requested,1);
  assert.equal(early.paired,1);
  const legacy = await prospectiveFamilyPairCounts(features(), [e], index, empty, [], after, forbidden);
  assert.deepEqual(reasons(legacy), {awaiting_verified_label_clock:1});
  const both = features([row,{...row,instrument:"QQQ",eventId:"QQQ/2026-11-23"}]);
  const mixed = await prospectiveFamilyPairCounts(both, archives, [{...identity,instrument:"QQQ"},identity], empty, [], after,
    fixture([before300,timely],async requests => {
      assert.deepEqual(requests.map(r=>[r.slot,r.identity.instrument]), [[0,"QQQ"]]);
      return new Map([[0,{status:"paired",up:0}]]);
    }));
  assert.equal(mixed.paired,1);
  assert.deepEqual(reasons(mixed), {possible_validation_or_test:1});
});

test("prospective rejects the last settled edition when a later pre-open archive owns the same window", async () => {
  const later={...e,id:"2026-11-24T12-30-00-000Z",issuedAt:"2026-11-24T12:30:00.000Z"};
  const report=await prospectiveFamilyPairCounts(features(),[e,later],[identity],empty,[],after,neverRead);
  assert.equal(report.rules.find(r=>r.id===rule && r.instrument==="SPY")?.reasons.superseded_edition,1);
  assert.throws(()=>prospectiveSelection([e,later],[identity,{...identity,snapshotId:later.id}],empty,after),/selection/);
  assert.throws(()=>prospectiveSelection([e],[identity],empty,recorded),/window/);
});

test("a second day repeating the same source event and a shortened trading day cannot consume another outcome", async () => {
  function next(date:string) {
    const move=(value:string)=>value.replace(day,date);
    const edition={...e,id:move(e.id),issuedAt:move(e.issuedAt),cutoff:move(e.cutoff)};
    const observation={...row,session:date,edition:edition.id,cutoff:edition.cutoff,issuedAt:edition.issuedAt,
      witnessedAt:move(row.witnessedAt),recordedAt:move(row.recordedAt)};
    const receipt={session:date,edition:edition.id,status:"recorded" as const,witnessedAt:observation.witnessedAt,
      recordedAt:observation.recordedAt,receipts:1};
    return {edition,observation,receipt};
  }
  const second=next("2026-11-25"), short=next("2026-11-27");
  const source=features([row,second.observation,{...short.observation,eventId:"next-independent-event"}]);
  const withSessions={...source,sessions:[...source.sessions,second.receipt,short.receipt]};
  const result=await prospectiveFamilyPairCounts(withSessions,[e,second.edition,short.edition],
    [identity,{...identity,snapshotId:second.edition.id},{...identity,snapshotId:short.edition.id}],empty,[],
    "2026-11-27T21:01:00.000Z",fixture([timely,timely.replace(day,"2026-11-25"),timely.replace(day,"2026-11-27")],async wanted=>{
      assert.deepEqual(wanted.map(r=>r.identity.snapshotId),[e.id]);
      return new Map([[wanted[0].slot,{status:"paired",up:0}]]);
    }));
  const ruleCounts=result.rules.find(v=>v.id===rule && v.instrument==="SPY")!;
  assert.equal(ruleCounts.paired,1);
  assert.deepEqual(ruleCounts.reasons,{repeated_source_event:1,short_session:1});
});

test("the private reader verifies complete transaction bytes and omits nonlicensed source rows", async t => {
  const root=await mkdtemp(join(tmpdir(),"prospective-pairs-")); t.after(()=>rm(root,{recursive:true,force:true}));
  const transaction="10000000-0000-4000-8000-000000000000";
  const ledgerPath=join(root,PRIVATE_OUTCOME_LEDGER), journal=join(root,COMPLETED_EVALUATIONS);
  await mkdir(join(root,".consensus/private-evaluation"),{recursive:true,mode:0o700});await mkdir(journal,{recursive:true,mode:0o700});
  const observations=[{...identity,source:"https://example.com/excluded",note:'space : and "quotation" stay in the hash'},
    {...identity,instrument:"QQQ",hiddenNumeric:1234.5}];
  const indexes=[identity,{...identity,instrument:"QQQ" as const}];
  const clocks={schemaVersion:1,ledgerSha256:digest(observations),knownAt:[timely,timely]};
  const saved={schemaVersion:1,id:transaction,writes:[{path:PRIVATE_OUTCOME_LEDGER,value:observations,before:null,after:digest(observations)},
    {path:PUBLIC_OUTCOME_INDEX,value:indexes,before:null,after:digest(indexes)},
    {path:PRIVATE_OUTCOME_AVAILABILITY,value:clocks,after:digest(clocks)}]};
  await durableJSON(join(root,PRIVATE_OUTCOME_AVAILABILITY),clocks);
  await durableJSON(join(root,EVALUATION_RELEASE_STATE),{status:"complete",outcomeLedgerTransactionId:transaction,hashes:{[PUBLIC_OUTCOME_INDEX]:digest(indexes)}});
  await writeFile(ledgerPath,JSON.stringify(observations,null,2)+"\n",{mode:0o600});
  await writeFile(join(journal,transaction+".json"),JSON.stringify(saved,null,2)+"\n",{mode:0o600});
  const audit=()=>prospectiveFamilyPairCounts(features(),[e],indexes,empty,[],after,{root,transaction});
  const result=await audit();assert.equal(result.paired,0);
  assert.equal(result.rules.find(r=>r.id===rule && r.instrument==="SPY")?.reasons.price_use_not_verified,1);
  await writeFile(ledgerPath,JSON.stringify([observations[0],{...observations[1],hiddenNumeric:4321}],null,2)+"\n");
  await assert.rejects(audit,/ledger changed/);
});

test("an authorized early training pair must match its native provider and exact frozen price contract", async t => {
  const root=await mkdtemp(join(tmpdir(),"prospective-verified-pair-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const tx="20000000-0000-4000-8000-000000000000";
  for (const d of [".consensus/private-evaluation",COMPLETED_EVALUATIONS,".consensus/private-firstrate"]) {
    await mkdir(join(root,d),{recursive:true,mode:0o700});
  }
  const clock=exchangeSession(day)!, indexes=[identity];
  const approval={schemaVersion:1,source:FIRST_RATE_SOURCE,from:day,through:day,approvedAt:timely,
    issuers:Object.entries(ETF_CASH_SOURCES).map(([symbol,source])=>({symbol,source,sha256:"a".repeat(64),capturedAt:timely,cash:[]})),
    symbols:[{symbol:"SPY",rows:[{...clock,open:100,close:101}],proof:{minuteRepairs:[]}}]};
  const put=async (path:string,value:unknown)=>writeFile(join(root,path),JSON.stringify(value,null,2)+"\n",{mode:0o600});
  await put(".consensus/private-firstrate/approved.json",{approval,sha256:digest(approval)});
  async function save(exit:number, entry=100) {
    const ledger=[{...identity,source:FIRST_RATE_SOURCE,adjustment:OUTCOME_PRICE_BASIS,calendarVersion:exchangeCalendarVersion(day,day),
      entryAt:clock.openAt,exitAt:clock.closeAt,issuedAt:e.issuedAt,entry,exit,returnPct:(exit/entry-1)*100}];
    await put(PRIVATE_OUTCOME_LEDGER,ledger);
    const clocks={schemaVersion:1,ledgerSha256:digest(ledger),knownAt:[timely]};
    await put(PRIVATE_OUTCOME_AVAILABILITY,clocks);
    await durableJSON(join(root,EVALUATION_RELEASE_STATE),{status:"complete",outcomeLedgerTransactionId:tx,hashes:{[PUBLIC_OUTCOME_INDEX]:digest(indexes)}});
    await put(join(COMPLETED_EVALUATIONS,tx+".json"),{schemaVersion:1,id:tx,writes:[
      {path:PRIVATE_OUTCOME_LEDGER,value:ledger,after:digest(ledger)},{path:PUBLIC_OUTCOME_INDEX,value:indexes,after:digest(indexes)},
      {path:PRIVATE_OUTCOME_AVAILABILITY,value:clocks,after:digest(clocks)}
    ]});
  }
  const audit=()=>prospectiveFamilyPairCounts(features(),[e],indexes,empty,[],after,{root,transaction:tx});
  await save(101);
  assert.equal((await audit()).paired,1);
  await save(99);
  await assert.rejects(audit,/Approved source disagrees/);
  await save(202,200);
  await assert.rejects(audit,/Approved source disagrees/);
});
