import datetime as dt
import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "scripts/verify-ons-services-study.py"
spec = importlib.util.spec_from_file_location("ons_study_verifier", MODULE)
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)


class OnsStudyTests(unittest.TestCase):
    def test_exchange_and_two_independently_zoned_clocks(self):
        self.assertIsNone(study.market_close(dt.date(2024, 6, 19)))
        self.assertIsNone(study.market_close(dt.date(2018, 12, 5)))
        self.assertIsNone(study.market_close(dt.date(2025, 1, 9)))
        self.assertEqual(study.market_close(dt.date(2021, 12, 31)), 16)
        self.assertEqual(study.market_close(dt.date(2025, 11, 28)), 13)
        day = dt.date(2016, 3, 22)
        self.assertEqual(study.local_clock(day, 9, 30, study.UK), "2016-03-22T09:30:00.000Z")
        self.assertEqual(study.local_clock(day, 7, 48, study.NY), "2016-03-22T11:48:00.000Z")
        with self.assertRaisesRegex(study.EvidenceError, "prelaunch"):
            study.trading_days("2026-11-02", "2026-11-03")

    def test_second_partial_bootstrap_block_is_truncated(self):
        self.assertEqual(study.interval([0., 0., 0., 4.]), [0., 1.])

    def test_test_labels_cannot_change_fit_or_forecasts(self):
        data = [{"features": [x/10, x % 3], "up": int(x % 4 > 1)} for x in range(14)]
        flipped = [{**row, "up": 1-row["up"]} for row in data[10:]]
        self.assertEqual(study.fit(2, data[:7], data[7:10], data[10:]),
                         study.fit(2, data[:7], data[7:10], flipped))

    def test_read_only_original_requires_exact_private_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt"
            path.write_bytes(b"private synthetic example")
            path.chmod(0o600)
            fingerprint = study.sha(path.read_bytes())
            self.assertEqual(study.sha(study.private(path, fingerprint)), fingerprint)
            with self.assertRaisesRegex(study.EvidenceError, "changed"):
                study.private(path, "0" * 64)
            path.chmod(0o644)
            with self.assertRaisesRegex(study.EvidenceError, "private"):
                study.private(path, fingerprint)


if __name__ == "__main__":
    unittest.main()
