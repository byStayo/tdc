"""Verify public SEC Form N-PORT B.6 as a private fiscal-quarter ETF share-flow control."""
import argparse
import calendar
import fcntl
import hashlib
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, localcontext
from html import unescape
from pathlib import Path
from stat import S_ISREG
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class Fund:
    cik: int
    file_number: str
    lei: str
    series: str | None
    share_class: str | None
    sample: str


FUNDS = {
    "SPY": Fund(884394, "811-06125", "549300NZAMSJ8FXPQQ63", None, None, "0001410368-26-089410"),
    "QQQ": Fund(1067839, "811-08947", "549300VY6FEJBCIMET58", "S000101292", "C000271435", "0001067839-26-000030"),
    "IWM": Fund(1100663, "811-09729", "549300O80OAR5VTWR172", "S000004344", "C000012074", "0002071691-26-019749"),
    "DIA": Fund(1041130, "811-09170", "54930039F2SG3UG2OZ18", None, None, "0001410368-26-095867"),
    "TLT": Fund(1100663, "811-09729", "549300WWURKS1JGBZU59", "S000004360", "C000012090", "0002071691-26-024225"),
}
ROOT = Path(__file__).resolve().parents[1] / ".consensus" / "private-sec-etf-flows" / "v1"
ACCESSION = re.compile(r"[0-9]{10}-[0-9]{2}-[0-9]{6}")
NUMBER = re.compile(r"[0-9]{1,24}(?:\.[0-9]{1,12})?")
NS = "{http://www.sec.gov/edgar/nport}"
NEW_YORK = ZoneInfo("America/New_York")
FORM = {"NPORT-P", "NPORT-P/A"}
AGENT = "DailyConsensusResearch/1.0 (+https://thedailyconsensus.com)"
METHOD = "sec-nport-b6-three-month-net-share-sales-v1"


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Missing UTC instant")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise ValueError("SEC availability needs an explicit UTC instant")
    return parsed


def utc(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def iso_day(value):
    if not isinstance(value, str):
        raise ValueError("Missing EDGAR date")
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value:
        raise ValueError("Invalid EDGAR date")
    return parsed


def urls(fund, accession):
    if not ACCESSION.fullmatch(accession):
        raise ValueError("Invalid accession")
    base = f"https://www.sec.gov/Archives/edgar/data/{fund.cik}/{accession.replace('-', '')}/"
    return base + accession + "-index.htm", base + "primary_doc.xml"


def filing_header(raw, fund, accession):
    index_url, xml_url = urls(fund, accession)
    html = raw.decode("utf-8")
    text = " ".join(unescape(re.sub(r"<[^>]+>", " ", html)).split())
    title = re.search(r"(?:SEC )?Accession No\.\s+([0-9-]+)", text)
    clock = re.search(r"Filing Date (\d{4}-\d{2}-\d{2}) Accepted (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) Documents \d+ Period of Report (\d{4}-\d{2}-\d{2})\b", text)
    forms = re.findall(r"Form (NPORT-P(?:/A)?)\s*-\s*Monthly Portfolio", text)
    link = re.escape(f"/Archives/edgar/data/{fund.cik}/{accession.replace('-', '')}/primary_doc.xml")
    if not title or title[1] != accession or not clock or len(forms) != 1 or not re.search(r'href=["\']' + link + r'["\']', html, re.I):
        raise ValueError("SEC index identity, native document, form or public filing clocks do not agree")
    filed = iso_day(clock[1])
    accepted = datetime.strptime(clock[2], "%Y-%m-%d %H:%M:%S").replace(tzinfo=NEW_YORK)
    period = iso_day(clock[3])
    if period >= accepted.date() or not accepted.date() <= filed <= accepted.date() + timedelta(days=7):
        raise ValueError("Invalid filing chronology")
    return {"accession": accession, "form": forms[0], "filed": filed.isoformat(), "acceptedAt": utc(accepted),
            "periodEnd": period.isoformat(), "indexUrl": index_url, "originalUrl": xml_url}


def one(parent, path):
    found = parent.findall("/".join(NS + part for part in path.split("/")))
    if len(found) != 1:
        raise ValueError("Missing or ambiguous N-PORT " + path)
    return found[0]


def value(parent, path):
    return (one(parent, path).text or "").strip()


def parse_flow(xml, raw_index, symbol, accession, acquired_at):
    fund = FUNDS[symbol]
    head = filing_header(raw_index, fund, accession)
    seen = timestamp(acquired_at)
    actual_filed = iso_day(head["filed"])
    if timestamp(head["acceptedAt"]) > seen or actual_filed > seen.astimezone(NEW_YORK).date():
        raise ValueError("Filing had not been publicly verified at the capture time")
    if b"<!DOCTYPE" in xml.upper() or b"<!ENTITY" in xml.upper():
        raise ValueError("Unexpected XML document declaration")
    doc = ET.fromstring(xml)
    if doc.tag != NS + "edgarSubmission":
        raise ValueError("Unexpected SEC XML schema")
    hdr, info = one(doc, "headerData"), one(doc, "formData/genInfo")
    if (value(hdr, "submissionType") != head["form"] or value(hdr, "isConfidential") != "false"
            or value(hdr, "filerInfo/filer/issuerCredentials/cik") != f"{fund.cik:010}"
            or value(info, "regCik") != f"{fund.cik:010}" or value(info, "regFileNumber") != fund.file_number
            or value(info, "seriesLei") != fund.lei or value(info, "repPdDate") != head["periodEnd"]):
        raise ValueError("Public form, registrant, portfolio identity or fiscal period mismatch")
    series_nodes = hdr.findall(f".//{NS}seriesClassInfo")
    if fund.series:
        if (len(series_nodes) != 1 or value(series_nodes[0], "seriesId") != fund.series
                or value(series_nodes[0], "classId") != fund.share_class or value(info, "seriesId") != fund.series):
            raise ValueError("Expected one matching ETF series and class")
    elif (series_nodes or info.findall(NS + "seriesId") or value(info, "regLei") != fund.lei
          or value(info, "seriesName") != "N/A"):
        raise ValueError("Expected a single-portfolio unit trust without a separate series")
    period = iso_day(head["periodEnd"])
    fiscal = iso_day(value(info, "repPdEnd"))
    month_gap = (fiscal.year - period.year) * 12 + fiscal.month - period.month
    month_end = period.replace(day=calendar.monthrange(period.year, period.month)[1])
    if (period != month_end or fiscal.day != calendar.monthrange(fiscal.year, fiscal.month)[1]
            or fiscal < period or month_gap not in {0, 3, 6, 9}):
        raise ValueError("Only complete month-end fiscal quarters are supported")
    for note in doc.iter(NS + "explntrNote"):
        label = re.sub(r"[^a-z0-9]", "", note.get("noteItem", "").lower())
        description = note.get("note", "") + " " + (note.text or "")
        if label.startswith("b6") or re.search(r"\b(?:item\s+)?B[.\s-]*6\b|\bflow (?:data|information|amounts)\b", description, re.I):
            raise ValueError("Issuer flow reporting note requires review")
    fund_info = one(doc, "formData/fundInfo")
    total = {"sales": Decimal(0), "redemption": Decimal(0), "reinvestment": Decimal(0)}
    with localcontext() as precision:
        precision.prec = 40
        for order in (1, 2, 3):
            bucket = one(fund_info, f"mon{order}Flow")
            if set(bucket.attrib) != set(total) or len(bucket):
                raise ValueError("Missing or unexpected B.6 flow fields")
            for name, raw in bucket.attrib.items():
                if not NUMBER.fullmatch(raw):
                    raise ValueError("Invalid or unavailable B.6 USD amount")
                total[name] += Decimal(raw)
        net = total["sales"] - total["redemption"]
    earlier = (period.year * 12 + period.month - 1) - 2
    return {"method": METHOD, "symbol": symbol, "registrantCik": fund.cik, "seriesId": fund.series,
            "classId": fund.share_class, "portfolioLei": fund.lei, **head,
            "periodStart": date(earlier // 12, earlier % 12 + 1, 1).isoformat(), "currency": "USD",
            "shareSalesUsd": format(total["sales"], "f"), "redemptionsUsd": format(total["redemption"], "f"),
            "distributionReinvestmentsUsd": format(total["reinvestment"], "f"), "netShareSalesUsd": format(net, "f"),
            "verifiedAt": acquired_at, "xmlSha256": hashlib.sha256(xml).hexdigest(),
            "indexSha256": hashlib.sha256(raw_index).hexdigest()}


def protected(path, maximum):
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077 or not 0 < info.st_size <= maximum:
        raise ValueError("Untrusted private SEC source")
    return path.read_bytes()


def private_dir(path):
    if path.is_symlink():
        raise ValueError("Unexpected symlink in private SEC archive")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if not path.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Expected an owner-only SEC source directory")


def read_receipt(path, symbol):
    info = path.lstat()
    if path.is_symlink() or not path.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("Untrusted accession directory")
    saved = json.loads(protected(path / "receipt.json", 10000))
    if not isinstance(saved, dict):
        raise ValueError("Invalid SEC accession receipt")
    if timestamp(saved.get("verifiedAt")) > datetime.now(timezone.utc):
        raise ValueError("Future local SEC verification clock")
    checked = parse_flow(protected(path / "filing.xml", 8_000_000), protected(path / "index.html", 175000),
                         symbol, path.name, saved["verifiedAt"])
    if checked != saved:
        raise ValueError("Retained N-PORT source changed")
    return checked


def verify_reference(row, reference):
    clocks = iso_day(row["periodEnd"]), timestamp(row["acceptedAt"]), iso_day(row["filed"])
    if reference is not None and clocks != reference:
        raise ValueError("Original index and SEC submissions report clocks disagree")
    return row


def collect_filing(root, symbol, accession, get, clock, reference=None):
    index_url, xml_url = urls(FUNDS[symbol], accession)
    directory = root / symbol
    private_dir(directory)
    final = directory / accession
    if final.exists():
        return verify_reference(read_receipt(final, symbol), reference)
    index = get(index_url, 175000)
    verify_reference(filing_header(index, FUNDS[symbol], accession), reference)
    xml = get(xml_url, 8_000_000)
    row = parse_flow(xml, index, symbol, accession, utc(clock()))
    with TemporaryDirectory(prefix=".pending-", dir=directory) as temp:
        stage = Path(temp) / accession
        stage.mkdir(mode=0o700)
        contents = {"index.html": index, "filing.xml": xml, "receipt.json": json.dumps(row, sort_keys=True).encode()}
        for name, data in contents.items():
            with (stage / name).open("xb") as out:
                os.fchmod(out.fileno(), 0o600)
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
        read_receipt(stage, symbol)
        stage.rename(final)
    return row


def select_latest(submissions, fund, listed=None):
    if str(submissions.get("cik", "")).zfill(10) != f"{fund.cik:010}":
        raise ValueError("Unexpected SEC submission issuer")
    table = submissions["filings"]["recent"]
    columns = [table[col] for col in ("form", "accessionNumber", "reportDate", "acceptanceDateTime", "filingDate")]
    if not columns[0] or len({len(c) for c in columns}) != 1:
        raise ValueError("Unusable SEC accession inventory")
    candidates = {}
    for form, accession, period, accepted, filed in zip(*columns):
        if form not in FORM or (listed is not None and accession not in listed):
            continue
        if not ACCESSION.fullmatch(accession) or not period or accession in candidates:
            raise ValueError("Unusable SEC public filing identity")
        candidates[accession] = (iso_day(period), timestamp(accepted), iso_day(filed))
    if not candidates:
        raise ValueError("No matching recent public N-PORT")
    if listed is not None:
        newest_period = max(item[0] for item in candidates.values())
        for accession, filed in listed.items():
            # An unknown filing made before the latest period ended could only cover an older period.
            if accession not in candidates and iso_day(filed) >= newest_period:
                raise ValueError("New series accession is missing from the SEC submissions inventory")
            if accession in candidates and iso_day(filed) != candidates[accession][2]:
                raise ValueError("SEC series listing and submissions filing dates disagree")
    latest = max(candidates, key=lambda accession: candidates[accession][:2])
    if sum(clocks[:2] == candidates[latest][:2] for clocks in candidates.values()) != 1:
        raise ValueError("Ambiguous latest SEC amendment")
    return latest, candidates[latest]


def listed_series(html, fund):
    text = html.decode("utf-8")
    entries = {}
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", text, re.S | re.I):
        cells = re.findall(r"<td\b[^>]*>(.*?)</td>", row, re.S | re.I)
        if len(cells) < 4 or unescape(re.sub("<[^>]+>", " ", cells[0])).strip() not in FORM:
            continue
        observed = re.findall(r'href=["\']/Archives/edgar/data/(\d+)/(\d{18})/([0-9-]+)-index\.htm[l]?["\']', cells[1], re.I)
        day = unescape(re.sub("<[^>]+>", " ", cells[3])).strip()
        if len(observed) != 1:
            raise ValueError("Unrecognized SEC series accession listing")
        cik, compact, acc = observed[0]
        if int(cik) != fund.cik or not ACCESSION.fullmatch(acc) or compact != acc.replace("-", "") or acc in entries:
            raise ValueError("Incorrect issuer or duplicate in SEC series listing")
        entries[acc] = iso_day(day).isoformat()
    if not entries or len(entries) > 40:
        raise ValueError("Missing or unexpected SEC fund-specific listing")
    return entries


class SecReader:
    def __init__(self):
        self.ready = 0.0

    def get(self, url, limit):
        for attempt in range(2):
            time.sleep(max(0, self.ready - time.monotonic()))
            self.ready = time.monotonic() + 0.30
            try:
                with urlopen(Request(url, headers={"User-Agent": AGENT}), timeout=15) as response:
                    if response.status != 200 or response.url != url:
                        raise ValueError("Unexpected SEC response or redirect")
                    data = response.read(limit + 1)
                if not 0 < len(data) <= limit:
                    raise ValueError("Invalid SEC response size")
                return data
            except HTTPError as error:
                delay = error.headers.get("Retry-After", "2")
                if attempt or error.code not in (429, 503) or not delay.isdecimal() or int(delay) > 10:
                    raise
                self.ready = max(self.ready, time.monotonic() + int(delay))
        raise ValueError("SEC request did not return a public original")


def latest_from_sec(reader, symbol, inventories):
    fund = FUNDS[symbol]
    if fund.cik not in inventories:
        uri = f"https://data.sec.gov/submissions/CIK{fund.cik:010}.json"
        inventories[fund.cik] = json.loads(reader.get(uri, 6_000_000))
    entries = None
    if symbol in ("IWM", "TLT"):
        query = urlencode({"action": "getcompany", "CIK": fund.series, "type": "NPORT-P",
                           "owner": "exclude", "count": "40"})
        entries = listed_series(reader.get("https://www.sec.gov/cgi-bin/browse-edgar?" + query, 300000), fund)
    return select_latest(inventories[fund.cik], fund, entries)


def last_cached(root, symbol):
    directory = root / symbol
    if not directory.is_dir():
        return None
    for path in (root, directory):
        info = path.lstat()
        if path.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Untrusted private SEC directory")
    rows = [read_receipt(path, symbol) for path in directory.iterdir() if ACCESSION.fullmatch(path.name)]
    if not rows:
        return None
    rows.sort(key=lambda row: (row["periodEnd"], row["acceptedAt"]), reverse=True)
    if len(rows) > 1 and all(rows[0][key] == rows[1][key] for key in ("periodEnd", "acceptedAt")):
        raise ValueError("Conflicting accession for latest retained amendment")
    return rows[0]


def period_comparison(rows):
    periods = {}
    for symbol, row in sorted(rows.items()):
        key = (row["periodStart"], row["periodEnd"])
        periods.setdefault(key, []).append(symbol)
    groups = []
    for (start, end), symbols in sorted(periods.items()):
        groups.append({"periodStart": start, "periodEnd": end, "symbols": symbols,
                       "lastAcceptedAt": max(rows[symbol]["acceptedAt"] for symbol in symbols),
                       "lastVerifiedAt": max(rows[symbol]["verifiedAt"] for symbol in symbols)})
    return {"identicalReportedQuarters": groups, "allFiveSamePeriod": set(rows) == set(FUNDS) and len(groups) == 1}


def collector_lock(root):
    handle = os.open(root / ".collect.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        st = os.fstat(handle)
        if not S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
            raise ValueError("Untrusted SEC collector lock")
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except BaseException:
        os.close(handle)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--collect-samples", action="store_true", help="verify five fixed example accessions")
    modes.add_argument("--collect-latest", action="store_true", help="check newest reported quarters and amendments")
    parser.add_argument("--private-dir", type=Path, default=ROOT, help="owner-only private receipt directory")
    args = parser.parse_args()
    root = args.private_dir.absolute()
    collect = args.collect_samples or args.collect_latest
    reader = SecReader()
    inventories, rows, held = {}, {}, {}
    lock = old_umask = None
    try:
        if collect:
            old_umask = os.umask(0o077)
            private_dir(root)
            lock = collector_lock(root)
        for symbol, fund in FUNDS.items():
            try:
                if collect:
                    accession, reference = fund.sample, None
                    if args.collect_latest:
                        accession, reference = latest_from_sec(reader, symbol, inventories)
                    rows[symbol] = collect_filing(root, symbol, accession, reader.get,
                                                  lambda: datetime.now(timezone.utc), reference)
                else:
                    rows[symbol] = last_cached(root, symbol)
                    if rows[symbol] is None:
                        del rows[symbol]
                        raise ValueError("No verified public N-PORT in this cache")
            except (OSError, ValueError, KeyError, ET.ParseError) as error:
                held[symbol] = str(error)
    except (OSError, ValueError) as error:
        held["collection"] = str(error)
    finally:
        if lock is not None:
            os.close(lock)
        if old_umask is not None:
            os.umask(old_umask)
    report = {"status": "incomplete" if held else "verified", "observation": "issuer-reported fiscal-quarter net share sales",
              "selection": "latest SEC inventory" if args.collect_latest else "pinned samples" if args.collect_samples else "cached originals",
              "rows": rows, "withheld": held, **period_comparison(rows)}
    print(json.dumps(report, sort_keys=True, indent=2))
    return int(bool(held))


if __name__ == "__main__":
    sys.exit(main())
