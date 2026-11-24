"""Replay Treasury OFR prelaunch source eligibility from a saved private capture.

From web, run python3 scripts/verify-ofr-volatility-vintages.py RECEIPT_SHA256.
This source-only check opens the original bytes and independent capture indexes.
Its output contains aggregate counts.
"""
import argparse
import base64
import bisect
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import math
import re
import subprocess
from collections import Counter, defaultdict
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from zoneinfo import ZoneInfo


WEB = Path(__file__).resolve().parents[1]
ROOT = WEB / ".consensus" / "private-ofr-volatility"
DISPLAY_ZONE = ZoneInfo("America/New_York")
REQUIRED_TARGETS = 120
START, END = "2022-01-03", "2026-11-02"
TREASURY = "https://www.financialresearch.gov/financial-stress-index/data/fsi."
GITHUB = "https://github.com/oid87/PersonalFiance/actions/runs/"
RAW_GITHUB = "https://raw.githubusercontent.com/oid87/PersonalFiance/"
LOC = "native-library-congress"
LOC_PLAYBACK = "https://webarchive-beta.loc.gov/playback-services/general/"
LOC_INDEX_SHA = "d5baedee48045e35ca6d240bb7f36aeaeb5a2e4f72328a153a9667a0d5851ee5"
PRIOR_COHORT = "83ae529ad9d0fe7eb5789737915e9de5975413cd0b4fffa5e2fb6e64f6a2fbef"
NATIVE = {"native-wayback", "native-archived-eco", "native-zenodo-release", LOC}
MIRROR = "timestamped-mirror-four-decimals"
PROTOCOLS = {
    "preregistration.json": "88f96b5baca5e16dc6d5c49df4e8d78496bfb66372e563a9a1843eb182d10d7e",
    "field-precision-preregistration.json": "e6248d835cdfb6add08ddf1681433b30e16a2c2c7da2eebd039b4b0c90b42fbf",
}
# Pin the independent capture clocks as well as the study receipt for this prelaunch sample.
ARCHIVE_INDEXES = {
    "wayback-index.json": "bb863c1335ab2f48a5cb750f1cbadc8e6eed8b4fdf9739d903feb122af0154b6",
    "economic-risk-clock-prelaunch-index.json": "c9d759125ecdd91edf1e8e21574f4520040c2deb401805049ca739bfffc17b88",
    "gh-scheduled-0-1.json": "f3638dba078946f17e435ce10a5d13bfb3a24ec07fc1d555d80ac884f7c887b2",
    "gh-scheduled-1-1.json": "496c6291b3c89fb92f2c2b4426490e557478acc409c4ed6ecb649f2f9ab98e68",
    "gh-other-timed-1.json": "53c752ebfa7b99c17b31a140de281c16c8decb86cd43979d0e15de59573bedf7",
}
# These exact reviewed collector versions map OFR FSI/Volatility and preserve four decimals.
MIRROR_CODE = {
    "8368720102b2bfe39ead11a00ecb02ab0f225c5826a59c3281104f362df1a9e3",
    "d5acb696f021a22d56a15dbe4b4ad796704233e4f37ea5ec376ae0256fd4ff4b",
    "efdcce99fb7e6815236d0e66f2547edc0bd9b603e00ce1679d0f859955ef5081",
}


def check(condition, message):
    if not condition:
        raise ValueError(message)


def hashed(path, digest, zipped=False):
    check(re.fullmatch(r"[a-f0-9]{64}", digest), "Invalid SHA-256")
    body = gzip.decompress(path.read_bytes()) if zipped else path.read_bytes()
    check(hashlib.sha256(body).hexdigest() == digest, "Digest mismatch in " + path.name)
    return body


def artifact(directory, digest):
    check(re.fullmatch(r"[a-f0-9]{64}", digest), "Invalid artifact digest")
    return hashed(directory / (digest + ".gz"), digest, zipped=True)


def date_only(s):
    return dt.datetime.strptime(s, "%m/%d/%Y").date() if "/" in s else dt.date.fromisoformat(s)


def instant(s):
    value = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    check(value.tzinfo is not None, "Capture needs a timezone")
    return value


def point(day, fsi, vol):
    check(all(x is not None and not isinstance(x, bool) and math.isfinite(float(x))
              for x in (fsi, vol)), "Missing or non-finite Treasury component")
    return date_only(day), float(fsi), float(vol)


def latest_points(raw, mirror=False):
    if mirror:
        doc = json.loads(raw)
        check("OFR Financial Stress Index" in doc["source"], "Wrong GitHub source")
        points = [point(r["date"], r["fsi"], r["vol"]) for r in doc["data"][-2:]]
    elif raw.lstrip().startswith(b"{"):
        doc = json.loads(raw)
        index, vol = doc["OFRFSI"]["data"], doc["Volatility"]["data"]
        check(len(index) == len(vol) and all(a[0] == b[0] for a, b in zip(index, vol)),
              "Treasury JSON series dates differ")
        points = [point(dt.datetime.fromtimestamp(a[0] / 1000, dt.timezone.utc).date().isoformat(), a[1], b[1])
                  for a, b in zip(index[-2:], vol[-2:])]
    else:
        rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
        points = [point(r["Date"], r["OFR FSI"], r["Volatility"]) for r in rows[-2:]]
    check(len(points) == 2 and points[0][0] < points[1][0], "Need two ordered observations")
    return tuple(points)


def indexes(directory):
    def load(name):
        return json.loads(hashed(directory / name, ARCHIVE_INDEXES[name]))

    warc = {(r[0], r[1], r[3]) for r in load("wayback-index.json")[1:] if r[2] == "200"}
    artifacts = set()
    for item in load("economic-risk-clock-prelaunch-index.json")["items"]:
        record = item["data"]
        if (record["lineage"]["source_id"] == "ofr_fsi" and
                record["availability"]["basis"] == "FIRST_RETRIEVAL" and
                record["available_at"] == record["retrieved_at"]):
            artifacts.add((record["artifact"]["sha256"], record["retrieved_at"]))
    runs = {}
    for name in (name for name in ARCHIVE_INDEXES if name.startswith("gh-")):
        for r in load(name):
            if (r["event"] in ("push", "schedule", "workflow_dispatch") and r["head_branch"] == "main" and
                    r["conclusion"] == "success" and r["status"] == "completed" and
                    r["html_url"] == GITHUB + str(r["id"])):
                runs[r["html_url"]] = (r["head_sha"], r["run_started_at"])
    return warc, artifacts, runs


def verified_receipts(directory, rows):
    warc, artifacts, runs = indexes(directory)
    parsed = {}
    verified_code = set()
    loc = None
    for row in rows:
        source, digest, at = row["source"], row["rawSha256"], row["available"]
        check(source in NATIVE or source == MIRROR, "Unrecognized source")
        timestamp = instant(at)
        if source == "native-wayback":
            stamp = timestamp.astimezone(dt.timezone.utc).strftime("%Y%m%d%H%M%S")
            native = row["native"]
            check(native in (TREASURY + "csv", TREASURY + "json") and
                  row["url"] == "https://web.archive.org/web/" + stamp + "id_/" + native and
                  (stamp, native, row["cdxSha1"]) in warc, "Unattested Treasury archive time")
            wire_digest = row["warcBytesSha256"]
            if wire_digest != digest:
                wire = artifact(directory / "warc", wire_digest)
                check(hashlib.sha256(gzip.decompress(wire)).hexdigest() == digest, "Wrong WARC encoding")
            else:
                wire = artifact(directory / "originals", digest)
            check(base64.b32encode(hashlib.sha1(wire).digest()).decode() == row["cdxSha1"],
                  "Archived entity differs from independent CDX digest")
        elif source == LOC:
            if loc is None:
                loc = congress_index(directory)
            payload = artifact(directory / "originals", digest)
            verify_congress_original(row, payload, loc)
        elif source == "native-archived-eco":
            check(row["native"] == TREASURY + "csv" and (digest, at) in artifacts and
                  row["timeBasis"] == "FIRST_RETRIEVAL" and row["url"].split("?")[0] ==
                  "https://economicriskclock.org/api/v1/artifacts/" + digest, "Unattested original retrieval")
        elif source == "native-zenodo-release":
            # This immutable DOI preserves a full Treasury CSV, copied as response.content.
            # The downloaded package matched Zenodo's published checksum before extraction.
            proof = json.loads(hashed(directory / "zenodo-20319671.json",
                                      "3042e45d9431835fabf6625c71184001a645da49e7b3f51bcdcc782489178447"))
            record = proof["record"]
            check(row["url"] == "https://doi.org/" + record["doi"] and row["native"] == TREASURY + "csv" and
                  at == max(record["created"], record["updated"]) and digest == proof["nativeSha256"] and
                  row["member"] == proof["member"] and row["archiveSha256"] == proof["archiveSha256"] and
                  row["codeSha256"] == proof["acquisitionCodeSha256"], "Unattested versioned research release")
            artifact(directory / "mirror-code", row["codeSha256"])
        else:
            head, code = row["workflowHead"], row["collectorSha256"]
            check(re.fullmatch(r"[0-9a-f]{40}", head) and runs.get(row["workflowUrl"]) == (head, at) and
                  row["url"] == RAW_GITHUB + head + "/data/fsi.json" and code in MIRROR_CODE,
                  "Unattested GitHub head or unreviewed collector")
            if code not in verified_code:
                artifact(directory / "mirror-code", code)
                verified_code.add(code)
        key = (source == MIRROR, digest)
        if key not in parsed:
            folder = "mirrors" if source == MIRROR else "originals"
            parsed[key] = latest_points(artifact(directory / folder, digest), source == MIRROR)
        declared = tuple(point(r["d"], r["fsi"], r["vol"]) for r in row["points"])
        check(declared == parsed[key], "Published fields disagree with receipt")
        yield timestamp, source, parsed[key]


def session_calendar():
    # Use the same exchange closures and half-days as other prelaunch studies.
    script = """
import { extendedResearchSessions, extendedResearchSession } from './lib/consensus/extended-research-calendar.ts';
import { isFullKibotSession } from './lib/consensus/kibot.ts';
const sessions = extendedResearchSessions(process.argv[1],process.argv[2]);
console.log(JSON.stringify(sessions.map(day => {
    const s = extendedResearchSession(day);
    return [day, isFullKibotSession(s.openAt,s.closeAt)];
})));
"""
    output = subprocess.run(["node", "--experimental-strip-types", "--input-type=module", "-e", script, START, END],
                            cwd=WEB, capture_output=True, text=True, check=True, timeout=20)
    return {date_only(day): full for day, full in json.loads(output.stdout)}


def precision(points):
    # Match Number.toFixed(4) in the frozen historical evaluator, including tie handling.
    def fixed(value):
        return float(Decimal.from_float(value).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))
    return tuple((day, fixed(fsi), fixed(vol)) for day, fsi, vol in points)


def selected_dates(captures, calendar, holidays, conflicts):
    ordered_days, pending = sorted(calendar), {}
    for moment, source, pair in sorted(captures, key=lambda r: r[0]):
        day = moment.astimezone(DISPLAY_ZONE).date()
        previous, latest = pair[0][0], pair[1][0]
        if not 0 < (latest - previous).days <= 7 or not 0 < (day - latest).days <= 7 or latest in conflicts:
            continue
        lag = sum(d.weekday() < 5 and d not in holidays for d in
                  (latest + dt.timedelta(days=i) for i in range(1, (day - latest).days + 1)))
        index = bisect.bisect_right(ordered_days, day)
        if lag < 2 or index == len(ordered_days) or not calendar[ordered_days[index]]:
            continue
        target = ordered_days[index]
        if target not in pending or (latest, moment) >= pending[target][:2]:
            pending[target] = (latest, moment, source, pair)
    seen, selected = set(), {}
    for target in sorted(pending):
        economic, moment, source, pair = pending[target]
        if economic not in seen:
            seen.add(economic)
            selected[target] = (moment, source, pair)
    return selected


def counts(selected):
    by_source = Counter(source for _, source, _ in selected.values())
    return {"eligibleTargets": len(selected), "missingFor120": max(0, REQUIRED_TARGETS - len(selected)),
            "targetsBySource": dict(sorted(by_source.items()))}


def congress_index(directory):
    doc = json.loads(hashed(directory / "library-congress-index-projection.json", LOC_INDEX_SHA))
    check(doc["source"] == TREASURY + "csv" and doc["catalog"] == "https://www.loc.gov/item/lcwaN0017866/" and
          doc["index"] == LOC_PLAYBACK + "cdx?url=https%3A%2F%2Fwww.financialresearch.gov%2Ffinancial-stress-index%2Fdata%2Ffsi.csv&from=2022&to=20261102&output=json" and
          (doc["status"], doc["mime"], doc["access"]) == ("200", "text/csv", "allow"),
          "Library native clock source differs")
    return doc["clocksAndOriginalCdxBase32Sha1"]


def verify_congress_original(row, payload, index):
    stamp = instant(row["available"]).astimezone(dt.timezone.utc).strftime("%Y%m%d%H%M%S")
    check(row["native"] == TREASURY + "csv" and
          row["url"] == LOC_PLAYBACK + stamp + "mp_/" + row["native"] and
          index.get(stamp) == row["cdxSha1"] == base64.b32encode(hashlib.sha1(payload).digest()).decode(),
          "Library replay substituted another government CSV")


def verify_congress_collection(doc, directory):
    supplement = doc["libraryCongress"]
    previous = json.loads(hashed(ROOT / ("cohort-inputs-" + PRIOR_COHORT + ".json"), PRIOR_COHORT))
    old = previous["observations"]
    check(doc["observations"][:len(old)] == old and doc["omissions"] == previous["omissions"] and
          supplement["beforePriceSelection"] is True and supplement["previousCohortSha256"] == PRIOR_COHORT and
          supplement["indexProjectionSha256"] == LOC_INDEX_SHA, "Previous sealed cohort changed")
    loc = congress_index(directory)
    accepted = set()
    for row in doc["observations"][len(old):]:
        stamp = instant(row["available"]).astimezone(dt.timezone.utc).strftime("%Y%m%d%H%M%S")
        check(row["source"] == LOC and stamp not in accepted and loc.get(stamp) == row["cdxSha1"],
              "Unknown or repeated Library capture")
        accepted.add(stamp)
    mismatched = set()
    for row in supplement["deliveryDigestMismatches"]:
        stamp = row["timestamp"]
        check(stamp not in mismatched and loc.get(stamp) == row["expectedCdxSha1"] and
              row["archiveUrl"] == LOC_PLAYBACK + stamp + "mp_/" + TREASURY + "csv" and
              row["actualReturnedSha1"] in loc.values() and row["actualReturnedSha1"] != row["expectedCdxSha1"],
              "Invalid Library delivery-rejection evidence")
        mismatched.add(stamp)
    check(accepted.isdisjoint(mismatched) and accepted | mismatched == set(loc) and
          len(accepted) == supplement["exactMatches"] and len(loc) == supplement["requested"],
          "Library requests are incomplete")
    return {"requested": len(loc), "matched": len(accepted), "mismatched": len(mismatched)}


def verify_outcome_inputs(outcome_digest, cohort_digest, doc, captures, selected):
    name = "outcome-time-attested-four-decimal-" + cohort_digest + ".json"
    result = json.loads(hashed(ROOT / name, outcome_digest))
    check(result["receipt"] == cohort_digest and result["scope"] == "time-attested-four-decimal" and
          len(selected) >= REQUIRED_TARGETS and len(result["selected"]) == len(selected), "Outcome scope differs")
    originals = {verified: row for verified, row in zip(captures, doc["observations"])}
    for (day, verified), used in zip(selected.items(), result["selected"]):
        moment, source, pair = verified
        first, last = precision(pair)
        origin = originals[verified]
        features = [(last[1] - last[2]) - (first[1] - first[2]), -(last[2] - first[2])]
        cutoff = dt.datetime.combine(day, dt.time(7, 48), DISPLAY_ZONE)
        check(moment < cutoff and used == {"session": day.isoformat(), "obs": last[0].isoformat(),
              "progress": origin["available"], "url": origin["url"], "source": source,
              "rawSha256": origin["rawSha256"], "features": features},
              "Scored row differs from native vintage or registered control on " + day.isoformat())


def replay(digest, outcome_digest=None):
    directory = ROOT / "evidence"
    for name, fingerprint in PROTOCOLS.items():
        hashed(ROOT / name, fingerprint)
    check(re.fullmatch(r"[a-f0-9]{64}", digest), "Expected collection SHA-256")
    doc = json.loads(hashed(ROOT / ("cohort-inputs-" + digest + ".json"), digest))
    captures = list(verified_receipts(directory, doc["observations"]))
    holidays = {date_only(d) for d in json.loads(hashed(directory / "OPM-dates.json",
                "856b9e19e2c639b5ff67193c24ccdcd34efb81d81606e882832dbe0fb0cf5f01"))}
    holidays.add(date_only("2025-01-09"))  # National day of mourning.
    calendar = session_calendar()
    native = [r for r in captures if r[1] in NATIVE]
    fields = defaultdict(set)
    for _, _, pair in native:
        fields[pair[-1][0]].add(precision(pair))
    overlap, conflicts = set(), set()
    for _, source, pair in captures:
        econ = pair[-1][0]
        if source == MIRROR and econ in fields:
            overlap.add(econ)
            if fields[econ] != {precision(pair)}:
                conflicts.add(econ)
    native_dates = selected_dates(native, calendar, holidays, set())
    mixed_dates = selected_dates(captures, calendar, holidays, conflicts)
    result = {"captures": dict(sorted(Counter(r[1] for r in captures).items())),
            "matchedMirrorEconomicDates": len(overlap - conflicts), "conflictingMirrorEconomicDates": len(conflicts),
            "nativeTreasury": counts(native_dates), "fourDecimalSensitivity": counts(mixed_dates),
            "etfOutcomesOpenedByReplay": 0}
    if "libraryCongress" in doc:
        result["libraryCongress"] = verify_congress_collection(doc, directory)
    if outcome_digest:
        verify_outcome_inputs(outcome_digest, digest, doc, captures, mixed_dates)
        result["verifiedOutcomeInputSha256"] = outcome_digest
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", help="SHA-256 of the private OFR cohort input")
    parser.add_argument("--verify-outcome-inputs", help="Check the sealed scoring receipt's selected dates and features")
    args = parser.parse_args()
    print(json.dumps(replay(args.receipt, args.verify_outcome_inputs), sort_keys=True))
