import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ANALYST_ID,ANALYST_LICENSE,ANALYST_URL,collectAnalystRatings,parseAnalystRatings,refreshAnalystRatings,validateAnalystRatings} from '../lib/consensus/analyst-ratings.ts';
import {freezeConsensus,asIssuedConsensus} from '../lib/consensus/as-issued.ts';
import {digest,observationDigest,validateSnapshot} from '../lib/consensus/history.ts';
import {INSTRUMENTS,HORIZONS,type Snapshot} from '../lib/consensus/types.ts';
import {retainLastKnown} from '../lib/consensus/last-known.ts';
import {SourceTransportError} from '../lib/consensus/source-failure.ts';
import {collectSnapshot,publicText} from '../lib/consensus/collector.ts';
import { effectiveStatus } from '../lib/consensus/engines/v2.ts';
const text=await readFile(new URL('./fixtures/quantisnow-analyst-ratings-2026-11-06.json',import.meta.url),'utf8');
const at='2026-11-06T17:00:00.000Z',later='2026-11-07T17:00:00.000Z';
const doc=(body=text,retrievedAt=at)=>({text:body,retrievedAt,sha256:createHash('sha256').update(body).digest('hex')});
const read=async()=>doc();
const months: ReturnType<typeof parseAnalystRatings>['months'] = JSON.parse(text).months;
const csv = (rows = months) => ['month,month_to_date,upgrades,downgrades,ratio,initiations,reiterations,total',
  ...rows.map(m => [m.month,m.monthToDate,m.values.upgrades,m.values.downgrades,m.values.ratio,
    m.values.initiations,m.values.reiterations,m.values.total].join(','))].join('\n') + '\n';
const readWith = (alternate: string, challenge = true, primary = '', status = 403) => async (url: string) =>
  url === ANALYST_URL ? publicText(url, async () => new Response(primary, { status,
    headers: challenge ? { 'cf-mitigated': 'challenge', 'content-type': 'text/html; charset=utf-8' } : {} })) : doc(alternate,later);
const signal = (s: Snapshot) => s.signals.find(row => row.id === ANALYST_ID)!;
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
  // An older month incorrectly marked partial must fail independently of the latest-closed check.
  (x:any)=>x.months[0].monthToDate=true,
  // Preserve global totals and sector sums, isolating the sector's impossible sub-total.
  (x:any)=>{const m=x.months[0],v=m.values,c=m.breakdown[0].values;const delta=c.total-c.upgrades-c.downgrades+1;c.upgrades+=delta;c.ratio=c.downgrades?c.upgrades/c.downgrades:0;v.upgrades+=delta;v.initiations-=delta;v.ratio=v.upgrades/v.downgrades;},
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
  (x:any)=>x.directionalInstruments=['MARKET'],(x:any)=>x.source.usage='',
  (x:any)=>x.status='unavailable',
  // End-of-month date isolates the closed-month-only chart rule in this validator.
  (x:any)=>x.series.push({date:'2026-11-30',value:50}),
  // Keep its date internally aligned with a partial label, exposing a wrong month label.
  (x:any)=>{for(const m of x.metrics.filter((m:any)=>m.label.startsWith('2026-10'))){m.label=m.label.replace('full month','month to date');m.date='2026-11-06';}},
  // Intentionally invalid saved payload: a third closed group with internally matching arithmetic.
  (x:any)=>{const extra=x.metrics.slice(0,5).map((m:any)=>({...m,label:m.label.replace('2026-09','2026-08'),date:'2026-08-31'}));x.metrics.push(...extra);x.series.unshift({date:'2026-08-31',value:206/(206+205)*100});},
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

test('a challenged JSON refresh retains the original analyst observation only if the provider CSV confirms every published figure', async () => {
 const original = await refreshAnalystRatings(prior, read, () => at);
 const previous = original.signals.find(s => s.id === ANALYST_ID)!;
 const refreshed = await refreshAnalystRatings(original,readWith(csv()),()=>later);
 const confirmed = signal(refreshed);
 assert.equal(confirmed.status,'available');
 assert.deepEqual(confirmed.source,previous.source);
 assert.deepEqual(confirmed.series,previous.series);
 assert.deepEqual(confirmed.metrics,previous.metrics);
 assert.deepEqual(confirmed.scores,{daily:null,weekly:null,monthly:null});
 assert.match(confirmed.collectionNote!,/CSV/);
 assert.equal(observationDigest(original),observationDigest(refreshed));
 assert.equal(effectiveStatus(confirmed,'2026-11-14T17:00:00.000Z'),'stale');
 const revised=structuredClone(months);
 const last=revised.at(-1)!.values; last.upgrades++;last.total++;last.ratio=last.upgrades/last.downgrades;
 const revisedHistory=structuredClone(months);
 const first=revisedHistory[0].values; first.upgrades++;first.total++;first.ratio=first.upgrades/first.downgrades;
 const badPrimary=JSON.parse(text);badPrimary.license='personal use only';
 for(const readSource of [readWith(csv(revised)),readWith(csv(revisedHistory)),readWith(csv(months.slice(1))),
   readWith(csv().replace('0.','2.')),readWith(csv()+'\n'+csv()),readWith('<!doctype html>'),readWith(csv(),false),
   readWith(csv(),false,JSON.stringify(badPrimary),200)]) {
   const rejected=signal(await refreshAnalystRatings(original,readSource,()=>later));
   assert.equal(rejected.status,'unavailable');assert.deepEqual(rejected.metrics,[]);
 }
 const full=await collectSnapshot(async url => url===ANALYST_URL?new Response('Challenge',{status:403,headers:{'content-type':'text/html','cf-mitigated':'challenge'}})
   :url===ANALYST_URL.replace('.json','.csv')?new Response(csv()):new Response('offline',{status:503}),original);
 assert.deepEqual(signal(full).source,previous.source);
});

test('an unavailable current edition recovers only its newest fresh, hash-verified original with matching CSV', async t => {
 const root=await mkdtemp(join(tmpdir(),'daily-consensus-analyst-history-'));
 try {
  const archive=join(root,'public/consensus'), current=join(root,'lib/consensus/current.json');
  await mkdir(archive,{recursive:true});await mkdir(join(root,'lib/consensus'),{recursive:true});
  async function store(items: Snapshot[]) {
   await writeFile(join(archive,'index.json'),JSON.stringify(items.map(s=>({
    id:s.id,issuedAt:s.issuedAt,sha256:digest(s),engineVersion:s.engineVersion
   }))));
   for(const s of items) await writeFile(join(archive,s.id+'.json'),JSON.stringify(s));
   await writeFile(current,JSON.stringify(items.at(-1)));
  }
  const original=freezeConsensus(await refreshAnalystRatings(prior,read,()=>at));
  const gapAt='2026-11-06T21:00:00.000Z';
  const gap=freezeConsensus(await refreshAnalystRatings(original,async()=>doc('{}',gapAt),()=>gapAt));
  assert.equal(signal(gap).status,'unavailable');
  await store([original,gap]);
  const recover=(now=later)=>refreshAnalystRatings(gap,readWith(csv()),()=>now,root);
  const restored=signal(await recover());
  assert.equal(restored.status,'available');assert.deepEqual(restored.source,signal(original).source);assert.deepEqual(restored.metrics,signal(original).metrics);
  t.mock.timers.enable({apis:['Date'],now:Date.parse(later)});
  const full=await collectSnapshot(async url=>url===ANALYST_URL?new Response('Challenge',{status:403,headers:{'content-type':'text/html','cf-mitigated':'challenge'}})
    :url===ANALYST_URL.replace('.json','.csv')?new Response(csv()):new Response('offline',{status:503}),gap,undefined,undefined,root);
  assert.deepEqual(signal(full).source,signal(original).source);
  t.mock.timers.reset();
  assert.equal(signal(await recover('2026-11-14T17:00:00.000Z')).status,'unavailable');
  assert.equal(signal(await refreshAnalystRatings({...gap,collectionErrors:['different base']},readWith(csv()),()=>later,root)).status,'unavailable');
  await writeFile(join(archive,original.id+'.json'),JSON.stringify({...original,collectionErrors:['archive altered']}));
  assert.equal(signal(await recover()).status,'unavailable');
  const revision=JSON.parse(text), currentMonth=revision.months.at(-1);
  currentMonth.values.initiations++;currentMonth.values.total++;currentMonth.breakdown[0].values.total++;
  const revisedAt='2026-11-06T19:00:00.000Z'; revision.updatedAt='2026-11-06 18:15:37';
  const revised=freezeConsensus(await refreshAnalystRatings(original,async()=>doc(JSON.stringify(revision),revisedAt),()=>revisedAt));
  await store([original,revised,gap]);
  assert.equal(signal(await recover()).status,'unavailable');
 } finally {await rm(root,{recursive:true,force:true});}
});
