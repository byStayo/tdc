"""Save one validated official issuer response atomically for the private after-close check."""

import datetime as dt
import hashlib
import importlib
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from issuer_corporate_actions import ISSUERS, issuer_cash


def capture_issuer(symbol, directory):
    source = ISSUERS[symbol]
    target = directory / symbol
    if target.is_dir():
        return
    capture = importlib.import_module("collect-firstrate-inputs")
    with TemporaryDirectory(dir=directory, prefix=symbol + "-") as stage:
        with urlopen(Request(source, headers={"User-Agent": "DailyConsensusResearch/1.0"}), timeout=14) as response:
            final = response.geturl()
            if final != source:
                issuer_id = {"IWM": "239710", "TLT": "239454"}.get(symbol)
                parsed = urlsplit(final)
                if not issuer_id or (parsed.scheme, parsed.netloc) != ("https", "www.ishares.com") or not parsed.path.startswith(f"/us/products/{issuer_id}/"):
                    raise ValueError("Official issuer response changed fund or host")
            raw = response.read(capture.ISSUER_SIZE + 1)
            if not 0 < len(raw) <= capture.ISSUER_SIZE:
                raise ValueError("Invalid official issuer response size")
            stamp = dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        issuer_cash(symbol, raw)
        meta = {"url": source, "responseUrl": final, "sha256": hashlib.sha256(raw).hexdigest(), "capturedAt": stamp}
        capture.write_private(Path(stage) / f"issuer-{symbol}.bin", raw)
        capture.write_private(Path(stage) / f"issuer-{symbol}.json", json.dumps(meta).encode())

        # Both the original body and its dated URL/hash receipt become visible together.
        try:
            Path(stage).rename(target)
        except OSError:
            if not target.is_dir():
                raise


if __name__ == "__main__":
    ticker, folder = sys.argv[1:]
    capture_issuer(ticker, Path(folder))
