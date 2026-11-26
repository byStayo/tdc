import datetime as dt
import gzip
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


path = Path(__file__).resolve().parents[1] / "scripts" / "verify-ofr-volatility-vintages.py"
spec = importlib.util.spec_from_file_location("ofr_vintage_check", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
day = dt.date.fromisoformat


def captured(when, prior, latest):
    return (module.instant(when), "native-wayback",
            ((day(prior), 1.0, 0.3), (day(latest), 1.1, 0.4)))


class OFRVintages(unittest.TestCase):
    def test_parses_legacy_dates_and_rejects_conflicted_components(self):
        data = b"Date,OFR FSI,Volatility\n4/19/2022,0.5,0.2\n4/20/2022,0.6,0.3\n"
        actual = module.latest_points(data)
        self.assertEqual(actual[-1], (day("2022-04-20"), 0.6, 0.3))
        body = {"OFRFSI": {"data": [[1, 0.5], [2, 0.6]]}, "Volatility": {"data": [[1, 0.2], [3, 0.3]]}}
        with self.assertRaisesRegex(ValueError, "dates differ"):
            module.latest_points(json.dumps(body).encode())
        with self.assertRaises(ValueError):
            module.latest_points(data.replace(b"0.3", b"NaN"))
        with self.assertRaises(ValueError):
            module.instant("2022-04-20T18:00:00")

    def test_uses_capture_ny_day_two_federal_days_full_target_and_unique_observation(self):
        calendar = {day(k): True for k in ["2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14"]}
        holiday = {day("2026-10-12")}
        # 00:12 UTC Saturday is Friday evening in New York. The exchange opens on the federal holiday.
        first = captured("2026-10-10T00:12:00Z", "2026-10-06", "2026-10-07")
        repeated = captured("2026-10-12T21:00:00Z", "2026-10-06", "2026-10-07")
        too_early = captured("2026-10-12T21:01:00Z", "2026-10-08", "2026-10-09")
        result = module.eligible([first, repeated, too_early], calendar, holiday, set())
        self.assertEqual(result["eligibleTargets"], 1)
        self.assertEqual(module.eligible([too_early], calendar, holiday, set())["eligibleTargets"], 0)
        self.assertEqual(module.eligible([first], {**calendar, day("2026-10-12"): False}, holiday, set())["eligibleTargets"], 0)
        self.assertEqual(module.eligible([first], calendar, holiday, {day("2026-10-07")})["eligibleTargets"], 0)

    def test_changed_private_source_body_fails_before_use(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            signature = hashlib.sha256(b"original government file").hexdigest()
            (directory / (signature + ".gz")).write_bytes(gzip.compress(b"later revision"))
            with self.assertRaisesRegex(ValueError, "Digest mismatch"):
                module.artifact(directory, signature)
            with self.assertRaisesRegex(ValueError, "Invalid artifact digest"):
                module.artifact(directory, "../another-file")


if __name__ == "__main__":
    unittest.main()
