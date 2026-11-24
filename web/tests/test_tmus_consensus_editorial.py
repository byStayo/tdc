import importlib.util
import hashlib
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


script = Path(__file__).resolve().parents[1] / "scripts" / "review_tmus_consensus.py"
spec = importlib.util.spec_from_file_location("tmus_editorial", script)
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


def rows():
    headers, revenue = {"B": "Q3"}, {"A": "Gross revs in $ (US GAAP)"}
    for i, start in enumerate("BGLQV"):
        headers[start] = "Q3" if i == 0 else f"FY {25 + i:02d}"
        for delta, stat in enumerate(review.STATISTICS, 1):
            headers[chr(ord(start) + delta)] = stat
        for delta, value in enumerate([106, 11, 110, 102, 105]):
            revenue[chr(ord(start) + delta)] = str(value)
    return {1: headers, 6: {"A": "Gross Revs [€ million]"}, 7: {"A": "TMUS (gross revs in €)"},
            8: revenue, 9: {"A": "Service revs in $ (US GAAP)"}}


def concept(*entries):
    return {"cik": 1283699, "taxonomy": "us-gaap", "tag": "RevenueFromContractWithCustomerExcludingAssessedTax",
            "units": {"USD": list(entries)}}


class EditorTest(unittest.TestCase):
    def test_revenue_and_annual_targets_have_their_own_basis_and_statistic(self):
        recognized = review.workbook_values(rows(), (2026, 3))
        self.assertEqual(recognized["Q3"], {"medianUsdMillions": 106, "analysts": 11})
        self.assertEqual(set(recognized), {"Q3", "FY 26", "FY 27", "FY 28", "FY 29"})
        for row, column, wrong in [(7, "A", "Germany"), (8, "A", "Net revenues (IFRS)"),
                                    (1, "G", "FY 27"), (1, "F", "Median"), (8, "C", "1"),
                                    (8, "D", "90"), (8, "B", "nan")]:
            with self.subTest(wrong=wrong):
                altered = rows()
                altered[row][column] = wrong
                with self.assertRaises(ValueError):
                    review.workbook_values(altered, (2026, 3))

    def test_uses_original_tmus_quarter_and_conservative_filing_day(self):
        survey = {"year": 2026, "quarter": 3, "printedDate": "2026-10-23"}
        first = {"start": "2026-07-01", "end": "2026-09-30", "fy": 2026, "fp": "Q3",
                 "form": "10-Q", "filed": "2026-10-28", "accn": "0001234567-26-000123", "val": 111_000_000}
        amended = dict(first, form="10-Q/A", filed="2026-11-23", val=999_000_000)
        year_to_date = dict(first, start="2026-01-01", val=399_000_000)
        data = concept(amended, year_to_date, first)
        self.assertIsNone(review.first_quarter_actual(data, survey, date(2026, 10, 28)))
        chosen = review.first_quarter_actual(data, survey, date(2026, 10, 29))
        self.assertEqual(chosen["usdMillions"], 111)
        self.assertIn(first["accn"], chosen["original"])
        self.assertIsNone(review.first_quarter_actual(concept(amended, year_to_date), survey, date(2027, 1, 1)))
        with self.assertRaises(ValueError):
            review.first_quarter_actual(concept(first, dict(first, val=222_000_000)), survey, date(2027, 1, 1))
        with self.assertRaises(ValueError):
            review.first_quarter_actual(data, dict(survey, printedDate="2026-10-29"), date(2027, 1, 1))

    def test_both_native_renderings_must_agree_on_date_currency_count_and_rounded_median(self):
        fixture = rows()
        fixture[1]["A"] = "Fixture notice"
        notice_hash = hashlib.sha256(b"Fixture notice").hexdigest()
        for column in ("B", "G", "L", "Q", "V"):
            for offset, value in enumerate([21106, 11, 21110, 21102, 21105]):
                fixture[8][chr(ord(column) + offset)] = str(value)
        printable = "\n".join([
            "Consensus Details Q3 and FY 2026 - 2030",
            "Gross revs in $ (US GAAP)  " + "  ".join(["21.106 11 21.110 21.102 21.105"] * 5),
            "23.10.2026",
        ])
        with patch.object(review, "WORKBOOK_NOTICE_SHA", notice_hash), patch.object(
                review, "worksheet", return_value=(fixture, date(2026, 10, 23))):
            with patch.object(review.subprocess, "run", return_value=SimpleNamespace(stdout=printable.encode())):
                result = review.verify_pair((2026, 3), b"fixture", b"%PDF fixture")
                self.assertEqual(result["estimates"]["FY 26"]["analysts"], 11)
            for char, wrong in [("23.10", "22.10"), ("Q3", "Q2"), ("21.106", "21.120"),
                                ("11 21.110", "8 21.110"), ("in $", "in €")]:
                with self.subTest(wrong=wrong), self.assertRaises(ValueError), patch.object(
                    review.subprocess, "run", return_value=SimpleNamespace(stdout=printable.replace(char, wrong).encode())
                ):
                    review.verify_pair((2026, 3), b"fixture", b"%PDF fixture")

    def test_source_selection_requires_native_paired_and_adjacent_surveys(self):
        def anchors(q):
            return "".join(
                f'<a href="https://corporate-media.telekom.com/adobe/assets/q{q}/original/as/dt-26q{q}-consensus-doc.{ext}?attachment=true">Download</a>'
                for ext in ("xlsx", "pdf"))
        latest, previous, early = anchors(3), anchors(2), anchors(1)
        self.assertEqual([p for p, _ in review.select_pairs((early + latest + previous).encode(), latest.encode())],
                         [(2026, 2), (2026, 3)])
        self.assertEqual([p for p, _ in review.select_pairs((early + latest).encode(), latest.encode())], [(2026, 3)])
        with self.assertRaises(ValueError):
            review.select_pairs((previous + latest).encode(), latest.replace(".pdf", ".zip").encode())
        self.assertIsNone(review.attachment_period("https://other.example/file/dt-26q3-consensus-doc.xlsx"))

    def test_revocable_editorial_licence_cannot_silently_change(self):
        text = b"for journalistic and editorial purposes. Revoke any granted right of use. You may not use the content to train AI systems."
        terms = b"<main>" + text + b"</main>"
        method = b"The consensus is the median. It cites various analysts and is not intended to constitute investment advice."
        with patch.object(review, "MEDIA_TERMS_SHA", hashlib.sha256(text).hexdigest()):
            review.consent_and_method(terms, method)
            for changed in [terms.replace(b"journalistic", b""), terms.replace(b"Revoke", b"May use"),
                            terms.replace(b"</main>", b" Additional restriction.</main>")]:
                with self.subTest(changed=changed), self.assertRaises(ValueError):
                    review.consent_and_method(changed, method)


if __name__ == "__main__":
    unittest.main()
