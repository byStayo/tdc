import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import qualify_txn_eps as q

RELEASE = """
TI reports third quarter 2026 financial results.
Earnings per share included a 1-cent reduction that was not in the company's original guidance.
TI's fourth quarter outlook is for revenue in the range of $5.80 billion to $6.30 billion
and earnings per share between $2.45 and $2.79.
Consolidated Statements of Income For Three Months Ended September 30, (In millions) 2026 2025
Revenue $ 6,055 $ 4,742 Diluted earnings per common share $ 2.62 $ 1.48
""".replace("\n", " ")

XML = b"""<xbrl xmlns="http://www.xbrl.org/2003/instance"
 xmlns:dei="http://xbrl.sec.gov/dei/2026" xmlns:g="http://fasb.org/us-gaap/2026"
 xmlns:iso="http://www.xbrl.org/2003/iso4217">
 <context id="q"><entity><identifier scheme="http://www.sec.gov/CIK">0000097476</identifier></entity>
 <period><startDate>2026-07-01</startDate><endDate>2026-09-30</endDate></period></context>
 <unit id="u"><divide><unitNumerator><measure>iso:USD</measure></unitNumerator>
 <unitDenominator><measure>shares</measure></unitDenominator></divide></unit>
 <dei:DocumentType contextRef="q">10-Q</dei:DocumentType>
 <dei:DocumentPeriodEndDate contextRef="q">2026-09-30</dei:DocumentPeriodEndDate>
 <dei:EntityCentralIndexKey contextRef="q">0000097476</dei:EntityCentralIndexKey>
 <g:EarningsPerShareDiluted contextRef="q" unitRef="u">2.62</g:EarningsPerShareDiluted></xbrl>"""


class EarningsSourceTest(unittest.TestCase):
    def test_original_range_and_separate_disclosed_item(self):
        values = q.issuer_values(RELEASE, 2026, 3)
        self.assertEqual(values, {"actualEpsCents": 262, "issuerUnplannedCents": -1,
                                  "nextEpsRangeCents": [245, 279], "actualRevenueMillions": 6055,
                                  "nextRevenueRangeMillions": [5800, 6300]})
        self.assertEqual(q.issuer_values(RELEASE.replace("$2.45 and $2.79.", "245 and 279 cents,"),
                                         2026, 3)["nextEpsRangeCents"], [245, 279])
        for original, wrong in [("third quarter", "second quarter"), ("fourth quarter", "first quarter"),
                                ("September 30", "June 30"), ("Diluted earnings", "Adjusted earnings"),
                                ("earnings per share between", "adjusted earnings per share between")]:
            with self.subTest(wrong=wrong), self.assertRaises(ValueError):
                q.issuer_values(RELEASE.replace(original, wrong), 2026, 3)
        self.assertIsNone(q.issuer_bridge("No comment about unusual items."))
        self.assertIsNone(q.issuer_bridge("Earnings per share included 5 cents not in original guidance."))
        self.assertIsNone(q.issuer_bridge("Earnings per share included a 5-cent benefit and a 2-cent expense not in original guidance."))
        self.assertEqual(q.issuer_bridge("Earnings per share included a 5-cent benefit not in original guidance."), 5)

    def test_exact_period_accession_units_and_quarterly_gaap_fact(self):
        statutory = {"accessionNumber": "test", "form": "10-K", "filingDate": "2027-02-05"}
        annual = {"accn": "test", "form": "10-K", "filed": "2027-02-05", "fy": 2026, "fp": "FY",
                  "start": "2026-01-01", "end": "2026-12-31", "val": "9.99"}
        nine_months = {**annual, "end": "2026-09-30", "val": "6.44"}
        match = {**annual, "start": "2026-10-01", "val": "2.61"}
        args = (statutory, 2026, 4, "2026-10-01", "2026-12-31")
        self.assertIsNone(q.original_quarter_fact([annual, nine_months, {**match, "accn": "later-10ka"}], *args))
        self.assertEqual(q.original_quarter_fact([annual, match], *args), 261)
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            q.original_quarter_fact([match, {**match, "val": "2.60"}], *args)
        self.assertEqual(q.current_native_eps(XML, "2026-07-01", "2026-09-30"), 262)
        for original, wrong in [(b"iso:USD", b"iso:EUR"), (b">shares<", b">pure<"),
                                (b"2026-07-01", b"2026-01-01"), (b"0000097476", b"0000002488"),
                                (b"</entity>", b"<segment>division</segment></entity>"),
                                (b"PerShareDiluted", b"PerShareBasic")]:
            with self.subTest(wrong=wrong), self.assertRaises(ValueError):
                q.current_native_eps(XML.replace(original, wrong), "2026-07-01", "2026-09-30")

    def test_source_only_range_counts(self):
        row = {"statutoryQuarterlyEpsConfirmed": True, "actualEpsCents": 260, "priorEpsRangeCents": [225, 259],
               "actualRevenueMillions": 6055, "priorRevenueRangeMillions": [5650, 6150], "issuerUnplannedCents": 1}
        counts, changes = q.range_counts([row, {**row, "statutoryQuarterlyEpsConfirmed": False},
                                          {**row, "issuerUnplannedCents": None}])
        self.assertEqual(counts, {"within revenue, above EPS": 2})
        self.assertEqual(changes, 1)

    def test_raw_source_identity_hash_and_capture_clock_are_checked(self):
        import gzip
        with TemporaryDirectory() as folder:
            store = Path(folder)
            raw = b'{"fixture":true}'
            digest = q.hashed(raw)
            data = store / "native.gz"
            data.write_bytes(gzip.compress(raw))
            data.chmod(0o600)
            meta = store / "source.json"
            url = "https://data.sec.gov/locked-file.json"
            q.seal(meta, {"url": url, "sha256": digest, "receivedAt": "2026-11-24T17:30:00Z"})
            clock = datetime(2026, 11, 24, 18, tzinfo=timezone.utc)
            self.assertEqual(q.document(meta, url, digest, data, clock)[0], raw)
            with self.assertRaisesRegex(ValueError, "identity"):
                q.document(meta, url + "?other", digest, data, clock)
            with self.assertRaisesRegex(ValueError, "clock"):
                q.document(meta, url, digest, data, datetime(2026, 11, 23, tzinfo=timezone.utc))
            data.write_bytes(gzip.compress(b"altered"))
            with self.assertRaisesRegex(ValueError, "bytes"):
                q.document(meta, url, digest, data, clock)

    def test_pre_quarter_end_witness_uses_real_clock_and_preserves_original(self):
        report = {"privateSourceAuditAt": "2026-11-24T17:00:00Z", "latest": {
            "resultsAccession": "r", "statutoryAccession": "s", "periodEnd": "2026-09-30",
            "nextEpsRangeCents": [245, 279], "nextRevenueRangeMillions": [5800, 6300],
            "actualEpsCents": 262, "actualRevenueMillions": 6055}}
        data = {"cik": "0000097476", "filings": {"recent": {"accessionNumber": ["r", "s"], "form": ["8-K","10-Q"],
                "items": ["2.02",""], "filingDate": ["2026-10-21","2026-10-23"], "reportDate": ["2026-10-21","2026-09-30"],
                "acceptanceDateTime": ["2026-10-21T20:00:00Z","2026-10-23T17:00:00Z"]}}}
        early = datetime(2026, 11, 24, 18, tzinfo=timezone.utc)
        late = datetime(2027, 1, 1, 18, tzinfo=timezone.utc)
        with TemporaryDirectory() as folder, patch.object(q, "fresh_source", return_value=(
                q.json.dumps(data).encode(), "2026-11-24T17:30:00Z", "a" * 64)):
            store = Path(folder)
            q.seal(store / "source-qualification.json", report)
            with self.assertRaisesRegex(ValueError, "precede"):
                q.witness(store, report, late, True)
            self.assertFalse((store / "forward-2026-Q4.json").exists())
            first = q.witness(store, report, early, True)
            self.assertEqual(q.witness(store, report, late, False), first)
            altered = {**report, "latest": {**report["latest"], "nextEpsRangeCents": [245, 300]}}
            with self.assertRaisesRegex(ValueError, "witness"):
                q.witness(store, altered, late, False)


if __name__ == "__main__":
    unittest.main()
