import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import duckdb


scripts = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location("marketparquet_capture", scripts / "collect-marketparquet.py")
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)


class CaptureTests(unittest.TestCase):
    def test_paid_transport_binds_real_parquet_fields_and_discards_credentials(self):
        day = "2026-11-17"
        token = "synthetic-secret"
        object_url = "https://example.r2.cloudflarestorage.com/fixture?sig=synthetic-signature"
        grant = capture.ORIGIN + "/api/v1/assets"
        download = capture.ORIGIN + "/api/v1/download/etf_daily/" + day
        prices = {symbol: 100.0 + i for i, symbol in enumerate(capture.SYMBOLS)}
        with TemporaryDirectory() as directory, duckdb.connect() as db:
            path = Path(directory) / "test.parquet"
            db.execute("create table etf(symbol varchar, date date, asset_type varchar, open double, high double, low double, close double, volume integer)")
            db.executemany("insert into etf values (?, ?::date, 'etf', ?, ?, ?, ?, 500)",
                           [(symbol, day, o, o + 2, o - 1, o + 1) for symbol, o in prices.items()])
            db.execute("copy etf to ? (format parquet)", [str(path)])
            raw = path.read_bytes()
        responses = {
            grant: b'{"plan":"full","assets":[{"asset_type":"etf_daily","access":"full"}]}',
            download: json.dumps({"asset_type": "etf_daily", "date": day, "download_url": object_url,
                                  "file_size_bytes": len(raw)}).encode(),
            object_url: raw,
        }
        calls = []

        def local(request, timeout):
            url = request.full_url
            calls.append(url)
            self.assertEqual(request.get_header("Authorization"), "Bearer " + token if url in (grant, download) else None)
            response = io.BytesIO(responses[url])
            response.geturl = lambda: url
            return response

        with patch.dict(os.environ, {"MARKETPARQUET_API_KEY": token}, clear=True), \
                patch.object(sys, "argv", ["capture", "licensed", day]), \
                patch.object(capture.urllib.request, "urlopen", local), \
                patch.object(capture, "issuer_actions", lambda s: {"symbol": s}):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                capture.main()
            text = output.getvalue()
            self.assertNotIn(token, text)
            self.assertNotIn("synthetic-signature", text)
            result = json.loads(text)
            proof = result["licensedCapture"]
            self.assertEqual(proof["entitlement"]["document"].encode(), responses[grant])
            self.assertEqual(calls, [grant, download, object_url])
            receipt = proof["downloads"][0]
            self.assertEqual(receipt["sha256"], hashlib.sha256(raw).hexdigest())
            encoded = b"".join(struct.pack(">dd", prices[s], prices[s] + 1) for s in sorted(prices))
            self.assertEqual(receipt["pricesSha256"], hashlib.sha256(encoded).hexdigest())
            self.assertEqual(result["sessions"][0]["bars"]["TLT"]["open"], prices["TLT"])
            calls.clear()
            responses[grant] = b'{"plan":"free","assets":[]}'
            with self.assertRaisesRegex(ValueError, "entitlement"):
                capture.main()
            self.assertEqual(calls, [grant])


if __name__ == "__main__":
    unittest.main()
