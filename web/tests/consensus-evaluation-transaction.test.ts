import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { commitEvaluationTransaction, recoverEvaluationTransaction, assertNoPendingEvaluation, assertEvaluationReleaseState, type EvaluationWrite } from "../lib/consensus/evaluation-transaction.ts";
import { rollbackActiveModel } from "../lib/consensus/model-rollback.ts";
import { verifyPublicationTree } from "../lib/consensus/history.ts";
import { digest } from "../lib/consensus/history.ts";
import { exchangeSession, exchangeSessions } from "../lib/consensus/exchange-calendar.ts";
import { missingSignals } from "../lib/consensus/registry.ts";

const writes: EvaluationWrite[] = [
  { path: "public/consensus/models/SPY-daily-test.json", value: {fixture:true}, immutable:true },
  { path: "public/consensus/outcomes.json", value: [{fixture:true}] },
  { path: "public/consensus/outcome-selection.json", value: {superseded:[]} },
  { path: "lib/consensus/models.json", value: {models:[]} },
  { path: "lib/consensus/performance.json", value: {resolved:1} },
];
for (const point of writes) test(`evaluation recovers after ${point.path} without re-evaluating a test window`, async () => {
  const root = await mkdtemp(join(tmpdir(), "tdc-evaluation-tx-"));
  try {
    await mkdir(join(root,"public/consensus/evaluations"),{recursive:true});
    await writeFile(join(root,"public/consensus/evaluations/reserved.json"),"reserved-window-must-not-change");
    await assert.rejects(commitEvaluationTransaction(root,writes,path=>{if(path===point.path)throw new Error("injected stop");}),/injected stop/);
    await assert.rejects(assertNoPendingEvaluation(root),/Incomplete evaluation/);
    await assert.rejects(verifyPublicationTree(root),/Incomplete evaluation/);
    assert.equal(await recoverEvaluationTransaction(root),true);
    assert.equal(await recoverEvaluationTransaction(root),false);
    await assertNoPendingEvaluation(root);
    for(const write of writes)assert.deepEqual(JSON.parse(await readFile(join(root,write.path),"utf8")),write.value);
    assert.equal(await readFile(join(root,"public/consensus/evaluations/reserved.json"),"utf8"),"reserved-window-must-not-change");
    assert.equal((await readdir(join(root,".consensus/evaluation-transactions"))).length,1);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("transaction recovery rejects intervening edits, unsafe paths, symlinks and immutable replacement",async()=>{
  const root=await mkdtemp(join(tmpdir(),"tdc-evaluation-conflict-"));
  try {
    await assert.rejects(commitEvaluationTransaction(root,[{path:"../escape.json",value:{}}]),/Unexpected/);
    await assert.rejects(commitEvaluationTransaction(root,writes,path=>{if(path===writes[0].path)throw new Error("stop");}),/stop/);
    await mkdir(join(root,"lib/consensus"),{recursive:true});
    await writeFile(join(root,"lib/consensus/models.json"),'{"intervening":true}');
    await assert.rejects(recoverEvaluationTransaction(root),/intervening file change/);
    await assert.rejects(readFile(join(root,"public/consensus/outcomes.json")),/ENOENT/);
    await rm(join(root,"lib/consensus/models.json"));
    await recoverEvaluationTransaction(root);
    await assert.rejects(commitEvaluationTransaction(root,[{...writes[0],value:{changed:true}}]),/Immutable/);
    await rm(join(root,"lib/consensus/models.json"));
    await symlink(join(root,"public/consensus/outcomes.json"),join(root,"lib/consensus/models.json"));
    await assert.rejects(commitEvaluationTransaction(root,[writes[3]]),/Symlink/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("the actual evaluator finishes a pending transaction and exits without fitting again",async()=>{
  const root=await mkdtemp(join(tmpdir(),"tdc-evaluation-resume-"));
  try {
    await cp(new URL("../lib",import.meta.url),join(root,"lib"),{recursive:true});
    await rm(join(root,"lib/consensus/evaluation-state.json"),{force:true}); // New synthetic fixture, not the production ledgers.
    await mkdir(join(root,"scripts"));
    await cp(new URL("../scripts/evaluate-consensus.ts",import.meta.url),join(root,"scripts/evaluate-consensus.ts"));
    await writeFile(join(root,"package.json"),'{"type":"module"}');
    await assert.rejects(commitEvaluationTransaction(root,writes,path=>{if(path===writes[0].path)throw new Error("stop");}),/stop/);
    const result=JSON.parse(execFileSync(process.execPath,["--experimental-strip-types","scripts/evaluate-consensus.ts"],{cwd:root,encoding:"utf8"}));
    assert.deepEqual(result,{status:"recovered_evaluation_transaction",retrained:false});
    await assertNoPendingEvaluation(root);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("the actual evaluator scores a covered date and records uncovered targets as pending in one run",async()=>{
  const root=await mkdtemp(join(tmpdir(),"tdc-mixed-calendar-evaluation-"));
  try {
    await cp(new URL("../lib",import.meta.url),join(root,"lib"),{recursive:true});
    await rm(join(root,"lib/consensus/evaluation-state.json"),{force:true}); // New synthetic fixture, not the production ledgers.
    await mkdir(join(root,"scripts"));await mkdir(join(root,"public/consensus/models"),{recursive:true});
    await cp(new URL("../scripts/evaluate-consensus.ts",import.meta.url),join(root,"scripts/evaluate-consensus.ts"));
    await writeFile(join(root,"package.json"),'{"type":"module"}');
    const index=[];
    for(const day of ["2026-11-02","2026-12-03"]){
      const at=`${day}T12:00:00.000Z`,base=missingSignals(at)[0];
      const snapshot={schemaVersion:1,origin:"prospective",engineVersion:"consensus-rules-2.0.0",id:at.replace(/[:.]/g,"-"),issuedAt:at,cutoff:at,
        signals:[{...base,id:"synthetic-rate",family:"rates",status:"available",series:[{date:"2026-10-30",value:1}],scores:{daily:.1,weekly:.1,monthly:.1},source:{...base.source,observedAt:"2026-10-30",sha256:"a".repeat(64)}}],catalysts:[],sourcesAttempted:1,collectionErrors:[]};
      index.push({id:snapshot.id,issuedAt:at,engineVersion:snapshot.engineVersion,sha256:digest(snapshot)});
      await writeFile(join(root,`public/consensus/${snapshot.id}.json`),JSON.stringify(snapshot));
    }
    await writeFile(join(root,"public/consensus/index.json"),JSON.stringify(index));
    await writeFile(join(root,"public/consensus/outcomes.json"),"[]");
    const dates=[...exchangeSessions("2026-11-02","2026-12-31"),"2027-01-04"];
    const prices=[{instrument:"SPY",source:"https://example.com/synthetic-fixture",adjustment:"total-return-adjusted",expectedSessions:dates,
      sessions:dates.map(day=>({... (day.startsWith("2026")?exchangeSession(day)!:{session:day,openAt:`${day}T14:30:00.000Z`,closeAt:`${day}T21:00:00.000Z`}),open:100,close:101}))}];
    await writeFile(join(root,"prices.json"),JSON.stringify(prices));
    execFileSync("git",["init","--quiet"],{cwd:root});
    const output=JSON.parse(execFileSync(process.execPath,["--experimental-strip-types","scripts/evaluate-consensus.ts","--prices",join(root,"prices.json")],{cwd:root,encoding:"utf8"}));
    assert.ok(output.resolved>=1);assert.ok(output.pending>=1);assert.equal(output.trained,0);
    const report=JSON.parse(await readFile(join(root,"lib/consensus/performance.json"),"utf8"));
    assert.ok(report.pending.some((row:{snapshotId:string;horizon:string})=>row.snapshotId.startsWith("2026-12-03")&&row.horizon==="monthly"));
    assert.ok(JSON.parse(await readFile(join(root,"public/consensus/outcomes.json"),"utf8")).some((row:{snapshotId:string;horizon:string})=>row.snapshotId.startsWith("2026-11-02")&&row.horizon==="daily"));
    for(const entry of index)assert.equal(digest(JSON.parse(await readFile(join(root,`public/consensus/${entry.id}.json`),"utf8"))),entry.sha256);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("remote release checks reject partial exports without a private journal and detect selectively omitted state",async()=>{
  const root=await mkdtemp(join(tmpdir(),"tdc-release-source-")), exported=await mkdtemp(join(tmpdir(),"tdc-release-export-"));
  try {
    await assert.rejects(assertEvaluationReleaseState(exported),/Missing evaluation release state/);
    await assert.rejects(commitEvaluationTransaction(root,writes,path=>{if(path===writes[1].path)throw new Error("stop");}),/stop/);
    await cp(join(root,"lib"),join(exported,"lib"),{recursive:true});
    await cp(join(root,"public"),join(exported,"public"),{recursive:true});
    await assert.rejects(readFile(join(exported,".consensus/evaluation-transaction.json")),/ENOENT/);
    await assert.rejects(assertEvaluationReleaseState(exported),/Incomplete evaluation release/);
    await assert.rejects(recoverEvaluationTransaction(exported),/Incomplete evaluation release/);
    await recoverEvaluationTransaction(root);
    await cp(join(root,"lib"),join(exported,"lib"),{recursive:true});
    await cp(join(root,"public"),join(exported,"public"),{recursive:true});
    await assertEvaluationReleaseState(exported);
    for(const path of ["public/consensus/outcomes.json","public/consensus/outcome-selection.json","lib/consensus/models.json","lib/consensus/performance.json"]){
      const before=await readFile(join(exported,path),"utf8");
      await writeFile(join(exported,path),JSON.stringify({unexpected:"uncommitted release state"}));
      await assert.rejects(assertEvaluationReleaseState(exported),/Evaluation release hash mismatch/);
      await writeFile(join(exported,path),before);
    }
    await assertEvaluationReleaseState(exported);
  }finally{await rm(root,{recursive:true,force:true});await rm(exported,{recursive:true,force:true});}
});

test("model deactivation writes an audit action and preserves prior forecasts, models and reservations",async()=>{
  const root=await mkdtemp(join(tmpdir(),"tdc-model-rollback-"));
  try {
    await mkdir(join(root,"lib/consensus"),{recursive:true});
    await mkdir(join(root,"public/consensus/models"),{recursive:true});
    const old={id:"SPY-daily-aaaaaaaaaaaaaaaa",instrument:"SPY",horizon:"daily",engineVersion:"consensus-rules-1.1.0"};
    await writeFile(join(root,"lib/consensus/models.json"),JSON.stringify({schemaVersion:1,models:[old],note:"fixture"}));
    await writeFile(join(root,"lib/consensus/performance.json"),JSON.stringify({generatedAt:"2026-11-01T00:00:00.000Z",learning:[{instrument:"SPY",horizon:"daily",activeModelId:old.id,promoted:true}],resolved:5,accuracy:.6}));
    const archive=join(root,`public/consensus/models/active-${old.id}.json`);await writeFile(archive,JSON.stringify(old));
    const result=await rollbackActiveModel(root,{instrument:"SPY",horizon:"daily",to:"none",reason:"Deactivate incompatible rules before a reviewed migration"});
    assert.equal(result.changed,true);assert.equal(result.modelId,null);
    assert.deepEqual(JSON.parse(await readFile(archive,"utf8")),old);
    const registry=JSON.parse(await readFile(join(root,"lib/consensus/models.json"),"utf8"));assert.deepEqual(registry.models,[]);
    const report=JSON.parse(await readFile(join(root,"lib/consensus/performance.json"),"utf8"));assert.equal(report.resolved,5);assert.equal(report.accuracy,.6);assert.equal(report.learning[0].activeModelId,null);assert.equal(report.learning[0].promoted,false);
    const actions=await readdir(join(root,"public/consensus/model-actions"));assert.equal(actions.length,1);
    assert.equal((await rollbackActiveModel(root,{instrument:"SPY",horizon:"daily",to:"none",reason:"Already inactive"})).changed,false);
    await assert.rejects(rollbackActiveModel(root,{instrument:"SPY",horizon:"daily",to:old.id,reason:"Wrong version test"}),/current engine and cohort/);
    assert.equal((await readdir(join(root,"public/consensus/model-actions"))).length,1);
  }finally{await rm(root,{recursive:true,force:true});}
});
