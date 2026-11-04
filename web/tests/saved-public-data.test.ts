import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {savedPublicData,savedPublicContext} from '../lib/saved-public-data.ts';
const source=JSON.parse(await readFile(new URL('../public/reports/2026-11-03-041634Z-DIA-8a2b9f7ef092-evidence.json',import.meta.url),'utf8'));
const saved=savedPublicData(source), at='2026-11-03T15:00:00.000Z';

test('public workspace selects saved official facts without a network request or a new collection date',()=>{
 const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('Page read must not request a provider');};
 try {
  const spy=savedPublicContext(saved,'SPY',at),tlt=savedPublicContext(saved,'TLT',at),aapl=savedPublicContext(saved,'AAPL',at),other=savedPublicContext(saved,'ZZZZ',at);
  assert.equal(spy.macro.data.length,3);assert.equal(spy.positioning.data[0].contractCode,'13874A');assert.equal(tlt.positioning.data[0].contractCode,'020601');
  assert.equal(new Set(spy.filings.data.map(f=>f.cik)).size,3);
  assert.ok(aapl.filings.data.every(f=>f.cik==='0000320193'));
  assert.equal(other.filings.status,'unconfigured');assert.deepEqual(other.filings.data,[]);
  assert.equal(spy.filings.fetchedAt,saved.filings.map(issuer=>issuer.retrievedAt).sort()[0]);
  assert.ok(!JSON.stringify(saved).includes('official-document-excerpt'));
 } finally {globalThis.fetch=original;}
});
test('a later unrelated release review preserves provider retrieval dates and cannot revive stale SEC filings',()=>{
 const later='2026-11-10T15:00:00.000Z';
 const enriched={...source,collectedAt:later,sources:[...source.sources,{id:'BLS_JOLTS',kind:'bls',status:'ok',retrievedAt:later,data:{}}]};
 const laterSaved=savedPublicData(enriched),before=savedPublicContext(saved,'SPY',later),after=savedPublicContext(laterSaved,'SPY',later);
 assert.equal(after.macro.fetchedAt,before.macro.fetchedAt);
 assert.equal(after.positioning.fetchedAt,before.positioning.fetchedAt);
 assert.equal(after.filings.fetchedAt,before.filings.fetchedAt);
 assert.equal(after.filings.status,'stale');
 const mixed=structuredClone(laterSaved);mixed.filings[0].retrievedAt=later;
 assert.equal(savedPublicContext(mixed,'SPY',later).filings.status,'stale');
 assert.equal(savedPublicContext(mixed,mixed.filings[0].symbol,later).filings.status,'ok');
});
test('saved providers retain outage and age distinctions',()=>{
 const failed={...source,sources:source.sources.map((s:object)=>({...s,status:'unavailable',data:null}))};
 const empty=savedPublicContext(savedPublicData(failed),'SPY',at);
 assert.equal(empty.macro.status,'unavailable');assert.equal(empty.positioning.status,'unavailable');assert.equal(empty.filings.status,'unconfigured');
 const old=savedPublicContext(saved,'SPY','2027-01-01T12:00:00.000Z');
 assert.equal(old.filings.status,'stale');assert.equal(old.positioning.status,'stale');assert.equal(old.macro.status,'stale');
});

test('dated rate citations remain outside the three workspace panels and their retrieval age',()=>{
 const citations=['DGS2','DGS10','DGS30','SOFR','RRPONTSYD'].map(seriesId=>({
  id:`FRED_${seriesId}`,kind:'fred',status:'ok',retrievedAt:'2026-10-01T12:00:00.000Z',
  data:{seriesId,unit:seriesId==='RRPONTSYD'?'billions USD':'percent',frequency:'daily',sha256:'a'.repeat(64),observations:[{date:'2026-09-30',value:0},{date:'2026-10-01',value:null}]},
 }));
 const enriched=savedPublicData({...source,sources:[...source.sources,...citations]});
 assert.deepEqual(enriched,saved);
 assert.throws(()=>savedPublicData({...source,sources:[...source.sources,{...citations[0],data:{...citations[0].data,seriesId:'DGS10'}}]}),/editorial-only/);
 assert.throws(()=>savedPublicData({...source,sources:[...source.sources,{...citations[0],data:{...citations[0].data,sha256:'missing'}}]}),/editorial-only/);
 assert.throws(()=>savedPublicData({...source,sources:[...source.sources,{...citations[0],id:'FRED_UNKNOWN',data:{...citations[0].data,seriesId:'UNKNOWN'}}]}),/Unknown saved/);
});
