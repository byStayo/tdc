"""Reproduce the first monthly retail balances from the Board's original, dated H.6 issues."""
import argparse
import calendar
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import math
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

WEB = Path(__file__).resolve().parents[1]
ROOT = WEB / ".consensus/private-h6-retail-iwm"
BOARD = "https://www.federalreserve.gov/releases/h6/"
STUDY_SHA = "5ae31205a2eb69600d9030042346b9b435842199150267a91863a48f97551d0d"
MONTHS = {m[:3].lower(): i for i, m in enumerate(calendar.month_name) if m}
DAY = dt.date.fromisoformat
clock = lambda: dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")
sha = lambda b: hashlib.sha256(b).hexdigest()
request_lock = threading.Lock()
last_request = 0.0

# Checked against original venue calendars. The 2008 and extended 2012 (Sandy) rules
# already appear in the sealed Iowa study. Three venues independently confirm 2009–12.
CLOSED = {
    2008: "0101 0121 0218 0321 0526 0704 0901 1127 1225",
    2009: "0101 0119 0216 0410 0525 0703 0907 1126 1225",
    2010: "0101 0118 0215 0402 0531 0705 0906 1125 1224",
    2011: "0117 0221 0422 0530 0704 0905 1124 1226",
    2012: "0102 0116 0220 0406 0528 0704 0903 1029 1030 1122 1225",
}
SHORT = {2008: "0703 1128 1224", 2009: "1127 1224", 2010: "1126", 2011: "1125", 2012: "0703 1123 1224"}
VENUE_SOURCES = {
    2008: ["https://www.urs.org/mango/pdf/urs/QuarterlyBulletin/2007/4q/quarterlyBulletin.pdf",
           "https://www.nasdaqtrader.com/TraderNews.aspx?id=HTA2008-070", "https://www.nasdaqtrader.com/TraderNews.aspx?id=uva2008-019"],
    2009: ["https://www.nasdaqtrader.com/TraderNews.aspx?id=nva2008-083", "https://www.nasdaqtrader.com/TraderNews.aspx?id=dtn2009-050"],
    2010: ["https://www.nasdaqtrader.com/TraderNews.aspx?id=dn2009-041", "https://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2010-73"],
    2011: ["https://www.nasdaqtrader.com/TraderNews.aspx?id=dn2010-030", "https://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2011-54"],
    2012: ["https://www.sec.gov/Archives/edgar/data/1540305/000089418912003062/ess_497c.htm", "https://www.nasdaqtrader.com/TraderNews.aspx?id=dtn2012-20", "https://www.nasdaqtrader.com/TraderNews.aspx?id=ETA2012-45"],
}
VOLUME = "https://cdn.cboe.com/resources/us/equities/market-statistics/historical-market-volume/market_history_{}.csv"


def earlier_sessions(root, collecting):
    days = {}
    source_hashes = {}
    for year in CLOSED:
        opened = set()
        day = dt.date(year, 1, 1)
        while day.year == year:
            md = day.strftime("%m%d")
            if day.weekday() < 5 and md not in CLOSED[year].split():
                opened.add(day.isoformat())
                days[day.isoformat()] = {"early": md in SHORT[year].split()}
            day += dt.timedelta(days=1)
        if year > 2008:
            body, receipt = native(root, f"cboe-calendar-{year}", VOLUME.format(year), collecting, 2_000_000)
            source_hashes[year] = receipt["sha256"]
            rows = list(csv.DictReader(io.StringIO(body.decode())))
            for participant in ("NASDAQ (Q)", "NYSE (N)", "NYSE Arca (P)"):
                traded = [r["Day"] for r in rows if r["Market Participant"] == participant and int(r["Total Trade Count"]) > 0]
                if len(traded) != len(opened) or set(traded) != opened:
                    raise ValueError(f"{year} calendar does not match trading dates on {participant}")
    previous = root / "earlier-calendar.json"
    if sha(previous.read_bytes()) != "1c46ee024f22687fd51d1d318d9fafaa1f15637fe4251ae0d9928fcf01bfc92d":
        raise ValueError("Existing 2013–15 original venue-calendar receipt changed")
    days.update(owner_json(previous)["days"])
    return {"days": days, "nativeVolume": source_hashes, "source": VENUE_SOURCES, "legacy2013To15": sha(previous.read_bytes())}


def native(root, name, url, collect=False, max_bytes=600_000):
    """Private source bytes and actual retrieval clock; originals remain outside Git."""
    folder = root / "originals"
    metadata = folder / (name + ".json")
    packed = folder / (name + ".gz")
    if not metadata.exists() and collect:
        global last_request
        for attempt in range(2):
            with request_lock:
                time.sleep(max(0, last_request + .32 - time.monotonic()))
                last_request = time.monotonic()
            try:
                req = Request(url, headers={"User-Agent":"DailyConsensusResearch/1.0 (+https://thedailyconsensus.com)"})
                with urlopen(req, timeout=14) as response:
                    if response.status != 200 or response.geturl() != url:
                        raise ValueError("Unexpected source status/redirect for " + name)
                    body = response.read(max_bytes + 1)
                break
            except (HTTPError, URLError, TimeoutError) as exc:
                if (isinstance(exc, HTTPError) and exc.code not in (408, 429, 500, 502, 503, 504)) or attempt:
                    raise
        if not 0 < len(body) <= max_bytes:
            raise ValueError("Unexpected source size: " + name)
        if packed.exists():
            if gzip.decompress(packed.read_bytes()) != body:
                raise ValueError("Existing raw source differs: " + name)
        else:
            with packed.open("xb") as output:
                output.write(gzip.compress(body, compresslevel=5, mtime=0))
        seal(metadata, {"source":url, "receivedAt":clock(), "sha256":sha(body), "bytes":len(body)})
    meta = owner_json(metadata)
    if not packed.is_file() or packed.is_symlink() or packed.stat().st_mode & 0o077:
        raise ValueError("Native source file is not owner-only")
    body = gzip.decompress(packed.read_bytes())
    if meta["source"] != url or meta["sha256"] != sha(body) or meta["bytes"] != len(body):
        raise ValueError("Raw source / receipt mismatch: " + name)
    return body, meta


def owner_json(path):
    if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o077:
        raise ValueError("Missing or unsafe owner-only file: " + path.name)
    return json.loads(path.read_bytes())


def seal(path, value):
    data = (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError("Immutable owner result differs: " + path.name)
    else:
        with path.open("xb") as f:
            f.write(data)
    return sha(data)


def clean(text):
    return " ".join(unescape(re.sub(r"<[^>]+>", " ", text)).split())


def values(numbers):
    if len(numbers) != 9 or not all(v > 0 for v in numbers):
        raise ValueError("Unexpected historical component count/value")
    if abs(sum(numbers[3:5]) - numbers[5]) > Decimal("0.2") or abs(numbers[2] + numbers[5] + numbers[6] - numbers[7]) > Decimal("0.3"):
        raise ValueError("Historical deposit subtotal or non-M1 balance does not reconcile")
    return str(numbers[6]), str(numbers[5])


class Rows(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows, self.row, self.cell = [], None, None
    def handle_starttag(self, name, attrs):
        if name == "tr":
            self.row = []
        elif name in ("th","td") and self.row is not None:
            self.cell = []
    def handle_endtag(self, name):
        if name in ("td","th") and self.cell is not None:
            self.row.append(" ".join(" ".join(self.cell).split()))
            self.cell = None
        elif name == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None
    def handle_data(self, text):
        if self.cell is not None:
            self.cell.append(text)


def monthkey(year, name):
    return f"{int(year):04d}-{MONTHS[name[:3].lower()]:02d}"


def parse_report(data, release_day):
    report = data.decode("utf-8", errors="replace")
    dates = re.findall(r"Release Date:\s*(?:<[^>]+>\s*)*([A-Za-z]+ \d{1,2}, \d{4})", report, re.I)
    if not dates or any(dt.datetime.strptime(v, "%B %d, %Y").date() != DAY(release_day) for v in dates):
        raise ValueError("Original release date disagrees with Board archive: " + release_day)
    pre = re.search(r"<pre[^>]*>(.*?)</pre>", report, re.I | re.S)
    result = {}
    if pre:
        text = unescape(pre[1])
        start = re.search(r"Table 4\s+SEASONALLY ADJUSTED COMPONENTS OF NON-M1 M2\s+Billions of dollars", text, re.I)
        if not start:
            raise ValueError("Unidentified historical seasonally adjusted Board table")
        table = text[start.end():].split("Week ending", 1)[0].split("Table 5", 1)[0]
        if not all(term in table.lower() for term in ("small-denomination time deposit","savings deposits","retail","funds")):
            raise ValueError("Unrecognized native fields")
        year = None
        for line in table.splitlines():
            # An explicit p after the month marks a valid first preliminary observation.
            row = re.fullmatch(r"\s*(?:(\d{4})-)?([A-Za-z]{3,9})\.?\s+(?:[per]\s+)?((?:[\d,.]+[per]?\s+){8}[\d,.]+[per]?)\s*",line,re.I)
            if not row or row[2][:3].lower() not in MONTHS:
                continue
            year = row[1] or year
            numbers = [Decimal(re.sub(r"[per,]","",v)) for v in row[3].split()]
            key = monthkey(year,row[2])
            if key in result:
                raise ValueError("Duplicate economic month")
            result[key] = values(numbers)
    else:
        # Select the one explicitly *seasonally adjusted* table, using its native title rather than table order.
        section = re.search(r"(?<!Not )Seasonally Adjusted Components of (?:Non-M1 M2|M1 and (?:Non-M1 )?M2)[^<]{0,70}Billions of dollars",report,re.I)
        if not section:
            raise ValueError("Missing native component table title")
        end = report.lower().find("</table>",section.end())
        parser = Rows()
        parser.feed(report[section.end():end])
        native_header = clean(report[section.end():end].split("</thead>",1)[0]).lower()
        if not re.search(r"small-\s*denomination time deposits",native_header) or not re.search(r"retail money(?: market)? funds",native_header):
            raise ValueError("Missing native retail/deposit field labels")
        old = release_day < "2021-02-23"
        components = None
        if not old:
            headers = [r for r in parser.rows if any("denomination time deposits" in s.lower() for s in r)]
            if len(headers) != 1:
                raise ValueError("Ambiguous current component header")
            names = [re.sub(r"\s+", " ", item.lower().replace("- ", "-")).strip() for item in headers[0]]
            def exact_column(prefix):
                matches = [i for i,s in enumerate(names) if re.fullmatch(prefix+r"(?: \d+)?", s)]
                if len(matches) != 1:
                    raise ValueError("Missing unique component label in the Board's dated table")
                return 1+matches[0]
            components = (exact_column("retail money market funds"),exact_column("small-denomination time deposits"))
        for row in parser.rows:
            if not row: continue
            named = re.fullmatch(r"([A-Za-z]+)\.?\s+(\d{4})",row[0])
            if not named: continue
            def number(v):
                return Decimal(re.sub(r"[\s,per]","",v))
            key = monthkey(named[2],named[1])
            if key in result: raise ValueError("Original economic month appears twice")
            if old:
                result[key] = values([number(v) for v in row[1:]])
            else:
                # The February 2021 methodology change retained separately published legacy components.
                retail, deposit = (number(row[index]) for index in components)
                if min(retail,deposit) <= 0: raise ValueError("Invalid monthly balance")
                result[key] = (str(retail),str(deposit))
    if len(result) < 5 or max(result) > release_day[:7]:
        raise ValueError("Insufficient or postdated original monthly data")
    return result


def prior_month(ym):
    return (DAY(ym + "-01") - dt.timedelta(days=1)).isoformat()[:7]


def month_candidate(root, month, dates, collect):
    expected = prior_month(month); previous = prior_month(expected)
    seen = []
    for d in dates:
        day = dt.datetime.strptime(d,"%Y%m%d").date().isoformat()
        body, receipt = native(root,d,BOARD+d+"/",collect)
        values = parse_report(body,day)
        latest = max(values)
        seen.append({"day":day,"latest":latest,"raw":receipt["sha256"]})
        if expected not in values:
            if latest > expected: raise ValueError("An original skipped the expected accounting month: "+day)
            continue
        if latest != expected or previous not in values:
            return {"month":month,"examined":seen,"excluded":"missing_or_multiple_reference_months"}
        # If an earlier original was already two reference months behind, one issue introduced two or more new months.
        prior_latest = seen[-2]["latest"] if len(seen)>1 else None
        if prior_latest and prior_latest != previous:
            return {"month":month,"examined":seen,"excluded":"multiple_first_months"}
        return {"month":month,"period":expected,"release":day,"raw":receipt["sha256"],"examined":seen,
                "current":values[expected],"previous":values[previous]}
    return {"month":month,"examined":seen,"excluded":"month_not_observed"}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collect", action="store_true",help="Collect missing primary Board originals. Default replays existing originals.")
    parser.add_argument("--directory",type=Path,default=ROOT)
    args=parser.parse_args();root=args.directory
    os.umask(0o077)
    reg=owner_json(root/"registration.json")
    if reg["policySha256"]!=STUDY_SHA or sha((WEB/"scripts/h6-retail-iwm-policy.json").read_bytes())!=STUDY_SHA:
        raise ValueError("Unregistered or changed source policy")
    raw,meta=native(root,"release-index",BOARD+"releaseDates.json",args.collect)
    # The migrated index uses the April 2013 href ending 05, which is a 404.
    # The contemporaneous annual index explicitly displays 04 and the dated April 4
    # document identifies itself as April 4. Verify both before using that original.
    april_index,april_receipt=native(root,"release-index-2013",BOARD+"2013.htm",args.collect)
    if not re.search(rb'href="20130405/">04</a>',april_index,re.I):
        raise ValueError("The historical April 2013 issue-index discrepancy changed")
    months={}
    complete_dates=[]
    for group in json.loads(raw):
        for m in group["Months"]:
            ym=m["MonthValue"][:4]+"-"+m["MonthValue"][4:]
            # The Board attaches asterisks to annual revisions and methodology notes.
            days=sorted(d.rstrip("*") for d in m["Dates"])
            if ym=="2013-04":
                if days.count("20130405") != 1:
                    raise ValueError("April 2013 migrated index has changed")
                days[days.index("20130405")]="20130404"
            if "2007-12"<=ym<="2021-12":
                if len(set(days))!=len(days) or any(not re.fullmatch(ym.replace("-","")+r"\d{2}",d) for d in days):
                    raise ValueError("Invalid archive date list")
                complete_dates.extend(days)
            if "2008-01"<=ym<="2021-12":
                months[ym]=days
    if len(months)!=14*12: raise ValueError("Official H.6 archive does not cover all requested months")
    def one(k):
        return month_candidate(root,k,months[k],args.collect)
    with ThreadPoolExecutor(max_workers=3) as pool:
        events=list(pool.map(one,sorted(months)))
    complete_dates.sort()
    for i,e in enumerate(events):
        if "release" not in e:
            continue
        index=complete_dates.index(e["release"].replace("-",""))
        previous=complete_dates[index-1]
        day=dt.datetime.strptime(previous,"%Y%m%d").date().isoformat()
        body,receipt=native(root,previous,BOARD+previous+"/",args.collect)
        former=max(parse_report(body,day))
        e["previousOriginal"]={"day":day,"latest":former,"raw":receipt["sha256"]}
        if former!=prior_month(e["period"]):
            events[i]={key:e[key] for key in ("month","examined","previousOriginal")}
            events[i]["excluded"]="prior_original_already_printed_or_multiple_new_months"
    calendar_hash = seal(root/"historical-sessions.json",earlier_sessions(root,args.collect))
    result={"study":STUDY_SHA,"index":meta["sha256"],"april2013Index":april_receipt["sha256"],"months":events,"calendar":calendar_hash}
    print(json.dumps({"months":len(events),"qualifiedNative":sum("release" in e for e in events),
                      "originals":sum(len(e["examined"]) for e in events),"seal":seal(root/"board-first-months.json",result)}))
if __name__=="__main__": main()

