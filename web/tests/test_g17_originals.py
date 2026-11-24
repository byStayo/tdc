"""Synthetic source semantics for the native G.17 ASCII reader."""
import importlib.util
from decimal import Decimal
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / "scripts" / "research-g17-originals.py"
spec = importlib.util.spec_from_file_location("g17_originals", path)
g17 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g17)

DATE = "2026-10-16"
HEADER = "Apr.[r] May[r] June[r] July[r] Aug.[r] Sept.[p]"
REPORT = f"""Federal Reserve statistical release

G.17 (419) For release at 9:15 a.m. (EDT)
October 16, 2026
Industrial Production and Capacity Utilization: Summary
Seasonally adjusted
| Index 2017=100 | Percent change
Industrial production | {HEADER} | {HEADER} | Sept. '26
 Total index | 99 100 101 102 103 104 | .1 .2 .3 .4 .5 .7 | 2.2
 Manufacturing (see note below) | 99 100 101 102 103 104 | .1 .2 .3 .4 .5 .3 | 1.1"""
HISTORY = {("init.b50001.pct", 2026, 9): Decimal(".6626"), ("init.b00004.pct", 2026, 9): Decimal(".2695")}


class G17SourceTest(unittest.TestCase):
    def test_release_and_first_vintage_agree(self):
        result = g17.parse_report(REPORT, DATE, HISTORY)
        self.assertEqual([result[k] for k in ["period", "releaseAt", "control", "candidate"]],
                         ["2026-09", "2026-10-16T13:15:00.000Z", .7, .3])

    def test_clock_date_duplicate_preliminary_fields_and_growth_must_match(self):
        for body, history in [(REPORT.replace("EDT", "PM"), HISTORY), (REPORT.replace("EDT", "EST"), HISTORY),
                (REPORT.replace("9:15", "9:30"), HISTORY), (REPORT.replace("October 16", "October 15"), HISTORY),
                (REPORT.replace("Aug.[r]", "Aug.[p]"), HISTORY), (REPORT.replace("Sept. '26", "Aug. '26"), HISTORY),
                (REPORT, HISTORY | {("init.b00004.pct", 2026, 9): Decimal(".8")})]:
            with self.subTest(body=body, history=history), self.assertRaises(ValueError):
                g17.parse_report(body, DATE, history)

    def test_pre_2017_rate_uses_the_revised_prior_level_across_year_end(self):
        history = {("init.b00004.s", 2016, 1): Decimal(102), ("rev1.b00004.s", 2015, 12): Decimal(100),
                  ("init.b00004.s", 2015, 12): Decimal(99), ("init.b00004.pct", 2016, 1): Decimal(80)}
        self.assertEqual(g17.reference_growth(history, "b00004", 2016, 1),
                         (Decimal(2), "original-over-first-revised-prior-level"))
        self.assertIsNone(g17.reference_growth(history, "b50001", 2016, 1)[0])


if __name__ == "__main__":
    unittest.main()
