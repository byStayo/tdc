import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyScoringPolicy, signalScore } from '../lib/consensus/scoring-policy.ts';
import { asIssuedConsensus, freezeConsensus, versionedConsensus } from '../lib/consensus/as-issued.ts';
import { calculateConsensus, effectiveStatus } from '../lib/consensus/engine.ts';
import { validateSnapshot, digest } from '../lib/consensus/history.ts';
import { FAMILIES, ENGINE_VERSION } from '../lib/consensus/registry.ts';
import type { Snapshot, Signal } from '../lib/consensus/types.ts';
const legacy: Snapshot = JSON.parse(await readFile(new URL('../public/consensus/2026-11-03T08-48-02-469Z.json', import.meta.url), 'utf8'));

test('v2 removes structural earnings/daily positioning priors and respects source cadence without changing old evidence', () => {
  const original = JSON.stringify(legacy), next = applyScoringPolicy(legacy);
  const get = (id: string) => next.signals.find(s => s.id === id)!;
  for(const ticker of ['AAPL','MSFT','NVDA']) assert.deepEqual(get(`earnings-${ticker}`).scores, {daily:null,weekly:null,monthly:null});
  for(const signal of next.signals.filter(s => s.id.startsWith('cftc-'))) assert.equal(signal.scores.daily,null);
  assert.deepEqual(get('fred-BUSLOANS').scores, {daily:null,weekly:null,monthly:0.40891833333333427});
  assert.equal(get('fred-WALCL').scores.daily,null);
  const walcl = get('fred-WALCL');
  assert.equal(walcl.scores.weekly, Math.max(-1,Math.min(1,(walcl.series.at(-1)!.value-walcl.series.at(-2)!.value)/200000)));
  for (const signal of next.signals) assert.deepEqual(signal.source, legacy.signals.find(s=>s.id===signal.id)!.source);
  assert.equal(JSON.stringify(legacy),original);
  assert.deepEqual(applyScoringPolicy(next),next);
});

test('v2 keeps equity priors out of TLT and Treasury futures out of MARKET', () => {
  const next=applyScoringPolicy(legacy), get=(id:string)=>next.signals.find(s=>s.id===id)!;
  for(const id of ['BUSLOANS','TOTBKCR','DTWEXBGS','WALCL','WTREGEN','SOFR','EFFR','DGS2']) {
    assert.equal(signalScore(get(`fred-${id}`),'TLT','monthly'),null);
    assert.ok(get(`fred-${id}`).instruments.includes('TLT'), 'context is preserved');
  }
  assert.equal(signalScore(get('fred-DGS30'),'TLT','daily'),get('fred-DGS30').scores.daily);
  assert.deepEqual(get('cftc-020601-asset').instruments,['TLT']);
  assert.deepEqual(get('cftc-043602-asset').scores,{daily:null,weekly:null,monthly:null});
  assert.equal(signalScore(get('cftc-020601-asset'),'MARKET','weekly'),null);
});

test('full context coverage cannot qualify a directionally incomplete verdict', () => {
  const base=legacy.signals.find(s=>s.status==='available')!;
  const signals:Signal[]=FAMILIES.map((family,i)=>({...base,id:`fixture-${family.id}`,family:family.id,instruments:['SPY'],scores:{daily:i<5?0.5:null,weekly:null,monthly:null}}));
  // Ensure both required risk families are present; only five independent votes exist.
  signals.find(s=>s.family==='technicals')!.scores.daily=.5;
  const consensus=calculateConsensus(signals,'SPY','daily',legacy.cutoff);
  assert.equal(consensus.coverage,1);
  assert.equal(consensus.directionalCoverage,5/15);
  assert.ok(consensus.abstain);
  assert.ok(consensus.reasons.some(r=>r.includes('directional vote')));
  assert.equal(effectiveStatus({...base,source:{...base.source,observedAt:'2099-01-01'}},legacy.cutoff),'unavailable');
});

test('v2 publications freeze both coverage measures and reject revived legacy votes', () => {
  const next=freezeConsensus(applyScoringPolicy(legacy));
  validateSnapshot(next);
  const daily=asIssuedConsensus(next,'MARKET','daily');
  assert.equal(daily.directionalCoverage,3/15);
  assert.equal(daily.families.find(f=>f.id==='earnings')!.score,null);
  assert.ok(daily.abstain);
  const wrong=structuredClone(next);wrong.signals.find(s=>s.id==='earnings-AAPL')!.scores.daily=.5;
  assert.throws(()=>validateSnapshot(wrong), /recorded engine|directional policy/);
  const wrongCoverage=structuredClone(next);wrongCoverage.consensus![0].directionalCoverage=2;
  assert.throws(()=>validateSnapshot(wrongCoverage,'archive'), /Invalid as-issued/);
  assert.equal(asIssuedConsensus(legacy,'MARKET','daily').directionalCoverage,undefined);
});


test('the current rule version dispatches to its live engine and remains pinned to its declared golden result', () => {
  const next=applyScoringPolicy(legacy);
  const goldens: Record<string,string> = {'consensus-rules-2.0.0':'e96cad61b822eb8b3a0f95d4f3c9c9e008e9dfb08777b727628cddc4397304b0'};
  assert.equal(next.engineVersion,ENGINE_VERSION);
  assert.deepEqual(versionedConsensus(next,'SPY','weekly'),calculateConsensus(next.signals,'SPY','weekly',next.cutoff));
  assert.equal(digest(freezeConsensus(next).consensus),goldens[ENGINE_VERSION], 'methodology changes need a new engine version and preserved old implementation');
  const stored=freezeConsensus(next);
  stored.consensus![0].abstain=false;
  assert.throws(()=>validateSnapshot(stored,'archive'),/Inconsistent as-issued/);
});
