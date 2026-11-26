import importlib.util
import unittest
from decimal import Decimal
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "scripts/diagnose-tlt-flow-accounting.py"
spec = importlib.util.spec_from_file_location("tlt_flow_gross", path)
accounting = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accounting)


def filing(sales, redeemed, reinvest=0):
    return {"sales": Decimal(sales), "redemption": Decimal(redeemed), "reinvestment": Decimal(reinvest)}


class GrossComparison(unittest.TestCase):
    def test_common_offset_in_both_legs_cancels(self):
        result = accounting.compare_legs([40, -30, 0], filing(60, 50), 100_000)
        self.assertEqual(result["filedGrossSalesLessDailyPositiveUsd"], "20")
        self.assertEqual(result["filedGrossRedemptionsLessDailyNegativeUsd"], "20")
        self.assertEqual(result["dailyNetMinusFiledNetUsd"], "0")
        self.assertTrue(result["pureWithinDayNettingCompatibleWithIdenticalValuationAndDates"])
        self.assertEqual(result["zeroDays"], 1)
        self.assertIsNone(result["requiredSomeInputNAVAtMostUsdIfOnlyNearestCentNavError"])

    def test_equal_net_does_not_fix_impossible_gross_legs(self):
        result = accounting.compare_legs([500, -500], filing(20, 20), 100_000)
        self.assertEqual(result["dailyNetMinusFiledNetUsd"], "0")
        self.assertFalse(result["pureWithinDayNettingCompatibleWithIdenticalValuationAndDates"])

    def test_residual_in_wrong_fee_direction_includes_conservative_whole_dollar_allowance(self):
        row = accounting.compare_legs([1000, -700], filing(1030, 750), 100_000)
        self.assertEqual(row["dailyNetMinusFiledNetUsd"], "20")
        self.assertFalse(row["onlyNonnegativeSalesChargesCompatibleWithIdenticalValuationAndDates"])
        self.assertEqual(row["minimumOtherDifferenceUnderOnlyNonnegativeSalesChargesUsd"], "18")
        self.assertEqual(row["minimumAbsoluteNetSharesIfOnlyNearestCentNavError"], "3600")
        self.assertEqual(row["requiredSomeInputNAVAtMostUsdIfOnlyNearestCentNavError"], "0.48")
        self.assertEqual(row["daysIncompatibleWithEarlierFiledUnitAndExactCentNav"], 1)

    def test_permitted_fee_sign_does_not_establish_fees_or_gross_netting(self):
        row = accounting.compare_legs([1000, -700], filing(1050, 730), 100_000)
        self.assertFalse(row["pureWithinDayNettingCompatibleWithIdenticalValuationAndDates"])
        self.assertTrue(row["onlyNonnegativeSalesChargesCompatibleWithIdenticalValuationAndDates"])
        self.assertEqual(row["minimumOtherDifferenceUnderOnlyNonnegativeSalesChargesUsd"], "0")

    def test_nonzero_reinvestment_or_ambiguous_definition_fails_closed(self):
        examples = [
            ([], filing(70, 60), 100_000),
            ([True], filing(60, 60), 100_000),
            ([10], filing(70, 60, 1), 100_000),
            ([10], filing(70, -60), 100_000),
            ([10], filing(70, 60), 99),
        ]
        for days, legs, unit in examples:
            with self.subTest(days=days, unit=unit), self.assertRaises(ValueError):
                accounting.compare_legs(days, legs, unit)
