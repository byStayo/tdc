"""Independent offline verification of the five exploratory X comparisons."""
import csv
from datetime import date, datetime, timedelta
import gzip
import hashlib
import json
import math
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]
SOURCE = WEB / ".consensus/private-x-attention/v1"
PRICES = WEB / ".consensus/private-technical-momentum"
FUNDS = ("SPY", "QQQ", "IWM", "DIA", "TLT")


def pinned(name, expected):
    wire = (SOURCE / name).read_bytes()
    if hashlib.sha256(wire).hexdigest() != expected:
        raise ValueError("Changed first research receipt: " + name)
    return json.loads(wire)


def price_file(ticker, year, basis):
    edges = {2023: ("01-03", "12-29"), 2024: ("01-02", "12-31")}
    start, end = edges[year]
    return json.loads((PRICES / f"{ticker}-{year}-{year}-{start}-{year}-{end}-{basis}.json").read_bytes())


def check_close(a, b):
    if not math.isclose(a, b, rel_tol=0, abs_tol=3e-12):
        raise ValueError("Independent calculation differs from the original result")


def verify_features(selection):
    fund_days = {}
    with gzip.open(SOURCE / "daily_ticker_stats.csv.gz", "rt", newline="") as file:
        for row in csv.DictReader(file):
            if row["ticker"] in FUNDS and "2024-01-01" <= row["date"] <= "2024-10-28":
                fund_days.setdefault(date.fromisoformat(row["date"]), {})[row["ticker"]] = (
                    int(row["tweets"]), int(row["unique_authors"]))
    # Native bar session clocks independently reproduce the original training population.
    bars = price_file("SPY", 2023, "raw")["sessions"][-21:] + price_file("SPY", 2024, "raw")["sessions"]
    full = [datetime.fromisoformat(b["closeAt"]) - datetime.fromisoformat(b["openAt"]) == timedelta(minutes=390)
            for b in bars]
    rows = {}
    for index, bar in enumerate(bars):
        target = date.fromisoformat(bar["session"])
        if target < date(2024, 1, 1) or target > date(2024, 10, 29) or not all(full[index-21:index+1]):
            continue
        days = [target - timedelta(days=1 + 7 * i) for i in range(5)]
        if days[-1] < date(2024, 1, 1) or days[-1] < date(2024, 6, 3) <= days[0]:
            continue
        if any(f not in fund_days.get(d, {}) or fund_days[d][f][1] < 10 for f in FUNDS for d in days):
            continue
        def change(fund, column):
            shares = [fund_days[d][fund][column] / sum(fund_days[d][f][column] for f in FUNDS) for d in days]
            return math.log(shares[0] / math.prod(shares[1:])**0.25)
        rows[bar["session"]] = [[change(f, 0), change(f, 1)] for f in FUNDS]
    if list(rows) != [p["target"] for p in selection["points"]]:
        raise ValueError("Independent source or calendar selection differs")
    for point in selection["points"]:
        for actual, expected in zip(rows[point["target"]], point["values"], strict=True):
            check_close(actual[0], expected[0])
            check_close(actual[1], expected[1])
    return rows


def probability(row, intercept, weights):
    z = intercept + sum(v*w for v, w in zip(row, weights, strict=True))
    return 1 / (1 + math.exp(-min(30, max(-30, z))))


def fit_scores(x, y):
    a, b = len(y)*3//5, len(y)*4//5
    mean = [sum(col)/a for col in zip(*x[:a], strict=True)]
    sd = [(sum((row[i]-m)**2 for row in x[:a])/a)**0.5 or 1. for i, m in enumerate(mean)]
    norm = [[(v-mean[i])/sd[i] for i, v in enumerate(row)] for row in x]
    candidates = []
    for penalty in (0.01, 0.1, 1., 10.):
        c, w = 0., [0.]*len(mean)
        for _ in range(600):
            delta = [probability(row, c, w)-label for row, label in zip(norm[:a], y[:a], strict=True)]
            c -= 0.08*sum(delta)/a
            w = [v-0.08*(sum(row[i]*d for row, d in zip(norm[:a], delta, strict=True))+penalty*v)/a
                 for i, v in enumerate(w)]
        def score(lo, hi):
            return sum((probability(norm[i], c, w)-y[i])**2 for i in range(lo, hi))/(hi-lo)
        candidates.append((score(a, b), penalty, w, c))
    _, _, w, c = min(candidates, key=lambda t: (t[0], t[1]))
    error = sum((probability(norm[i], c, w)-y[i])**2 for i in range(b, len(y)))/(len(y)-b)
    return error, w[-1]


if __name__ == "__main__":
    selection = pinned("selection.json", "44e30fe4918776c3aa3099b6340f41c2dc44e39ef4afb86bcd244f7d6e8eb92c")
    result = pinned("research-result.json", "63f0cbf46e05afd922d70634d8adc931aee7bf6bb13d3d665683d2c1ef5462ec")
    rows = verify_features(selection)
    for i, ticker in enumerate(FUNDS):
        recorded = next(row for row in result["comparisons"] if row["symbol"] == ticker)
        signs = []
        for basis, sha in zip(("raw", "splits"), recorded["sourceHashes"], strict=True):
            receipt = price_file(ticker, 2024, basis)
            if receipt["sha256"] != sha:
                raise ValueError("Source comparison changed")
            signs.append([int(bar["close"] > bar["open"]) for bar in receipt["sessions"] if bar["session"] in rows])
        if signs[0] != signs[1] or len(signs[0]) != len(rows):
            raise ValueError("Source signs or session count disagree")
        labels = signs[0]
        x = [v[i] for v in rows.values()]
        full_error, weight = fit_scores(x, labels)
        control_error, _ = fit_scores([point[:1] for point in x], labels)
        check_close(full_error, recorded["candidateBrier"])
        check_close(control_error, recorded["mentionBrier"])
        check_close(weight, recorded["coefficient"])
        a, b = len(labels)*3//5, len(labels)*4//5
        rate = sum(labels[:a])/a
        check_close(sum((y-rate)**2 for y in labels[b:])/(len(labels)-b), recorded["frequencyBrier"])
        check_close(0.25, recorded["coinBrier"])
    print(json.dumps({"funds": len(FUNDS), "sessionsPerFund": len(rows), "scoreComparisons": len(FUNDS)*4,
                      "forecastPricePairs": len(FUNDS)*len(rows), "maxAbsoluteTolerance": 3e-12, "verified": True}))
