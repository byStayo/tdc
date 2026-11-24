#!/usr/bin/env python3
"""Verify contemporaneous Canadian policy statements without opening any instrument prices."""
import argparse
import concurrent.futures
import datetime as dt
import decimal
import gzip
import hashlib
import html
import json
import os
import re
import tempfile
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from bisect import bisect_left, bisect_right
from fractions import Fraction
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
BANK = "https://www.bankofcanada.ca"
FIRST = 2003
LAST = 2021
NY = ZoneInfo("America/New_York")
MONTH = r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"
WEEKDAY = r"(?:Monday|Tuesday|Wednesday|Thursday|Friday)"
ISO = r"\d{4}-\d{2}-\d{2}"
POLICY = HERE / "boc-decisions-tlt-policy.json"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(data):
    return (json.dumps(data, sort_keys=True, indent=2) + "\n").encode()


def seal(path, data):
    if path.exists():
        if path.is_symlink() or path.stat().st_mode & 0o077 or path.read_bytes() != data:
            raise ValueError(f"Historical source changed or became readable: {path.name}")
        return
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        f.write(data)
        name = f.name
    try:
        os.link(name, path)
    except FileExistsError:
        seal(path, data)
    finally:
        os.unlink(name)


def source(root, url, online):
    if urllib.parse.urlsplit(url).hostname != "www.bankofcanada.ca":
        raise ValueError("Unexpected archive host")
    cache = root / "sources"
    pointer = cache / (sha(url.encode()) + ".json")
    if not pointer.exists():
        if not online:
            raise ValueError(f"Missing original: {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "DailyConsensus public-research/1.0"})
        for attempt in range(2):
            try:
                with urllib.request.urlopen(req, timeout=15) as response:
                    if response.status != 200 or response.geturl() != url:
                        raise ValueError("Bank source changed status or location")
                    data = response.read(4_000_001)
                    if len(data) > 4_000_000:
                        raise ValueError("Bank source exceeds bounded size")
                    meta = {"url": url, "sha256": sha(data), "bytes": len(data),
                            "serverDate": response.headers.get("date"),
                            "retrievedAt": dt.datetime.now(dt.timezone.utc).isoformat()}
                break
            except (TimeoutError, urllib.error.URLError):
                if attempt:
                    raise
                time.sleep(1)
        seal(cache / (meta["sha256"] + ".gz"), gzip.compress(data, mtime=0))
        seal(pointer, json_bytes(meta))
    if pointer.stat().st_mode & 0o077:
        raise ValueError("Source metadata must be owner-only")
    meta = json.loads(pointer.read_bytes())
    original = cache / (meta["sha256"] + ".gz")
    if original.stat().st_mode & 0o077:
        raise ValueError("Source bytes must be owner-only")
    data = gzip.decompress(original.read_bytes())
    if meta["url"] != url or sha(data) != meta["sha256"] or len(data) != meta["bytes"]:
        raise ValueError("Native Bank source hash mismatch")
    return meta, data


def discover(root, online):
    meta, idx = source(root, f"{BANK}/wp-sitemap.xml", online)
    loc = ".//{*}loc"
    indexes = [x.text for x in ET.fromstring(idx).findall(loc)
               if re.fullmatch(r"https://www.bankofcanada.ca/wp-sitemap-posts-post-\d+\.xml", x.text)]
    if not indexes:
        raise ValueError("Original Bank post index not found")
    urls = set()
    for url in indexes:
        _, xml = source(root, url, online)
        urls.update(x.text for x in ET.fromstring(xml).findall(loc))
    schedule, decisions = {}, set()
    for url in sorted(urls):
        parsed = re.fullmatch(r"https://www.bankofcanada.ca/(20\d\d)/\d\d/([^/]+)/", url)
        if not parsed:
            continue
        year, slug = int(parsed[1]), parsed[2]
        if FIRST - 1 <= year < LAST and "schedule" in slug and str(year + 1) in slug and not any(x in slug for x in ("bond","auction","debt","domestic")):
            if year + 1 in schedule:
                raise ValueError(f"Ambiguous advance date schedule for {year + 1}")
            schedule[year + 1] = url
        if FIRST <= year <= LAST and re.search(r"overnight|key-policy|interest-rate-target|bank-rate|keeps-target|target-for-the|fad-press-release|raises-target|lowers-target|maintains-target", slug):
            if not re.search(r"schedule|survey|research|paper|corridor|outlook|speeche?s|repo|funding-rate|overnight-index|consultation|quarterly|market-notice|payment",slug):
                decisions.add(url)
    if set(schedule) != set(range(FIRST, LAST + 1)):
        raise ValueError("Incomplete Bank annual schedule catalogue")
    return schedule, sorted(decisions)


def plain(raw):
    return " ".join(html.unescape(re.sub(r"<[^>]*>", " ", raw)).split())


def content(raw):
    text = raw.decode("utf8")
    date = re.search(r"<div class=['\"]post-date['\"]>(.*?)</div>", text, re.S)
    title = re.search(r"<h1\b[^>]*>(.*?)</h1>", text, re.S)
    if not date or not title:
        raise ValueError("Original publication date or title missing")
    match = re.search(rf"({MONTH} \d{{1,2}}, \d{{4}})", plain(date[1]))
    if not match:
        raise ValueError("No unambiguous dataset release day")
    day = dt.datetime.strptime(match[1], "%B %d, %Y").date().isoformat()
    body = text[date.end():]
    paragraphs = [plain(s) for s in re.findall(r"<p\b[^>]*>(.*?)</p>",body,re.I|re.S)]
    return day, plain(title[1]), body, paragraphs


def scheduled_dates(page, year):
    issued, title, raw, _ = content(page)
    if issued[:4] != str(year-1) or str(year) not in title:
        raise ValueError(f"Advance calendar clock or title differs for {year}")
    text = plain(raw)
    # The older calendars print an explicit year on every date or one heading per year.
    # Locate the *schedule* for the following year; ignore later survey and MPR sections.
    candidates = set()
    for m in re.finditer(rf"({WEEKDAY}),?\s+(?:(\d{{1,2}})\s+({MONTH})|({MONTH})\s+(\d{{1,2}}))(?:\s*,?\s*(20\d\d))?", text):
        day = int(m[2] or m[5])
        month = dt.datetime.strptime(m[3] or m[4], "%B").month
        if m[6] and int(m[6]) != year:
            continue
        when = dt.date(year, month, day)
        if when.strftime("%A") != m[1]:
            continue
        candidates.add(when.isoformat())
    return candidates


def canada_target(statement, title):
    words = " ".join(statement[:2]) or title
    words = words.replace("¼", " 1/4").replace("½", " 1/2").replace("¾", " 3/4")
    words = words.replace("per cent", "percent").replace("per-cent","percent")
    words = re.sub(r"\s+"," ",words)
    # The first target level after the overnight/policy-rate description is the decision.
    # Bank Rate and deposit rates in the next clause have different definitions.
    direct = re.search(r"(?i)(?:target (?:for the |for |level for the )?overnight (?:interest )?rate|overnight rate target|(?:key )?policy (?:interest )?rate|key interest rate)\b", words)
    if not direct:
        return None
    fragment = words[direct.end():direct.end()+195]
    point = re.search(r"(?:\bat|\bto|\bunchanged at|\bof)\s+(\d+\s+\d/\d|\d/\d|\d+(?:\.\d+)?)\s*(?:per\s*cent|percent|%)", fragment, re.I)
    if not point:
        return None
    return str(decimal.Decimal(sum(Fraction(s) for s in point[1].split()).numerator)
               / decimal.Decimal(sum(Fraction(s) for s in point[1].split()).denominator))


def originals(root, online):
    schedule, candidates = discover(root, online)
    urls = sorted(set(schedule.values()).union(candidates))
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        captured = dict(zip(urls, pool.map(lambda u: source(root, u, online), urls)))
    plans, originals = {}, {}
    for year, url in schedule.items():
        info, data = captured[url]
        plans[year] = {"url": url, "sha256": info["sha256"],
                       "possible": sorted(scheduled_dates(data,year))}
    for url in candidates:
        info, data = captured[url]
        rel, title, _, paras = content(data)
        if not re.match(r"Bank of Canada (?:keeps|holds|maintains|raises|increases|lowers|cuts|reduces|leaves|will maintain|will hold)",title,re.I):
            continue
        when = int(rel[:4])
        if when not in plans or rel not in plans[when]["possible"]:
            continue
        rate = canada_target(paras, title)
        if rel in originals:
            raise ValueError(f"Two decision originals for {rel}")
        originals[rel] = {"url": url, "sha256": info["sha256"], "new": rate, "title": title}
    return plans, originals, len(candidates)


def date_at(raw):
    return dt.date.fromisoformat(raw)


def minus(day, n):
    return (date_at(day) - dt.timedelta(days=n)).isoformat()


def bank_rates(root, online):
    link = f"{BANK}/valet/observations/V39079/json?start_date=2002-09-01&end_date=2022-01-15"
    meta, raw = source(root, link, online)
    data = json.loads(raw)
    series = data["seriesDetail"]["V39079"]
    if series["label"] != "Target for the overnight rate (business daily)" or series["metadata"]["unit"] != "Percent":
        raise ValueError("Native target definition or units changed")
    records = [(row["d"], Fraction(row["V39079"]["v"])) for row in data["observations"] if "V39079" in row]
    if len(records) < 3000 or any(b[0] <= a[0] for a,b in zip(records,records[1:])):
        raise ValueError("Missing or unordered Bank policy history")
    return meta["sha256"], dict(records)


def effective_register(root, online):
    path = "/rates/interest-rates/key-interest-rates/?lookupPage=lookup_key_interest.php&startRange=1935-01-01&searchType=dates&dFrom=2002-01-01&dTo=2022-01-15&submit=Submit"
    meta, raw = source(root,BANK+path,online)
    tables = re.findall(r"<table\b[^>]*>.*?</table>",raw.decode(),re.S|re.I)
    rates = {}
    for t in tables:
        parsed = [[plain(v) for v in re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>",r,re.S|re.I)]
                  for r in re.findall(r"<tr\b[^>]*>(.*?)</tr>",t,re.S|re.I)]
        if not parsed or parsed[0]!=["Date","Bank rate","Change","Target for the overnight rate","Change"]:
            continue
        for date, _, _, rate, change in parsed[1:]:
            if not re.fullmatch(ISO,date) or date in rates or (rates and date <= next(reversed(rates))):
                raise ValueError("Ambiguous historical effective-date register")
            level = Fraction(rate)
            if rates and level - next(reversed(rates.values())) != Fraction(change):
                raise ValueError("Effective register level and printed change conflict")
            rates[date] = level
    if len(rates) < 40 or min(rates) > "2002-11-01":
        raise ValueError("Incomplete Bank effective-date register")
    return meta["sha256"],rates


def fed_rates(external):
    rates, hashes = {}, {}
    for name, url in [("board-target","https://www.federalreserve.gov/monetarypolicy/openmarket.htm"),
                      ("board-target-archive","https://www.federalreserve.gov/monetarypolicy/openmarket_archive.htm")]:
        folder = next(d for d in (external/"private-tlt-fomc-dissent",external/"private-frbsf-fomc-source-qualification") if (d/(name+".json")).is_file())
        m = json.loads((folder/(name+".json")).read_bytes())
        raw = gzip.decompress((folder/m["file"]).read_bytes())
        if m["source"] != url or m["status"] != 200 or sha(raw) != m["sha256"]:
            raise ValueError("U.S. Federal Reserve source proof failed")
        hashes[name] = m["sha256"]
        text = raw.decode()
        for table in re.finditer(r"<table\b[^>]*>.*?</table>", text, re.I|re.S):
            ys = re.findall(r"<h4[^>]*>\s*(\d{4})\s*</h4>", text[:table.start()], re.I)
            if not ys or ys[-1] < "2002":
                continue
            for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", table[0], re.I|re.S):
                cells = [plain(c) for c in re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]>",row,re.I|re.S)]
                if len(cells) != 4 or cells[0] == "Date":
                    continue
                day = dt.datetime.strptime(ys[-1]+" "+cells[0].rstrip(" *"),"%Y %B %d").date().isoformat()
                values = [Fraction(v) for v in re.split(r"[-–]",cells[3].replace(" ",""))]
                if day in rates or len(values) not in (1,2):
                    raise ValueError("Duplicate or ambiguous U.S. policy rate")
                rates[day] = sum(values) / len(values)
    if len(rates) < 40 or min(rates) > "2002-11-07":
        raise ValueError("Incomplete U.S. policy history")
    return hashes, rates


def earlier(external):
    specs = {
        "FOMC dissent": ("private-tlt-fomc-dissent/source-only-cohort.json","approved",("prior","target")),
        "BLS CPI": ("private-november-price-repair/nov19/bls-cpi-tlt/eligible-dates.json","eligible",("prior","target")),
        "BLS payroll": ("private-bls-payroll-news/source-targets.json","targets",("entry.session",)),
        "Treasury TIC": ("private-tic-treasury-demand/source-cohort.json","targets",("day",)),
        "ONS services": ("private-ons-services-tlt/v1/features-final.json","eligible",("target",)),
    }
    excluded, proof = {}, {}
    for name,(file,field,columns) in specs.items():
        data = (external/file).read_bytes()
        rows = json.loads(data)[field]
        proof[name] = {"file":file,"sha256":sha(data),"rows":len(rows),"fields":columns}
        for row in rows:
            for col in columns:
                node = row
                for field_name in col.split("."):
                    node = node[field_name]
                if not re.fullmatch(ISO,node):
                    raise ValueError("Invalid earlier research date")
                excluded.setdefault(node,set()).add(name+"/"+col)
    return excluded,proof


def roster(root, external, plans, statements, online):
    cal_file = external/"private-tlt-fomc-dissent/research-calendar.json"
    cal_raw = cal_file.read_bytes()
    cal = json.loads(cal_raw)
    if cal["version"] != "4.13.3" or "exchange_calendar_xnys" not in cal["source"]:
        raise ValueError("Historical NYSE clock is unverified")
    days = sorted(cal["sessions"])
    old, receipts = earlier(external)
    ca_digest, ca = bank_rates(root,online)
    us_sources, us = fed_rates(external)
    change_digest, register = effective_register(root,online)
    ca_dates, us_dates, effective_dates = sorted(ca), sorted(us), sorted(register)

    def previous(dates,history,day):
        index=bisect_right(dates,day)-1
        if index<0:
            raise ValueError("Missing prior policy observation")
        return history[dates[index]]

    if set(plans) != set(range(FIRST,LAST+1)) or any(sum(d.startswith(str(y)) for d in statements) != 8 for y in plans):
        raise ValueError("Missing the full eight original decisions of an annual calendar")
    for d,level in ca.items():
        if previous(effective_dates,register,d) != level:
            raise ValueError("Daily and effective-date histories disagree on "+d)
    kept, removed, source_checks, strict = [],[],[],[]
    for day, original in sorted(statements.items()):
        if day not in plans[int(day[:4])]["possible"] or original["new"] is None:
            raise ValueError("Missing same-day decision or context")
        end, start = minus(day,1),minus(day,43)
        has_daily = ca_dates[0] <= start and bisect_right(ca_dates,day) < len(ca_dates)
        prev_day = ca_dates[bisect_left(ca_dates,day)-1] if has_daily else None
        next_day = ca_dates[bisect_right(ca_dates,day)] if has_daily else None
        following = (date_at(day)+dt.timedelta(days=1)).isoformat()
        new = Fraction(original["new"])
        # The press statements and register are reconciled before the daily business series exists.
        old_level = previous(effective_dates,register,end)
        stat_level = previous(effective_dates,register,following)
        matches = (new == stat_level and (not has_daily or (new == ca[next_day] and old_level == ca[prev_day])))
        source_checks.append({"day":day,"newMatches":matches,"priorDailyDate":prev_day,"nextDailyDate":next_day,
                              "nextEffectiveBound":following,"dailyEligible":has_daily})
        target = days[bisect_right(days,day)]
        session = cal["sessions"][target]
        reason = []
        if not matches:
            reason.append("native decision disagrees with the first later policy observation")
        if not session["full"]:
            reason.append("short U.S. session")
        reason.extend(sorted(old.get(target,[])))
        if reason:
            removed.append({"sourceDay":day,"target":target,"reasons":reason})
            continue
        issue = dt.datetime.combine(date_at(target),dt.time(7,48),NY)
        bound = dt.datetime.combine(date_at(day)+dt.timedelta(days=1),dt.time(),NY)
        opening = dt.datetime.fromisoformat(session["open"])
        close = dt.datetime.fromisoformat(session["close"])
        if not bound <= issue < opening < close or close-opening != dt.timedelta(hours=6,minutes=30):
            raise ValueError("Invalid pre-target or U.S. session clock")
        features = [previous(effective_dates,register,start)-old_level,
                    previous(us_dates,us,start)-previous(us_dates,us,end),
                    old_level-new]
        if has_daily:
            daily_features = [previous(ca_dates,ca,start)-previous(ca_dates,ca,end),
                              features[1],ca[prev_day]-new]
            if daily_features != features:
                raise ValueError("Source extension changes a previously qualified feature")
            strict.append(target)
        kept.append({"day":target,"sourceDay":day,"plan":plans[int(day[:4])]["sha256"],"original":original["sha256"],
                     "availableBy":bound.astimezone(dt.timezone.utc).isoformat(),"issue":issue.astimezone(dt.timezone.utc).isoformat(),
                     "open":opening.isoformat(),"close":close.isoformat(),"features":[float(x) for x in features]})
    if len(set(r["day"] for r in kept)) != len(kept) or any(a["close"]>=b["issue"] for a,b in zip(kept,kept[1:])):
        raise ValueError("Overlapping or nonunique retrospective dates")
    inputs = {"policy":sha(POLICY.read_bytes()),"sourceProgram":sha(Path(__file__).read_bytes()),"feeds":us_sources,
              "bankTargetHistory":ca_digest,"effectiveRegister":change_digest,"sourceSupplement":sha((HERE/"boc-decisions-tlt-source-extension.json").read_bytes()),"exchangeCalendar":sha(cal_raw),"earlierRosters":receipts,
              "decisionOriginals":sha((root/"verified-schedule-origins.json").read_bytes())}
    return {"inputs":inputs,"strictEligible":strict,"sourceChecks":source_checks,"excluded":removed,"eligible":kept,
            "validationFrom":kept[len(kept)*6//10]["day"],"testFrom":kept[len(kept)*8//10]["day"]}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--capture", action="store_true", help="Fetch absent originals. Default is offline.")
    p.add_argument("--external", type=Path, help="Owner-only reference receipt root, without opening any ETF outcome.")
    args = p.parse_args()
    root = args.root
    root.mkdir(mode=0o700,exist_ok=True,parents=True)
    if root.stat().st_mode & 0o077:
        raise ValueError("Private directory must be owner-only")
    seal(root/"policy.json", POLICY.read_bytes())
    plans, statements, discovered = originals(root,args.capture)
    seal(root/"verified-schedule-origins.json",json_bytes({"plans":plans,"originals":statements,"candidates":discovered}))
    print(json.dumps({"candidateUrls":discovered,"originalScheduled":len(statements),
          "missingParsedRates":[d for d,v in statements.items() if v["new"] is None],
          "years":{y:[len(v["possible"]),sum(day.startswith(str(y)) for day in statements)] for y,v in plans.items()}},sort_keys=True))

    if args.external:
        seal(root/"effective-register-qualification.json",(HERE/"boc-decisions-tlt-source-extension.json").read_bytes())
        cohort = roster(root,args.external,plans,statements,args.capture)
        seal(root/"source-cohort.json",json_bytes(cohort))
        print(json.dumps({"eligible":len(cohort["eligible"]),"strictDaily":len(cohort["strictEligible"]),"excluded":len(cohort["excluded"]),
                          "nativeTargetMismatches":[r["day"] for r in cohort["sourceChecks"] if not r["newMatches"]],
                          "validationFrom":cohort["validationFrom"],"testFrom":cohort["testFrom"],
                          "sourceCohortSHA256":sha(json_bytes(cohort))},sort_keys=True))

if __name__ == "__main__":
    main()
