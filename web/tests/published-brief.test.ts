import test from 'node:test';
import assert from 'node:assert/strict';
import { getPublishedBrief } from '../lib/published-brief.ts';
import { assertPublicURL } from '../scripts/collect-editorial-evidence.ts';

test('published brief has traceable public evidence and a valid publication date', () => {
  const brief = getPublishedBrief(0);
  assert.equal(brief.status, 'ok');
  assert.equal(brief.scope, 'market');
  assert.ok(Number.isFinite(Date.parse(brief.createdAt!)));
  assert.ok(brief.sources?.length);
  for (const source of brief.sources!) {
    const url = new URL(assertPublicURL(source.url));
    assert.equal(url.protocol, 'https:');
    if (source.id === 'TREASURY_YIELD_CURVE' || url.hostname === 'home.treasury.gov') {
      assert.equal(source.id, 'TREASURY_YIELD_CURVE');
      assert.equal(url.origin, 'https://home.treasury.gov');
      assert.equal(url.pathname, '/resource-center/data-chart-center/interest-rates/TextView');
      assert.equal(url.searchParams.get('type'), 'daily_treasury_yield_curve');
      assert.match(url.searchParams.get('field_tdr_date_value') ?? '', /^\d{4}$/);
    }
    if (url.hostname === 'www.bankofengland.co.uk') {
      assert.match(url.pathname, /^\/monetary-policy-summary-and-minutes\/(\d{4})\/[a-z]+-\1$/);
      assert.equal(url.search + url.hash, '');
    }
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
