"""Collect first-release ONS CPI time-series originals for private historical replay."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
from html import unescape
import json
import os
from pathlib import Path
import re
from tempfile import NamedTemporaryFile
import time
from zoneinfo import ZoneInfo
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

WEB = Path(__file__).resolve().parents[1]
ROOT = WEB / ".consensus/private-ons-services-tlt/v1"
BASE = "https://www.ons.gov.uk"
CDIDS = ("d7g7", "d7nn")
POLICY = "851c11d510dbb61a646aa46d5e2ca0d982e5b7f3adbc62594993de2bc83cb8af"
TERMS = BASE + "/help/terms-conditions"
CLOCK = BASE + "/aboutus/transparencyandgovernance/freedomofinformationfoi/historicalukcpifirstreleasedatesandhistoricalconsensusinflationforecasts2004to2025"
LICENCE = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"
MONTHS = "January February March April May June July August September October November December".split()
PREFIX = "/economy/inflationandpriceindices/timeseries/"
SHA = lambda value: hashlib.sha256(value).hexdigest()
LONDON = ZoneInfo("Europe/London")


def write_once(path, body):
    if path.is_file():
        if path.read_bytes() != body:
            raise ValueError("Changed immutable original " + path.name)
        return
    with NamedTemporaryFile(dir=path.parent, prefix=".ons-", delete=False) as tmp:
        part = Path(tmp.name)
        try:
            tmp.write(body)
            tmp.flush()
            os.fsync(tmp.fileno())
            try:
                os.link(part, path)
            except FileExistsError:
                if path.read_bytes() != body:
                    raise ValueError("Concurrent source conflict")
        finally:
            part.unlink(missing_ok=True)


def read(name, url, collect, missing_ok=False):
    folder = ROOT / "source"
    meta = folder / (name + ".json")
    if meta.is_file():
        receipt = json.loads(meta.read_bytes())
        if receipt["url"] != url or not re.fullmatch(r"[0-9a-f]{64}", receipt["sha256"]):
            raise ValueError("Changed source registration " + name)
        body = gzip.decompress((folder / (receipt["sha256"] + ".gz")).read_bytes())
        if len(body) != receipt["bytes"] or SHA(body) != receipt["sha256"]:
            raise ValueError("Changed ONS native bytes " + name)
        return body
    if not collect:
        if missing_ok:
            return None
        raise ValueError("Missing ONS native source " + name)
    headers = {"User-Agent": "The Daily Consensus research (+https://thedailyconsensus.com)", "Accept-Encoding": "identity"}
    for attempt in range(2):
        try:
            time.sleep(0.55)
            with urlopen(Request(url, headers=headers), timeout=18) as response:
                if response.status != 200 or response.url != url:
                    raise ValueError("Source identity changed")
                body = response.read(1500001)
            break
        except HTTPError as error:
            if missing_ok and error.code in (404, 410):
                return None
            if attempt or error.code not in (408, 429, 500, 502, 503, 504):
                raise
            retry = error.headers.get("Retry-After", "2")
            if not retry.isdecimal() or int(retry) > 10:
                raise
            time.sleep(int(retry))
        except (URLError, TimeoutError):
            if attempt:
                raise
            time.sleep(2)
    if not 0 < len(body) <= 1500000:
        raise ValueError("Invalid ONS source size")
    digest = SHA(body)
    captured = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    write_once(folder / (digest + ".gz"), gzip.compress(body, compresslevel=6, mtime=0))
    write_once(meta, (json.dumps({"url": url, "sha256": digest, "bytes": len(body), "retrievedAt": captured}, indent=2) + "\n").encode())
    return body


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collect", action="store_true")
    parser.add_argument("--bulletin-priors", action="store_true",
                        help="Check independently published prior-month values for native series with inconsistent clocks")
    args = parser.parse_args()
    os.umask(0o077)
    (ROOT / "source").mkdir(parents=True, exist_ok=True, mode=0o700)
    if SHA((ROOT / "registration.json").read_bytes()) != POLICY or SHA((WEB / "scripts/ons-services-study-policy.json").read_bytes()) != POLICY:
        raise ValueError("Expected the pre-price registration on the publishing host")
    if b'Open Government Licence' not in read("rights", TERMS, args.collect) or b'commercial' not in read("licence", LICENCE, args.collect):
        raise ValueError("Unconfirmed usage terms")
    clocks = read("timing", CLOCK, args.collect)
    if b'25 March 2020' not in clocks or b'9.30am' not in clocks or b'7am' not in clocks:
        raise ValueError("Unconfirmed historical release convention")
    if args.bulletin_priors:
        print(json.dumps(bulletin_priors(args.collect), sort_keys=True))
        return
    plans = {}
    for code in CDIDS:
        path = PREFIX + code + "/mm23"
        catalog = json.loads(read(code + "-catalog", BASE + path + "/data", args.collect))
        if catalog.get("uri") != path or catalog["description"]["cdid"] != code.upper():
            raise ValueError("Invalid native index")
        entries = catalog["versions"]
        if not (1 <= len(entries) <= 800):
            raise ValueError("Invalid source catalogue")
        plans[code] = []
        for i, entry in enumerate(entries, start=1):
            if entry["label"] != "v" + str(i) or entry["uri"] != path + "/previous/v" + str(i):
                raise ValueError("Unexpected archived link")
            plans[code].append(entry)
            if entry["updateDate"] >= "2026-11-03T06:28:30.460Z":
                break
    for code, entries in plans.items():
        for entry in entries:
            url = BASE + entry["uri"] + "/data"
            obj = json.loads(read(code + "-" + entry["label"], url, args.collect))
            if obj["uri"] != entry["uri"] or obj["description"]["cdid"] != code.upper() or obj["description"]["datasetId"] != "MM23":
                raise ValueError("Unexpected ONS vintage identity")
        print(code, len(entries), "original versions", flush=True)
    print(json.dumps({"catalogues":len(plans),"archivedOriginals":sum(map(len,plans.values())),"policy":POLICY}))

def london_day(stamp):
    return datetime.fromisoformat(stamp.replace("Z", "+00:00")).astimezone(LONDON).date().isoformat()


def cell(fragment):
    return " ".join(unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def bulletin_priors(collect):
    # Independent published values can establish a preceding month's levels by the
    # next release. A month with conflicting native dates stays out as a target.
    # Each of these five months had a conflict in the complete pre-price inventory.
    periods = ["2017-01", "2020-11", "2021-08", "2026-02", "2026-05"]
    accepted, excluded = {}, {}
    for period in periods:
        year, month = map(int, period.split("-"))
        named = MONTHS[month-1] + " " + str(year)
        slug = named.replace(" ", "").lower()
        path = "/releases/" + ("ukconsumerpriceindicesjan2017" if period == "2017-01" else "consumerpriceinflationuk" + slug)
        cal = read("bulletin-calendar-" + period, BASE + path + "/data", collect, missing_ok=True)
        if not cal:
            excluded[period] = "No verified dated release calendar"
            continue
        j = json.loads(cal)
        d = j["description"]
        if j["uri"] != path or not d["published"] or not d["finalised"] or d["cancelled"]:
            raise ValueError("Invalid historical bulletin calendar")
        title = "Consumer price inflation, UK: " + named
        refs = [r["uri"] for r in j.get("related_documents", []) if r.get("title") == title]
        if len(refs) != 1 or not re.fullmatch(r"/economy/inflationandpriceindices/bulletins/consumerpriceinflation/[a-zA-Z0-9]+", refs[0]):
            excluded[period] = "Dated calendar has no unambiguous link to the bulletin"
            continue
        url = BASE + refs[0]
        body = read("bulletin-" + period, url, collect, missing_ok=True)
        if not body:
            excluded[period] = "Bulletin original unavailable"
            continue
        html = body.decode("utf8")
        articles = [json.loads(s) for s in re.findall(r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S)]
        articles = [a for a in articles if a.get("@type") == "Article" and a.get("mainEntityOfPage") == refs[0] and a.get("url") == url]
        instant = d["release_date"]
        if len(articles) != 1 or articles[0].get("publisher", {}).get("name") != "Office for National Statistics" or \
                any(london_day(articles[0][k]) != london_day(instant) for k in ("datePublished","dateModified")) or \
                not any(cell(h) == title for h in re.findall(r"<h1\b[^>]*>(.*?)</h1>", html, re.S)):
            excluded[period] = "Unconfirmed original bulletin version"
            continue
        tables = []
        for table in re.findall(r"<table\b[^>]*>.*?</table>", html, re.S):
            cap = re.search(r"<caption[^>]*>(.*?)</caption>", table, re.S)
            if cap and re.match(r"Table \d+: CPI annual and monthly inflation rates by division\b", cell(cap.group(1))):
                tables.append(table)
        if len(tables) != 1:
            excluded[period] = "No separate CPI all-items and services table"
            continue
        rows = [[cell(c) for c in re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", row, re.S)] for row in
                re.findall(r"<tr\b[^>]*>(.*?)</tr>", tables[0], re.S)]
        if len(rows)<4 or rows[0] != ["", "CPI 12-month rate (%)", "CPI 1-month rate (%)"] or \
                len(rows[1]) != 5 or rows[1][2] != named or rows[1][4] != named:
            excluded[period] = "The measure or column is unconfirmed"
            continue
        rates = {}
        for label in ("CPI All items", "All services"):
            matches = [row for row in rows if len(row)==5 and row[0]==label]
            if len(matches) != 1 or not re.fullmatch(r"-?\d{1,2}\.\d", matches[0][2]):
                raise ValueError("Invalid original bulletin CPI cell")
            rates[label] = float(matches[0][2])
        accepted[period] = {"period":period,"releaseAt":instant,"url":url,"calendarUrl":BASE+path+"/data",
                            "bulletinSha256":SHA(body),"calendarSha256":SHA(cal),"headline":rates["CPI All items"],"services":rates["All services"]}
    return {"accepted":accepted,"excluded":excluded}


if __name__ == "__main__":
    main()
