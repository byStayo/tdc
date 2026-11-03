import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { currencies, FX_CURRENCIES } from '../lib/consensus/collector.ts';
import { retainLastKnown } from '../lib/consensus/last-known.ts';
import { calculateConsensus } from '../lib/consensus/engine.ts';
import { boeRequestDate, collectPolicyRates } from '../lib/consensus/policy.ts';
import type { Snapshot } from '../lib/consensus/types.ts';

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

test('Bank Rate query dates use an explicit three-letter month including September', async () => {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (let month = 1; month <= 12; month++) assert.equal(boeRequestDate(`2024-${String(month).padStart(2,'0')}-03`), `03/${months[month-1]}/2024`);
  assert.throws(() => boeRequestDate('2024-02-30'));
  const urls: string[] = [];
  await collectPolicyRates(async url => { urls.push(url); throw new Error('fixture outage'); }, '2026-09-03T08:00:00.000Z');
  const url = new URL(urls.find(url => url.includes('bankofengland'))!);
  assert.equal(url.searchParams.get('Datefrom'), '03/Sep/2024');
});
