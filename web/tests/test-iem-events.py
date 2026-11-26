"""Regression tests for no-trade carry and two separately traded election markets."""
from decimal import Decimal
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import unittest

script = Path(__file__).resolve().parents[1] / "scripts/qualify-iem-events.py"
spec = spec_from_file_location("iem", script)
iem = module_from_spec(spec)
spec.loader.exec_module(iem)


def trade(price):
    p = Decimal(price)
    return (Decimal(10), p * 10, p, p, p)


class IemNativeTest(unittest.TestCase):
    def setUp(self):
        self.group = {
            ("VS", "DEM"): trade("0.54"), ("VS", "REP"): trade("0.46"),
            ("WTA", "DEM"): trade("0.75"), ("WTA", "REP"): trade("0.25"),
        }

    def test_distinct_normalizations_are_party_neutral(self):
        self.assertEqual(iem.numeric_features(self.group), [0.08, 0.5])
        other = {(market, "REP" if party == "DEM" else "DEM"): value
                 for (market, party), value in self.group.items()}
        self.assertEqual(iem.numeric_features(other), [0.08, 0.5])

    def test_positive_carried_last_without_volume_is_ineligible(self):
        leg = self.group[("WTA", "DEM")]
        self.group[("WTA", "DEM")] = (Decimal(0), Decimal(0), *leg[2:])
        self.assertIsNone(iem.numeric_features(self.group))

    def test_conflicting_last_and_missing_control_leg_are_ineligible(self):
        self.group[("WTA", "DEM")] = (Decimal(2), Decimal(1), Decimal(".7"), Decimal(".8"), Decimal(".9"))
        self.assertIsNone(iem.numeric_features(self.group))
        del self.group[("VS", "REP")]
        self.assertIsNone(iem.numeric_features(self.group))


if __name__ == "__main__":
    unittest.main()
