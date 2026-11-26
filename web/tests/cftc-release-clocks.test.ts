import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  publishedFeature,
  releasePanel,
  releaseRow,
  STUDY_CONTRACTS,
  studyReportDates,
  verifyOriginalReport,
} from '../lib/consensus/cftc-release-clocks.ts';

function item(day: string, posted: string, long = 20, code = '13874A') {
  return {
    id: day.replaceAll('-', '').slice(2) + code + 'F',
    report_date_as_yyyy_mm_dd: day + 'T00:00:00.000',
    cftc_contract_market_code: code,
    market_and_exchange_names: 'Synthetic futures market',
    contract_units: 'contracts',
    futonly_or_combined: 'FutOnly',
    open_interest_all: '100',
    asset_mgr_positions_long: String(long),
    asset_mgr_positions_short: '10',
    ':created_at': posted,
    ':updated_at': posted,
  };
}

test('uses the last published adjacent weekly pair strictly before the issued open, including a delayed Monday holiday release', () => {
  const data = [
    item('2026-06-02', '2026-06-05T19:30:00.000Z'),
    item('2026-06-09', '2026-06-12T19:30:02.000Z', 24),
    item('2026-06-16', '2026-06-22T19:30:54.000Z', 28),
  ].map(releaseRow);
  assert.equal(publishedFeature(data, '2026-06-22T13:30:00.000Z')?.date, '2026-06-09');
  assert.equal(publishedFeature(data, data[2].createdAt)?.date, '2026-06-09');
  const known = publishedFeature(data, '2026-06-23T13:30:00.000Z');
  assert.equal(known?.date, '2026-06-16');
  assert.equal(known.priorDate, '2026-06-09');
  assert.ok(Math.abs(known.value - 0.04) < 1e-14);
  assert.equal(publishedFeature(data, '2026-06-05T19:30:00.000Z'), null);
});

test('withholds later revisions of either selected input and handles unpublished backlog reports in observation order', () => {
  const data = [
    item('2025-09-23', '2025-09-26T19:30:00.000Z'),
    item('2025-09-30', '2025-11-19T20:30:44.000Z'),
    item('2025-10-07', '2025-11-21T20:30:45.000Z'),
  ].map(releaseRow);
  assert.equal(publishedFeature(data, '2025-10-15T13:30:00.000Z'), null);
  assert.equal(publishedFeature(data, '2025-11-21T14:30:00.000Z')?.date, '2025-09-30');
  const revised = { ...data[1], updatedAt: '2025-11-26T20:30:00.000Z' };
  assert.equal(publishedFeature([data[0], revised, data[2]], '2025-11-21T14:30:00.000Z'), null);
  assert.equal(publishedFeature([data[0], revised, data[2]], '2025-11-24T14:30:00.000Z'), null);
  assert.equal(publishedFeature([data[0], revised, data[2]], '2025-12-01T14:30:00.000Z')?.date, '2025-10-07');
});

test('requires exact contract, date, version clocks and one futures-only row per study week, including the Monday report', () => {
  const days = studyReportDates();
  assert.equal(days.length, 58);
  assert.ok(days.includes('2025-11-10'));
  assert.ok(!days.includes('2025-11-11'));
  const input = days.flatMap((day) =>
    Object.values(STUDY_CONTRACTS).map((code) =>
      item(day, new Date(Date.parse(day) + 3 * 86400000 + 20 * 3600000).toISOString(), 20, code)
    )
  );
  assert.equal(releasePanel(input).TLT.length, 58);
  assert.throws(() => releasePanel([input[0], ...input.slice(0, -1)]));
  for (const change of [
    { id: 'wrong' },
    { futonly_or_combined: 'Combined' },
    { ':updated_at': 'bad' },
    { ':updated_at': '2025-09-22T20:00:00.000Z' },
    { open_interest_all: 0 },
  ]) {
    assert.throws(() => releaseRow({ ...input[0], ...change }));
  }
});

test('corroborates the dated static financial Futures Only positions and rejects changed counts, duplicate reports or mismatched dates', () => {
  const original =
    'Financial Traders in Markets (Futures Only)\nTraders in Financial Futures - Futures Only Positions as of October 20, 2026\nDealer : Asset Manager/ : Leveraged : Other : Nonreportable :\nLong : Short : Spreading : Long : Short : Spreading : Long : Short : Spreading : Long : Short : Spreading : Long : Short :\nCFTC Code #13874A  Open Interest is 100\nPositions\n  7 8 9 20 10 3 0 4 5 6 7 8 9 10\n';
  const row = releaseRow(item('2026-10-20', '2026-10-23T19:30:08.000Z'));
  verifyOriginalReport(original, row.date, [row]);
  for (const altered of [
    original.replace(' 20 10 ', ' 21 10 '),
    original.replace('20, 2026', '27, 2026'),
    original.replace('13874A', '209742'),
    original.replace('Dealer : Asset Manager/', 'Asset Manager/ : Dealer'),
    original + original,
  ]) {
    assert.throws(() => verifyOriginalReport(altered, row.date, [row]));
  }
});
