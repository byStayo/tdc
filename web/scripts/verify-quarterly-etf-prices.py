"""Independently replay the five ETF cash-adjusted windows from original CSV and JSONL."""

import csv
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, getcontext
from hashlib import sha256
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo

from issuer_corporate_actions import ISSUERS, SYMBOLS, issuer_cash

getcontext().prec = 48
if not __debug__:
    raise RuntimeError("The independent source checks require enabled assertions")
ROOT = Path(__file__).resolve().parents[1] / ".consensus"
STUDY = ROOT / "private-quarterly-price-qualification/2026-09"
NEW_YORK = ZoneInfo("America/New_York")
START, END = date(2026, 8, 31), date(2026, 10, 1)
LABOR_DAY = date(2026, 9, 7)
DAYS = [(START + timedelta(days=i)).isoformat() for i in range((END - START).days + 1)
        if (START + timedelta(days=i)).weekday() < 5 and START + timedelta(days=i) != LABOR_DAY]
BASIS_POINTS = Decimal(10000)


def owner_bytes(path):
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_mode & 0o077 or not 0 < info.st_size <= 4_000_000:
        raise ValueError("Invalid private source " + path.name)
    return path.read_bytes()


def source_json(path):
    return json.loads(owner_bytes(path))


def native_guest(symbol, basis, pin):
    raw = source_json(STUDY / f"{symbol}-{basis}.json")
    assert sha256(raw["csv"].encode()).hexdigest() == raw["sha256"] == pin
    url = urlsplit(raw["source"])
    query = parse_qs(url.query)
    assert url.scheme == "https" and url.hostname == "api.kibot.com" and query["symbol"] == [symbol]
    assert query["splitadjusted" if basis == "splits" else "unadjusted"] == ["1"]
    rows = {}
    for day, opening, high, low, closing, volume in csv.reader(raw["csv"].splitlines()):
        day = datetime.strptime(day, "%m/%d/%Y").date().isoformat()
        o, h, l, c = map(Decimal, (opening, high, low, closing))
        assert day not in rows and 0 < l <= min(o, c) <= max(o, c) <= h and int(volume) > 0
        rows[day] = o, c
    assert list(rows) == DAYS
    return rows


def hourly_edge(symbol, basis, edge):
    filename = f"{symbol}-{START}-{END}-{basis}-{edge}.json"
    src = source_json(ROOT / "private-market-history/firstrate-controls" / filename)
    url = urlsplit(src["source"])
    query = parse_qs(url.query)
    assert url.scheme == "https" and url.hostname == "getmarkethistory.com" and url.path.endswith("/" + symbol + "/1h")
    assert query["start"] == [str(START)] and query["end"] == [str(END)] and query["adjust"] == [basis]
    assert query["tz"] == ["Asia/Kolkata" if edge == "open" else "exchange"] and query["feed"] == ["consolidated"]
    assert src["status"] == 200 and sha256(src["text"].encode()).hexdigest() == src["sha256"]
    assert src["headers"]["x-bars-paid-remaining"] == "0" and src["headers"]["x-feed"] == "consolidated"
    lines = src["text"].splitlines()
    assert int(src["headers"]["x-row-count"]) == len(lines) and not src["headers"].get("x-next-cursor")
    values = {}
    edge_time = time(9, 30) if edge == "open" else time(15)
    for line in lines:
        bar = json.loads(line, parse_float=Decimal)
        instant = datetime.fromisoformat(bar["timestamp"].replace("Z", "+00:00")).astimezone(NEW_YORK)
        day = instant.date().isoformat()
        if instant.time() != edge_time or day not in DAYS:
            continue
        assert bar["symbol"] == symbol and bar["is_gap"] is False and bar["trade_count"] > 0 and bar["volume"] > 0
        assert day not in values and bar[edge] > 0
        values[day] = Decimal(bar[edge])
    assert set(values) == set(DAYS)
    return values


def official_cash(symbol, pin):
    folder = ROOT / "private-kibot/sources/2026-11-23/issuer-post-close" / symbol
    meta = source_json(folder / f"issuer-{symbol}.json")
    body = owner_bytes(folder / f"issuer-{symbol}.bin")
    assert meta["url"] == ISSUERS[symbol] and sha256(body).hexdigest() == meta["sha256"] == pin
    assert datetime.fromisoformat(meta["capturedAt"].replace("Z", "+00:00")) > datetime.combine(END, time(20), timezone.utc)
    cash = {r["session"]: Decimal(str(r["amount"])) for r in issuer_cash(symbol, body)["cash"] if r["session"] in DAYS}
    native = source_json(ROOT / f"private-market-history/firstrate-actions/{symbol}-{START}-{END}.json")["capture"]
    assert sha256(native["raw"].encode()).hexdigest() == native["sha256"]
    totals = {}
    for line in native["raw"].splitlines():
        event = json.loads(line, parse_float=Decimal)
        assert event["symbol"] == symbol and event["type"] in ("cash_dividends", "capital_gains_distributions")
        day = event["ex_date"]
        totals[day] = totals.get(day, Decimal(0)) + event["rate"]
    assert totals.keys() == cash.keys() and all(abs(totals[d] - cash[d]) <= Decimal("0.00001") for d in cash)
    return cash


def sign(value):
    return (value > 0) - (value < 0)


def window_sign(prices, window, cash):
    factor = Decimal(1)
    for previous, current in zip(window, window[1:]):
        if current in cash:
            prior_close = prices[previous][1]
            factor *= (prior_close - cash[current]) / prior_close
    return sign(prices[window[-1]][1] - prices[window[0]][0] * factor)


def verify(fund):
    symbol, pins = fund["symbol"], fund["sources"]
    raw = native_guest(symbol, "raw", pins["kibotRaw"])
    splits = native_guest(symbol, "splits", pins["kibotSplits"])
    reference = {}
    for basis in ("raw", "splits"):
        opens, closes = hourly_edge(symbol, basis, "open"), hourly_edge(symbol, basis, "close")
        reference[basis] = {d: (opens[d], closes[d]) for d in DAYS}
    cash = official_cash(symbol, pins["issuer"]["sha256"])
    independent = reference["raw"]
    excluded = {}
    for d in DAYS:
        o, c = raw[d]
        other_o, other_c = independent[d]
        conditions = [(raw[d] != splits[d], "Kibot split basis"),
                      (independent[d] != reference["splits"][d], "Market History split basis"),
                      (abs(o / other_o - 1) * BASIS_POINTS > 3, "open"),
                      (abs(c / other_c - 1) * BASIS_POINTS > 15, "close"),
                      (sign(c - o) != sign(other_c - other_o), "daily direction")]
        reasons = [label for failed, label in conditions if failed]
        if reasons:
            excluded[d] = reasons
    assert [{"day": d, "reasons": reasons} for d, reasons in excluded.items()] == fund["differences"]
    cash_basis, cash_checked = {}, {}
    for day, amount in cash.items():
        i = DAYS.index(day)
        preceding = DAYS[i - 1]
        cash_basis[day] = i > 0 and abs(raw[preceding][1] - independent[preceding][1]) < amount / 2
        cash_checked[day] = cash_basis[day] and preceding not in excluded and amount < raw[preceding][1]
    assert {r["session"]: r["verified"] for r in fund["cashChecks"]} == cash_checked
    expected, horizons = [], {}
    for horizon, length in (("weekly", 5), ("monthly", 21)):
        horizons[horizon] = {"crossingCash": 0, "cashChangedDirection": 0}
        for start in range(len(DAYS) - length + 1):
            window = DAYS[start:start + length]
            crosses = [d for d in window[1:] if d in cash]
            same = window_sign(raw, window, cash) == window_sign(independent, window, cash)
            if crosses:
                horizons[horizon]["crossingCash"] += 1
                if all(window_sign(prices, window, cash) != window_sign(prices, window, {})
                       for prices in (raw, independent)):
                    horizons[horizon]["cashChangedDirection"] += 1
            expected.append({"horizon": horizon, "from": window[0], "through": window[-1], "exDates": crosses,
                             "sameDirection": same, "cashBasisVerified": all(cash_basis[d] for d in crosses),
                             "qualified": same and not set(excluded).intersection(window) and all(cash_checked[d] for d in crosses)})
    assert expected == fund["holding"]
    public_periods = {}
    for name in ("weekly", "monthly"):
        rows = [row for row in expected if row["horizon"] == name]
        public_periods[name] = {"checked": len(rows), "passed": sum(row["qualified"] for row in rows),
                                "withDividend": horizons[name]["crossingCash"],
                                "changedByDividend": horizons[name]["cashChangedDirection"]}
    return {"symbol": symbol, "daily": {"checked": len(DAYS), "passed": len(DAYS) - len(excluded)},
            **public_periods, "dividends": {"checked": len(cash), "passed": sum(cash_checked.values())}}


if __name__ == "__main__":
    report = source_json(STUDY / "report.json")
    assert report["method"] == "quarterly-etf-price-qualification-v1" and [f["symbol"] for f in report["funds"]] == list(SYMBOLS)
    print(json.dumps([verify(fund) for fund in report["funds"]]))
