"""Capture official sample ZIPs and issuer histories for the four-ETF review."""

import argparse
import csv
import datetime as dt
from email.utils import parsedate_to_datetime
from hashlib import sha256
from io import BytesIO, StringIO
import json
import math
import os
from pathlib import Path
from stat import S_IMODE
import sys
from tempfile import NamedTemporaryFile
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zipfile import BadZipFile, ZipFile

from issuer_corporate_actions import ISSUERS, SYMBOLS, issuer_cash


EQUITY_SAMPLES = ("SPY", "QQQ", "IWM", "DIA")
STORAGE = "https://frd001.s3.us-east-2.amazonaws.com/"
SAMPLE_SIZE, ISSUER_SIZE = 1_000_000, 4_000_000
HEADERS = ("timestamp", "open", "high", "low", "close", "volume")
ROOT = Path(__file__).resolve().parents[1]


def owner_read(path, maximum):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Missing private receipt {path.name}")
    stat = path.stat()
    if S_IMODE(stat.st_mode) != 0o600 or not 0 < stat.st_size <= maximum:
        raise ValueError(f"Invalid private receipt {path.name}")
    return path.read_bytes()


def write_private(path, data):
    with NamedTemporaryFile(dir=path.parent, prefix=".pending-", delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
            file.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def capture(folder, name, url, maximum, cached_only, session=None, expected_close=None):
    source, receipt = folder / f"{name}.bin", folder / f"{name}.json"
    existing = cached_only or receipt.exists()
    if existing:
        meta = json.loads(owner_read(receipt, 4000))
        raw = owner_read(source, maximum)
    else:
        request = Request(url, headers={"User-Agent": "DailyConsensusResearch/1.0 (+https://thedailyconsensus.com)"})
        try:
            with urlopen(request, timeout=14) as response:
                if session and response.geturl() != url:
                    raise ValueError(f"{name} sample redirected")
                raw = response.read(maximum + 1)
                modified = response.headers.get("Last-Modified")
        except HTTPError as error:
            raise ValueError(f"{name} returned HTTP {error.code}") from None
        if not 0 < len(raw) <= maximum:
            raise ValueError(f"{name} source size exceeds its bound")
        meta = {"url": url, "sha256": sha256(raw).hexdigest(), "lastModified": modified,
                "capturedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")}
    if meta.get("url") != url or sha256(raw).hexdigest() != meta.get("sha256"):
        raise ValueError(f"{name} raw bytes differ from the reviewed source receipt")
    observed = dt.datetime.fromisoformat(meta["capturedAt"])
    if observed.tzinfo is None:
        raise ValueError(f"{name} receipt timestamp lacks a timezone")
    rows = read_daily(name.removeprefix("sample-"), raw) if session else None
    if rows and rows[-1]["session"] != session:
        raise ValueError(f"{name} ends {rows[-1]['session']} and expected {session}")
    if expected_close and not expected_close <= parsedate_to_datetime(meta["lastModified"]) <= observed:
        raise ValueError(f"{name} was not finalized after the reviewed core close")
    if not existing:
        if source.exists() and owner_read(source, maximum) != raw:
            raise ValueError(f"{name} changed after an interrupted capture")
        if not source.exists():
            write_private(source, raw)
        write_private(receipt, json.dumps(meta).encode())
    return raw, {**meta, "capturedAt": utc(observed)}, rows


def utc(instant):
    return instant.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_ohlcv(symbol, row):
    o, h, lo, c, volume = (float(row[key]) for key in HEADERS[1:])
    if not all(math.isfinite(value) and value > 0 for value in (o, h, lo, c, volume)) or lo > min(o, c) or h < max(o, c):
        raise ValueError(f"Invalid {symbol} sample OHLCV")
    return o, c


def read_daily(symbol, raw):
    with ZipFile(BytesIO(raw)) as archive:
        members = archive.infolist()
        if len(members) > 12 or len({entry.filename for entry in members}) != len(members):
            raise ValueError(f"Unexpected {symbol} sample archive")
        docs = archive.getinfo("_readme_documentation.txt")
        barfile = archive.getinfo(f"{symbol}_1day_sample.csv")
        if docs.file_size > 25_000 or barfile.file_size > 20_000:
            raise ValueError(f"Oversized {symbol} sample members")
        readme = archive.read(docs).decode("utf-8-sig").lower()
        if "two weeks of split-adjusted sample data" not in readme or "https://firstratedata.com/about/license" not in readme:
            raise ValueError(f"{symbol} sample lacks the reviewed adjustment or licence description")
        table = csv.DictReader(StringIO(archive.read(barfile).decode("utf-8-sig")))
        if tuple(table.fieldnames or []) != HEADERS:
            raise ValueError(f"{symbol} daily sample fields changed")
        rows = []
        for row in table:
            day = row["timestamp"]
            if len(row) != len(HEADERS) or dt.date.fromisoformat(day).isoformat() != day or rows and day <= rows[-1]["session"]:
                raise ValueError(f"Invalid {symbol} sample date order")
            o, c = read_ohlcv(symbol, row)
            rows.append({"session": day, "open": o, "close": c})
        if not 1 <= len(rows) <= 16:
            raise ValueError(f"Unexpected {symbol} sample size")
    return rows


def read_regular_minutes(symbol, raw, daily, short_days):
    """Verify every minute between the independently reviewed core-session bounds."""
    by_day = {row["session"]: [] for row in daily}
    cutoff = {day: "13:00:00" if day in short_days else "16:00:00" for day in by_day}
    with ZipFile(BytesIO(raw)) as archive:
        member = archive.getinfo(f"{symbol}_1min_sample.csv")
        if member.file_size > 3_000_000:
            raise ValueError(f"Oversized {symbol} minute file")
        text = archive.read("_readme_documentation.txt").decode("utf-8-sig").lower()
        if "timestamps run from the start of the period" not in text or "timezone is us eastern time" not in text:
            raise ValueError(f"{symbol} minute clock documentation changed")
        table = csv.DictReader(StringIO(archive.read(member).decode("utf-8-sig")))
        if tuple(table.fieldnames or []) != HEADERS:
            raise ValueError(f"{symbol} minute sample fields changed")
        for row in table:
            stamp = row["timestamp"]
            day = stamp[:10]
            if day in by_day and "09:30:00" <= stamp[11:] < cutoff[day]:
                by_day[day].append(row)
    result = []
    for day, rows in by_day.items():
        start = dt.datetime.fromisoformat(day + "T09:30:00")
        count = 210 if day in short_days else 390
        if len(rows) != count or any(row["timestamp"] != (start + dt.timedelta(minutes=index)).isoformat(sep=" ") or
                                   len(row) != len(HEADERS) for index, row in enumerate(rows)):
            continue
        pairs = [read_ohlcv(symbol, row) for row in rows]
        result.append({"session": day, "open": pairs[0][0], "close": pairs[-1][1], "minutes": count})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("through", type=dt.date.fromisoformat)
    parser.add_argument("--cached-only", action="store_true")
    parser.add_argument("--independent-samples", action="store_true",
                        help="Report unverified sample files separately from verified captures")
    parser.add_argument("--expected-close", type=dt.datetime.fromisoformat)
    parser.add_argument("--short-session", type=dt.date.fromisoformat, action="append", default=[])
    parser.add_argument("--cached-issuer-history-from", type=dt.date.fromisoformat,
                        help="Read only issuer histories from an existing capture")
    args = parser.parse_args()
    folder = ROOT / ".consensus" / "private-firstrate" / "captures" / args.through.isoformat()
    issuer_history = args.cached_issuer_history_from
    cached_only = args.cached_only or issuer_history is not None
    if issuer_history and issuer_history > args.through:
        parser.error("Issuer history starts after the capture session")
    if args.expected_close and args.expected_close.tzinfo is None:
        parser.error("The expected core close requires a timezone")
    start = issuer_history.isoformat() if issuer_history else "2026-01-01"
    short_days = {day.isoformat() for day in args.short_session}
    os.umask(0o077)
    try:
        if not cached_only:
            folder.mkdir(parents=True, mode=0o700, exist_ok=True)
        if folder.is_symlink() or S_IMODE(folder.stat().st_mode) != 0o700:
            raise ValueError("FirstRate capture must use an owner-only directory")
        samples = []
        failures = []
        for symbol in (() if issuer_history else EQUITY_SAMPLES):
            url = STORAGE + f"frd_sample_etf_{symbol}.zip"
            try:
                raw, meta, rows = capture(folder, f"sample-{symbol}", url, SAMPLE_SIZE, cached_only,
                                        args.through.isoformat(), args.expected_close)
                sample = {**meta, "symbol": symbol, "basis": "split-adjusted",
                          "modifiedAt": utc(parsedate_to_datetime(meta["lastModified"])), "rows": rows}
                if args.independent_samples:
                    try:
                        sample["regularMinutes"] = read_regular_minutes(symbol, raw, rows, short_days)
                    except (ValueError, KeyError, TypeError, BadZipFile):
                        sample["regularMinutes"] = []
                samples.append(sample)
            except (OSError, ValueError, KeyError, TypeError, BadZipFile) as error:
                if not args.independent_samples:
                    raise
                failures.append({"symbol": symbol, "reason": str(error)[:240]})
        issuers = []
        if samples or issuer_history:
            for symbol in SYMBOLS:
                raw, meta, _ = capture(folder, f"issuer-{symbol}", ISSUERS[symbol], ISSUER_SIZE, cached_only)
                issuers.append({**issuer_cash(symbol, raw, start), "capturedAt": meta["capturedAt"]})
        result = {"samples": samples, "issuers": issuers}
        if args.independent_samples:
            result["sampleFailures"] = failures
        print(json.dumps(result, allow_nan=False, separators=(",", ":")))
    except (OSError, ValueError, KeyError, TypeError, BadZipFile) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
