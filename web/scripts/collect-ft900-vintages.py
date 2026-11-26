"""Capture dated Census/BEA FT900 releases for the prelaunch DIA research cohort."""
import calendar
import concurrent.futures
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / ".consensus/private-ft900"
ARCHIVE = "https://www.census.gov/foreign-trade/Press-Release/ft900_index.html"
ORIGINAL = "https://www.census.gov/foreign-trade/Press-Release/ft900/ft900_"
AGENT = "The Daily Consensus source research (https://thedailyconsensus.com/)"
MONTH = r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"
UTC = dt.timezone.utc


def fetch(url, bound):
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENT})
            with urllib.request.urlopen(req, timeout=22) as res:
                if res.url != url:
                    raise ValueError("Unexpected release redirect: " + res.url)
                raw = res.read(bound + 1)
            if not 0 < len(raw) <= bound:
                raise ValueError("Invalid release length")
            return raw
        except urllib.error.HTTPError as err:
            if err.code not in (429, 502, 503, 504) or attempt == 2:
                raise
            time.sleep(min(15, int(err.headers.get("Retry-After", "2"))))


def save(path, data):
    # Link the finished capture exactly once. A failed run never installs partial data.
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as source:
        tmp = Path(source.name)
        try:
            source.write(data)
            source.flush()
            os.fsync(source.fileno())
            try:
                os.link(tmp, path)
            except FileExistsError:
                if path.read_bytes() != data:
                    raise ValueError("Conflicting original " + path.name)
        finally:
            tmp.unlink(missing_ok=True)


def collect(period):
    directory = ROOT / "sources"
    path = directory / (period + ".json")
    if path.exists():
        # Preserve a dated URL that was missing and pin its known permanent replacement.
        saved = json.loads(path.read_text())
        supplement = directory / (period + ".bea.json")
        if not saved["beaSHA256"] and not supplement.exists():
            url = saved["beaURL"]
            if period == "2018-11":
                url = url.removesuffix("-0") + "-0"
            elif period.endswith("-12") and "-and-annual-" not in url:
                url = url.replace("-december-", "-december-and-annual-")
            if url != saved["beaURL"]:
                raw = fetch(url, 450_000)
                save(directory / (period + ".alternate.html.gz"), gzip.compress(raw, mtime=0))
                save(supplement, json.dumps({"url": url, "sha256": hashlib.sha256(raw).hexdigest()}).encode())
        return
    year, month = map(int, period.split("-"))
    name = calendar.month_name[month].lower()
    pdf_url = ORIGINAL + f"{year % 100:02}{month:02}.pdf"
    raw = fetch(pdf_url, 7_000_000)
    if not raw.startswith(b"%PDF-"):
        raise ValueError("Invalid FT900 PDF " + period)
    layout = subprocess.run(["pdftotext", "-layout", "-", "-"], input=raw,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=22)
    pages = layout.stdout.decode().split("\f")
    header = " ".join(pages[0].split())
    dated = re.search(r"(?:FOR|UNTIL) (?:IMMEDIATE )?RELEASE (?:AT )?8:30 A\.?M\.?,?\s*"
                      r"(?:E[DS]T|ET)[, ]+(?:[A-Z]+,?\s+)?(" + MONTH + r") (\d{1,2}),\s*(20\d{2})",
                      header, re.I)
    if not dated:
        raise ValueError("Missing original embargo date " + period)
    issue_year = int(dated[3])
    bea_month = "december-and-annual" if month == 12 and year >= 2022 else name
    suffix = "-0" if period == "2018-11" else ""
    bea_url = f"https://www.bea.gov/news/{issue_year}/us-international-trade-goods-and-services-{bea_month}-{year}{suffix}"
    try:
        bea = fetch(bea_url, 450_000)
    except urllib.error.HTTPError as err:
        if err.code not in (404, 410):
            raise
        bea = None
    except ValueError as err:
        if not str(err).startswith("Unexpected release redirect: "):
            raise
        bea = None
    table = [page for page in pages if re.search(r"Exhibit 1\.\s+U\.S\. International Trade in Goods and Services", page)
             and re.search(r"In millions of dollars", page, re.I)
             and re.search(r"Balance\s+Exports\s+Imports", page)]
    data = {"period": period, "pdfURL": pdf_url, "pdfSHA256": hashlib.sha256(raw).hexdigest(),
            "firstPage": pages[0], "exhibitOne": table[0] if len(table) == 1 else None,
            "capturedAt": dt.datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "beaURL": bea_url, "beaSHA256": hashlib.sha256(bea).hexdigest() if bea else None}
    if bea:
        save(directory / (period + ".html.gz"), gzip.compress(bea, mtime=0))
    save(path, json.dumps(data, ensure_ascii=False).encode())


def main():
    os.umask(0o077)
    directory = ROOT / "sources"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    policy = json.loads(Path(__file__).with_name("ft900-study-policy.json").read_text())
    digest = hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    seal = ROOT / "policy.json"
    if not seal.exists():
        save(seal, json.dumps({"createdAt": dt.datetime.now(UTC).isoformat(), "sha256": digest, "spec": policy}).encode())
    frozen = json.loads(seal.read_text())
    if frozen["spec"] != policy or frozen["sha256"] != digest:
        raise SystemExit("Saved FT900 study differs from its frozen hypothesis")
    index_path = ROOT / "archive-index.html.gz"
    if not index_path.exists():
        save(index_path, gzip.compress(fetch(ARCHIVE, 3_000_000), mtime=0))
    index = gzip.decompress(index_path.read_bytes()).decode()
    dates = [f"{year}-{month:02}" for year in range(2015, 2027) for month in range(1, 13)
             if "2015-11" <= f"{year}-{month:02}" <= "2026-08"]
    failures = {}
    for period in dates:
        if ORIGINAL + period[2:].replace("-", "") + ".pdf" not in index:
            failures[period] = "Absent from government archive"
    # Two independent readers and an immutable cache keep replays small.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(collect, period): period for period in dates if period not in failures}
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result()
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as err:
                failures[futures[future]] = str(err)
    print(json.dumps({"expected": len(dates), "saved": len(dates) - len(failures), "unavailable": failures}))


if __name__ == "__main__":
    main()
