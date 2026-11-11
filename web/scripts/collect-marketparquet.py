# /// script
# dependencies = ["duckdb==1.4.4"]
# ///
"""Read the provider's documented daily downloads and primary issuer distributions."""
import datetime as dt
import hashlib
import html
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from concurrent.futures import ThreadPoolExecutor

import duckdb

SYMBOLS = ("SPY", "QQQ", "IWM", "DIA", "TLT")
ORIGIN = "https://marketparquet.com"
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


def read(url, credential=None):
    req = urllib.request.Request(url, headers={"User-Agent": "DailyConsensus/1.0 (issuer and ETF verification)"})
    if credential:
        # urllib does not forward unredirected headers to the signed object host.
        req.add_unredirected_header("Authorization", "Bearer " + credential)
    with urllib.request.urlopen(req, timeout=15) as response:
        data = response.read(4_000_001)
    if len(data) > 4_000_000:
        raise ValueError("Source payload exceeds size limit")
    return data


def compact_date(value):
    return dt.datetime.strptime(str(value), "%Y%m%d").date().isoformat()


def ishares_rows(payload):
    text = html.unescape(payload.decode())
    columns = {}
    for name in ("exDate", "totalDistribution"):
        marker = f'"{name}":{{"name":"{name}","fullName":"performance.distributions.table.{name}"'
        start = text.index(marker) + len(name) + 3
        column, _ = json.JSONDecoder().raw_decode(text[start:])
        columns[name] = column["value"]
    return [(compact_date(day), float(amount)) for day, amount in zip(
        columns["exDate"], columns["totalDistribution"], strict=True
    )]


def issuer_actions(symbol):
    url = ISSUERS[symbol]
    data = read(url)
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
    rows = [(day, amount) for day, amount in rows if day >= "2026-01-01"]
    if CHECKPOINTS[symbol] not in rows or len(dict(rows)) != len(rows) or any(
        not math.isfinite(amount) or amount <= 0 or dt.date.fromisoformat(day).isoformat() != day
        for day, amount in rows
    ):
        raise ValueError(f"{symbol} distribution history failed issuer reconciliation")
    return {"symbol": symbol, "source": url, "sha256": hashlib.sha256(data).hexdigest(),
            "cash": [{"session": day, "amount": amount} for day, amount in sorted(rows)]}


def fetch_session(day, credential):
    try:
        if credential:
            info = json.loads(read(f"{ORIGIN}/api/v1/download/etf_daily/{day}", credential))
            target = urlsplit(info["download_url"])
            if (info["asset_type"], info["date"], target.scheme) != ("etf_daily", day, "https") or (
                not target.hostname or not target.hostname.endswith(".r2.cloudflarestorage.com")
                or target.username or target.password
            ):
                raise ValueError("Unexpected MarketParquet download authorization")
            data = read(info["download_url"])
            if len(data) != info["file_size_bytes"]:
                raise ValueError("MarketParquet file differs from authorized size")
        else:
            data = read(f"{ORIGIN}/api/data/download/etf_daily/{day}.parquet")
    except urllib.error.HTTPError as error:
        if error.code in (401, 403, 404) and not credential:
            return {"session": day, "httpStatus": error.code}
        if error.code == 404 and credential:
            return {"session": day, "httpStatus": error.code}
        raise ValueError(f"MarketParquet returned HTTP {error.code} for {day}") from None
    if not data.startswith(b"PAR1") or not data.endswith(b"PAR1"):
        raise ValueError("Expected a MarketParquet daily Parquet file")
    with tempfile.TemporaryDirectory(prefix="consensus-etf-") as directory, duckdb.connect() as db:
        path = Path(directory) / "bars.parquet"
        path.write_bytes(data)
        rows = db.execute(
            """select symbol, date::varchar, asset_type, open, high, low, close, volume
                 from read_parquet(?) where symbol in ('SPY', 'QQQ', 'IWM', 'DIA', 'TLT')
                 order by symbol""", [str(path)]
        ).fetchall()
    if [row[0] for row in rows] != sorted(SYMBOLS) or any(
        date != day or kind.lower() != "etf" or
        not all(math.isfinite(value) and value > 0 for value in (opening, high, low, close, volume)) or
        not low <= min(opening, close) <= max(opening, close) <= high
        for _, date, kind, opening, high, low, close, volume in rows
    ):
        raise ValueError(f"Invalid or incomplete MarketParquet ETF bars for {day}")
    return {"session": day, "sha256": hashlib.sha256(data).hexdigest(),
            "bars": {s: {"open": o, "close": c} for s, _, _, o, _, _, c, _ in rows}}


def main():
    mode, *days = sys.argv[1:]
    if mode not in ("sample", "licensed") or any(dt.date.fromisoformat(day).isoformat() != day for day in days):
        raise ValueError("Invalid source request")
    credential = os.environ.get("MARKETPARQUET_API_KEY") if mode == "licensed" else None
    if mode == "licensed" and not credential:
        raise ValueError("Licensed MarketParquet access requires MARKETPARQUET_API_KEY")
    if credential:
        access = json.loads(read(f"{ORIGIN}/api/v1/assets", credential))
        if access.get("plan") != "full" or not any(
            asset["asset_type"] == "etf_daily" and asset["access"] == "full"
            for asset in access.get("assets", [])
        ):
            raise ValueError("MarketParquet key does not show a paid ETF archive entitlement")
    with ThreadPoolExecutor(max_workers=3) as executor:
        issuer_futures = [executor.submit(issuer_actions, symbol) for symbol in SYMBOLS]
        sessions = list(executor.map(lambda day: fetch_session(day, credential), days))
        distributions = [future.result() for future in issuer_futures]
    print(json.dumps({"sessions": sessions, "distributions": distributions}, allow_nan=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, duckdb.Error) as error:
        # Exceptions from downloads may contain short-lived signed URL credentials.
        if isinstance(error, urllib.error.HTTPError):
            print(f"Issuer request failed with HTTP {error.code}", file=sys.stderr)
        elif isinstance(error, (OSError, duckdb.Error)):
            print(f"MarketParquet collection failed ({type(error).__name__})", file=sys.stderr)
        else:
            print(f"MarketParquet collection failed ({type(error).__name__}): {error}", file=sys.stderr)
        sys.exit(1)
