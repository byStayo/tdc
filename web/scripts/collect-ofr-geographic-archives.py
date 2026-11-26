"""Retrieve bounded original Treasury captures from the two registered public archive indexes.

Run once with the owner-private directory containing the pinned native CDX results.
No market-price inputs or accounts are used.
"""
import argparse
import base64
from collections import Counter
import concurrent.futures
import datetime as dt
import email.utils
import gzip
import hashlib
import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

NATIVE = "https://www.financialresearch.gov/financial-stress-index/data/fsi."
CDX = "https://web.archive.org/cdx/search/cdx?"
INDEXES = {
    "csv": "84f803fc169723ce2813f23c1c11515fa8b1f6cfcca71b0c0c693e0f903ee6dc",
    "json": "484a3a516adad3cef810e043ef800411d850e7cc724be7b6390363b409a1404b",
}
MAX_RESPONSE = 4_000_000


def write_exclusive(file, raw):
    if file.exists():
        if file.is_symlink() or file.stat().st_mode & 0o077 or file.read_bytes() != raw:
            raise ValueError("Private archive capture differs from its first recording")
        return
    with os.fdopen(os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as out:
        out.write(raw)


def download(url):
    request = Request(url, headers={"User-Agent": "The Daily Consensus dated Treasury research", "Accept-Encoding": "identity"})
    with urlopen(request, timeout=14) as response:
        body = response.read(MAX_RESPONSE + 1)
        if len(body) > MAX_RESPONSE or response.status != 200:
            raise ValueError("Public archive returned an unexpected response")
        return body, response.geturl(), response.headers


def indexed(root, kind, allow_network=False):
    native = NATIVE + kind
    url = CDX + urlencode({"url": native, "from": "2018", "to": "20211231", "output": "json",
                            "filter": "statuscode:200", "fl": "timestamp,original,statuscode,digest"})
    file = root / ("ia-" + kind + "-pre2022-api.json")
    if not file.exists() and allow_network:
        raw, landed, _ = download(url)
        if landed != url:
            raise ValueError("Archive index redirected")
        write_exclusive(file, json.dumps({"url": url, "rows": json.loads(raw)}).encode())
    contents = file.read_bytes()
    if hashlib.sha256(contents).hexdigest() != INDEXES[kind]:
        raise ValueError("Archive index differs from its preregistered inventory")
    index = json.loads(contents)
    if index["url"] != url or index["rows"][0] != ["timestamp", "original", "statuscode", "digest"]:
        raise ValueError("Unrecognized CDX query")
    rows = index["rows"][1:]
    if any(origin != native or status != "200" or not "20180101" <= stamp[:8] <= "20211231"
           for stamp, origin, status, _ in rows):
        raise ValueError("Archive index contains an out-of-scope resource")
    return rows


def delivery_path(root, stamp, kind, retry=False):
    suffix = "-retry" if retry else ""
    return root / ("delivery-" + stamp + "-" + kind + suffix + ".json")


def receipt(root, stamp, kind):
    first = json.loads(delivery_path(root, stamp, kind).read_bytes())
    retry = delivery_path(root, stamp, kind, True)
    if first["status"] in ("URLError", "TimeoutError") and retry.exists():
        return json.loads(retry.read_bytes())
    return first


def fetch(root, row):
    stamp, origin, _, checksum = row
    at = dt.datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=dt.timezone.utc)
    url = "https://web.archive.org/web/" + stamp + "id_/" + origin
    kind = origin.rsplit(".", 1)[-1]
    out = delivery_path(root, stamp, kind)
    if out.exists():
        prior = receipt(root, stamp, kind)
        if prior["status"] not in ("URLError", "TimeoutError"):
            return prior
        out = delivery_path(root, stamp, kind, True)
        if out.exists():
            return prior
    result = {"timestamp": stamp, "cdxSha1": checksum, "source": origin, "url": url}
    try:
        body, landed, headers = download(url)
        clock = email.utils.parsedate_to_datetime(headers["Memento-Datetime"])
        wire_sha1 = base64.b32encode(hashlib.sha1(body).digest()).decode()
        if landed != url or clock != at or wire_sha1 != checksum:
            result.update(status="memento-or-body-mismatch")
        else:
            result.update(status="verified", sha256=hashlib.sha256(body).hexdigest(), available=at.isoformat())
            write_exclusive(root / (result["sha256"] + ".gz"), gzip.compress(body, compresslevel=4, mtime=0))
    except HTTPError as error:
        result.update(status="HTTP-" + str(error.code))
    except (URLError, TimeoutError, ValueError, TypeError, KeyError) as error:
        result.update(status=type(error).__name__)
    write_exclusive(out, (json.dumps(result, sort_keys=True) + "\n").encode())
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    root = args.directory.resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.stat().st_mode & 0o077:
        raise ValueError("The research capture must remain owner-only")
    rows = [r for k in INDEXES for r in indexed(root, k, allow_network=True)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda row: fetch(root, row), rows))
    print(json.dumps({"indexed": len(rows), "status": dict(Counter(r["status"] for r in results))}))


if __name__ == "__main__":
    main()
