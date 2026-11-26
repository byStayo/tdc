"""Small regressions for versioned, international OFR source availability."""
import base64
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


source = module("regional", "qualify-ofr-geographic.py")
archive = module("regional_archive", "collect-ofr-geographic-archives.py")


def native_rows(total=1.001):
    return [("2020-04-17", total, .1, .3, .6), ("2020-04-20", total, .2, .3, .5)]


class Geography(unittest.TestCase):
    def test_quantization_preserves_the_initial_and_supplemental_policies(self):
        with self.assertRaisesRegex(ValueError, "do not reconcile"):
            source.points(native_rows(), False)
        self.assertEqual(len(source.points(native_rows(), True)), 2)
        with self.assertRaisesRegex(ValueError, "do not reconcile"):
            source.points(native_rows(1.003), True)
        with self.assertRaisesRegex(ValueError, "precision grid"):
            source.points(native_rows(1.0002), True)

    def test_missing_region_and_misaligned_economic_dates_are_rejected(self):
        rows = [{"date": x[0], "fsi": x[1], "us": x[2], "adv": x[3]} for x in native_rows()]
        mirror = json.dumps({"source": "OFR Financial Stress Index", "data": rows}).encode()
        with self.assertRaises(KeyError):
            source.geographic(mirror, True, True)
        series = {name: {"data": [[0, v], [86_400_000, v]]} for name, v in (
            ("OFRFSI", 1.), ("US", .3), ("AE", .2), ("EM", .5))}
        series["US"]["data"][0][0] = 3600
        with self.assertRaisesRegex(ValueError, "dates disagree"):
            source.geographic(json.dumps(series).encode(), False, True)

    def test_early_native_release_does_not_satisfy_two_day_rule_and_duplicates_count_once(self):
        cal = {dt.date(2021, 11, 12): True, dt.date(2021, 11, 15): True}
        econ = dt.date(2021, 11, 10)
        pair = ((dt.date(2021, 11, 9), 0, 0, 0), (econ, 0, 0, 0))
        capture = dt.datetime(2021, 11, 12, 14, tzinfo=dt.timezone.utc)
        holiday = {dt.date(2021, 11, 11)}
        self.assertEqual(source.federal_lag(econ, capture.date(), holiday), 1)
        one = (capture, "native-wayback", pair)
        two = (capture + dt.timedelta(seconds=1), "native-wayback", pair)
        self.assertEqual(source.vintage.selected_dates([one, two], cal, holiday, set()), {})
        self.assertEqual(len(source.vintage.selected_dates([one, two], cal, set(), set())), 1)

    def test_delayed_original_preserves_actual_capture_and_old_targets_and_refuses_mirrors(self):
        day = dt.date.fromisoformat
        calendar = {day(d): True for d in ("2021-11-10", "2021-11-11", "2021-11-12", "2021-11-15", "2021-11-16")}
        holiday = {day("2021-11-11")}
        first = dt.datetime(2021, 11, 10, 15, tzinfo=dt.timezone.utc)
        earlier = (first, "native-wayback", ((day("2021-11-08"), 0, 1, 0), (day("2021-11-09"), 0, 2, 0)))
        later = (first + dt.timedelta(hours=1), "native-wayback", earlier[2])
        mirror = (first, source.vintage.MIRROR, earlier[2])
        captures = [earlier, later, mirror]
        artifacts = {r: {"available": r[0].isoformat(), "rawSha256": hex(i + 1)} for i, r in enumerate(captures)}
        select = lambda old: source.admitted_after_maturity(old, captures, artifacts, set(), holiday, calendar)[0]
        result = select([])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["sha256"], artifacts[later]["rawSha256"])
        self.assertEqual(result[0]["publishedBy"], later[0].isoformat())
        self.assertEqual(result[0]["economic"], "2021-11-09")
        self.assertEqual(result[0]["maturityDate"], "2021-11-12")
        self.assertEqual(result[0]["session"], "2021-11-15")
        self.assertEqual(select([{"session": "2021-11-16", "economic": "2021-11-09"}]), [])
        self.assertEqual(select([{"session": "2021-11-15", "economic": "2021-11-02"}]), [])
        self.assertEqual(source.admitted_after_maturity([], [mirror], artifacts, set(), holiday, calendar)[0], [])

    def test_substituted_memento_cannot_admit_wrong_time_or_bytes(self):
        stamp = "20210422085142"
        origin = archive.NATIVE + "csv"
        url = "https://web.archive.org/web/" + stamp + "id_/" + origin
        raw = b"treasury-test-fixture"
        sha1 = base64.b32encode(hashlib.sha1(raw).digest()).decode()
        row = [stamp, origin, "200", sha1]
        exact_clock = "Thu, 22 Apr 2021 08:51:42 GMT"
        cases = [(b"other", url, exact_clock), (raw, url, "Thu, 22 Apr 2021 08:51:41 GMT"),
                 (raw, url.replace("085142", "085141"), exact_clock)]
        for body, landed, clock in cases:
            with self.subTest(clock=clock, landed=landed), TemporaryDirectory() as temp:
                with patch.object(archive, "download", return_value=(body, landed, {"Memento-Datetime": clock})):
                    result = archive.fetch(Path(temp), row)
                self.assertEqual(result["status"], "memento-or-body-mismatch")
                self.assertEqual(list(Path(temp).glob("*.gz")), [])
        with TemporaryDirectory() as temp:
            with patch.object(archive, "download", return_value=(raw, url, {"Memento-Datetime": exact_clock})):
                result = archive.fetch(Path(temp), row)
            self.assertEqual(result["status"], "verified")
            saved = Path(temp) / (result["sha256"] + ".gz")
            self.assertEqual(gzip.decompress(saved.read_bytes()), raw)
            self.assertEqual(saved.stat().st_mode & 0o077, 0)

    def test_transport_recovery_reuses_success_and_does_not_retry_access_denial(self):
        stamp = "20210422085142"
        origin = archive.NATIVE + "csv"
        url = "https://web.archive.org/web/" + stamp + "id_/" + origin
        raw = b"treasury-test-fixture"
        row = [stamp, origin, "200", base64.b32encode(hashlib.sha1(raw).digest()).decode()]
        with TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.object(archive, "download", side_effect=archive.URLError("timed out")):
                first = archive.fetch(root, row)
            with patch.object(archive, "download", return_value=(raw, url, {"Memento-Datetime": "Thu, 22 Apr 2021 08:51:42 GMT"})):
                second = archive.fetch(root, row)
            with patch.object(archive, "download", side_effect=AssertionError("repeated request")):
                self.assertEqual(archive.fetch(root, row), second)
            self.assertEqual(first["status"], "URLError")
            self.assertEqual(second["status"], "verified")
        with TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.object(archive, "download", side_effect=archive.HTTPError(url, 403, "denied", None, None)):
                self.assertEqual(archive.fetch(root, row)["status"], "HTTP-403")
            with patch.object(archive, "download", side_effect=AssertionError("forbidden retry")):
                self.assertEqual(archive.fetch(root, row)["status"], "HTTP-403")


if __name__ == "__main__":
    unittest.main()
