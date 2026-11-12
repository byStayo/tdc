import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUMENT_REPORTS } from '../lib/instrument-reports.ts';
import { getPublishedInstrumentBrief } from '../lib/published-instrument-reports.ts';

test('all five reports retain their own identity, distinct analysis and instrument evidence', () => {
  const headlines = new Set<string>();
  for (const descriptor of INSTRUMENT_REPORTS) {
    const brief = getPublishedInstrumentBrief(descriptor.symbol, 0);
    assert.equal(brief.status, 'ok'); assert.equal(brief.scope, 'instrument'); assert.equal(brief.symbol, descriptor.symbol);
    assert.ok(brief.data); assert.ok(brief.createdAt); headlines.add(brief.data.headline);
    assert.ok(brief.sources?.some(source => source.id === descriptor.sourceId));
    const sourceIds = new Set(brief.sources!.map(source => source.id));
    const claims = [...brief.data.bull, ...brief.data.bear, ...brief.data.watch];
    assert.ok(claims.some(claim => claim.sourceIds.includes(descriptor.sourceId)));
    assert.ok(claims.every(claim => claim.sourceIds.length && claim.sourceIds.every(id => sourceIds.has(id))));
  }
  assert.equal(headlines.size, 5);
});

test('unsupported instruments never receive a mislabeled market report', () => {
  for (const symbol of ['AAPL', 'GLD', 'UNKNOWN', '../../SPY']) {
    const brief = getPublishedInstrumentBrief(symbol, 0);
    assert.equal(brief.status, 'unconfigured'); assert.equal(brief.scope, 'instrument'); assert.equal(brief.symbol, symbol);
    assert.equal(brief.data, null); assert.equal(brief.createdAt, undefined);
  }
});

test('each instrument ages independently without refreshing the observation or publication date', () => {
  for (const descriptor of INSTRUMENT_REPORTS) {
    const fresh = getPublishedInstrumentBrief(descriptor.symbol, 0);
    const stale = getPublishedInstrumentBrief(descriptor.symbol, Date.parse(fresh.createdAt!) + 73 * 60 * 60 * 1000);
    assert.equal(stale.status, 'stale'); assert.match(stale.message!, /historical context/);
    assert.equal(stale.createdAt, fresh.createdAt); assert.deepEqual(stale.data, fresh.data);
  }
});
