"""Reproduce Texas Instruments' original EPS guidance beside its filed diluted EPS and revenue."""

import argparse
import calendar
import gzip
import hashlib
import html
import io
import os
import tempfile
import json
import re
from collections import Counter
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

from qualify_spf_profits import check, private_bytes, private_dir, seal, utc

WEB = Path(__file__).resolve().parents[1]
SOURCE = WEB / ".consensus/private-issuer-guidance-archive-qualification"
STORE = WEB / ".consensus/private-txn-eps-qualification"
METHOD = "txn-original-diluted-eps-and-revenue-qualification-v1"
CATALOG = "https://data.sec.gov/submissions/CIK0000097476.json"
FACTS = "https://data.sec.gov/api/xbrl/companyconcept/CIK0000097476/us-gaap/EarningsPerShareDiluted.json"
ROOT = "https://www.sec.gov/Archives/edgar/data/97476/"
LATEST = "0000097476-26-000169"
INDEX = ROOT + LATEST.replace("-", "") + "/" + LATEST + "-index.htm"
PINS = {
    "txn-filings.json": "38e62183fd0c78d527c2ce783a6a391c80969342e0c032b9b035bff6bd655207",
    "txn-official-exhibits.json": "445b0dd3773b0df76e21f97907c4038801f07e38adda6b1883528b74892ad6b3",
    "txn-source-matches.json": "55fed9f168368e7d7a4fd24844c9daa0f7f09a58303bb13a16fcc77c7b285a22",
}
QUARTERS = {"first": 1, "second": 2, "third": 3, "fourth": 4}
X = "{http://www.xbrl.org/2003/instance}"
SHA = re.compile(r"[0-9a-f]{64}")
ORDINAL = r"(first|second|third|fourth)"
MONEY = r"\$\s*(\d+(?:\.\d+)?|\.\d+)"


def hashed(data):
    return hashlib.sha256(data).hexdigest()


def parsed(text):
    return json.loads(text, parse_float=Decimal)


def cents(dollars):
    value = Decimal(dollars) * 100
    check(value.is_finite() and value == value.to_integral_value(), "Expected whole USD cents per share")
    return int(value)


def filename(accession):
    check(re.fullmatch(r"\d{10}-\d{2}-\d{6}", accession), "Invalid EDGAR accession")
    return ROOT + accession.replace("-", "") + "/"


def pinned(path, expected):
    raw = private_bytes(path)
    check(hashed(raw) == expected, "Private manifest changed: " + path.name)
    return parsed(raw)


def document(folder, url, expected, compressed_path, clock):
    record = parsed(private_bytes(folder))
    check(SHA.fullmatch(expected) and record["url"] == url and record["sha256"] == expected,
          "Source identity changed")
    captured = record.get("retrievedAt", record.get("asOf", record.get("receivedAt")))
    check(utc(captured) <= clock, "Capture follows replay clock")
    with gzip.GzipFile(fileobj=io.BytesIO(private_bytes(compressed_path))) as stream:
        raw = stream.read(5_000_001)
    check(0 < len(raw) <= 5_000_000 and hashed(raw) == expected, "Original bytes differ")
    return raw, captured


def fresh_source(store, name, url, suffix, clock):
    path = store / (name + ".json")
    ref = parsed(private_bytes(path))
    check(SHA.fullmatch(ref["sha256"]), "Invalid source hash")
    raw, captured = document(path, url, ref["sha256"], store / (ref["sha256"] + suffix), clock)
    return raw, captured, ref["sha256"]


def capture(store, name, url, suffix):
    path = store / (name + ".json")
    if not path.exists():
        request = Request(url, headers={"User-Agent": "The Daily Consensus public editorial research https://thedailyconsensus.com"})
        with urlopen(request, timeout=15) as response:
            check(response.status == 200 and response.url == url, "Unexpected SEC source response")
            raw = response.read(5_000_001)
            check(0 < len(raw) <= 5_000_000, "Invalid original size")
            received = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
            digest = hashed(raw)
            meta = {"url": url, "receivedAt": received, "serverDate": response.headers.get("Date"), "sha256": digest}
        with tempfile.NamedTemporaryFile(dir=store) as temp:
            temp.write(gzip.compress(raw, mtime=0))
            temp.flush()
            os.fsync(temp.fileno())
            try:
                os.link(temp.name, store / (digest + suffix))
            except FileExistsError:
                pass
        try:
            seal(path, meta)
        except FileExistsError:
            pass
    return fresh_source(store, name, url, suffix, datetime.now(timezone.utc))


def instance_url(index):
    links = re.findall(rb'href="([^"]+_htm\.xml)"', index, re.I)
    check(len(links) == 1, "Expected one statutory instance in the original index")
    url = "https://www.sec.gov" + links[0].decode()
    check(url.startswith(filename(LATEST)) and re.fullmatch(r"[\w.-]+_htm\.xml", url[len(filename(LATEST)):]),
          "Invalid original statutory instance URL")
    return url


def capture_missing(store):
    private_dir(store)
    capture(store, "sec-eps", FACTS, ".json.gz")
    capture(store, "submissions", CATALOG, ".json.gz")
    raw, _, _ = capture(store, "q3-index", INDEX, ".gz")
    capture(store, "q3-xbrl", instance_url(raw), ".gz")


def native_exhibit(archive, row, clock):
    accession = row["accessionNumber"]
    base = filename(accession)
    check(row["ticker"] == "TXN" and row["cik"] == "0000097476" and row["form"] == "8-K"
          and "2.02" in row["items"].split(","), "Unexpected issuer or filing")
    texts = {}
    clocks = []
    for kind in ("index", "original"):
        url, sha = row[kind]
        if kind == "index":
            check(url == base + accession + "-index.htm", "Wrong original filing index")
        else:
            check(url.startswith(base) and re.fullmatch(r"[\w.-]+\.html?", url[len(base):]), "Wrong exhibit path")
        raw, captured = document(archive / "receipts" / (hashed(url.encode()) + ".json"),
                                 url, sha, archive / "objects" / (sha + ".gz"), clock)
        check(utc(captured) >= utc(row["acceptanceDateTime"]), "Capture precedes SEC acceptance")
        texts[kind] = raw.decode()
        clocks.append(utc(captured))
    link = row["original"][0].rsplit("/", 1)[-1]
    exhibit_rows = [t for t in re.findall(r"<tr\b[^>]*>.*?</tr>", texts["index"], re.I | re.S)
                    if re.search(r">\s*EX-99(?:\.0?1|\.)?\s*<", t, re.I)]
    check(len(exhibit_rows) == 1 and re.search(r'(?i)href="[^"]*/?' + re.escape(link) + '"', exhibit_rows[0]),
          "Issuer exhibit is not linked by the original index")
    plain = " ".join(html.unescape(re.sub(r"<[^>]*>", " ", texts["original"])).split())
    return plain, max(clocks)


def issuer_bridge(lead):
    """Only an expressly quantified, signed item absent from the original forecast."""
    matches = re.findall(r"\bearnings per share include(?:s|d)?\s+([^.!?]{1,230}?\b(?:original|prior) guidance)", lead, re.I)
    if len(matches) != 1:
        return None
    body = matches[0].lower()
    if not re.search(r"\bnot\b", body):
        return None
    amounts = re.findall(r"\b(\d+)[- ]cents?\b", body)
    benefit = bool(re.search(r"\bbenefits?\b", body))
    cost = bool(re.search(r"\b(?:reductions?|costs?|expenses?)\b", body))
    if len(amounts) != 1 or benefit == cost:
        return None
    return int(amounts[0]) * (1 if benefit else -1)


def issuer_values(text, year, quarter):
    # The earnings release puts the quarter first and the year-to-date/annual column after it.
    aliases = (rf"\b{list(QUARTERS)[quarter - 1]}[ -]quarter (?:{year}|{year % 100:02d})\b",
               rf"\b{quarter}Q{year % 100:02d}\b", rf"\bQ{quarter} {year}\b")
    check(any(re.search(r"(?:TI|Texas Instruments) reports " + a, text[:1800], re.I) for a in aliases),
          "The original does not name the expected reporting quarter")
    body = text.split("Consolidated Statements of Income", 1)
    check(len(body) == 2, "Missing consolidated income statement")
    statement = body[1][:2200]
    month = 3 * quarter
    day = calendar.monthrange(year, month)[1]
    first_date = re.search(r"\b(" + "|".join(calendar.month_name[1:]) + r") (\d{1,2}),", statement[:300])
    check(first_date and first_date[1] == calendar.month_name[month] and int(first_date[2]) == day
          and "For Three Months Ended" in statement[:250] and str(year) in statement[:300], "Wrong quarterly column")
    eps = re.search(r"\bDiluted earnings per common share\s+" + MONEY, statement, re.I)
    revenue = re.search(r"\bRevenue\s+\$\s*([\d,]+)\s", statement)
    check(eps and revenue, "Missing issuer GAAP EPS or consolidated revenue")

    range_match = re.findall(ORDINAL + r"[- ]quarter outlook is for revenue in the range of\s+\$\s*"
                             r"([\d.]+) (billion|million) to\s+\$\s*([\d.]+) (billion|million),? and earnings per share between "
                             r"(?:\$\s*(\d+(?:\.\d+)?) and \$\s*(\d+(?:\.\d+)?)|(\d+) and (\d+) cents)(?=[,.\s”\"])",
                             text, re.I)
    check(len(range_match) == 1, "Missing unique paired next-quarter outlook")
    ordinal, revenue_low, unit_low, revenue_high, unit_high, lo, hi, cent_lo, cent_hi = range_match[0]
    check(QUARTERS[ordinal.lower()] == quarter % 4 + 1, "Outlook names another fiscal quarter")
    shares = (cents(lo), cents(hi)) if lo else (int(cent_lo), int(cent_hi))
    millions = tuple(Decimal(n) * (1000 if unit.lower() == "billion" else 1)
                     for n, unit in [(revenue_low, unit_low), (revenue_high, unit_high)])
    check(0 <= shares[0] < shares[1] and 0 < millions[0] < millions[1]
          and all(n == int(n) for n in millions), "Invalid management range or unit")
    return {"actualEpsCents": cents(eps[1]), "actualRevenueMillions": int(revenue[1].replace(",", "")),
            "issuerUnplannedCents": issuer_bridge(text[:1800]), "nextEpsRangeCents": list(shares),
            "nextRevenueRangeMillions": list(map(int, millions))}


def original_quarter_fact(items, filed, year, quarter, start, end):
    matches = {cents(f["val"]) for f in items if f["accn"] == filed["accessionNumber"]
               and f.get("form") == filed["form"] and f.get("filed") == filed["filingDate"]
               and f.get("fy") == year and f.get("fp") == ("FY" if quarter == 4 else "Q" + str(quarter))
               and f.get("start") == start and f.get("end") == end}
    if len(matches) > 1:
        raise ValueError("Conflicting original quarterly GAAP facts")
    return next(iter(matches), None)


def current_native_eps(raw, start, end):
    check(not re.search(br"<!\s*(DOCTYPE|ENTITY)", raw, re.I), "Invalid XBRL markup")
    ns = {}
    for _, (prefix, uri) in ET.iterparse(io.BytesIO(raw), events=["start-ns"]):
        check(prefix not in ns or ns[prefix] == uri, "Conflicting namespace binding")
        ns[prefix] = uri
    def qname(text):
        prefix, _, name = (text or "").rpartition(":")
        return ns.get(prefix), name

    root = ET.fromstring(raw)
    check(root.tag == X + "xbrl", "Invalid instance root")
    contexts = set()
    covers = set()
    for c in root.findall(X + "context"):
        cik = c.find(X + "entity/" + X + "identifier")
        if cik is None or cik.text != "0000097476" or cik.get("scheme") != "http://www.sec.gov/CIK":
            continue
        if c.find(".//" + X + "segment") is not None or c.find(".//" + X + "scenario") is not None:
            continue
        period = c.find(X + "period")
        if period is not None and period.findtext(X + "endDate") == end:
            covers.add(c.get("id"))
            if period.findtext(X + "startDate") == start:
                contexts.add(c.get("id"))
    units = set()
    for unit in root.findall(X + "unit"):
        nums = unit.findall(X + "divide/" + X + "unitNumerator/" + X + "measure")
        dens = unit.findall(X + "divide/" + X + "unitDenominator/" + X + "measure")
        if (len(nums) == len(dens) == 1 and
                qname(nums[0].text) == ("http://www.xbrl.org/2003/iso4217", "USD") and
                qname(dens[0].text) == (X[1:-1], "shares")):
            units.add(unit.get("id"))
    values = {cents(f.text) for f in root if isinstance(f.tag, str)
              and re.fullmatch(r"\{https?://fasb\.org/us-gaap/\d{4}\}EarningsPerShareDiluted", f.tag)
              and f.get("contextRef") in contexts and f.get("unitRef") in units}
    cover = {"DocumentType": "10-Q", "DocumentPeriodEndDate": end, "EntityCentralIndexKey": "0000097476"}
    for field, expected in cover.items():
        observed = {f.text for f in root if re.fullmatch(r"\{https?://xbrl\.sec\.gov/dei/\d{4}\}" + field, f.tag)
                    and f.get("contextRef") in covers}
        check(observed == {expected}, "Wrong native statutory cover")
    check(len(values) == 1, "Missing unique native consolidated diluted EPS")
    return values.pop()


def run(archive, store, clock):
    private_dir(store)
    f = {k: pinned(archive / k, v) for k, v in PINS.items()}
    exhibits = {r["accessionNumber"]: r for r in f["txn-official-exhibits.json"] if r.get("original")}
    filings = {r["accessionNumber"]: r for r in f["txn-filings.json"]["TXN"]}
    prior_pairs = f["txn-source-matches.json"]["pairs"]
    raw, concept_at, facts_sha = fresh_source(store, "sec-eps", FACTS, ".json.gz", clock)
    concept = parsed(raw)
    check(concept["cik"] == 97476 and concept["tag"] == "EarningsPerShareDiluted"
          and concept["taxonomy"] == "us-gaap" and set(concept["units"]) == {"USD/shares"}, "Wrong statutory fact or unit")
    items = concept["units"]["USD/shares"]
    sources = {}
    checked = {}
    rows = []
    for pair in prior_pairs:
        year, quarter = pair["fiscalYear"], pair["fiscalQuarter"]
        prior_year, prior_quarter = (year - 1, 4) if quarter == 1 else (year, quarter - 1)
        for a, y, q, key in [(pair["prior"], prior_year, prior_quarter, "priorExhibitSha"),
                              (pair["actual"], year, quarter, "actualExhibitSha")]:
            check(exhibits[a]["original"][1] == pair[key], "Issuer original differs from prior source qualification")
            if a not in sources:
                text, at = native_exhibit(archive, exhibits[a], clock)
                sources[a] = issuer_values(text, y, q)
                checked[a] = at
        prior, actual = sources[pair["prior"]], sources[pair["actual"]]
        low, high, mid = [Decimal(x) for x in pair["rangeMillions"]]
        check(prior["nextRevenueRangeMillions"] == [low, high] and (low+high)/2 == mid
              and actual["actualRevenueMillions"] == Decimal(pair["actualMillions"]), "Revenue control changed")
        end = pair["periodEnd"]
        start = date(year, quarter * 3 - 2, 1).isoformat()
        statutory = filings[pair["filedAccn"]]
        check(statutory["form"] == ("10-K" if quarter == 4 else "10-Q") and statutory["reportDate"] == end,
              "Unexpected statutory report or fiscal period")
        eps = original_quarter_fact(items, statutory, year, quarter, start, end)
        check(eps is None or eps == actual["actualEpsCents"], "Statutory fact differs from the issuer release")
        rows.append({"year": year, "quarter": quarter, "periodEnd": end, "priorAccession": pair["prior"],
                     "resultsAccession": pair["actual"], "statutoryAccession": pair["filedAccn"],
                     "statutoryAcceptedAt": statutory["acceptanceDateTime"], "statutoryFilingDate": statutory["filingDate"],
                     "statutoryQuarterlyEpsConfirmed": eps is not None, "priorEpsRangeCents": prior["nextEpsRangeCents"],
                     "priorRevenueRangeMillions": prior["nextRevenueRangeMillions"], **actual})
    last = rows[-1]
    index, index_at, index_sha = fresh_source(store, "q3-index", INDEX, ".gz", clock)
    check(last["statutoryAccession"] == LATEST, "Unexpected last historic quarter")
    instance, instance_at, instance_sha = fresh_source(store, "q3-xbrl", instance_url(index), ".gz", clock)
    check(current_native_eps(instance, "2026-07-01", last["periodEnd"]) == last["actualEpsCents"],
          "Original statutory instance differs from both published values")
    check(min(utc(index_at),utc(instance_at)) >= utc(last["statutoryAcceptedAt"]), "Statutory capture predates filing")
    complete = [r for r in rows if r["statutoryQuarterlyEpsConfirmed"]]
    basis = [r for r in complete if r["issuerUnplannedCents"] is not None]
    source_complete = max(utc(instance_at), utc(index_at), utc(concept_at), *checked.values())
    result = {"method": METHOD, "pricesOpened": False, "privateSourceAuditAt": source_complete.isoformat(),
              "rawFactSha256": facts_sha, "nativeInstanceSha256": instance_sha, "indexSha256": index_sha,
              "sourceFilings": len(f["txn-official-exhibits.json"]), "originalEarningsExhibits": len(exhibits),
              "sameQuarterRevenuePairs": len(rows), "directStatutoryEpsPairs": len(complete),
              "directStatutoryAndDisclosedBridge": len(basis),
              "missingStatutoryByQuarter": dict(Counter(str(r["quarter"]) for r in rows if not r["statutoryQuarterlyEpsConfirmed"])),
              "quarterRows": rows, "latest": last}
    return result


def position(value, bounds):
    low, high = bounds
    if value < low:
        return "below"
    if value > high:
        return "above"
    return "within"


def range_counts(rows):
    counts = Counter()
    bridge_changes = 0
    for row in rows:
        if not row["statutoryQuarterlyEpsConfirmed"]:
            continue
        earnings = position(row["actualEpsCents"], row["priorEpsRangeCents"])
        sales = position(row["actualRevenueMillions"], row["priorRevenueRangeMillions"])
        counts[sales + " revenue, " + earnings + " EPS"] += 1
        bridge = row["issuerUnplannedCents"]
        if bridge is not None and earnings != position(row["actualEpsCents"] - bridge, row["priorEpsRangeCents"]):
            bridge_changes += 1
    return dict(sorted(counts.items())), bridge_changes


def historical_target_overlap(archive, rows):
    """Consult the earlier sealed source-only target list. Do not open its price or outcome data."""
    native = pinned(archive / "qqq-source-candidates.json",
                    "45e4ebec6487e50583a5bd9c9889cc4ebf0e984c784cba22870fe80b45d95f62")
    prior = {(f["prior"], f["actual"], f["filed"]) for sample in native
             for f in sample["filings"] if f["ticker"] == "TXN"}
    eligible = [r for r in rows if r["statutoryQuarterlyEpsConfirmed"]]
    shared = [r for r in eligible
              if (r["priorAccession"], r["resultsAccession"], r["statutoryAccession"]) in prior]
    return {"statutoryDatesInEarlierStudy": len(shared), "untouchedStatutoryDates": len(eligible)-len(shared),
            "bridgeDatesInEarlierStudy": sum(r["issuerUnplannedCents"] is not None for r in shared)}


def witness(store, report, clock, allow_write):
    """Seal only an actual pre-period-end observation. Historical private data never backdates it."""
    raw, received, catalog_sha = fresh_source(store, "submissions", CATALOG, ".json.gz", clock)
    catalog = parsed(raw)
    recent = catalog["filings"]["recent"]
    check(catalog["cik"] == "0000097476", "Unexpected issuer")
    keys = ("form", "items", "filingDate", "reportDate", "acceptanceDateTime")
    check(all(len(recent[k]) == len(recent["accessionNumber"]) for k in keys), "Incomplete SEC catalogue")
    latest = report["latest"]
    verified = {}
    for i, acc in enumerate(recent["accessionNumber"]):
        form = recent["form"][i]
        if form in ("8-K", "8-K/A") and "2.02" in recent["items"][i].split(","):
            if recent["reportDate"][i] >= latest["periodEnd"] and recent["filingDate"][i] >= "2026-10-21":
                check(form == "8-K" and acc == latest["resultsAccession"], "A newer or amended results filing needs review")
        if acc in (latest["resultsAccession"], latest["statutoryAccession"]):
            check(acc not in verified, "Duplicate catalogue accession")
            verified[acc] = {k: recent[k][i] for k in keys}
    check(len(verified) == 2 and verified[latest["statutoryAccession"]]["reportDate"] == latest["periodEnd"],
          "Catalogue does not corroborate the source pair")
    base = {"method": METHOD, "symbol": "TXN", "targetYear": 2026, "targetQuarter": 4, "targetEnd": "2026-12-31",
            "observation": "Management range recorded before the quarter ended; no realized EPS, ETF label or consensus estimate.",
            "sourceQualificationSha256": hashed(private_bytes(store / "source-qualification.json")),
            "officialResultsAccession": latest["resultsAccession"], "catalogSha256": catalog_sha,
            "sourceLastCheckedAt": max(utc(report["privateSourceAuditAt"]), utc(received)).isoformat(),
            "epsRangeCents": latest["nextEpsRangeCents"], "revenueRangeMillions": latest["nextRevenueRangeMillions"],
            "previousQuarterEpsCents": latest["actualEpsCents"], "previousQuarterRevenueMillions": latest["actualRevenueMillions"],
            "afterRelease": "Require first original earnings exhibit and same-quarter direct GAAP diluted USD/share from the original statutory filing. Separate a signed item outside guidance only when explicitly quantified. Annual less nine-month EPS and an unreported bridge are ineligible."}
    path = store / "forward-2026-Q4.json"
    deadline = utc("2026-12-31T00:00:00Z")
    if allow_write and not path.exists():
        check(clock < deadline, "The first witness must precede the target period end")
        try:
            seal(path, {**base, "witnessedAt": clock.isoformat()})
        except FileExistsError:
            pass
    saved = parsed(private_bytes(path))
    observed = utc(saved.pop("witnessedAt"))
    check(saved == base and utc(base["sourceLastCheckedAt"]) <= observed < deadline and observed <= clock,
          "Invalid prospective source witness")
    return observed.isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("capture", "qualify", "replay"))
    parser.add_argument("--archive", type=Path, default=SOURCE)
    parser.add_argument("--store", type=Path, default=STORE)
    args = parser.parse_args()
    if args.command == "capture":
        capture_missing(args.store)
    clock = datetime.now(timezone.utc)
    report = run(args.archive, args.store, clock)
    target = args.store / "source-qualification.json"
    if args.command != "replay" and not target.exists():
        try:
            seal(target, report)
        except FileExistsError:
            pass
    check(parsed(private_bytes(target)) == report, "Saved qualification differs")
    at = witness(args.store, report, clock, args.command != "replay")
    ranges, changes = range_counts(report["quarterRows"])
    summary = {k: v for k, v in report.items() if k not in {"quarterRows", "latest"}}
    overlap = historical_target_overlap(args.archive, report["quarterRows"])
    print(json.dumps({**summary, **overlap, "jointRanges": ranges, "classChangesAfterExplicitBridge": changes,
                      "forwardQ4WitnessedAt": at}, sort_keys=True))


if __name__ == "__main__":
    main()
