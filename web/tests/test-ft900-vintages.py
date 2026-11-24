"""Offline, synthetic tests for the source-only FT900 verifier."""
import datetime as dt
import gzip
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify-ft900-vintages.py"
spec = importlib.util.spec_from_file_location("ft900_verifier", SCRIPT)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
SEALED_AT = dt.datetime(2026, 11, 23, tzinfo=dt.timezone.utc)


def write(path, value):
    path.write_bytes(value if isinstance(value, bytes) else json.dumps(value).encode())
    path.chmod(0o600)


def numbers(exports):
    imports, exported_goods, imported_goods = 12_000, 6_000, 8_000
    return " ".join(str(n) for n in (
        exports - imports, exported_goods - imported_goods, exports - exported_goods - imports + imported_goods,
        exports, exported_goods, exports - exported_goods, imports, imported_goods, imports - imported_goods))


EXHIBIT = "\n".join((
    "Part A: Seasonally Adjusted (by Commodity/Service)",
    "Exhibit 1. U.S. International Trade in Goods and Services",
    "In millions of dollars. Balance Exports Imports",
    "2018", f"December (R) {numbers(8_800)}",
    "2019", f"January {numbers(9_100)}", "December",
    "December data as published last month:", numbers(8_700),
    "(1) Data are presented on a balance of payments (BOP) basis.",
))
RELEASE = (
    "FOR RELEASE AT 8:30 AM EST, Friday, February 1, 2019 "
    "U.S. International Trade in Goods and Services, January 2019 "
    "U.S. Census Bureau and U.S. Bureau of Economic Analysis. "
    "January exports were $9.1 billion, $0.3 billion more than December exports."
)


class VintageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.src = self.root / "sources"
        self.src.mkdir(mode=0o700)
        self.raw = RELEASE
        self.census = {
            "period": "2019-01", "pdfURL": audit.CENSUS_PDF + "1901.pdf", "pdfSHA256": "a" * 64,
            "firstPage": RELEASE, "exhibitOne": EXHIBIT, "capturedAt": "2026-11-24T04:00:00Z",
            "beaURL": "https://www.bea.gov/news/2019/us-international-trade-goods-and-services-january-2019",
        }

    def save(self):
        web = ("<main>" + self.raw + "</main>").encode()
        self.census["beaSHA256"] = audit.signature(web)
        write(self.src / "2019-01.html.gz", gzip.compress(web, mtime=0))
        write(self.src / "2019-01.json", self.census)

    def receive(self):
        return audit.read_release(self.src, "2019-01", SEALED_AT)[0]

    def test_january_uses_the_previous_calendar_year_in_the_same_release(self):
        self.save()
        row = self.receive()
        self.assertEqual(row["previousInThisVintageMillions"], 8_800)
        self.assertEqual(row["previousAsPublishedLastMonthMillions"], 8_700)
        self.assertEqual(row["monthlyExportHeadlineMillions"], 9_100)
        self.assertEqual(row["changeOrBoundMillions"], 300)
        self.assertTrue(row["yearBoundary"])
        self.assertEqual(audit.summarize({"2019-01": row})["wrongVintagesOutsideHeadlineResolution"], ["2019-01"])
        self.census["exhibitOne"] = EXHIBIT.replace(numbers(8_800), numbers(8_700))
        self.save()
        with self.assertRaisesRegex(ValueError, "difference"):
            self.receive()

    def test_monthly_title_and_magnitude_only_are_kept_separate_from_annual_summary(self):
        audit.month_mentioned("U.S. International Trade in Goods and Services, December and Annual 2022", (2022, 12))
        with self.assertRaisesRegex(ValueError, "reference period"):
            audit.month_mentioned("U.S. International Trade in Goods and Services, July 2019. "
                                  "Next: U.S. International Trade in Goods and Services, August 2019", (2019, 8))
        self.raw = RELEASE.replace("$0.3 billion more than", "down less than $0.1 billion from")
        self.census["firstPage"] = self.raw
        self.census["exhibitOne"] = EXHIBIT.replace(numbers(8_800), numbers(9_140))
        self.save()
        row = self.receive()
        self.assertEqual(row["kind"], "strict-bound")
        self.assertEqual(audit.summarize({"2019-01": row})["boundedExcluded"], ["2019-01"])

    def test_true_weekday_and_dst_are_validated_independently(self):
        stamp, _ = audit.date_check("FOR RELEASE AT 8:30 AM, EST, Friday, February 1,2019")
        self.assertEqual(stamp, "2019-02-01T08:30:00-05:00")
        with self.assertRaisesRegex(ValueError, "offset"):
            audit.date_check("FOR RELEASE AT 8:30 AM EDT, Friday, February 1, 2019")
        with self.assertRaisesRegex(ValueError, "weekday"):
            audit.date_check("FOR RELEASE AT 8:30 AM EST, Thursday, February 1, 2019")

    def test_bea_typo_requires_the_two_earlier_calendars_and_exact_time(self):
        self.raw = RELEASE.replace("Friday", "Thursday")
        self.save()
        with self.assertRaises(FileNotFoundError):
            self.receive()
        previous = ("FOR RELEASE AT 8:30 AM EST, Friday, January 4, 2019 "
                    "Next release: Friday, February 1, 2019. Next release: February 1, 2019, at 8:30 a.m. EST")
        meta = {"firstPage": previous, "pdfSHA256": "f" * 64, "beaURL": "https://www.bea.gov/news/2019/previous"}
        for present in (True, False):
            raw = (previous if present else previous.replace("8:30 a.m.", "9:30 a.m.")).encode()
            write(self.src / "2018-12.html.gz", gzip.compress(raw, mtime=0))
            meta["beaSHA256"] = audit.signature(raw)
            write(self.src / "2018-12.json", meta)
            if present:
                self.assertEqual(self.receive()["weekdayControl"]["incorrectBEAWeekday"], ["Thursday"])
            else:
                with self.assertRaisesRegex(ValueError, "earlier release calendars"):
                    self.receive()

    def test_unreviewed_changed_or_disappeared_correction_fails_closed(self):
        for period, text in (
            ("2019-01", "ERRATA Exhibit 1 revised."),
            ("2017-01", "ERRATA Exhibits 20 and 20b, Saudi Arabia, March 22, 2017. Exhibit 1 changed, too."),
            ("2025-12", "Monthly release without original correction banner")):
            with self.subTest(period=period), self.assertRaisesRegex(ValueError, "correction"):
                audit.reviewed_erratum(period, text, "")
        with self.assertRaisesRegex(ValueError, "Census"):
            audit.reviewed_erratum("2019-01", "", "Correction notice: Exhibit 1 updated")

    def test_hash_issuer_and_capture_chronology(self):
        self.save()
        write(self.src / "2019-01.html.gz", gzip.compress(b"alternate text"))
        with self.assertRaisesRegex(ValueError, "hash"):
            self.receive()
        self.census["beaURL"] += "?v=latest"
        self.save()
        with self.assertRaisesRegex(ValueError, "BEA release URL"):
            self.receive()
        self.census["beaURL"] = self.census["beaURL"].split("?")[0]
        self.census["capturedAt"] = "2026-11-01T04:00:00Z"
        self.save()
        with self.assertRaisesRegex(ValueError, "chronology"):
            self.receive()

    def test_missing_month_and_policy_mismatch_leave_validated_receipt_untouched(self):
        policy = json.loads(audit.POLICY.read_bytes())
        seal = {"spec": policy, "sha256": audit.signature(audit.canonical(policy)), "createdAt": SEALED_AT.isoformat()}
        write(self.root / "policy.json", seal)
        write(self.root / "archive-index.html.gz", gzip.compress((audit.CENSUS_PDF + "1511.pdf").encode()))
        receipt = self.root / "independent-table-audit.json"
        write(receipt, b"previously verified receipt")
        with self.assertRaisesRegex(ValueError, "2015-11"):
            audit.run(self.root, audit.POLICY)
        self.assertEqual(receipt.read_bytes(), b"previously verified receipt")
        seal["sha256"] = "0" * 64
        write(self.root / "policy.json", seal)
        with self.assertRaisesRegex(ValueError, "seal mismatch"):
            audit.run(self.root, audit.POLICY)
        self.assertEqual(receipt.read_bytes(), b"previously verified receipt")

    def test_private_atomic_receipt_and_idempotent_replay(self):
        path = self.root / "independent-table-audit.json"
        audit.record_receipt(self.root, {"synthetic": "first"})
        original = (path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        audit.record_receipt(self.root, {"synthetic": "first"})
        self.assertEqual((path.read_bytes(), path.stat().st_ino, path.stat().st_mtime_ns), original)
        with patch.object(os, "replace", side_effect=OSError("simulated interrupted commit")):
            with self.assertRaisesRegex(OSError, "interrupted"):
                audit.record_receipt(self.root, {"synthetic": "second"})
        self.assertEqual(path.read_bytes(), original[0])
        self.assertEqual({p.name for p in self.root.iterdir()}, {"sources", path.name})
        path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "owner-only"):
            audit.record_receipt(self.root, {"synthetic": "second"})


if __name__ == "__main__":
    unittest.main()
