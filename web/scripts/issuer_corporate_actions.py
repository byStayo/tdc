"""Parse the official distribution histories shared by the ETF price collectors."""

import datetime as dt
from hashlib import sha256
import html
import json
import math


SYMBOLS = ("SPY", "QQQ", "IWM", "DIA", "TLT")
STATE_STREET = (
    "https://www.ssga.com/bin/v1/ssmp/fund/dividend-distribution?"
    "country=us&language=en&role=intermediary&product=etfs&ticker="
)
ISSUERS = {
    "SPY": STATE_STREET + "SPY",
    "DIA": STATE_STREET + "DIA",
    "QQQ": "https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/46090E103/distribution?idType=cusip&productType=ETF",
    "IWM": "https://www.ishares.com/us/products/239710/ishare",
    "TLT": "https://www.ishares.com/us/products/239454/ishares-20-year-treasury-bond-etf?cid=synd",
}
CHECKPOINTS = {
    "SPY": ("2026-09-18", 1.888834),
    "DIA": ("2026-10-16", 0.114040),
    "QQQ": ("2026-09-21", 0.75143),
    "IWM": ("2026-09-15", 0.750436),
    "TLT": ("2026-11-02", 0.343177),
}


def ishares_rows(payload):
    text = html.unescape(payload.decode())
    columns = {}
    for name in ("exDate", "totalDistribution"):
        marker = f'"{name}":{{"name":"{name}","fullName":"performance.distributions.table.{name}"'
        start = text.index(marker) + len(name) + 3
        column, _ = json.JSONDecoder().raw_decode(text[start:])
        columns[name] = column["value"]
    return [(dt.datetime.strptime(str(day), "%Y%m%d").date().isoformat(), float(amount))
            for day, amount in zip(columns["exDate"], columns["totalDistribution"], strict=True)]


def issuer_cash(symbol, data, start="2026-01-01"):
    if symbol in ("SPY", "DIA"):
        rows = [
            (dt.datetime.strptime(row["exDate"], "%m/%d/%Y").date().isoformat(),
             sum(float(row[key]) for key in ("dividend", "shortTeamCapital", "longTeamCapital")
                 if row[key] not in ("-", "", None)))
            for row in json.loads(data)
        ]
    elif symbol == "QQQ":
        fund = json.loads(data)
        if (fund.get("cusip"), fund.get("currencyCode")) != ("46090E103", "USD"):
            raise ValueError("Unexpected Invesco fund identity")
        rows = [(row["exDate"], float(row["distributionAmountPerUnit"])) for row in fund["distributions"]]
    else:
        rows = ishares_rows(data)
    rows = [(day, amount) for day, amount in rows if day >= start]
    if CHECKPOINTS[symbol] not in rows or len(dict(rows)) != len(rows) or any(
        not math.isfinite(amount) or amount <= 0 or dt.date.fromisoformat(day).isoformat() != day
        for day, amount in rows
    ):
        raise ValueError(f"{symbol} distribution history failed issuer reconciliation")
    return {"symbol": symbol, "source": ISSUERS[symbol], "sha256": sha256(data).hexdigest(),
            "cash": [{"session": day, "amount": amount} for day, amount in sorted(rows)]}
