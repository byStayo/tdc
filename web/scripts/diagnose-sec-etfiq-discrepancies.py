"""Replay the November 20 ETFIQ TLT count-date residual and QQQ's independent opening balance."""
import argparse
import importlib.util
import gzip
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from html import unescape
from functools import cache
from io import BytesIO
from pathlib import Path
from tempfile import NamedTemporaryFile

HERE = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location("etfiq_quarter", HERE.with_name("reconcile-sec-etfiq-flows.py"))
quarter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(quarter)
sec = quarter.sec
FROZEN = "2ab9c565d7022340629e932b205af90f9d3a077a0d184a5d19d3c85c247f2696"
ROOT = sec.ROOT.parent / "issuer-diagnostic-v1"
MONTHS = ("2026-06", "2026-07", "2026-08")
PROJECTION = "351dcc8477c80d6f4177c594effdaeef1f051eb4e5762afe1efdb8246e45b81e"
ANNUAL = "0001410368-26-044733"
SEMIANNUAL = "0001100663-26-000074"
PRIOR_QUARTER = "0002071691-26-016714"
SEMESTER_PROJECTION = "02384b89b565352dc9359a909766ac181a291074059ce0fd26c162f35614fa0b"
FINANCIAL_STATEMENTS = "8e3121e6dc81a9d51e0d12e365553b317b9568e1ef88bfdd807c61ffcdae92d5"
BALANCE = "0001193125-26-250483"
SOURCES = {
    "tlt-annual-fees-index": ("TLT", ANNUAL, ANNUAL + "-index.htm", "27fce60b975d812b8378ce7be99ca83462d4124de33a1f46b4dc3291655cb06f"),
    "tlt-annual-fees": ("TLT", ANNUAL, "primary_doc.xml", "e2a9d26a24df7bd8fd019f11bdadec01b35d5968d266e29e5f0113b270a60088"),
    "tlt-semiannual-index": ("TLT", SEMIANNUAL, SEMIANNUAL + "-index.htm", "f022aa57fdda91e237c22019bd3aa2a499b1418bfeccd307addf6d914419d733"),
    "qqq-march-balance-index": ("QQQ", BALANCE, BALANCE + "-index.htm", "74912ca22cf2469b30c04937e0f1257f5f2913f66cb46d8bf7ad7c3f5b7f5fd9"),
    "qqq-march-balance": ("QQQ", BALANCE, "8deb6f921189c0e.htm", "6574b78e4a5045458fc162383499f748299d00aac4313f3b6858db99f0c889e5"),
}


def checked_file(path, digest, limit, get=None, compressed=False):
    if not path.exists() and get:
        raw = get()
        if len(raw) > limit or quarter.sha(raw) != digest:
            raise ValueError(f"New source differs from the pinned original: {path.name}")
        with NamedTemporaryFile(dir=path.parent) as temp:
            temp.write(gzip.compress(raw, mtime=0) if compressed else raw)
            temp.flush()
            os.fsync(temp.fileno())
            try:
                os.link(temp.name, path)
            except FileExistsError:
                pass
    raw = sec.protected(path, 8_000_000 if compressed else limit)
    if compressed:
        with gzip.GzipFile(fileobj=BytesIO(raw)) as stream:
            raw = stream.read(limit + 1)
    if len(raw) > limit or quarter.sha(raw) != digest:
        raise ValueError(f"Retained source differs from its pinned original: {path.name}")
    return raw


def supplemental(raw, original):
    if quarter.sha(raw) != original:
        raise ValueError("Different ETFIQ original from the frozen all-five comparison")
    doc = quarter.decode(raw)
    rows = []
    for record in doc["monthly"]:
        if record["m"] not in MONTHS or record["src"] not in ("daily", "nport"):
            continue
        keys = (("m", "src", "flow", "days", "of", "from", "to") if record["src"] == "daily"
                else ("m", "src", "flow", "accession", "filed", "form", "scope"))
        rows.append({key: record[key] for key in keys})
    check = doc["nportCheck"]
    return quarter.packed({"nativeSha256": original, "monthly": rows, "declaredSplitEvents": len(doc["splits"]),
                           "declaredRoundTrips": len(doc["heartbeats"]),
                           "providerCheck": {**{k: check[k] for k in ("m", "agree", "daily", "nport")},
                                             "ruleSha256": quarter.sha(check["rule"].encode())}})


def issuer_slots(xml):
    fund = sec.one(ET.fromstring(xml), "formData/fundInfo")
    result = []
    for order in (1, 2, 3):
        row = sec.one(fund, f"mon{order}Flow")
        result.append({key: Decimal(row.attrib[key]) for key in ("sales", "redemption", "reinvestment")})
    return result


def by_month(issuer, slots, native, supplemental_rows, pairs):
    """The filed field supplies a month label; only individual daily rows supply the independent subtotal."""
    if native["nativeSha256"] != supplemental_rows["nativeSha256"]:
        raise ValueError("Inconsistent ETFIQ source revisions")
    slots = slots.copy()
    result = []
    for month in MONTHS:
        monthly = [r for r in supplemental_rows["monthly"] if r["m"] == month]
        if len(monthly) != 2 or {r["src"] for r in monthly} != {"daily", "nport"}:
            raise ValueError("Missing or ambiguous ETFIQ source/month")
        annotation = next(r for r in monthly if r["src"] == "nport")
        calculated = next(r for r in monthly if r["src"] == "daily")
        if ((annotation["accession"], annotation["filed"], annotation["form"], annotation["scope"])
                != (issuer["accession"], issuer["filed"], issuer["form"], "fund")):
            raise ValueError("Month refers to a different filing")
        matches = [slot for slot in slots if (slot["sales"] + slot["reinvestment"] - slot["redemption"])
                   .quantize(Decimal(1), rounding=ROUND_HALF_UP) == annotation["flow"]]
        if len(matches) != 1:
            raise ValueError("SEC B.6 month slot cannot be uniquely identified")
        slot = matches[0]
        slots.remove(slot)
        window = quarter.observed_window(native, {order: count for order, count in pairs.items() if count[:7] == month})
        if (not window["completeCalendarCoverage"]
                or (calculated["from"], calculated["to"], calculated["days"], calculated["of"])
                != (window["firstCount"], window["lastCount"], window["coveredSessions"], window["expectedSessions"])):
            raise ValueError("Incomplete or conflicting independent count-date coverage")
        total = window["etfiqQuarterUsd"]
        result.append({"month": month, "countDays": window["coveredSessions"], "zeroDays": window["zeroDays"],
                       "roundTripLegs": window["roundTripLegs"], "splitDays": window["splitDays"],
                       "distributionReinvestmentUsd": str(slot["reinvestment"]),
                       "displayedDailyMinusIssuerNetUsd": str(Decimal(total) - (slot["sales"] - slot["redemption"])),
                       "displayedDailyMinusProviderMonthUsd": total - calculated["flow"]})
    check = supplemental_rows["providerCheck"]
    check_month = {r["src"]: r["flow"] for r in supplemental_rows["monthly"] if r["m"] == check["m"]}
    if check_month != {"daily": check["daily"], "nport": check["nport"]} or type(check["agree"]) is not bool:
        raise ValueError("Provider self-check cannot be tied to both original monthly series")
    return result


def plain(raw):
    return " ".join(unescape(re.sub(r"<[^>]+>", " ", raw.decode())).split())


def identity(index, symbol, accession, form, document):
    fund = sec.FUNDS[symbol]
    text = plain(index)
    header = re.search(r"SEC Accession No\. (\S+) Filing Date \d{4}-\d{2}-\d{2} Accepted "
                       r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) Documents \d+ Period of Report (\d{4}-\d{2}-\d{2})", text)
    if (not header or header[1] != accession or f"Form {form} -" not in text
            or f"Series {fund.series} " not in text or f"Class/Contract {fund.share_class} " not in text
            or f" {symbol} " not in text or f"/{accession.replace('-', '')}/{document}" not in index.decode()):
        raise ValueError(f"{symbol} independent filing identity or original changed")
    when = datetime.strptime(header[2], "%Y-%m-%d %H:%M:%S").replace(tzinfo=sec.NEW_YORK)
    return {"accession": accession, "periodEnd": sec.iso_day(header[3]).isoformat(), "acceptedAt": sec.utc(when)}


def annual_fees(raw):
    fund = sec.FUNDS["TLT"]
    nodes = [n for n in ET.fromstring(raw).findall(".//{*}exchangeTradedFund")
             if n.findtext("{*}etfSeriesId") == fund.series]
    if len(nodes) != 1 or nodes[0].findtext("{*}fundName") != "iShares 20+ Year Treasury Bond ETF":
        raise ValueError("Uncertain TLT annual fee series")
    keys = ("creationUnitNumOfShares", "creationUnitPurchasedInKind", "creationUnitPercentageRedeemedInKind",
            "creationUnitTransactionFeePercentagePerUnit", "creationUnitTransactionFeeCashPercentagePerUnit",
            "purchaseCreationUnitDollarPercentagePerUnit", "purchaseCreationUnitCashPercentagePerUnit",
            "creationUnitTransactionFeeManyUnits", "purchaseCreationUnitDollarPerMoreUnits")
    facts = {}
    for key in keys:
        fields = nodes[0].findall("{*}" + key)
        if len(fields) != 1 or not sec.NUMBER.fullmatch(fields[0].text or ""):
            raise ValueError("Incomplete TLT annual percentage and fixed dollar fee facts")
        facts[key] = fields[0].text
    return facts


def opening_balance(raw, period):
    date = sec.iso_day(period).strftime("%B %d, %Y")
    text = plain(raw)
    start = f"Statement of Assets and Liabilities {date} (Unaudited) Invesco QQQ Trust"
    if "C000271435Member" not in raw.decode() or text.count(start) != 1:
        raise ValueError("QQQ period or share class differs")
    block = text.split(start)[1].split("See accompanying Notes")[0]
    matches = re.findall(r"Shares outstanding \(unlimited amount authorized, [^)]*\) ([\d,]+) Net asset value \$ "
                         r"([\d,]+\.\d+) Market price", block)
    if len(matches) != 1:
        raise ValueError("QQQ opening shares and NAV are absent or ambiguous")
    return {"shares": int(matches[0][0].replace(",", "")), "navUsd": matches[0][1].replace(",", "")}


def capital_statement(raw):
    text = plain(raw).replace("\u200c", "")
    numbers = r"([0-9]{1,3}(?:,[0-9]{3})+)"
    pair = r"Six Months Ended 08/31/26 Year Ended 02/28/26 iShares ETF Shares Amount Shares Amount "
    pattern = (pair + r"20\+ Year Treasury Bond Shares sold " + numbers + r" \$ " + numbers
               + r" [0-9,]+ \$ [0-9,]+ Shares redeemed \( " + numbers + r" \) \( " + numbers
               + r" \) \( [0-9,]+ \) \( [0-9,]+ \) " + numbers + r" \$ " + numbers)
    records = re.findall(pattern, text)
    if len(records) != 1:
        raise ValueError("Ambiguous TLT period or capital transactions table")
    sold, sale_dollars, redeemed, redemption_dollars, shares, dollars = [int(n.replace(",", "")) for n in records[0]]
    if sold - redeemed != shares or sale_dollars - redemption_dollars != dollars:
        raise ValueError("Shares and consideration do not reconcile inside the statement")
    # Cross-check the third column in the separately printed adjacent-fund statement.
    heading = ("iShares 10-20 Year Treasury Bond ETF iShares 20+ Year Treasury Bond ETF "
               "Six Months Ended 08/31/26 (unaudited) Year Ended 02/28/26 "
               "Six Months Ended 08/31/26 (unaudited) Year Ended 02/28/26")
    sections = text.split(heading)
    if len(sections) != 2:
        raise ValueError("Ambiguous TLT column in statement of changes")
    block = sections[1].split("NET ASSETS Total increase")[0]
    line = re.search(r"Net increase \(decrease\) in net assets derived from capital share transactions "
                     r"\.+ \([0-9,]+\) [0-9,]+ ([0-9,]+) \([0-9,]+\)\s*$", block)
    if not line or int(line[1].replace(",", "")) != dollars:
        raise ValueError("Capital share note and financial statement disagree")
    # The fees note concerns the table's accounting basis; it does not state fees for individual orders.
    if ("additional variable charge" not in text or "Such variable charges, if any, are included in shares sold" not in text):
        raise ValueError("Issuer consideration or variable-charge disclosure changed")
    return {"sharesSold": sold, "sharesRedeemed": redeemed, "netShares": shares, "salesUsd": sale_dollars,
            "redemptionsUsd": redemption_dollars, "netCapitalTransactionsUsd": dollars,
            "variableChargesIfAnyIncludedInSharesSold": True}


def semester_check(collect, index, latest, pinned_source, read_etfiq):
    ishares = sec.FUNDS["TLT"]
    head = identity(index, "TLT", SEMIANNUAL, "N-CSRS", "primary-document.htm")
    url = sec.urls(ishares, SEMIANNUAL)[0].rsplit("/", 1)[0] + "/primary-document.htm"
    html = checked_file(ROOT / "tlt-august-statements.html.gz", FINANCIAL_STATEMENTS, 50_000_000,
                        (lambda: sec.SecReader().get(url, 50_000_000)) if collect else None, compressed=True)
    statement = capital_statement(html)
    earlier_root = ROOT / "quarters"
    if collect:
        sec.private_dir(earlier_root)
        prior = sec.collect_filing(earlier_root, "TLT", PRIOR_QUARTER, sec.SecReader().get, lambda: datetime.now(timezone.utc))
    else:
        prior = sec.read_receipt(earlier_root / "TLT" / PRIOR_QUARTER, "TLT")
    if ((prior["xmlSha256"], prior["indexSha256"])
            != ("3e1fc923461680464aa786532bbe3673514088057ab08308072b18d0d0a185a8",
                "293d9e7a18e9c64f901a8da046176453715a02b2d0c413e7d2541bb0c0d2d81d")
            or (prior["periodStart"], prior["periodEnd"], latest["periodStart"], latest["periodEnd"], head["periodEnd"])
            != ("2026-03-01", "2026-05-31", "2026-06-01", "2026-08-31", "2026-08-31")):
        raise ValueError("Two adjacent TLT filings must span the certified shareholder report")
    window = {"periodStart": prior["periodStart"], "periodEnd": head["periodEnd"]}
    calendar = quarter.calendar_for({"TLT": window})
    order = quarter.eligible_period(window, calendar)
    count = quarter.count_date_period(window, calendar)

    def project_semester():
        raw = read_etfiq()
        if quarter.sha(raw) != pinned_source:
            raise ValueError("ETFIQ edition changed")
        return quarter.packed(quarter.project(raw, "TLT", order | count))

    native = quarter.decode(checked_file(ROOT / "tlt-semester-daily-projection.json", SEMESTER_PROJECTION,
                                        30_000, project_semester if collect else None))
    if native["nativeSha256"] != pinned_source:
        raise ValueError("Semester comes from a different ETFIQ source edition")
    od, cd = [quarter.observed_window(native, pairs) for pairs in (order, count)]
    if not od["completeCalendarCoverage"] or not cd["completeCalendarCoverage"]:
        raise ValueError("Complete individual daily rows required on both semester bases")
    b6 = Decimal(prior["netShareSalesUsd"]) + Decimal(latest["netShareSalesUsd"])
    if Decimal(prior["distributionReinvestmentsUsd"]) + Decimal(latest["distributionReinvestmentsUsd"]):
        raise ValueError("Semester controls require separate treatment of nonzero reinvestments")
    return {"financialStatement": {**head, "original": url, **statement}, "firstQuarterAccession": prior["accession"],
            "secondQuarterAccession": latest["accession"], "twoB6QuarterNetUsd": str(b6),
            "financialStatementMinusTwoB6QuartersUsd": str(Decimal(statement["netCapitalTransactionsUsd"]) - b6),
            "orderSessions": od["coveredSessions"], "orderDateNetUsd": od["etfiqQuarterUsd"],
            "orderDateMinusFinancialStatementUsd": od["etfiqQuarterUsd"] - statement["netCapitalTransactionsUsd"],
            "countSessions": cd["coveredSessions"], "countDateNetUsd": cd["etfiqQuarterUsd"],
            "countDateMinusTwoB6QuartersUsd": str(Decimal(cd["etfiqQuarterUsd"]) - b6),
            "orderDateMinusCountDateUsd": od["etfiqQuarterUsd"] - cd["etfiqQuarterUsd"]}


def report(collect=False):
    frozen = quarter.replay(sec.ROOT, quarter.ROOT, FROZEN)
    evidence, _ = quarter.read_evidence(quarter.ROOT, FROZEN)
    native = evidence["histories"]["TLT"]
    tlt = sec.ROOT / "TLT" / evidence["sec"]["TLT"]["accession"]
    issuer = sec.read_receipt(tlt, "TLT")
    if collect:
        sec.private_dir(ROOT)
    if ROOT.is_symlink() or not ROOT.is_dir() or ROOT.stat().st_uid != os.getuid() or ROOT.stat().st_mode & 0o077:
        raise ValueError("Untrusted private discrepancy directory")

    @cache
    def read_etfiq():
        return quarter.fetch("TLT")

    supplement = quarter.decode(checked_file(ROOT / "tlt-provider-projection.json", PROJECTION, 10000,
        (lambda: supplemental(read_etfiq(), native["nativeSha256"])) if collect else None))
    pairs = quarter.count_date_period(issuer, quarter.calendar_for({"TLT": issuer}))
    rows = by_month(issuer, issuer_slots(sec.protected(tlt / "filing.xml", 8_000_000)), native, supplement, pairs)
    residual = sum(Decimal(r["displayedDailyMinusIssuerNetUsd"]) for r in rows)
    if residual != Decimal(frozen["rows"]["TLT"]["countDateDiagnostic"]["etfiqMinusSecExcludingReinvestmentUsd"]):
        raise ValueError("Monthly residuals differ from the immutable all-five comparison")
    reader = sec.SecReader()
    docs = {}
    for name, (fund, acc, filename, digest) in SOURCES.items():
        url = sec.urls(sec.FUNDS[fund], acc)[0].rsplit("/", 1)[0] + "/" + filename
        docs[name] = checked_file(ROOT / (name + ".bin"), digest, 1_300_000,
                                  (lambda: reader.get(url, 1_300_000)) if collect else None)
    annual = identity(docs["tlt-annual-fees-index"], "TLT", ANNUAL, "N-CEN", SOURCES["tlt-annual-fees"][2])
    qqq = identity(docs["qqq-march-balance-index"], "QQQ", BALANCE, "N-CSRS", SOURCES["qqq-march-balance"][2])
    qqq_window = frozen["rows"]["QQQ"]["countDateDiagnostic"]
    if (annual["periodEnd"] >= issuer["periodStart"] or annual["acceptedAt"][:10] >= issuer["periodStart"]
            or qqq["periodEnd"] != qqq_window["firstOrder"] or qqq["acceptedAt"][:10] <= qqq["periodEnd"]):
        raise ValueError("Independent filing dates do not establish the stated scope")
    return {"method": "tlt-count-months-qqq-opening-balance-v1", "comparison": FROZEN,
            "tlt": {"source": native["source"], "dates": [issuer["periodStart"], issuer["periodEnd"]],
                    "months": rows, "displayedDailyMinusIssuerNetUsd": str(residual),
                    "displayedDailyMinusProviderMonthsUsd": sum(r["displayedDailyMinusProviderMonthUsd"] for r in rows),
                    "declaredSplitEventsInFile": supplement["declaredSplitEvents"],
                    "declaredRoundTripsInFile": supplement["declaredRoundTrips"],
                    "providerSelfCheckMonth": supplement["providerCheck"]["m"],
                    "providerSelfCheckAgrees": supplement["providerCheck"]["agree"],
                    "annualFeeDisclosure": {**annual, **annual_fees(docs["tlt-annual-fees"])},
                    "separateSixMonthCheck": semester_check(collect, docs["tlt-semiannual-index"], issuer, native["nativeSha256"], read_etfiq),
                    "attributionOfResidual": "unresolved"},
            "qqq": {"independentOpeningBalance": {**qqq, **opening_balance(docs["qqq-march-balance"], qqq["periodEnd"])},
                    "countDaysWithIndependentDailyFlow": qqq_window["coveredSessions"],
                    "countDaysRequired": qqq_window["expectedSessions"],
                    "firstETFIQCount": frozen["rows"]["QQQ"]["etfiqFirstCount"]}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--collect", action="store_true", help="fill only missing files, verifying each pinned source")
    mode.add_argument("--replay", action="store_true", help="verify and replay retained originals offline")
    args = parser.parse_args()
    try:
        data = report(args.collect)
        digest = quarter.sha(quarter.packed(data))
        if args.collect:
            quarter.persist(ROOT / "reports", data, sec.utc(datetime.now(timezone.utc)))
        receipt = ROOT / "reports" / (digest + ".json")
        if receipt.exists():
            sealed = quarter.decode(sec.protected(receipt, 30_000))
            body = {"evidence": data, "firstComparedAt": sealed["firstComparedAt"]}
            if sealed != {**body, "receiptSha256": quarter.sha(quarter.packed(body))}:
                raise ValueError("Independent discrepancy report changed")
            if sec.timestamp(body["firstComparedAt"]) > datetime.now(timezone.utc):
                raise ValueError("Invalid discrepancy verification time")
        print(json.dumps({"reportSha256": digest, **data}, indent=2))
    except (OSError, ValueError, KeyError, TypeError, quarter.subprocess.SubprocessError) as error:
        print(f"Flow discrepancy audit unavailable: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
