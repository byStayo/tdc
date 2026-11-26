# /// script
# dependencies = ["duckdb==1.4.4"]
# ///
"""Read the provider's documented daily downloads and primary issuer distributions."""
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from concurrent.futures import ThreadPoolExecutor

import duckdb
from issuer_corporate_actions import ISSUERS, SYMBOLS, issuer_cash

ORIGIN = "https://marketparquet.com"

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read(url, credential=None, *, exact=False, with_url=False):
    req = urllib.request.Request(url, headers={"User-Agent": "DailyConsensus/1.0 (issuer and ETF verification)"})
    if credential:
        # urllib does not forward unredirected headers to the signed object host.
        req.add_unredirected_header("Authorization", "Bearer " + credential)
    with urllib.request.urlopen(req, timeout=15) as response:
        final = response.geturl()
        if (credential or exact) and final != url:
            raise ValueError("Authenticated MarketParquet endpoint redirected")
        data = response.read(4_000_001)
    if len(data) > 4_000_000:
        raise ValueError("Source payload exceeds size limit")
    return (data, final) if with_url else data


def issuer_actions(symbol):
    raw, final = read(ISSUERS[symbol], with_url=True)
    captured = now()
    issuer = issuer_cash(symbol, raw)
    actions = b"".join(action["session"].encode("ascii") + struct.pack(">d", action["amount"]) for action in issuer["cash"])
    return {**issuer, "capturedAt": captured, "responseUrl": final, "actionsSha256": hashlib.sha256(actions).hexdigest()}


def fetch_session(day, credential):
    try:
        if credential:
            endpoint = f"{ORIGIN}/api/v1/download/etf_daily/{day}"
            authorized = read(endpoint, credential)
            authorized_at = now()
            info = json.loads(authorized)
            target = urlsplit(info["download_url"])
            if (info["asset_type"], info["date"], target.scheme) != ("etf_daily", day, "https") or (
                not target.hostname or not target.hostname.endswith(".r2.cloudflarestorage.com")
                or target.username or target.password
            ):
                raise ValueError("Unexpected MarketParquet download authorization")
            data = read(info["download_url"], exact=True)
            retrieved_at = now()
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
    file_hash = hashlib.sha256(data).hexdigest()
    result = {"session": day, "sha256": file_hash,
              "bars": {s: {"open": o, "close": c} for s, _, _, o, _, _, c, _ in rows}}
    if credential:
        # Bind the five extracted price pairs to the authorized download without retaining its signed URL.
        prices = b"".join(struct.pack(">dd", row[3], row[6]) for row in rows)
        result["download"] = {"source": endpoint, "objectHost": target.hostname, "authorizedAt": authorized_at,
                              "retrievedAt": retrieved_at, "size": len(data), "sha256": file_hash,
                              "authorizationSha256": hashlib.sha256(authorized).hexdigest(),
                              "pricesSha256": hashlib.sha256(prices).hexdigest(), "session": day}
    return result


def main():
    mode, *days = sys.argv[1:]
    if mode not in ("sample", "licensed") or any(dt.date.fromisoformat(day).isoformat() != day for day in days):
        raise ValueError("Invalid source request")
    credential = os.environ.get("MARKETPARQUET_API_KEY") if mode == "licensed" else None
    if mode == "licensed" and not credential:
        raise ValueError("Licensed MarketParquet access requires MARKETPARQUET_API_KEY")
    if credential:
        endpoint = f"{ORIGIN}/api/v1/assets"
        raw = read(endpoint, credential)
        if len(raw) > 128_000 or credential.encode() in raw:
            raise ValueError("Entitlement response is unsuitable for retention")
        entitlement = {"source": endpoint, "capturedAt": now(), "document": raw.decode("utf-8"),
                       "sha256": hashlib.sha256(raw).hexdigest()}
        access = json.loads(raw)
        if access.get("plan") != "full" or not any(
            asset["asset_type"] == "etf_daily" and asset["access"] == "full"
            for asset in access.get("assets", [])
        ):
            raise ValueError("MarketParquet key does not show a paid ETF archive entitlement")
    with ThreadPoolExecutor(max_workers=3) as executor:
        issuer_futures = [executor.submit(issuer_actions, symbol) for symbol in SYMBOLS]
        sessions = list(executor.map(lambda day: fetch_session(day, credential), days))
        distributions = [future.result() for future in issuer_futures]
    output = {"sessions": sessions, "distributions": distributions}
    if credential:
        output["licensedCapture"] = {"entitlement": entitlement,
                                     "downloads": [row.pop("download") for row in sessions if "download" in row]}
    print(json.dumps(output, allow_nan=False))


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
