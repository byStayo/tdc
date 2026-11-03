import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { currencies, FX_CURRENCIES, macro, positioning, positioningRows, earnings, publicText } from '../lib/consensus/collector.ts';
import { retainLastKnown } from '../lib/consensus/last-known.ts';
import { calculateConsensus } from '../lib/consensus/engine.ts';
import { boeRequestDate, collectPolicyRates } from '../lib/consensus/policy.ts';
import type { Snapshot } from '../lib/consensus/types.ts';
import { collectCapital } from '../lib/consensus/capital.ts';
import { collectPrivateFunds } from '../lib/consensus/private-funds.ts';
import { collectNews } from '../lib/consensus/news.ts';
import { observationDigest, validateSnapshot } from '../lib/consensus/history.ts';
import { sourceFailureKind, SourceTransportError } from '../lib/consensus/source-failure.ts';

test('ECB transport outage retains seven stable identities, dates and the coverage denominator', async () => {
  const previous: Snapshot = JSON.parse(await readFile(new URL('../public/consensus/2026-11-03T08-48-02-469Z.json', import.meta.url), 'utf8'));
  const failed = await currencies(async () => new Response('', { status: 503 }));
  assert.deepEqual(failed.map(s => s.id), FX_CURRENCIES.map(ccy => `fx-${ccy}`));
  assert.ok(failed.every(s => s.failureKind === 'transport' && s.status === 'unavailable'));
  const next = { ...previous, issuedAt: new Date(Date.parse(previous.issuedAt) + 60000).toISOString(), signals: previous.signals.map(s => failed.find(f => f.id === s.id) ?? s) };
  const retained = retainLastKnown(next, previous);
  for (const id of failed.map(s => s.id)) {
    assert.deepEqual(retained.signals.find(s => s.id === id)?.source, previous.signals.find(s => s.id === id)?.source);
    assert.match(retained.signals.find(s => s.id === id)!.collectionNote!, /original dates/);
  }
  assert.equal(calculateConsensus(next.signals, 'MARKET', 'daily', previous.cutoff).families.find(f => f.id === 'fx')!.expected, 8);
  const malformed = await currencies(async () => new Response('<bad-schema/>'));
  assert.ok(malformed.every(s => s.failureKind === 'validation'));
  const invalid = retainLastKnown({ ...next, signals: malformed }, previous);
  assert.ok(invalid.signals.every(s => s.status === 'unavailable'));
});

test('all retained feed families distinguish transport loss from invalid or revoked source access', async () => {
  const previous:Snapshot=JSON.parse(await readFile(new URL('../public/consensus/2026-11-03T08-48-02-469Z.json',import.meta.url),'utf8'));
  for (const [status,kind] of [[503,'transport'],[429,'transport'],[403,'validation'],[404,'validation'],[200,'validation']] as const) {
    const fetcher=async()=>new Response('invalid source schema',{status});
    const read=(url:string)=>publicText(url,fetcher);
    const signals=[...await macro(fetcher),...await currencies(fetcher),...await positioning(fetcher),...await earnings(fetcher),
      ...await collectPolicyRates(read),...await collectCapital(read),await collectPrivateFunds(read,fetcher),(await collectNews(fetcher)).signal];
    assert.ok(signals.length>40);
    assert.ok(signals.every(s=>s.status==='unavailable'&&s.failureKind===kind),`HTTP${status}`);
    const next={...previous,issuedAt:'2026-11-04T12:00:00.000Z',cutoff:'2026-11-04T12:00:00.000Z',signals};
    const retained=retainLastKnown(next,previous);
    if(kind==='validation') assert.ok(retained.signals.every(s=>s.status==='unavailable'));
    else for(const id of ['fred-DGS10','fx-EUR','policy-ecb-deposit','tic-for_lt_total','earnings-NVDA','cftc-13874A-asset','gdelt-finance-news','sec-private-equity-assets']) {
      assert.deepEqual(retained.signals.find(s=>s.id===id)?.source,previous.signals.find(s=>s.id===id)!.source,id);
      assert.match(retained.signals.find(s=>s.id===id)!.collectionNote!,/original dates/);
    }
  }
});

test('size and schema errors never masquerade as transport while interrupted streams do',async()=>{
  const url='https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10';
  await assert.rejects(publicText(url,async()=>new Response('x'.repeat(2_000_001))),error=>sourceFailureKind(error)==='validation');
  await assert.rejects(publicText(url,async()=>{throw new Error('connection reset');}),error=>error instanceof SourceTransportError);
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.error(new Error('broken stream'));}});
  await assert.rejects(publicText(url,async()=>new Response(stream)),error=>sourceFailureKind(error)==='transport');
});

test('an unavailable error-message change alone cannot publish another edition',async()=>{
  const previous:Snapshot=JSON.parse(await readFile(new URL('../public/consensus/2026-11-03T08-48-02-469Z.json',import.meta.url),'utf8'));
  const failure=(await macro(async()=>new Response('',{status:503})))[0];
  const first={...previous,signals:[failure]}, second=structuredClone(first);
  second.signals[0].summary='A different timeout stack or provider error message';
  second.signals[0].source.retrievedAt='2026-11-04T12:00:00.000Z';
  assert.equal(observationDigest(first),observationDigest(second));
  second.signals[0].failureKind='validation';
  assert.notEqual(observationDigest(first),observationDigest(second));
  delete second.signals[0].failureKind;
  assert.equal(retainLastKnown({...second,issuedAt:'2026-11-04T12:00:00.000Z'},previous).signals[0].status,'unavailable');
});

test('CFTC identical duplicate dates collapse; conflicts only withhold the affected contract',async()=>{
  const row={id:'fixture',report_date_as_yyyy_mm_dd:'2026-10-27T00:00:00.000',contract_market_name:'S&P 500',cftc_contract_market_code:'13874A',
    contract_units:'Contracts',open_interest_all:'100',asset_mgr_positions_long:'50',asset_mgr_positions_short:'20',
    lev_money_positions_long:'10',lev_money_positions_short:'30',dealer_positions_long_all:'30',dealer_positions_short_all:'20',futonly_or_combined:'FutOnly'};
  assert.equal(positioningRows([row,{...row,id:'duplicate'}],'13874A','2026-11-03T12:00:00.000Z').length,1);
  const conflict={...row,asset_mgr_positions_long:'51'};
  assert.throws(()=>positioningRows([row,conflict],'13874A','2026-11-03T12:00:00.000Z'),/Conflicting CFTC/);
  const good={...row,cftc_contract_market_code:'209742',contract_market_name:'Nasdaq'};
  const signals=await positioning(async()=>new Response(JSON.stringify([row,conflict,good,{...good,id:'duplicate'}])));
  assert.ok(signals.filter(s=>s.id.includes('13874A')).every(s=>s.status==='unavailable'&&s.failureKind==='validation'));
  assert.ok(signals.filter(s=>s.id.includes('209742')).every(s=>s.status==='available'&&s.series.length===1));
});

test('snapshot signal and catalyst citations reject unreviewed hosts, credentials and encoded secret keys',async()=>{
  const snapshot:Snapshot=JSON.parse(await readFile(new URL('../public/consensus/2026-11-03T08-48-02-469Z.json',import.meta.url),'utf8'));
  for(const url of ['https://unreviewed.example/data','https://www.sec.gov.attacker.example/data','https://name:password@www.sec.gov/data','https://www.sec.gov:8443/data','https://www.sec.gov/data?%61pi_key=fixture','javascript:alert(1)']) {
    const signal=structuredClone(snapshot);signal.signals[0].source.url=url;
    assert.throws(()=>validateSnapshot(signal,'archive'),/source URL/);
    const catalyst=structuredClone(snapshot);catalyst.catalysts[0].url=url;
    assert.throws(()=>validateSnapshot(catalyst,'archive'),/source URL/);
  }
  assert.doesNotThrow(()=>validateSnapshot(snapshot,'archive'));
});

test('Bank Rate query dates use an explicit three-letter month including September', async () => {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (let month = 1; month <= 12; month++) assert.equal(boeRequestDate(`2024-${String(month).padStart(2,'0')}-03`), `03/${months[month-1]}/2024`);
  assert.throws(() => boeRequestDate('2024-02-30'));
  const urls: string[] = [];
  await collectPolicyRates(async url => { urls.push(url); throw new Error('fixture outage'); }, '2026-09-03T08:00:00.000Z');
  const url = new URL(urls.find(url => url.includes('bankofengland'))!);
  assert.equal(url.searchParams.get('Datefrom'), '03/Sep/2024');
});
