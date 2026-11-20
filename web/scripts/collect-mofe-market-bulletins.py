"""Collect the Korean finance ministry's dated 2024–25 Daily Economic Indicators."""

import argparse
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
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
import struct
import sys
from tempfile import NamedTemporaryFile
from time import monotonic, sleep
from urllib.parse import urlencode
from urllib.robotparser import RobotFileParser


HOST = "mofe.go.kr"
BASE = f"https://{HOST}"
BOARD = "/st/ecnmyidx/TbEconomyIndicatorList.do"
DETAIL = "/st/ecnmyidx/detailTbEconomyIndicatorView.do"
ATTACHMENT = "/com/cmm/fms/FileDown.do"
CATALOG = "https://www.data.go.kr/data/3034223/fileData.do"
PARAMS = {"bbsId": "MOSFBBS_000000000045", "menuNo": "6010200"}
START, END = date(2024, 1, 1), date(2025, 12, 31)
SEOUL = timezone(timedelta(hours=9))
CACHE = Path(__file__).resolve().parents[1] / ".consensus" / "private-korea-market"
USER_AGENT = "DailyConsensusResearch/1.0 (+https://thedailyconsensus.com)"
MAX_HTML, MAX_HWP = 384_000, 384_000
MIN_INTERVAL_SECONDS = 0.65
FIELD = re.compile(r"<([^<>]*)>")
POST_ID = r"MOSF_[0-9]{15}"
DATE_SPAN = r'<span class="date">\s*(20\d\d\.\d\d\.\d\d)\.?\s*</span>'
REPORT_DATE = re.compile(r"일일\s*경제지표\s*\(\s*['’‘]?(?:20)?(2[3-6])\.\s*(\d{1,2})\.\s*(\d{1,2})")
NUMBER = r"(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?"
HWP_SUMMARY = "\x05HwpSummaryInformation"

# Weekday cash-market holidays from the Korea Exchange schedule. December 29,
# 2023 is included to validate the first prior-session column of 2024.
# https://global.krx.co.kr/contents/GLB/05/0501/0501060000/GLB0501060000T3.jsp
# https://kind.krx.co.kr/external/2024/12/17/000106/20241217000237/99303.htm
KRX_CLOSURES = frozenset(date.fromisoformat(day) for day in """
    2023-12-29
    2024-01-01 2024-02-09 2024-02-12 2024-03-01 2024-04-10
    2024-05-01 2024-05-06 2024-05-15 2024-06-06 2024-08-15
    2024-09-16 2024-09-17 2024-09-18 2024-10-01 2024-10-03
    2024-10-09 2024-12-25 2024-12-31
    2025-01-01 2025-01-27 2025-01-28 2025-01-29 2025-01-30 2025-03-03
    2025-05-01 2025-05-05 2025-05-06 2025-06-03 2025-06-06 2025-08-15
    2025-10-03 2025-10-06 2025-10-07 2025-10-08 2025-10-09
    2025-12-25 2025-12-31
""".split())
DELAYED_KRX_CLOSE = {date(2024, 11, 14), date(2025, 11, 13)}


class SourceError(Exception):
    """A collection-wide source or integrity failure."""


class RejectedBulletin(ValueError):
    """A structural or date exclusion for one archived entry."""


def board_path(page):
    return BOARD + "?" + urlencode({
        **PARAMS, "searchStartDt": START.strftime("%Y.%m.%d"),
        "searchEndDt": END.strftime("%Y.%m.%d"), "pageIndex": page,
    })


def detail_path(post_id):
    return DETAIL + "?" + urlencode({**PARAMS, "searchNttId1": post_id})


def private_dir(path):
    if path.is_symlink():
        raise SourceError(f"Unexpected symbolic link at {path}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if S_IMODE(path.stat().st_mode) != 0o700:
        raise SourceError(f"Expected owner-only directory at {path}")


def private_bytes(path, limit):
    if path.is_symlink() or not path.is_file():
        raise SourceError(f"Unexpected receipt path {path}")
    info = path.stat()
    if S_IMODE(info.st_mode) != 0o600 or info.st_size > limit:
        raise SourceError(f"Unexpected permissions or size for {path}")
    return path.read_bytes()


def read_json(path):
    return json.loads(private_bytes(path, MAX_HTML))


def write_private(path, payload):
    with NamedTemporaryFile(dir=path.parent, prefix=".pending-", delete=False) as temporary:
        staged = Path(temporary.name)
        try:
            temporary.write(payload)
            temporary.close()
            staged.replace(path)
        finally:
            staged.unlink(missing_ok=True)


def encode_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


class Ministry:
    def __init__(self):
        self.connection = HTTPSConnection(HOST, timeout=15)
        self.robots = None
        self.next_request = 0
        self.interval = MIN_INTERVAL_SECONDS

    def request(self, path, limit):
        if self.robots is None:
            policy, _ = self.get("/robots.txt", 16_000)
            self.robots = RobotFileParser()
            self.robots.parse(policy.decode("utf-8-sig").splitlines())
            self.interval = max(self.interval, self.robots.crawl_delay(USER_AGENT) or 0)
        if not self.robots.can_fetch(USER_AGENT, BASE + path):
            raise SourceError(f"The ministry's robots.txt disallows {path.split('?')[0]}")
        return self.get(path, limit, allow_missing=path.startswith((DETAIL + "?", ATTACHMENT + "?")))

    def get(self, path, limit, allow_missing=False):
        for attempt in range(3):
            sleep(max(0, self.next_request - monotonic()))
            retry_after = 0
            try:
                self.connection.request("GET", path, headers={"User-Agent": USER_AGENT})
                response = self.connection.getresponse()
                status = response.status
                content_type = response.headers.get_content_type()
                if status == 200:
                    data = response.read(limit + 1)
                    if len(data) > limit:
                        raise SourceError(f"Oversized response at {path.split('?')[0]}")
                    return data, content_type
                if status == 404 and allow_missing:
                    self.connection.close()
                    return None, content_type
                if status not in {408, 429, 500, 502, 503, 504}:
                    raise SourceError(f"HTTP {status} at {path.split('?')[0]}")
                delay_header = response.getheader("Retry-After")
                if delay_header:
                    try:
                        retry_after = int(delay_header) if delay_header.isdecimal() else (
                            parsedate_to_datetime(delay_header) - datetime.now(timezone.utc)
                        ).total_seconds()
                    except (OverflowError, TypeError, ValueError) as error:
                        raise SourceError("Invalid ministry Retry-After header") from error
                failure = f"HTTP {status}"
                self.connection.close()
            except (HTTPException, OSError) as error:
                self.connection.close()
                failure = str(error)
            finally:
                self.next_request = monotonic() + self.interval
            if attempt == 2 or retry_after > 30:
                raise SourceError(f"{failure} at {path.split('?')[0]}")
            self.next_request = monotonic() + max(2 ** (attempt + 1), retry_after, self.interval)


def parse_day(text):
    return date.fromisoformat(text.replace(".", "-"))


def observation_in(text):
    match = REPORT_DATE.search(text)
    if match:
        year, month, day = map(int, match.groups())
        return date(2000 + year, month, day)
    return None


def parse_board(text):
    board = re.search(r'<ul class="boardType3">(.*?)</ul>', text, re.S)
    last_page = re.search(r'<span class="lst"><a href="\?pageIndex=(\d+)"', text)
    if not board or not last_page:
        raise SourceError("The ministry board format changed")
    posts = []
    for entry in re.findall(r"<li>(.*?)</li>", board[1], re.S):
        post = re.search(r"fn_egov_select\(\"(" + POST_ID + r")\"\);'\s*>([^<]+)</a>", entry)
        posted = re.findall(DATE_SPAN, entry)
        if post is None or len(posted) != 1:
            raise SourceError("Unexpected entry on the ministry board")
        title = unescape(post[2]).strip()
        posts.append({"id": post[1], "title": title, "postingDate": parse_day(posted[0]).isoformat()})
    return int(last_page[1]), posts


def board_entries(ministry, cached_only):
    folder = CACHE / "board"
    posts = []
    pages = 1
    for number in range(1, 61):
        path = board_path(number)
        cache = folder / f"{number:02}.json"
        if cache.exists():
            receipt = read_json(cache)
        elif cached_only:
            return posts, False
        else:
            private_dir(folder)
            raw, _ = ministry.request(path, MAX_HTML)
            last_page, entries = parse_board(raw.decode("utf-8"))
            receipt = {"source": BASE + path, "sha256": sha256(raw).hexdigest(),
                       "lastPage": last_page, "entries": entries}
            write_private(cache, encode_json(receipt).encode())
        if number == 1:
            pages = receipt["lastPage"]
        entries = receipt["entries"]
        if (receipt["source"] != BASE + path or receipt["lastPage"] != pages or not 1 <= pages <= 60
                or not 1 <= len(entries) <= 10 or (number < pages and len(entries) != 10)):
            raise SourceError("Ministry archive pagination drifted")
        posts.extend(entries)
        if number % 10 == 0 and not cached_only:
            print(f"Indexed {number}/{pages} ministry board pages", file=sys.stderr)
        if number == pages:
            break
    if len({post["id"] for post in posts}) != len(posts):
        raise SourceError("Repeated ministry archive entry across pages")
    dates = [parse_day(post["postingDate"]) for post in posts]
    if dates != sorted(dates, reverse=True) or any(not START <= day <= END for day in dates):
        raise SourceError("Ministry archive date filters failed")
    return posts, True


def hwp_last_saved(summary):
    # Hancom HWP 5.0 Table 7 identifies PIDSI_LASTSAVE_DTM (0x0D) as a UTC FILETIME.
    if len(summary) < 48 or summary[:2] != b"\xfe\xff":
        return None
    section = struct.unpack_from("<I", summary, 44)[0]
    if section > len(summary) - 8:
        return None
    length, count = struct.unpack_from("<II", summary, section)
    if length > len(summary) - section or 8 + count * 8 > length:
        return None
    for index in range(count):
        number, offset = struct.unpack_from("<II", summary, section + 8 + index * 8)
        if number == 0x0D and offset <= length - 12:
            kind, ticks = struct.unpack_from("<IQ", summary, section + offset)
            if kind == 0x40 and ticks:
                try:
                    last_saved = datetime(1601, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=ticks // 10)
                    return last_saved.isoformat(timespec="seconds")
                except OverflowError:
                    return None
    return None


def hwp_document(raw):
    """Read the text preview and optional save time from a bounded HWP 5 CFB file."""
    if len(raw) < 512 or raw[:8] != bytes.fromhex("d0cf11e0a1b11ae1"):
        raise RejectedBulletin("unsupported_attachment")
    end = 0xFFFFFFFE
    sector_size = 1 << struct.unpack_from("<H", raw, 30)[0]
    mini_size = 1 << struct.unpack_from("<H", raw, 32)[0]
    if sector_size not in {512, 4096} or mini_size != 64 or len(raw) % sector_size:
        raise RejectedBulletin("unsupported_attachment")
    u32 = lambda offset: struct.unpack_from("<I", raw, offset)[0]

    def sector(index):
        if not 0 <= index < len(raw) // sector_size - 1:
            raise RejectedBulletin("invalid_compound_file")
        return raw[(index + 1) * sector_size:(index + 2) * sector_size]

    def int_array(data):
        return [number for number, in struct.iter_unpack("<I", data)]

    def chain(start, allocation, read_sector):
        chunks, seen = [], set()
        while start != end:
            if not 0 <= start < len(allocation) or start in seen:
                raise RejectedBulletin("invalid_compound_file")
            seen.add(start)
            chunks.append(read_sector(start))
            start = allocation[start]
        return b"".join(chunks)

    fat_ids = int_array(raw[76:512])[:u32(44)]
    if not fat_ids or u32(44) > 109 or u32(72):
        raise RejectedBulletin("unsupported_attachment")
    fat = int_array(b"".join(sector(number) for number in fat_ids))
    directory = chain(u32(48), fat, sector)
    required = {"PrvText", "Root Entry", "FileHeader"}
    streams = {}
    for offset in range(0, len(directory), 128):
        entry = directory[offset:offset + 128]
        name_length = struct.unpack_from("<H", entry, 64)[0]
        if 2 <= name_length <= 64 and name_length % 2 == 0:
            name = entry[:name_length - 2].decode("utf-16le")
            if name in required or name == HWP_SUMMARY:
                if name in streams or entry[66] != (5 if name == "Root Entry" else 2):
                    raise RejectedBulletin("invalid_compound_file")
                streams[name] = struct.unpack_from("<IQ", entry, 116)
    if not required.issubset(streams):
        raise RejectedBulletin("unsupported_attachment")
    mini_start, mini_length = streams["Root Entry"]
    mini_stream = chain(mini_start, fat, sector)[:mini_length]
    mini_fat = int_array(chain(u32(60), fat, sector))

    def mini_sector(index):
        start = index * mini_size
        if start >= len(mini_stream):
            raise RejectedBulletin("invalid_compound_file")
        return mini_stream[start:start + mini_size]

    def read_stream(name):
        start, length = streams[name]
        if length < u32(56):
            data = chain(start, mini_fat, mini_sector)
        else:
            data = chain(start, fat, sector)
        if not 0 < length <= len(data):
            raise RejectedBulletin("invalid_compound_file")
        return data[:length]

    header = read_stream("FileHeader")
    if not header.startswith(b"HWP Document File") or len(header) < 40 or header[35] != 5:
        raise RejectedBulletin("unsupported_attachment")
    preview = read_stream("PrvText").decode("utf-16le").lstrip("\ufeff")
    last_saved = None
    if HWP_SUMMARY in streams:
        try:
            last_saved = hwp_last_saved(read_stream(HWP_SUMMARY))
        except RejectedBulletin:
            pass
    return preview, last_saved


def krx_business_day(day):
    return day.weekday() < 5 and day not in KRX_CLOSURES


def previous_krx_day(day):
    prior = day - timedelta(days=1)
    while not krx_business_day(prior):
        prior -= timedelta(days=1)
    return prior


def stock_fields(preview, observation):
    title = preview.splitlines()[0] if preview.strip() else ""
    if observation_in(title) != observation:
        raise RejectedBulletin("attachment_observation_mismatch")
    clock = re.search(r"\b([01]?\d|2[0-3]):([0-5]\d)\s*현재", title)
    close_time = (16, 30) if observation in DELAYED_KRX_CLOSE else (15, 30)
    if clock is None or tuple(map(int, clock.groups())) < close_time:
        raise RejectedBulletin("unverified_post_close_observation")
    equity = re.split(r"\[\s*주가\s*\]", preview, maxsplit=1)
    if len(equity) != 2:
        raise RejectedBulletin("missing_equity_table")
    lines = [FIELD.findall(line) for line in equity[1].splitlines() if FIELD.search(line)]
    lines = [[cell.strip() for cell in row] for row in lines]
    if not lines or lines[0].count("전일비") != 1:
        raise RejectedBulletin("unexpected_equity_columns")
    header = lines[0]
    change = header.index("전일비")
    prior_day = previous_krx_day(observation)
    date_columns = [(prior_day.month, prior_day.day), (observation.month, observation.day)]
    observed_columns = []
    for cell in header[change - 2:change]:
        field = re.fullmatch(r"(\d{1,2})\s*/\s*(\d{1,2})", cell)
        if not field:
            raise RejectedBulletin("stale_or_undated_equity_columns")
        observed_columns.append(tuple(map(int, field.groups())))
    if observed_columns != date_columns:
        raise RejectedBulletin("stale_or_undated_equity_columns")
    prices = {}
    for name in ("KOSPI", "KOSDAQ"):
        matches = [line for line in lines[1:] if line and line[0] == name]
        if len(matches) != 1 or len(matches[0]) != len(header):
            raise RejectedBulletin("missing_equity_series")
        prior, close, reported = matches[0][change - 2:change + 1]
        change_match = re.fullmatch(r"([+\-△▲−]?)\s*(" + NUMBER + r")\s*%", reported)
        if not all(re.fullmatch(NUMBER, price) for price in (prior, close)) or not change_match:
            raise RejectedBulletin("invalid_equity_values")
        prior, close = (Decimal(value.replace(",", "")) for value in (prior, close))
        stated = Decimal(change_match[2].replace(",", ""))
        if change_match[1] in {"-", "△", "−"}:
            stated = -stated
        if prior <= 0 or close <= 0 or abs((close / prior - 1) * 100 - stated) > Decimal("0.01"):
            raise RejectedBulletin("equity_change_mismatch")
        prices[name.lower()] = {"prior": float(prior), "close": float(close)}
    if all(pair["prior"] == pair["close"] for pair in prices.values()):
        raise RejectedBulletin("both_indices_unchanged")
    return prices, f"{int(clock[1]):02}:{clock[2]}", prior_day.isoformat()


def bulletin(post, ministry, raw_path):
    post_id, posted = post["id"], parse_day(post["postingDate"])
    detail = detail_path(post_id)
    result = {"schemaVersion": 1, "id": post_id, "postingDate": posted.isoformat(), "source": BASE + detail}
    try:
        observed = observation_in(post["title"])
        if observed is None or not START <= observed <= END:
            raise RejectedBulletin("other_page_or_outside_window")
        result["observationDate"] = observed.isoformat()
        if not krx_business_day(observed):
            raise RejectedBulletin("closed_krx_session")
        if posted < observed:
            raise RejectedBulletin("posting_precedes_observation")
        detail_bytes, _ = ministry.request(detail, MAX_HTML)
        if detail_bytes is None:
            raise RejectedBulletin("missing_detail")
        result["detailSha256"] = sha256(detail_bytes).hexdigest()
        document = detail_bytes.decode("utf-8")
        heading = re.search(r"<h3[^>]*>\s*(" + re.escape(post["title"]) + r")\s*</h3>", unescape(document))
        if heading is None or parse_day(re.search(DATE_SPAN, document)[1]) != posted:
            raise RejectedBulletin("detail_archive_mismatch")
        downloads = set(re.findall(
            r"/com/cmm/fms/FileDown\.do(?:;jsessionid=[^?\"\s]+)?\?atchFileId=(ATCH_[0-9]+)&fileSn=(\d+)",
            unescape(document),
        ))
        if len(downloads) != 1:
            raise RejectedBulletin("missing_or_multiple_attachments")
        file_id, file_number = downloads.pop()
        attachment = ATTACHMENT + "?" + urlencode({"atchFileId": file_id, "fileSn": file_number})
        result["attachment"] = BASE + attachment
        raw, kind = ministry.request(attachment, MAX_HWP)
        if raw is None:
            raise RejectedBulletin("missing_attachment")
        if kind not in {"application/octet-stream", "application/x-hwp", "application/haansofthwp"}:
            raise RejectedBulletin("unexpected_attachment_content_type")
        if raw_path.exists():
            # A file without a receipt is from an interrupted write. Confirm its
            # bytes against the current attachment associated with this posting.
            if private_bytes(raw_path, MAX_HWP) != raw:
                raise SourceError(f"Unfinished attachment changed for {post_id}")
        else:
            write_private(raw_path, raw)
        result["sha256"] = sha256(raw).hexdigest()
        preview, result["documentLastSavedAt"] = hwp_document(raw)
        prices, as_of, prior = stock_fields(preview, observed)
        result.update(prices, observationTimeSeoul=as_of, priorObservationDate=prior)
    except RejectedBulletin as error:
        result["reason"] = str(error)
    except (UnicodeError, ValueError, TypeError, struct.error, IndexError):
        result["reason"] = "invalid_detail_or_hwp"
    result["collectedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return result


def report(posts, indexed, receipts):
    rejected = Counter(receipt["reason"] for receipt in receipts if "reason" in receipt)
    candidates = defaultdict(list)
    for receipt in receipts:
        if "reason" not in receipt:
            candidates[receipt["observationDate"]].append(receipt)
    fields = ("id", "postingDate", "observationDate", "source", "sha256", "kospi", "kosdaq")
    vintage = {"savedBeforeObservationDate": 0, "savedBetweenObservationAndPosting": 0,
               "savedAfterPostingDate": 0, "missingLastSaved": 0}
    rows = []
    for _, releases in sorted(candidates.items()):
        first = min(releases, key=lambda item: (item["postingDate"], item["id"]))
        earliest = [release for release in releases if release["postingDate"] == first["postingDate"]]
        if len(releases) > len(earliest):
            rejected["later_archive_entry"] += len(releases) - len(earliest)
        if any((r["kospi"], r["kosdaq"]) != (first["kospi"], first["kosdaq"]) for r in earliest):
            rejected["conflicting_observation"] += len(earliest)
            continue
        if len(earliest) > 1:
            rejected["duplicate_observation"] += len(earliest) - 1
        rows.append({key: first[key] for key in fields})
        last_saved = first.get("documentLastSavedAt")
        if last_saved is None:
            vintage["missingLastSaved"] += 1
        else:
            save_day = datetime.fromisoformat(last_saved).astimezone(SEOUL).date().isoformat()
            if save_day > first["postingDate"]:
                vintage["savedAfterPostingDate"] += 1
            elif save_day < first["observationDate"]:
                vintage["savedBeforeObservationDate"] += 1
            else:
                vintage["savedBetweenObservationAndPosting"] += 1
    pending = len(posts) - len(receipts)
    return {
        "schemaVersion": 1, "from": START.isoformat(), "through": END.isoformat(), "catalog": CATALOG,
        "summary": {
            "indexEntries": len(posts), "indexComplete": indexed, "processed": len(receipts),
            "accepted": len(rows), "pending": pending, "rejected": dict(sorted(rejected.items())),
            "complete": indexed and pending == 0, "archiveVintage": vintage,
        },
        "rows": rows,
    }


def collect(ministry, cached_only, max_new):
    posts, indexed = board_entries(ministry, cached_only)
    sorted_posts = sorted(posts, key=lambda post: (post["postingDate"], post["id"]))
    # Sampling every third listing first gives a bounded partial run coverage of both years.
    order = sorted_posts[::3] + sorted_posts[1::3] + sorted_posts[2::3]
    folder = CACHE / "bulletins"
    receipts = []
    new = 0
    for post in order:
        if not re.fullmatch(POST_ID, post["id"]):
            raise SourceError("Invalid ministry archive ID")
        path = folder / (post["id"] + ".json")
        raw = path.with_suffix(".hwp")
        if path.exists():
            saved = read_json(path)
            if (saved["schemaVersion"] != 1 or saved["id"] != post["id"]
                    or saved["postingDate"] != post["postingDate"]):
                raise SourceError(f"Receipt does not match archive entry {post['id']}")
            if "sha256" in saved:
                original = private_bytes(raw, MAX_HWP)
                if sha256(original).hexdigest() != saved["sha256"]:
                    raise SourceError(f"Changed HWP receipt for {post['id']}")
                if "reason" not in saved and "documentLastSavedAt" not in saved:
                    _, saved["documentLastSavedAt"] = hwp_document(original)
                    if not cached_only:
                        write_private(path, encode_json(saved).encode())
            receipts.append(saved)
        elif not cached_only and (max_new is None or new < max_new):
            private_dir(folder)
            saved = bulletin(post, ministry, raw)
            write_private(path, encode_json(saved).encode())
            receipts.append(saved)
            new += 1
            if new % 20 == 0:
                accepted = sum("reason" not in receipt for receipt in receipts)
                print(f"Processed {new} new bulletins, {accepted} validated receipts so far", file=sys.stderr)
    return report(posts, indexed, receipts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--cached-only", action="store_true", help="Read receipts without making HTTP requests.")
    mode.add_argument("--max-new", type=int, help="Stop after processing this many previously unseen entries.")
    args = parser.parse_args()
    if args.max_new is not None and not 1 <= args.max_new <= 600:
        parser.error("--max-new must be in the range 1–600")
    os.umask(0o077)
    ministry = Ministry()
    try:
        if args.cached_only:
            result = collect(ministry, True, None)
        else:
            private_dir(CACHE)
            with (CACHE / "collector.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = collect(ministry, False, args.max_new)
        print(encode_json(result))
    except (SourceError, OSError, ValueError) as error:
        print(f"Collection stopped: {error}. Completed receipts remain available with --cached-only.", file=sys.stderr)
        return 1
    finally:
        ministry.connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
