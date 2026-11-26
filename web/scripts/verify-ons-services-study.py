"""Independently replay the frozen prelaunch ONS–TLT study offline. Only aggregate checks leave stdout."""
import argparse
import calendar
import csv
import datetime as dt
import gzip
import hashlib
import json
import math
import os
import re
import stat
from decimal import Decimal
from html.parser import HTMLParser
from pathlib import Path
from zoneinfo import ZoneInfo

POLICY = "851c11d510dbb61a646aa46d5e2ca0d982e5b7f3adbc62594993de2bc83cb8af"
FEATURES = "f00c43849811c2f61c229a7434ff217ec449ca9a6586e43f57a6e1ecf95a62b2"
OUTCOME = "bf3568bb6188fa31a303e08ce647a5f696251bcc9eb9454ad87acacb2749cbcc"
CUTOFF = "2026-11-03T06:28:30.460Z"
STUDY = "ons-first-services-inflation-tlt-prelaunch-v1"
ONS = "https://www.ons.gov.uk"
TIMING = "/aboutus/transparencyandgovernance/freedomofinformationfoi/historicalukcpifirstreleasedatesandhistoricalconsensusinflationforecasts2004to2025"
UK, NY = ZoneInfo("Europe/London"), ZoneInfo("America/New_York")


class EvidenceError(ValueError):
    """A source-independent message that is safe to expose from a private failed replay."""


def check(ok, message):
    if not ok:
        raise EvidenceError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def private(path, expected=None, limit=4_000_000):
    info = path.lstat()
    # Approved research directories share some content-checked, owner-only captures by hard link.
    check(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and
          info.st_mode & 0o077 == 0 and 0 < info.st_size <= limit, "Unverified private research file")
    raw = path.read_bytes()
    check(not expected or sha(raw) == expected, "A sealed research input has changed")
    return raw


def stamp(text):
    value = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    check(value.tzinfo is not None, "Source timestamp lacks its timezone")
    return value


def instant(value):
    return value.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def local_clock(day, hour, minute, zone):
    return instant(dt.datetime.combine(day, dt.time(hour, minute), tzinfo=zone))


def previous_period(period):
    first = dt.date.fromisoformat(period + "-01")
    return (first - dt.timedelta(days=1)).isoformat()[:7]


def easter(year):
    # Gregorian computus for the exchange's Good Friday closure.
    a, (b, c) = year % 19, divmod(year, 100)
    h = (19 * a + b - b // 4 - (b - (b + 8) // 25 + 1) // 3 + 15) % 30
    m = (32 + 2 * (b % 4) + 2 * (c // 4) - h - c % 4) % 7
    n = h + m - 7 * ((a + 11 * h + 22 * m) // 451) + 114
    return dt.date(year, n // 31, n % 31 + 1)


def market_close(day):
    """Verified NYSE holiday and shortened-session rules for this historical study only."""
    y, wd = day.year, day.weekday()
    check(2016 <= y <= 2026, "Outside registered market-calendar years")
    if wd >= 5:
        return None
    def observed(m, d):
        x = dt.date(y, m, d)
        return x + dt.timedelta(days={5: -1, 6: 1}.get(x.weekday(), 0))
    def weekday(month, day_of_week, week):
        first = dt.date(y, month, 1)
        return first + dt.timedelta(days=(day_of_week - first.weekday()) % 7 + 7 * (week - 1))
    thanksgiving = weekday(11, 3, 4)
    holidays = {observed(1, 1), weekday(1, 0, 3), weekday(2, 0, 3), easter(y) - dt.timedelta(days=2),
                dt.date(y, 5, 31) - dt.timedelta(days=dt.date(y, 5, 31).weekday()),
                observed(7, 4), weekday(9, 0, 1), thanksgiving, observed(12, 25),
                dt.date(2018, 12, 5), dt.date(2025, 1, 9)}
    if y >= 2022:
        holidays.add(observed(6, 19))
    if day in holidays:
        return None
    return 13 if day == thanksgiving + dt.timedelta(days=1) or (day.month, day.day) in {(7, 3), (12, 24)} else 16


def native(source, name, url):
    m = json.loads(private(source / (name + ".json")))
    check(m["url"] == url and re.fullmatch(r"[0-9a-f]{64}", m["sha256"]) and 0 < m["bytes"] <= 1_500_000,
          "ONS artifact URI, digest or size is invalid")
    stamp(m["retrievedAt"])
    raw = gzip.decompress(private(source / (m["sha256"] + ".gz"), limit=1_500_000))
    check(len(raw) == m["bytes"] and sha(raw) == m["sha256"], "ONS original body differs from its recorded version")
    return raw, m["sha256"]


def series(source, code):
    root = "/economy/inflationandpriceindices/timeseries/" + code + "/mm23"
    def load(name, path):
        raw, fingerprint = native(source, name, ONS + path + "/data")
        body = json.loads(raw)
        d = body["description"]
        title = d["title"].upper()
        check(body["type"] == "timeseries" and body["uri"] == path and d["datasetId"] == "MM23" and
              d["cdid"] == code.upper() and d["unit"] in ("%", "") and title.startswith("CPI")
              and ("SERVICES" in title if code == "d7nn" else "ALL ITEMS" in title or "CONSUMER PRICES INDEX" in title),
              "Incorrect original inflation series")
        versions = [(v["label"], v["uri"], v["updateDate"]) for v in body.get("versions", [])]
        return d, versions, body["months"], fingerprint
    _, entries, _, catalog = load(code + "-catalog", root)
    first, versions, last = {}, 0, ""
    for num, (label, url, replaced) in enumerate(entries, 1):
        check(label == "v" + str(num) and url == root + "/previous/" + label, "Invalid original version chain")
        d, predecessors, rows, fingerprint = load(code + "-" + label, url)
        check(predecessors == entries[:num - 1], "Original vintage disagrees with its catalogue history")
        dated = {(int(r["year"]), list(calendar.month_name).index(r["month"])): r for r in rows}
        yyyy, mm = max(dated)
        row = dated[yyyy, mm]
        period = f"{yyyy:04d}-{mm:02d}"
        month_title = f"{yyyy:04d} {calendar.month_abbr[mm].upper()}"
        check(period >= last and row["date"] == d["date"] == month_title == row["label"] and row["sourceDataset"] == "MM23"
              and re.fullmatch(r"-?\d{1,2}(?:\.\d)?", row["value"]), "Invalid latest economic month or rate")
        if period not in first:
            first[period] = None if not predecessors else {
                "period": period, "rate": float(Decimal(row["value"])), "nativeDay": stamp(d["releaseDate"]).astimezone(UK).date().isoformat(),
                "introducedAt": predecessors[-1][2], "nativeDate": d["releaseDate"], "observationUpdate": row["updateDate"],
                "uri": url, "sha256": fingerprint,
            }
        last, versions = period, num
        if replaced >= CUTOFF:
            break
    return first, catalog, versions


class BulletinHTML(HTMLParser):
    def __init__(self, body):
        super().__init__()
        self.headings, self.articles, self.tables = [], [], []
        self.table = self.row = self.field = None
        self.buffer = []
        self.feed(body)
        self.close()

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.table = {"caption": "", "rows": []}
        if tag == "tr" and self.table is not None:
            self.row = []
        if ((tag in ("td", "th", "caption") and self.table is not None) or tag == "h1" or
                (tag == "script" and dict(attrs).get("type") == "application/ld+json")):
            self.field, self.buffer = tag, []

    def handle_data(self, data):
        if self.field:
            self.buffer.append(data)

    def handle_endtag(self, tag):
        if tag == self.field:
            value = " ".join(" ".join(self.buffer).split())
            if tag == "script":
                self.articles.append(json.loads("".join(self.buffer)))
            elif tag == "h1":
                self.headings.append(value)
            elif tag == "caption":
                self.table["caption"] = value
            else:
                self.row.append(value)
            self.field = None
        if tag == "tr" and self.row is not None:
            self.table["rows"].append(self.row)
            self.row = None
        if tag == "table" and self.table is not None:
            self.tables.append(self.table)
            self.table = None


def bulletin(source, period):
    y, m = map(int, period.split("-"))
    month = f"{calendar.month_name[m]} {y}"
    title = "Consumer price inflation, UK: " + month
    slug = "ukconsumerpriceindicesjan2017" if period == "2017-01" else "consumerpriceinflationuk" + month.replace(" ", "").lower()
    calendar_path = "/releases/" + slug
    cal_url = ONS + calendar_path + "/data"
    cal_raw, cal_hash = native(source, "bulletin-calendar-" + period, cal_url)
    cal = json.loads(cal_raw)
    d = cal["description"]
    linked = [r["uri"] for r in cal["related_documents"] if r["title"] == title]
    check(cal["uri"] == calendar_path and d["published"] and d["finalised"] and not d["cancelled"] and len(linked) == 1
          and re.fullmatch(r"/economy/inflationandpriceindices/bulletins/consumerpriceinflation/[A-Za-z0-9]+", linked[0]),
          "Alternate original calendar or bulletin link failed")
    raw, doc_hash = native(source, "bulletin-" + period, ONS + linked[0])
    parsed = BulletinHTML(raw.decode())
    articles = [a for a in parsed.articles if a.get("@type") == "Article" and a.get("mainEntityOfPage") == linked[0]
                and a.get("url") == ONS + linked[0] and a.get("publisher", {}).get("name") == "Office for National Statistics"]
    check(parsed.headings.count(title) == 1 and len(articles) == 1 and all(stamp(articles[0][k]).astimezone(UK).date() ==
          stamp(d["release_date"]).astimezone(UK).date() for k in ("datePublished", "dateModified")), "Bulletin is not the original release")
    annual = [t["rows"] for t in parsed.tables if re.match(r"Table \d+: CPI annual and monthly inflation rates by division\b", t["caption"])]
    if not annual:
        return None
    check(len(annual) == 1 and annual[0][0] == ["", "CPI 12-month rate (%)", "CPI 1-month rate (%)"]
          and annual[0][1][2] == annual[0][1][4] == month, "Wrong measure or column in alternate bulletin")
    def cell(label):
        values = [row[2] for row in annual[0] if len(row) == 5 and row[0] == label]
        check(len(values) == 1 and re.fullmatch(r"-?\d{1,2}\.\d", values[0]), "Missing unique annual CPI cell")
        return float(values[0])
    return {"period": period, "headline": cell("CPI All items"), "services": cell("All services"), "releaseAt": d["release_date"],
            "calendarSha256": cal_hash, "bulletinSha256": doc_hash, "url": ONS + linked[0], "calendarUrl": cal_url}


def features(study):
    sealed = json.loads(private(study / "features-final.json", FEATURES))
    policy = json.loads(private(study / "registration.json", POLICY))
    check(policy["study"] == STUDY and policy["instrument"] == "TLT" and
          sealed["registration"] == POLICY and sealed["before"] == CUTOFF and sealed["exchangeCalendars"] ==
          ["nyse-group-core-research-2016-2021-v1", "nyse-nasdaq-core-research-2022-2025-v1", "us-equities-core-2026-reviewed-2026-11-03-v1"],
          "Different preregistration, calendar or forecast boundary")
    source = study / "source"
    timing, clock_hash = native(source, "timing", ONS + TIMING)
    check(all(s in timing for s in (b"25 March 2020", b"9.30am", b"7am")) and sealed["clock"] == clock_hash,
          "Unverified ONS release convention")
    h, h_hash, hv = series(source, "d7g7")
    s, s_hash, sv = series(source, "d7nn")
    periods = sorted(h.keys() | s.keys())
    check(sealed["catalogues"] == [h_hash, s_hash] and len(periods) == sealed["periods"], "Different source catalogues")
    ordinary, alt, invalid_bulletins, selected, excluded = {}, {}, set(), [], []
    for period in periods:
        a, b = h.get(period), s.get(period)
        reject = lambda why: excluded.append({"period": period, "reason": why})
        if not a or not b:
            reject("Missing verified introduction for one or both originals")
            continue
        day = dt.date.fromisoformat(a["nativeDay"])
        clocks = [r[k] for r in (a, b) for k in ("introducedAt", "nativeDate", "observationUpdate")]
        uk_time = (9, 30) if day < dt.date(2020, 3, 25) else (7, 0)
        issued = local_clock(day, *uk_time, UK)
        if previous_period(day.isoformat()[:7]) != period or not all(stamp(c).astimezone(UK).date() == day for c in clocks):
            other = bulletin(source, period)
            if other:
                check(other["headline"] == a["rate"] and other["services"] == b["rate"], "Archived monthly values differ from bulletin")
                alt[period] = {"period": period, "headline": a, "services": b, "availableAt": max([other["releaseAt"]] + clocks), "bulletin": other}
            else:
                invalid_bulletins.add(period)
            reject("ONS original rate and publication dates disagree")
            continue
        current = {"period": period, "releaseAt": issued, "availableAt": max([issued] + clocks),
                   "calendarSha256": clock_hash, "headline": a, "services": b}
        ordinary[period] = current
        if day.year < 2016 or issued >= CUTOFF:
            continue
        p = previous_period(period)
        prior = ordinary.get(p) or alt.get(p)
        if not prior or prior["availableAt"] >= issued:
            reject("Missing preceding first monthly release")
            continue
        if market_close(day) != 16:
            reject("No full US trading session")
            continue
        decision, opened, closed = [local_clock(day, *t, NY) for t in ((7, 48), (9, 30), (16, 0))]
        if not current["availableAt"] < decision < opened < closed < CUTOFF:
            reject("Release outside the registered cutoff")
            continue
        def delta(name):
            return float(Decimal(str(current[name]["rate"])) - Decimal(str(prior[name]["rate"])))
        selected.append({"target": day.isoformat(), "period": period, "decision": decision, "openAt": opened, "closeAt": closed,
                         "headlineChange": delta("headline"), "servicesChange": delta("services"), "current": current, "previous": prior})
    check(sealed["eligible"] == selected and sealed["excluded"] == excluded and set(sealed["bulletinPriors"]) == alt.keys() and
          sealed["unverifiedBulletins"] == {p: "No separate CPI all-items and services table" for p in invalid_bulletins},
          "Independent source cohort, clocks, bulletin or exclusions disagree")
    check(len(selected) == len({r["target"] for r in selected}) >= 120 and selected == sorted(selected, key=lambda r:r["target"]),
          "Missing source gate or duplicated/unordered dates")
    return selected, {"catalogueVersions": [hv, sv], "economicMonths": len(periods), "verifiedTargets": len(selected),
                      "excluded": len(excluded), "bulletinPriorMonths": sorted(alt), "unconfirmedBulletins": len(invalid_bulletins)}


def trading_days(start, end):
    a, b = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    check("2016-01-01" <= start <= end < CUTOFF[:10], "Price source would cross the prelaunch boundary")
    return [a + dt.timedelta(days=i) for i in range((b-a).days + 1) if market_close(a + dt.timedelta(days=i))]


def csv_bars(data):
    result = []
    for fields in csv.reader(data.decode("ascii").splitlines()):
        check(len(fields) == 6 and all(re.fullmatch(r"\d+(?:\.\d+)?", x) for x in fields[1:]), "Malformed historical price response")
        day = dt.datetime.strptime(fields[0], "%m/%d/%Y").date()
        opened, high, low, closed, volume = map(Decimal, fields[1:])
        check(0 < low <= min(opened, closed) <= max(opened, closed) <= high and volume > 0 and volume == int(volume),
              "Invalid OHLCV on a historical TLT response")
        def number(x):
            return int(x) if x == int(x) else float(x)
        close_hour = market_close(day)
        check(close_hour is not None, "Price received for market closure")
        result.append({"session": day.isoformat(), "openAt": local_clock(day, 9, 30, NY), "closeAt": local_clock(day, close_hour, 0, NY),
                       "open": number(opened), "close": number(closed)})
    return result


def js_hash(obj):
    # Numbers in these prices and published features use ordinary decimal notation.
    def normalized(value):
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, dict):
            return {key: normalized(v) for key, v in value.items()}
        if isinstance(value, list):
            return list(map(normalized, value))
        return value
    return sha(json.dumps(normalized(obj), separators=(",", ":"), ensure_ascii=False).encode())


def native_prices(folder, witness, basis):
    start, end = witness["from"], witness["through"]
    expected = trading_days(start, end)
    file = f"TLT-{start[:4]}-{start}-{end}-{basis}.json"
    locations = [folder / n / file for n in ("private-technical-momentum", "private-tic-treasury-demand",
                 "private-bls-payroll-news/prices", "private-ons-services-tlt/v1/prices")]
    matched = [p for p in locations if p.is_file()]
    check(len(matched) == 1, "Missing or ambiguous frozen price location")
    path = matched[0]
    doc = json.loads(private(path))
    check(doc["from"] == start and doc["through"] == end, "Wrong dated price source")
    original = "sourceSHA256" in doc
    if original:
        check(doc["ticker"] == "TLT" and doc["basis"] == basis and doc["sourceSHA256"] == witness["sha256"],
              "Wrong native source or adjustment")
        bars = csv_bars(private(path.with_suffix(".csv"), witness["sha256"]))
    else:
        check(doc["instrument"] == "TLT" and doc["sha256"] == witness["sha256"] and doc["priceDigest"] == witness["priceDigest"],
              "Normalized historical receipt differs from its price source")
        bars = doc["sessions"]
    check(js_hash(bars) == witness["priceDigest"] and len(bars) == len(expected), "The complete normalized historical file differs")
    for day, bar in zip(expected, bars):
        check(bar["session"] == day.isoformat() and bar["openAt"] == local_clock(day, 9, 30, NY) and
              bar["closeAt"] == local_clock(day, market_close(day), 0, NY) and min(bar["open"], bar["close"]) > 0 and
              all(math.isfinite(bar[k]) for k in ("open", "close")), "A retained TLT bar or exchange clock is invalid")
    return bars, original


def direction(bar):
    return (bar["close"] > bar["open"]) - (bar["close"] < bar["open"])


def source_labels(folder, result, selected):
    wanted = {r["target"] for r in selected}
    books, copies = {}, {}
    for key, basis in (("raw", "raw"), ("splitOnly", "splits")):
        hits = {}
        independent = set()
        for witness in result[key]:
            bars, has_csv = native_prices(folder, witness, basis)
            for bar in bars:
                date = bar["session"]
                if date in wanted:
                    check(date not in hits or hits[date] == bar, "Different overlapping price captures")
                    hits[date] = bar
                    if has_csv:
                        independent.add(date)
        check(hits.keys() == wanted, "Incomplete paired TLT prices")
        books[basis], copies[basis] = hits, independent
    for row in selected:
        date = row["target"]
        a, b = books["raw"][date], books["splits"][date]
        check(direction(a) == direction(b) and all(row[k] == a[k] == b[k] for k in ("openAt", "closeAt")),
              "Raw and split controls disagree at the registered session")
    return books, copies


def crosscheck_csv(folder, books, copies):
    # A separate earlier study retained daily native OHLCV for additional historical periods.
    # Use only hash-verified files whose own receipt explicitly ends before the first public forecast.
    for base, style in (("private-bls-payroll-news/prices", "payroll"), ("private-november-price-repair/nov19/bls-cpi-tlt/prices", "usCpi")):
        for path in sorted((folder / base).glob("TLT-*.csv")):
            meta = path.with_suffix(".json") if style == "payroll" else Path(str(path) + ".json")
            m = json.loads(private(meta))
            start, end = m["from"], m["through"]
            if not ("2016-01-01" <= start <= end < CUTOFF[:10]):
                continue
            if style == "payroll":
                check(m["ticker"] == "TLT" and m["basis"] in books and path.name == f"TLT-{start[:4]}-{start}-{end}-{m['basis']}.csv",
                      "Incomparable supplemental payroll price source")
                basis, expected = m["basis"], m["sourceSHA256"]
            else:
                check(m["instrument"] == "TLT" and m["basis"] == "unadjusted" and path.name == f"TLT-{start[:4]}-raw.csv",
                      "Incomparable supplemental CPI price source")
                basis, expected = "raw", m["responseSha256"]
            if not any(start <= d <= end for d in books[basis]):
                continue
            bars = csv_bars(private(path, expected))
            check([r["session"] for r in bars] == [d.isoformat() for d in trading_days(start, end)], "Incomplete supplemental dates")
            for bar in bars:
                d = bar["session"]
                if d in books[basis]:
                    check(bar == books[basis][d], "Separate native Kibot CSV disagrees with the frozen endpoint")
                    copies[basis].add(d)
    return {basis: len(days) for basis, days in copies.items()}


def fit(width, train, validation, test):
    series = list(zip(*(item["features"][:width] for item in train)))
    count = len(train)
    means = [sum(col) / count for col in series]
    scale = [math.sqrt(sum((n-u)**2 for n in col) / count) or 1. for col, u in zip(series, means)]

    def normalize(data):
        return [(tuple((x-u)/s for x, u, s in zip(row["features"], means, scale)), row["up"]) for row in data]
    training, validating, testing = map(normalize, (train, validation, test))

    def probabilities(data, bias, weights):
        def sigmoid(z):
            return 1 / (1 + math.exp(-max(-30., min(30., z))))
        return [sigmoid(bias + sum(a*b for a, b in zip(weights, vector))) for vector, _ in data]

    options = []
    for penalty in (0.01, 0.1, 1, 10):
        weights, bias = [0.] * width, 0.
        for _ in range(600):
            predicted = probabilities(training, bias, weights)
            residuals = [p - label for p, (_, label) in zip(predicted, training)]
            gradients = [sum(v[i] * e for (v, _), e in zip(training, residuals)) for i in range(width)]
            bias -= 0.08 * sum(residuals) / count
            weights = [w - 0.08 * (g + penalty*w)/count for g, w in zip(gradients, weights)]
        val_loss = sum((p-y)**2 for p, (_, y) in zip(probabilities(validating, bias, weights), validating))
        options.append((val_loss, {"intercept": bias, "weights": weights, "regularization": penalty, "means": means, "scales": scale}))
    model = min(options, key=lambda o: o[0])[1]
    return model, probabilities(testing, model["intercept"], model["weights"])


def interval(differences):
    n = len(differences)
    check(n >= 3, "Insufficient held-out dates for a length-three block")
    state, means = int(POLICY[:8], 16), []
    for _ in range(10_000):
        draw = []
        while len(draw) < n:
            state = (1664525 * state + 1013904223) & 0xffffffff
            start = (state * (n-2)) // 2**32
            draw.extend(differences[start:start+3])
        means.append(sum(draw[:n]) / n)
    means.sort()
    return [means[249], means[9749]]


def close(actual, recorded):
    if isinstance(actual, list):
        check(isinstance(recorded, list) and len(actual) == len(recorded), "Different comparison length")
        for a, b in zip(actual, recorded):
            close(a, b)
    elif isinstance(actual, dict):
        check(isinstance(recorded, dict) and actual.keys() == recorded.keys(), "Different numeric result fields")
        for k in actual:
            close(actual[k], recorded[k])
    else:
        check(math.isclose(actual, recorded, rel_tol=0, abs_tol=1e-12), "Independent fit, prediction, or score disagrees")


def exposures(folder, outcome):
    def get(name):
        return json.loads(private(folder / name))
    technical = get("private-technical-momentum/prelaunch-technical-momentum-volatility-v1.json")
    comp = next(r for r in technical["cohorts"] if r["instrument"] == "TLT")
    clocks = []
    for r in sorted((r for r in outcome["raw"] if r["sha256"] in comp["raw"]), key=lambda r:r["from"]):
        clocks.extend(trading_days(r["from"], r["through"]))
    check(technical["before"] == CUTOFF and clocks == trading_days("2022-01-03", "2026-11-02"), "Technical control calendar differs")
    # Original study needs 21 prior sessions plus its target free of shortened days.
    tech_days = {clocks[i].isoformat() for i in range(21, len(clocks)) if all(market_close(k) == 16 for k in clocks[i-21:i+1])}
    check(len(tech_days) == comp["candidate"]["samples"], "Different prior technical exposure count")
    def dates(rows):
        return {row["labelKnownAt"][:10] for row in rows}
    payroll = get("private-bls-payroll-news/sealed-study.json")
    cpi = get("private-november-price-repair/nov19/bls-cpi-tlt/result.json")
    tic = get("private-tic-treasury-demand/source-cohort.json")
    options = get("private-cftc-options/prelaunch-tff-option-positioning-v1.json")
    nowcast = get("private-nyfed-nowcast/prelaunch-nyfed-nowcast-revisions-2023-2026-v1.json")
    def cohort(obj):
        return next(c for c in obj["cohorts"] if c["instrument"] == "TLT")
    histories = {"technical": tech_days, "payroll": dates(payroll["rows"]), "usCpi": dates(cpi["rows"]),
                 "treasuryCapital": {r["day"] for r in tic["targets"]}, "futuresOptions": dates(cohort(options)["training"]),
                 "nowcast": dates(r["training"] for r in cohort(nowcast)["pairs"])}
    check(all(d < CUTOFF[:10] for days in histories.values() for d in days), "Prior comparison extends into production")
    histories["anyOfSix"] = set().union(*histories.values())
    return histories


def replay(web):
    folder = web / ".consensus"
    study = folder / "private-ons-services-tlt/v1"
    selected, source_checks = features(study)
    outcome = json.loads(private(study / "tlt-result.json", OUTCOME))
    check(outcome["study"] == STUDY and outcome["before"] == CUTOFF and outcome["registration"] == POLICY and
          outcome["featureSeal"] == FEATURES and not outcome["excluded"], "Different study, price exclusion or cutoff")
    books, copies = source_labels(folder, outcome, selected)
    native_coverage = crosscheck_csv(folder, books, copies)
    rows = [{"id": "TLT:" + event["target"], "engineVersion": STUDY, "issuedAt": event["decision"], "labelKnownAt": event["closeAt"],
             "features": [event["headlineChange"], event["servicesChange"]], "up": int(direction(books["raw"][event["target"]]) > 0)}
            for event in selected]
    check(rows == outcome["rows"], "Rebuilt source features or binary labels disagree")
    control_rows = [{**r, "features": r["features"][:1]} for r in rows]
    check(js_hash(rows) == outcome["candidateDataset"] and js_hash(control_rows) == outcome["controlDataset"],
          "Candidate and headline-only training commitments differ")
    n = len(rows)
    start_val, start_test = [rows[n * i // 5]["issuedAt"] for i in (3, 4)]
    train = [r for r in rows if r["issuedAt"] < start_val and r["labelKnownAt"] < start_val]
    validation = [r for r in rows if start_val <= r["issuedAt"] < start_test and r["labelKnownAt"] < start_test]
    test = [r for r in rows if start_test <= r["issuedAt"]]
    split = {"train": len(train), "validation": len(validation), "test": len(test), "trainEnds": train[-1]["labelKnownAt"],
             "testStarts": test[0]["issuedAt"], "testEnds": test[-1]["labelKnownAt"]}
    saved = outcome["summary"]
    check(n >= 120 and len(train) >= 50 and min(len(validation), len(test)) >= 20 and
          all({r["up"] for r in partition} == {0, 1} for partition in (train, validation, test)) and
          split == saved["split"] and saved["paired"] == saved["verifiedDates"] == n, "Invalid chronological split or label diversity")
    combined, pc = fit(2, train, validation, test)
    baseline, ph = fit(1, train, validation, test)
    close(combined, outcome["candidateModel"])
    close(baseline, outcome["controlModel"])
    check(len(outcome["predictions"]) == len(test), "Wrong test prediction count")
    for row, p, q, savedrow in zip(test, pc, ph, outcome["predictions"]):
        check(savedrow["id"] == row["id"] and savedrow["observed"] == row["up"], "Wrong test identity")
        close([p, q], [savedrow["combined"], savedrow["headline"]])
    def loss(p):
        return [(pred-row["up"])**2 for pred, row in zip(p, test)]
    c_loss, h_loss = loss(pc), loss(ph)
    rate = sum(r["up"] for r in train)/len(train)
    def mean(seq):
        return sum(seq) / len(seq)
    metrics = {"candidate": mean(c_loss), "headline": mean(h_loss), "trainingRate": mean(loss([rate] * len(test))), "coin": .25,
               "servicesCoefficient": combined["weights"][1], "controlImprovement95": interval([a-b for a, b in zip(h_loss, c_loss)])}
    for k, v in metrics.items():
        close(v, saved[k])
    passed = metrics["servicesCoefficient"] < 0 and min(metrics[k] for k in ("headline", "trainingRate", "coin")) - metrics["candidate"] > .01
    check(passed == saved["clearsRegisteredScreen"], "Different preregistered threshold decision")
    previous = exposures(folder, outcome)
    overlap = {name: {k: len({r["labelKnownAt"][:10] for r in fold} & seen) for k, seen in previous.items()}
               for name, fold in (("all", rows), ("test", test))}
    check(overlap == saved["previousStudies"], "Different exposure to prior studies")
    return {"study": STUDY, **source_checks, "pairedRawAndSplitOnly": n, "directCsvEndpointChecks": native_coverage,
            "split": split, **metrics, "passes": passed, "priorDateOverlap": overlap, "privateReceiptSha256": OUTCOME}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web", type=Path, default=Path(__file__).resolve().parents[1], help="Project web directory containing prior private receipts")
    try:
        print(json.dumps(replay(parser.parse_args().web.resolve()), sort_keys=True))
    except EvidenceError as error:
        raise SystemExit(str(error)) from None
    except (OSError, ValueError, TypeError, IndexError, KeyError):
        raise SystemExit("ONS independent replay refused an unreadable or malformed private source") from None
