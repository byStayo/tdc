"""Capture official sample ZIPs and issuer histories for the four-ETF review."""

import argparse
import csv
import datetime as dt
from decimal import Decimal
from email.utils import parsedate_to_datetime
from hashlib import sha256
from io import BytesIO, StringIO
import json
import math
import os
from pathlib import Path
import re
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


def read_premarket(symbol, raw, day):
    """Read only the archived 04:00–09:29 Eastern minutes for one approved date."""
    with ZipFile(BytesIO(raw)) as archive:
        members = archive.infolist()
        if len(members) > 12 or len({entry.filename for entry in members}) != len(members):
            raise ValueError("Unexpected sample archive")
        docs = archive.getinfo("_readme_documentation.txt")
        minute_file = archive.getinfo(f"{symbol}_1min_sample.csv")
        if docs.file_size > 25_000 or minute_file.file_size > 3_000_000:
            raise ValueError("Oversized premarket sample")
        readme = archive.read(docs).decode("utf-8-sig").lower()
        if not all(term in readme for term in ("two weeks of split-adjusted sample data",
                "timestamps run from the start of the period", "timezone is us eastern time",
                "times with zero volume are omitted", "https://firstratedata.com/about/license")):
            raise ValueError("Premarket time, coverage or price basis changed")
        table = csv.DictReader(StringIO(archive.read(minute_file).decode("utf-8-sig")))
        if tuple(table.fieldnames or []) != HEADERS:
            raise ValueError("Premarket sample fields changed")
        bars = {}
        for row in table:
            stamp = row["timestamp"]
            if not isinstance(stamp, str) or dt.date.fromisoformat(stamp[:10]).isoformat() != stamp[:10]:
                raise ValueError("Invalid minute date")
            if stamp[:10] != day:
                continue
            clock = dt.datetime.fromisoformat(stamp)
            if clock.isoformat(sep=" ") != stamp or clock.tzinfo is not None:
                raise ValueError("Invalid Eastern minute timestamp")
            if not dt.time(4) <= clock.time() < dt.time(9, 30):
                continue
            if clock.second or clock.microsecond or stamp in bars or len(row) != len(HEADERS) or not all(
                    re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", row[key] or "") for key in HEADERS[1:-1]) or not re.fullmatch(
                    r"[0-9]+", row["volume"] or ""):
                raise ValueError("Invalid or duplicate premarket minute")
            bars[stamp] = read_ohlcv(symbol, row)
    first, last = bars.get(day + " 04:00:00"), bars.get(day + " 09:29:00")
    if first is None or last is None:
        raise ValueError("Premarket boundary minute unavailable")
    return {"session": day, "changePct": round(100 * (last[1] / first[0] - 1), 1), "activeMinutes": len(bars)}


def compare_minute_grids(symbol, raw, day, regular=False):
    """Compare the vendor's dated native minute trades with every native five-minute OHLCV."""
    start, stop = ("09:30:00", "16:00:00") if regular else ("04:00:00", "09:30:00")
    with ZipFile(BytesIO(raw)) as archive:
        info = archive.infolist()
        if len(info) > 12 or len({item.filename for item in info}) != len(info):
            raise ValueError("Unexpected sample archive members")
        docs = archive.getinfo("_readme_documentation.txt")
        if docs.file_size > 25_000:
            raise ValueError("Oversized FirstRate documentation")
        readme = archive.read(docs).decode("utf-8-sig").lower()
        if not all(term in readme for term in ("two weeks of split-adjusted sample data",
                "timestamps run from the start of the period", "timezone is us eastern time",
                "times with zero volume are omitted", "https://firstratedata.com/about/license")):
            raise ValueError("FirstRate time, adjustment, zero-volume or licence definition changed")

        def rows(interval):
            member = archive.getinfo(f"{symbol}_{interval}min_sample.csv")
            if member.file_size > 3_000_000:
                raise ValueError("Oversized FirstRate intraday comparison file")
            table = csv.DictReader(StringIO(archive.read(member).decode("utf-8-sig")))
            if tuple(table.fieldnames or ()) != HEADERS:
                raise ValueError("Unexpected FirstRate OHLCV columns")
            previous = None
            for row in table:
                stamp = row["timestamp"]
                if not isinstance(stamp, str) or len(stamp) < 10:
                    raise ValueError("Missing FirstRate intraday timestamp")
                if stamp[:10] != day:
                    continue
                instant = dt.datetime.fromisoformat(stamp)
                if instant.isoformat(sep=" ") != stamp or instant.tzinfo or instant.second or instant.microsecond:
                    raise ValueError("Malformed FirstRate Eastern interval timestamp")
                if not start <= stamp[11:] < stop:
                    continue
                if (instant.minute % interval or (previous and stamp <= previous) or len(row) != len(HEADERS) or
                        not all(re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", row[name] or "") for name in HEADERS[1:-1]) or
                        not re.fullmatch(r"[0-9]+", row["volume"] or "")):
                    raise ValueError("Invalid FirstRate intraday comparison row")
                opening, high, low, close = (Decimal(row[name]) for name in HEADERS[1:-1])
                volume = int(row["volume"])
                if low <= 0 or low > min(opening, close) or high < max(opening, close) or volume <= 0:
                    raise ValueError("Invalid FirstRate intraday OHLCV")
                previous = stamp
                yield instant, [opening, high, low, close, volume]

        minutes = dict(rows(1))
        buckets = {}
        for instant, (opening, high, low, close, volume) in minutes.items():
            at = instant.replace(minute=instant.minute // 5 * 5)
            if at not in buckets:
                buckets[at] = [opening, high, low, close, volume]
            else:
                bar = buckets[at]
                bar[1], bar[2], bar[3], bar[4] = max(bar[1], high), min(bar[2], low), close, bar[4] + volume
        native = dict(rows(5))
        if not regular:
            if not 2 <= len(native) <= 66 or native != buckets:
                raise ValueError("Premarket minute aggregates differ from the five-minute delivery")
            return len(native)
        opening = dt.datetime.fromisoformat(day + " 09:30:00")
        last = opening + dt.timedelta(minutes=389)
        if opening not in minutes or last not in minutes:
            raise ValueError("Regular-session boundary minute unavailable")
        starts = [opening + dt.timedelta(minutes=5 * n) for n in range(78)]
        if list(native) != starts or native != buckets:
            raise ValueError("Regular-session minute OHLCV differs from the complete 78 five-minute bars")
        high, low = max(v[1] for v in native.values()), min(v[2] for v in native.values())
        if high <= low:
            raise ValueError("Indeterminate regular-session high and low")
        close = minutes[last][3]
        return {"closeFifth": min(5, 1 + int((5 * (close - low)) // (high - low))),
                "activeMinutes": len(minutes), "verifiedBuckets": len(native)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compare-premarket-grids", action="store_true")
    parser.add_argument("--cached-regular-range", choices=EQUITY_SAMPLES,
                        help="Replay one native minute/five-minute local archive for price context")
    parser.add_argument("--capture-root", type=Path,
                        help="Existing private captures directory for offline regular-range replay only")
    parser.add_argument("through", type=dt.date.fromisoformat)
    parser.add_argument("--cached-only", action="store_true")
    parser.add_argument("--cached-premarket", choices=EQUITY_SAMPLES,
                        help="Replay one approved sample locally and return derived premarket statistics")
    parser.add_argument("--independent-samples", action="store_true",
                        help="Report unverified sample files separately from verified captures")
    parser.add_argument("--expected-close", type=dt.datetime.fromisoformat)
    parser.add_argument("--short-session", type=dt.date.fromisoformat, action="append", default=[])
    parser.add_argument("--cached-issuer-history-from", type=dt.date.fromisoformat,
                        help="Read only issuer histories from an existing capture")
    args = parser.parse_args()
    if args.compare_premarket_grids and not args.cached_premarket:
        parser.error("Premarket comparisons require a specific locally captured ETF")
    folder = ROOT / ".consensus" / "private-firstrate" / "captures" / args.through.isoformat()
    if args.capture_root and not args.cached_regular_range:
        parser.error("--capture-root is only available for read-only regular-range replay")
    if args.cached_regular_range and (args.cached_premarket or args.compare_premarket_grids or
            args.independent_samples or args.cached_issuer_history_from):
        parser.error("Choose only the regular-range replay")
    if args.capture_root:
        folder = args.capture_root / args.through.isoformat()
    issuer_history = args.cached_issuer_history_from
    cached_only = args.cached_only or issuer_history is not None or bool(args.cached_premarket or args.cached_regular_range)
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
        if args.cached_regular_range:
            from zoneinfo import ZoneInfo
            expected = dt.datetime.combine(args.through, dt.time(16), tzinfo=ZoneInfo("America/New_York"))
            if args.expected_close != expected:
                raise ValueError("Full ordinary regular-session close required")
            symbol, day = args.cached_regular_range, args.through.isoformat()
            raw, meta, _ = capture(folder, f"sample-{symbol}", STORAGE + f"frd_sample_etf_{symbol}.zip",
                                   SAMPLE_SIZE, True, session=day, expected_close=expected)
            result = compare_minute_grids(symbol, raw, day, regular=True)
            print(json.dumps({**result, "symbol": symbol, "session": day, "source": meta["url"],
                              "nativeSha256": meta["sha256"], "capturedAt": meta["capturedAt"],
                              "vintageAt": utc(parsedate_to_datetime(meta["lastModified"]))}, allow_nan=False))
            return
        if args.cached_premarket:
            if not args.expected_close:
                raise ValueError("Premarket replay requires the reviewed session close")
            symbol = args.cached_premarket
            raw, meta, _ = capture(folder, f"sample-{symbol}", STORAGE + f"frd_sample_etf_{symbol}.zip",
                                   SAMPLE_SIZE, True, session=args.through.isoformat() if args.compare_premarket_grids else None,
                                   expected_close=args.expected_close)
            result = {**read_premarket(symbol, raw, args.through.isoformat()), "symbol": symbol, "url": meta["url"],
                      "sha256": meta["sha256"], "retrievedAt": meta["capturedAt"],
                      "vintageAt": utc(parsedate_to_datetime(meta["lastModified"]))}
            if args.compare_premarket_grids:
                result["verifiedBuckets"] = compare_minute_grids(symbol, raw, args.through.isoformat())
            print(json.dumps(result, allow_nan=False))
            return
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
