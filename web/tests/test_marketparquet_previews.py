import csv
from datetime import datetime, timezone
from decimal import Decimal
import gzip
import hashlib
import importlib.util
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


preview = load("qualify-marketparquet-previews")
economics = load("research-marketparquet-dividend")


class NativePreview(unittest.TestCase):
    session = "2025-11-28"
    path = "/preview/etf_daily/" + session

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Path(self.tmp.name)
        self.rows = [[self.session, symbol, "ETF", "100.00", "101.05", "99", "101", "10"] for symbol in preview.FUNDS]
        self.catalogue()
        self.native()

    def save(self, name, kind, url, data):
        data = data.encode()
        (self.store / f"{name}.{kind}.gz").write_bytes(gzip.compress(data, mtime=0))
        meta = {"source": url, "status": 200, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
                "receivedAt": datetime.now(timezone.utc).isoformat(), "date": None,
                "contentType": "text/html" if kind == "html" else "text/csv"}
        (self.store / f"{name}.{kind}.source.json").write_text(json.dumps(meta))
        for path in self.store.glob(f"{name}.{kind}.*"):
            path.chmod(0o600)

    def catalogue(self, featured=True):
        self.save("catalog-2025", "html", preview.BASE + "/browse/etf_daily?year=2025",
                  f'<button data-href="{self.path if featured else "/no-preview"}">view</button>')

    def native(self, html_rows=None, csv_rows=None, link=None):
        csv_text = StringIO()
        csv.writer(csv_text).writerows([preview.FIELDS, *(self.rows if csv_rows is None else csv_rows)])
        html = "<table>" + "".join("<tr>" + "".join("<td>"+v+"</td>" for v in row)+"</tr>"
                                    for row in [preview.FIELDS, *(self.rows if html_rows is None else html_rows)]) + "</table>"
        self.save(self.session, "html", preview.BASE+self.path, html+f'<a href="{link or self.path+"?format=csv"}">these rows as CSV</a>')
        self.save(self.session, "csv", preview.BASE+self.path+"?format=csv", csv_text.getvalue())

    def test_official_link_and_source_identity(self):
        info = preview.table_for(self.store, self.session, False)
        self.assertEqual(info["scope"], "private-evaluation-preview")
        self.assertEqual(sorted(info["funds"]), list(preview.FUNDS))
        self.catalogue(False)
        with self.assertRaisesRegex(ValueError, "no preview"):
            preview.table_for(self.store, self.session, False)
        self.catalogue()
        self.native(link="https://other.example/full.csv")
        with self.assertRaisesRegex(ValueError, "did not offer"):
            preview.table_for(self.store, self.session, False)

    def test_omission_duplicate_and_double_source_disagreement(self):
        for rows, error in [(self.rows[:-1], "omitted"), (self.rows + [self.rows[-1]], "Invalid candidate")]:
            self.native(rows, rows)
            with self.assertRaisesRegex(ValueError, error):
                preview.table_for(self.store, self.session, False)
        altered = [list(row) for row in self.rows]
        altered[-1][3] = "100.0001"
        self.native(csv_rows=altered)
        with self.assertRaisesRegex(ValueError, "precision differs"):
            preview.table_for(self.store, self.session, False)

    def test_native_bytes_are_sealed_and_immutable(self):
        path = self.store / (self.session + ".csv.gz")
        path.write_bytes(gzip.compress(b"changed"))
        with self.assertRaisesRegex(ValueError, "source differs"):
            preview.table_for(self.store, self.session, False)
        slot = self.store / "immutable"
        preview.exclusive(slot, b"first")
        preview.exclusive(slot, b"first")
        with self.assertRaisesRegex(ValueError, "changed"):
            preview.exclusive(slot, b"replacement")
        self.assertEqual(slot.read_bytes(), b"first")
        self.assertFalse(list(self.store.glob(".capture-*")))

    def test_no_rolling_publisher_scope(self):
        self.assertEqual(len(preview.EVALUATION_DATES), 9)
        self.assertNotIn("2026-11-23", preview.EVALUATION_DATES)

    def test_reinvestment_and_cash_held_are_distinct(self):
        result = economics.dividend_check("104", "100", "99", "101", "2")
        prior, ex = result["adjusted"]
        self.assertEqual((Decimal(prior["open"]), Decimal(prior["close"])), (Decimal("101.92"), Decimal("98")))
        self.assertEqual((Decimal(ex["open"]), Decimal(ex["close"])), (Decimal("99"), Decimal("101")))
        bps = result["bps"]
        self.assertAlmostEqual(bps["oneSharePlusReceivableBps"], 300)
        self.assertAlmostEqual(bps["backwardAdjustedBps"], 30000/98)
        self.assertGreater(bps["differenceBps"], 0)
        with self.assertRaises(ValueError):
            economics.dividend_check("101", "100", "99", "101", "100")


if __name__ == "__main__":
    unittest.main()
