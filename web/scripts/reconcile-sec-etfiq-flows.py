"""Compare original SEC Item B.6 quarters with ETFIQ daily computed flows by economic order date."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from decimal import Decimal, localcontext
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve()
WEB = HERE.parents[1]
spec = importlib.util.spec_from_file_location("sec_issuer_flows", HERE.with_name("collect-sec-etf-flows.py"))
sec = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = sec
spec.loader.exec_module(sec)

ROOT = WEB / ".consensus" / "private-sec-etfiq-comparisons" / "v1"
METHOD = "sec-b6-etfiq-order-and-count-periods-v1"
LICENSE = "https://etfiq.com/license/"
METHODOLOGY = "https://etfiq.com/methodology/flows"
HOUSES = {"SPY": "State Street", "QQQ": "Invesco", "IWM": "iShares", "DIA": "State Street", "TLT": "iShares"}
DAILY_FIELDS = {"d", "navDate", "flow", "src", "house", "spanDays", "why", "held", "status", "spans", "spansSessions",
                "heartbeat", "split"}
ISSUES = {"different-issuer", "non-daily-source", "missing-nav-date", "invalid-flow", "held", "spans-sessions",
          "provider-reason", "unreviewed-status", "unreviewed-daily-field", "invalid-split", "unverified-round-trip"}
FINGERPRINT = re.compile("[0-9a-f]{64}")


def packed(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def decode(raw):
    def unique(pairs):
        result = {}
        for key, val in pairs:
            if key in result:
                raise ValueError("Duplicate JSON field in source")
            result[key] = val
        return result
    return json.loads(raw, object_pairs_hook=unique)


def history_url(symbol):
    return f"https://etfiq.com/data/flows/funds/{symbol.lower()}.json"


def calendar_for(rows):
    first = min(row["periodStart"] for row in rows.values())
    last = max(row["periodEnd"] for row in rows.values())
    # Use the publisher's reviewed exchange schedule, including shortened trading sessions.
    program = """
import { exchangeSession, exchangeSessions, exchangeCalendarVersion } from './lib/consensus/exchange-calendar.ts';
const [from, last] = process.argv.slice(1);
let start = from, end = last;
do { start = new Date(Date.parse(start) - 86_400_000).toISOString().slice(0, 10); } while (!exchangeSession(start));
do { end = new Date(Date.parse(end) + 86_400_000).toISOString().slice(0, 10); } while (!exchangeSession(end));
console.log(JSON.stringify({version: exchangeCalendarVersion(start, end), days: exchangeSessions(start, end)}));
"""
    data = subprocess.check_output(["node", "--experimental-strip-types", "--input-type=module", "-e",
                                    program, first, last], cwd=WEB, timeout=20)
    return json.loads(data)


def eligible_period(row, calendar):
    days = calendar["days"]
    pairs = [(order, count) for order, count in zip(days, days[1:])
             if row["periodStart"] <= order <= row["periodEnd"]]
    if not pairs or pairs[-1][1] <= row["periodEnd"]:
        raise ValueError("Incomplete reviewed exchange coverage including first subsequent count")
    return dict(pairs)


def count_date_period(row, calendar):
    days = calendar["days"]
    return {order: count for order, count in zip(days, days[1:]) if row["periodStart"] <= count <= row["periodEnd"]}


def project(source, symbol, pairs):
    doc = decode(source)
    cited = doc.get("cite", {})
    if (doc.get("schemaVersion") != 3 or doc.get("ticker") != symbol or doc.get("issuer") != HOUSES[symbol]
            or doc.get("seriesId", "absent") != sec.FUNDS[symbol].series
            or doc.get("category") != ("Bonds" if symbol == "TLT" else "Stocks") or doc.get("coverage") != "daily"
            or cited.get("publisher") != "ETFIQ" or cited.get("class") != "ETFIQ-computed"
            or cited.get("page") != "https://etfiq.com/funds/" + symbol.lower() or cited.get("license") != LICENSE
            or cited.get("methodology") != METHODOLOGY or cited.get("as_of") != doc.get("asOf")):
        raise ValueError("ETFIQ history identity, licence, daily coverage or provider date changed")
    source_day = sec.iso_day(doc["asOf"])
    if source_day > datetime.now(sec.NEW_YORK).date():
        raise ValueError("ETFIQ source has a future observation date")
    daily = doc.get("daily")
    if not isinstance(daily, list) or not 0 < len(daily) <= 5000:
        raise ValueError("Missing or oversized ETFIQ daily series")
    heartbeats = doc.get("heartbeats")
    if not isinstance(heartbeats, list):
        raise ValueError("Unknown ETFIQ round-trip layout")
    legs = set()
    for item in heartbeats:
        if not isinstance(item, dict):
            raise ValueError("Unknown ETFIQ round-trip record")
        start, end = sec.iso_day(item["in"]), sec.iso_day(item["out"])
        if start >= end:
            raise ValueError("Invalid ETFIQ round-trip dates")
        legs.update((start.isoformat(), end.isoformat()))
    count_days = sorted(pairs.values())
    relevant, count_history = [], []
    for obj in daily:
        if not isinstance(obj, dict):
            raise ValueError("Unlocatable ETFIQ daily record")
        count = sec.iso_day(obj.get("d")).isoformat()
        if count > source_day.isoformat():
            raise ValueError("ETFIQ row dated after its source edition")
        count_history.append(count)
        nav = obj.get("navDate")
        if nav is not None:
            nav = sec.iso_day(nav).isoformat()
        if not (count_days[0] <= count <= count_days[-1] or nav in pairs):
            continue
        issues = set()
        if set(obj) - DAILY_FIELDS:
            issues.add("unreviewed-daily-field")
        if obj.get("src") not in ("history", "capture"):
            issues.add("non-daily-source")
        if obj.get("house") != HOUSES[symbol]:
            issues.add("different-issuer")
        if not nav:
            issues.add("missing-nav-date")
        flow = obj.get("flow")
        if type(flow) is not int or abs(flow) > 2**53 - 1:
            issues.add("invalid-flow")
        if "held" in obj and obj["held"] is not False:
            issues.add("held")
        if obj.get("status", "ok") == "held":
            issues.add("held")
        elif obj.get("status", "ok") == "spans-sessions":
            issues.add("spans-sessions")
        elif obj.get("status", "ok") != "ok":
            issues.add("unreviewed-status")
        if ("spanDays" in obj and (type(obj["spanDays"]) is not int or obj["spanDays"] != 1)
                or any(key in obj and obj[key] is not False for key in ("spans", "spansSessions"))):
            issues.add("spans-sessions")
        if obj.get("why") not in (None, ""):
            issues.add("provider-reason")
        split = "split" in obj
        if split and (type(obj["split"]) not in (int, float) or not math.isfinite(obj["split"])
                      or obj["split"] <= 0 or obj["split"] == 1):
            issues.add("invalid-split")
        if "heartbeat" in obj and count not in legs:
            issues.add("unverified-round-trip")
        # Discard issuer/vendor fields before writing. Preserve an explicit held reason but never its amount.
        relevant.append({"count": count, "nav": nav, "usd": None if issues else flow, "issues": sorted(issues),
                         "roundTripLeg": count in legs, "splitAdjusted": split})
    return {"fund": symbol, "source": history_url(symbol), "asOf": source_day.isoformat(), "nativeSha256": sha(source),
            "firstCount": min(count_history), "lastCount": max(count_history), "publishedRows": len(count_history),
            "observations": sorted(relevant, key=lambda row: (row["count"], row["nav"] or "", packed(row)))}


def validate_projection(projection, symbol, checked_at):
    fields = {"fund", "source", "asOf", "nativeSha256", "firstCount", "lastCount", "publishedRows", "observations"}
    rows = projection["observations"]
    if (set(projection) != fields or projection["fund"] != symbol or projection["source"] != history_url(symbol)
            or not FINGERPRINT.fullmatch(projection["nativeSha256"]) or not isinstance(rows, list)
            or type(projection["publishedRows"]) is not int or not 0 < projection["publishedRows"] <= 5000
            or len(rows) > projection["publishedRows"]):
        raise ValueError("Invalid ETFIQ history receipt")
    begin, end, published = [sec.iso_day(projection[k]) for k in ("firstCount", "lastCount", "asOf")]
    if not begin <= end <= published <= sec.timestamp(checked_at).astimezone(sec.NEW_YORK).date():
        raise ValueError("Invalid ETFIQ history dates")
    for row in rows:
        if (set(row) != {"count", "nav", "usd", "issues", "roundTripLeg", "splitAdjusted"}
                or not begin <= sec.iso_day(row["count"]) <= end or not isinstance(row["issues"], list)
                or sorted(set(row["issues"])) != row["issues"] or not set(row["issues"]) <= ISSUES
                or type(row["roundTripLeg"]) is not bool or type(row["splitAdjusted"]) is not bool):
            raise ValueError("Invalid retained ETFIQ daily row")
        if row["nav"] is not None:
            sec.iso_day(row["nav"])
        if (row["issues"] and row["usd"] is not None or not row["issues"]
                and (not row["nav"] or type(row["usd"]) is not int or abs(row["usd"]) > 2**53 - 1)):
            raise ValueError("Invalid retained daily dollar amount")


def observed_window(projection, pairs):
    by_count, by_order = {}, {}
    for row in projection["observations"]:
        by_count.setdefault(row["count"], []).append(row)
        if row["nav"]:
            by_order.setdefault(row["nav"], []).append(row)
    approved, gaps = [], {}
    count_days = set(pairs.values())
    unexpected = sorted({count for count in by_count if min(count_days) <= count <= max(count_days) and count not in count_days})
    for order, count in pairs.items():
        found = by_count.get(count, [])
        candidates = by_order.get(order, [])
        issues = set()
        if not found:
            issues.add("missing-count")
        elif len(found) != 1:
            issues.add("duplicate-count")
        if len(candidates) > 1:
            issues.add("duplicate-order")
        if any(r["count"] != count for r in candidates):
            issues.add("ambiguous-order-date")
        for row in found:
            issues.update(row["issues"])
            if row["nav"] != order:
                issues.add("wrong-order-date")
        if issues:
            gaps[order] = sorted(issues)
        else:
            approved.append(found[0])
    total = sum(r["usd"] for r in approved)
    complete = not gaps and not unexpected
    return {"firstOrder": min(pairs), "lastOrder": max(pairs), "firstCount": min(count_days), "lastCount": max(count_days),
            "expectedSessions": len(pairs), "coveredSessions": len(approved), "zeroDays": sum(r["usd"] == 0 for r in approved),
            "roundTripLegs": sum(r["roundTripLeg"] for r in approved), "splitDays": sum(r["splitAdjusted"] for r in approved),
            "exclusionsByOrder": gaps, "unexpectedCountDates": unexpected, "completeCalendarCoverage": complete,
            "etfiqCoveredSubtotalUsd": total if approved else None, "etfiqQuarterUsd": total if complete else None}


def compare(issuer, projection, calendar):
    primary = observed_window(projection, eligible_period(issuer, calendar))
    count_basis = observed_window(projection, count_date_period(issuer, calendar))
    net = Decimal(issuer["netShareSalesUsd"])
    reinvest = Decimal(issuer["distributionReinvestmentsUsd"])
    with localcontext() as precision:
        precision.prec = 40  # SEC XML supports up to 36 decimal digits.
        for window in (primary, count_basis):
            total = window["etfiqQuarterUsd"]
            window["etfiqMinusSecExcludingReinvestmentUsd"] = str(Decimal(total) - net) if total is not None else None
            window["etfiqMinusSecIncludingReinvestmentUsd"] = str(Decimal(total) - (net + reinvest)) if total is not None else None
    return {"symbol": issuer["symbol"], "periodStart": issuer["periodStart"], "periodEnd": issuer["periodEnd"],
            "accession": issuer["accession"], "secAcceptedAt": issuer["acceptedAt"], "secFirstVerifiedAt": issuer["verifiedAt"],
            "secFiling": issuer["indexUrl"], "etfiqHistory": projection["source"], "etfiqAsOf": projection["asOf"],
            "etfiqPage": "https://etfiq.com/funds/" + issuer["symbol"].lower(),
            "etfiqFirstCount": projection["firstCount"], "etfiqLastCount": projection["lastCount"], "calendar": calendar["version"],
            "secNetExcludingReinvestmentUsd": str(net), "secReinvestmentUsd": str(reinvest),
            **primary, "countDateDiagnostic": count_basis}


def fetch(symbol):
    url = history_url(symbol)
    req = Request(url, headers={"User-Agent": sec.AGENT, "Accept": "application/json"})
    with urlopen(req, timeout=15) as response:
        if response.status != 200 or response.url != url:
            raise ValueError("Unexpected ETFIQ history response")
        raw = response.read(700001)
    if not 0 < len(raw) <= 700000:
        raise ValueError("ETFIQ history response size changed")
    return raw


def original(row):
    return {k: row[k] for k in ("accession", "xmlSha256", "indexSha256")}


def persist(directory, evidence, now):
    identity = sha(packed(evidence))
    location = directory / (identity + ".json")
    sec.private_dir(directory)
    if not location.exists():
        body = {"evidence": evidence, "firstComparedAt": now}
        with NamedTemporaryFile(dir=directory, prefix=".pending-", delete=True) as pending:
            pending.write(packed({**body, "receiptSha256": sha(packed(body))}))
            pending.flush()
            os.fsync(pending.fileno())
            try:
                os.link(pending.name, location)
            except FileExistsError:
                pass
    return identity


def read_evidence(directory, identity):
    if not isinstance(identity, str) or not FINGERPRINT.fullmatch(identity):
        raise ValueError("Expected private comparison SHA-256")
    if directory.is_symlink() or directory.lstat().st_mode & 0o077 or directory.lstat().st_uid != os.getuid():
        raise ValueError("Untrusted comparison directory")
    sealed = decode(sec.protected(directory / (identity + ".json"), 3_000_000))
    evidence = sealed["evidence"]
    body = {"evidence": evidence, "firstComparedAt": sealed["firstComparedAt"]}
    if (set(sealed) != {*body, "receiptSha256"} or sha(packed(evidence)) != identity
            or sha(packed(body)) != sealed["receiptSha256"] or sec.timestamp(sealed["firstComparedAt"]) > datetime.now(timezone.utc)
            or evidence.get("method") != METHOD or set(evidence["sec"]) != set(sec.FUNDS)
            or set(evidence["histories"]) != set(sec.FUNDS)):
        raise ValueError("Private comparison seal or coverage changed")
    return evidence, sealed["firstComparedAt"]


def replay(sec_root, directory, identity):
    evidence, clock = read_evidence(directory, identity)
    filings = {}
    for symbol, ref in evidence["sec"].items():
        sec.urls(sec.FUNDS[symbol], ref["accession"])
        row = sec.read_receipt(sec_root / symbol / ref["accession"], symbol)
        if original(row) != ref or sec.timestamp(clock) < sec.timestamp(row["verifiedAt"]):
            raise ValueError("Different issuer originals or local verification clock")
        filings[symbol] = row
    calendar = calendar_for(filings)
    if evidence.get("calendarVersion") != calendar["version"] or evidence.get("sessionSha256") != sha(packed(calendar["days"])):
        raise ValueError("Reviewed exchange calendar changed")
    results = {}
    for symbol, row in filings.items():
        projection = evidence["histories"][symbol]
        validate_projection(projection, symbol, clock)
        results[symbol] = compare(row, projection, calendar)
    return {"method": METHOD, "receipt": identity, "firstComparedAt": clock, "source": "ETFIQ and issuer SEC filings",
            "etfiqMethodology": METHODOLOGY, "etfiqLicense": LICENSE, "rows": results}


def collect(sec_root, directory, read=fetch, new_filings_only=False):
    sec.private_dir(directory)
    handle = sec.collector_lock(directory)
    try:
        filings = {symbol: sec.last_cached(sec_root, symbol) for symbol in sec.FUNDS}
        if not all(filings.values()):
            raise ValueError("Collect all five public SEC originals before comparison")
        calendar = calendar_for(filings)
        refs = {symbol: original(row) for symbol, row in filings.items()}
        session_sha = sha(packed(calendar["days"]))
        if new_filings_only:
            matching = []
            for path in directory.glob("*.json"):
                if not FINGERPRINT.fullmatch(path.stem):
                    continue
                evidence, observed = read_evidence(directory, path.stem)
                if (evidence["sec"] == refs and evidence["calendarVersion"] == calendar["version"]
                        and evidence["sessionSha256"] == session_sha):
                    matching.append((observed, path.stem))
            if matching:
                return max(matching)[1]
        projections = {}
        for symbol, row in filings.items():
            pairs = count_date_period(row, calendar) | eligible_period(row, calendar)
            projections[symbol] = project(read(symbol), symbol, pairs)
        evidence = {"method": METHOD, "calendarVersion": calendar["version"], "sessionSha256": session_sha,
                    "sec": refs, "histories": projections}
        checked_at = sec.utc(datetime.now(timezone.utc))
        for symbol, projection in projections.items():
            validate_projection(projection, symbol, checked_at)
        return persist(directory, evidence, checked_at)
    finally:
        os.close(handle)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--collect", action="store_true", help="fetch five individual histories and pin the comparison")
    mode.add_argument("--scheduled", action="store_true", help="reuse a checked comparison for unchanged SEC filings")
    mode.add_argument("--replay", metavar="SHA256", help="offline replay of an exact private comparison")
    args = parser.parse_args()
    if args.collect or args.scheduled:
        os.umask(0o077)
    try:
        identity = args.replay or collect(sec.ROOT, ROOT, new_filings_only=args.scheduled)
        report = replay(sec.ROOT, ROOT, identity)
        if args.scheduled:
            print(json.dumps({"receipt": identity, "sessionsByFund": {fund: [row["coveredSessions"], row["expectedSessions"]]
                              for fund, row in report["rows"].items()}}, sort_keys=True))
        else:
            print(json.dumps(report, sort_keys=True, indent=2))
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(f"ETF flow comparison unavailable: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
