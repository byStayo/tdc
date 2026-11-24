"""Verify the publisher's CC BY cashtag aggregates without retrieving individual posts."""
import argparse
import csv
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1] / ".consensus/private-x-attention/v1"
REVISION = "f1485ca2d83e6f770ed6d28522dde60f8071bebe"
BASE = f"https://huggingface.co/datasets/twitterapi-io/x-cashtag-mentions-2024-2026/resolve/{REVISION}/"
FUNDS = ("SPY", "QQQ", "IWM", "DIA", "TLT")
FILES = {
    "README.md": (5725, "3ad3a0e39387fc8ef93740f2e6245b9559bd2210"),
    "summary.json": (3802, "2903caffd3690af516ece272a94e13e346e46d42"),
    "daily_collection_counts.csv": (153675, "ed2371dfa10ec7c3a34bb21e7e8e5585eefbc7d2"),
    "daily_ticker_stats.csv.gz": (49075155, "35a97748c4d89ed43c4ac1bcecc3f8cab4afbfced8060e1b6fad862316c70af5"),
}
HEADER = "date,ticker,tweets,unique_authors,likes,retweets,replies,quotes,impressions".split(",")


def verified(path, size, oid):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != size:
        raise ValueError(f"Wrong file or length for {path.name}")
    digest = hashlib.sha256() if len(oid) == 64 else hashlib.sha1(f"blob {size}\0".encode())
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != oid:
        raise ValueError(f"Changed publisher object for {path.name}")


def original(directory, name, collect):
    size, oid = FILES[name]
    path = directory / name
    if not path.exists() and collect:
        # A concurrent replay sees either a complete verified object or no object.
        request = Request(BASE + name, headers={"User-Agent": "TheDailyConsensus/1.0 (https://thedailyconsensus.com)"})
        with urlopen(request, timeout=45) as response, tempfile.NamedTemporaryFile(dir=directory) as temp:
            if response.status != 200 or urlsplit(response.geturl()).scheme != "https":
                raise ValueError("Expected a complete HTTPS source delivery")
            while temp.tell() <= size:
                block = response.read(min(1024 * 1024, size + 1 - temp.tell()))
                if not block:
                    break
                temp.write(block)
            temp.flush()
            verified(Path(temp.name), size, oid)
            os.fsync(temp.fileno())
            try:
                os.link(temp.name, path)
            except FileExistsError:
                pass
    verified(path, size, oid)
    return path


def extract(directory, collect):
    originals = {name: original(directory, name, collect) for name in FILES}
    readme = originals["README.md"].read_text()
    if "cc-by-4.0" not in readme or "Released under CC BY 4.0" not in readme:
        raise ValueError("The author's licence was not verified")
    summary = json.loads(originals["summary.json"].read_bytes())
    with originals["daily_collection_counts.csv"].open(newline="") as file:
        collections = csv.DictReader(file)
        if collections.fieldnames != ["date", "collection", "tweets"]:
            raise ValueError("Unexpected collection inventory")
        query_days = {}
        query_total = 0
        for row in collections:
            dates = query_days.setdefault(row["collection"], set())
            if row["date"] in dates or int(row["tweets"]) <= 0:
                raise ValueError("Invalid or duplicate collection count")
            dates.add(row["date"])
            query_total += int(row["tweets"])
    first_last = {group: [min(dates), max(dates)] for group, dates in query_days.items()}
    if first_last != summary["collection_first_last"] or summary["unique_tweet_ids"] != summary["rows_in"]:
        raise ValueError("Publisher collection dates or post inventory disagree")
    days, totals = {}, dict.fromkeys(FUNDS, 0)
    mentions = authors = 0
    with gzip.open(originals["daily_ticker_stats.csv.gz"], "rt", newline="") as file:
        rows = csv.reader(file)
        if next(rows) != HEADER:
            raise ValueError("Unexpected cashtag aggregate header")
        for row in rows:
            day, ticker = row[:2]
            if len(row) != len(HEADER):
                raise ValueError("Unexpected cashtag aggregate row")
            n, a = int(row[2]), int(row[3])
            if not 0 <= a <= n or n < 1:
                raise ValueError("Invalid mention or author count")
            mentions += n
            authors += a
            if ticker in totals:
                totals[ticker] += n
                if not summary["date_min"] <= day <= summary["date_max"] or dt.date.fromisoformat(day).isoformat() != day:
                    raise ValueError("Invalid study day")
                if ticker in days.setdefault(day, {}):
                    raise ValueError("Duplicate fund and day")
                days[day][ticker] = [n, a]
    meta = summary["column_totals"]
    if mentions != meta["tweets"] or authors != meta["unique_authors"]:
        raise ValueError("Publisher's independent aggregate totals disagree")
    top = dict(summary["top100"])
    if any(totals[ticker] != top[ticker] for ticker in FUNDS if ticker in top):
        raise ValueError("Individual ticker and ranking totals disagree")
    return {"revision": REVISION, "uniquePosts": summary["unique_tweet_ids"], "queryCountTotal": query_total,
            "stockQuoteCollectionBegan": first_last["quotes_of_stock_tweets"][0], "tagMentions": mentions, "fundMentions": totals,
            "archiveDates": [summary["date_min"], summary["date_max"]], "days": days}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collect", action="store_true", help="fetch missing pinned aggregate files")
    parser.add_argument("--study-input", action="store_true", help="include daily counts for the local evaluator")
    args = parser.parse_args()
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    data = extract(ROOT, args.collect)
    if not args.study_input:
        data["days"] = len(data["days"])
    print(json.dumps(data, separators=(",", ":")))
