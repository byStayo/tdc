import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "qualify-boc-decisions.py"
SPEC = importlib.util.spec_from_file_location("boc_decision_research", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class OriginalBankDecisions(unittest.TestCase):
    def test_target_excludes_bank_and_deposit_rates(self):
        paragraph = ("The Bank of Canada today increased its target for the overnight rate by "
                     "25 basis points to 2½%, with the Bank Rate at 2.75% and the deposit rate at 2.25%.")
        self.assertEqual(MODULE.canada_target([paragraph], ""), "2.5")
        self.assertIsNone(MODULE.canada_target(["The Bank Rate is 2.75%."], ""))

    def test_advance_schedule_requires_a_native_previous_year_date_and_matching_weekday(self):
        page = b"""<h1>Bank of Canada 2003 schedule</h1><div class='post-date'>August 29, 2002</div>
            <p>Tuesday 21 January 2003. Thursday 4 March 2003. Tuesday 3 December 2002.</p>"""
        self.assertEqual(MODULE.scheduled_dates(page, 2003), {"2003-01-21"})
        with self.assertRaisesRegex(ValueError, "clock"):
            MODULE.scheduled_dates(page.replace(b"August 29, 2002", b"August 29, 2004"), 2003)

    def test_altered_private_native_original_fails_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            url = "https://www.bankofcanada.ca/2003/01/official-example/"
            original = b"original Bank of Canada statement"
            sha = hashlib.sha256(original).hexdigest()
            pointer = root / "sources" / (hashlib.sha256(url.encode()).hexdigest() + ".json")
            body = root / "sources" / (sha + ".gz")
            MODULE.seal(pointer, json.dumps({"url": url, "sha256": sha, "bytes": len(original)}).encode())
            MODULE.seal(body, MODULE.gzip.compress(b"a different statement", mtime=0))
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                MODULE.source(root, url, False)


if __name__ == "__main__":
    unittest.main()
