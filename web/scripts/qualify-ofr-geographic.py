"""Reconstruct international stress measurements from timestamped Treasury vintages.

Run with --source-root pointing to the existing private OFR capture directory.
The immutable owner-only output contains forecast measurements but no ETF returns.
"""
import argparse
import base64
import bisect
from collections import Counter, defaultdict
import csv
from decimal import Decimal, ROUND_HALF_UP
import datetime as dt
import gzip
import hashlib
import importlib.util
import io
import json
import math
import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = "9e2615f0e735d5e527506317243607c82294b1d4c0b6928607db5e5fb18b7119"
COHORT = "7c2608afbed7bd9fa23a0f5a5ca4455a07366fcb4d821ac6b6441ef8b390839b"
SUPPLEMENT = "e3280ee5a3e7b8ef40c5b24416002ab7a4f68c265bb8337baf21ba3817c74078"
MATURITY_POLICY = "5c69e67e38cd74afb1b6b1af9388d88e0f4c11a76a757fe3df6772e74825e584"
FROZEN_BASE = "39c14be4941b6cac590a4a106a430ce1d1706a7eb74837bd1805db036a68b1b0"
MIRROR_MAPPINGS = {
    "8368720102b2bfe39ead11a00ecb02ab0f225c5826a59c3281104f362df1a9e3",
    "d5acb696f021a22d56a15dbe4b4ad796704233e4f37ea5ec376ae0256fd4ff4b",
}
OLD_MIRROR = "efdcce99fb7e6815236d0e66f2547edc0bd9b603e00ce1679d0f859955ef5081"
spec = importlib.util.spec_from_file_location("ofr_source_clocks", HERE / "verify-ofr-volatility-vintages.py")
vintage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vintage)


def points(rows, native_precision=False):
    result = []
    for fields in rows:
        day, *values = fields
        if len(values) != 4 or any(isinstance(v, bool) or v is None or not math.isfinite(float(v)) for v in values):
            raise ValueError("OFR regional measurement is incomplete")
        if native_precision and any(Decimal(str(v)) % Decimal("0.001") for v in values):
            raise ValueError("Source fields are off the registered native precision grid")
        # Mirror records have already been rounded. Apply the registered four decimals
        # to every source before comparing fields or taking differences.
        fsi, us, advanced, emerging = (
            Decimal.from_float(float(v)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP) for v in values
        )
        if abs(us + advanced + emerging - fsi) > (Decimal("0.002") if native_precision else Decimal("0.0003")):
            raise ValueError("Geographic contributions do not reconcile to the global index")
        result.append((vintage.date_only(day), us, advanced, emerging))
    if len(result) != 2 or result[0][0] >= result[1][0]:
        raise ValueError("OFR releases must contain two distinct ordered observations")
    return tuple(result)


def geographic(raw, mirror, native_precision=False):
    if mirror:
        source = json.loads(raw)
        if "OFR Financial Stress Index" not in source["source"]:
            raise ValueError("Unknown mirror source")
        return points([(r["date"], r["fsi"], r["us"], r["adv"], r["em"]) for r in source["data"][-2:]], native_precision)
    if raw.lstrip().startswith(b"{"):
        source = json.loads(raw)
        series = [source[k]["data"][-2:] for k in ("OFRFSI", "US", "AE", "EM")]
        if any(len(s) != 2 for s in series):
            raise ValueError("Missing native rows")
        fields = []
        for same_date in zip(*series):
            if len({r[0] for r in same_date}) != 1:
                raise ValueError("Native region and global observation dates disagree")
            day = dt.datetime.fromtimestamp(same_date[0][0] / 1000, dt.timezone.utc).date().isoformat()
            fields.append((day, *(r[1] for r in same_date)))
        return points(fields, native_precision)
    source = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))[-2:]
    return points([(r["Date"], r["OFR FSI"], r["United States"],
                    r["Other advanced economies"], r["Emerging markets"]) for r in source], native_precision)


def older_originals(directory):
    loader = importlib.util.spec_from_file_location("ofr_archive_originals", HERE / "collect-ofr-geographic-archives.py")
    archive = importlib.util.module_from_spec(loader)
    loader.loader.exec_module(archive)
    for kind in archive.INDEXES:
        for stamp, original, _, cdx in archive.indexed(directory, kind):
            result = archive.receipt(directory, stamp, kind)
            moment = dt.datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=dt.timezone.utc)
            if (result["timestamp"] != stamp or result["cdxSha1"] != cdx or result["source"] != original or
                    result["url"] != "https://web.archive.org/web/" + stamp + "id_/" + original):
                raise ValueError("Archive delivery differs from the complete frozen CDX inventory")
            if result["status"] != "verified":
                yield None, result["status"]
                continue
            wire = vintage.artifact(directory, result["sha256"])
            if base64.b32encode(hashlib.sha1(wire).digest()).decode() != cdx or moment != vintage.instant(result["available"]):
                raise ValueError("Pre-2022 Treasury original is not the indexed native response")
            native = gzip.decompress(wire) if wire.startswith(b"\x1f\x8b") else wire
            try:
                pair = geographic(native, False, True)
            except (KeyError, ValueError) as error:
                yield None, str(error)
                continue
            yield ((moment, "native-wayback", pair), {**result, "rawSha256": result["sha256"]})


def historical_holidays(directory):
    html = vintage.hashed(directory / "OPM-federal-calendar.html",
                          "d1b08173e028983252e3cb0c09154b1236767448606b99cb62da01e987ec01b0").decode()
    days = set()
    for year in (2018, 2019, 2020):
        match = re.search(rf"<caption>{year} Holiday Schedule</caption>(.*?)</tbody>", html, re.DOTALL)
        if not match:
            raise ValueError("Missing historical U.S. Office of Personnel Management holiday table")
        dates = re.findall(r"<tr>\s*<td>([A-Za-z]+), ([A-Za-z]+) (\d+)", match.group(1))
        if len(dates) != 10:
            raise ValueError("Incomplete historic federal holiday list")
        for weekday, month, day in dates:
            value = dt.datetime.strptime(f"{month} {day} {year}", "%B %d %Y").date()
            if value.strftime("%A") != weekday:
                raise ValueError("OPM weekday disagrees with its date")
            days.add(value)
    return days


def federal_lag(start, end, holidays):
    return sum(day.weekday() < 5 and day not in holidays
               for day in (start + dt.timedelta(days=i) for i in range(1, (end - start).days + 1)))


def encoded_receipt(receipt):
    return (json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode()


def admitted_after_maturity(rows, qualified, originals, conflicts, holidays, calendar):
    reserved_days = {r["session"] for r in rows}
    reserved_economics = {r["economic"] for r in rows}
    sessions = sorted(calendar)
    candidates = {}
    omissions = Counter()
    for moment, source, pair in qualified:
        a, b = pair
        observed, physical = b[0], moment.astimezone(vintage.DISPLAY_ZONE).date()
        if source not in vintage.NATIVE or observed in conflicts or observed.isoformat() in reserved_economics:
            continue
        if not (0 < (observed - a[0]).days <= 7 and 0 <= (physical - observed).days <= 7):
            continue
        if federal_lag(observed, physical, holidays) >= 2:
            continue
        maturity = observed
        while federal_lag(observed, maturity, holidays) < 2:
            maturity += dt.timedelta(days=1)
        available_day = max(maturity, physical)
        index = bisect.bisect_right(sessions, available_day)
        if index >= len(sessions) or (available_day - observed).days > 7:
            continue
        day = sessions[index]
        if not calendar[day] or day.isoformat() in reserved_days:
            omissions["shortened or existing target"] += 1
            continue
        cutoff = dt.datetime.combine(day, dt.time(7, 48), vintage.DISPLAY_ZONE)
        if moment >= cutoff or day >= dt.date(2026, 11, 3):
            raise ValueError("An early original cannot be dated after its registered historical forecast")
        record = originals[(moment, source, pair)]
        candidate = (observed, moment, {
            "session": day.isoformat(), "economic": observed.isoformat(), "publishedBy": record["available"],
            "maturityDate": maturity.isoformat(),
            "issue": cutoff.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "source": source, "sha256": record["rawSha256"],
            "features": [float(a[1] - b[1]), float(a[2] + a[3] - b[2] - b[3])]
        })
        if day not in candidates or candidate[:2] > candidates[day][:2]:
            candidates[day] = candidate
    added = []
    for target in sorted(candidates):
        row = candidates[target][2]
        if row["economic"] in reserved_economics:
            omissions["repeated economic date"] += 1
            continue
        reserved_economics.add(row["economic"])
        added.append(row)
    return added, dict(sorted(omissions.items()))


def qualify(root, archive_directory=None, with_maturity=False):
    vintage.hashed(HERE / "ofr-geographic-study-policy.json", SPEC)
    if archive_directory is not None:
        vintage.hashed(HERE / "ofr-geographic-supplement.json", SUPPLEMENT)
    vintage.ROOT = root
    evidence = root / "evidence"
    doc = json.loads(vintage.hashed(root / ("cohort-inputs-" + COHORT + ".json"), COHORT))
    vintage.verify_congress_collection(doc, evidence)
    for name, fingerprint in vintage.PROTOCOLS.items():
        vintage.hashed(root / name, fingerprint)
    captures = list(vintage.verified_receipts(evidence, doc["observations"]))
    for code in MIRROR_MAPPINGS:
        actual = vintage.artifact(evidence / "mirror-code", code)
        if not all(s in actual for s in (b'("United States", "us")', b'("Other advanced economies", "adv")',
                                         b'("Emerging markets", "em")', b'round(float(v), 4)')):
            raise ValueError("The mirror collector omitted the required geographic mapping")
    old = vintage.artifact(evidence / "mirror-code", OLD_MIRROR)
    if b'("United States", "us")' in old:
        raise ValueError("The previously ineligible mirror suddenly offers regional input")

    qualified, missing, parsed, originals = [], Counter(), {}, {}
    field_errors = {}
    for record, (moment, origin, old_pair) in zip(doc["observations"], captures, strict=True):
        mirror = origin == vintage.MIRROR
        if mirror and record["collectorSha256"] not in MIRROR_MAPPINGS:
            missing["documented mirror collector omitted region fields"] += 1
            continue
        digest = record["rawSha256"]
        cache_key = (mirror, digest)
        if cache_key not in parsed and cache_key not in field_errors:
            raw = vintage.artifact(evidence / ("mirrors" if mirror else "originals"), digest)
            try:
                parsed[cache_key] = geographic(raw, mirror, archive_directory is not None)
            except (ValueError, KeyError) as error:
                field_errors[cache_key] = str(error)
        if cache_key in field_errors:
            missing[field_errors[cache_key]] += 1
            continue
        pair = parsed[cache_key]
        if [p[0] for p in pair] != [p[0] for p in old_pair]:
            raise ValueError("Regional and global latest two economic dates disagree")
        key = (moment, origin, pair)
        originals[key] = record
        qualified.append(key)

    original_geographic = len(qualified)
    older_status = Counter()
    older_rows = []
    if archive_directory is not None:
        for row, evidence_record in older_originals(archive_directory):
            if row is None:
                older_status[evidence_record] += 1
            else:
                older_status["accepted"] += 1
                older_rows.append(row)
                originals[row] = evidence_record
                qualified.append(row)
    by_day = {False: defaultdict(set), True: defaultdict(set)}
    for _, source, pair in qualified:
        by_day[source == vintage.MIRROR][pair[1][0]].add(pair)
    overlap = set(by_day[True]) & set(by_day[False])
    conflicts = {day for side in by_day.values() for day, pairs in side.items() if len(pairs) != 1}
    conflicts.update(day for day in overlap if by_day[False][day] != by_day[True][day])
    holidays = {vintage.date_only(day) for day in json.loads(vintage.hashed(evidence / "OPM-dates.json",
                            "856b9e19e2c639b5ff67193c24ccdcd34efb81d81606e882832dbe0fb0cf5f01"))}
    holidays.add(vintage.date_only("2025-01-09"))
    if archive_directory is not None:
        holidays.update(historical_holidays(evidence))
    vintage.START = "2018-01-02" if archive_directory is not None else "2022-01-03"
    calendar = vintage.session_calendar()
    selected = vintage.selected_dates(qualified, calendar, holidays, conflicts)
    natives = [row for row in qualified if row[1] in vintage.NATIVE]
    native_targets = vintage.selected_dates(natives, calendar, holidays, conflicts)
    features = []
    for day, (moment, origin, pair) in selected.items():
        a, b = pair
        source = originals[(moment, origin, pair)]
        cutoff = dt.datetime.combine(day, dt.time(7, 48), vintage.DISPLAY_ZONE)
        if moment >= cutoff or day >= dt.date(2026, 11, 3):
            raise ValueError("The verified source was not available before the registered cutoff")
        features.append({
            "session": day.isoformat(), "economic": b[0].isoformat(), "publishedBy": source["available"],
            "issue": cutoff.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "source": origin, "sha256": source["rawSha256"],
            "features": [float(a[1] - b[1]), float(a[2] + a[3] - b[2] - b[3])]
        })
    summary = {
        "originalCaptureCount": len(captures), "withVerifiedRegionalFields": original_geographic,
        "omissions": dict(missing), "matchedEconomicDates": len(overlap - conflicts),
        "conflictingDates": sorted(d.isoformat() for d in conflicts), "nativeOnlyTargets": len(native_targets),
        "distinctTargets": len(features), "sourceTargetCounts": dict(sorted(Counter(r["source"] for r in features).items())),
        "firstTarget": features[0]["session"] if features else None,
        "lastTarget": features[-1]["session"] if features else None,
        "sourceFloorMet": len(features) >= 120 and len(overlap - conflicts) >= 10
    }
    if archive_directory is not None:
        summary["before2022ArchiveStatus"] = dict(sorted(older_status.items()))
        summary["addedPre2022TargetDays"] = sum(row["session"] < "2022-01-01" for row in features)
        summary["pre2022CapturesUnderMinimumFederalLag"] = sum(
            federal_lag(pair[-1][0], moment.astimezone(vintage.DISPLAY_ZONE).date(), holidays) < 2
            for moment, _, pair in older_rows)
    result = {"policySHA256": SUPPLEMENT if archive_directory is not None else SPEC,
              "originalInventorySHA256": COHORT, "summary": summary, "rows": features}
    if not with_maturity:
        return result
    vintage.hashed(HERE / "ofr-geographic-maturity.json", MATURITY_POLICY)
    if hashlib.sha256(encoded_receipt(result)).hexdigest() != FROZEN_BASE or len(features) != 109:
        raise ValueError("Previously selected dates, values, clocks or topology changed")
    added, duplicate_reasons = admitted_after_maturity(features, qualified, originals, conflicts, holidays, calendar)
    combined = sorted(features + added, key=lambda r: r["session"])
    summary = {**summary, "originalBaseTargets": len(features), "distinctTargets": len(combined),
               "addedAfterMaturity": len(added), "wholeOriginalsInNewRows": len(added),
               "additionalSourceCounts": dict(sorted(Counter(r["source"] for r in added).items())),
               "deferredOmissions": duplicate_reasons,
               "sourceTargetCounts": dict(sorted(Counter(r["source"] for r in combined).items())),
               "baseOnlyNativeTargets": summary["nativeOnlyTargets"],
               "firstTarget": combined[0]["session"], "lastTarget": combined[-1]["session"],
               "sourceFloorMet": len(combined) >= 120 and len(overlap - conflicts) >= 10}
    del summary["nativeOnlyTargets"]
    return {"policySHA256": MATURITY_POLICY, "priorSelectionSHA256": FROZEN_BASE,
            "originalInventorySHA256": COHORT, "summary": summary, "rows": combined}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--native-precision-archives", type=Path,
                        help="Verify the separately preregistered supplement and earlier original captures")
    parser.add_argument("--after-maturity", action="store_true", help="Use only newly eligible witnessed native source dates")
    args = parser.parse_args()
    if args.after_maturity and not args.native_precision_archives:
        parser.error("--after-maturity requires --native-precision-archives")
    result = qualify(args.source_root.resolve(), args.native_precision_archives, args.after_maturity)
    encoded = encoded_receipt(result)
    path = args.output.resolve()
    if path.exists():
        if path.is_symlink() or path.stat().st_mode & 0o077 or path.read_bytes() != encoded:
            raise ValueError("Refusing to replace an earlier source selection")
    else:
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as f:
            f.write(encoded)
    print(json.dumps({**result["summary"], "selectionSHA256": hashlib.sha256(encoded).hexdigest()}, sort_keys=True))


if __name__ == "__main__":
    main()
