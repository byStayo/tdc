"""Independently audit archived joint FT900 releases against their own Exhibit 1.

Run after collect-ft900-vintages.py. The input and the checked receipt stay in
web/.consensus/private-ft900. The verifier only reads release materials.
"""
import calendar
import datetime as dt
import gzip
import hashlib
import html
import io
import json
import os
import re
import stat
import sys
import tempfile
from collections import Counter
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1] / ".consensus" / "private-ft900"
POLICY = Path(__file__).with_name("ft900-study-policy.json")
CENSUS_PDF = "https://www.census.gov/foreign-trade/Press-Release/ft900/ft900_"
CENSUS_INDEX = "https://www.census.gov/foreign-trade/Press-Release/ft900_index.html"
MONTHS = list(calendar.month_name)[1:]
MONTH_PATTERN = "|".join(MONTHS)
TIME = re.compile(
    r"\b(?:FOR|UNTIL)\s+(?:IMMEDIATE\s+)?RELEASE\s+(?:AT\s+)?8:30\s*"
    r"A\.?\s*M\.?[,]?\s*(EST|EDT|ET)\s*,?\s*"
    r"(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*"
    rf"({MONTH_PATTERN})\s+(\d{{1,2}})\s*,\s*(20\d{{2}})\b", re.I)
PERIOD = re.compile(rf"U\.\s*S\.\s+International Trade in Goods and Services[,:;]?\s+"
                    rf"({MONTH_PATTERN})(?:\s+and\s+Annual)?\s+(20\d{{2}})\b", re.I)
TABLE_MONTH = re.compile(rf"^({MONTH_PATTERN})(?:\s+\(R\))?\s+((?:-?[\d,]+\s+){{8}}-?[\d,]+)$", re.I)
NUMBER_LINE = re.compile(r"^(?:-?[\d,]+\s+){8}-?[\d,]+$")
ET = ZoneInfo("America/New_York")
ERRATA = {
    "2017-01": {"exhibits": "20 and 20b", "area": "Saudi Arabia", "published": "2017-03-22"},
    "2019-04": {"exhibits": "20 and 20b", "area": "Brazil", "published": "2019-06-19"},
    "2023-01": {"exhibits": "14", "area": "Vietnam", "published": "2023-03-09"},
    "2024-01": {"exhibits": "20 and 20b", "area": "Belgium", "published": "2024-03-11"},
    "2025-12": {"exhibits": "15", "area": "Net Adjustments", "published": "2026-02-19"},
}
# These five agency notices were individually reviewed against Exhibit 1.
# A changed or newly issued notice requires a fresh review of its scope.
ERRATA_HASHES = {
    "2017-01": "f20d007c5dc1169bdb5adb57ed142c40b48361f5f3db8e021f48b82f408bc09b",
    "2019-04": "212b48233934ee2c99cc5bdca729f2e13b3de879b3287e2ab9095a8b0ef7da06",
    "2023-01": "97c15ba409c8eb6ebb3f44d7466f64b01ba56666a3bec0277885bf66fed86b96",
    "2024-01": "87bc9b2464549fb6d82e6ed6e59cb8da3a28a6ea9e86d48fa9068d42df8c59ad",
    "2025-12": "6b584834a1001a6f1f7df41f57613f98213866f5e7c4ec60cb163ff5628fad6a",
}
CORRECTION = re.compile(r"\b(?:errata|erratum|correction notice|corrected release)\b", re.I)


def normalize(s):
    return " ".join(s.split())


def html_text(raw):
    without_assets = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", raw.decode(), flags=re.I | re.S)
    return normalize(html.unescape(re.sub(r"<[^>]+>", " ", without_assets)))


def signature(src):
    return hashlib.sha256(src).hexdigest()


def canonical(data):
    return json.dumps(data, sort_keys=True, separators=(",", ":")).encode()


def check_private_dir(directory):
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Expected owner-only private directory: " + directory.name)


def private_bytes(path, limit, compressed=False):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as data:
        info = os.fstat(data.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Expected owner-only source file: " + path.name)
        if info.st_size > limit:
            raise ValueError("Oversized capture: " + path.name)
        raw = data.read(limit + 1)
    if compressed:
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as data:
            raw = data.read(limit + 1)
    if not 0 < len(raw) <= limit:
        raise ValueError("Invalid capture size: " + path.name)
    return raw


def instant(value):
    clock = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if clock.utcoffset() is None:
        raise ValueError("Missing time zone in captured or sealed timestamp")
    return clock


def sealed_policy(root, policy_path):
    spec = json.loads(policy_path.read_bytes())
    frozen = json.loads(private_bytes(root / "policy.json", 20_000))
    if (frozen["spec"] != spec or frozen["sha256"] != signature(canonical(spec))
            or spec["method"] != "prelaunch-ft900-exports-dia-v1"
            or (spec["periodFrom"], spec["periodThrough"]) != ("2015-11", "2026-08")):
        raise ValueError("FT900 preregistration seal mismatch")
    return frozen["sha256"], instant(frozen["createdAt"])


def date_check(text, tolerate_weekday_typo=False):
    clocks, typos = set(), set()
    for zone, weekday, month, day, year in TIME.findall(text):
        date = dt.datetime(int(year), MONTHS.index(month.title()) + 1, int(day), 8, 30, tzinfo=ET)
        if zone.upper() not in ("ET", date.tzname()):
            raise ValueError("Original release offset conflicts with New York")
        if date.strftime("%A").lower() != weekday.lower():
            if not tolerate_weekday_typo:
                raise ValueError("Original release weekday conflicts with calendar")
            typos.add(weekday.title())
        clocks.add(date.isoformat())
    if len(clocks) != 1:
        raise ValueError("No unique 08:30 New York release clock: " + str(sorted(clocks)))
    return clocks.pop(), sorted(typos)


def month_mentioned(text, expected):
    title = PERIOD.search(text)
    if not title or (int(title[2]), MONTHS.index(title[1].title()) + 1) != expected:
        raise ValueError("Release title missing its reference period")


def headline(text, year, month, prior, repair_pdf=False):
    if repair_pdf:
        # A PDF text layer may have a space INSIDE a word. Its visible value
        # must still agree with independently hosted BEA text and Exhibit 1.
        text = re.sub(r"\bles\s+s(?=\s+than)", "less", text, flags=re.I)
    amount = r"\$(\d{1,4}\.\d)\s+billion"
    name = MONTHS[month-1]
    previous = MONTHS[prior.month-1]
    prefix = rf"\b{name}\s+exports\s+were\s+{amount},\s+"
    fixed = re.compile(prefix + amount + rf"\s+(more|less)\s+than\s+{previous}\s+exports\b", re.I)
    bounded = re.compile(prefix + rf"(up|down)\s+less\s+than\s+{amount}\s+from\s+{previous}\s+exports\b", re.I)
    values = {(int(Decimal(level) * 1000),
               int(Decimal(change) * 1000) * (1 if direction.lower() == "more" else -1),
               "reported") for level, change, direction in fixed.findall(text)}
    values.update((int(Decimal(level) * 1000), int(Decimal(change) * 1000) *
                   (1 if direction.lower() == "up" else -1), "strict-bound")
                  for level, direction, change in bounded.findall(text))
    if len(values) != 1:
        raise ValueError(f"No unique monthly level and signed change/bound in {year}-{month:02d}")
    return values.pop()


def cells(line):
    here = [int(col.replace(",", "")) for col in line.split()]
    if len(here) != 9:
        raise ValueError("Exhibit 1 monthly row must have nine numbers")
    balance, bg, bs, exports, eg, es, imports, ig, ins = here
    # Each integer is independently rounded to a million dollars.
    if max(abs(a) for a in (balance - bg - bs, exports - eg - es, imports - ig - ins,
                            balance - exports + imports)) > 1:
        raise ValueError("Displayed table rows fail cross-foot")
    return exports


def exhibit(raw, required, prior):
    if not isinstance(raw, str):
        raise ValueError("Missing unique Census Exhibit 1")
    text = normalize(raw).lower()
    for term in ("exhibit 1. u.s. international trade in goods and services", "in millions of dollars",
                 "seasonally adjusted", "balance exports imports", "balance of payments (bop) basis"):
        if term not in text:
            raise ValueError("Unexpected Exhibit 1 caption/unit/basis: " + term)
    rows, before, year, foot_next = {}, None, None, False
    for source_line in raw.splitlines():
        line = source_line.strip()
        if re.fullmatch(r"20\d{2}", line):
            year = int(line)
            continue
        if re.match(rf"^{MONTHS[prior[1]-1]} data as published last month:", line, re.I):
            if foot_next or before is not None:
                raise ValueError("Duplicate as-published footnote")
            foot_next = True
            continue
        if foot_next and line:
            if not NUMBER_LINE.fullmatch(line):
                raise ValueError("Malformed as-published footnote")
            before = cells(line)
            foot_next = False
            continue
        match = TABLE_MONTH.fullmatch(line)
        if match:
            key = year, MONTHS.index(match[1].title())+1
            if key in rows:
                raise ValueError("Duplicate non-summary calendar row")
            rows[key] = cells(match[2])
    if before is None:
        raise ValueError("Missing as-published footnote")
    return rows[required], rows[prior], before


def bea_capture(directory, period, orig):
    if orig["beaSHA256"]:
        path = directory / (period + ".html.gz")
        url, digest = orig["beaURL"], orig["beaSHA256"]
    else:
        supplement = json.loads(private_bytes(directory / (period + ".bea.json"), 2_000))
        path = directory / (period + ".alternate.html.gz")
        url, digest = supplement["url"], supplement["sha256"]
    raw = private_bytes(path, 450_000, compressed=True)
    if digest != signature(raw):
        raise ValueError("BEA capture hash mismatch")
    return html_text(raw), url, digest


def prior_schedule(directory, previous, when, typos):
    earlier = json.loads(private_bytes(directory / (previous + ".json"), 300_000))
    earlier_bea, _, earlier_bea_hash = bea_capture(directory, previous, earlier)
    when = when.astimezone(ET)
    stamp = f"{when.strftime('%B')} {when.day}, {when.year}"
    weekday = f"Next release: {when.strftime('%A')}, {stamp}".lower()
    exact = f"Next release: {stamp}, at 8:30 a.m. {when.tzname()}".lower()
    if (instant(date_check(normalize(earlier["firstPage"]))[0]) >= when
            or weekday not in normalize(earlier["firstPage"]).lower()
            or weekday not in earlier_bea.lower() or exact not in earlier_bea.lower()):
        raise ValueError("Incorrect BEA weekday without corroboration in both earlier release calendars")
    return {"incorrectBEAWeekday": typos, "expectedWeekday": when.strftime("%A"),
            "priorReference": previous, "priorBEAHash": earlier_bea_hash,
            "priorCensusHash": earlier["pdfSHA256"]}


def reviewed_erratum(period, bea, pdf):
    marks = list(CORRECTION.finditer(bea))
    if CORRECTION.search(pdf):
        raise ValueError("Unreviewed correction on Census front page")
    if not marks and period not in ERRATA:
        return None
    if len(marks) != 1 or period not in ERRATA:
        raise ValueError("Unexpected or missing BEA correction notice")
    after = bea[marks[0].end():]
    notice = re.split(r"(?=The U\.S\. Census Bureau and the U\.S\. Bureau of Economic Analysis|"
                      r"U\.S\. Census Bureau U\.S\. Bureau of Economic Analysis)", after, maxsplit=1, flags=re.I)[0]
    if signature(notice.strip().encode()) != ERRATA_HASHES[period]:
        raise ValueError("Reviewed BEA correction notice changed")
    return ERRATA[period]


def read_release(directory, period, sealed_at):
    capture = private_bytes(directory / (period + ".json"), 300_000)
    orig = json.loads(capture)
    year, month = [int(i) for i in period.split("-")]
    date = dt.date(year, month, 1)
    last = date - dt.timedelta(days=1)
    if (orig["period"] != period or orig["pdfURL"] != CENSUS_PDF + date.strftime("%y%m") + ".pdf"
            or not re.fullmatch("[a-f0-9]{64}", orig["pdfSHA256"])):
        raise ValueError("Invalid original Census capture identity")
    bea, web_url, web_hash = bea_capture(directory, period, orig)
    pdf = normalize(orig["firstPage"])
    released, _ = date_check(pdf)
    bea_released, typos = date_check(bea, tolerate_weekday_typo=True)
    when = instant(released)
    month_end = date.replace(day=calendar.monthrange(year, month)[1])
    captured_at = instant(orig["capturedAt"])
    if (released != bea_released or month_end >= when.date() or captured_at < when
            or captured_at < sealed_at):
        raise ValueError("Original release, reference month, or preregistration chronology mismatch")
    bea_month = "december-and-annual" if month == 12 and year >= 2022 else MONTHS[month - 1].lower()
    suffix = "-0" if period == "2018-11" else ""
    if web_url != f"https://www.bea.gov/news/{when.year}/us-international-trade-goods-and-services-{bea_month}-{year}{suffix}":
        raise ValueError("Invalid original BEA release URL")
    calendar_witness = prior_schedule(directory, last.strftime("%Y-%m"), when, typos) if typos else None
    for text in (pdf, bea):
        month_mentioned(text, (year, month))
        if any(name not in text.lower() for name in ("census bureau", "bureau of economic analysis")):
            raise ValueError("Unidentified joint issuer")
    figures = headline(pdf, year, month, last, repair_pdf=True)
    if figures != headline(bea, year, month, last):
        raise ValueError("Agency headlines disagree")
    current, previous, prior_issue = exhibit(orig["exhibitOne"], (year, month), (last.year, last.month))
    level, change, kind = figures
    delta = current - previous
    if abs(level - current) > 50:
        raise ValueError("Current Exhibit 1 is inconsistent with billion rounding")
    # The two inputs to the change have each been rounded to a whole million
    # in the exhibit. The headline separately rounds the change to $100m.
    if kind == "reported" and abs(change - delta) > 51:
        raise ValueError("Current/prior Exhibit 1 difference is inconsistent with the headline")
    if kind == "strict-bound" and not (0 < abs(delta) < abs(change) and delta * change > 0):
        raise ValueError("Exhibit 1 violates the published directional bound")
    return {
        "release": released, "pdfSHA256": orig["pdfSHA256"], "beaSHA256": web_hash,
        "beaURL": web_url, "monthlyExportHeadlineMillions": level, "changeOrBoundMillions": change,
        "kind": kind, "currentExhibitMillions": current, "previousInThisVintageMillions": previous,
        "previousAsPublishedLastMonthMillions": prior_issue, "yearBoundary": last.year != year,
        "scopeLimitedErratum": reviewed_erratum(period, bea, pdf), "weekdayControl": calendar_witness,
    }, signature(capture)


def summarize(records):
    summary = Counter()
    boundaries, holds, wrong_vintage, implied = [], [], [], []
    errata, weekdays = {}, {}
    for period, row in records.items():
        last_month = (dt.date.fromisoformat(period + "-01") - dt.timedelta(days=1)).strftime("%Y-%m")
        foot = row["previousAsPublishedLastMonthMillions"]
        current = row["currentExhibitMillions"]
        prior = row["previousInThisVintageMillions"]
        if last_month in records:
            if foot != records[last_month]["currentExhibitMillions"]:
                raise ValueError(period + " as-published footnote disagrees with the earlier original issue")
            summary["previousFootnotesComparedWithEarlierIssue"] += 1
        if prior != foot:
            summary["priorMonthlyFigureRevisedInThisRelease"] += 1
        if row["yearBoundary"]:
            summary["januaryCalendarRolloversVerified"] += 1
        if row["scopeLimitedErratum"]:
            errata[period] = row["scopeLimitedErratum"]
        if row["weekdayControl"]:
            weekdays[period] = row["weekdayControl"]
        if row["kind"] == "strict-bound":
            holds.append(period)
            continue
        summary["exactHeadlineObservations"] += 1
        level, change = row["monthlyExportHeadlineMillions"], row["changeOrBoundMillions"]
        if abs(change - (current - prior)) >= 50 or abs(level - current) >= 50:
            boundaries.append(period)
        if abs(change - (current - foot)) > 51:
            wrong_vintage.append(period)
        if abs((level - change) - prior) > 50:
            implied.append(period)
    return {
        "summary": dict(summary), "boundedExcluded": holds,
        "weekdayDisagreementsWithIndependentOriginalSchedule": weekdays,
        "sourceMillionRoundingBoundaries": boundaries, "asPreviouslyPublishedFootnoteMismatch": [],
        "wrongVintagesOutsideHeadlineResolution": wrong_vintage,
        "roundedHeadlineImpliedPriorOver50MillionFromCurrentExhibit": implied, "scopedErrata": errata,
    }


def verify(root, policy_path):
    check_private_dir(root)
    directory = root / "sources"
    check_private_dir(directory)
    policy_hash, sealed_at = sealed_policy(root, policy_path)
    index = private_bytes(root / "archive-index.html.gz", 3_000_000, compressed=True)
    records, input_hashes = {}, {}
    for year in range(2015, 2027):
        for month in range(1, 13):
            period = f"{year}-{month:02}"
            if not "2015-11" <= period <= "2026-08":
                continue
            canonical_url = CENSUS_PDF + f"{year % 100:02}{month:02}.pdf"
            if canonical_url.encode() not in index:
                raise ValueError(period + " missing from original Census archive index")
            try:
                records[period], input_hashes[period] = read_release(directory, period, sealed_at)
            except (ValueError, OSError, EOFError, KeyError, TypeError) as err:
                raise ValueError(f"{period}: {err}") from err
    return {
        "policySHA256": policy_hash, "expected": 130, "verified": len(records), "errors": {},
        **summarize(records), "records": records,
        "sourceManifestSHA256": signature(canonical(input_hashes)), "archiveIndexSHA256": signature(index),
        "sources": {"archive": CENSUS_INDEX, "definitions": "https://www.census.gov/foreign-trade/guide/sec2.html",
                    "reuse": "https://www.bea.gov/help/faq/147"},
    }


def record_receipt(root, receipt):
    target = root / "independent-table-audit.json"
    data = json.dumps(receipt, indent=2).encode() + b"\n"
    try:
        if private_bytes(target, 5_000_000) == data:
            return
    except FileNotFoundError:
        pass
    with tempfile.NamedTemporaryFile(dir=root, delete=False) as handle:
        path = Path(handle.name)
        try:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
            os.replace(path, target)
        finally:
            path.unlink(missing_ok=True)


def run(root=ROOT, policy_path=POLICY):
    receipt = verify(root, policy_path)
    record_receipt(root, receipt)
    return receipt


if __name__ == "__main__":
    try:
        result = run()
        print(json.dumps({"policySHA256": result["policySHA256"], "verified": result["verified"],
                          **result["summary"], "magnitudeOnlyExcluded": result["boundedExcluded"],
                          "reviewedErrata": len(result["scopedErrata"]), "receipt": str(ROOT / "independent-table-audit.json")}))
    except (OSError, EOFError, ValueError, KeyError, TypeError) as err:
        print(f"FT900 source verification failed: {err}", file=sys.stderr)
        sys.exit(1)
