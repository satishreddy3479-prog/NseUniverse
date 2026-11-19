"""A ledger of the places where the app overrides or substitutes what a source sent.

19 Nov 2026: the check that replaces a "frozen" index quote with the option-implied level fired 32 times in 33 minutes on a healthy quote and the only trace was a log line
nobody read. Anything that repairs, replaces or stands in for source data records here, and a rate above a threshold raises a warning in the app's alert list
(``/api/ops/alerts``). The ledger is in memory (counts per IST day and the last events); it starts empty after a restart, the log keeps the full history.
"""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
RECENT = 200

# kind -> (events in WINDOW_MIN minutes that raise a warning, what the kind means)
THRESHOLDS: dict[str, tuple[int, str]] = {
    "index_quote_replaced": (5, "the broker's index level was replaced by the option-implied level"),
    "index_snapshot_failed": (3, "a request for the index on demand failed"),
}
WINDOW_MIN = 60


@dataclass(frozen=True)
class Override:
    at: datetime
    kind: str
    detail: str


class OverrideLedger:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._events: deque[Override] = deque(maxlen=RECENT)
        self._days: dict[str, dict[str, int]] = {}

    def record(self, kind: str, detail: str = "", at: datetime | None = None) -> None:
        at = at or datetime.now(UTC)
        day = at.astimezone(IST).date().isoformat()
        with self._lock:
            self._events.append(Override(at, kind, detail))
            counts = self._days.setdefault(day, {})
            counts[kind] = counts.get(kind, 0) + 1
            for old in sorted(self._days)[:-7]:  # a week of daily counts is plenty
                del self._days[old]

    def counts(self, now: datetime | None = None) -> dict[str, dict[str, int]]:
        """Per kind: events today (IST) and in the last hour."""
        now = now or datetime.now(UTC)
        today = now.astimezone(IST).date().isoformat()
        since = now - timedelta(minutes=WINDOW_MIN)
        with self._lock:
            events = list(self._events)
            day = dict(self._days.get(today, {}))
        out: dict[str, dict[str, int]] = {}
        for kind, n in day.items():
            out[kind] = {"today": n, "last_hour": sum(1 for e in events if e.kind == kind and e.at >= since)}
        return out

    def recent(self, n: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            return [{"at": e.at.isoformat(), "kind": e.kind, "detail": e.detail} for e in list(self._events)[-n:]][::-1]

    def warnings(self, now: datetime | None = None) -> list[dict[str, str]]:
        """Alert-list entries (key, level, text) for the kinds whose hourly rate is above their threshold."""
        out = []
        for kind, c in self.counts(now).items():
            limit, meaning = THRESHOLDS.get(kind, (10, kind))
            if c["last_hour"] >= limit:
                out.append({"key": f"override-{kind}", "level": "warning",
                            "text": f"{c['last_hour']} times in the last hour ({c['today']} today) {meaning}. Overrides above {limit} an hour mean a source or a check is misbehaving: look at the log lines of this kind."})  # fmt: skip
        return out

    def reset(self) -> None:
        with self._lock:
            self._events.clear()
            self._days.clear()


ledger = OverrideLedger()
