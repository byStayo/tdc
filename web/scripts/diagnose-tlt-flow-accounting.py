"""Separate within-day netting, reported NAV flows and assumed fee/rounding effects using frozen inputs."""
import argparse
import importlib.util
import json
from decimal import Decimal, ROUND_CEILING
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "dated_flow_comparison", Path(__file__).with_name("diagnose-sec-etfiq-discrepancies.py")
)
previous = importlib.util.module_from_spec(spec)
spec.loader.exec_module(previous)
quarter = previous.quarter
sec = previous.sec
MONTH_RULES = "https://www.sec.gov/files/nport_readme.pdf"
NAV_BASIS = "https://www.sec.gov/about/forms/formn-port.pdf#page=9"
FINANCIAL_BASIS = "https://www.sec.gov/resources-small-businesses/small-business-compliance-guides/investment-company-reporting-modernization-rules"
PRIOR_DIGEST = "8028ae635d53362bf877c849b8f1e34638880247e737adc26bc2e664d0bf7874"


def compare_legs(signed_days, filed, earlier_unit):
    """Gross netted legs and necessary (never sufficient) conditions for the stated explanations."""
    if not signed_days or any(type(n) is not int for n in signed_days):
        raise ValueError("Need original whole-dollar daily observations")
    if (set(filed) != {"sales", "reinvestment", "redemption"}
            or any(not n.is_finite() or n < 0 for n in filed.values())
            or filed["reinvestment"] != 0):
        raise ValueError("This comparison requires unambiguous gross legs and zero reinvestments")
    if type(earlier_unit) is not int or earlier_unit < 100 or earlier_unit % 100:
        raise ValueError("Expected the separately filed whole creation unit")
    positive = sum(n for n in signed_days if n > 0)
    negative = -sum(n for n in signed_days if n < 0)
    positive_days = sum(n > 0 for n in signed_days)
    negative_days = sum(n < 0 for n in signed_days)
    extra_sales = filed["sales"] - positive
    extra_redemptions = filed["redemption"] - negative
    residual = extra_redemptions - extra_sales
    # Conservative whole-dollar constraint. Either truncation or rounding to a dollar
    # is less than one dollar in absolute error per day, irrespective of sign or tie handling.
    allowance = Decimal(len(signed_days))
    same_net_possible = (
        abs(residual) <= allowance
        and extra_sales >= -positive_days
        and extra_redemptions >= -negative_days
    )
    # If the only additional consideration was a nonnegative amount on sales and
    # the date, NAV and quantity bases coincided, vendor minus issuer could not exceed zero.
    fee_sign_possible = residual <= allowance
    # Under a nearest-cent NAV-only hypothesis, one share contributes at most half a cent in error.
    half_cent = Decimal("0.005")
    excess = max(Decimal(0), abs(residual) - allowance)
    shares_needed = (excess / half_cent).to_integral_value(rounding=ROUND_CEILING)
    min_nav_ceiling = half_cent * (positive + negative + allowance) / excess if excess else None
    return {
        "days": len(signed_days),
        "positiveDays": positive_days,
        "negativeDays": negative_days,
        "zeroDays": signed_days.count(0),
        "dailyPositiveNetUsd": positive,
        "dailyAbsoluteNegativeNetUsd": negative,
        "filedGrossSalesLessDailyPositiveUsd": str(extra_sales),
        "filedGrossRedemptionsLessDailyNegativeUsd": str(extra_redemptions),
        "dailyNetMinusFiledNetUsd": str(residual),
        "wholeDollarReportingAllowanceUsd": str(allowance),
        "pureWithinDayNettingCompatibleWithIdenticalValuationAndDates": same_net_possible,
        "onlyNonnegativeSalesChargesCompatibleWithIdenticalValuationAndDates": fee_sign_possible,
        "minimumOtherDifferenceUnderOnlyNonnegativeSalesChargesUsd": str(max(Decimal(0), residual - allowance)),
        "minimumAbsoluteNetSharesIfOnlyNearestCentNavError": str(int(shares_needed)),
        "requiredSomeInputNAVAtMostUsdIfOnlyNearestCentNavError": (
            str(min_nav_ceiling.quantize(Decimal(".01"), rounding=ROUND_CEILING))
            if min_nav_ceiling is not None else None
        ),
        "daysIncompatibleWithEarlierFiledUnitAndExactCentNav": sum(n % (earlier_unit // 100) != 0 for n in signed_days),
    }


def replay():
    prior = previous.report(collect=False)
    if quarter.sha(quarter.packed(prior)) != PRIOR_DIGEST:
        raise ValueError("The immutable November 20 diagnostic differs")
    original, _ = quarter.read_evidence(quarter.ROOT, previous.FROZEN)
    ref = original["sec"]["TLT"]
    directory = sec.ROOT / "TLT" / ref["accession"]
    issuer = sec.read_receipt(directory, "TLT")
    if (issuer["periodStart"], issuer["periodEnd"]) != ("2026-06-01", "2026-08-31"):
        raise ValueError("Unexpected SEC quarter")
    slots = previous.issuer_slots(sec.protected(directory / "filing.xml", 8_000_000))
    native = original["histories"]["TLT"]
    pairs = quarter.count_date_period(issuer, quarter.calendar_for({"TLT": issuer}))
    earlier = prior["tlt"]["annualFeeDisclosure"]
    unit_value = Decimal(earlier["creationUnitNumOfShares"])
    if earlier["periodEnd"] != "2026-02-28" or unit_value != unit_value.to_integral_value():
        raise ValueError("Unreviewed annual creation unit")
    all_days, months = [], {}
    for idx, month in enumerate(previous.MONTHS):
        monthly_pairs = {order: day for order, day in pairs.items() if day[:7] == month}
        approved = quarter.observed_window(native, monthly_pairs)
        if not approved["completeCalendarCoverage"] or approved["splitDays"] or approved["roundTripLegs"]:
            raise ValueError("Calendar, splits or round-trip rows changed")
        count_set = set(monthly_pairs.values())
        flows = [row["usd"] for row in native["observations"] if row["count"] in count_set]
        if len(flows) != len(monthly_pairs) or sum(flows) != approved["etfiqQuarterUsd"]:
            raise ValueError("Independent daily legs disagree with the accepted observation window")
        # SEC's filed data dictionary defines MON1/MON2/MON3 as the first,
        # second and third months of this statutory period. No vendor monthly label is used here.
        series = compare_legs(flows, slots[idx], int(unit_value))
        previous_difference = prior["tlt"]["months"][idx]["displayedDailyMinusIssuerNetUsd"]
        if Decimal(series["dailyNetMinusFiledNetUsd"]) != Decimal(previous_difference):
            raise ValueError("Native chronological SEC leg disagrees with the frozen monthly comparison")
        months[month] = series
        all_days.extend(flows)
    filed_quarter = {key: sum((slot[key] for slot in slots), Decimal(0)) for key in slots[0]}
    combined = compare_legs(all_days, filed_quarter, int(unit_value))
    if Decimal(combined["dailyNetMinusFiledNetUsd"]) != Decimal(prior["tlt"]["displayedDailyMinusIssuerNetUsd"]):
        raise ValueError("Gross legs do not reproduce the previous quarter")
    return {
        "method": "tlt-b6-gross-netting-conditional-precision-v1",
        "fund": "TLT",
        "accession": issuer["accession"],
        "period": [issuer["periodStart"], issuer["periodEnd"]],
        "basis": "later share-count session in the statutory period",
        "observedAsOf": native["asOf"],
        "etfiqOriginalSHA256": native["nativeSha256"],
        "secOriginalSHA256": issuer["xmlSha256"],
        "originalComparison": previous.FROZEN,
        "replayedPreviousDiagnostic": PRIOR_DIGEST,
        "monthly": months,
        "quarter": combined,
        "priorFiledUnit": {"shares": int(unit_value), "asOf": earlier["periodEnd"], "accession": earlier["accession"]},
        "attribution": "unresolved",
        "labelOrVote": False,
        "interpretation": [
            "A positive daily-flow amount can contain offsetting AP sales and redemptions. Same-day netting cancels in the net only when the order dates, share quantities and NAV bases are identical.",
            "B.6 asks for total NAV of sales and redemptions. The separate shareholder report expressly includes some variable charges in shares sold. Its treatment does not establish how charges entered B.6.",
            "The cent-precision check is a conditional sensitivity, not a recovered share count, price series, fee or NAV floor. The creation-unit lattice uses a separately filed earlier-year size and does not certify a later date's unit.",
        ],
        "sources": {
            "fundFlows": native["source"],
            "etfiqLicense": quarter.LICENSE,
            "secB6": NAV_BASIS,
            "monthOrder": MONTH_RULES,
            "distinctFinancialReportingClocks": FINANCIAL_BASIS,
            "financialStatement": prior["tlt"]["separateSixMonthCheck"]["financialStatement"]["original"],
        },
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    result = replay()
    print(json.dumps({"resultSha256": quarter.sha(quarter.packed(result)), "evidence": result}, indent=2))
