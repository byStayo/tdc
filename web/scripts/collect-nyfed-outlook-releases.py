"""Collect first-published NY Fed SCE stock-expectation readings from dated press releases."""

import argparse
from calendar import monthrange
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
import fcntl
from hashlib import sha256
from html import unescape
from http.client import HTTPException, HTTPSConnection
import json
import os
from pathlib import Path
import re
from stat import S_IMODE
import sys
from tempfile import NamedTemporaryFile
from time import monotonic, sleep
from urllib.robotparser import RobotFileParser


HOST = "www.newyorkfed.org"
BASE = f"https://{HOST}"
INDEX = "/newsevents/news/index"
INDEXES = {"archive.html": INDEX, "archive-with-extension.html": INDEX + ".html"}
# These original monthly reports were independently located on the publisher's
# site. Neither was linked in the saved live index snapshots.
REVIEWED_GAPS = (
    {"id": "2017-an171211", "publicationDate": "2017-12-11",
     "source": BASE + "/newsevents/news/research/2017/an171211"},
    {"id": "2018-an180514", "publicationDate": "2018-05-14",
     "source": BASE + "/newsevents/news/research/2018/an180514"},
)
TERMS = BASE + "/privacy/termsofuse.html"
ATTRIBUTION = (
    "Source: Survey of Consumer Expectations, ©2013-2020 Federal Reserve Bank of New York. "
    "The SCE data are available without charge at https://www.newyorkfed.org/microeconomics/sce "
    "and may be used subject to license terms posted there. The New York Fed disclaims any responsibility "
    "for this analysis and interpretation of Survey of Consumer Expectations data."
)
START, END = date(2014, 1, 1), date(2026, 10, 31)
CACHE = Path(__file__).resolve().parents[1] / ".consensus" / "private-nyfed-outlook"
USER_AGENT = "DailyConsensusResearch/1.0 (+https://thedailyconsensus.com)"
MAX_INDEX_BYTES, MAX_RELEASE_BYTES, MAX_RELEASES = 2_000_000, 350_000, 320
INTERVAL_SECONDS = 0.65
RELEASE_PATH = r"/newsevents/news/research/(20\d{2})/([A-Za-z0-9][A-Za-z0-9_.-]+)"
MONTH_NAMES = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)
MONTH = "(" + "|".join(MONTH_NAMES) + r")\s+(20\d{2})"
PERIOD = re.compile(
    r"\b" + MONTH + r"\s*Survey of Consumer Expectations\b"
    r"|\b(?:findings|results) from (?:the )?" + MONTH + r"\s*Survey\b"
    r"|\bsurvey for " + MONTH + r"\b", re.I,
)
STOCK_MEAN = re.compile(
    r"\b(?:mean|average)\s+(?:(?:perceived|reported)\s+)?probability\s+that\s+"
    r"(?:U\.?\s*S\.?|United States)\s+stock prices\s+will be higher\s+"
    r"(?:12 months|twelve months|one year|a year)(?: from now| ahead)\b", re.I,
)
LEVEL = re.compile(
    r"\b(?:to|at|was|were)(?:\s+(?:a|its|the)\s+(?:new\s+)?)?"
    r"(?:\s*(?:series['’]?|record|all-time)\s+(?:low|high)\s+of)?"
    r"\s+(\d{1,3}(?:\.\d+)?)\s*(?:%|percent\b)(?!\s+(?:point|change))", re.I,
)


class SourceError(Exception):
    """The official corpus or the private cache is incomplete."""


def clean(html):
    return " ".join(unescape(re.sub(r"<[^>]+>", " ", html)).split())


def parse_date(text):
    for style in ("%B %d, %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(text, style).date()
        except ValueError:
            pass
    return None


def normalized_json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def private_dir(path):
    if path.is_symlink():
        raise SourceError(f"Unexpected symlink at {path}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if S_IMODE(path.stat().st_mode) != 0o700:
        raise SourceError(f"Expected owner-only directory at {path}")


def read_private(path, limit):
    if path.is_symlink() or not path.is_file():
        raise SourceError(f"Missing or invalid receipt file {path}")
    info = path.stat()
    if S_IMODE(info.st_mode) != 0o600 or info.st_size > limit:
        raise SourceError(f"Unexpected receipt permissions or size at {path}")
    return path.read_bytes()


def write_private(path, data):
    with NamedTemporaryFile(dir=path.parent, prefix=".pending-", delete=False) as file:
        temp = Path(file.name)
        try:
            file.write(data)
            file.close()
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)


class OfficialSite:
    def __init__(self):
        self.connection = HTTPSConnection(HOST, timeout=15)
        self.robots = None
        self.ready_at = 0
        self.interval = INTERVAL_SECONDS

    def request(self, path, limit, missing_ok=False):
        if self.robots is None:
            self.robots = RobotFileParser()
            self.robots.parse(self.get("/robots.txt", 32_000).decode("utf-8-sig").splitlines())
            self.interval = max(self.interval, self.robots.crawl_delay(USER_AGENT) or 0)
        if not self.robots.can_fetch(USER_AGENT, BASE + path):
            raise SourceError(f"Official crawler policy disallows {path}")
        return self.get(path, limit, missing_ok)

    def get(self, path, limit, missing_ok=False):
        for attempt in range(3):
            sleep(max(0, self.ready_at - monotonic()))
            retry_after = 0
            try:
                self.connection.request("GET", path, headers={"User-Agent": USER_AGENT})
                response = self.connection.getresponse()
                status = response.status
                if status == 200:
                    raw = response.read(limit + 1)
                    if len(raw) > limit:
                        raise SourceError(f"Oversized response at {path}")
                    return raw
                self.connection.close()
                if status == 404 and missing_ok:
                    return None
                if status not in {408, 429, 500, 502, 503, 504}:
                    raise SourceError(f"HTTP {status} at {path}")
                failure = f"HTTP {status}"
                wait = response.getheader("Retry-After")
                if wait:
                    try:
                        retry_after = int(wait) if wait.isdecimal() else (
                            parsedate_to_datetime(wait) - datetime.now(timezone.utc)
                        ).total_seconds()
                    except (TypeError, ValueError, OverflowError) as error:
                        raise SourceError("Invalid NY Fed Retry-After header") from error
            except (HTTPException, OSError) as error:
                self.connection.close()
                failure = str(error)
            finally:
                self.ready_at = monotonic() + self.interval
            if attempt == 2 or retry_after > 30:
                raise SourceError(f"{failure} at {path}")
            self.ready_at = monotonic() + max(self.interval, retry_after, 2 ** (attempt + 1))


def index_releases(raw):
    entries = {}
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", raw.decode("utf-8-sig"), re.I | re.S):
        link = re.search(r'<a\b[^>]*href="(' + RELEASE_PATH + r')"[^>]*>(.*?)</a>', row, re.S)
        if not link or not START.year <= int(link[2]) <= END.year:
            continue
        date_cell = re.search(r'<td\b[^>]*class="dirColL"[^>]*>(.*?)</td>', row, re.S)
        if not date_cell or not (day := parse_date(clean(date_cell[1]))) or day.year != int(link[2]):
            raise SourceError(f"Undated official index entry {link[1]}")
        if not START <= day <= END:
            continue
        entry = {"id": f"{link[2]}-{link[3]}", "publicationDate": day.isoformat(),
                 "source": BASE + link[1], "title": clean(link[4])}
        old = entries.setdefault(entry["id"], entry)
        if old != entry:
            raise SourceError(f"Conflicting press-release listings for {entry['id']}")
    if not 240 <= len(entries) <= MAX_RELEASES:
        raise SourceError("Press archive count is outside its reviewed 2014–26 bounds")
    if not {"2014-rp140113", "2017-an170410", "2026-20261007"}.issubset(entries):
        raise SourceError("The NY Fed index lacks a reviewed historical release sentinel")
    return sorted(entries.values(), key=lambda row: (row["publicationDate"], row["id"]))


def receipt(path, source, site, cached_only, limit):
    stamp = path.with_suffix(".json")
    if not stamp.exists():
        if cached_only:
            return None, None
        request_path = source.removeprefix(BASE)
        raw = site.request(request_path, limit, missing_ok=request_path not in INDEXES.values())
        if raw is not None:
            if path.exists() and read_private(path, limit) != raw:
                raise SourceError(f"Interrupted download changed for {source}")
            if not path.exists():
                write_private(path, raw)
        metadata = {"source": source, "sha256": sha256(raw).hexdigest() if raw is not None else None,
                    "retrievedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        write_private(stamp, normalized_json(metadata).encode())
        return raw, metadata
    metadata = json.loads(read_private(stamp, 8_000))
    if metadata["source"] != source:
        raise SourceError(f"Receipt URL does not match {source}")
    if metadata["sha256"] is None:
        return None, metadata
    raw = read_private(path, limit)
    if sha256(raw).hexdigest() != metadata["sha256"]:
        raise SourceError(f"Archived bytes changed for {source}")
    return raw, metadata


def article_body(html):
    start = re.search(r'<div\b[^>]*class="ts-article-text"[^>]*>', html)
    if not start:
        return ""
    depth = 1
    for tag in re.finditer(r"</?div\b[^>]*>", html[start.end():], re.I):
        depth += -1 if tag[0].startswith("</") else 1
        if depth == 0:
            return html[start.end():start.end() + tag.start()]
    return ""


def parse_release(raw, entry, digest):
    html = raw.decode("utf-8-sig")
    body = article_body(html)
    if not body:
        return None, "missing_article_body"
    # Some older pages put the dated lead directly in the article div, before its list.
    preamble = clean(re.split(r"<(?:ul|ol|li)\b", body, maxsplit=1, flags=re.I)[0])[:3500]
    matches = {tuple(field for field in match.groups() if field is not None) for match in PERIOD.finditer(preamble)}
    if not matches:
        return None, "other_release_or_undated_reference_month"
    if len(matches) != 1:
        return None, "ambiguous_reference_month"
    name, year_text = matches.pop()
    month, year = MONTH_NAMES.index(name.title()) + 1, int(year_text)
    reference = date(year, month, monthrange(year, month)[1])
    release_date = date.fromisoformat(entry["publicationDate"])
    article_dates = {parse_date(clean(block)) for block in re.findall(
        r'<div\b[^>]*class="ts-contact-info"[^>]*>(.*?)</div>', html, re.S
    )}
    if release_date not in article_dates or article_dates - {release_date, None}:
        return None, "publication_date_mismatch"
    if not 1 <= (release_date - reference).days <= 45:
        return None, "reference_month_not_before_release"
    values = set()
    stock_mentions = 0
    for block in re.findall(r"<(li|p)\b[^>]*>(.*?)</\1>", body, re.I | re.S):
        text = clean(block[1])
        for definition in STOCK_MEAN.finditer(text):
            stock_mentions += 1
            tail = re.split(r"(?<=[.!?])\s+(?=[A-Z])", text[definition.end():].lstrip(), maxsplit=1)[0]
            levels = [float(x) for x in LEVEL.findall(tail)]
            if len(levels) > 1:
                return None, "ambiguous_stock_percent"
            values.update(levels)
    if not values:
        return None, "unresolved_stock_percent" if stock_mentions else "no_original_stock_percent"
    if len(values) != 1:
        return None, "ambiguous_stock_percent"
    value = values.pop()
    if not 0 <= value <= 100:
        return None, "invalid_stock_percent"
    if re.search(r"\b(?:correction|corrected on|revised on)\b.{0,100}\bstock prices\b", clean(body), re.I):
        return None, "stock_value_correction"
    return {
        "id": entry["id"], "referenceMonthEnd": reference.isoformat(),
        "publicationDate": entry["publicationDate"], "meanHigherStockPricesPercent": value,
        "source": entry["source"], "sha256": digest,
    }, None


def collect(site, cached_only):
    catalogs, merged = {}, {}
    for filename, index in INDEXES.items():
        source = BASE + index
        raw, metadata = receipt(CACHE / filename, source, site, cached_only, MAX_INDEX_BYTES)
        if raw is None:
            raise SourceError("Both saved NY Fed archive indexes are required")
        catalogs[source] = metadata["sha256"]
        for entry in index_releases(raw):
            existing = merged.setdefault(entry["id"], entry)
            if existing["source"] != entry["source"] or existing["publicationDate"] != entry["publicationDate"]:
                raise SourceError(f"NY Fed indexes disagree on the date or URL for {entry['id']}")
    listed = len(merged)
    for entry in REVIEWED_GAPS:
        existing = merged.setdefault(entry["id"], entry)
        if existing["source"] != entry["source"] or existing["publicationDate"] != entry["publicationDate"]:
            raise SourceError(f"The NY Fed index disagrees with the reviewed original {entry['id']}")
    if len(merged) > MAX_RELEASES:
        raise SourceError("The NY Fed release corpus exceeds its reviewed bound")
    entries = sorted(merged.values(), key=lambda row: (row["publicationDate"], row["id"]))
    folder = CACHE / "releases"
    if not cached_only:
        private_dir(folder)
    candidates = defaultdict(list)
    rejected = Counter()
    processed = 0
    examples = defaultdict(list)
    for entry in entries:
        raw, metadata = receipt(folder / f"{entry['id']}.html", entry["source"], site, cached_only, MAX_RELEASE_BYTES)
        if metadata is None:
            continue
        processed += 1
        if raw is None:
            row, reason = None, "official_page_missing"
        else:
            row, reason = parse_release(raw, entry, metadata["sha256"])
        if row is not None:
            candidates[row["referenceMonthEnd"]].append(row)
        else:
            rejected[reason] += 1
            if len(examples[reason]) < 3:
                examples[reason].append(entry["id"])
        if not cached_only and processed % 50 == 0:
            print(f"Read {processed}/{len(entries)} official release receipts", file=sys.stderr)
    rows = []
    for _, observations in sorted(candidates.items()):
        first = min(observations, key=lambda row: (row["publicationDate"], row["id"]))
        same_day = [row for row in observations if row["publicationDate"] == first["publicationDate"]]
        if any(row["meanHigherStockPricesPercent"] != first["meanHigherStockPricesPercent"] for row in same_day):
            rejected["conflicting_original_release"] += len(same_day)
        else:
            rows.append(first)
            rejected["duplicate_original_release"] += len(same_day) - 1
        rejected["later_republication"] += len(observations) - len(same_day)
    return {
        "schemaVersion": 1, "from": START.isoformat(), "through": END.isoformat(),
        "catalog": BASE + INDEX, "catalogSha256": catalogs[BASE + INDEX],
        "catalogHashes": catalogs, "terms": TERMS, "attribution": ATTRIBUTION,
        "transformation": "The Daily Consensus extracted and reformatted the published readings.",
        "rows": rows,
        "summary": {"indexEntries": len(entries), "processed": processed, "accepted": len(rows),
                    "listedIndexEntries": listed, "supplementalEntries": len(entries) - listed,
                    "pending": len(entries) - processed, "complete": processed == len(entries),
                    "rejected": dict(sorted((reason, count) for reason, count in rejected.items() if count)),
                    "firstExamples": dict(examples)},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cached-only", action="store_true", help="Read saved receipts without opening a connection.")
    args = parser.parse_args()
    os.umask(0o077)
    site = OfficialSite()
    try:
        if args.cached_only:
            result = collect(site, True)
        else:
            private_dir(CACHE)
            with (CACHE / "collector.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = collect(site, False)
        print(normalized_json(result))
    except (SourceError, OSError, ValueError) as error:
        print(f"Collection stopped: {error}. Saved receipts remain available with --cached-only.", file=sys.stderr)
        return 1
    finally:
        site.connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
