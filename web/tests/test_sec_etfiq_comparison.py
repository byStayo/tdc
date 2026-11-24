import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from test_sec_etf_flows import originals


path = Path(__file__).resolve().parents[1] / "scripts" / "reconcile-sec-etfiq-flows.py"
spec = importlib.util.spec_from_file_location("sec_etfiq_controls", path)
audit = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = audit
spec.loader.exec_module(audit)

DAYS = ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02", "2026-07-06"]
CAL = {"version": "test-reviewed-sessions", "days": DAYS}


def issuer():
    return {"symbol": "SPY", "periodStart": DAYS[1], "periodEnd": DAYS[2], "accession": "fixture",
            "verifiedAt": "2026-08-28T16:00:00Z", "acceptedAt": "2026-08-27T14:00:00Z",
            "indexUrl": "fixture", "netShareSalesUsd": "6.75", "distributionReinvestmentsUsd": "2.50"}


def native(symbol, rows, **extra):
    top = {"ticker": symbol, "coverage": "daily", "schemaVersion": 3, "seriesId": audit.sec.FUNDS[symbol].series,
           "issuer": audit.HOUSES[symbol], "category": "Bonds" if symbol == "TLT" else "Stocks", "asOf": "2026-11-01",
           "daily": rows, "heartbeats": [], "cite": {"page": "https://etfiq.com/funds/" + symbol.lower(), "publisher": "ETFIQ",
           "license": audit.LICENSE, "methodology": audit.METHODOLOGY, "class": "ETFIQ-computed", "as_of": "2026-11-01"}}
    return json.dumps({**top, **extra}).encode()


def daily(symbol, nav, count, flow, **extra):
    return {"src": "history", "house": audit.HOUSES[symbol], "navDate": nav, "d": count, "flow": flow, **extra}


def sample():
    return [daily("SPY", DAYS[0], DAYS[1], 100), daily("SPY", DAYS[1], DAYS[2], 0), daily("SPY", DAYS[2], DAYS[3], 7)]


def calculate(rows, **top):
    sec = issuer()
    pairs = audit.count_date_period(sec, CAL) | audit.eligible_period(sec, CAL)
    proj = audit.project(native("SPY", rows, **top), "SPY", pairs)
    return audit.compare(sec, proj, CAL), proj


class DailyQuarterTests(unittest.TestCase):
    def test_period_end_includes_following_count_before_holiday_and_separates_reinvestment(self):
        result, _ = calculate(sample())
        self.assertEqual((result["expectedSessions"], result["coveredSessions"], result["zeroDays"]), (2, 2, 1))
        self.assertEqual((result["firstCount"], result["lastCount"], result["etfiqQuarterUsd"]), (DAYS[2], DAYS[3], 7))
        self.assertEqual(result["etfiqMinusSecExcludingReinvestmentUsd"], "0.25")
        self.assertEqual(result["etfiqMinusSecIncludingReinvestmentUsd"], "-2.25")
        self.assertEqual(result["countDateDiagnostic"]["etfiqQuarterUsd"], 100)
        actual = audit.calendar_for({"SPY": {"periodStart": "2026-06-29", "periodEnd": "2026-07-03"}})
        pairs = audit.eligible_period({"periodStart": "2026-06-29", "periodEnd": "2026-07-03"}, actual)
        self.assertEqual(pairs["2026-07-02"], "2026-07-06")
        self.assertNotIn("2026-07-03", pairs)

    def test_genuine_all_zero_complete_and_partial_zero_retained(self):
        rows = [{**r, "flow": 0} for r in sample()]
        complete, _ = calculate(rows)
        partial, _ = calculate(rows[:2])
        absent, _ = calculate(rows[:1])
        self.assertEqual((complete["etfiqQuarterUsd"], complete["zeroDays"]), (0, 2))
        self.assertEqual((partial["etfiqCoveredSubtotalUsd"], partial["etfiqQuarterUsd"]), (0, None))
        self.assertIsNone(absent["etfiqCoveredSubtotalUsd"])
        self.assertEqual(absent["coveredSessions"], 0)
        self.assertIsNone(absent["etfiqMinusSecIncludingReinvestmentUsd"])

    def test_real_span_why_held_imported_or_unrecognized_fields_cannot_count(self):
        for extras, expected in [({"spanDays": 2, "why": "covers 2 trading days"}, "spans-sessions"),
                                 ({"why": "provider review"}, "provider-reason"), ({"held": True}, "held"),
                                 ({"spansSessions": True}, "spans-sessions"), ({"src": "nport"}, "non-daily-source"),
                                 ({"status": "closed"}, "unreviewed-status"), ({"house": "other"}, "different-issuer"),
                                 ({"reviewFlag": "pending"}, "unreviewed-daily-field"), ({"flow": None}, "invalid-flow")]:
            with self.subTest(extras=extras):
                rows = sample()
                rows[1].update(extras)
                result, proj = calculate(rows, monthly=[{"flow": 777777777}], netAssets={"private": 123.456789})
                self.assertIn(expected, result["exclusionsByOrder"][DAYS[1]])
                self.assertIsNone(result["etfiqQuarterUsd"])
                snapshot = json.dumps(proj)
                self.assertNotIn("777777777", snapshot)
                self.assertNotIn("123.456789", snapshot)
                self.assertNotIn("provider review", snapshot)

    def test_duplicates_and_wrong_nav_excluded_even_for_equal_amounts(self):
        rows = sample()
        result, _ = calculate(rows + [rows[1]])
        self.assertIn("duplicate-count", result["exclusionsByOrder"][DAYS[1]])
        self.assertIn("duplicate-order", result["exclusionsByOrder"][DAYS[1]])
        rows[2]["navDate"] = DAYS[1]
        result, _ = calculate(rows)
        self.assertIn("ambiguous-order-date", result["exclusionsByOrder"][DAYS[1]])
        self.assertIn("wrong-order-date", result["exclusionsByOrder"][DAYS[2]])

    def test_unexpected_non_session_count_and_economic_dates(self):
        calendar = {"days": ["2026-07-01", "2026-07-02", "2026-07-06", "2026-07-07"], "version": "fixture"}
        sec = {**issuer(), "periodStart": "2026-07-02", "periodEnd": "2026-07-06"}
        rows = [daily("SPY", a, b, 4) for a, b in zip(calendar["days"], calendar["days"][1:])]
        rows += [daily("SPY", "2026-07-04", "2026-07-05", 0)]
        all_pairs = audit.count_date_period(sec, calendar) | audit.eligible_period(sec, calendar)
        proj = audit.project(native("SPY", rows), "SPY", all_pairs)
        checked = audit.compare(sec, proj, calendar)
        self.assertFalse(checked["countDateDiagnostic"]["completeCalendarCoverage"])
        self.assertEqual(checked["countDateDiagnostic"]["unexpectedCountDates"], ["2026-07-05"])

    def test_round_trip_and_split_are_already_in_daily_amount(self):
        rows = sample()
        rows[1]["heartbeat"] = "event"
        rows[2].update({"heartbeat": "event", "split": 2.4})
        result, proj = calculate(rows, heartbeats=[{"id": "event", "in": DAYS[2], "out": DAYS[3]}],
                                splits=[{"privateVendorFactor": 2.4}])
        self.assertEqual((result["roundTripLegs"], result["splitDays"], result["etfiqQuarterUsd"]), (2, 1, 7))
        self.assertNotIn("2.4", json.dumps(proj))
        missing, _ = calculate(rows)
        self.assertIn("unverified-round-trip", missing["exclusionsByOrder"][DAYS[1]])

    def test_wrong_etf_series_citation_and_duplicate_json_fields(self):
        pairs = audit.eligible_period(issuer(), CAL)
        for field, replacement in [("seriesId", "S000076777"), ("issuer", "Invesco"), ("coverage", "monthly"),
                                   ("cite", {"publisher": "Someone else"})]:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "identity"):
                audit.project(native("SPY", sample(), **{field: replacement}), "SPY", pairs)
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            audit.project(b'{"ticker":"SPY","ticker":"QQQ"}', "SPY", pairs)

    def test_offline_replay_uses_exact_edgar_original_and_immutable_daily_projection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            private, output = root / "sec", root / "comparison"
            private.mkdir(mode=0o700)
            ranges = {"one": {"periodStart": "2026-04-01", "periodEnd": "2026-06-30"}}
            days = audit.calendar_for(ranges)["days"]
            bodies = {}
            for symbol, fund in audit.sec.FUNDS.items():
                raw = dict(zip(audit.sec.urls(fund, fund.sample),
                               originals(symbol, quarter="2026-06-30", acceptance="2026-08-28 10:00:00")))
                audit.sec.collect_filing(private, symbol, fund.sample, lambda url, limit: raw[url],
                                        lambda: datetime(2026, 9, 1, 12, tzinfo=timezone.utc))
                bodies[symbol] = native(symbol, [daily(symbol, a, b, 1) for a, b in zip(days, days[1:])])
            identity = audit.collect(private, output, bodies.__getitem__)
            second = audit.collect(private, output, bodies.__getitem__)
            self.assertEqual(identity, second)
            # The daily run reuses an unchanged filing bundle without a single provider request.
            self.assertEqual(audit.collect(private, output, {}.__getitem__, new_filings_only=True), identity)
            location = output / (identity + ".json")
            self.assertEqual(location.stat().st_mode & 0o077, 0)
            with patch.object(audit, "fetch", side_effect=AssertionError("unexpected network call")):
                report = audit.replay(private, output, identity)
            self.assertEqual(len(report["rows"]), 5)
            self.assertTrue(all(r["etfiqQuarterUsd"] == 62 for r in report["rows"].values()))
            older = location.read_bytes()
            with self.assertRaises(KeyError):
                audit.collect(private, output, {}.__getitem__)
            self.assertEqual(location.read_bytes(), older)
            location.write_bytes(older.replace(b'"usd":1', b'"usd":2', 1))
            with self.assertRaisesRegex(ValueError, "seal"):
                audit.replay(private, output, identity)
            location.write_bytes(older)
            fund = audit.sec.FUNDS["TLT"]
            document = private / "TLT" / fund.sample / "filing.xml"
            document.write_bytes(document.read_bytes().replace(b'sales="2.10"', b'sales="4.10"'))
            with self.assertRaisesRegex(ValueError, "source changed"):
                audit.replay(private, output, identity)


if __name__ == "__main__":
    unittest.main()
