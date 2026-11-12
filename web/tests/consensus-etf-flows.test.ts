import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseEtfFlows, collectEtfFlows, refreshEtfFlows, validateEtfFlows, ETF_FLOW_URL } from '../lib/consensus/etf-flows.ts';
import { collectSnapshot } from '../lib/consensus/collector.ts';
import { validateSnapshot, observationDigest } from '../lib/consensus/history.ts';
import { freezeConsensus } from '../lib/consensus/as-issued.ts';
import { retainLastKnown } from '../lib/consensus/last-known.ts';
import { SourceTransportError } from '../lib/consensus/source-failure.ts';
import type { Snapshot } from '../lib/consensus/types.ts';

const at = '2026-11-10T04:00:00.000Z';
import { fixture } from './fixtures/etf-flows.ts';
const document = (raw=fixture(), retrievedAt=at) => {
  const text=JSON.stringify(raw);return {text,retrievedAt,sha256:createHash('sha256').update(text).digest('hex')};
};
const prior = JSON.parse(await readFile(new URL('../public/consensus/2026-11-06T17-01-48-890Z.json',import.meta.url),'utf8')) as Snapshot;

test('daily flows distinguish positive, negative, real zero, held and absent observations',async()=>{
  const parsed=parseEtfFlows(JSON.stringify(fixture()),at);assert.equal(parsed.asOf,'2026-11-06');
  const signals=await collectEtfFlows(async()=>document(),()=>at);
  assert.equal(signals.length,6);
  for(const signal of signals) validateEtfFlows(signal);
  assert.equal(signals.find(s=>s.id==='etfiq-flow-QQQ')!.series[0].value,100_000_000);
  assert.equal(signals.find(s=>s.id==='etfiq-flow-IWM')!.series[0].value,-40_000_000);
  assert.equal(signals.find(s=>s.id==='etfiq-flow-TLT')!.series[0].value,0);
  for(const ticker of ['SPY','DIA']) {const s=signals.find(s=>s.id===`etfiq-flow-${ticker}`)!;assert.equal(s.status,'unavailable');assert.deepEqual(s.series,[]);}
  assert.match(signals.find(s=>s.id==='etfiq-flow-SPY')!.summary,/held/i);
  assert.match(signals.find(s=>s.id==='etfiq-flow-DIA')!.summary,/not included/i);
  for(const s of signals){assert.deepEqual(s.directionalInstruments,[]);assert.ok(Object.values(s.scores).every(v=>v===null));}
  const json=JSON.stringify(signals);
  assert.doesNotMatch(json,/startNetAssetsUsd|startNetAssetsDate|10000000000|sharesOutstanding|"nav"/);
  assert.equal(signals.find(s=>s.id==='etfiq-flow-MARKET')!.series[0].value,60_000_000);
});

test('invalid licence, future dates, duplicated funds, wrong basis, arithmetic and held observations fail closed',()=>{
  const edits=[
    (x:any)=>x.cite.license='https://example.com/personal', (x:any)=>x.cite.publisher='Other',
    (x:any)=>x.cite.as_of='2026-11-05', (x:any)=>x.asOf='2026-11-11',
    (x:any)=>x.window.to='2026-11-05', (x:any)=>x.window.days=2,
    (x:any)=>x.funds.push(x.funds[0]), (x:any)=>x.funds[0].basis='monthly',
    (x:any)=>x.funds[0].flowUsd='100000000', (x:any)=>x.funds[0].flowPctOfStartNetAssets=9,
    (x:any)=>x.funds[0].navDate='2026-11-07', (x:any)=>x.total.flowUsd++,
    (x:any)=>x.funds[3].flowUsd=10, (x:any)=>x.funds[0].page='https://example.com/QQQ',
  ];
  for(const edit of edits){const raw=fixture();edit(raw);assert.throws(()=>parseEtfFlows(JSON.stringify(raw),at));}
});

test('source hashes and collection clocks are checked before publishing values',async()=>{
  for(const read of [async()=>({...document(),sha256:'0'.repeat(64)}),async()=>document(fixture(),'2026-11-11T00:00:00.000Z')]){
    const signals=await collectEtfFlows(read,()=>at);assert.ok(signals.every(s=>s.status==='unavailable'&&s.series.length===0&&s.failureKind==='validation'));
  }
});

test('saved flow contracts reject votes, changed provenance, missing and corrupted values',async()=>{
  const valid=(await collectEtfFlows(async()=>document(),()=>at)).find(s=>s.id==='etfiq-flow-QQQ')!;
  for(const edit of [(s:any)=>s.scores.daily=.5,(s:any)=>s.instruments=['SPY'],(s:any)=>s.source.url='https://example.com',
    (s:any)=>s.series[0].value++,(s:any)=>s.metrics[0].value++,(s:any)=>s.source.releasedAt=at]){
    const changed=structuredClone(valid);edit(changed);assert.throws(()=>validateEtfFlows(changed));
  }
});

test('scoped collection preserves old editions and retrieval-only changes do not invent an edition',async()=>{
  const before=JSON.stringify(prior),one=freezeConsensus(await refreshEtfFlows(prior,async()=>document(),()=>at));
  validateSnapshot(one);assert.equal(JSON.stringify(prior),before);
  const later='2026-11-11T04:00:00.000Z';
  const two=freezeConsensus(await refreshEtfFlows(one,async()=>document(fixture(),later),()=>later));
  assert.equal(observationDigest(one),observationDigest(two));
  const failed=await refreshEtfFlows(one,async()=>{throw new SourceTransportError('synthetic outage')},()=>later);
  const retained=retainLastKnown(failed,one).signals.find(s=>s.id==='etfiq-flow-QQQ')!;
  assert.equal(retained.source.retrievedAt,at);assert.equal(retained.source.observedAt,'2026-11-06');
  const rejected=await refreshEtfFlows(one,async()=>{throw new Error('invalid schema')},()=>later);
  assert.equal(retainLastKnown(rejected,one).signals.find(s=>s.id==='etfiq-flow-QQQ')!.status,'unavailable');
  assert.equal(ETF_FLOW_URL,'https://etfiq.com/data/flows/daily/latest.json');
});


test('full and scoped flow collection have one stable order and fetch the feed once',async()=>{
  let requests=0;
  const full=await collectSnapshot(async url=>{
    if(url===ETF_FLOW_URL){requests++;return new Response(JSON.stringify(fixture()));}
    return new Response('Synthetic provider outage',{status:503});
  });
  const later=new Date(Date.parse(full.issuedAt)+1000).toISOString();
  const scoped=await refreshEtfFlows(full,async()=>document(fixture(),later),()=>later);
  assert.equal(requests,1);assert.deepEqual(scoped.signals.map(s=>s.id),full.signals.map(s=>s.id));
  assert.equal(full.signals.at(-1)!.id,'fed-private-credit-loans');
  assert.deepEqual(full.signals.filter(s=>s.id.startsWith('etfiq-flow-')).map(s=>s.series),scoped.signals.filter(s=>s.id.startsWith('etfiq-flow-')).map(s=>s.series));
});

test('zero eligible funds withholds the aggregate; genuine zero with positive coverage remains available',async()=>{
  for(const status of ['held','spans-sessions'] as const){
    const raw=fixture();
    raw.funds=raw.funds.map(row=>({...row,status,held:status==='held',why:'Synthetic exclusion',flowUsd:null,roundTripUsd:null,flowPctOfStartNetAssets:null}));
    raw.total={funds:0,heldFunds:status==='held'?4:0,flowUsd:0,roundTripUsd:0};
    const signals=await collectEtfFlows(async()=>document(raw),()=>at);
    assert.equal(signals.find(s=>s.id==='etfiq-flow-MARKET')!.status,'unavailable');
    assert.deepEqual(signals.find(s=>s.id==='etfiq-flow-MARKET')!.series,[]);
  }
  const raw=fixture();raw.funds=raw.funds.filter(row=>row.ticker==='TLT');
  raw.total={funds:1,heldFunds:0,flowUsd:0,roundTripUsd:0};
  const market=(await collectEtfFlows(async()=>document(raw),()=>at)).find(s=>s.id==='etfiq-flow-MARKET')!;
  assert.equal(market.status,'available');assert.equal(market.series[0].value,0);
  const invalid=structuredClone(market);invalid.metrics[2].value=0;assert.throws(()=>validateEtfFlows(invalid));
});

test('a multi-session count is withheld individually while eligible daily rows remain intact',async()=>{
  const raw=fixture();raw.funds[3].held=false;raw.funds[3].status='spans-sessions';raw.total.heldFunds=0;
  const signals=await collectEtfFlows(async()=>document(raw),()=>at);
  assert.equal(signals.find(s=>s.id==='etfiq-flow-QQQ')!.status,'available');
  const spy=signals.find(s=>s.id==='etfiq-flow-SPY')!;
  assert.equal(spy.status,'unavailable');assert.match(spy.summary,/spans sessions/);
  assert.equal(signals.find(s=>s.id==='etfiq-flow-MARKET')!.metrics.at(-1)!.value,1);
});

test('signed round-trip redemption legs survive collection and saved validation', async () => {
  const raw = fixture();
  const redemption = raw.funds.find(row => row.ticker === 'IWM')!;
  redemption.roundTripUsd = -120_000_000;
  raw.total.roundTripUsd = raw.funds.reduce((sum, row) => sum + (row.roundTripUsd ?? 0), 0);
  const signals = await collectEtfFlows(async () => document(raw), () => at);
  const flow = signals.find(signal => signal.id === 'etfiq-flow-IWM')!;
  assert.equal(flow.status, 'available');
  assert.equal(flow.metrics[1].value, -120_000_000);
  assert.doesNotThrow(() => validateEtfFlows(flow));
  assert.doesNotThrow(() => validateEtfFlows(signals[0]));
});
