import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResearch } from '../lib/research-schema.ts';

const brief = () => ({ headline: 'Evidence is mixed', summary: 'Completed-session prices and reported developments offer different perspectives.', bull: [{ text: 'The close exceeded the prior close.', sourceIds: ['P1'] }], bear: [], watch: [], limitations: ['Completed-session data is not a live quote.'] });
test('rejects nonexistent evidence citations even when the answer has the correct shape', () => {
  const value = brief(); value.bull[0].sourceIds = ['invented-source'];
  assert.throws(() => validateResearch(value, new Set(['P1'])), /citation/);
});
test('rejects uncited observations', () => {
  const value = brief(); value.bull[0].sourceIds = [];
  assert.throws(() => validateResearch(value, new Set(['P1'])), /citation/);
});
test('preserves evidence and permits no opposing claim when none is supported', () => {
  assert.deepEqual(validateResearch(brief(), new Set(['P1'])), brief());
});
test('rejects excessive generated content', () => {
  const value = brief(); value.summary = 'x'.repeat(1101);
  assert.throws(() => validateResearch(value, new Set(['P1'])), /text/);
});
