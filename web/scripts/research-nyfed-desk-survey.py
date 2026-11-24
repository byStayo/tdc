#!/usr/bin/env python3
"""Privately qualify NY Fed year-end policy probabilities from the original results and workbook.

Use --collect once to obtain timestamped receipts. A replay requires no network.
The measured probability is a survey response, never a contract quote or an ETF-direction label.
"""
import argparse
import base64
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import html
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET
from zipfile import ZipFile
from zoneinfo import ZoneInfo

WEB = Path(__file__).resolve().parents[1]
FED = "https://www.newyorkfed.org"
INDEX = FED + "/markets/market-intelligence/survey-of-market-expectations"
HUB = FED + "/markets/data-hub"
HUB_SCRIPT = FED + "/medialibrary/interactives/markets/data/browser/main.js"
TERMS = FED + "/privacy/termsofuse"
CALENDAR = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
CELL = re.compile(r"([A-Z]+)[0-9]+")
FAMILY = "fftr_probdist"
MAX_BYTES = 2_000_000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def store_private(path, payload, immutable=False):
    # Link a complete first receipt into place. Concurrent captures preserve the first verified copy.
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            temp = handle.name
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        if immutable:
            try:
                os.link(temp, path)
            except FileExistsError:
                pass
        else:
            os.replace(temp, path)
            temp = None
    finally:
        if temp:
            os.unlink(temp)


def capture(root, url, collect):
    key = sha(url.encode())
    path = root / "receipts" / (key + ".json")
    if not path.exists():
        require(collect, "No saved receipt for " + url)
        req = Request(url, headers={"User-Agent": "The Daily Consensus daily data verification (thedailyconsensus.com)"})
        with urlopen(req, timeout=20) as res:
            require(res.status == 200 and res.url == url, "Unexpected source status or redirect " + url)
            body = res.read(MAX_BYTES + 1)
        require(0 < len(body) <= MAX_BYTES, "Source outside size bounds")
        record = {"url": url, "firstCapturedAt": utc(), "sha256": sha(body), "bytes": len(body)}
        obj = root / "objects" / record["sha256"]
        if not obj.exists():
            store_private(obj, body, immutable=True)
        store_private(path, json.dumps(record).encode(), immutable=True)
    record = json.loads(path.read_text())
    require(record["url"] == url and re.fullmatch(r"[a-f0-9]{64}", record["sha256"]), "Receipt identity mismatch")
    body = (root / "objects" / record["sha256"]).read_bytes()
    require(len(body) == record["bytes"] <= MAX_BYTES and sha(body) == record["sha256"], "Receipt bytes mismatch")
    return record, body


def index_pairs(text):
    pairs = []
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", text, re.I | re.S):
        urls = re.findall(r'href="(/medialibrary/media/markets/survey/(?:20[0-9]{2})/[^"<>]+)"', row)
        results = [u for u in urls if re.search(r"/[a-z]+-[0-9]{4}-sme-results\.pdf$", u)]
        if not results:
            continue
        sheets = [u for u in urls if re.search(r"/[a-z]+-[0-9]{4}-data\.xlsx$", u)]
        require(len(sheets) == len(results) == 1, "Missing native result or workbook")
        stem = results[0].removesuffix("-sme-results.pdf")
        require(sheets[0] == stem + "-data.xlsx", "Result/workbook dates differ")
        pairs.append((FED + results[0], FED + sheets[0]))
    require(0 < len(pairs) <= 250 and len(set(pairs)) == len(pairs), "Invalid combined-survey archive")
    return pairs


def xml(book, name):
    entry = book.getinfo(name)
    require(entry.file_size <= 8_000_000, "Outsize workbook part")
    data = book.read(entry)
    require(b"<!DOCTYPE" not in data.upper() and b"<!ENTITY" not in data.upper(), "Unexpected XML declaration")
    return ET.fromstring(data)


def workbook(raw):
    with ZipFile(io.BytesIO(raw)) as book:
        require(len(book.infolist()) < 80, "Too many workbook parts")
        names = xml(book, "xl/workbook.xml").findall(".//" + NS + "sheet")
        require(len(names) == 1 and names[0].get("name") == "Sheet1", "Unrecognized survey workbook structure")
        shared = ["".join(t.text or "" for t in node.iter(NS + "t")) for node in xml(book, "xl/sharedStrings.xml")] if "xl/sharedStrings.xml" in book.namelist() else []
        rows = xml(book, "xl/worksheets/sheet1.xml").iter(NS + "row")
        header = None
        for row in rows:
            cells = {}
            for cell in row.findall(NS + "c"):
                val = "".join(t.text or "" for t in cell.iter(NS + "t")) if cell.get("t") == "inlineStr" else cell.findtext(NS + "v")
                if val is None:
                    continue
                col = CELL.fullmatch(cell.get("r", "")).group(1)
                require(col not in cells, "Duplicate workbook cell")
                cells[col] = shared[int(val)] if cell.get("t") == "s" else val
            if header is None:
                require(set(("survey_release_date", "survey_due_date", "panel_type", "question_type", "horizon_date",
                             "question_tag", "bucket_range", "aggregation", "aggregation_value")) <= set(cells.values()),
                        "Workbook column schema changed")
                header = cells
            else:
                yield {header[k]: v for k, v in cells.items() if k in header}


def parse_combined(raw):
    dates = set()
    distributions = defaultdict(dict)
    for row in workbook(raw):
        if row.get("panel_type") not in {"Combined", "Dealer", "Participant"} or row.get("question_type") != "probability_distribution":
            continue
        code = row.get("question_tag", "")
        if not re.fullmatch(FAMILY + r"_(?:[0-9]{4}|[0-9]{8})", code):
            continue
        require(row.get("subject") == "fed_funds_target_range", "Question subject changed")
        dispatched, due = (date.fromisoformat(row[k]) for k in ("survey_release_date", "survey_due_date"))
        require(dispatched < due, "Invalid fieldwork dates")
        dates.add((dispatched, due))
        target, label = row["horizon_date"], row["bucket_range"]
        date.fromisoformat(target)
        key = (row["panel_type"], label, row["aggregation"])
        require(key not in distributions[target], "Duplicate combined-panel rate bin")
        distributions[target][key] = Decimal(row["aggregation_value"])
    require(len(dates) == 1 and distributions, "Missing or inconsistent combined panel")
    return next(iter(dates)), distributions


def minutes_publication(calendar, meeting):
    key = meeting.replace("-", "")
    suffix = calendar.split("fomcminutes" + key + ".htm")
    require(len(suffix) == 2, "Missing or non-unique FOMC meeting in the official calendar")
    text = html.unescape(re.sub(r"<[^>]+>", " ", suffix[1][:550]))
    match = re.search(r"\(Released\s+([A-Za-z]+\s+[0-9]{1,2},\s+[0-9]{4})\)", " ".join(text.split()))
    require(match, "No dated minutes for " + meeting)
    return datetime.strptime(match.group(1), "%B %d, %Y").date()


def next_scheduled_day(minutes):
    # These historical releases all have Wed/Thu minutes followed by a regular weekday.
    # If that pattern changes, require a separate Fed holiday-calendar check.
    require(minutes.weekday() in (1, 2, 3), "Minutes release needs a separate business-day check")
    candidate = minutes + timedelta(days=1)
    require((candidate.month, candidate.day) not in {(1, 1), (6, 19), (7, 4), (11, 11), (12, 25)}
            and not (candidate.month == 11 and candidate.weekday() == 3 and 22 <= candidate.day <= 28)
            and not (candidate.weekday() == 4 and (candidate.month, candidate.day) in {(6, 18), (7, 3), (11, 10), (12, 24), (12, 31)}),
            "Following day may be a Federal Reserve holiday")
    return candidate


def pdf_table(text, year):
    header = re.search(r"Federal Funds Rate or Range at the End of\s+" + year + r"\b", text, re.I)
    require(header, "Original report lacks a distinctly labelled year-end distribution")
    block = text[header.end():header.end() + 1500].split("\f")[0]
    next_table = re.search(r"Federal Funds Rate or Range|^\s*[0-9]+[a-z]\)", block, re.I|re.M)
    if next_table:
        block = block[:next_table.start()]
    avg = re.search(r"^\s*Average\s+([^\n]+)$", block, re.I | re.M)
    count = re.search(r"^\s*#\s*of Respondents\s+([^\n]+)$", block, re.I | re.M)
    require(avg, "Original report lacks a legible probability row")
    probs = [int(v) for v in re.findall(r"(-?[0-9]+)%", avg.group(1))]
    respondents = [int(v) for v in re.findall(r"\b[0-9]+\b", count.group(1))] if count else []
    require(3 <= len(probs) <= 25 and (not respondents or (len(probs) == len(respondents) and len(set(respondents)) == 1 and respondents[0] > 0)),
            "PDF contains inconsistent respondent counts or bins")
    # Match each printed bin with its PDF probability by the column's horizontal position.
    average_line = next(t for t in block.splitlines() if re.match(r"^\s*Average\s+", t, re.I))
    centers = [(m.start()+m.end())/2 for m in re.finditer(r"[0-9]+%", average_line)]
    before = block.split(average_line)[0]
    bins = [[] for _ in centers]
    for line in before.splitlines():
        for token in re.finditer(r"<=|>=|[0-9]+(?:\.[0-9]+)?", line):
            col = min(range(len(centers)), key=lambda i: abs(centers[i] - (token.start()+token.end())/2))
            value = token.group(0)
            bins[col].append(value if value in ("<=", ">=") else Decimal(value))
    return probs, respondents[0] if respondents else None, bins


def qualified_measurements(group, probs, respondents, pdf_bins):
    combined = {(label, stat): v for (panel, label, stat), v in group.items() if panel == "Combined"}
    labels = list(dict.fromkeys(k[0] for k in combined))
    workbook_counts = set(v for (label, stat), v in combined.items() if stat == "count")
    require(len(workbook_counts) == 1, "Native bins have different respondent counts")
    total = next(iter(workbook_counts))
    require(total == int(total) and 1 <= total <= 500 and (respondents is None or respondents == total), "PDF and native respondent counts differ")
    for label in labels:
        panel_counts = [group[(panel, label, "count")] for panel in ("Dealer", "Participant")]
        require(all(v == int(v) and 0 < v <= total for v in panel_counts) and sum(panel_counts) == total,
                "Combined respondents disagree with the distinct dealer and participant panels")
        panel_means = [group[(panel, label, "avg")] for panel in ("Dealer", "Participant")]
        require(all(v.is_finite() and 0 <= v <= 1 for v in panel_means), "Invalid separated-panel probabilities")
        weighted = sum(n * p for n, p in zip(panel_counts, panel_means)) / total
        require(abs(weighted - combined[(label, "avg")]) <= Decimal("0.01000001"), "Combined probability disagrees with the two separately rounded panels")
    group = combined
    require(len(labels) == len(probs) and len(group) == 2 * len(labels), "Workbook and report bin counts differ")
    check = []
    for col, label in enumerate(labels):
        endpoints = [x if x in ("<=", ">=") else Decimal(x) for x in re.findall(r"<=|>=|[0-9]+(?:\.[0-9]+)?", label)]
        require(endpoints == pdf_bins[col], "PDF rate-bin boundaries differ from the worksheet")
        mass, count = group[(label, "avg")], group[(label, "count")]
        require(mass.is_finite() and 0 <= mass <= 1 and count == total, "Invalid workbook probability or count")
        check.append((label, int((mass * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))))
    require([m for _, m in check] == probs and abs(sum(probs) - 100) <= len(probs) / 2, "PDF and worksheet probabilities differ")
    return int(total), [{"range": label, "meanProbabilityPct": p} for label, p in check]


def qualify(pair, reference, cal, root, collect):
    pdf_ref, pdf = capture(root, pair[0], collect)
    xls_ref, xls = capture(root, pair[1], collect)
    return compare_originals(pdf_ref, pdf, xls_ref, xls, reference, cal)


def compare_originals(pdf_ref, pdf, xls_ref, xls, reference, cal):
    extract = subprocess.run(["pdftotext", "-layout", "-", "-"], input=pdf, capture_output=True, timeout=14, check=True)
    require(0 < len(extract.stdout) < MAX_BYTES, "Native result PDF did not parse")
    text = extract.stdout.decode("utf-8")
    require(not re.search(r"confidential|internal use only|may not be (?:distributed|reproduced)|redistribution prohibited", text, re.I),
            "Native PDF contains an additional restriction")
    (distributed, due), distributions = parse_combined(xls)
    date_line = re.search(r"Distributed:\s*([0-9/]+)\s*[–-]\s*Received by:\s*([0-9/]+)", text)
    require(date_line and [datetime.strptime(v, "%m/%d/%Y").date() for v in date_line.groups()] == [distributed, due], "PDF and workbook fieldwork dates differ")
    # Some results omit the same-meeting distribution. The first question about a meeting
    # can therefore refer to the *following* FOMC and cannot date the release.
    calendar_meetings = {datetime.strptime(v, "%Y%m%d").date()
                         for v in re.findall(r"fomcminutes([0-9]{8})\.htm", cal)}
    meetings = sorted(day for day in calendar_meetings if due < day <= due + timedelta(days=16))
    require(len(meetings) == 1, "No unique independently dated meeting after survey fieldwork")
    meeting = meetings[0]
    minutes = minutes_publication(cal, str(meeting))
    posted_day = next_scheduled_day(minutes)
    require(due < meeting < minutes < posted_day, "Impossible results chronology")
    capture_date = datetime.fromisoformat(max(xls_ref["firstCapturedAt"], pdf_ref["firstCapturedAt"])).astimezone(ZoneInfo("America/New_York")).date()
    require(posted_day <= capture_date <= reference, "Native receipt or scheduled public day is outside the reference dates")
    yearly = sorted(d for d in distributions if d.endswith("-12-31") and date.fromisoformat(d) > posted_day)
    require(yearly, "No prospective year-end survey target at publication")
    measures = []
    for target in yearly:
        probs, respondents, pdf_bins = pdf_table(text, target[:4])
        count, values = qualified_measurements(distributions[target], probs, respondents, pdf_bins)
        measures.append({"targetDate": target, "respondents": count, "probabilities": values,
                         "respondentCrossCheck": "per-bin native, dealer and other participant panels" + (" and PDF" if respondents is not None else "")})
    return {"distributed": str(distributed), "responsesDue": str(due), "elapsedMeetingTarget": str(meeting), "surveyIncludesMeetingProbabilities": str(meeting) in distributions,
            "minutesReleasedDate": str(minutes), "surveyResultsPublicationDateByOfficialSchedule": str(posted_day),
            "surveyResultsOfficialClock": None, "bothDocumentsFirstVerifiedBy": max(xls_ref["firstCapturedAt"], pdf_ref["firstCapturedAt"]),
            "surveys": measures, "pdf": pdf_ref, "xlsx": xls_ref}


def check_policy(sources):
    index, hub, hub_script, terms, calendar = [body.decode("utf-8") for r, body in sources]
    strip = lambda content: " ".join(html.unescape(re.sub(r"<[^>]+>", " ", content)).split()).lower()
    require(HUB_SCRIPT.removeprefix(FED) in hub and "results are posted one business day after the fomc meeting minutes are made public" in hub_script.lower(), "Publication-day policy changed")
    legal = strip(terms)
    start = legal.index("the new york fed grants you a non-exclusive license")
    end = legal.index("except to identify the new york fed as the source", start)
    # This reviewed section includes the business-use grant, attribution, third-party and special-series restrictions.
    require(sha(legal[start:end].encode()) == "b6c3ff1dd90e46e47224f34defa9721a0662856cddc1c487015d8b2313da7510",
            "New York Fed reuse conditions changed and need review")
    return index, calendar


def native_bundle():
    raw = sys.stdin.buffer.read(14_000_001)
    require(len(raw) <= 14_000_000, "Capture bundle is too large")
    data = json.loads(raw)
    require(set(data) == {"cutoff", "sources"} and len(data["sources"]) == 7, "Invalid native source bundle")
    cutoff = datetime.fromisoformat(data["cutoff"].replace("Z", "+00:00"))
    require(cutoff.tzinfo is not None, "Invalid cutoff")
    sources = []
    for s in data["sources"]:
        body = base64.b64decode(s["base64"], validate=True)
        captured = datetime.fromisoformat(s["retrievedAt"].replace("Z", "+00:00"))
        require(captured.tzinfo is not None and captured <= cutoff and len(body) <= MAX_BYTES and
                sha(body) == s["sha256"], "Source time or hash is invalid")
        sources.append(({"url":s["url"], "sha256":s["sha256"], "firstCapturedAt":s["retrievedAt"], "bytes":len(body)}, body))
    urls = [ref["url"] for ref, body in sources]
    require(urls[:5] == [INDEX, HUB, HUB_SCRIPT, TERMS, CALENDAR], "Unrecognized policy and calendar references")
    index, cal = check_policy(sources[:5])
    require(tuple(urls[5:]) == index_pairs(index)[0], "Native documents do not match the newest released survey in the index")
    result = compare_originals(*sources[5], *sources[6], cutoff.astimezone(ZoneInfo("America/New_York")).date(), cal)
    result["firstVerifiedBy"] = max(ref["firstCapturedAt"] for ref, body in sources)
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-stdin", action="store_true", help="Verify the latest in-memory native source bundle for the publisher")
    parser.add_argument("--collect", action="store_true")
    parser.add_argument("--issues", type=int, default=1, choices=range(1, 26), metavar="1..25")
    parser.add_argument("--receipt-date", default=datetime.now(ZoneInfo("America/New_York")).date().isoformat(), help="Private capture directory YYYY-MM-DD")
    args = parser.parse_args()
    if args.native_stdin:
        native_bundle()
        return 0
    reference = date.fromisoformat(args.receipt_date)
    require(reference <= datetime.now(ZoneInfo("America/New_York")).date(), "Future capture date")
    root = WEB / ".consensus/private-nyfed-desk-survey" / str(reference) / "qualified"
    for sub in ("objects", "receipts"):
        (root / sub).mkdir(mode=0o700, exist_ok=True, parents=True)
    source_receipts = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        sources = list(pool.map(lambda u: capture(root, u, args.collect), (INDEX, HUB, HUB_SCRIPT, TERMS, CALENDAR)))
    for (r, body) in sources:
        source_receipts[r["url"]] = r
    index, calendar = check_policy(sources)
    pairs = index_pairs(index)[:args.issues]
    results, failures = [], []
    def worker(pair):
        try:
            return (qualify(pair, reference, calendar, root, args.collect), None)
        except (ValueError, KeyError, OSError, subprocess.SubprocessError) as err:
            return (None, {"pdf": pair[0], "reason": str(err)})
    with ThreadPoolExecutor(max_workers=3) as pool:
        for success, failure in pool.map(worker, pairs):
            if success:
                results.append(success)
            else:
                failures.append(failure)
    report = {"scope":"private-original-release-qualification", "sourcePolicy":"combined panel, original year-end probabilities only",
              "asOf":str(reference), "sources":source_receipts, "checked":len(pairs),"qualified":len(results),"issues":results,"failures":failures,
              "tradedOdds":False,"etfVotes":0,
              "use":"NY Fed survey attribution and terms must accompany redistribution. No trade price, traded probability, liquidity or ETF direction is observed."}
    receipt = root / ("qualification-" + str(args.issues) + ".json")
    store_private(receipt, (json.dumps(report, indent=2, allow_nan=False) + "\n").encode())
    print(json.dumps({"receipt":str(receipt.relative_to(WEB)), "checked":len(pairs),"qualified":len(results),"failures":failures, "latest": results[0]["surveys"][0] if results else None}, indent=2))
    return int(bool(failures))


if __name__ == "__main__":
    sys.exit(main())
