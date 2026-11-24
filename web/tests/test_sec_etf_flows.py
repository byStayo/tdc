import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "sec_etf_flows", Path(__file__).resolve().parents[1] / "scripts" / "collect-sec-etf-flows.py"
)
flows = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = flows
spec.loader.exec_module(flows)

CHECKED = "2026-11-01T10:00:00Z"


def originals(symbol="TLT", accession=None, quarter="2026-08-31", acceptance="2026-10-22 11:25:28",
              form="NPORT-P", numerics=None):
    fund = flows.FUNDS[symbol]
    accession = accession or fund.sample
    cik = f"{fund.cik:010}"
    native = flows.urls(fund, accession)[1].removeprefix("https://www.sec.gov")
    html = f"""SEC Accession No. {accession}
        <b>Form {form}</b> - Monthly Portfolio Investments Report
        <div>Filing Date</div>{acceptance[:10]} <div>Accepted</div>{acceptance}
        <div>Documents</div>3 <div>Period of Report</div>{quarter}
        <a href="{native}">primary_doc.xml</a>"""
    series = (f"<seriesClassInfo><seriesId>{fund.series}</seriesId><classId>{fund.share_class}</classId></seriesClassInfo>"
              if fund.series else "")
    series_tag = f"<seriesId>{fund.series}</seriesId>" if fund.series else ""
    values = numerics or [(1, "2.10", "0.01"), (2, "3.20", "1.02"), (3, "4.30", "2.03")]
    buckets = "".join(f'<mon{i}Flow sales="{sold}" redemption="{redeemed}" reinvestment="1.01"/>'
                      for i, sold, redeemed in values)
    xml = f"""<edgarSubmission xmlns="http://www.sec.gov/edgar/nport"><headerData>
        <submissionType>{form}</submissionType><isConfidential>false</isConfidential><filerInfo>
        <filer><issuerCredentials><cik>{cik}</cik></issuerCredentials></filer>{series}</filerInfo></headerData>
        <formData><genInfo><regCik>{cik}</regCik><regFileNumber>{fund.file_number}</regFileNumber>
        <regLei>{fund.lei}</regLei><seriesLei>{fund.lei}</seriesLei><seriesName>N/A</seriesName>{series_tag}
        <repPdEnd>{quarter}</repPdEnd><repPdDate>{quarter}</repPdDate></genInfo>
        <fundInfo>{buckets}</fundInfo></formData></edgarSubmission>"""
    return html.encode(), xml.encode()


def parse(symbol, **kwargs):
    accession = kwargs.get("accession") or flows.FUNDS[symbol].sample
    index, xml = originals(symbol, **kwargs)
    return flows.parse_flow(xml, index, symbol, accession, CHECKED)


def inventory(entries, fund):
    columns = ("form", "accessionNumber", "reportDate", "acceptanceDateTime", "filingDate")
    data = {column: list(values) for column, values in zip(columns, zip(*entries))}
    return {"cik": f"{fund.cik:010}", "filings": {"recent": data}}


class SecFlowTests(unittest.TestCase):
    def test_five_native_identities_and_exact_quarter_math(self):
        for symbol in flows.FUNDS:
            with self.subTest(symbol=symbol):
                row = parse(symbol)
                self.assertEqual((row["periodStart"], row["periodEnd"]), ("2026-06-01", "2026-08-31"))
                self.assertEqual((row["shareSalesUsd"], row["redemptionsUsd"], row["netShareSalesUsd"]),
                                 ("9.60", "3.06", "6.54"))
                self.assertEqual(row["distributionReinvestmentsUsd"], "3.03")
                self.assertEqual(row["acceptedAt"], "2026-10-22T15:25:28Z")
                self.assertEqual(row["verifiedAt"], CHECKED)
        reversed_buckets = [(1, "4.30", "2.03"), (2, "3.20", "1.02"), (3, "2.10", "0.01")]
        self.assertEqual(parse("TLT", numerics=reversed_buckets)["netShareSalesUsd"], "6.54")
        self.assertEqual(parse("TLT", numerics=[(i, "0", "3") for i in (1, 2, 3)])["netShareSalesUsd"], "-9")

    def test_identity_requires_exact_registrant_series_class_and_lei(self):
        fund = flows.FUNDS["TLT"]
        index, xml = originals()
        for before, after in [(fund.series, "S000076777"), (fund.share_class, "C000236812"),
                              (fund.lei, flows.FUNDS["IWM"].lei), ("0001100663", "0001100664"),
                              ("</classId>", "</classId><classId>C000000001</classId>"),
                              ("<isConfidential>false", "<isConfidential>true")]:
            with self.subTest(before=before), self.assertRaises(ValueError):
                flows.parse_flow(xml.replace(before.encode(), after.encode()), index, "TLT", fund.sample, CHECKED)
        index, xml = originals("SPY")
        with self.assertRaisesRegex(ValueError, "unit trust"):
            flows.parse_flow(xml.replace(b"<seriesName>N/A", b"<seriesName>Unidentified subfund"), index,
                             "SPY", flows.FUNDS["SPY"].sample, CHECKED)

    def test_completeness_notes_and_flow_grammar(self):
        index, xml = originals()
        for before, after in [
            ('redemption="0.01"', 'redemption="-0.01"'), ('sales="2.10"', 'sales="NA"'),
            ('reinvestment="1.01"', ''), ('mon3Flow', 'mon2Flow'),
            ('<fundInfo>', '<explntrNotes><explntrNote noteItem="B.6.c" note="correction"/></explntrNotes><fundInfo>'),
            ('<repPdEnd>2026-08-31', '<repPdEnd>2026-10-31'), ('<repPdEnd>2026-08-31', '<repPdEnd>2026-11-12'),
            ('<edgarSubmission', '<!DOCTYPE Q SYSTEM "ref"><edgarSubmission')
        ]:
            with self.subTest(before=before, after=after), self.assertRaises(ValueError):
                flows.parse_flow(xml.replace(before.encode(), after.encode()), index, "TLT", flows.FUNDS["TLT"].sample, CHECKED)

    def test_edgar_timezone_original_and_actual_availability(self):
        fund = flows.FUNDS["TLT"]
        index, xml = originals(acceptance="2026-01-15 09:30:00", quarter="2025-11-30")
        self.assertEqual(flows.filing_header(index, fund, fund.sample)["acceptedAt"], "2026-01-15T14:30:00Z")
        with self.assertRaisesRegex(ValueError, "capture time"):
            flows.parse_flow(xml, index, "TLT", fund.sample, "2026-01-15T14:29:59Z")
        modified = index.replace(b"/primary_doc.xml", b"/xslFormNPORT-P_X01/primary_doc.xml")
        with self.assertRaisesRegex(ValueError, "index identity"):
            flows.parse_flow(xml, modified, "TLT", fund.sample, CHECKED)
        mismatch = index.replace(b"Form NPORT-P", b"Form NPORT-P/A")
        with self.assertRaisesRegex(ValueError, "Public form"):
            flows.parse_flow(xml, mismatch, "TLT", fund.sample, CHECKED)

    def test_select_correct_quarter_amendment_and_ambiguous_new_accessions(self):
        fund = flows.FUNDS["TLT"]
        acc, amend, older, unknown = [f"0002071691-26-{i:06}" for i in range(1, 5)]
        entries = [("NPORT-P", acc, "2026-08-31", "2026-10-22T15:25:28Z", "2026-10-22"),
                   ("NPORT-P/A", amend, "2026-08-31", "2026-10-23T15:25:28Z", "2026-10-23"),
                   ("NPORT-P/A", older, "2026-05-31", "2026-10-24T15:25:28Z", "2026-10-24"),
                   ("NPORT-P", unknown, "2026-09-30", "2026-10-26T15:25:28Z", "2026-10-26")]
        listed = {row[1]: row[4] for row in entries[:3]}
        def listing(accession):
            return (f'<tr><td>NPORT-P</td><td><a href="/Archives/edgar/data/{fund.cik}/'
                    f'{accession.replace("-", "")}/{accession}-index.htm">Docs</a></td>'
                    f'<td>Monthly</td><td>{listed[accession]}</td></tr>')
        html = "".join(listing(accession) for accession in listed).encode()
        self.assertEqual(flows.listed_series(html, fund), listed)
        with self.assertRaisesRegex(ValueError, "Incorrect issuer"):
            flows.listed_series(html.replace(b"/1100663/", b"/884394/"), fund)
        table = inventory(entries, fund)
        self.assertEqual(flows.select_latest(table, fund, listed)[0], amend)
        listed["0002071691-19-000003"] = "2019-01-15"
        self.assertEqual(flows.select_latest(table, fund, listed)[0], amend)
        listed["0002071691-26-000009"] = "2026-10-26"
        with self.assertRaisesRegex(ValueError, "missing"):
            flows.select_latest(table, fund, listed)

    def test_mixed_quarters_and_amended_availability(self):
        rows = {symbol: parse(symbol) for symbol in flows.FUNDS}
        self.assertTrue(flows.period_comparison(rows)["allFiveSamePeriod"])
        rows["DIA"] = parse("DIA", quarter="2026-07-31", acceptance="2026-10-26 16:00:00")
        result = flows.period_comparison(rows)
        self.assertFalse(result["allFiveSamePeriod"])
        self.assertEqual([g["symbols"] for g in result["identicalReportedQuarters"]],
                         [["DIA"], ["IWM", "QQQ", "SPY", "TLT"]])
        self.assertFalse(flows.period_comparison({"DIA": rows["DIA"]})["allFiveSamePeriod"])

    def test_immutable_cache_verified_before_commit_and_replayed_offline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fund = flows.FUNDS["TLT"]
            index, xml = originals()
            clock = lambda: datetime(2026, 11, 1, 10, tzinfo=timezone.utc)
            raw = dict(zip(flows.urls(fund, fund.sample), (index, xml)))
            get = lambda uri, limit: raw[uri]
            wrong = (date(2026, 5, 31), clock(), date(2026, 10, 22))
            with self.assertRaisesRegex(ValueError, "clocks disagree"):
                flows.collect_filing(root, "TLT", fund.sample, get, clock, wrong)
            self.assertEqual(list((root / "TLT").iterdir()), [])
            row = flows.collect_filing(root, "TLT", fund.sample, get, clock)
            def disallow(*args):
                self.fail("Offline replay attempted to fetch an immutable accession")
            self.assertEqual(flows.collect_filing(root, "TLT", fund.sample, disallow, clock), row)
            self.assertEqual(flows.last_cached(root, "TLT"), row)
            with self.assertRaisesRegex(ValueError, "clocks disagree"):
                flows.collect_filing(root, "TLT", fund.sample, disallow, clock, wrong)
            directory = root / "TLT" / fund.sample
            self.assertEqual([p.stat().st_mode & 0o077 for p in directory.iterdir()], [0] * 3)
            (directory / "filing.xml").write_bytes(xml.replace(b'2.10', b'2.11'))
            with self.assertRaisesRegex(ValueError, "source changed"):
                flows.last_cached(root, "TLT")

    def test_full_cli_replays_originals_and_a_malformed_fund_is_isolated(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw = {}
            for symbol, fund in flows.FUNDS.items():
                raw.update(zip(flows.urls(fund, fund.sample), originals(symbol)))
            def run(*options):
                output = io.StringIO()
                with patch.object(sys, "argv", ["collector", "--private-dir", tmp, *options]), redirect_stdout(output):
                    code = flows.main()
                return code, json.loads(output.getvalue())
            with patch.object(flows.SecReader, "get", lambda _, url, limit: raw[url]):
                code, first = run("--collect-samples")
            self.assertEqual(code, 0)
            with patch.object(flows.SecReader, "get", side_effect=AssertionError("unexpected network call")):
                code, replay = run()
                self.assertEqual((code, replay["rows"]), (0, first["rows"]))
                self.assertEqual(replay["selection"], "cached originals")
                receipt = Path(tmp) / "IWM" / flows.FUNDS["IWM"].sample / "receipt.json"
                receipt.write_text("[]")
                code, broken = run()
                self.assertEqual((code, set(broken["withheld"]), len(broken["rows"])), (1, {"IWM"}, 4))

    def test_partial_failed_acquisition_and_competing_worker_preserve_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fund = flows.FUNDS["SPY"]
            index, _ = originals("SPY")
            def interrupted(url, limit):
                if url.endswith(".xml"):
                    raise OSError("SEC unavailable")
                return index
            with self.assertRaisesRegex(OSError, "unavailable"):
                flows.collect_filing(root, "SPY", fund.sample, interrupted, lambda: datetime.now(timezone.utc))
            self.assertEqual(list((root / "SPY").iterdir()), [])
            lock = flows.collector_lock(root)
            try:
                with self.assertRaises(BlockingIOError):
                    flows.collector_lock(root)
            finally:
                os.close(lock)


if __name__ == "__main__":
    unittest.main()
