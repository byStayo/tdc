"""Collect or replay the publicly offered MarketParquet evaluation tables and their CSV links."""
import argparse
import csv
import fcntl
from datetime import date, datetime, timezone
from decimal import Decimal
import gzip
import hashlib
from html.parser import HTMLParser
from io import BytesIO, StringIO
import json
import os
import tempfile
from pathlib import Path
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin
from urllib.request import Request, urlopen

BASE = "https://marketparquet.com"
FIELDS = ("date", "symbol", "asset_type", "open", "high", "low", "close", "volume")
FUNDS = ("DIA", "IWM", "QQQ", "SPY", "TLT")
# Single, bounded evaluation protocol, deliberately separate from the daily publisher.
EVALUATION_DATES = frozenset({
    "2025-11-28", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28",
    "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03",
})
MAX_BYTES = 1_500_000


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def exclusive(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".capture-", delete=False) as pending:
        try:
            pending.write(data)
            pending.flush()
            os.fsync(pending.fileno())
            try:
                os.link(pending.name, path)
            except FileExistsError:
                if path.is_symlink() or path.read_bytes() != data:
                    raise ValueError("Frozen source changed: " + path.name)
        finally:
            os.unlink(pending.name)


class NativeTable(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows, self.csv, self.preview_days = [], [], set()
        self.in_row = False
        self.in_cell = False
        self.row, self.value = [], ""
        self.link, self.caption = None, ""

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "a":
            self.link, self.caption = attrs.get("href"), ""
        if tag == "button" and attrs.get("data-href", "").startswith("/preview/etf_daily/"):
            self.preview_days.add(attrs["data-href"])
        if tag == "tr":
            self.in_row, self.row = True, []
        if self.in_row and tag in ("th", "td"):
            self.in_cell, self.value = True, ""

    def handle_data(self, value):
        if self.link:
            self.caption += value
        if self.in_cell:
            self.value += value

    def handle_endtag(self, tag):
        if tag == "a" and self.link:
            if self.caption.strip().lower() == "these rows as csv":
                self.csv.append(self.link)
            self.link = None
        if tag in ("th", "td") and self.in_cell:
            self.row.append(self.value.strip())
            self.in_cell = False
        if tag == "tr" and self.in_row:
            self.rows.append(self.row)
            self.in_row = False


def original(store, name, url, kind, collect):
    data_file, meta_file = store / f"{name}.{kind}.gz", store / f"{name}.{kind}.source.json"
    if not meta_file.exists():
        if not collect:
            raise ValueError("Missing evaluation original " + name)
        q = Request(url, headers={"User-Agent": "The Daily Consensus private market-data evaluation"})
        with urlopen(q, timeout=15) as result:
            if result.status != 200 or result.geturl() != url:
                raise ValueError("Unexpected response from native evaluation page")
            data = result.read(MAX_BYTES + 1)
            if not data or len(data) > MAX_BYTES:
                raise ValueError("Bounded evaluation original expected")
            meta = {"source": url, "status": result.status, "receivedAt": datetime.now(timezone.utc).isoformat(),
                    "date": result.headers.get("Date"), "contentType": result.headers.get("Content-Type"),
                    "bytes": len(data), "sha256": sha(data)}
        exclusive(data_file, gzip.compress(data, mtime=0))
        exclusive(meta_file, (json.dumps(meta, sort_keys=True) + "\n").encode())
    for path in (meta_file, data_file):
        if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077 or path.stat().st_size > MAX_BYTES:
            raise ValueError("Expected a bounded owner-only native source")
    meta = json.loads(meta_file.read_bytes())
    with gzip.GzipFile(fileobj=BytesIO(data_file.read_bytes())) as stream:
        data = stream.read(MAX_BYTES + 1)
    received = datetime.fromisoformat(meta["receivedAt"])
    server = parsedate_to_datetime(meta["date"]) if meta.get("date") else None
    expected_mime = "text/csv" if kind == "csv" else "text/html"
    if (meta["source"] != url or meta["status"] != 200 or sha(data) != meta["sha256"] or
            not 0 < len(data) == meta["bytes"] <= MAX_BYTES or
            (meta.get("contentType") is not None and meta["contentType"].split(";")[0].lower() != expected_mime) or
            not received.tzinfo or received > datetime.now(timezone.utc) or
            (server is not None and (not server.tzinfo or (server - received).total_seconds() > 30))):
        raise ValueError("Frozen native MarketParquet evaluation source differs")
    return data, meta


def table_for(store, session, collect):
    day = date.fromisoformat(session)
    if day.isoformat() != session or day >= datetime.now(timezone.utc).date():
        raise ValueError("A completed historical date is required")
    canonical = BASE + "/browse/etf_daily"
    year_url = canonical + "?year=" + str(day.year)
    stored_catalog = store / f"catalog-{day.year}.html.source.json"
    catalogue_url = json.loads(stored_catalog.read_bytes())["source"] if stored_catalog.exists() else (
        canonical if day.year == datetime.now(timezone.utc).year else year_url)
    if catalogue_url not in (canonical, year_url):
        raise ValueError("Unexpected catalogue source")
    browser, catalog_meta = original(store, f"catalog-{day.year}", catalogue_url, "html", collect)
    catalog = NativeTable()
    catalog.feed(browser.decode())
    path = "/preview/etf_daily/" + session
    if path not in catalog.preview_days:
        raise ValueError("Official year catalogue has no preview action for " + session)
    html_url = BASE + path
    html, html_meta = original(store, session, html_url, "html", collect)
    table = NativeTable()
    table.feed(html.decode())
    if not table.rows or len(table.csv) != 1 or urljoin(html_url, table.csv[0]) != html_url + "?format=csv":
        raise ValueError("Native evaluation page did not offer the date-specific CSV")
    body, csv_meta = original(store, session, urljoin(html_url, table.csv[0]), "csv", collect)
    for meta in (html_meta, csv_meta):
        if datetime.fromisoformat(meta["receivedAt"]).date() <= day:
            raise ValueError("Evaluation original lacks a later completed-session receipt")
    parsed = list(csv.reader(StringIO(body.decode("utf-8-sig"))))
    if (not parsed or tuple(parsed[0]) != FIELDS or table.rows[0] != parsed[0] or
            not 2 <= len(parsed) == len(table.rows) <= 51):
        raise ValueError("Unexpected native preview schema")
    selected = {}
    for html_cells, cells in zip(table.rows[1:], parsed[1:]):
        if len(cells) != len(FIELDS) or len(cells) != len(html_cells) or cells[:3] != html_cells[:3]:
            raise ValueError("Native preview HTML/CSV identity differs")
        if any(Decimal(a) != Decimal(b) for a, b in zip(cells[3:], html_cells[3:])):
            raise ValueError("Native preview HTML/CSV precision differs")
        row = dict(zip(FIELDS, cells))
        symbol = row['symbol']
        if symbol not in FUNDS:
            continue
        o, high, low, close, volume = (Decimal(row[key]) for key in FIELDS[3:])
        if (symbol in selected or row['date'] != session or row['asset_type'] != 'ETF' or
                not all(x.is_finite() and x > 0 for x in (o, high, low, close, volume)) or
                not low <= min(o, close) <= max(o, close) <= high or volume != volume.to_integral_value()):
            raise ValueError("Invalid candidate ETF evaluation row")
        selected[symbol] = {k: row[k] for k in FIELDS[3:]}
    if sorted(selected) != list(FUNDS):
        raise ValueError("Native unfiltered preview omitted one of the five ETFs on " + session)
    return {"session": session, "scope": "private-evaluation-preview", "catalogueSha256": catalog_meta["sha256"],
            "htmlSha256": html_meta["sha256"], "csvSha256": csv_meta["sha256"], "rowsShown": len(parsed) - 1,
            "source": csv_meta["source"], "funds": selected}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("sessions", nargs="+")
    parser.add_argument("--collect", action="store_true")
    args = parser.parse_args()
    if len(set(args.sessions)) != len(args.sessions) or not 1 <= len(args.sessions) <= 24:
        raise ValueError("Choose up to 24 distinct evaluation dates")
    if args.collect:
        if not set(args.sessions).issubset(EVALUATION_DATES):
            raise ValueError("Online collection is limited to the nine source-qualification samples")
        args.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not args.directory.is_dir() or args.directory.is_symlink() or args.directory.stat().st_mode & 0o077:
        raise ValueError("Owner-only evidence directory required")
    # Lock the owner directory itself. The offline mode does not create any files.
    lock = os.open(args.directory, os.O_RDONLY)
    fcntl.flock(lock, fcntl.LOCK_EX if args.collect else fcntl.LOCK_SH)
    for day in sorted(args.sessions):
        row = table_for(args.directory, day, args.collect)
        output = (json.dumps(row, separators=(",", ":"), sort_keys=True) + "\n").encode()
        slot = args.directory / f"{day}.private.json"
        if args.collect:
            exclusive(slot, output)
        if not slot.is_file() or slot.read_bytes() != output:
            raise ValueError("Frozen extracted evaluation row differs")
        print(json.dumps({"date": day, "funds": len(row["funds"]), "sampleRows": row["rowsShown"], "seal": sha(output)}))
