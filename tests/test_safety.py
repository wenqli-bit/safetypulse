import tempfile
import unittest
from pathlib import Path

from server import detect_safety_anomalies, load_safety_accounts, root_cause_safety, safety_trends, seed_safety_demo, summarize_safety


class SafetyPulseTests(unittest.TestCase):
    def test_seed_summary_and_anomalies(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "safety.db"
            seed = seed_safety_demo(path=db_path)
            summary = summarize_safety(path=db_path)
            anomalies = detect_safety_anomalies(path=db_path)

            self.assertGreater(seed["metrics"], 1000)
            self.assertGreater(seed["accounts"], 50)
            self.assertEqual(summary["days"], 7)
            self.assertGreater(summary["totals"]["exposures"], 0)
            self.assertTrue(any(item["surface"] == "Live" for item in summary["surfaces"]))
            self.assertEqual(len(summary["region_mix"]), 6)
            self.assertGreaterEqual(len(anomalies["anomalies"]), 1)

    def test_root_cause_returns_contributors_and_funnel(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "safety.db"
            seed_safety_demo(path=db_path)
            root = root_cause_safety(metric="violation_rate", path=db_path)

            self.assertEqual(root["metric"], "violation_rate")
            self.assertGreater(len(root["segments"]), 0)
            self.assertEqual(root["funnel"][0]["step"], "Exposure")

    def test_accounts_and_trends_are_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "safety.db"
            seed_safety_demo(path=db_path)
            accounts = load_safety_accounts(path=db_path, limit=10)
            trends = safety_trends(path=db_path, metric="risk_accounts", days=30)

            self.assertEqual(len(accounts), 10)
            self.assertGreaterEqual(accounts[0]["risk_score"], accounts[-1]["risk_score"])
            self.assertGreaterEqual(len(trends["actual"]), 14)
            self.assertEqual(len(trends["forecast"]), 7)


if __name__ == "__main__":
    unittest.main()
