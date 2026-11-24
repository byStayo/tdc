import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { durableJSON } from "../lib/publication-storage.ts";
import { dealerStudy } from "../lib/consensus/dealer-study.ts";
import { collectDealerPositionsWithStudy, DEALER_DIRECTORY, DEALER_ROSTER, dealerBuckets, dealerPanelChanges, dealerTarget, replayDealerStudySources } from "../lib/consensus/dealer-study-sources.ts";
import { exchangeCalendarVersion, exchangeSession } from "../lib/consensus/exchange-calendar.ts";
import { digest } from "../lib/consensus/history.ts";
import { MARKET_HISTORY_SOURCE } from "../lib/consensus/market-history-settlement.ts";
import { recordPreopenReceipt } from "../lib/consensus/preopen-receipt.ts";
import { OUTCOME_PRICE_BASIS } from "../lib/consensus/price-basis.ts";
import { collectPrimaryDealerPositions } from "../lib/consensus/primary-dealer-positions.ts";
import { publisherSecondaryStudies } from "../lib/consensus/secondary-studies.ts";
import type { Signal, Snapshot } from "../lib/consensus/types.ts";

const history = "PDPOSGSC-G21", adjacent = "PDPOSGSC-G11L21";
const target = "2027-01-08", prior = "2026-12-23", current = "2026-12-30";
const received = "2027-01-07T21:15:06.000Z", issuedAt = target + "T13:00:00.000Z", edition = issuedAt.replace(/[:.]/g, "-");
const now = () => new Date().toISOString();
function raw(text: string) { return {text, retrievedAt: now(), sha256: createHash("sha256").update(text).digest("hex")}; }
const anchor = '<tr><td class="dirColL"><div>Oct 16, 2026</div></td><td class="dirColR"><a href="/newsevents/news/markets/2026/an261016p">NatWest Markets Securities Inc. has withdrawn its name, effective October 16, 2026.</a></td></tr>';
function roster(extra = "") { return '<div id="additions-and-removals"><table><thead>Additions and Removals</thead><tbody>' + extra + anchor + '</tbody></table></div>'; }
const addition = '<tr><td class="dirColL"><div>Dec 31, 2026</div></td><td class="dirColR"><a href="/newsevents/news/markets/2026/example">A dealer was added, effective December 28, 2026.</a></td></tr>';
function csv(week: string, large: number, change: number, nearby: number, nearbyChange: number) {
  return ['"As Of Date","Time Series","Value (millions)"', ...[[history,large], [history+"C",change], [adjacent,nearby], [adjacent+"C",nearbyChange]].map(
    ([key,value]) => [week,key,value].map(v => '"' + v + '"').join(","))].join("\n");
}
const previousCsv = csv(prior, 22002, 27, 31000, 350), currentCsv = csv(current, 21801, -201, 31430, 430);
async function fixture(t: TestContext) {
  t.mock.timers.enable({apis: ["Date"], now: Date.parse("2026-12-28T15:00:00Z")});
  const root = await mkdtemp(join(tmpdir(), "dealer-secondary-"));
  t.after(() => rm(root, {recursive:true,force:true}));
  return {root, dir: join(root, DEALER_DIRECTORY)};
}
const set = (t: TestContext, date: string) => t.mock.timers.setTime(Date.parse(date));
async function collect(dir: string, latest: boolean, panel = () => roster(), table = latest ? currentCsv : previousCsv) {
  const series = (latest ? [["2026-12-16",21975],[prior,22002],[current,21801]] : [["2026-12-16",21975],[prior,22002]]).map(([asofdate,value]) => ({asofdate, keyid:history, value:String(value)}));
  return collectDealerPositionsWithStudy(async url => raw(url === DEALER_ROSTER ? panel() :
    url.endsWith(".csv") ? table : JSON.stringify({pd:{timeseries:series}})), dir, now);
}
async function published(root: string, signal: Signal) {
  const s: Snapshot = {schemaVersion:1, origin:"prospective", id:edition, issuedAt, cutoff:issuedAt, engineVersion:"consensus-rules-2.0.0",
    signals:[signal], catalysts:[], sourcesAttempted:1, collectionErrors:[]};
  const index = Buffer.from(JSON.stringify([{id:edition,issuedAt,engineVersion:s.engineVersion,sha256:digest(s)}]));
  const dir = join(root,"public/consensus"), bytes = Buffer.from(JSON.stringify(s));
  await mkdir(dir,{recursive:true}); await writeFile(join(dir,edition+".json"),bytes); await writeFile(join(dir,"index.json"),index);
  await writeFile(join(dir,"outcomes.json"),"[]");
  await recordPreopenReceipt(root,target,edition,bytes,index,target+"T13:02:00.000Z");
}

test("official bucket identities, suppression, effective roster dates and first observed 07:48 target", () => {
  assert.deepEqual(dealerBuckets(currentCsv,current),{long:21801,longChange:-201,adjacent:31430,adjacentChange:430});
  for (const changed of [currentCsv + "\n" + currentCsv.split("\n")[2],currentCsv.replace("430","n/a"),currentCsv.replace(adjacent,"other"),
    currentCsv.replace("millions","thousands"),currentCsv.replace(current,prior)]) assert.throws(() => dealerBuckets(changed,current));
  assert.deepEqual(dealerPanelChanges(roster(addition)), ["2026-12-28","2026-10-16"]);
  for (const html of [roster(addition.replace("effective","effective TBD on")), roster(addition.replace("was added","may change")),
    roster().replace("NatWest","Unknown"), roster().replace("additions-and-removals","names")]) assert.throws(() => dealerPanelChanges(html));
  assert.deepEqual(dealerTarget(current, received), {session:target,cutoff:target+"T12:48:00.000Z"});
  assert.equal(dealerTarget(current, target+"T12:48:00.000Z")?.session,"2027-01-11");
  assert.equal(dealerTarget(current,"2027-01-16T12:00:00.000Z"),null);
  assert.equal(dealerTarget(current,"2027-01-01T12:00:00.000Z"),null);
  assert.equal(dealerTarget("2026-11-18","2026-11-26T21:00:00.000Z")?.session,"2026-11-30");
});

test("a separately retained pre-installation week can supply only the preceding balance", async t => {
  const {dir} = await fixture(t);
  set(t,"2026-12-31T21:16:00.000Z");
  const levels = [["2026-12-16",21975],[prior,22002]].map(([asofdate,value]) => ({asofdate,keyid:history,value:String(value)}));
  const old = await collectPrimaryDealerPositions(async url => raw(url.endsWith(".csv") ? previousCsv :
    JSON.stringify({pd:{timeseries:levels}})),dir,now);
  assert.equal(old.status,"available");
  await assert.rejects(readFile(join(dir,"study-weeks",prior+".json")),{code:"ENOENT"});
  set(t,received);
  const next = await collect(dir,true);
  const rawPrior = JSON.parse(await readFile(join(dir,"study-weeks",prior+".json"),"utf8"));
  assert.equal(rawPrior.nativeAt,old.source.vintageAt);
  assert.equal(rawPrior.sourceSha,old.source.sha256);
  const pair = await replayDealerStudySources(dir,next,target,issuedAt);
  assert.ok(pair);
  assert.deepEqual([pair.candidate,pair.control,pair.nativeAt],[.201,.43,received]);
});

test("registered future release replays unchanged native bytes through original pre-open and only first permitted TLT settlement", async t => {
  const {root,dir} = await fixture(t);
  assert.equal(publisherSecondaryStudies.find(s=>s.name==="institutions")?.study,dealerStudy);
  await dealerStudy.register(root);
  set(t,"2026-12-31T21:16:00.000Z");
  await collect(dir,false,() => { throw Error("No earlier weekly level should request a roster"); });
  set(t,received);
  let requests = 0;
  const getRoster = () => { requests++; return roster(); };
  const signal = await collect(dir,true,getRoster);
  assert.equal(signal.status,"available");
  assert.deepEqual(signal.scores,{daily:null,weekly:null,monthly:null});
  set(t,"2027-01-07T23:00:00.000Z");
  await collect(dir,true,getRoster);
  assert.equal(requests,1);
  const pair = await replayDealerStudySources(dir,signal,target,issuedAt);
  assert.ok(pair); assert.deepEqual([pair.candidate,pair.control,pair.nativeAt],[.201,.430,received]);
  assert.equal(await replayDealerStudySources(dir,signal,"2027-01-11","2027-01-11T13:00:00.000Z"),null);
  set(t,target+"T13:03:00.000Z"); await published(root,signal);
  set(t,target+"T13:05:00.000Z");
  assert.equal((await dealerStudy.enroll(root,target,edition)).enrolled,1);
  assert.equal((await dealerStudy.enroll(root,target,edition)).enrolled,1);
  const eventRoot = join(root,dirname(dealerStudy.registrationPath),"TLT");
  const event = JSON.parse(await readFile(join(eventRoot,"events",edition+".json"),"utf8")).value;
  assert.deepEqual([event.id,event.sourceReleasedAt,event.sourceSeal,event.candidate,event.control,event.phase,event.prediction],
    ["nyfed:fr2004a:"+current,received,pair.sourceSeal,.201,.43,"train",null]);
  set(t,target+"T21:05:00.000Z");
  const tx = "bbbbbbbb-1111-4222-8333-444444444444", clock = exchangeSession(target)!;
  await durableJSON(join(root,".consensus/evaluation-transaction.json"),{schemaVersion:1,id:tx,synthetic:true},true);
  let opened = 0;
  const row = { snapshotId:edition, instrument:"TLT" as const, horizon:"daily" as const, issuedAt, entryAt:clock.openAt, exitAt:clock.closeAt,
    source:MARKET_HISTORY_SOURCE, adjustment:OUTCOME_PRICE_BASIS, calendarVersion:exchangeCalendarVersion(target,target),
    direction:() => {opened++;return 0 as const;} };
  const issues = [{id:edition,issuedAt}];
  await dealerStudy.stage(root,tx,[{...row,instrument:"SPY"},{...row,source:"guest"},{...row,horizon:"weekly"}],issues,[]);
  await dealerStudy.stage(root,tx,[row],[...issues,{id:"later",issuedAt:target+"T14:00:00.000Z"}],[]);
  await dealerStudy.stage(root,tx,[row],issues,[{instrument:"TLT",reservedAt:target+"T13:04:00.000Z",consumedThrough:issuedAt,testWindows:[]}]);
  assert.equal(opened,0);
  await dealerStudy.stage(root,tx,[row],issues,[]); await dealerStudy.stage(root,tx,[row],issues,[]);
  assert.equal(opened,1);
  assert.equal(JSON.parse(await readFile(join(eventRoot,"admissions",edition+".json"),"utf8")).value.source,MARKET_HISTORY_SOURCE);
});

for (const failure of ["missing-prior","revised-adjacent","roster-change","unknown-roster","late-roster","old-input","native-corruption"]) {
  test("private dealer comparison rejects " + failure + " and preserves the public context", async t => {
    const {root,dir} = await fixture(t);
    if (failure !== "old-input") await dealerStudy.register(root);
    set(t,"2026-12-31T21:16:00.000Z");
    if (failure !== "missing-prior") await collect(dir,false);
    set(t,received);
    const signal = await collect(dir,true,() => {
      if (failure === "late-roster") set(t,target+"T12:48:00.000Z");
      return failure === "roster-change" ? roster(addition) : failure === "unknown-roster" ? "<html/>" : roster();
    },failure === "revised-adjacent" ? currentCsv.replace('"430"','"431"') : currentCsv);
    if (failure === "old-input") { set(t,"2027-01-07T22:00:00.000Z"); await dealerStudy.register(root); }
    if (failure === "native-corruption") {
      const p=join(dir,digest(signal.series)+".json"),v=JSON.parse(await readFile(p,"utf8"));
      v.weekly.text=v.weekly.text.replace("31430","31431");await durableJSON(p,v);
    }
    assert.equal(signal.status,"available");
    set(t,target+"T13:03:00.000Z"); await published(root,signal);
    set(t,target+"T13:05:00.000Z");
    if (failure === "native-corruption") await assert.rejects(dealerStudy.enroll(root,target,edition),/differs/);
    else assert.equal((await dealerStudy.enroll(root,target,edition)).enrolled,0);
  });
}

test("a first release with a suppressed control reserves its week before a later revision changes both buckets", async t => {
  const {dir} = await fixture(t);
  set(t,"2026-12-31T21:16:00.000Z"); await collect(dir,false);
  set(t,received);
  let rosterRequests = 0;
  const request = () => {rosterRequests++;return roster();};
  const first = await collect(dir,true,request,currentCsv.replace('"430"','"*"'));
  assert.equal(first.status,"available");
  set(t,"2027-01-07T22:00:00.000Z");
  const revised = await collectDealerPositionsWithStudy(async url => raw(url === DEALER_ROSTER ? request() :
    url.endsWith(".csv") ? csv(current,21802,-200,31430,430) :
      JSON.stringify({pd:{timeseries:[{asofdate:prior,keyid:history,value:"22002"},{asofdate:current,keyid:history,value:"21802"}]}})),dir,now);
  assert.ok(revised.source.sha256 && revised.source.sha256 !== first.source.sha256);
  assert.equal(await replayDealerStudySources(dir,revised,target,issuedAt),null);
  assert.equal(rosterRequests,0);
});
