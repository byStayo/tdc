import importlib.util
import io
import json
from contextlib import redirect_stdout
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

script = Path(__file__).resolve().parents[1] / 'scripts/research-tlt-share-counts.py'
spec = importlib.util.spec_from_file_location('share_counts', script)
counts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(counts)


def source_text(kind, day, trade, shares):
    fields = {**counts.IDENTITY, 'Basket Type': kind, 'Nav Date': day, 'Trade Date': trade,
              'Settlement Date': '2026-10-13', 'Publication Time': day + 'T22:00:00Z',
              'sharesPerUnit': '100', 'Units Outstanding': '10.0', 'Shares Outstanding': str(shares),
              'Nav Per Share': '123.450987', 'Asset Holding': 'FOO'}
    return '\n'.join(key + '   ' + value for key, value in fields.items())


def example():
    sessions = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']
    originals = []
    for index, shares in enumerate([1001, 980, 980]):
        day, trade = sessions[index:index + 2]
        for kind in counts.KINDS:
            filename = 'TLT_' + kind + '_' + day.replace('-', '') + '.pdf'
            row = counts.header(source_text(kind, day, trade, shares), filename)
            originals.append({**row, 'sha256': 'a' * 64, 'bytes': 1333})
    history = {'fund': 'TLT', 'source': counts.flows.history_url('TLT'), 'asOf': sessions[-1],
               'nativeSha256': 'b' * 64, 'firstCount': sessions[1], 'lastCount': sessions[-1],
               'publishedRows': 3, 'observations': []}
    for i, usd in enumerate([-100, 200, None]):
        history['observations'].append({'count': sessions[i + 1], 'nav': sessions[i], 'usd': usd,
                                        'issues': ['held'] if usd is None else [], 'roundTripLeg': False, 'splitAdjusted': False})
    return {'method': counts.METHOD, 'termsSha256': counts.TERMS_SHA, 'first': sessions[0],
            'last': sessions[2], 'observedAt': '2026-10-13T21:00:00Z', 'originals': originals, 'history': history}


class ShareCounts(unittest.TestCase):
    def test_explicit_collection_waits_for_the_short_session_to_close(self):
        class BeforeShortClose(datetime):
            @classmethod
            def now(cls, tz=None):
                return counts.sec.timestamp("2026-11-27T17:59:59Z").astimezone(tz)

        with patch.object(counts, "datetime", BeforeShortClose):
            with self.assertRaisesRegex(ValueError, "completed"):
                counts.expected("2026-11-25", "2026-11-27")

    def test_recent_sessions_follow_exchange_close_including_thanksgiving_half_day(self):
        for clock, limits in [
            ('2026-11-24T12:48:00Z', ('2026-11-18', '2026-11-23')),
            ('2026-11-27T17:59:59Z', ('2026-11-20', '2026-11-25')),
            ('2026-11-27T18:00:01Z', ('2026-11-23', '2026-11-27')),
        ]:
            with self.subTest(clock=clock):
                self.assertEqual(counts.latest_window(counts.sec.timestamp(clock)), limits)

    def test_repeated_scheduled_window_verifies_the_first_receipt_without_fetch(self):
        evidence = example()
        with (TemporaryDirectory() as scratch,
              patch.object(counts, 'PRIVATE', Path(scratch) / 'private'),
              patch.object(counts, 'latest_window', return_value=(evidence['first'], evidence['last'])),
              patch.object(counts, 'collect', return_value=evidence) as collect,
              patch.object(counts.sys, 'argv', ['study', '--scheduled']), redirect_stdout(io.StringIO()) as output):
            self.assertEqual(counts.main(), 0)
            first = json.loads(output.getvalue())
            output.truncate(0)
            output.seek(0)
            self.assertEqual(counts.main(), 0)
            second = json.loads(output.getvalue())
            self.assertEqual(collect.call_count, 1)
            self.assertEqual(first['privateReceipt'], second['privateReceipt'])
            self.assertFalse(first['cached'])
            self.assertTrue(second['cached'])
            self.assertEqual(second['status'], 'partial')

    def test_both_clocks_have_separate_denominators_and_zeros(self):
        evidence = example()
        result = counts.compare(evidence)['clocks']
        self.assertEqual((result['navDate']['matched'], result['navDate']['compared']), (1, 2))
        self.assertEqual((result['tradeDate']['matched'], result['tradeDate']['compared']), (0, 1))
        self.assertEqual(result['tradeDate']['missingOrFlagged'], {'2026-10-08': ['held']})
        self.assertFalse(any(key in evidence['originals'][0] for key in ('Nav Per Share', 'Asset Holding', 'ISIN', 'Name')))

    def test_primary_and_duplicate_basket_disagreement_fails(self):
        evidence = example()
        evidence['originals'][0]['sharesOutstanding'] += 1
        with self.assertRaisesRegex(ValueError, 'disagree'):
            counts.compare(evidence)
        evidence['originals'][0] = evidence['originals'][1].copy()
        with self.assertRaisesRegex(ValueError, 'duplicated'):
            counts.compare(evidence)

    def test_missing_new_delivery_preserves_previously_verified_day(self):
        evidence = example()
        day = evidence['first']
        with TemporaryDirectory() as scratch:
            parent = Path(scratch)
            old = parent / 'issuer-dates' / (day + '.json')
            counts.write_once(old, {'termsSha256': counts.TERMS_SHA, 'verifiedAt': evidence['observedAt'],
                                    'originals': evidence['originals'][:2]})
            original = old.read_bytes()
            with (patch.object(counts, 'connect', return_value=object()),
                  patch.object(counts, 'pdf_bytes', side_effect=counts.Pending('not delivered')) as fetch,
                  patch.object(counts.flows, 'fetch') as etfiq, self.assertRaises(counts.Pending)):
                counts.collect(day, '2026-10-06', parent)
            self.assertEqual(fetch.call_count, 1)
            self.assertFalse(etfiq.called)
            self.assertEqual(old.read_bytes(), original)
            self.assertFalse((old.parent / '2026-10-06.json').exists())

    def test_splits_and_roundtrip_rows_are_excluded_without_selecting_alternative(self):
        evidence = example()
        evidence['history']['observations'][0]['splitAdjusted'] = True
        evidence['history']['observations'][1]['roundTripLeg'] = True
        clocks = counts.compare(evidence)['clocks']
        self.assertEqual(clocks['navDate']['compared'], 0)
        self.assertEqual(clocks['navDate']['missingOrFlagged']['2026-10-06'], ['split'])
        self.assertEqual(clocks['tradeDate']['missingOrFlagged']['2026-10-07'], ['round-trip'])

    def test_source_identity_date_duplicate_and_unbounded_range_are_rejected(self):
        name = 'TLT_DELIVERABLE_20261005.pdf'
        data = source_text('DELIVERABLE', '2026-10-05', '2026-10-06', 1221)
        for invalid in (data.replace('US4642874329', 'other'), data.replace('2026-10-05', '2026-10-04'),
                        data + '\nShares Outstanding   900', data.replace('1221', '1221.2')):
            with self.subTest(invalid=invalid[-20:]), self.assertRaises(ValueError):
                counts.header(invalid, name)
        with self.assertRaises(ValueError):
            counts.expected('2026-09-01', '2026-10-05')

    def test_foreign_download_form_or_changed_terms_never_receives_credentials(self):
        form = b"New Token Landing Page form.setAttribute('method','POST'); form.setAttribute('action','https://example.test/');"
        with patch.object(counts, 'get', return_value=form) as get:
            with self.assertRaisesRegex(ValueError, 'navigation'):
                counts.pdf_bytes(None, 'TLT_DELIVERABLE_20261005.pdf')
            self.assertEqual(get.call_count, 1)
        with patch.object(counts, 'get', return_value=b'changed terms') as get:
            with self.assertRaisesRegex(ValueError, 'terms'):
                counts.connect()
            self.assertEqual(get.call_count, 1)


if __name__ == '__main__':
    unittest.main()
