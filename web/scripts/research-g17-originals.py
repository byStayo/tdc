"""Replay the Board's dated G.17 originals against its original-estimate histories, before opening outcomes."""
import argparse
import calendar
from datetime import datetime, time
from decimal import Decimal
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess
from zoneinfo import ZoneInfo

WEB = Path(__file__).resolve().parents[1]
BOARD = "https://www.federalreserve.gov/releases/g17/"
REGISTRATION = "f689c4113b3dd75c31656e05e84976191801eeea9be2e0892060927c7c8603eb"
FIRST_ISSUE = "2026-11-03T06:28:30.460Z"
ZONE = ZoneInfo("America/New_York")
MONTHS = {month[:3].lower(): i for i, month in enumerate(calendar.month_name) if month}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def checked_text(directory, name, url, meta_name=None):
    body = gzip.decompress((directory / (name + ".gz")).read_bytes())
    receipt = json.loads((directory / ((meta_name or name) + ".json")).read_text())
    actual = sha(body)
    final = receipt["final"]
    if (receipt["url"] != url or final != url and not (url == BOARD + "ipdisk/revh_sa.txt" and
            final == BOARD + "Current/ipdisk/revh_sa.txt") or
            actual != receipt.get("sha256", receipt.get("hash")) or receipt.get("bytes", len(body)) != len(body) or
            datetime.fromisoformat(receipt["receivedAt"]).utcoffset() is None):
        raise ValueError("Official G.17 receipt differs: " + name)
    return body.decode("utf8"), actual


def pct_history(body):
    history = {}
    for line in body.splitlines():
        match = re.fullmatch(r'"((?:init|rev1)\.b(?:00004|50001)\.(?:s|pct))"\s+(\d{4})\s+(.+)', line)
        if match:
            series, year, values = match.groups()
            readings = values.split()
            if not 1 <= len(readings) <= 12:
                raise ValueError("Invalid G.17 history width")
            for month, raw in enumerate(readings, 1):
                key = (series, int(year), month)
                if key in history:
                    raise ValueError("Duplicate G.17 source history")
                history[key] = None if raw == "na" else Decimal(raw)
    return history


def reference_growth(history, code, year, month):
    if (year, month) >= (2017, 3):
        return history.get(("init." + code + ".pct", year, month)), "original-published-pct"
    previous = (year, month - 1) if month > 1 else (year - 1, 12)
    current_level = history.get(("init." + code + ".s", year, month))
    prior_level = history.get(("rev1." + code + ".s", *previous))
    if current_level is None or not prior_level:
        return None, "missing-original-level"
    return 100 * (current_level / prior_level - 1), "original-over-first-revised-prior-level"


def parse_report(body, day, history):
    """The first summary's percent-change column, distinct from the level and capacity tables."""
    lines = body.splitlines()
    clock = re.search(r'For release at (\d{1,2}):(\d{2}) a\.m\. \(([^)]+)\)\s*$', lines[2])
    printed = datetime.strptime(lines[3].strip(), "%B %d, %Y").date()
    if printed.isoformat() != day or not clock or clock.groups()[:2] != ("9", "15"):
        raise ValueError("missing matching dated 09:15 release")
    release = datetime.combine(printed, time(9, 15), ZONE)
    if clock.group(3) != release.tzname():
        raise ValueError("release timezone missing or contradictory in native original")
    begin = next(i for i, line in enumerate(lines) if "Industrial Production and Capacity Utilization:" in line and "Summary" in line)
    summary = lines[begin:begin + 30]
    label = next(line for line in summary if re.match(r'^\s*Industrial production\s+\|', line))
    headings = label.split("|")
    if len(headings) != 4 or not any(len(line.split("|")) >= 3 and "Percent change" in line.split("|")[2]
                                     for line in summary[:summary.index(label)]):
        raise ValueError("unexpected summary column definitions")
    ordered = re.findall(r'([A-Za-z]+)\.?\[([a-z]+)\]', headings[2])
    if len(ordered) != 6 or [entry[1] for entry in ordered] != ["r"] * 5 + ["p"]:
        raise ValueError("several or ambiguous preliminary months")
    last_month = MONTHS[ordered[-1][0][:3].lower()]
    annual_end = re.fullmatch(r"\s*([A-Za-z]+)\.?\s+'(\d\d)\s*", headings[3])
    if not annual_end or MONTHS[annual_end.group(1)[:3].lower()] != last_month:
        raise ValueError("cannot verify latest reference month and year")
    year = 2000 + int(annual_end.group(2))
    if (year, last_month) >= (printed.year, printed.month):
        raise ValueError("reference month was not complete at release")
    inputs = {}
    corroboration = {}
    for field, series, caption in [("control", "b50001", "Total index"),
            ("candidate", "b00004", "Manufacturing (see note below)")]:
        matches = [line.split("|") for line in summary if line.split("|")[0].strip() == caption]
        if len(matches) != 1 or len(matches[0]) != 4 or len(matches[0][2].split()) != len(ordered):
            raise ValueError("ambiguous industrial production series: " + series)
        printed_growth = Decimal(matches[0][2].split()[-1])
        checked, method = reference_growth(history, series, year, last_month)
        if checked is None or abs(checked - printed_growth) > Decimal(".05"):
            raise ValueError("initial-vintage growth outside press rounding: " + series)
        inputs[field] = float(printed_growth) or 0
        corroboration[field] = {"code": series.upper(), "method": method, "value": str(checked)}
    return {"period": f"{year:04}-{last_month:02}", "releaseAt": release.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            **inputs, "originalVintage": corroboration}


def build(directory):
    policy = (directory / "registration.json").read_bytes()
    if sha(policy) != REGISTRATION or json.loads(policy)["before"] != FIRST_ISSUE:
        raise ValueError("Preregistered G.17 study has changed")
    index, index_hash = checked_text(directory, "monthly-archive.html", BOARD + "default.htm", "monthly-archive")
    _, methods_hash = checked_text(directory, "vintage-doc.html", BOARD + "revhist.htm", "vintage-doc")
    _, terms_hash = checked_text(directory, "reuse.html", "https://www.federalreserve.gov/disclaimer.htm", "reuse")
    originals = directory / "originals"
    publication_dates, dates_hash = checked_text(originals, "release_dates.htm", BOARD + "release_dates.htm")
    confirmed = {datetime.strptime(raw, "%d-%B-%Y").date().isoformat()
                 for raw in re.findall(r'\b\d{1,2}-[A-Za-z]+-\d{4}\b', publication_dates)}
    vintage, vintage_hash = checked_text(originals, "ipdisk-revh_sa.txt", BOARD + "ipdisk/revh_sa.txt")
    history = pct_history(vintage)
    hrefs = sorted(set(re.findall(r'href="(20\d{6}/g17\.txt)"', index)))
    cutoff = json.loads(policy)["before"][:10].replace("-", "")
    paths = [href for href in hrefs if "20160101" <= href[:8] < cutoff]
    calendar_js = """
import {extendedResearchSession,extendedResearchSessions} from './lib/consensus/extended-research-calendar.ts';
import {newYorkTimestamp} from './lib/consensus/time.ts';
console.log(JSON.stringify(extendedResearchSessions('2016-01-01','2026-11-02').map(day => ({
...extendedResearchSession(day),decision:newYorkTimestamp(day.replaceAll('-','')+'T074800')}))));
"""
    sessions = json.loads(subprocess.check_output(["node", "--disable-warning=ExperimentalWarning",
        "--input-type=module", "-e", calendar_js], cwd=WEB))
    accepted, excluded, seen = [], [], set()
    for path in paths:
        day = datetime.strptime(path[:8], "%Y%m%d").date().isoformat()
        native, body_hash = checked_text(originals, path.replace("/", "-"), BOARD + path)
        item = {"releaseDate": day, "url": BOARD + path, "sha256": body_hash}
        if day not in confirmed:
            raise ValueError("Historical Board release-date calendar omits " + day)
        try:
            result = parse_report(native, day, history)
        except ValueError as error:
            excluded.append({**item, "reason": str(error)})
            continue
        target = next((s for s in sessions if s["session"] > day), None)
        if not target or (datetime.fromisoformat(target["closeAt"]) - datetime.fromisoformat(target["openAt"])).total_seconds() != 390 * 60:
            excluded.append({**item, "reason": "immediate next session is short or outside time fence"})
            continue
        if not result["releaseAt"] < target["decision"] < target["openAt"] < target["closeAt"] < FIRST_ISSUE:
            raise ValueError("Chronology failure")
        if result["period"] in seen or any(row["target"] == target["session"] for row in accepted):
            raise ValueError("Duplicate reference period or target")
        seen.add(result["period"])
        accepted.append({**item, **result, "target": target["session"], "decision": target["decision"],
                         "openAt": target["openAt"], "closeAt": target["closeAt"]})
    return {"registration": REGISTRATION, "before": FIRST_ISSUE, "archive": index_hash, "dates": dates_hash,
            "vintage": vintage_hash, "methodology": methods_hash, "rights": terms_hash,
            "monthlyReleases": len(paths), "eligible": accepted, "excluded": excluded}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--seal", action="store_true", help="create the evidence seal once, before accessing research prices")
    args = parser.parse_args()
    manifest = build(args.directory)
    data = canonical(manifest)
    destination = args.directory / "features-sealed.json"
    if args.seal and not destination.exists():
        import os
        with os.fdopen(os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "wb") as stream:
            stream.write(data)
    if not destination.is_file() or destination.read_bytes() != data:
        raise ValueError("Original G.17 feature manifest missing or changed")
    from collections import Counter
    print(json.dumps({"sha256": sha(data), "monthly": manifest["monthlyReleases"], "eligible": len(manifest["eligible"]),
        "excluded": Counter(item["reason"] for item in manifest["excluded"])}))
