from __future__ import annotations

import json
import math
import mimetypes
import os
import random
import sqlite3
import sys
import uuid
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


APP_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = APP_ROOT / "static"
DATA_ROOT = APP_ROOT / "data"
DB_PATH = DATA_ROOT / "events.db"

DEFAULT_CONVERSION_EVENTS = {
    "purchase",
    "order_paid",
    "checkout_complete",
    "signup",
    "lead",
    "subscribe",
    "trial_start",
}

MARKETING_FIELDS = ("channel", "source", "medium", "campaign", "content", "term")

SAFETY_NUMERIC_FIELDS = (
    "exposures",
    "reports",
    "violations",
    "model_hits",
    "human_reviews",
    "enforcements",
    "appeals",
    "appeal_success",
    "risk_accounts",
    "incidents",
)

SAFETY_METRIC_LABELS = {
    "report_rate": "举报率",
    "violation_rate": "违规命中率",
    "avg_review_minutes": "审核耗时",
    "appeal_success_rate": "申诉成功率",
    "risk_accounts": "高风险账号",
    "incidents": "安全事件",
}

SAFETY_SURFACES = ("Video", "Live", "Account", "Privacy", "Review Platform")
SAFETY_REGIONS = {
    "US": "en",
    "BR": "pt",
    "ID": "id",
    "VN": "vi",
    "TH": "th",
    "TR": "tr",
}
SAFETY_POLICIES = (
    "Harassment",
    "Adult Safety",
    "Spam & Scam",
    "Violent Content",
    "Misinformation",
    "Privacy",
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_time(value: Any | None) -> datetime:
    if value is None or value == "":
        return utc_now()

    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 10_000_000_000 else value
        return datetime.fromtimestamp(seconds, tz=timezone.utc)

    if isinstance(value, str):
        raw = value.strip()
        if raw.isdigit():
            return parse_time(float(raw))
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    raise ValueError("timestamp must be ISO-8601 text or Unix time")


def clean_text(value: Any | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def first_value(payload: dict[str, Any], properties: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = clean_text(payload.get(key))
        if value:
            return value
    for key in keys:
        value = clean_text(properties.get(key))
        if value:
            return value
    return None


def parse_float(value: Any | None, default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def infer_channel(source: str | None, medium: str | None, channel: str | None) -> str | None:
    if channel:
        return channel

    source_l = (source or "").lower()
    medium_l = (medium or "").lower()

    if medium_l in {"cpc", "ppc", "paid_search", "sem"}:
        return "Paid Search"
    if medium_l in {"paid_social", "social_paid"}:
        return "Paid Social"
    if medium_l in {"email", "newsletter"}:
        return "Email"
    if medium_l in {"organic", "seo", "organic_search"}:
        return "Organic Search"
    if medium_l in {"referral", "partner", "affiliate"}:
        return "Referral"
    if medium_l in {"social", "organic_social"}:
        return "Organic Social"

    social_sources = {"tiktok", "facebook", "instagram", "youtube", "twitter", "x", "linkedin", "snapchat"}
    if source_l in social_sources:
        return "Organic Social"
    if source_l in {"google", "bing", "duckduckgo", "baidu"}:
        return "Organic Search"
    if source_l in {"email", "newsletter", "mailchimp"}:
        return "Email"

    return None


def normalize_event(payload: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("event must be a JSON object")

    properties = payload.get("properties") or {}
    if not isinstance(properties, dict):
        raise ValueError("properties must be a JSON object")

    event_name = first_value(payload, properties, ("event_name", "event", "name", "type"))
    if not event_name:
        raise ValueError("event_name is required")

    user_id = first_value(payload, properties, ("user_id", "uid", "customer_id", "account_id"))
    anonymous_id = first_value(payload, properties, ("anonymous_id", "anon_id", "device_id", "distinct_id", "visitor_id"))
    if not user_id and not anonymous_id:
        raise ValueError("user_id or anonymous_id is required for attribution")

    source = first_value(payload, properties, ("source", "utm_source"))
    medium = first_value(payload, properties, ("medium", "utm_medium"))
    campaign = first_value(payload, properties, ("campaign", "utm_campaign", "campaign_id", "campaign_name"))
    content = first_value(payload, properties, ("content", "utm_content", "ad_id", "creative_id"))
    term = first_value(payload, properties, ("term", "utm_term", "keyword"))
    channel = infer_channel(source, medium, first_value(payload, properties, ("channel",)))

    is_conversion = bool(payload.get("is_conversion") or properties.get("is_conversion"))
    raw_event_type = first_value(payload, properties, ("event_type",))
    if raw_event_type:
        event_type = raw_event_type.lower()
    elif is_conversion or event_name.lower() in DEFAULT_CONVERSION_EVENTS:
        event_type = "conversion"
    elif any((channel, source, medium, campaign, content, term)):
        event_type = "touchpoint"
    else:
        event_type = "event"

    value = parse_float(
        payload.get("value", properties.get("value", properties.get("revenue", properties.get("amount")))),
        0.0,
    )

    event_time = parse_time(payload.get("timestamp", payload.get("event_time", properties.get("timestamp"))))
    received_at = now or utc_now()

    return {
        "id": clean_text(payload.get("id")) or str(uuid.uuid4()),
        "received_at": to_iso_z(received_at),
        "event_time": to_iso_z(event_time),
        "user_id": user_id,
        "anonymous_id": anonymous_id,
        "event_name": event_name,
        "event_type": event_type,
        "channel": channel,
        "source": source,
        "medium": medium,
        "campaign": campaign,
        "content": content,
        "term": term,
        "value": value,
        "currency": clean_text(payload.get("currency", properties.get("currency"))) or "USD",
        "session_id": first_value(payload, properties, ("session_id", "sid")),
        "properties": properties,
    }


def init_db(path: Path = DB_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                received_at TEXT NOT NULL,
                event_time TEXT NOT NULL,
                user_id TEXT,
                anonymous_id TEXT,
                event_name TEXT NOT NULL,
                event_type TEXT NOT NULL,
                channel TEXT,
                source TEXT,
                medium TEXT,
                campaign TEXT,
                content TEXT,
                term TEXT,
                value REAL NOT NULL DEFAULT 0,
                currency TEXT NOT NULL DEFAULT 'USD',
                session_id TEXT,
                properties_json TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_identity_time ON events(user_id, anonymous_id, event_time)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_name ON events(event_name)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_campaign ON events(campaign)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_channel ON events(channel)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS safety_metrics (
                id TEXT PRIMARY KEY,
                metric_date TEXT NOT NULL,
                surface TEXT NOT NULL,
                region TEXT NOT NULL,
                language TEXT NOT NULL,
                policy TEXT NOT NULL,
                exposures INTEGER NOT NULL,
                reports INTEGER NOT NULL,
                violations INTEGER NOT NULL,
                model_hits INTEGER NOT NULL,
                human_reviews INTEGER NOT NULL,
                enforcements INTEGER NOT NULL,
                appeals INTEGER NOT NULL,
                appeal_success INTEGER NOT NULL,
                risk_accounts INTEGER NOT NULL,
                incidents INTEGER NOT NULL,
                avg_review_minutes REAL NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_safety_date ON safety_metrics(metric_date)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_safety_segment ON safety_metrics(surface, region, policy)")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS safety_actions (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                priority TEXT NOT NULL,
                status TEXT NOT NULL,
                owner TEXT NOT NULL,
                metric TEXT NOT NULL,
                segment TEXT NOT NULL,
                title TEXT NOT NULL,
                expected_impact TEXT NOT NULL,
                last_update TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS safety_accounts (
                id TEXT PRIMARY KEY,
                detected_at TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                account_id TEXT NOT NULL,
                risk_score REAL NOT NULL,
                risk_level TEXT NOT NULL,
                status TEXT NOT NULL,
                surface TEXT NOT NULL,
                region TEXT NOT NULL,
                language TEXT NOT NULL,
                policy TEXT NOT NULL,
                cluster TEXT NOT NULL,
                signup_source TEXT NOT NULL,
                device_count INTEGER NOT NULL,
                report_count INTEGER NOT NULL,
                violation_count INTEGER NOT NULL,
                exposure_count INTEGER NOT NULL,
                recommendation TEXT NOT NULL
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_safety_accounts_score ON safety_accounts(risk_score DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_safety_accounts_segment ON safety_accounts(surface, region, policy)")
        conn.commit()
    finally:
        conn.close()


def connect_db(path: Path = DB_PATH) -> sqlite3.Connection:
    init_db(path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def db_session(path: Path = DB_PATH):
    conn = connect_db(path)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def event_to_row(event: dict[str, Any]) -> tuple[Any, ...]:
    return (
        event["id"],
        event["received_at"],
        event["event_time"],
        event["user_id"],
        event["anonymous_id"],
        event["event_name"],
        event["event_type"],
        event["channel"],
        event["source"],
        event["medium"],
        event["campaign"],
        event["content"],
        event["term"],
        event["value"],
        event["currency"],
        event["session_id"],
        json.dumps(event["properties"], ensure_ascii=False, separators=(",", ":")),
    )


def insert_events(payload: Any, path: Path = DB_PATH) -> dict[str, Any]:
    if isinstance(payload, dict) and isinstance(payload.get("events"), list):
        raw_events = payload["events"]
    elif isinstance(payload, list):
        raw_events = payload
    else:
        raw_events = [payload]

    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    now = utc_now()

    for index, raw in enumerate(raw_events):
        try:
            accepted.append(normalize_event(raw, now=now))
        except Exception as exc:  # noqa: BLE001 - API should report row-level failures.
            rejected.append({"index": index, "error": str(exc)})

    if accepted:
        with db_session(path) as conn:
            conn.executemany(
                """
                INSERT OR REPLACE INTO events (
                    id, received_at, event_time, user_id, anonymous_id, event_name, event_type,
                    channel, source, medium, campaign, content, term, value, currency, session_id,
                    properties_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [event_to_row(event) for event in accepted],
            )

    return {
        "accepted": len(accepted),
        "rejected": rejected,
        "events": [{k: v for k, v in event.items() if k != "properties"} for event in accepted],
    }


def row_to_event(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    event = dict(row)
    properties_json = event.pop("properties_json", "{}")
    try:
        event["properties"] = json.loads(properties_json)
    except json.JSONDecodeError:
        event["properties"] = {}
    return event


def load_events(path: Path = DB_PATH, limit: int | None = None) -> list[dict[str, Any]]:
    query = "SELECT * FROM events ORDER BY event_time ASC, received_at ASC"
    params: tuple[Any, ...] = ()
    if limit:
        query = "SELECT * FROM events ORDER BY event_time DESC, received_at DESC LIMIT ?"
        params = (limit,)

    with db_session(path) as conn:
        rows = conn.execute(query, params).fetchall()
    events = [row_to_event(row) for row in rows]
    if limit:
        events.reverse()
    return events


def clear_events(path: Path = DB_PATH) -> int:
    with db_session(path) as conn:
        cursor = conn.execute("DELETE FROM events")
        return cursor.rowcount


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, item: str) -> str:
        self.parent.setdefault(item, item)
        if self.parent[item] != item:
            self.parent[item] = self.find(self.parent[item])
        return self.parent[item]

    def union(self, left: str, right: str) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            # Prefer logged-in IDs as the readable root where possible.
            if left_root.startswith("user:"):
                self.parent[right_root] = left_root
            else:
                self.parent[left_root] = right_root


def identity_token(event: dict[str, Any]) -> str:
    if event.get("user_id"):
        return f"user:{event['user_id']}"
    if event.get("anonymous_id"):
        return f"anon:{event['anonymous_id']}"
    return f"event:{event['id']}"


def build_identity_graph(events: list[dict[str, Any]]) -> UnionFind:
    graph = UnionFind()
    for event in events:
        token = identity_token(event)
        graph.find(token)
        if event.get("user_id") and event.get("anonymous_id"):
            graph.union(f"user:{event['user_id']}", f"anon:{event['anonymous_id']}")
    return graph


def is_conversion(event: dict[str, Any], conversion_event: str) -> bool:
    if conversion_event and conversion_event.lower() != "any":
        return event["event_name"].lower() == conversion_event.lower()
    return event["event_type"] == "conversion"


def is_touchpoint(event: dict[str, Any]) -> bool:
    if event["event_type"] == "conversion":
        return False
    return event["event_type"] == "touchpoint" or any(event.get(field) for field in MARKETING_FIELDS)


def dimension_label(event: dict[str, Any] | None, dimension: str) -> str:
    if event is None:
        return "Unattributed"
    if dimension == "source_medium":
        return f"{event.get('source') or '(direct)'} / {event.get('medium') or '(none)'}"
    if dimension in MARKETING_FIELDS:
        return event.get(dimension) or "(not set)"
    return event.get("campaign") or "(not set)"


def choose_touchpoints(touches: list[dict[str, Any]], model: str) -> list[tuple[dict[str, Any], float]]:
    if not touches:
        return []
    if model == "first_touch":
        return [(touches[0], 1.0)]
    if model == "linear":
        credit = 1.0 / len(touches)
        return [(touch, credit) for touch in touches]
    return [(touches[-1], 1.0)]


def compute_attribution(
    events: list[dict[str, Any]],
    model: str = "last_touch",
    dimension: str = "campaign",
    conversion_event: str = "purchase",
    lookback_days: int = 30,
) -> dict[str, Any]:
    model = model if model in {"last_touch", "first_touch", "linear"} else "last_touch"
    dimension = dimension if dimension in {*MARKETING_FIELDS, "source_medium"} else "campaign"
    lookback = max(1, min(int(lookback_days), 365))
    graph = build_identity_graph(events)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for event in events:
        cloned = dict(event)
        cloned["_time"] = parse_time(event["event_time"])
        grouped[graph.find(identity_token(event))].append(cloned)

    buckets: dict[str, dict[str, Any]] = {}
    total_conversions = 0
    attributed_conversions = 0
    total_value = 0.0
    touchpoint_count = sum(1 for event in events if is_touchpoint(event))

    for identity_events in grouped.values():
        identity_events.sort(key=lambda item: (item["_time"], item["received_at"]))
        for index, event in enumerate(identity_events):
            if not is_conversion(event, conversion_event):
                continue

            total_conversions += 1
            total_value += float(event.get("value") or 0.0)
            cutoff = event["_time"] - timedelta(days=lookback)
            touches = [
                candidate
                for candidate in identity_events[:index]
                if is_touchpoint(candidate) and cutoff <= candidate["_time"] <= event["_time"]
            ]
            chosen = choose_touchpoints(touches, model)

            if not chosen:
                label = "Unattributed"
                buckets.setdefault(
                    label,
                    {"dimension": label, "credit": 0.0, "revenue": 0.0, "touchpoints": 0, "conversion_ids": set()},
                )
                buckets[label]["credit"] += 1.0
                buckets[label]["revenue"] += float(event.get("value") or 0.0)
                buckets[label]["conversion_ids"].add(event["id"])
                continue

            attributed_conversions += 1
            for touch, credit in chosen:
                label = dimension_label(touch, dimension)
                buckets.setdefault(
                    label,
                    {"dimension": label, "credit": 0.0, "revenue": 0.0, "touchpoints": 0, "conversion_ids": set()},
                )
                buckets[label]["credit"] += credit
                buckets[label]["revenue"] += float(event.get("value") or 0.0) * credit
                buckets[label]["touchpoints"] += 1
                buckets[label]["conversion_ids"].add(event["id"])

    rows = []
    for bucket in buckets.values():
        rows.append(
            {
                "dimension": bucket["dimension"],
                "credit": round(bucket["credit"], 4),
                "revenue": round(bucket["revenue"], 2),
                "touchpoints": bucket["touchpoints"],
                "conversions": len(bucket["conversion_ids"]),
            }
        )
    rows.sort(key=lambda item: (item["revenue"], item["credit"]), reverse=True)

    return {
        "model": model,
        "dimension": dimension,
        "conversion_event": conversion_event,
        "lookback_days": lookback,
        "totals": {
            "events": len(events),
            "touchpoints": touchpoint_count,
            "conversions": total_conversions,
            "attributed_conversions": attributed_conversions,
            "unattributed_conversions": max(total_conversions - attributed_conversions, 0),
            "revenue": round(total_value, 2),
            "attributed_rate": round(attributed_conversions / total_conversions, 4) if total_conversions else 0,
        },
        "rows": rows,
    }


def summarize_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    graph = build_identity_graph(events)
    identities = {graph.find(identity_token(event)) for event in events}
    conversions = [event for event in events if event["event_type"] == "conversion"]
    event_names = Counter(event["event_name"] for event in events)

    return {
        "events": len(events),
        "identities": len(identities),
        "touchpoints": sum(1 for event in events if is_touchpoint(event)),
        "conversions": len(conversions),
        "revenue": round(sum(float(event.get("value") or 0.0) for event in conversions), 2),
        "latest_event_time": events[-1]["event_time"] if events else None,
        "event_names": [{"name": name, "count": count} for name, count in event_names.most_common(8)],
    }


def demo_payload() -> list[dict[str, Any]]:
    base = utc_now() - timedelta(days=9)

    def ts(days: int, hours: int = 0) -> str:
        return to_iso_z(base + timedelta(days=days, hours=hours))

    return [
        {
            "event_name": "page_view",
            "anonymous_id": "anon_001",
            "timestamp": ts(0),
            "source": "google",
            "medium": "cpc",
            "campaign": "spring_search",
            "properties": {"landing_page": "/pricing"},
        },
        {"event_name": "product_view", "anonymous_id": "anon_001", "timestamp": ts(1), "properties": {"sku": "pro"}},
        {
            "event_name": "purchase",
            "user_id": "user_001",
            "anonymous_id": "anon_001",
            "timestamp": ts(2),
            "value": 128,
            "properties": {"order_id": "ord_001"},
        },
        {
            "event_name": "ad_click",
            "anonymous_id": "anon_002",
            "timestamp": ts(1),
            "source": "tiktok",
            "medium": "paid_social",
            "campaign": "creator_launch",
            "content": "video_17",
        },
        {
            "event_name": "email_click",
            "anonymous_id": "anon_002",
            "timestamp": ts(3),
            "source": "newsletter",
            "medium": "email",
            "campaign": "may_winback",
        },
        {
            "event_name": "purchase",
            "user_id": "user_002",
            "anonymous_id": "anon_002",
            "timestamp": ts(4),
            "value": 86,
            "properties": {"order_id": "ord_002"},
        },
        {
            "event_name": "referral_visit",
            "anonymous_id": "anon_003",
            "timestamp": ts(2),
            "source": "partner_blog",
            "medium": "referral",
            "campaign": "partner_review",
        },
        {
            "event_name": "purchase",
            "anonymous_id": "anon_003",
            "timestamp": ts(6),
            "value": 43,
            "properties": {"order_id": "ord_003"},
        },
        {
            "event_name": "page_view",
            "user_id": "user_004",
            "timestamp": ts(4),
            "properties": {"path": "/direct"},
        },
        {
            "event_name": "purchase",
            "user_id": "user_004",
            "timestamp": ts(5),
            "value": 62,
            "properties": {"order_id": "ord_004"},
        },
        {
            "event_name": "ad_click",
            "anonymous_id": "anon_005",
            "timestamp": ts(5),
            "source": "facebook",
            "medium": "paid_social",
            "campaign": "retargeting_core",
            "content": "carousel_a",
        },
        {
            "event_name": "purchase",
            "user_id": "user_005",
            "anonymous_id": "anon_005",
            "timestamp": ts(8),
            "value": 154,
            "properties": {"order_id": "ord_005"},
        },
    ]


def clear_safety_data(path: Path = DB_PATH) -> dict[str, int]:
    with db_session(path) as conn:
        metrics = conn.execute("DELETE FROM safety_metrics").rowcount
        actions = conn.execute("DELETE FROM safety_actions").rowcount
        accounts = conn.execute("DELETE FROM safety_accounts").rowcount
    return {"metrics": metrics, "actions": actions, "accounts": accounts}


def safety_metric_row(
    metric_date: str,
    surface: str,
    region: str,
    language: str,
    policy: str,
    exposures: int,
    reports: int,
    violations: int,
    model_hits: int,
    human_reviews: int,
    enforcements: int,
    appeals: int,
    appeal_success: int,
    risk_accounts: int,
    incidents: int,
    avg_review_minutes: float,
) -> tuple[Any, ...]:
    row_id = f"{metric_date}:{surface}:{region}:{policy}".replace(" ", "_").lower()
    return (
        row_id,
        metric_date,
        surface,
        region,
        language,
        policy,
        max(0, int(exposures)),
        max(0, int(reports)),
        max(0, int(violations)),
        max(0, int(model_hits)),
        max(0, int(human_reviews)),
        max(0, int(enforcements)),
        max(0, int(appeals)),
        max(0, int(appeal_success)),
        max(0, int(risk_accounts)),
        max(0, int(incidents)),
        round(max(1.0, float(avg_review_minutes)), 2),
    )


def safety_account_row(
    detected_at: str,
    last_seen: str,
    account_id: str,
    risk_score: float,
    status: str,
    surface: str,
    region: str,
    language: str,
    policy: str,
    cluster: str,
    signup_source: str,
    device_count: int,
    report_count: int,
    violation_count: int,
    exposure_count: int,
    recommendation: str,
) -> tuple[Any, ...]:
    risk_level = "Critical" if risk_score >= 94 else "High" if risk_score >= 82 else "Medium"
    return (
        f"{account_id}:{detected_at}",
        detected_at,
        last_seen,
        account_id,
        round(float(risk_score), 1),
        risk_level,
        status,
        surface,
        region,
        language,
        policy,
        cluster,
        signup_source,
        max(1, int(device_count)),
        max(0, int(report_count)),
        max(0, int(violation_count)),
        max(0, int(exposure_count)),
        recommendation,
    )


def seed_safety_demo(reset: bool = True, path: Path = DB_PATH) -> dict[str, Any]:
    if reset:
        clear_safety_data(path)

    rng = random.Random(20260531)
    today = utc_now().date()
    first_day = today - timedelta(days=41)
    region_weight = {"US": 1.25, "BR": 0.86, "ID": 1.1, "VN": 0.74, "TH": 0.68, "TR": 0.62}
    surface_base = {"Video": 210_000, "Live": 64_000, "Account": 82_000, "Privacy": 24_000, "Review Platform": 38_000}
    policy_report_rate = {
        "Harassment": 1.35,
        "Adult Safety": 0.78,
        "Spam & Scam": 0.92,
        "Violent Content": 0.5,
        "Misinformation": 0.44,
        "Privacy": 0.28,
    }
    surface_review_minutes = {"Video": 18, "Live": 9, "Account": 26, "Privacy": 36, "Review Platform": 21}
    rows: list[tuple[Any, ...]] = []
    account_rows: list[tuple[Any, ...]] = []

    for day_offset in range(42):
        metric_day = first_day + timedelta(days=day_offset)
        seasonality = 1 + 0.08 * math.sin((day_offset / 7) * math.tau)
        release_pressure = 1 + (0.05 if day_offset in {13, 14, 28, 29} else 0)

        for surface in SAFETY_SURFACES:
            for region, language in SAFETY_REGIONS.items():
                for policy in SAFETY_POLICIES:
                    exposure_noise = rng.uniform(0.9, 1.11)
                    policy_weight = 0.72 if policy == "Privacy" else 1.0
                    exposures = int(surface_base[surface] * region_weight[region] * policy_weight * seasonality * release_pressure * exposure_noise)

                    report_rate = policy_report_rate[policy] * rng.uniform(0.82, 1.2)
                    if surface == "Live":
                        report_rate *= 1.35
                    if surface == "Account":
                        report_rate *= 0.82
                    if surface == "Privacy":
                        report_rate *= 0.62

                    reports = int(exposures * report_rate / 1000)
                    violation_ratio = rng.uniform(0.24, 0.42)
                    if policy in {"Adult Safety", "Violent Content"}:
                        violation_ratio += 0.12
                    violations = int(reports * violation_ratio)

                    avg_review = surface_review_minutes[surface] * rng.uniform(0.84, 1.18)
                    risk_accounts = int(violations * rng.uniform(0.05, 0.12))
                    incidents = int(max(0, violations * rng.uniform(0.012, 0.035)))
                    success_rate = rng.uniform(0.12, 0.24)

                    if metric_day >= today - timedelta(days=2) and surface == "Live" and region == "ID" and policy == "Harassment":
                        reports = int(reports * 2.75)
                        violations = int(violations * 2.28 + 22)
                        avg_review *= 1.85
                        incidents += 9

                    if metric_day >= today - timedelta(days=2) and surface == "Account" and region == "BR" and policy == "Spam & Scam":
                        reports = int(reports * 1.72)
                        violations = int(violations * 1.95 + 18)
                        risk_accounts = int(max(risk_accounts * 3.1, 65))
                        incidents += 6

                    if metric_day >= today - timedelta(days=1) and surface == "Video" and region == "US" and policy == "Privacy":
                        reports = int(reports * 1.58)
                        violations = int(violations * 1.46 + 11)
                        success_rate = 0.48
                        incidents += 4

                    if metric_day >= today - timedelta(days=3) and surface == "Review Platform" and region == "VN" and policy == "Adult Safety":
                        avg_review *= 2.35
                        incidents += 5

                    model_hits = int(reports * rng.uniform(0.32, 0.48) + violations * rng.uniform(0.58, 0.86))
                    human_reviews = int(model_hits * rng.uniform(0.55, 0.82) + violations * rng.uniform(0.35, 0.65))
                    enforcements = int(violations * rng.uniform(0.78, 0.92))
                    appeals = int(enforcements * rng.uniform(0.06, 0.16))
                    appeal_success = int(appeals * success_rate)

                    rows.append(
                        safety_metric_row(
                            metric_day.isoformat(),
                            surface,
                            region,
                            language,
                            policy,
                            exposures,
                            reports,
                            violations,
                            model_hits,
                            human_reviews,
                            enforcements,
                            appeals,
                            appeal_success,
                            risk_accounts,
                            incidents,
                            avg_review,
                        )
                    )

    account_clusters = [
        {
            "surface": "Live",
            "region": "ID",
            "policy": "Harassment",
            "cluster": "live_chat_harassment_burst",
            "source": "creator_invite",
            "recommendation": "优先送审最近直播片段，并对重复骚扰弹幕账号做临时禁言。",
            "count": 34,
            "base_score": 96,
        },
        {
            "surface": "Account",
            "region": "BR",
            "policy": "Spam & Scam",
            "cluster": "shared_device_signup_ring",
            "source": "bulk_signup",
            "recommendation": "核查共享设备与注册路径，命中后加入账号风险评分特征。",
            "count": 32,
            "base_score": 94,
        },
        {
            "surface": "Video",
            "region": "US",
            "policy": "Privacy",
            "cluster": "privacy_false_positive_review",
            "source": "organic_upload",
            "recommendation": "抽样复核处罚样本，确认是否存在隐私策略误伤。",
            "count": 22,
            "base_score": 88,
        },
        {
            "surface": "Video",
            "region": "BR",
            "policy": "Harassment",
            "cluster": "comment_attack_coordination",
            "source": "referral",
            "recommendation": "检查评论互动图谱，对协同攻击账号降权并送人工复核。",
            "count": 24,
            "base_score": 86,
        },
        {
            "surface": "Review Platform",
            "region": "VN",
            "policy": "Adult Safety",
            "cluster": "sla_backlog_sensitive_review",
            "source": "review_queue",
            "recommendation": "提升成人安全积压队列优先级，避免延迟处置扩大曝光。",
            "count": 16,
            "base_score": 82,
        },
    ]
    status_pool = ["待复核", "观察中", "已限流", "待策略处理"]
    for cluster in account_clusters:
        language = SAFETY_REGIONS[cluster["region"]]
        for index in range(cluster["count"]):
            risk_score = cluster["base_score"] - index * rng.uniform(0.18, 0.72) + rng.uniform(-1.4, 1.8)
            risk_score = max(65, min(99.8, risk_score))
            account_id = f"acct_{cluster['region'].lower()}_{cluster['policy'].lower().replace(' ', '_').replace('&', 'and')}_{index + 1:03d}"
            detected_at = to_iso_z(utc_now() - timedelta(days=rng.randint(0, 5), hours=rng.randint(0, 23)))
            last_seen = to_iso_z(utc_now() - timedelta(hours=rng.randint(0, 48), minutes=rng.randint(0, 59)))
            report_count = int(risk_score * rng.uniform(0.6, 1.9))
            violation_count = int(report_count * rng.uniform(0.22, 0.56))
            exposure_count = int(report_count * rng.uniform(60, 240))
            account_rows.append(
                safety_account_row(
                    detected_at,
                    last_seen,
                    account_id,
                    risk_score,
                    status_pool[(index + len(cluster["cluster"])) % len(status_pool)],
                    cluster["surface"],
                    cluster["region"],
                    language,
                    cluster["policy"],
                    cluster["cluster"],
                    cluster["source"],
                    rng.randint(1, 11) if cluster["surface"] == "Account" else rng.randint(1, 4),
                    report_count,
                    violation_count,
                    exposure_count,
                    cluster["recommendation"],
                )
            )

    actions = [
        (
            "act_live_id_harassment",
            to_iso_z(utc_now()),
            "P0",
            "复核中",
            "Live Safety Ops",
            "report_rate",
            "Live / ID / Harassment",
            "加强高风险直播间分流和审核排班",
            "72 小时内将举报率降低 18%-25%",
            "分流规则已起草，正在评估排班影响",
        ),
        (
            "act_account_br_spam",
            to_iso_z(utc_now()),
            "P1",
            "排队中",
            "Account Integrity",
            "risk_accounts",
            "Account / BR / Spam & Scam",
            "将设备聚类特征加入账号风险评分",
            "将高风险账号曝光降低 12%-18%",
            "特征清单已同步算法团队",
        ),
        (
            "act_video_us_privacy",
            to_iso_z(utc_now()),
            "P1",
            "实验中",
            "Privacy Compliance",
            "appeal_success_rate",
            "Video / US / Privacy",
            "复核隐私处罚策略并启动阈值实验",
            "将误伤申诉降低 8%-12%",
            "实验护栏指标已准备",
        ),
        (
            "act_review_vn_sla",
            to_iso_z(utc_now()),
            "P2",
            "监控中",
            "Review Platform",
            "avg_review_minutes",
            "Review Platform / VN / Adult Safety",
            "重排成人安全审核积压队列优先级",
            "将 SLA 恢复到 25 分钟内",
            "队列结构已改为小时级监控",
        ),
    ]

    with db_session(path) as conn:
        conn.executemany(
            """
            INSERT OR REPLACE INTO safety_metrics (
                id, metric_date, surface, region, language, policy, exposures, reports, violations,
                model_hits, human_reviews, enforcements, appeals, appeal_success, risk_accounts,
                incidents, avg_review_minutes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        conn.executemany(
            """
            INSERT OR REPLACE INTO safety_actions (
                id, created_at, priority, status, owner, metric, segment, title, expected_impact, last_update
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            actions,
        )
        conn.executemany(
            """
            INSERT OR REPLACE INTO safety_accounts (
                id, detected_at, last_seen, account_id, risk_score, risk_level, status, surface, region,
                language, policy, cluster, signup_source, device_count, report_count, violation_count,
                exposure_count, recommendation
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            account_rows,
        )

    return {"metrics": len(rows), "actions": len(actions), "accounts": len(account_rows), "latest_date": today.isoformat()}


def load_safety_rows(path: Path = DB_PATH) -> list[dict[str, Any]]:
    with db_session(path) as conn:
        rows = conn.execute("SELECT * FROM safety_metrics ORDER BY metric_date ASC").fetchall()
    return [dict(row) for row in rows]


def load_safety_actions(path: Path = DB_PATH) -> list[dict[str, Any]]:
    with db_session(path) as conn:
        rows = conn.execute(
            """
            SELECT * FROM safety_actions
            ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, created_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def load_safety_accounts(
    limit: int = 30,
    surface: str = "all",
    region: str = "all",
    policy: str = "all",
    path: Path = DB_PATH,
) -> list[dict[str, Any]]:
    ensure_safety_seeded(path)
    clauses: list[str] = []
    params: list[Any] = []
    if surface != "all":
        clauses.append("surface = ?")
        params.append(surface)
    if region != "all":
        clauses.append("region = ?")
        params.append(region)
    if policy != "all":
        clauses.append("policy = ?")
        params.append(policy)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(max(1, min(int(limit), 100)))
    with db_session(path) as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM safety_accounts
            {where}
            ORDER BY risk_score DESC, report_count DESC
            LIMIT ?
            """,
            params,
        ).fetchall()
    return [dict(row) for row in rows]


def ensure_safety_seeded(path: Path = DB_PATH) -> None:
    with db_session(path) as conn:
        metric_count = conn.execute("SELECT COUNT(*) FROM safety_metrics").fetchone()[0]
        account_count = conn.execute("SELECT COUNT(*) FROM safety_accounts").fetchone()[0]
    if metric_count == 0 or account_count == 0:
        seed_safety_demo(reset=True, path=path)


def latest_metric_date(rows: list[dict[str, Any]]) -> str | None:
    return max((row["metric_date"] for row in rows), default=None)


def safety_date_window(rows: list[dict[str, Any]], days: int, surface: str = "all") -> tuple[list[dict[str, Any]], list[dict[str, Any]], str | None]:
    if surface != "all":
        rows = [row for row in rows if row["surface"] == surface]
    latest = latest_metric_date(rows)
    if latest is None:
        return [], [], None
    latest_dt = datetime.fromisoformat(latest).date()
    recent_start = latest_dt - timedelta(days=days - 1)
    previous_start = recent_start - timedelta(days=days)
    previous_end = recent_start - timedelta(days=1)

    recent = [row for row in rows if recent_start.isoformat() <= row["metric_date"] <= latest]
    previous = [row for row in rows if previous_start.isoformat() <= row["metric_date"] <= previous_end.isoformat()]
    return recent, previous, latest


def aggregate_safety(rows: list[dict[str, Any]]) -> dict[str, Any]:
    aggregate: dict[str, Any] = {field: 0 for field in SAFETY_NUMERIC_FIELDS}
    weighted_review_minutes = 0.0
    for row in rows:
        for field in SAFETY_NUMERIC_FIELDS:
            aggregate[field] += int(row[field])
        weighted_review_minutes += float(row["avg_review_minutes"]) * int(row["human_reviews"])

    aggregate["avg_review_minutes"] = (
        round(weighted_review_minutes / aggregate["human_reviews"], 2) if aggregate["human_reviews"] else 0.0
    )
    aggregate["report_rate"] = round(aggregate["reports"] / aggregate["exposures"] * 1000, 3) if aggregate["exposures"] else 0
    aggregate["violation_rate"] = (
        round(aggregate["violations"] / aggregate["exposures"] * 1000, 3) if aggregate["exposures"] else 0
    )
    aggregate["appeal_success_rate"] = (
        round(aggregate["appeal_success"] / aggregate["appeals"] * 100, 2) if aggregate["appeals"] else 0
    )
    aggregate["enforcement_rate"] = (
        round(aggregate["enforcements"] / aggregate["violations"] * 100, 2) if aggregate["violations"] else 0
    )
    return aggregate


def pct_delta(current: float, baseline: float) -> float:
    if baseline == 0:
        return 0.0
    return round((current - baseline) / baseline * 100, 1)


def aggregate_metric_value(aggregate: dict[str, Any], metric: str) -> float:
    if metric in {"report_rate", "violation_rate", "avg_review_minutes", "appeal_success_rate"}:
        return float(aggregate.get(metric, 0))
    if metric in {"risk_accounts", "incidents", "reports", "violations", "exposures"}:
        return float(aggregate.get(metric, 0))
    return float(aggregate.get("violation_rate", 0))


def linear_forecast(values: list[float], horizon: int = 7) -> tuple[list[float], float]:
    if not values:
        return [0.0] * horizon, 0.0
    if len(values) == 1:
        return [values[0]] * horizon, 0.0
    xs = list(range(len(values)))
    mean_x = sum(xs) / len(xs)
    mean_y = sum(values) / len(values)
    denominator = sum((x - mean_x) ** 2 for x in xs) or 1.0
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, values)) / denominator
    intercept = mean_y - slope * mean_x
    residuals = [y - (intercept + slope * x) for x, y in zip(xs, values)]
    residual_std = math.sqrt(sum(item**2 for item in residuals) / len(residuals)) if residuals else 0.0
    forecasts = [max(0.0, intercept + slope * (len(values) + step)) for step in range(horizon)]
    return forecasts, residual_std


def metric_card(key: str, label: str, current: float, previous: float, unit: str, precision: int = 1) -> dict[str, Any]:
    return {
        "key": key,
        "label": label,
        "value": round(current, precision),
        "unit": unit,
        "delta": pct_delta(current, previous),
        "direction": "up" if current >= previous else "down",
    }


def summarize_safety(days: int = 7, surface: str = "all", path: Path = DB_PATH) -> dict[str, Any]:
    ensure_safety_seeded(path)
    days = max(3, min(int(days), 30))
    rows = load_safety_rows(path)
    recent, previous, latest = safety_date_window(rows, days, surface)
    current = aggregate_safety(recent)
    baseline = aggregate_safety(previous)

    by_surface = []
    for surface_name in SAFETY_SURFACES:
        surface_rows = [row for row in recent if row["surface"] == surface_name]
        if not surface_rows:
            continue
        item = aggregate_safety(surface_rows)
        by_surface.append(
            {
                "surface": surface_name,
                "exposures": item["exposures"],
                "report_rate": item["report_rate"],
                "violation_rate": item["violation_rate"],
                "incidents": item["incidents"],
                "avg_review_minutes": item["avg_review_minutes"],
            }
        )

    policy_mix = []
    for policy in SAFETY_POLICIES:
        policy_rows = [row for row in recent if row["policy"] == policy]
        item = aggregate_safety(policy_rows)
        policy_mix.append(
            {
                "policy": policy,
                "violations": item["violations"],
                "reports": item["reports"],
                "violation_rate": item["violation_rate"],
                "appeal_success_rate": item["appeal_success_rate"],
            }
        )
    policy_mix.sort(key=lambda item: item["violations"], reverse=True)

    region_mix = []
    for region in SAFETY_REGIONS:
        region_rows = [row for row in recent if row["region"] == region]
        item = aggregate_safety(region_rows)
        region_mix.append(
            {
                "region": region,
                "language": SAFETY_REGIONS[region],
                "exposures": item["exposures"],
                "reports": item["reports"],
                "violations": item["violations"],
                "report_rate": item["report_rate"],
                "violation_rate": item["violation_rate"],
                "risk_accounts": item["risk_accounts"],
                "incidents": item["incidents"],
            }
        )
    region_mix.sort(key=lambda item: (item["risk_accounts"], item["violation_rate"]), reverse=True)

    return {
        "latest_date": latest,
        "days": days,
        "surface": surface,
        "cards": [
            metric_card("exposures", "内容曝光", current["exposures"], baseline["exposures"], "", 0),
            metric_card("report_rate", "举报率/千曝光", current["report_rate"], baseline["report_rate"], "", 2),
            metric_card("violation_rate", "违规命中/千曝光", current["violation_rate"], baseline["violation_rate"], "", 2),
            metric_card("avg_review_minutes", "平均审核耗时", current["avg_review_minutes"], baseline["avg_review_minutes"], "min", 1),
            metric_card("appeal_success_rate", "申诉成功率", current["appeal_success_rate"], baseline["appeal_success_rate"], "%", 1),
            metric_card("risk_accounts", "高风险账号", current["risk_accounts"], baseline["risk_accounts"], "", 0),
        ],
        "totals": current,
        "baseline": baseline,
        "surfaces": by_surface,
        "policy_mix": policy_mix,
        "region_mix": region_mix,
        "row_count": len(rows),
    }


def safety_trends(metric: str = "violation_rate", days: int = 30, surface: str = "all", path: Path = DB_PATH) -> dict[str, Any]:
    ensure_safety_seeded(path)
    metric = metric if metric in {*SAFETY_METRIC_LABELS, "reports", "violations", "exposures"} else "violation_rate"
    days = max(14, min(int(days), 42))
    rows = load_safety_rows(path)
    if surface != "all":
        rows = [row for row in rows if row["surface"] == surface]
    latest = latest_metric_date(rows)
    if latest is None:
        return {"metric": metric, "metric_label": SAFETY_METRIC_LABELS.get(metric, metric), "actual": [], "forecast": []}

    latest_dt = datetime.fromisoformat(latest).date()
    first_dt = latest_dt - timedelta(days=days - 1)
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_date[row["metric_date"]].append(row)

    all_dates = sorted(by_date)
    values_by_date = {date: aggregate_metric_value(aggregate_safety(items), metric) for date, items in by_date.items()}
    actual = []
    for date in all_dates:
        date_obj = datetime.fromisoformat(date).date()
        if date_obj < first_dt or date_obj > latest_dt:
            continue
        previous_values = [values_by_date[item] for item in all_dates if item < date][-7:]
        baseline = sum(previous_values) / len(previous_values) if previous_values else values_by_date[date]
        actual.append({"date": date, "value": round(values_by_date[date], 3), "baseline": round(baseline, 3)})

    train_values = [point["value"] for point in actual[-14:]]
    forecast_values, residual_std = linear_forecast(train_values, horizon=7)
    forecast = []
    for index, value in enumerate(forecast_values, start=1):
        forecast_date = latest_dt + timedelta(days=index)
        forecast.append(
            {
                "date": forecast_date.isoformat(),
                "value": round(value, 3),
                "lower": round(max(0.0, value - residual_std * 1.25), 3),
                "upper": round(value + residual_std * 1.25, 3),
            }
        )

    current = actual[-1]["value"] if actual else 0.0
    forecast_end = forecast[-1]["value"] if forecast else current
    return {
        "latest_date": latest,
        "days": days,
        "surface": surface,
        "metric": metric,
        "metric_label": SAFETY_METRIC_LABELS.get(metric, metric),
        "unit": "%" if metric == "appeal_success_rate" else "min" if metric == "avg_review_minutes" else "",
        "actual": actual,
        "forecast": forecast,
        "summary": {
            "current": current,
            "forecast_7d": forecast_end,
            "forecast_delta_pct": pct_delta(forecast_end, current),
            "volatility": round(residual_std, 3),
        },
    }


def metric_value(row: dict[str, Any], metric: str) -> float:
    if metric == "report_rate":
        return row["reports"] / row["exposures"] * 1000 if row["exposures"] else 0
    if metric == "violation_rate":
        return row["violations"] / row["exposures"] * 1000 if row["exposures"] else 0
    if metric == "appeal_success_rate":
        return row["appeal_success"] / row["appeals"] * 100 if row["appeals"] else 0
    if metric == "avg_review_minutes":
        return float(row["avg_review_minutes"])
    if metric == "risk_accounts":
        return float(row["risk_accounts"])
    if metric == "incidents":
        return float(row["incidents"])
    return 0.0


def anomaly_action(metric: str, surface: str, region: str, policy: str) -> str:
    if surface == "Live" and policy == "Harassment":
        return "将更多直播间路由到高风险审核队列，并更新骚扰关键词覆盖。"
    if surface == "Account" and policy == "Spam & Scam":
        return "检查设备与注册聚类，将高增益特征加入账号风险评分。"
    if metric == "appeal_success_rate":
        return "抽样复核处罚样本，并以申诉成功率为护栏启动阈值实验。"
    if metric == "avg_review_minutes":
        return "重排受影响审核队列的优先级和人力配置。"
    return f"发起 {surface} / {region} / {policy} 的政策与模型联合复盘。"


def detect_safety_anomalies(lookback_days: int = 14, path: Path = DB_PATH) -> dict[str, Any]:
    ensure_safety_seeded(path)
    rows = load_safety_rows(path)
    latest = latest_metric_date(rows)
    if latest is None:
        return {"latest_date": None, "anomalies": []}

    latest_dt = datetime.fromisoformat(latest).date()
    start = latest_dt - timedelta(days=max(7, min(int(lookback_days), 30)))
    history_by_segment: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    latest_rows = []

    for row in rows:
        row_date = datetime.fromisoformat(row["metric_date"]).date()
        key = (row["surface"], row["region"], row["policy"])
        if row["metric_date"] == latest:
            latest_rows.append(row)
        elif start <= row_date < latest_dt:
            history_by_segment[key].append(row)

    anomalies = []
    for row in latest_rows:
        key = (row["surface"], row["region"], row["policy"])
        history = history_by_segment.get(key, [])
        if len(history) < 7:
            continue
        for metric in ("report_rate", "violation_rate", "avg_review_minutes", "appeal_success_rate", "risk_accounts", "incidents"):
            values = [metric_value(item, metric) for item in history]
            baseline = sum(values) / len(values)
            variance = sum((value - baseline) ** 2 for value in values) / len(values)
            min_std = 2.0 if metric == "appeal_success_rate" else 1.0 if metric == "avg_review_minutes" else 0.05
            std = max(math.sqrt(variance), abs(baseline) * 0.08, min_std)
            current = metric_value(row, metric)
            if metric == "report_rate" and row["reports"] < 20:
                continue
            if metric == "violation_rate" and row["violations"] < 10:
                continue
            if metric == "appeal_success_rate" and (current < 15 or row["appeals"] < 8):
                continue
            if metric == "risk_accounts" and row["risk_accounts"] < 10:
                continue
            if metric == "incidents" and row["incidents"] < 3:
                continue
            score = (current - baseline) / std
            delta = pct_delta(current, baseline)
            if score < 2.5 or current <= baseline:
                continue

            severity = "P0" if score >= 5 or delta >= 120 else "P1" if score >= 3.5 or delta >= 55 else "P2"
            segment = f"{row['surface']} / {row['region']} / {row['policy']}"
            anomalies.append(
                {
                    "id": f"{latest}:{metric}:{segment}".replace(" ", "_").lower(),
                    "date": latest,
                    "severity": severity,
                    "metric": metric,
                    "metric_label": SAFETY_METRIC_LABELS[metric],
                    "surface": row["surface"],
                    "region": row["region"],
                    "policy": row["policy"],
                    "segment": segment,
                    "current": round(current, 2),
                    "baseline": round(baseline, 2),
                    "delta_pct": delta,
                    "score": round(score, 2),
                    "title": f"{segment} {SAFETY_METRIC_LABELS[metric]}异常上升",
                    "recommendation": anomaly_action(metric, row["surface"], row["region"], row["policy"]),
                }
            )

    anomalies.sort(key=lambda item: ({"P0": 0, "P1": 1, "P2": 2}[item["severity"]], -item["score"]))
    return {"latest_date": latest, "lookback_days": lookback_days, "anomalies": anomalies[:18]}


def metric_numerator(rows: list[dict[str, Any]], metric: str) -> float:
    item = aggregate_safety(rows)
    if metric == "report_rate":
        return float(item["reports"])
    if metric == "violation_rate":
        return float(item["violations"])
    if metric == "avg_review_minutes":
        return float(item["avg_review_minutes"] * item["human_reviews"])
    if metric == "appeal_success_rate":
        return float(item["appeal_success"])
    if metric == "risk_accounts":
        return float(item["risk_accounts"])
    if metric == "incidents":
        return float(item["incidents"])
    return float(item["violations"])


def segment_rate(rows: list[dict[str, Any]], metric: str) -> float:
    item = aggregate_safety(rows)
    if metric in {"report_rate", "violation_rate", "avg_review_minutes", "appeal_success_rate"}:
        return float(item[metric])
    return float(item.get(metric, 0))


def root_cause_safety(metric: str = "violation_rate", days: int = 7, surface: str = "all", path: Path = DB_PATH) -> dict[str, Any]:
    ensure_safety_seeded(path)
    metric = metric if metric in SAFETY_METRIC_LABELS else "violation_rate"
    days = max(3, min(int(days), 30))
    rows = load_safety_rows(path)
    recent, previous, latest = safety_date_window(rows, days, surface)

    recent_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    previous_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in recent:
        recent_groups[f"{row['surface']} / {row['region']} / {row['policy']}"].append(row)
    for row in previous:
        previous_groups[f"{row['surface']} / {row['region']} / {row['policy']}"].append(row)

    segment_rows = []
    positive_delta = 0.0
    for segment, segment_recent in recent_groups.items():
        segment_previous = previous_groups.get(segment, [])
        delta = metric_numerator(segment_recent, metric) - metric_numerator(segment_previous, metric)
        if delta > 0:
            positive_delta += delta
        surface_name, region, policy = segment.split(" / ")
        segment_rows.append(
            {
                "segment": segment,
                "surface": surface_name,
                "region": region,
                "policy": policy,
                "delta": round(delta, 2),
                "current": round(segment_rate(segment_recent, metric), 2),
                "baseline": round(segment_rate(segment_previous, metric), 2) if segment_previous else 0,
                "contribution": 0,
            }
        )

    for row in segment_rows:
        row["contribution"] = round(row["delta"] / positive_delta * 100, 1) if positive_delta and row["delta"] > 0 else 0
    segment_rows.sort(key=lambda item: (item["contribution"], item["delta"]), reverse=True)

    current = aggregate_safety(recent)
    previous_item = aggregate_safety(previous)
    funnel = [
        {"step": "Exposure", "value": current["exposures"], "baseline": previous_item["exposures"]},
        {"step": "Report", "value": current["reports"], "baseline": previous_item["reports"]},
        {"step": "Model Hit", "value": current["model_hits"], "baseline": previous_item["model_hits"]},
        {"step": "Human Review", "value": current["human_reviews"], "baseline": previous_item["human_reviews"]},
        {"step": "Enforcement", "value": current["enforcements"], "baseline": previous_item["enforcements"]},
        {"step": "Appeal Success", "value": current["appeal_success"], "baseline": previous_item["appeal_success"]},
    ]

    return {
        "latest_date": latest,
        "metric": metric,
        "metric_label": SAFETY_METRIC_LABELS[metric],
        "days": days,
        "surface": surface,
        "segments": segment_rows[:12],
        "funnel": funnel,
        "summary": {
            "current": round(float(current[metric]) if metric in current else segment_rate(recent, metric), 2),
            "baseline": round(float(previous_item[metric]) if metric in previous_item else segment_rate(previous, metric), 2),
            "delta_pct": pct_delta(
                float(current[metric]) if metric in current else segment_rate(recent, metric),
                float(previous_item[metric]) if metric in previous_item else segment_rate(previous, metric),
            ),
        },
    }


class AttributionHandler(BaseHTTPRequestHandler):
    server_version = "SafetyPulse/0.2"

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()

    def do_HEAD(self) -> None:
        # Render health-check uses HEAD — respond 200 OK with no body
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/health":
                self.send_json({"ok": True, "app": "SafetyPulse", "db": str(DB_PATH)})
            elif parsed.path == "/api/events":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["100"])[0])
                self.send_json({"events": load_events(limit=max(1, min(limit, 500)))})
            elif parsed.path == "/api/summary":
                self.send_json(summarize_events(load_events()))
            elif parsed.path == "/api/attribution":
                params = parse_qs(parsed.query)
                model = params.get("model", ["last_touch"])[0]
                dimension = params.get("dimension", ["campaign"])[0]
                conversion_event = params.get("conversion_event", ["purchase"])[0]
                lookback_days = int(params.get("lookback_days", ["30"])[0])
                self.send_json(compute_attribution(load_events(), model, dimension, conversion_event, lookback_days))
            elif parsed.path == "/api/safety/summary":
                params = parse_qs(parsed.query)
                days = int(params.get("days", ["7"])[0])
                surface = params.get("surface", ["all"])[0]
                self.send_json(summarize_safety(days=days, surface=surface))
            elif parsed.path == "/api/safety/anomalies":
                params = parse_qs(parsed.query)
                lookback_days = int(params.get("lookback_days", ["14"])[0])
                self.send_json(detect_safety_anomalies(lookback_days=lookback_days))
            elif parsed.path == "/api/safety/root-cause":
                params = parse_qs(parsed.query)
                metric = params.get("metric", ["violation_rate"])[0]
                days = int(params.get("days", ["7"])[0])
                surface = params.get("surface", ["all"])[0]
                self.send_json(root_cause_safety(metric=metric, days=days, surface=surface))
            elif parsed.path == "/api/safety/actions":
                ensure_safety_seeded()
                self.send_json({"actions": load_safety_actions()})
            elif parsed.path == "/api/safety/accounts":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["30"])[0])
                surface = params.get("surface", ["all"])[0]
                region = params.get("region", ["all"])[0]
                policy = params.get("policy", ["all"])[0]
                self.send_json(
                    {
                        "accounts": load_safety_accounts(
                            limit=limit,
                            surface=surface,
                            region=region,
                            policy=policy,
                        )
                    }
                )
            elif parsed.path == "/api/safety/trends":
                params = parse_qs(parsed.query)
                metric = params.get("metric", ["violation_rate"])[0]
                days = int(params.get("days", ["30"])[0])
                surface = params.get("surface", ["all"])[0]
                self.send_json(safety_trends(metric=metric, days=days, surface=surface))
            else:
                self.serve_static(parsed.path)
        except Exception as exc:  # noqa: BLE001 - HTTP boundary should return JSON errors.
            self.send_json({"error": str(exc)}, status=500)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/events":
                self.send_json(insert_events(self.read_json()), status=202)
            elif parsed.path == "/api/demo":
                params = parse_qs(parsed.query)
                if params.get("reset", ["true"])[0].lower() != "false":
                    clear_events()
                result = insert_events(demo_payload())
                result.pop("events", None)
                result["summary"] = summarize_events(load_events())
                self.send_json(result, status=201)
            elif parsed.path == "/api/safety/seed":
                params = parse_qs(parsed.query)
                reset = params.get("reset", ["true"])[0].lower() != "false"
                result = seed_safety_demo(reset=reset)
                result["summary"] = summarize_safety(days=7)
                self.send_json(result, status=201)
            else:
                self.send_json({"error": "not found"}, status=404)
        except Exception as exc:  # noqa: BLE001
            self.send_json({"error": str(exc)}, status=400)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/events":
            deleted = clear_events()
            self.send_json({"deleted": deleted})
        else:
            self.send_json({"error": "not found"}, status=404)

    def read_json(self) -> Any:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def serve_static(self, request_path: str) -> None:
        relative = unquote(request_path).lstrip("/") or "index.html"
        candidate = (STATIC_ROOT / relative).resolve()
        if STATIC_ROOT.resolve() not in candidate.parents and candidate != STATIC_ROOT.resolve():
            self.send_error(403)
            return
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if not candidate.exists():
            self.send_error(404)
            return

        body = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))


def main() -> None:
    init_db()
    ensure_safety_seeded()
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), AttributionHandler)