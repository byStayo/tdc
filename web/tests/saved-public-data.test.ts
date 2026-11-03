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
  assert.equal(spy.filings.fetchedAt,source.collectedAt);
  assert.ok(!JSON.stringify(saved).includes('official-document-excerpt'));
 } finally {globalThis.fetch=original;}
});
test('saved providers retain outage and age distinctions',()=>{
 const failed={...source,sources:source.sources.map((s:object)=>({...s,status:'unavailable',data:null}))};
 const empty=savedPublicContext(savedPublicData(failed),'SPY',at);
 assert.equal(empty.macro.status,'unavailable');assert.equal(empty.positioning.status,'unavailable');assert.equal(empty.filings.status,'unconfigured');
 const old=savedPublicContext(saved,'SPY','2027-01-01T12:00:00.000Z');
 assert.equal(old.filings.status,'stale');assert.equal(old.positioning.status,'stale');assert.equal(old.macro.status,'stale');
});
