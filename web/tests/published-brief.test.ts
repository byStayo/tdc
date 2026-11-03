import test from 'node:test';
import assert from 'node:assert/strict';
import { getPublishedBrief } from '../lib/published-brief.ts';

test('published brief has traceable public evidence and a valid publication date', () => {
  const brief = getPublishedBrief(0);
  assert.equal(brief.status, 'ok');
  assert.equal(brief.scope, 'market');
  assert.ok(Number.isFinite(Date.parse(brief.createdAt!)));
  assert.ok(brief.sources?.length);
  const allowed = new Set(['publicreporting.cftc.gov', 'www.cftc.gov', 'fred.stlouisfed.org', 'www.sec.gov', 'data.sec.gov', 'www.bls.gov']);
  for (const source of brief.sources!) {
    const url = new URL(source.url);
    assert.equal(url.protocol, 'https:');
    assert.ok(allowed.has(url.hostname));
  }
  const ids = new Set(brief.sources!.map(source => source.id));
  for (const claim of [...brief.data!.bull, ...brief.data!.bear, ...brief.data!.watch]) {
    assert.ok(claim.sourceIds.length > 0);
    assert.ok(claim.sourceIds.every(id => ids.has(id)));
  }
});

test('a brief ages into an explicit historical state without a generation request', () => {
  const fresh = getPublishedBrief(0);
  const stale = getPublishedBrief(Date.parse(fresh.createdAt!) + 73 * 60 * 60 * 1000);
  assert.equal(stale.status, 'stale');
  assert.match(stale.message!, /historical context/);
  assert.deepEqual(stale.data, fresh.data);
});
