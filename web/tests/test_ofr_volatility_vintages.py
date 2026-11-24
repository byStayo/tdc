import base64
import datetime as dt
import hashlib
import importlib.util
import unittest
from pathlib import Path


script = Path(__file__).resolve().parents[1] / "scripts/verify-ofr-volatility-vintages.py"
spec = importlib.util.spec_from_file_location("ofr_vintages", script)
vintages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vintages)


class TreasuryVintageTest(unittest.TestCase):
    def test_library_calendar_may_serve_neighboring_file_under_requested_date(self):
        first, neighbor = b"native Treasury file one\n", b"native Treasury file two\n"
        sha1 = lambda value: base64.b32encode(hashlib.sha1(value).digest()).decode()
        index = {"20250314200011": sha1(first), "20250513050300": sha1(neighbor)}
        origin = vintages.TREASURY + "csv"
        receipt = {"native": origin, "available": "2025-03-14T20:00:11+00:00",
                   "url": vintages.LOC_PLAYBACK + "20250314200011mp_/" + origin,
                   "cdxSha1": index["20250314200011"]}
        vintages.verify_congress_original(receipt, first, index)
        with self.assertRaisesRegex(ValueError, "substituted"):
            vintages.verify_congress_original(receipt, neighbor, index)
        with self.assertRaisesRegex(ValueError, "substituted"):
            vintages.verify_congress_original({**receipt, "cdxSha1": sha1(neighbor)}, neighbor, index)

    def test_one_vintage_cannot_supply_two_targets_and_a_short_session_is_excluded(self):
        day = dt.date.fromisoformat
        point = ((day("2025-11-21"), -1.2, 0.4), (day("2025-11-24"), -1.3, 0.3))
        calendar = {day("2025-11-28"): False, day("2025-12-01"): True, day("2025-12-02"): True}
        captures = [(vintages.instant(s), vintages.LOC, point) for s in
                    ("2025-11-27T20:00:00Z", "2025-11-28T20:00:00Z", "2025-12-01T20:00:00Z")]
        selected = vintages.selected_dates(captures, calendar, {day("2025-11-27")}, set())
        self.assertEqual(list(selected), [day("2025-12-01")])
        self.assertEqual(selected[day("2025-12-01")], captures[1])
