"""Synthetic source and timing regressions for the private US corporate-profit comparison."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from io import BytesIO, StringIO
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError
from xml.etree import ElementTree as ET
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import qualify_spf_profits as study


POLICY = json.loads(study.POLICY_FILE.read_bytes())
Q2 = POLICY["completedExample"]
Q3 = POLICY["prospective"]
HEAD = "TABLE ONE\nMAJOR MACROECONOMIC INDICATORS\nMEDIANS OF FORECASTER PREDICTIONS\n"
PDF = "Release Date: August 14, 2026\n" + HEAD + """
 OF     2026 2026 2026 2027
 FORECASTERS     Q2 Q3 Q4 Q1
 3. CORPORATE PROFITS AFTER TAXES    2   N.A.   3010.0  5555.0 6000.0
       ($ BILLIONS)
 TABLE TWO
 3. CORPORATE PROFITS AFTER TAXES  2  3.1  4.6
"""


def workbook(name, data):
    """A minimal actual XLSX file, with fully qualified relationships and shared strings."""
    n = study.N
    root = ET.Element(n + "workbook")
    sheets = ET.SubElement(root, n + "sheets")
    ET.SubElement(sheets, n + "sheet", {"name": name, study.R + "id": "rId1"})
    rel = ET.Element("Relationships")
    ET.SubElement(rel, "Relationship", {"Id": "rId1", "Target": "worksheets/sheet1.xml"})
    worksheet = ET.Element(n + "worksheet")
    cells = ET.SubElement(worksheet, n + "sheetData")
    strings = ET.Element(n + "sst")
    for i, values in enumerate(data, 1):
        row = ET.SubElement(cells, n + "row", {"r": str(i)})
        for j, value in enumerate(values):
            if value is None:
                continue
            attrs = {"r": f"{chr(65 + j)}{i}"}
            text = str(value)
            if isinstance(value, str):
                attrs["t"] = "s"
                text = str(len(strings))
                ET.SubElement(ET.SubElement(strings, n + "si"), n + "t").text = value
            ET.SubElement(ET.SubElement(row, n + "c", attrs), n + "v").text = text
    buffer = BytesIO()
    with ZipFile(buffer, "w") as bundle:
        for path, node in [("xl/workbook.xml", root), ("xl/_rels/workbook.xml.rels", rel),
                           ("xl/worksheets/sheet1.xml", worksheet), ("xl/sharedStrings.xml", strings)]:
            bundle.writestr(path, ET.tostring(node))
    return buffer.getvalue()


def medians(level=3010):
    return workbook("Median_Level", [["YEAR", "QUARTER", "CPROF1", "CPROF2", "CPROF3"],
                                     [2026, 3, 9000, level, 5555]])


def people(repeated=False):
    return workbook("CPROF", [["YEAR", "QUARTER", "ID", "INDUSTRY", "CPROF1", "CPROF2"],
                              [2026, 3, 1, 1, 9000, 3000], [2026, 3, 1 if repeated else 2, 2, 9050, 3020],
                              [2026, 3, 3, 2, 7750, "#N/A"], [2026, 4, 4, 1, 1222, 1100]])


def nipa_sheet(label="Profits after tax with IVA and CCAdj", quarter_value=".....", stamp="October 29, 2026"):
    return workbook("T11200-Q", [
        ["Table 1.12. National Income by Type of Income"], ["[Millions of dollars] Seasonally adjusted at annual rates"],
        ["Quarterly data"], ["Bureau of Economic Analysis"], ["Data published " + stamp],
        ["Line", None, None, "2026Q2", "2026Q3"], [15, label, "A551RC", 3877000, quarter_value],
        [45, "Profits after tax (without IVA and CCAdj)", "A055RC", 8100000, 8190000],
    ])


class SurveyTests(unittest.TestCase):
    def test_native_current_quarter_uses_only_the_dated_level_and_eligible_respondents(self):
        observed = study.checked_survey(Q3, PDF, medians(), people())
        self.assertEqual(observed, {"usdBillions": "3010", "forecasters": 2, "released": "2026-08-14"})
        for replacement in [PDF.replace(" Q2 Q3 Q4 ", " Q3 Q4 Q1 "),
                            PDF.replace("  2   N.A.", "  3   N.A."),
                            PDF.replace("August 14", "November 16")]:
            with self.subTest(pdf=replacement):
                with self.assertRaises(ValueError):
                    study.checked_survey(Q3, replacement, medians(), people())
        with self.assertRaisesRegex(ValueError, "disagree"):
            study.checked_survey(Q3, PDF, medians(9000), people())
        with self.assertRaisesRegex(ValueError, "duplicated individual"):
            study.checked_survey(Q3, PDF, medians(), people(repeated=True))

    def test_original_government_table_binds_units_basis_dates_and_missingness(self):
        self.assertEqual(study.nipa(nipa_sheet(), 2026, 3, "2026-10-29"), (Decimal("3877"), None))
        self.assertEqual(study.nipa(nipa_sheet(quarter_value=3970100), 2026, 3, "2026-10-29")[1],
                         Decimal("3970.1"))
        with self.assertRaisesRegex(ValueError, "basis"):
            study.nipa(nipa_sheet(label="Corporate profits before taxes"), 2026, 3, "2026-10-29")
        with self.assertRaisesRegex(ValueError, "vintage"):
            study.nipa(nipa_sheet(stamp="November 25, 2026"), 2026, 3, "2026-10-29")

    def test_actual_requires_original_publication_and_equal_same_vintage_series(self):
        class Store:
            def __init__(self):
                self.records = {}
                self.value = "3901.333"
                self.title = ("GDP (Second Estimate) and Corporate Profits, 2nd Quarter 2026 "
                              "8:30 a.m. EDT, Wednesday, August 26, 2026")

            def get(self, key, url):
                self.records[key] = {"receivedAt": "2026-11-24T13:30:00Z"}
                if key.endswith("-pdf"):
                    return self.title
                if key.endswith("-nipa"):
                    return b"synthetic workbook"
                if key.endswith("-control"):
                    return f"observation_date,CPATAX_20260826\n2026-04-01,{self.value}".encode()
                return b'<a href="/sites/default/files/2026-08/gdp2q26-2nd.pdf">Release</a>'

        store = Store()
        baseline = {"quarter": "2026Q2", "survey": {"usdBillions": "3700"}, "priorQuarterControlUsdBillions": "3599"}
        with patch.object(study, "pdf_text", side_effect=lambda data: data), patch.object(
                study, "nipa", return_value=(Decimal("3599"), Decimal("3901.333"))):
            good = study.release_comparison(store, "retrospective_original", Q2, baseline)
            self.assertEqual(good["surveyMissUsdBillions"], "201.333")
            self.assertEqual(good["reductionInAbsoluteErrorUsdBillions"], "101.000")
            store.value = "3922"
            with self.assertRaisesRegex(ValueError, "Independent delivery"):
                study.release_comparison(store, "retrospective_original", Q2, baseline)
            store.title = store.title.replace("Second Estimate", "Third Estimate")
            with self.assertRaisesRegex(ValueError, "first government release"):
                study.release_comparison(store, "retrospective_original", Q2, baseline)

    def test_pre_release_gate_and_read_only_replay_never_create_a_backdated_witness(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(study, "now", return_value=datetime(2026, 11, 24, 14, tzinfo=timezone.utc)):
                with patch.object(study, "urlopen", side_effect=AssertionError("unexpected network")):
                    with self.assertRaisesRegex(ValueError, "has not occurred"):
                        study.command(root, "compare")
                    with self.assertRaisesRegex(ValueError, "No genuine"):
                        study.command(root, "replay")
            with patch.object(study, "now", return_value=study.utc(Q3["releaseAt"])):
                with patch.object(study, "urlopen", side_effect=AssertionError("unexpected network")):
                    with self.assertRaisesRegex(ValueError, "No genuine"):
                        study.command(root, "witness")
            self.assertEqual(list(root.iterdir()), [])

    def test_source_wording_is_immutable_and_original_bytes_replay_offline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store = study.SourceStore(root, False)
            original, receipt = store.directory / "a.body", store.directory / "a.json"
            original.write_bytes(b"original")
            os.chmod(original, 0o600)
            item = {"url": study.BASIS, "servedUrl": study.BASIS, "bytes": 8, "sha256": study.sha(b"original"),
                    "receivedAt": datetime(2026, 1, 1, tzinfo=timezone.utc).isoformat()}
            study.seal(receipt, item)
            with self.assertRaises(FileExistsError):
                study.seal(receipt, {"replacement": True})
            self.assertEqual(store.get("a", study.BASIS), b"original")
            original.write_bytes(b"revised!")
            with self.assertRaisesRegex(ValueError, "failed to replay"):
                store.get("a", study.BASIS)

    def test_a_delayed_mirror_can_recover_without_replacing_the_approved_packet(self):
        def inspect(store, key, period, benchmark):
            marker = store.directory / "synthetic.txt"
            if store.online:
                marker.write_text("server responded")
                if not ready:
                    raise ValueError("This delivery is missing its first vintage")
            self.assertEqual(marker.read_text(), "server responded")
            return {"status": key}

        with tempfile.TemporaryDirectory() as tmp, patch.object(study, "release_comparison", side_effect=inspect):
            root = Path(tmp)
            ready = False
            with self.assertRaisesRegex(ValueError, "missing its first vintage"):
                study.verified_first_release(root, Q3, {}, True)
            self.assertEqual(list(root.iterdir()), [])
            ready = True
            result, _ = study.verified_first_release(root, Q3, {}, True)
            self.assertEqual(result["status"], "first_release_reconciled")
            self.assertEqual(study.verified_first_release(root, Q3, {}, False)[0], result)

    def test_scheduled_entry_skips_unenrolled_and_early_runs_without_source_access(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(study, "command", side_effect=AssertionError("unexpected comparison")):
                self.assertEqual(study.scheduled(root), {"status": "not_enrolled"})
                self.assertEqual(list(root.iterdir()), [])
                study.seal(root / "prerelease.json", {"synthetic": True})
                when = study.utc("2026-11-25T13:29:59Z")
                with patch.object(study, "now", return_value=when):
                    self.assertEqual(study.scheduled(root), {"status": "awaiting_first_release",
                                                             "scheduledAt": Q3["releaseAt"]})
            self.assertEqual([p.name for p in root.iterdir()], ["prerelease.json"])

    def test_scheduled_release_recovers_after_missing_delivery_then_calls_only_offline_replay(self):
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            study.seal(root / "prerelease.json", {"synthetic": True})

            def perform(path, action, include_example):
                self.assertEqual(path, root)
                self.assertFalse(include_example)
                calls.append(action)
                if len(calls) == 1:
                    raise URLError("SYNTHETIC_PRIVATE_RESPONSE")
                if action == "compare":
                    study.seal(path / "first-release.json", {"synthetic": True})
                return {"prospective": {"target": "2026Q3", "actualAvailableOnHostAt": "2026-11-26T12:48:01Z"}}

            with patch.object(study, "command", side_effect=perform), patch.object(study, "now", return_value=study.utc(Q3["releaseAt"])):
                with patch("sys.stdout", new_callable=StringIO) as out:
                    self.assertEqual(study.scheduled_cli(root), 1)
                    self.assertEqual(json.loads(out.getvalue()), {"status": "pending_verification", "reason": "source_unavailable"})
                self.assertFalse((root / "first-release.json").exists())
                first = study.scheduled(root)
                saved = (root / "first-release.json").stat()
                second = study.scheduled(root)
                self.assertEqual(first["status"], "verified_first_release")
                self.assertEqual(second["status"], "verified_saved_result")
                self.assertEqual(first["resultSHA256"], second["resultSHA256"])
                self.assertEqual((root / "first-release.json").stat().st_mtime_ns, saved.st_mtime_ns)
                self.assertEqual(calls, ["compare", "compare", "replay"])

    def test_due_comparisons_share_one_native_capture_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with study.comparison_lock(root):
                with self.assertRaises(BlockingIOError):
                    with study.comparison_lock(root):
                        self.fail("Duplicate native capture")
            with study.comparison_lock(root):
                self.assertEqual((root / ".comparison.lock").stat().st_mode & 0o777, 0o600)

    @unittest.skipUnless(Path("/opt/homebrew/opt/node@24/bin/node").is_file(), "macOS weekday publisher runtime")
    def test_weekday_entry_preserves_normal_output_and_status_on_optional_failure(self):
        script = Path(__file__).resolve().parents[1] / "scripts/weekday-harvest.sh"
        with tempfile.TemporaryDirectory() as tmp:
            scripts = Path(tmp) / "scripts"
            scripts.mkdir()
            shutil.copyfile(script, scripts / script.name)
            for name in ("check-publisher-checkout.py", "collect-sec-etf-flows.py", "reconcile-sec-etfiq-flows.py",
                         "verify-live-consensus.ts", "research-occ-volume.ts", "collect-sentisense-options-private.ts"):
                (scripts / name).write_text("")
            (scripts / "prepare-daily-data.ts").write_text(
                'console.log("ordinary fixture prepared"); process.exit(Number(process.env.SYNTHETIC_PREPARATION));')
            (scripts / "qualify_spf_profits.py").write_text(
                'import sys\nassert sys.argv[1:] == ["scheduled"]\nprint("private fixture pending")\nraise SystemExit(1)\n')
            for code in (0, 7):
                result = subprocess.run(["/bin/bash", str(scripts / script.name)], capture_output=True, text=True,
                                        env={**os.environ, "SYNTHETIC_PREPARATION": str(code)}, timeout=15)
                self.assertEqual(result.returncode, code)
                self.assertEqual(result.stdout.strip(), "ordinary fixture prepared")
                self.assertIn("private fixture pending", result.stderr)
                self.assertIn("Private corporate-profits comparison remains pending", result.stderr)


if __name__ == "__main__":
    unittest.main()
