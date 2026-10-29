"""Scheduled macro events (central banks, elections, key releases) from official calendars.

Events are known in advance, so using them is not look-ahead. They are NOT model inputs yet (too few
past occurrences to validate): they flag event risk next to a forecast and, for T+1 only, withhold a
directional call when a high-impact event falls between the reference close and the target close.
That rule is a precaution, not a validated improvement.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

REFERENCE = Path(__file__).parent / "reference" / "events.json"
IST = ZoneInfo("Asia/Kolkata")


@dataclass(frozen=True)
class Event:
    id: str
    name: str
    kind: str
    start: datetime  # aware, UTC
    end: datetime  # aware, UTC (== start unless all-day)
    impact: str
    time_verified: bool
    tentative: bool
    source: str

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "kind": self.kind, "impact": self.impact,
            "start_ist": self.start.astimezone(IST).isoformat(), "all_day": self.end > self.start,
            "time_verified": self.time_verified, "tentative": self.tentative, "source": self.source,
        }  # fmt: skip


class EventCalendar:
    def __init__(self, events: list[Event]) -> None:
        self.events = sorted(events, key=lambda e: e.start)

    @classmethod
    def load(cls, path: Path = REFERENCE) -> EventCalendar:
        raw = json.loads(path.read_text("utf-8"))
        out = []
        for e in raw["events"]:
            tz = ZoneInfo(e["tz"])
            hh, mm = (int(x) for x in e["time"].split(":"))
            d = date.fromisoformat(e["date"])
            start = datetime(d.year, d.month, d.day, hh, mm, tzinfo=tz).astimezone(UTC)
            end = (datetime(d.year, d.month, d.day, tzinfo=tz) + timedelta(days=1)).astimezone(UTC) if e["all_day"] else start
            out.append(Event(e["id"], e["name"], e["kind"], start, end, e["impact"], bool(e["time_verified"]), bool(e["tentative"]), e["source"]))
        return cls(out)

    def between(self, after: datetime, until: datetime) -> list[Event]:
        """Events that happen after ``after`` and no later than ``until`` (an all-day event counts if it overlaps)."""
        return [e for e in self.events if e.end > after and e.start <= until]

    def upcoming(self, now: datetime, days: int = 21) -> list[Event]:
        return self.between(now, now + timedelta(days=days))
