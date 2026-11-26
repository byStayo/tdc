"""Capture original SEC Form D quarters and reduce selected notices by filing date."""

from collections import Counter
import csv
from datetime import date, datetime, timezone
from hashlib import sha256
from html.parser import HTMLParser
from io import BytesIO, TextIOWrapper
import json
from os import fsync
from pathlib import Path
import re
from stat import S_IMODE
import sys
from tempfile import TemporaryDirectory
from urllib.parse import urljoin
from urllib.request import Request, urlopen
from zipfile import ZipFile


INDEX = "https://www.sec.gov/data-research/sec-markets-data/form-d-data-sets"
ROOT = Path(__file__).resolve().parents[1] / ".consensus/private-form-d"
QUARTERS = ["2021q4", *(f"{year}q{quarter}" for year in range(2022, 2026) for quarter in range(1, 5)),
            "2026q1", "2026q2", "2026q3"]
FROM, THROUGH = date(2021, 10, 1), date(2026, 9, 29)
ARCHIVE = re.compile(r"https://www\.sec\.gov/files/(?:structureddata|datastandardsinnovation)/data/form-d-data-sets/([0-9]{4}q[1-4])_d\.zip")
ACCESSION = re.compile(r"[0-9]{10}-[0-9]{2}-[0-9]{6}")
SUBMISSION = {"ACCESSIONNUMBER", "FILING_DATE", "SUBMISSIONTYPE", "TESTORLIVE"}
OFFERING = {"ACCESSIONNUMBER", "INDUSTRYGROUPTYPE", "INVESTMENTFUNDTYPE", "ISAMENDMENT", "PREVIOUSACCESSIONNUMBER",
            "SALE_DATE", "YETTOOCCUR", "ISPOOLEDINVESTMENTFUNDTYPE", "TOTALAMOUNTSOLD"}
FUND_TYPES = {"Private Equity Fund", "Venture Capital Fund"}
MAX_ARCHIVE = 6_000_000


def get(url, limit):
    request = Request(url, headers={"User-Agent": "The Daily Consensus public research https://thedailyconsensus.com"})
    with urlopen(request, timeout=25) as response:
        if response.status != 200 or response.geturl() != url:
            raise ValueError("Unexpected SEC response for " + url)
        data = response.read(limit + 1)
    if not 0 < len(data) <= limit:
        raise ValueError("SEC source exceeds the verified byte bound")
    return data


class ArchiveLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.sources = {}

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        url = urljoin(INDEX, dict(attrs).get("href") or "")
        match = ARCHIVE.fullmatch(url)
        if match and match[1] in QUARTERS:
            if self.sources.setdefault(match[1], url) != url:
                raise ValueError("Conflicting SEC links for " + match[1])


def owner_bytes(path, limit):
    stat = path.lstat()
    if path.is_symlink() or not path.is_file() or S_IMODE(stat.st_mode) != 0o600 or not 0 < stat.st_size <= limit:
        raise ValueError("Expected a bounded owner-only SEC file " + path.name)
    return path.read_bytes()


def archive_for(quarter, sources):
    directory = ROOT / quarter
    if not directory.exists():
        if sources is None:
            raise ValueError("Missing saved Form D archive for " + quarter)
        url = sources[quarter]
        data = get(url, MAX_ARCHIVE)
        proof = {"url": url, "retrievedAt": datetime.now(timezone.utc).isoformat(),
                 "sha256": sha256(data).hexdigest(), "bytes": len(data)}
        return data, proof, False
    if directory.is_symlink():
        raise ValueError("Form D archive directory must be local")
    data = owner_bytes(directory / "original.zip", MAX_ARCHIVE)
    proof = json.loads(owner_bytes(directory / "source.json", 10_000))
    match = ARCHIVE.fullmatch(proof["url"])
    if (not match or match[1] != quarter or proof["bytes"] != len(data) or
            proof["sha256"] != sha256(data).hexdigest() or not datetime.fromisoformat(proof["retrievedAt"]).tzinfo):
        raise ValueError("Saved Form D bytes differ from the verified source: " + quarter)
    return data, proof, True


def store_archive(quarter, data, proof):
    with TemporaryDirectory(prefix=".form-d-", dir=ROOT) as staging:
        for filename, content in (("original.zip", data), ("source.json", json.dumps(proof).encode())):
            path = Path(staging) / filename
            path.touch(mode=0o600, exist_ok=False)
            with path.open("wb") as stream:
                stream.write(content)
                stream.flush()
                fsync(stream.fileno())
        Path(staging).rename(ROOT / quarter)


def table(archive, name, required):
    matches = [entry for entry in archive.infolist() if Path(entry.filename).name == name + ".tsv"]
    if len(matches) != 1 or matches[0].file_size > 30_000_000:
        raise ValueError("Form D table is missing, duplicated or oversized: " + name)
    with archive.open(matches[0]) as stream, TextIOWrapper(stream, encoding="utf-8-sig", newline="") as text:
        rows = csv.DictReader(text, delimiter="\t")
        if not rows.fieldnames or not required.issubset(rows.fieldnames):
            raise ValueError("Form D table headers drifted: " + name)
        yield from rows


def study_amount(row, filed):
    if (row["ISAMENDMENT"] != "false" or row["PREVIOUSACCESSIONNUMBER"] or
            row["INDUSTRYGROUPTYPE"] != "Pooled Investment Fund" or row["INVESTMENTFUNDTYPE"] not in FUND_TYPES or
            row["ISPOOLEDINVESTMENTFUNDTYPE"] != "true" or row["YETTOOCCUR"] not in {"", "false"}):
        return None
    try:
        first_sale = date.fromisoformat(row["SALE_DATE"])
    except (TypeError, ValueError):
        return None
    amount = row["TOTALAMOUNTSOLD"] or ""
    if first_sale > filed or not re.fullmatch(r"[0-9]{1,15}", amount) or int(amount) == 0:
        return None
    return int(amount)


def reduce_quarter(data, accessions):
    with ZipFile(BytesIO(data)) as archive:
        filings = {}
        for row in table(archive, "FORMDSUBMISSION", SUBMISSION):
            accession, kind = row["ACCESSIONNUMBER"], row["SUBMISSIONTYPE"]
            if not ACCESSION.fullmatch(accession) or accession in accessions or kind not in {"D", "D/A"}:
                raise ValueError("Invalid or duplicate SEC Form D accession")
            accessions.add(accession)
            filed = datetime.strptime(row["FILING_DATE"], "%d-%b-%Y").date()
            filings[accession] = (filed, kind, row["TESTORLIVE"])
        original, counts, dollars = Counter(), Counter(), Counter()
        remaining = set(filings)
        for row in table(archive, "OFFERING", OFFERING):
            accession = row["ACCESSIONNUMBER"]
            if accession not in remaining:
                raise ValueError("Missing or repeated Form D offering accession")
            remaining.remove(accession)
            filed, kind, live = filings[accession]
            if kind != "D" or live != "LIVE" or not FROM <= filed <= THROUGH:
                continue
            day = filed.isoformat()
            original[day] += 1
            amount = study_amount(row, filed)
            if amount is not None:
                counts[day] += 1
                dollars[day] += amount
        if not original or remaining:
            raise ValueError("Form D offering table does not cover its original submissions")
    return original, counts, dollars


def main():
    if sys.argv[1:] not in ([], ["--cached-only"]):
        raise SystemExit("Use --cached-only to reuse verified Form D quarters offline")
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    sources = None
    if not sys.argv[1:] and any(not (ROOT / quarter).exists() for quarter in QUARTERS):
        links = ArchiveLinks()
        links.feed(get(INDEX, 1_000_000).decode("utf-8"))
        if set(links.sources) != set(QUARTERS):
            raise ValueError("SEC index does not identify each quarter in the fixed study")
        sources = links.sources
    accessions, proofs = set(), []
    original, counts, dollars = Counter(), Counter(), Counter()
    for quarter in QUARTERS:
        data, proof, cached = archive_for(quarter, sources)
        all_filings, selected_filings, selected_dollars = reduce_quarter(data, accessions)
        if not cached:
            store_archive(quarter, data, proof)
        proofs.append({"quarter": quarter, **proof, "submissions": sum(all_filings.values()),
                       "selected": sum(selected_filings.values())})
        original.update(all_filings)
        counts.update(selected_filings)
        dollars.update(selected_dollars)
    print(json.dumps({"from": FROM.isoformat(), "through": THROUGH.isoformat(), "proofs": proofs,
                      "totalSubmissions": len(accessions), "originalFilings": sum(original.values()),
                      "selectedFilings": sum(counts.values()), "days": [
                          {"date": day, "original": original[day], "selected": counts[day], "dollars": dollars[day]}
                          for day in sorted(original)]}, separators=(",", ":")))


if __name__ == "__main__":
    main()
