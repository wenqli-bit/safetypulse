import unittest
from datetime import datetime, timezone

from server import compute_attribution, normalize_event


def event(payload):
    return normalize_event(payload, now=datetime(2026, 1, 1, tzinfo=timezone.utc))


class AttributionTests(unittest.TestCase):
    def test_last_first_and_linear_models(self):
        events = [
            event(
                {
                    "event_name": "page_view",
                    "anonymous_id": "anon_1",
                    "timestamp": "2026-01-01T10:00:00Z",
                    "source": "google",
                    "medium": "cpc",
                    "campaign": "search_a",
                }
            ),
            event(
                {
                    "event_name": "email_click",
                    "anonymous_id": "anon_1",
                    "timestamp": "2026-01-02T10:00:00Z",
                    "source": "newsletter",
                    "medium": "email",
                    "campaign": "email_b",
                }
            ),
            event(
                {
                    "event_name": "purchase",
                    "user_id": "user_1",
                    "anonymous_id": "anon_1",
                    "timestamp": "2026-01-03T10:00:00Z",
                    "value": 100,
                }
            ),
        ]

        last = compute_attribution(events, model="last_touch")
        first = compute_attribution(events, model="first_touch")
        linear = compute_attribution(events, model="linear")

        self.assertEqual(last["rows"][0]["dimension"], "email_b")
        self.assertEqual(last["rows"][0]["revenue"], 100)
        self.assertEqual(first["rows"][0]["dimension"], "search_a")
        self.assertEqual(first["rows"][0]["revenue"], 100)
        self.assertEqual({row["dimension"]: row["revenue"] for row in linear["rows"]}, {"search_a": 50, "email_b": 50})

    def test_unattributed_conversion(self):
        events = [
            event(
                {
                    "event_name": "purchase",
                    "user_id": "user_direct",
                    "timestamp": "2026-01-03T10:00:00Z",
                    "value": 30,
                }
            )
        ]

        result = compute_attribution(events)

        self.assertEqual(result["totals"]["conversions"], 1)
        self.assertEqual(result["totals"]["unattributed_conversions"], 1)
        self.assertEqual(result["rows"][0]["dimension"], "Unattributed")
        self.assertEqual(result["rows"][0]["revenue"], 30)


if __name__ == "__main__":
    unittest.main()
