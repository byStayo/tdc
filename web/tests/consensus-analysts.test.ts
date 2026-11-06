import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ANALYST_ID,ANALYST_LICENSE,ANALYST_URL,collectAnalystRatings,parseAnalystRatings,refreshAnalystRatings,validateAnalystRatings} from '../lib/consensus/analyst-ratings.ts';
import {freezeConsensus,asIssuedConsensus} from '../lib/consensus/as-issued.ts';
import {observationDigest,validateSnapshot} from '../lib/consensus/history.ts';
import {INSTRUMENTS,HORIZONS,type Snapshot} from '../lib/consensus/types.ts';
import {retainLastKnown} from '../lib/consensus/last-known.ts';
import {SourceTransportError} from '../lib/consensus/source-failure.ts';
import {collectSnapshot} from '../lib/consensus/collector.ts';
const text=await readFile(new URL('./fixtures/quantisnow-analyst-ratings-2026-11-06.json',import.meta.url),'utf8');
const at='2026-11-06T17:00:00.000Z',later='2026-11-07T17:00:00.000Z';
const doc=(body=text,retrievedAt=at)=>({text:body,retrievedAt,sha256:createHash('sha256').update(body).digest('hex')});
const read=async()=>doc();
const prior:Snapshot=JSON.parse(await readFile(new URL('../public/consensus/2026-11-06T13-14-19-532Z.json',import.meta.url),'utf8'));
test('real monthly analyst counts distinguish closed October from incomplete November',async()=>{
 const parsed=parseAnalystRatings(text,at);assert.equal(parsed.updatedAt,'2026-11-06T06:15:37.000Z');
 assert.deepEqual(parsed.months.at(-1)!.values,{upgrades:66,downgrades:98,initiations:31,reiterations:8,total:203,ratio:66/98});
 const s=await collectAnalystRatings(read,()=>at);validateAnalystRatings(s);assert.equal(s.status,'available');
 assert.equal(s.series.at(-1)!.date,'2026-10-31');assert.ok(Math.abs(s.series.at(-1)!.value-263/558*100)<1e-12);
 assert.match(s.summary,/2026-10 full month: 263 upgrades and 295 downgrades/);assert.match(s.summary,/2026-11 month to date: 66 upgrades and 98 downgrades/);
 assert.deepEqual(s.instruments,['MARKET']);assert.deepEqual(s.directionalInstruments,[]);assert.ok(Object.values(s.scores).every(x=>x===null));assert.ok(s.source.usage.includes(ANALYST_LICENSE));
});
test('licence removal, future or impossible clocks, false periods and inconsistent counts fail closed',()=>{
 for(const edit of [
  (x:any)=>x.license='personal use only',(x:any)=>x.updatedAt='2026-11-07 06:15:37',
  (x:any)=>x.updatedAt='2026-02-31 06:15:37',(x:any)=>x.months[0].month='2026-13',
  (x:any)=>x.months.at(-1).monthToDate=false,(x:any)=>x.months[0].values.upgrades=-1,
  (x:any)=>x.months[0].values.total++,(x:any)=>x.months[0].values.ratio+=1,
  (x:any)=>x.months[0].breakdown[0].values.total++,(x:any)=>x.months.push(x.months[0]),
  (x:any)=>x.months=x.months.filter((r:any)=>r.month!=='2026-10'),
 ]){const x=JSON.parse(text);edit(x);assert.throws(()=>parseAnalystRatings(JSON.stringify(x),at));}
});
test('zero-downgrade sector sentinel is validated without inventing infinite ratios',()=>{
 const x=JSON.parse(text),sector=x.months.at(-1).breakdown.find((x:any)=>x.values.downgrades===0);assert.ok(sector);assert.equal(sector.values.ratio,0);
 sector.values.ratio=1;assert.throws(()=>parseAnalystRatings(JSON.stringify(x),at));
});
test('bad response provenance and unavailable data never become neutral observations',async()=>{
 for(const invalid of [{...doc(),sha256:'0'.repeat(64)},doc(text,later),doc('{}')]){
 const s=await collectAnalystRatings(async()=>invalid,()=>at);assert.equal(s.status,'unavailable');assert.deepEqual(s.series,[]);assert.equal(s.source.observedAt,null);assert.equal(s.failureKind,'validation');}
});
test('saved licence, scope, units, partial-period dates and arithmetic are enforced',async()=>{
 const good=await collectAnalystRatings(read,()=>at);
 for(const edit of [
  (x:any)=>x.instruments.push('SPY'),(x:any)=>x.scores.daily=.5,(x:any)=>x.source.attribution='',
  (x:any)=>x.source.frequency='daily',(x:any)=>x.metrics[0].unit='dollars',
  (x:any)=>x.metrics.at(-1).date='2026-11-30',(x:any)=>x.metrics[0].value++,
  (x:any)=>x.metrics=[],(x:any)=>x.series.at(-1).value+=5,
 ]){const bad=structuredClone(good);edit(bad);assert.throws(()=>validateAnalystRatings(bad));}
});
test('scoped addition preserves previous sources and every directional reading',async()=>{
 const original=JSON.stringify(prior),next=freezeConsensus(await refreshAnalystRatings(prior,read,()=>at));validateSnapshot(next);
 assert.equal(JSON.stringify(prior),original);assert.deepEqual(next.signals.filter(s=>s.id!==ANALYST_ID),prior.signals);
 for(const sym of INSTRUMENTS)for(const h of HORIZONS){const a=asIssuedConsensus(prior,sym,h),b=asIssuedConsensus(next,sym,h);assert.equal(b.score,a.score);assert.equal(b.directionalCoverage,a.directionalCoverage);assert.equal(b.abstain,true);}
 assert.equal(next.signals.find(s=>s.id==='analyst-revisions')!.status,'unavailable');
});
test('retrieval-only refresh is not a new observation; transport fallback preserves original age',async()=>{
 const one=freezeConsensus(await refreshAnalystRatings(prior,read,()=>at));
 const two=freezeConsensus(await refreshAnalystRatings(one,async()=>doc(text,later),()=>later));assert.equal(observationDigest(one),observationDigest(two));
 const bad=await refreshAnalystRatings(one,async()=>{throw new SourceTransportError('offline')},()=>later);
 const retained=retainLastKnown(bad,one).signals.find(s=>s.id===ANALYST_ID)!;assert.equal(retained.source.retrievedAt,at);assert.equal(retained.source.observedAt,'2026-11-06T06:15:37.000Z');
});
test('full and scoped collectors retain a stable tail order with no extra ETF coverage',async()=>{
 const full=await collectSnapshot(async(url)=>url===ANALYST_URL?new Response(text):new Response('unavailable',{status:503}));
 const scoped=await refreshAnalystRatings(prior,read,()=>at);const tail=(s:Snapshot)=>s.signals.filter(x=>x.id===ANALYST_ID||x.id.startsWith('twse-')||x.id==='fed-private-credit-loans').map(x=>x.id);
 assert.deepEqual(tail(full),tail(scoped));assert.equal(full.signals.find(s=>s.id===ANALYST_ID)!.status,'available');
});
