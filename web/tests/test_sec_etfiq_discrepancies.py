import importlib.util
import tempfile
import unittest
from copy import deepcopy
from decimal import Decimal
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "diagnose-sec-etfiq-discrepancies.py"
spec = importlib.util.spec_from_file_location("flow_discrepancy", SCRIPT)
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)


def sample():
    # A monthly calculation expressed using its true independent, later share-count date.
    pairs = {"2026-05-29": "2026-06-01", "2026-06-30": "2026-07-01", "2026-07-31": "2026-08-03"}
    issuer = {"accession": "fixture", "form": "NPORT-P", "filed": "2026-10-22"}
    slots = [{"sales": Decimal(s), "redemption": Decimal(0), "reinvestment": Decimal(1)} for s in ("8.2", "26.8", "49")]
    rows, monthly = [], []
    for (nav, count), displayed, independently_rounded, issuer_tag in zip(pairs.items(), (10, 0, 50), (10, 0, 49), (9, 28, 50)):
        rows.append({"count": count, "nav": nav, "usd": displayed, "issues": [],
                     "roundTripLeg": False, "splitAdjusted": False})
        monthly.extend([{"src": "nport", "m": count[:7], "flow": issuer_tag, "scope": "fund", **issuer},
                        {"src": "daily", "m": count[:7], "flow": independently_rounded, "days": 1, "of": 1,
                         "from": count, "to": count}])
    supplemental = {"monthly": monthly, "nativeSha256": "pinned", "providerCheck":
                    {"m": "2026-08", "daily": 49, "nport": 50, "agree": False}}
    return issuer, list(reversed(slots)), {"observations": rows, "nativeSha256": "pinned"}, supplemental, pairs


class DiscrepancyTest(unittest.TestCase):
    def test_filed_months_only_annotate_and_daily_rows_control_each_difference(self):
        rows = study.by_month(*sample())
        self.assertEqual([row["displayedDailyMinusIssuerNetUsd"] for row in rows], ["1.8", "-26.8", "1"])
        self.assertEqual([row["displayedDailyMinusProviderMonthUsd"] for row in rows], [0, 0, 1])
        self.assertEqual([row["zeroDays"] for row in rows], [0, 1, 0])
        self.assertEqual([row["distributionReinvestmentUsd"] for row in rows], ["1", "1", "1"])

    def test_no_month_assignment_for_a_different_receipt_or_ambiguous_filing(self):
        for change in ("different-native-source", "different-accession", "duplicate-month", "ambiguous-amount"):
            with self.subTest(change=change):
                issuer, slots, native, sup, pairs = sample()
                if change == "different-native-source":
                    sup["nativeSha256"] = "new"
                elif change == "different-accession":
                    sup["monthly"][0]["accession"] = "other"
                elif change == "duplicate-month":
                    sup["monthly"].append(deepcopy(sup["monthly"][0]))
                else:
                    slots[0] = deepcopy(slots[-1])
                with self.assertRaises(ValueError):
                    study.by_month(issuer, slots, native, sup, pairs)

    def test_held_or_missing_days_and_inconsistent_aggregate_stay_unresolved(self):
        for change in ("held", "missing", "duplicate", "wrong-period", "different-self-check", "non-boolean-check"):
            with self.subTest(change=change):
                issuer, slots, native, sup, pairs = sample()
                if change == "held":
                    native["observations"][0]["issues"] = ["held"]
                    native["observations"][0]["usd"] = None
                elif change == "missing":
                    native["observations"].pop(0)
                elif change == "duplicate":
                    native["observations"].append(deepcopy(native["observations"][0]))
                elif change == "wrong-period":
                    sup["monthly"][1]["to"] = "2026-06-02"
                elif change == "different-self-check":
                    sup["providerCheck"]["daily"] = 50
                else:
                    sup["providerCheck"]["agree"] = "false"
                with self.assertRaises(ValueError):
                    study.by_month(issuer, slots, native, sup, pairs)

    def test_independent_balance_is_bound_to_the_dated_funds_assets_statement(self):
        html = (b'<h2>Statement of Assets and Liabilities March 31, 2026 (Unaudited) Invesco QQQ Trust</h2>'
                b'<p>Shares outstanding (unlimited amount authorized, $0.01 par value) 123,456 '
                b'Net asset value $ 12.34 Market price $ 56.78 See accompanying Notes</p><p>C000271435Member</p>')
        self.assertEqual(study.opening_balance(html, "2026-03-31"), {"shares": 123456, "navUsd": "12.34"})
        for source, period in ((html, "2026-06-30"), (html.replace(b"C000271435Member", b"other"), "2026-03-31"),
                               (html.replace(b"Net asset value", b"Fair value"), "2026-03-31")):
            with self.assertRaises(ValueError):
                study.opening_balance(source, period)

    def test_semiannual_transactions_reconcile_to_the_correct_column_and_contiguous_period(self):
        first_header = ("Six Months Ended 08/31/26 Year Ended 02/28/26 iShares ETF Shares Amount Shares Amount ")
        note = ("20+ Year Treasury Bond Shares sold 123,000 $ 456,000 789,000 $ 900,000 "
                "Shares redeemed ( 100,000 ) ( 250,000 ) ( 655,000 ) ( 800,000 ) 23,000 $ 206,000 ")
        second_header = ("iShares 10-20 Year Treasury Bond ETF iShares 20+ Year Treasury Bond ETF "
                         "Six Months Ended 08/31/26 (unaudited) Year Ended 02/28/26 "
                         "Six Months Ended 08/31/26 (unaudited) Year Ended 02/28/26 ")
        statement = ("Net increase (decrease) in net assets derived from capital share transactions "
                     "......... (871,000) 981,000 206,000 (445,000) NET ASSETS Total increase ")
        fee = "additional variable charge. Such variable charges, if any, are included in shares sold."
        source = first_header + note + second_header + statement + fee
        got = study.capital_statement(source.encode())
        self.assertEqual(got["netShares"], 23000)
        self.assertEqual(got["netCapitalTransactionsUsd"], 206000)
        self.assertTrue(got["variableChargesIfAnyIncludedInSharesSold"])
        for before, after in [(" 206,000 (445,000)", " 206,001 (445,000)"), (" 23,000 $", " 24,000 $"),
                              ("Six Months Ended", "Year Ended"), ("20+ Year Treasury", "25+ Year Treasury"),
                              ("Such variable charges", "No such disclosure")]:
            with self.subTest(before=before), self.assertRaises(ValueError):
                study.capital_statement(source.replace(before, after).encode())

    def test_pinned_private_sources_cannot_be_replaced_by_new_vendor_revisions(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "private"
            original = b"frozen exact"
            digest = study.quarter.sha(original)
            self.assertEqual(study.checked_file(path, digest, 100, lambda: original), original)
            self.assertEqual(study.checked_file(path, digest, 100, lambda: self.fail("fetched again")), original)
            path.write_bytes(b"altered")
            with self.assertRaises(ValueError):
                study.checked_file(path, digest, 100, lambda: self.fail("mutated an original"))
            path.unlink()
            with self.assertRaises(ValueError):
                study.checked_file(path, digest, 100, lambda: b"new upstream")
            self.assertFalse(path.exists())
            self.assertEqual(study.checked_file(path, digest, 100, lambda: original, compressed=True), original)
            self.assertNotEqual(path.read_bytes(), original)
            self.assertEqual(study.checked_file(path, digest, 100, compressed=True), original)
            with self.assertRaises(ValueError):
                study.checked_file(path, digest, 3, compressed=True)


if __name__ == "__main__":
    unittest.main()
