"""Check Deutsche Telekom's dated broker survey for a private T-Mobile US editorial review."""

import argparse
import calendar
import hashlib
import json
import math
import os
import re
import subprocess
import tempfile
from datetime import date, datetime, timezone
from html.parser import HTMLParser
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET
from zipfile import ZipFile
from zoneinfo import ZoneInfo


INDEX = "https://www.telekom.com/en/investor-relations/publications/financial-results"
METHODOLOGY = "https://www.telekom.com/en/investor-relations/publications/consensus"
TERMS = "https://www.telekom.com/en/general/terms-of-use-for-media-content"
FACTS = ("https://data.sec.gov/api/xbrl/companyconcept/CIK0001283699/"
         "us-gaap/RevenueFromContractWithCustomerExcludingAssessedTax.json")
METHOD = "tmus-deutsche-telekom-editorial-v1"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
STATISTICS = ["# of estimates", "High", "Low", "Average"]
LIMIT = 3_000_000
MEDIA_TERMS_SHA = "596997a8a9eda6344d4daa021d5a027382b13a1048eb5d9e0cf22cc786ec46af"
WORKBOOK_NOTICE_SHA = "1044630c8edece94a88550118e735da0cd6dad12b825e6e3ed734156675a8096"


def require(condition, message):
    if not condition:
        raise ValueError(message)


class SourcePage(HTMLParser):
    def __init__(self, data):
        super().__init__()
        self.links = []
        self.text = []
        self.feed(data.decode("utf-8"))

    def handle_starttag(self, tag, attrs):
        href = dict(attrs).get("href")
        if tag == "a" and href:
            self.links.append(urljoin(INDEX, href))

    def handle_data(self, text):
        self.text.extend(text.split())

    def contains(self, text):
        return text.lower() in " ".join(self.text).lower()


def consent_and_method(terms, methodology):
    main = re.findall(br"<main\b[^>]*>([\s\S]+?)</main>", terms, re.I)
    require(len(main) == 1, "Cannot identify the issuer's complete media terms")
    grant = SourcePage(main[0])
    grant_hash = hashlib.sha256(" ".join(grant.text).encode()).hexdigest()
    rule = SourcePage(methodology)
    require(grant_hash == MEDIA_TERMS_SHA and grant.contains("for journalistic and editorial purposes")
            and grant.contains("revoke any granted right of use")
            and grant.contains("You may not use the content to train AI systems"),
            "Editorial-use conditions changed and need review")
    require(rule.contains("The consensus is the median")
            and rule.contains("various analysts") and rule.contains("not intended to constitute investment advice"),
            "Issuer's aggregation or source disclaimer changed")


def attachment_period(url):
    parsed = urlparse(url)
    if (parsed.scheme != "https" or parsed.netloc != "corporate-media.telekom.com"
            or not parsed.path.startswith("/adobe/assets/") or parsed.fragment
            or parsed.query not in ("", "attachment=true")):
        return None
    name = unquote(parsed.path).rsplit("/", 1)[-1].lower()
    if "consensus" not in name or not name.endswith((".pdf", ".xlsx")):
        return None
    modern = re.search(r"\bq([1-4])\s+(20\d{2})\b", name)
    short = re.search(r"\bdt-(\d{2})q([1-4])-consensus-", name)
    if modern:
        period = int(modern[2]), int(modern[1])
    elif short:
        period = 2000 + int(short[1]), int(short[2])
    else:
        return None
    return period, name.rsplit(".", 1)[1]


def select_pairs(index, methodology):
    def inventory(page):
        found = {}
        for url in set(SourcePage(page).links):
            result = attachment_period(url)
            if result:
                period, extension = result
                group = found.setdefault(period, {})
                require(extension not in group, "Multiple native attachments for the same fiscal period")
                group[extension] = url
        return found

    archive = inventory(index)
    current = inventory(methodology)
    require(len(current) == 1, "Current methodology page has an ambiguous quarterly packet")
    latest = next(iter(current))
    require(archive.get(latest) == current[latest] and set(current[latest]) == {"pdf", "xlsx"},
            "Issuer archive does not corroborate the latest PDF and workbook")
    previous = (latest[0], latest[1] - 1) if latest[1] > 1 else (latest[0] - 1, 4)
    periods = [latest]
    if set(archive.get(previous, {})) == {"pdf", "xlsx"}:
        periods.insert(0, previous)
    return [(period, archive[period]) for period in periods]


def xml_member(book, path):
    require(book.getinfo(path).file_size <= 1_200_000, "Unexpectedly large workbook part")
    data = book.read(path)
    require(b"<!DOCTYPE" not in data.upper() and b"<!ENTITY" not in data.upper(), "Invalid workbook XML")
    return ET.fromstring(data)


def worksheet(raw):
    with ZipFile(BytesIO(raw)) as book:
        sheets = xml_member(book, "xl/workbook.xml").findall("m:sheets/m:sheet", NS)
        match = [sheet for sheet in sheets if sheet.get("name") == "Overview Ys"]
        require(len(match) == 1, "Missing or repeated analyst-estimate worksheet")
        target = [item.get("Target", "") for item in xml_member(book, "xl/_rels/workbook.xml.rels")
                  if item.get("Id") == match[0].get(REL_ID) and item.get("TargetMode") != "External"]
        require(len(target) == 1 and re.fullmatch(r"worksheets/sheet\d+\.xml", target[0]), "Invalid worksheet reference")
        strings = ["".join(x.text or "" for x in item.findall(".//m:t", NS))
                   for item in xml_member(book, "xl/sharedStrings.xml")]
        rows = {}
        for row in xml_member(book, "xl/" + target[0]).findall("m:sheetData/m:row", NS):
            n = int(row.attrib["r"])
            require(n not in rows, "Duplicate workbook row")
            rows[n] = {}
            for cell in row.findall("m:c", NS):
                value = cell.findtext("m:v", None, NS)
                if value is None:
                    continue
                split = re.fullmatch(r"([A-Z]+)(\d+)", cell.attrib["r"])
                require(split and int(split[2]) == n and split[1] not in rows[n], "Invalid cell reference")
                if cell.get("t") == "s":
                    require(value.isdigit() and int(value) < len(strings), "Invalid shared string reference")
                    value = strings[int(value)].strip()
                rows[n][split[1]] = value
        core = xml_member(book, "docProps/core.xml")
        modified = [node.text for node in core if node.tag.endswith("}modified")]
        require(len(modified) == 1, "Missing workbook modification time")
        return rows, date.fromisoformat(modified[0][:10])


def workbook_values(rows, period):
    headers = [row for row in rows.values() if row.get("B") == "Q" + str(period[1])]
    target = [n for n, row in rows.items() if row.get("A") == "Gross revs in $ (US GAAP)"]
    require(len(headers) == 1 and len(target) == 1, "Ambiguous T-Mobile US dollar revenue row or fiscal quarter")
    n = target[0]
    require(rows.get(n - 1, {}).get("A") == "TMUS (gross revs in €)"
            and rows.get(n + 1, {}).get("A") == "Service revs in $ (US GAAP)",
            "T-Mobile US segment, currency or revenue mapping changed")
    require(any(row.get("A") == "Gross Revs [€ million]" for row in rows.values()), "Missing million-unit header")
    header, values = headers[0], rows[n]
    groups = {}
    # Each period in this native sheet has a median, count, high, low and average.
    for first in ["B", "G", "L", "Q", "V"]:
        label = header.get(first, "")
        expected_header = f"Q{period[1]}"
        if first != "B":
            fiscal_year = period[0] + (ord(first) - ord("G")) // 5
            expected_header = f"FY {fiscal_year % 100:02d}"
        require(label == expected_header, "Unrecognized fiscal period in the estimate table")
        cols = [chr(ord(first) + offset) for offset in range(5)]
        require([header.get(c) for c in cols[1:]] == STATISTICS, "Summary statistic columns changed")
        numbers = [float(values[c]) for c in cols]
        median, count, high, low, average = numbers
        require(all(math.isfinite(x) for x in numbers) and count.is_integer() and 2 <= count <= 200
                and 0 < low <= median <= high and low <= average <= high,
                "Missing contributors or inconsistent USD revenue estimates")
        groups[label] = {"medianUsdMillions": median, "analysts": int(count)}
    require(f"FY {period[0] % 100:02d}" in groups, "No matching fiscal-year estimate")
    return groups


def verify_pair(period, workbook, pdf):
    rows, modified = worksheet(workbook)
    notice = " ".join(rows.get(1, {}).get("A", "").split())
    require(hashlib.sha256(notice.encode()).hexdigest() == WORKBOOK_NOTICE_SHA,
            "Issuer changed the asset-specific notice. A new editorial review is required")
    groups = workbook_values(rows, period)
    require(pdf.startswith(b"%PDF"), "The paired report is not a PDF")
    text = subprocess.run(["pdftotext", "-layout", "-", "-"], input=pdf, capture_output=True,
                          check=True, timeout=12).stdout.decode()
    require(re.search(rf"Consensus Details Q{period[1]} and FY {period[0]}\b", text), "PDF period mismatches workbook")
    dates = re.findall(r"(?m)^\s*(\d{2}\.\d{2}\.\d{4})\s*$", text)
    require(len(dates) == 1, "Expected one printed survey date")
    vintage = datetime.strptime(dates[0], "%d.%m.%Y").date()
    require(vintage == modified, "Printed vintage differs from workbook modification day")
    lines = re.findall(r"(?m)^\s*Gross revs in \$ \(US GAAP\)\s+([^\n]+)", text)
    require(len(lines) == 1, "Missing independently rendered US-GAAP gross revenue row")
    cells = lines[0].split()
    require(len(cells) >= len(groups) * 5, "Truncated paired PDF estimate row")
    for index, group in enumerate(groups.values()):
        printed = cells[index * 5]
        require(re.fullmatch(r"\d{1,3}(?:\.\d{3})+", printed) and
                abs(group["medianUsdMillions"] - int(printed.replace(".", ""))) <= 0.501 and
                int(cells[index * 5 + 1]) == group["analysts"], "PDF disagrees with workbook median or analyst count")
    return {"year": period[0], "quarter": period[1], "printedDate": str(vintage), "estimates": groups}


def first_quarter_actual(facts, latest, as_of):
    require(facts.get("cik") == 1283699 and facts.get("taxonomy") == "us-gaap"
            and facts.get("tag") == "RevenueFromContractWithCustomerExcludingAssessedTax",
            "Incorrect SEC registrant or US-GAAP concept")
    y, q = latest["year"], latest["quarter"]
    begin, end_month = date(y, q * 3 - 2, 1), q * 3
    end = date(y, end_month, calendar.monthrange(y, end_month)[1])
    eligible = [row for row in facts.get("units", {}).get("USD", []) if
                row.get("start") == str(begin) and row.get("end") == str(end) and
                row.get("fy") == y and row.get("fp") == (f"Q{q}" if q < 4 else "FY") and
                row.get("form") == ("10-Q" if q < 4 else "10-K")]
    if not eligible:
        return None
    first = min(row["filed"] for row in eligible)
    original = [row for row in eligible if row["filed"] == first]
    require(len({(row["accn"], row["val"]) for row in original}) == 1 and
            re.fullmatch(r"\d{10}-\d{2}-\d{6}", original[0]["accn"]) and original[0]["val"] > 0,
            "Ambiguous original fiscal-quarter filing")
    require(first > latest["printedDate"] and first > str(end), "Consensus postdates the initial filed result")
    # No public dissemination hour was established by this SEC API. Admission starts the following date.
    if first >= str(as_of):
        return None
    accession = original[0]["accn"]
    return {"filed": first, "accession": accession, "usdMillions": original[0]["val"] / 1_000_000,
            "original": f"https://www.sec.gov/Archives/edgar/data/1283699/{accession.replace('-', '')}/{accession}-index.htm"}


def review(packet):
    def part(name):
        return packet[name]["body"]

    for name, source in [("terms", TERMS), ("methodology", METHODOLOGY), ("index", INDEX), ("sec", FACTS)]:
        require(packet[name]["url"] == source, "Unexpected origin for a required editorial source")
    for record in packet.values():
        require(datetime.fromisoformat(record["receivedAt"]).utcoffset() == timezone.utc.utcoffset(None),
                "Expected a UTC capture instant")
    consent_and_method(part("terms"), part("methodology"))
    selection = select_pairs(part("index"), part("methodology"))
    vintages = []
    for period, urls in selection:
        stem = f"{period[0]}-Q{period[1]}"
        for ext in ("xlsx", "pdf"):
            require(packet[f"{stem}.{ext}"]["url"] == urls[ext], "Native attachment does not match the issuer archive")
        vintages.append(verify_pair(period, part(f"{stem}.xlsx"), part(f"{stem}.pdf")))
    latest = vintages[-1]
    verified = max(datetime.fromisoformat(row["receivedAt"]) for row in packet.values())
    local_day = verified.astimezone(ZoneInfo("America/New_York")).date()
    require(date.fromisoformat(latest["printedDate"]) <= verified.astimezone(ZoneInfo("Europe/Berlin")).date(),
            "Future-dated survey")
    quarter = latest["estimates"][f"Q{latest['quarter']}"]
    year = f"FY {latest['year'] % 100:02d}"
    actual = first_quarter_actual(json.loads(part("sec")), latest, local_day)
    updated = latest["estimates"][year]
    revision = None
    if len(vintages) == 2:
        prior = vintages[0]
        require(prior["printedDate"] < latest["printedDate"], "Unordered release vintages")
        if year in prior["estimates"]:
            previous = prior["estimates"][year]
            revision = {"target": year, "earlierDate": prior["printedDate"], "earlierAnalysts": previous["analysts"],
                        "laterDate": latest["printedDate"], "laterAnalysts": updated["analysts"],
                        "changePct": (updated["medianUsdMillions"] / previous["medianUsdMillions"] - 1) * 100}
    return {"method": METHOD, "scope": "removable private editorial check about T-Mobile US",
            "statistic": "median of external analysts surveyed by parent Deutsche Telekom",
            "basis": "T-Mobile US consolidated US GAAP total revenue, USD millions",
            "surveyDate": latest["printedDate"], "fiscalQuarter": f"{latest['year']}-Q{latest['quarter']}",
            "verifiedAt": verified.isoformat(), "releaseTiming": "printed vintage confirmed; original public intraday time unverified",
            "historicalFirstSeenVerified": False, "quarterlyConsensus": quarter, "filedActual": actual,
            "quarterlyDifferencePct": None if not actual else (actual["usdMillions"] / quarter["medianUsdMillions"] - 1) * 100,
            "annualRevision": revision, "investorRelations": METHODOLOGY, "terms": TERMS,
            "surveyPublications": [urls["pdf"] for _, urls in selection],
            "publicArchive": False, "modelUse": False, "familyVote": False}


def capture(url):
    require(url in (INDEX, METHODOLOGY, TERMS, FACTS) or attachment_period(url), "Unsupported source")
    request = Request(url, headers={"User-Agent": "The Daily Consensus research contact@thedailyconsensus.com"})
    with urlopen(request, timeout=15) as response:
        require(response.status == 200 and response.url == url, "Unexpected provider response")
        body = response.read(LIMIT + 1)
        require(0 < len(body) <= LIMIT, "Source document size outside bounds")
        return {"url": url, "receivedAt": datetime.now(timezone.utc).isoformat(), "body": body}


def acquire():
    packet = {name: capture(url) for name, url in [("terms", TERMS), ("methodology", METHODOLOGY), ("index", INDEX)]}
    consent_and_method(packet["terms"]["body"], packet["methodology"]["body"])
    for period, urls in select_pairs(packet["index"]["body"], packet["methodology"]["body"]):
        for ext, url in urls.items():
            packet[f"{period[0]}-Q{period[1]}.{ext}"] = capture(url)
    packet["sec"] = capture(FACTS)
    return packet


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collect", action="store_true", help="request native originals for this editorial check")
    parser.add_argument("packet", type=Path, help="private capture directory under this checkout's .editorial")
    args = parser.parse_args()
    directory = args.packet.resolve()
    allowed = Path(__file__).resolve().parents[1] / ".editorial"
    require(allowed in directory.parents, "Select a removable owner-only directory inside .editorial")
    os.umask(0o077)
    if args.collect:
        require(not directory.exists(), "Use a new private directory or replay the existing one")
        packet = acquire()
        result = review(packet)
        directory.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=directory.parent) as tmp:
            staging = Path(tmp) / "packet"
            staging.mkdir(mode=0o700)
            manifest = {}
            for name, record in packet.items():
                body = record["body"]
                digest = hashlib.sha256(body).hexdigest()
                (staging / digest).write_bytes(body)
                manifest[name] = {"url": record["url"], "receivedAt": record["receivedAt"], "sha256": digest}
            (staging / "sources.json").write_text(json.dumps(manifest, indent=2))
            (staging / "aggregate.json").write_text(json.dumps(result, indent=2))
            staging.rename(directory)
    else:
        packet = {}
        for name, record in json.loads((directory / "sources.json").read_text()).items():
            digest = record["sha256"]
            require(re.fullmatch(r"[a-f0-9]{64}", digest), "Invalid evidence digest")
            body = (directory / digest).read_bytes()
            require(hashlib.sha256(body).hexdigest() == digest, "Changed editorial source bytes")
            packet[name] = {**record, "body": body}
        result = review(packet)
        require(result == json.loads((directory / "aggregate.json").read_text()), "Changed original editorial result")
    print(json.dumps({"scope": result["scope"], "fiscalQuarter": result["fiscalQuarter"],
                      "surveyDate": result["surveyDate"], "filedActualVerified": result["filedActual"] is not None,
                      "annualRevisionVerified": result["annualRevision"] is not None,
                      "modelUse": False, "publicArchive": False}, indent=2))


if __name__ == "__main__":
    main()
