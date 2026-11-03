import test from 'node:test';
import assert from 'node:assert/strict';
import { contractsForSymbol, hasRelatedContract, isPublicRange, isPublicSymbol, latestPublicPositioning, normalizeCik, parseIssuerDirectory, parseSECSubmissions, publicCount, publicDate, secDocumentUrl } from '../lib/public-normalization.ts';

test('public contract counts distinguish measured zero from missing, invalid and fractional values', () => {
  for (const value of [0, '0', '0.0']) assert.equal(publicCount(value), 0);
  assert.equal(publicCount('12003'), 12003);
  for (const value of [undefined, null, '', ' ', '.', '-', 'NaN', NaN, Infinity, -1, '-1', '1.5', true, 1.5, '1e3']) assert.equal(publicCount(value), null);
});

test('report dates remain calendar dates and reject impossible dates', () => {
  assert.equal(publicDate('2026-10-27T00:00:00.000'), '2026-10-27');
  assert.equal(publicDate('2026-11-03T00:00:00-05:00'), '2026-11-03');
  assert.equal(publicDate('2024-02-29'), '2024-02-29');
  for (const value of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-10-27junk', '2026-10-27T99:99:99', '2026-10-27T24:00:00', '10/27/2026', '', undefined]) assert.equal(publicDate(value), null);
});

test('SEC document URLs stay in the expected issuer and accession namespace', () => {
  const accession = '0000320193-26-000024';
  assert.equal(normalizeCik(320193), '0000320193'); assert.equal(normalizeCik('0000320193'), '0000320193');
  assert.equal(secDocumentUrl('0000320193', accession, 'aapl-20261102.htm'), 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000024/aapl-20261102.htm');
  assert.ok(secDocumentUrl('0000320193', accession, 'xslF345X06/form4.xml')?.endsWith('/xslF345X06/form4.xml'));
  for (const path of ['https://evil.example/steal', '//evil.example/file', '../outside.htm', 'x/../../outside', 'file.htm?token=x', 'file.htm#x', '%2e%2e/file', 'file\\outside', '']) assert.equal(secDocumentUrl(320193, accession, path), null);
  assert.equal(secDocumentUrl('0000320193', '../../outside', 'file.htm'), null);
  for (const cik of [0, '0000000000', '12345678901', '../320193', '0x123']) assert.equal(normalizeCik(cik), null);
});

test('SEC columnar rows remain aligned and mismatched issuer data is discarded', () => {
  const input = { cik: '0000320193', name: 'Apple Inc.', filings: { recent: {
    accessionNumber: ['0000320193-26-000024', '0000320193-26-000023', '0000320193-26-000022'],
    filingDate: ['2026-11-02', '2026-10-29', '2026-10-28'], form: ['8-K', '4', '10-K'],
    reportDate: ['2026-11-02', '', '2026-09-30'], primaryDocument: ['aapl-20261102.htm', 'xslF345X06/form4.xml'],
    primaryDocDescription: ['CURRENT REPORT', 'FORM 4', 'ANNUAL REPORT'],
  } } };
  const parsed = parseSECSubmissions(input, '0000320193');
  assert.equal(parsed.length, 2); assert.equal(parsed[0].form, '8-K'); assert.equal(parsed[0].filedAt, '2026-11-02');
  assert.equal(parsed[1].form, '4'); assert.equal(parsed[1].reportDate, null); assert.ok(parsed[1].url.includes('/000032019326000023/'));
  assert.deepEqual(parseSECSubmissions(input, '0000789019'), []);
});

test('SEC directory mappings validate ticker and CIK rather than trusting arbitrary URLs', () => {
  const map = parseIssuerDirectory({ '0': { ticker: 'AAPL', cik_str: 320193, title: 'Apple Inc.' }, '1': { ticker: 'BRK-B', cik_str: 1067983, title: 'Berkshire' }, '2': { ticker: '../SPY', cik_str: 1 }, '3': { ticker: 'MSFT', cik_str: 'https://evil.example' } });
  assert.equal(map.get('AAPL')?.cik, '0000320193'); assert.equal(map.get('BRK-B')?.cik, '0001067983'); assert.equal(map.size, 2);
});

test('CFTC latest rows are deduplicated per verified contract without mixing report namespaces or units', () => {
  const row = { futonly_or_combined: 'FutOnly', cftc_contract_market_code: '13874A', market_and_exchange_names: 'E-MINI S&P 500 - CME', report_date_as_yyyy_mm_dd: '2026-10-27T00:00:00.000', contract_units: '($50 X S&P 500 INDEX)', open_interest_all: '100', asset_mgr_positions_long: '0', asset_mgr_positions_short: '20', lev_money_positions_long: '30', lev_money_positions_short: '40', dealer_positions_long_all: '10', dealer_positions_short_all: '0' };
  const parsed = latestPublicPositioning([
    { ...row, report_date_as_yyyy_mm_dd: '2026-10-20T00:00:00.000', open_interest_all: '90' },
    row,
    { ...row, futonly_or_combined: 'Combined', report_date_as_yyyy_mm_dd: '2026-11-03T00:00:00.000', open_interest_all: '999' },
    { ...row, cftc_contract_market_code: '020601', market_and_exchange_names: 'UST BOND - CBOT', contract_units: '($100,000 FACE VALUE)', open_interest_all: '200', asset_mgr_positions_long: undefined },
    { ...row, cftc_contract_market_code: 'GUESSED' },
  ], ['13874A', '020601']);
  assert.equal(parsed.length, 2); assert.equal(parsed[0].reportDate, '2026-10-27'); assert.equal(parsed[0].openInterest, 100); assert.equal(parsed[0].assetManagerLong, 0);
  assert.equal(parsed[1].contractCode, '020601'); assert.equal(parsed[1].openInterest, 200); assert.equal(parsed[1].assetManagerLong, null);
  assert.notEqual(parsed[0].units, parsed[1].units); assert.ok(parsed[0].id.startsWith('cftc-tff-futures:'));
});

test('instrument-to-contract mapping is explicit and does not mistake gold or individual equities for futures', () => {
  assert.deepEqual(contractsForSymbol('SPY'), ['13874A']); assert.deepEqual(contractsForSymbol('TLT'), ['020601']);
  assert.equal(hasRelatedContract('GLD'), false); assert.equal(hasRelatedContract('AAPL'), false); assert.equal(contractsForSymbol('GLD').length, 6);
  for (const value of ['SPY', 'BRK.B', 'BRK-B']) assert.equal(isPublicSymbol(value), true);
  for (const value of ['SPY?mode=private', '../AAPL', 'spy']) assert.equal(isPublicSymbol(value), false);
  assert.equal(isPublicRange('1Y'), true); assert.equal(isPublicRange('5Y'), false);
});
