"""Witness the pre-release US profit survey and compare original BEA vintages privately."""

import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import tempfile
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from io import BytesIO, StringIO
from pathlib import Path
from statistics import median
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET
from zipfile import ZipFile


SCRIPT = Path(__file__).resolve()
POLICY_FILE = SCRIPT.with_name("spf-profit-witness-policy.json")
DEFAULT = SCRIPT.parents[1] / ".consensus/private-spf-profit-witness"
PHILLY = "https://www.philadelphiafed.org"
BEA = "https://www.bea.gov"
ARCHIVE = "https://apps.bea.gov/histdata/Files/Releases/GDP_and_PI"
BEA_NEWS = BEA + "/news/2026/"
BASIS = PHILLY + "/surveys-and-data/cprof"
RIGHTS = PHILLY + "/about-us/privacy-notice"
SCOPE = PHILLY + "/-/media/FRBP/Assets/Surveys-And-Data/survey-of-professional-forecasters/spf-data-sources.pdf"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
N = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
LIMIT = 8_000_000


def check(value, message):
    if not value:
        raise ValueError(message)


def now():
    return datetime.now(timezone.utc)


def utc(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    check(result.utcoffset() == timezone.utc.utcoffset(None), "Expected a UTC source clock")
    return result


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def seal(path, value):
    """Atomic create without replacing an existing witness, even on concurrent runs."""
    encoded = (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        try:
            f.write(encoded)
            f.flush()
            os.fsync(f.fileno())
            os.link(f.name, path)
        finally:
            os.unlink(f.name)


def private_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    check(not path.is_symlink() and path.is_dir() and not info.st_mode & 0o077 and info.st_uid == os.getuid(),
          "Research directory must be owner-only")


def private_bytes(path):
    info = path.lstat()
    check(path.is_file() and not path.is_symlink() and info.st_uid == os.getuid() and info.st_nlink == 1
          and not info.st_mode & 0o077 and 0 < info.st_size <= LIMIT, "Unprotected or invalid source file")
    return path.read_bytes()


class SourceStore:
    def __init__(self, root, online):
        private_dir(root)
        self.directory = root / "originals"
        private_dir(self.directory)
        self.online = online
        self.records = {}

    def get(self, name, url):
        check(urlsplit(url).scheme == "https" and urlsplit(url).netloc in
              {"www.philadelphiafed.org", "apps.bea.gov", "www.bea.gov", "alfred.stlouisfed.org"},
              "Unexpected source origin")
        base = self.directory / name
        body, meta = base.with_suffix(".body"), base.with_suffix(".json")
        if not meta.exists() and self.online:
            request = Request(url, headers={"User-Agent": "The Daily Consensus public research https://thedailyconsensus.com"})
            with urlopen(request, timeout=18) as response:
                check(response.status == 200 and response.geturl() == url, "Unverified native source response")
                raw = response.read(LIMIT + 1)
            check(0 < len(raw) <= LIMIT, "Source exceeds the bounded research request")
            record = {"url": url, "servedUrl": url, "bytes": len(raw), "sha256": sha(raw),
                      "receivedAt": now().isoformat(timespec="milliseconds")}
            with tempfile.NamedTemporaryFile(dir=self.directory, delete=False) as f:
                try:
                    f.write(raw)
                    f.flush()
                    os.fsync(f.fileno())
                    os.link(f.name, body)
                except FileExistsError:
                    check(private_bytes(body) == raw, "An earlier source capture differs")
                finally:
                    os.unlink(f.name)
            try:
                seal(meta, record)
            except FileExistsError:
                pass
        record = json.loads(private_bytes(meta))
        raw = private_bytes(body)
        check(record["url"] == record["servedUrl"] == url and record["bytes"] == len(raw)
              and sha(raw) == record["sha256"] and utc(record["receivedAt"]) <= now(),
              "Source identity, body or arrival clock failed to replay")
        self.records[name] = record
        return raw


class Page(HTMLParser):
    def __init__(self, raw, base):
        super().__init__()
        self.base = base
        self.links = set()
        self.words = []
        self.feed(raw.decode("utf-8"))

    def handle_starttag(self, tag, attrs):
        href = dict(attrs).get("href")
        if tag == "a" and href:
            self.links.add(urljoin(self.base, href))

    def handle_data(self, text):
        self.words.extend(text.split())

    def link(self, suffix):
        found = [url for url in self.links if urlsplit(url).path.lower().endswith(suffix.lower())]
        check(len(found) == 1, "Official page has no unique matching attachment")
        return found[0]

    @property
    def text(self):
        return " ".join(self.words)


def pdf_text(raw):
    check(raw.startswith(b"%PDF"), "Missing primary PDF")
    return subprocess.run(["pdftotext", "-layout", "-", "-"], input=raw, capture_output=True,
                          check=True, timeout=12).stdout.decode()


def rows(raw, sheet_name):
    with ZipFile(BytesIO(raw)) as book:
        def xml(path):
            check(book.getinfo(path).file_size <= LIMIT, "Unexpectedly large workbook part")
            b = book.read(path)
            check(b"<!DOCTYPE" not in b.upper() and b"<!ENTITY" not in b.upper(), "Unexpected XML declaration")
            return ET.fromstring(b)

        sheets = [s for s in xml("xl/workbook.xml").find(N + "sheets") if s.get("name") == sheet_name]
        check(len(sheets) == 1, "Missing or duplicated native worksheet")
        ref = sheets[0].get(R + "id")
        targets = [r.get("Target") for r in xml("xl/_rels/workbook.xml.rels")
                   if r.get("Id") == ref and r.get("TargetMode") != "External"]
        check(len(targets) == 1 and re.fullmatch(r"worksheets/sheet\d+\.xml", targets[0]), "Invalid worksheet relationship")
        strings = ["".join(node.text or "" for node in item.iter(N + "t"))
                   for item in xml("xl/sharedStrings.xml")]
        for row in xml("xl/" + targets[0]).find(N + "sheetData"):
            data = {}
            for cell in row.findall(N + "c"):
                value = cell.findtext(N + "v")
                if value is None:
                    continue
                coord = re.fullmatch(r"([A-Z]+)(\d+)", cell.get("r", ""))
                check(coord and coord[2] == row.get("r") and coord[1] not in data, "Invalid worksheet cell")
                data[coord[1]] = strings[int(value)] if cell.get("t") == "s" else value
            if data:
                yield data


def only(values, message):
    found = list(values)
    check(len(found) == 1, message)
    return found[0]


def quarter_rows(raw, sheet, year, quarter):
    stream = rows(raw, sheet)
    headers = next(stream)
    check(headers.get("A") == "YEAR" and headers.get("B") == "QUARTER"
          and len(headers) == len(set(headers.values())), "Invalid survey year, quarter or duplicated field")
    for row in stream:
        if Decimal(row["A"]) == year and Decimal(row["B"]) == quarter:
            yield {name: row[col] for col, name in headers.items() if col in row}


def dated_pdf(page):
    dates = re.findall(r"Release Date:\s*([A-Za-z]+ \d{1,2}, \d{4})", page)
    return datetime.strptime(only(dates, "Survey PDF lacks a unique release date"), "%B %d, %Y").date()


def displayed_forecast(text, period):
    parts = re.split(r"(?m)^\s*TABLE ONE\s*$", text)
    check(len(parts) == 2, "Missing unique levels table")
    levels = re.split(r"(?m)^\s*TABLE TWO\s*$", parts[1])[0]
    check("MEDIANS OF FORECASTER PREDICTIONS" in levels and "MAJOR MACROECONOMIC INDICATORS" in levels,
          "Original does not identify the median levels")
    header = re.search(r"(?m)^\s*OF\s+([\d ]+)\s*\n\s*FORECASTERS\s+([^\n]+)", levels)
    check(header and header[1].split()[1] == str(period["year"])
          and header[2].split()[1] == "Q" + str(period["quarter"]), "Printed current-quarter forecast header differs")
    matched = re.findall(r"(?m)^\s*3\. CORPORATE PROFITS AFTER TAXES\s+(\d+)\s+(\S+)\s+([\d.]+)[^\n]*\n\s*\(\$ BILLIONS\)", levels)
    contributors, prior, current = only(matched, "Missing or ambiguous corporate profits levels row")
    return int(contributors), prior, Decimal(current)


def checked_survey(period, original, medians, participants):
    check(dated_pdf(original).isoformat() == period["survey"], "Unexpected survey release date")
    printed_count, _, printed = displayed_forecast(original, period)
    year, quarter = period["year"], period["quarter"]
    record = only(quarter_rows(medians, "Median_Level", year, quarter), "Duplicate or missing median survey vintage")
    native = Decimal(record["CPROF2"])
    values = {}
    for row in quarter_rows(participants, "CPROF", year, quarter):
        value = row.get("CPROF2")
        if value in (None, "", "#N/A", "NA", "#NUM!"):
            continue
        try:
            number = Decimal(value)
        except InvalidOperation as err:
            raise ValueError("Unknown source missing-value marker") from err
        check(number.is_finite() and number > 0 and row.get("ID") and row["ID"] not in values,
              "Invalid or duplicated individual forecast")
        values[row["ID"]] = number
    check(printed_count == len(values) and printed_count >= 2 and abs(median(values.values()) - native) <= Decimal("0.00005")
          and abs(printed - native) <= Decimal("0.05"), "Survey values and respondent count disagree across native sources")
    return {"usdBillions": str(native), "forecasters": printed_count, "released": period["survey"]}


def nipa(raw, year, quarter, vintage):
    table = list(rows(raw, "T11200-Q"))
    leading = [r.get("A", "") for r in table[:7]]
    text_date = date.fromisoformat(vintage).strftime("%B %d, %Y").replace(" 0", " ")
    check("Table 1.12. National Income by Type of Income" in leading and "Bureau of Economic Analysis" in leading
          and "[Millions of dollars] Seasonally adjusted at annual rates" in leading
          and "Data published " + text_date in leading, "Wrong original NIPA vintage, table, units or seasonal basis")
    headers = only((r for r in table if r.get("A") == "Line"), "Ambiguous NIPA period header")
    line = only((r for r in table if r.get("C") == "A551RC"), "Target profit series absent or duplicated")
    check(line.get("A") == "15" and line.get("B", "").strip() == "Profits after tax with IVA and CCAdj",
          "Wrong profit concept or accounting basis")

    def level(q):
        column = only((c for c, key in headers.items() if key == f"{year}Q{q}"), "Wrong or duplicate target quarter")
        raw_value = line.get(column)
        if raw_value in (None, "", "....."):
            return None
        amount = Decimal(raw_value)
        check(amount.is_finite() and amount > 0, "Unknown or invalid profit cell")
        return amount / 1000

    return level(quarter - 1), level(quarter)


def archive_url(period, stage, when):
    token = date.fromisoformat(when).strftime("%B-%d-%Y")
    return f'{ARCHIVE}/{period["year"]}/Q{period["quarter"]}/{stage}_{token}/Section1all_xls.xlsx'


def survey_url(q):
    return f"{PHILLY}/surveys-and-data/real-time-data-research/spf-q{q}-2026"


def survey_pdf(store, q):
    url = survey_url(q)
    key = f"spf-2026q{q}"
    page = Page(store.get(key, url), url)
    return pdf_text(store.get(key + "-pdf", page.link(f"/spfQ{q}26.pdf")))


def pre_release(store, policy):
    terms = Page(store.get("phl-terms", RIGHTS), RIGHTS).text
    check("informational, educational, and research purposes only" in terms
          and "Permission to use such copyrighted material" in terms, "The Philadelphia Fed use conditions changed")
    scope = " ".join(pdf_text(store.get("bea-series-scope", SCOPE)).split())
    check("Survey of Current Business, Table 1.12" in scope and
          "corporate profits after tax with inventory valuation and capital consumption adjustments" in scope,
          "Survey and government accounting definitions do not match")
    basis = Page(store.get("spf-basis", BASIS), BASIS)
    check("Includes IVA and CCAdj 2006-present" in basis.text, "The survey accounting basis changed")
    medians = store.get("median", basis.link("/Median_CPROF_Level.xlsx"))
    individuals = store.get("individual", basis.link("/Individual_CPROF.xlsx"))
    baselines = {}
    for name in ("completedExample", "prospective"):
        period = policy[name]
        q = period["quarter"]
        forecast = checked_survey(period, survey_pdf(store, q), medians, individuals)
        prior, target = nipa(store.get(f"bea-q{q}-control", archive_url(period, "Advance", period["advance"])),
                             period["year"], q, period["advance"])
        check(prior is not None and target is None, "Prior-quarter baseline or missing target could not be established")
        baselines[name] = {"quarter": f'2026Q{q}', "survey": forecast,
                           "priorQuarterControlUsdBillions": str(prior), "controlVintage": period["advance"]}
    later = survey_pdf(store, 4)
    check(dated_pdf(later) == date(2026, 11, 16)
          and displayed_forecast(later, {"year": 2026, "quarter": 4})[1] == "N.A.",
          "November original did not confirm the prior-quarter actual was unavailable")
    url = BEA_NEWS + "gdp-advance-estimate-3rd-quarter-2026"
    calendar = Page(store.get("bea-q3-schedule", url), url).text
    check("November 25, 2026, at 8:30 a.m. EST" in calendar
          and "GDP (Second Estimate) and Corporate Profits, 3rd Quarter 2026" in calendar,
          "BEA's original release does not establish the registered time and quarter")
    return baselines


def alfred_url(q, period):
    day = date(2026, 3 * q - 2, 1).isoformat()
    return (f"https://alfred.stlouisfed.org/graph/alfredgraph.csv?bgcolor=%23ebf3fb&chart_type=line"
            f"&cosd={day}&coed={day}&id=CPATAX&vintage_date={period['first']}")


def release_comparison(store, key, period, benchmark):
    q = period["quarter"]
    when = utc(period["releaseAt"])
    check(now() >= when, "The scheduled first release has not occurred")
    ordinal = "2nd" if q == 2 else "3rd"
    url = BEA_NEWS + f"gdp-second-estimate-and-corporate-profits-{ordinal}-quarter-2026"
    release_key = f"bea-2026q{q}"
    page = Page(store.get(release_key, url), url)
    original = pdf_text(store.get(release_key + "-pdf", page.link(f"/gdp{q}q26-2nd.pdf")))
    compact = " ".join(original.split())
    release_day = date.fromisoformat(period["first"]).strftime("%A, %B %d, %Y").replace(" 0", " ")
    zone = "EDT" if q == 2 else "EST"
    check(f"8:30 a.m. {zone}, {release_day}" in compact and
          f"GDP (Second Estimate) and Corporate Profits, {ordinal} Quarter 2026" in compact,
          "Unverified first government release, quarter or public clock")
    current = store.get(f"bea-q{q}-first-nipa", archive_url(period, "Second", period["first"]))
    _, actual = nipa(current, period["year"], q, period["first"])
    check(actual is not None, "First official vintage does not contain the target")
    csv_key = f"q{q}-alfred-control"
    check_rows = list(csv.reader(StringIO(store.get(csv_key, alfred_url(q, period)).decode())))
    check(len(check_rows) == 2 and check_rows[0] == ["observation_date", "CPATAX_" + period["first"].replace("-", "")]
          and len(check_rows[1]) == 2 and check_rows[1][0] == date(2026, 3 * q - 2, 1).isoformat()
          and Decimal(check_rows[1][1]) == actual, "Independent delivery of the exact first vintage differs")
    for name in (release_key, release_key + "-pdf", f"bea-q{q}-first-nipa", csv_key):
        check(utc(store.records[name]["receivedAt"]) >= when, "Actual receipt predates the public release")
    survey, control = Decimal(benchmark["survey"]["usdBillions"]), Decimal(benchmark["priorQuarterControlUsdBillions"])
    return {"status": key, "target": benchmark["quarter"], "publicAt": period["releaseAt"], "actualUsdBillions": str(actual),
            "surveyMissUsdBillions": str(actual - survey), "priorQuarterMissUsdBillions": str(actual - control),
            "reductionInAbsoluteErrorUsdBillions": str(abs(actual - control) - abs(actual - survey)),
            "actualAvailableOnHostAt": max(store.records[name]["receivedAt"] for name in
                                           (release_key, release_key + "-pdf", f"bea-q{q}-first-nipa", csv_key))}


def verified_first_release(root, period, benchmark, online):
    destination = root / "first-release-sources"
    if not destination.exists():
        check(online, "No verified first-release originals exist")
        # BEA and its independent delivery can arrive at different times. Only preserve
        # a complete, reconciled bundle. A transient blank from ALFRED can then recover.
        with tempfile.TemporaryDirectory(dir=root) as temporary:
            pending = Path(temporary) / "packet"
            native = SourceStore(pending, True)
            release_comparison(native, "first_release_reconciled", period, benchmark)
            try:
                pending.rename(destination)
            except OSError:
                if not destination.is_dir():
                    raise
    saved = SourceStore(destination, False)
    result = release_comparison(saved, "first_release_reconciled", period, benchmark)
    return result, saved.records


def command(root, action):
    policy = json.loads(POLICY_FILE.read_bytes())
    witness_file = root / "prerelease.json"
    cutoff = utc(policy["prospective"]["releaseAt"])
    if action == "compare":
        check(now() >= cutoff, "The scheduled first release has not occurred")
    if not witness_file.exists():
        check(action == "witness" and now() < cutoff, "No genuine pre-release witness exists")
    store = SourceStore(root, action != "replay")
    baselines = pre_release(store, policy)
    binding = {"policySHA256": sha(POLICY_FILE.read_bytes()), "method": policy["method"],
               "sourceReceipts": dict(store.records), "baselines": baselines}
    if not witness_file.exists():
        captured = now()
        check(all(utc(r["receivedAt"]) <= captured for r in store.records.values())
              and captured < cutoff, "Refuse to backdate the prospective witness")
        try:
            seal(witness_file, {**binding, "witnessedAt": captured.isoformat(timespec="milliseconds")})
        except FileExistsError:
            pass
    saved = json.loads(private_bytes(witness_file))
    witnessed = utc(saved.pop("witnessedAt"))
    check(saved == binding and max(utc(r["receivedAt"]) for r in store.records.values()) <= witnessed < cutoff,
          "Pre-release witness no longer binds the original sources, forecast or cutoff")
    result = {"method": policy["method"], "witnessSHA256": sha(private_bytes(witness_file)),
              "witnessedAt": witnessed.isoformat(timespec="milliseconds"), "baselines": baselines,
              "priorQuarter": release_comparison(store, "retrospective_original", policy["completedExample"], baselines["completedExample"])}
    result_file = root / "first-release.json"
    if action == "compare" or result_file.exists():
        result["prospective"], native = verified_first_release(root, policy["prospective"], baselines["prospective"],
                                                              action == "compare")
        comparison = {"witnessSHA256": result["witnessSHA256"], "prospective": result["prospective"], "sources": native}
        if action == "compare" and not result_file.exists():
            try:
                seal(result_file, comparison)
            except FileExistsError:
                pass
        check(json.loads(private_bytes(result_file)) == comparison, "Previously verified first-release comparison changed")
    else:
        result["prospective"] = {"status": "awaiting_first_release" if now() < cutoff else "awaiting_verified_first_release",
                                 "scheduledAt": policy["prospective"]["releaseAt"]}
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("witness", "replay", "compare"))
    parser.add_argument("--private-root", type=Path, default=DEFAULT)
    args = parser.parse_args()
    try:
        print(json.dumps(command(args.private_root, args.operation), indent=2))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Profits source verification failed: {error}\n")
