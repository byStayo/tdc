import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPublicURL, collectEditorialEvidence, parseFREDCSV, type EditorialEvidence } from '../scripts/collect-editorial-evidence.ts';
import { publishEditorialBrief, validateEditorialPublication } from '../scripts/publish-editorial-brief.ts';

const NOW = Date.parse('2026-11-03T03:00:00Z');
function fixture() {
  const url = 'https://publicreporting.cftc.gov/resource/gpe5-46if.json?cftc_contract_market_code=13874A';
  const evidence: EditorialEvidence = { schemaVersion: 1, scope: 'market', collectedAt: '2026-11-03T02:00:00Z', sources: [{ id: 'CFTC_ES', kind: 'cftc', title: 'CFTC futures evidence', url, retrievalUrl: url, retrievedAt: '2026-11-03T01:59:00Z', observationDates: ['2026-10-27'], status: 'ok', data: { openInterest: 0 } }], limitations: ['Weekly report, not a live flow.'] };
  const candidate = { status: 'ok', scope: 'market', createdAt: '2026-11-03T02:30:00Z', model: 'Codex editorial workflow', message: 'Published public-source research.', data: { headline: 'Read the report in context', summary: 'A descriptive summary of the cited evidence.', bull: [{ text: 'This observation has a source.', sourceIds: ['CFTC_ES'] }], bear: [], watch: [], limitations: ['Weekly data is delayed.'] }, sources: [{ id: 'CFTC_ES', title: 'CFTC evidence', url }] };
  return { candidate, evidence };
}

test('editorial URLs reject private hosts, credentials, HTTP and credential query parameters', () => {
  assert.equal(new URL(assertPublicURL('https://fred.stlouisfed.org/series/FEDFUNDS')).hostname, 'fred.stlouisfed.org');
  for (const url of ['http://fred.stlouisfed.org/series/FEDFUNDS', 'https://fred.stlouisfed.org.evil.example/x', 'https://user:secret@www.sec.gov/x', 'https://www.sec.gov:8443/x', 'https://data.sec.gov/x?api_key=secret', 'https://api.openai.com/v1/responses']) assert.throws(() => assertPublicURL(url));
});

test('FRED evidence preserves genuine zero and missing observations without accepting malformed numerics', () => {
  const rows = parseFREDCSV('observation_date,FEDFUNDS\n2026-08-01,0\n2026-09-01,.\n2026-10-01,3.88\n2026-11-01,0x10\n', 'FEDFUNDS');
  assert.deepEqual(rows, [{ date: '2026-08-01', value: 0 }, { date: '2026-09-01', value: null }, { date: '2026-10-01', value: 3.88 }]);
  assert.throws(() => parseFREDCSV('observation_date,WRONG\n2026-10-01,5', 'FEDFUNDS'));
});

test('collector uses bounded official reads, retains provenance and marks failed sources unavailable', async () => {
  const calls: URL[] = [];
  const evidence = await collectEditorialEvidence(async (input, init) => {
    const url = new URL(input); calls.push(url); assertPublicURL(url.href);
    assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).has('Authorization'), false);
    if (url.hostname === 'fred.stlouisfed.org') { const id = url.searchParams.get('id'); return new Response(`observation_date,${id}\n2026-10-01,0\n`, { status: 200 }); }
    if (url.hostname === 'www.cftc.gov') return new Response(`<main>${'Official report methodology. '.repeat(20)}</main>`);
    if (url.hostname === 'publicreporting.cftc.gov') {
      assert.equal(url.searchParams.get('$limit'), '100');
      return Response.json(['13874A', '209742', '239742', '124603', '020601', '043602'].flatMap(code => [
        { futonly_or_combined: 'FutOnly', cftc_contract_market_code: code, contract_market_name: `Fixture ${code}`, contract_units: 'contracts', report_date_as_yyyy_mm_dd: '2026-10-27T00:00:00.000', open_interest_all: '0' },
        { futonly_or_combined: 'FutOnly', cftc_contract_market_code: code, contract_market_name: `Fixture ${code}`, contract_units: 'contracts', report_date_as_yyyy_mm_dd: '2026-10-20T00:00:00.000', open_interest_all: '100' },
        { futonly_or_combined: 'Combined', cftc_contract_market_code: code, contract_market_name: `Fixture ${code}`, contract_units: 'contracts', report_date_as_yyyy_mm_dd: '2026-10-25T00:00:00.000', open_interest_all: '999' },
      ]));
    }
    if (url.pathname.includes('0000789019')) return new Response('unavailable', { status: 503 });
    const cik = url.pathname.match(/CIK(\d+)\.json/)![1];
    return Response.json({ cik, name: 'Fixture issuer', filings: { recent: { accessionNumber: ['0000320193-26-000024'], filingDate: ['2026-11-02'], reportDate: ['2026-09-30'], form: ['8-K'], primaryDocument: ['filing.htm'] } } });
  });
  assert.equal(calls.length, 8); assert.equal(evidence.sources.length, 13);
  assert.equal(evidence.sources.find(source => source.id === 'SEC_MSFT')?.status, 'unavailable');
  assert.ok(evidence.sources.every(source => source.retrievedAt && source.retrievalUrl && source.url));
  assert.equal(evidence.sources.find(source => source.id === 'CFTC_ES')?.observationDates[0], '2026-10-27');
  const es = evidence.sources.find(source => source.id === 'CFTC_ES')!;
  assert.deepEqual(es.observationDates, ['2026-10-27', '2026-10-20']);
  assert.equal((es.data as { previous: { openInterest: number } }).previous.openInterest, 100);
  const citation = new URL(es.url);
  assert.equal(citation.searchParams.get('cftc_contract_market_code'), '13874A');
  assert.match(citation.searchParams.get('$where')!, /2026-10-27.*2026-10-20/);
  assert.equal(citation.searchParams.has('report_date_as_yyyy_mm_dd'), false);
});

test('publisher rejects future times, non-market scope, unavailable citations and mismatched evidence URLs', () => {
  const { candidate, evidence } = fixture(); assert.equal(validateEditorialPublication(candidate, evidence, NOW).brief.scope, 'market');
  assert.throws(() => validateEditorialPublication({ ...candidate, createdAt: '2026-11-04T00:00:00Z' }, evidence, NOW));
  assert.throws(() => validateEditorialPublication({ ...candidate, createdAt: '2026-11-03T01:00:00Z' }, evidence, NOW));
  assert.throws(() => validateEditorialPublication({ ...candidate, scope: 'instrument' }, evidence, NOW));
  assert.throws(() => validateEditorialPublication(candidate, { ...evidence, sources: [{ ...evidence.sources[0], status: 'unavailable', data: null }] }, NOW));
  assert.throws(() => validateEditorialPublication({ ...candidate, sources: [{ ...candidate.sources[0], url: 'https://www.sec.gov/' }] }, evidence, NOW));
  assert.throws(() => validateEditorialPublication({ ...candidate, data: { ...candidate.data, bull: [{ text: 'Unverified', sourceIds: ['UNKNOWN'] }] } }, evidence, NOW));
});

async function inputFiles() {
  const root = await mkdtemp(join(tmpdir(), 'tdc-editorial-')), { candidate, evidence } = fixture();
  const candidatePath = join(root, 'candidate.json'), evidencePath = join(root, 'evidence.json');
  await writeFile(candidatePath, JSON.stringify(candidate)); await writeFile(evidencePath, JSON.stringify(evidence));
  return { root, candidate, evidence, candidatePath, evidencePath };
}

test('validation failure and check-only mode leave existing publication and archives untouched', async () => {
  const input = await inputFiles(); await mkdir(join(input.root, 'lib')); await mkdir(join(input.root, 'public/reports'), { recursive: true });
  const latest = join(input.root, 'lib/published-brief.json'); await writeFile(latest, '{"existing":true}'); await writeFile(join(input.root, 'public/reports/prior.json'), '{"historical":true}');
  const before = await readFile(latest, 'utf8');
  await writeFile(input.candidatePath, JSON.stringify({ ...input.candidate, scope: 'instrument' }));
  await assert.rejects(publishEditorialBrief(input.candidatePath, input.evidencePath, { root: input.root, now: NOW }));
  assert.equal(await readFile(latest, 'utf8'), before); assert.deepEqual(await readdir(join(input.root, 'public/reports')), ['prior.json']);
  await writeFile(input.candidatePath, JSON.stringify(input.candidate));
  const checked = await publishEditorialBrief(input.candidatePath, input.evidencePath, { root: input.root, now: NOW, checkOnly: true });
  assert.equal(checked.published, false); assert.equal(await readFile(latest, 'utf8'), before);
  await assert.rejects(stat(join(input.root, '.editorial')));
});

test('publisher writes immutable evidence/brief archives then atomically replaces the complete latest brief', async () => {
  const input = await inputFiles();
  const result = await publishEditorialBrief(input.candidatePath, input.evidencePath, { root: input.root, now: NOW });
  assert.equal(result.published, true);
  const latest = JSON.parse(await readFile(result.latest, 'utf8'));
  assert.equal(latest.scope, 'market'); assert.equal(latest.data.headline, input.candidate.data.headline);
  assert.deepEqual(JSON.parse(await readFile(result.evidenceArchive, 'utf8')), input.evidence);
  assert.deepEqual(JSON.parse(await readFile(result.briefArchive, 'utf8')), latest);
  const repeated = await publishEditorialBrief(input.candidatePath, input.evidencePath, { root: input.root, now: NOW });
  assert.equal(repeated.briefArchive, result.briefArchive); assert.equal((await readdir(join(input.root, 'public/reports'))).length, 2);
  await assert.rejects(stat(join(input.root, '.editorial/publish.lock')));
});

test('an archive collision cannot overwrite the current publication or historical evidence', async () => {
  const input = await inputFiles(), plan = await publishEditorialBrief(input.candidatePath, input.evidencePath, { root: input.root, now: NOW, checkOnly: true });
  await mkdir(join(input.root, 'public/reports'), { recursive: true }); await mkdir(join(input.root, 'lib'));
  await writeFile(plan.latest, '{"existing":true}'); await writeFile(plan.briefArchive, '{"immutable":true}');
  await assert.rejects(publishEditorialBrief(input.candidatePath, input.evidencePath, { root: input.root, now: NOW }));
  assert.equal(await readFile(plan.latest, 'utf8'), '{"existing":true}'); assert.equal(await readFile(plan.briefArchive, 'utf8'), '{"immutable":true}');
  await assert.rejects(stat(plan.evidenceArchive));
});

test('instrument publications require a supported identity and a claim citing that instrument’s contract', () => {
  const { candidate, evidence } = fixture();
  const instrument = { ...candidate, scope: 'instrument', symbol: 'SPY' };
  const input = { ...evidence, sources: [{ ...evidence.sources[0], data: { contractCode: '13874A', openInterest: 0 } }] };
  const valid = validateEditorialPublication(instrument, input, NOW).brief;
  assert.equal(valid.scope, 'instrument'); assert.equal(valid.symbol, 'SPY');
  assert.throws(() => validateEditorialPublication({ ...instrument, symbol: 'QQQ' }, input, NOW));
  assert.throws(() => validateEditorialPublication({ ...instrument, symbol: '../../SPY' }, input, NOW));
  assert.throws(() => validateEditorialPublication({ ...candidate, symbol: 'SPY' }, input, NOW));
  assert.throws(() => validateEditorialPublication(instrument, { ...input, sources: [{ ...input.sources[0], data: { contractCode: '209742' } }] }, NOW));
});

test('publishing one instrument preserves the market edition, other instruments and earlier archives', async () => {
  const input = await inputFiles();
  await mkdir(join(input.root, 'lib/published-instruments'), { recursive: true });
  await writeFile(join(input.root, 'lib/published-brief.json'), '{"market":"unchanged"}');
  await writeFile(join(input.root, 'lib/published-instruments/QQQ.json'), '{"other":"unchanged"}');
  const candidate = { ...input.candidate, scope: 'instrument', symbol: 'SPY' };
  const evidence = { ...input.evidence, sources: [{ ...input.evidence.sources[0], data: { contractCode: '13874A', openInterest: 0 } }] };
  await writeFile(input.candidatePath, JSON.stringify(candidate)); await writeFile(input.evidencePath, JSON.stringify(evidence));
  const result = await publishEditorialBrief(input.candidatePath, input.evidencePath, { root: input.root, now: NOW });
  assert.equal(result.latest, join(input.root, 'lib/published-instruments/SPY.json'));
  assert.equal(JSON.parse(await readFile(result.latest, 'utf8')).symbol, 'SPY');
  assert.equal(await readFile(join(input.root, 'lib/published-brief.json'), 'utf8'), '{"market":"unchanged"}');
  assert.equal(await readFile(join(input.root, 'lib/published-instruments/QQQ.json'), 'utf8'), '{"other":"unchanged"}');
  const repeated = await publishEditorialBrief(input.candidatePath, input.evidencePath, { root: input.root, now: NOW });
  assert.equal(repeated.briefArchive, result.briefArchive);
  await writeFile(input.candidatePath, JSON.stringify({ ...candidate, createdAt: '2026-11-03T02:20:00Z' }));
  await assert.rejects(publishEditorialBrief(input.candidatePath, input.evidencePath, { root: input.root, now: NOW }));
  assert.equal(JSON.parse(await readFile(result.latest, 'utf8')).createdAt, '2026-11-03T02:30:00.000Z');
});
