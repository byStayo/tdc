"""Reduce a bounded SEC Form 3/4/5 archive to original Form 4 study rows."""

import csv
import hashlib
import io
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.request import Request, urlopen
from zipfile import ZipFile


ARCHIVE_BASE = "https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/"
ISSUERS = {320193: "AAPL", 789019: "MSFT", 1045810: "NVDA", 2488: "AMD", 804328: "QCOM"}
MAX_DOWNLOAD_BYTES = 20_000_000
MAX_TABLE_BYTES = 100_000_000
SUBMISSION_FIELDS = {"ACCESSION_NUMBER", "ISSUERCIK", "DOCUMENT_TYPE", "FILING_DATE", "AFF10B5ONE"}
TRADE_FIELDS = {
    "ACCESSION_NUMBER", "NONDERIV_TRANS_SK", "SECURITY_TITLE", "TRANS_DATE", "TRANS_FORM_TYPE",
    "TRANS_CODE", "TRANS_ACQUIRED_DISP_CD", "EQUITY_SWAP_INVOLVED", "TRANS_SHARES",
    "TRANS_PRICEPERSHARE", "DIRECT_INDIRECT_OWNERSHIP",
}
FALSE = {"0", "false"}


def time_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def filed_day(text):
    return datetime.strptime(text, "%d-%b-%Y").date().isoformat()


def download(url, destination):
    request = Request(url, headers={"User-Agent": "The Daily Consensus public research https://thedailyconsensus.com"})
    with urlopen(request, timeout=25) as response, destination.open("xb") as output:
        if response.status != 200 or response.geturl() != url:
            raise ValueError("SEC archive response did not match its official URL")
        size = 0
        while chunk := response.read(128 * 1024):
            size += len(chunk)
            if size > MAX_DOWNLOAD_BYTES:
                raise ValueError("SEC archive exceeds the compressed byte bound")
            output.write(chunk)


def tables(archive, name, required):
    info = archive.getinfo(name + ".tsv")
    if info.file_size > MAX_TABLE_BYTES:
        raise ValueError("SEC table exceeds its expanded byte bound: " + name)
    with archive.open(info) as stream, io.TextIOWrapper(stream, encoding="utf-8-sig", newline="") as text:
        rows = csv.DictReader(text, delimiter="\t")
        if not rows.fieldnames or not required.issubset(rows.fieldnames):
            raise ValueError("SEC data table lacks required columns: " + name)
        yield from rows


def original_filings(archive, breadth):
    filings = {}
    for row in tables(archive, "SUBMISSION", SUBMISSION_FIELDS):
        raw_cik = row["ISSUERCIK"] or ""
        cik = int(raw_cik) if raw_cik.isdecimal() and len(raw_cik) <= 10 else 0
        issuer = str(cik) if breadth and cik > 0 else ISSUERS.get(cik)
        if issuer is None or row["DOCUMENT_TYPE"] != "4":
            continue
        accession = row["ACCESSION_NUMBER"]
        if not re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession) or accession in filings:
            raise ValueError("Invalid or repeated original Form 4 accession")
        filings[accession] = (issuer, filed_day(row["FILING_DATE"]), (row["AFF10B5ONE"] or "").lower())
    return filings


def amount_cents(shares, price):
    try:
        n_shares, dollars = Decimal(shares), Decimal(price)
        if not n_shares.is_finite() or not dollars.is_finite() or n_shares <= 0 or dollars <= 0:
            return None
        cents = (n_shares * dollars * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP)
        return int(cents) if 0 < cents <= 2**53 - 1 else None
    except (InvalidOperation, TypeError):
        return None


def disposition(row, plan):
    if plan not in FALSE:
        return "plan_checked_or_missing"
    title = (row["SECURITY_TITLE"] or "").strip().lower()
    if title not in {"common", "common stock", "common shares"} or row["DIRECT_INDIRECT_OWNERSHIP"] != "D":
        return "other_security_or_indirect"
    if row["TRANS_FORM_TYPE"] != "4" or (row["EQUITY_SWAP_INVOLVED"] or "").lower() not in FALSE:
        return "swap_or_other_form"
    if row["TRANS_ACQUIRED_DISP_CD"] != {"P": "A", "S": "D"}[row["TRANS_CODE"]]:
        return "side_mismatch"
    return None


def reduce_archive(path, breadth):
    digest = hashlib.sha256()
    with path.open("rb") as raw:
        while chunk := raw.read(128 * 1024):
            digest.update(chunk)
    accepted, rejected, seen = [], Counter(), set()
    totals, accessions = Counter(), set()
    selected, purchases = 0, 0
    with ZipFile(path) as archive:
        filings = original_filings(archive, breadth)
        if not filings:
            raise ValueError("No original Form 4 filings for the announced issuer panel")
        for row in tables(archive, "NONDERIV_TRANS", TRADE_FIELDS):
            accession, code = row["ACCESSION_NUMBER"], row["TRANS_CODE"]
            if accession not in filings or code not in {"P", "S"}:
                continue
            issuer, filing_date, plan = filings[accession]
            reason = disposition(row, plan)
            if reason:
                rejected[reason] += 1
                continue
            transaction = row["NONDERIV_TRANS_SK"]
            if not transaction or not transaction.isdecimal() or (accession, transaction) in seen:
                raise ValueError("Invalid or repeated original transaction key")
            seen.add((accession, transaction))
            try:
                trans_date = filed_day(row["TRANS_DATE"])
            except (ValueError, TypeError):
                rejected["missing_value_or_future_trade"] += 1
                continue
            cents = amount_cents(row["TRANS_SHARES"], row["TRANS_PRICEPERSHARE"])
            if trans_date > filing_date or cents is None:
                rejected["missing_value_or_future_trade"] += 1
                continue
            signed = cents if code == "P" else -cents
            if breadth:
                totals[(issuer, filing_date)] += signed
                accessions.add(accession)
                selected += 1
                purchases += code == "P"
            else:
                accepted.append({
                    "accession": accession, "transaction": transaction, "ticker": issuer, "filingDate": filing_date,
                    "transactionDate": trans_date, "signedCents": signed,
                })
    receipt = {"sha256": digest.hexdigest(), "originalForms": len(filings), "excluded": dict(rejected)}
    if breadth:
        return {**receipt, "accessions": sorted(accessions), "selectedTransactions": selected,
                "selectedPurchaseRows": purchases,
                "issuerDays": [
                    {"cik": cik, "filingDate": day, "netCents": cents}
                    for (cik, day), cents in sorted(totals.items())
                ]}
    accepted.sort(key=lambda row: (row["filingDate"], row["accession"], row["transaction"]))
    return {**receipt, "events": accepted}


def main():
    if len(sys.argv) not in {2, 3} or not re.fullmatch(r"202[45]q[1-4]", sys.argv[1]) or (
        len(sys.argv) == 3 and sys.argv[2] != "--breadth"
    ):
        raise SystemExit("Specify one quarter in the frozen 2024–2025 study period.")
    breadth = len(sys.argv) == 3
    quarter = sys.argv[1]
    name = quarter + "_form345.zip"
    source_url = ARCHIVE_BASE + name
    archive_dir = Path(__file__).resolve().parents[1] / ".consensus/private-insider-research/archives"
    checked_archive = archive_dir / name
    csv.field_size_limit(2_000_000)
    if checked_archive.is_file():
        if checked_archive.is_symlink() or checked_archive.stat().st_size > MAX_DOWNLOAD_BYTES:
            raise ValueError("Invalid saved SEC archive")
        result = reduce_archive(checked_archive, breadth)
    else:
        with TemporaryDirectory(prefix="tdc-sec-form4-") as folder:
            path = Path(folder) / name
            download(source_url, path)
            result = reduce_archive(path, breadth)
    print(json.dumps({"quarter": quarter, "source": source_url, "parsedAt": time_now(), **result}, separators=(",", ":")))


if __name__ == "__main__":
    main()
