from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from app.prediction.events import EventCalendar

IST = ZoneInfo("Asia/Kolkata")


def test_fomc_decision_on_28_oct_is_inside_the_t1_window_for_the_28_oct_session() -> None:
    cal = EventCalendar.load()
    start = datetime(2026, 10, 28, 15, 30, tzinfo=IST)
    end = datetime(2026, 10, 29, 15, 30, tzinfo=IST)
    hits = cal.between(start, end)
    assert [e.kind for e in hits] == ["fomc"]
    assert hits[0].start.astimezone(IST).strftime("%H:%M") == "23:30"  # 14:00 EDT, before DST ends on 1 Nov


def test_fomc_time_follows_us_daylight_saving() -> None:
    cal = EventCalendar.load()
    dec = next(e for e in cal.events if e.id == "fomc-2026-12-09")
    assert dec.start.astimezone(IST).strftime("%Y-%m-%d %H:%M") == "2026-12-10 00:30"  # EST in December


def test_every_event_names_an_official_source_and_marks_unverified_times() -> None:
    raw = json.loads(Path("app/prediction/reference/events.json").read_text())
    for e in raw["events"]:
        assert e["source"] and e["impact"] in {"high", "medium"}
    assert not any(e["time_verified"] for e in raw["events"] if e["kind"] in {"fomc", "rbi", "data"})


def test_all_day_election_overlaps_any_window_touching_that_us_day() -> None:
    cal = EventCalendar.load()
    hits = cal.between(datetime(2026, 11, 3, 15, 30, tzinfo=IST), datetime(2026, 11, 4, 15, 30, tzinfo=IST))
    assert any(e.kind == "election" for e in hits)
    assert not any(e.kind == "election" for e in cal.between(datetime(2026, 11, 5, 0, 0, tzinfo=IST), datetime(2026, 11, 6, 0, 0, tzinfo=IST)))


GDELT = json.dumps({"timeline": [{"series": "Average Tone", "data": [{"date": "20261027T000000Z", "value": -1.5}, {"date": "20261028T000000Z", "value": -2.25}]}]}).encode()


ARTICLES = json.dumps({"articles": [
    {"url": "https://example.com/a", "title": "Nifty  ends   higher on banks", "seendate": "20261110T103000Z", "domain": "example.com"},
    {"url": "https://example.org/b", "title": "Sensex slips", "seendate": "20261110T093000Z", "domain": "example.org"},
    {"url": "", "title": "no link", "seendate": "20261110T093000Z"},
    {"url": "https://example.net/c", "title": "", "seendate": "20261110T093000Z"},
    {"url": "https://example.net/d", "title": "bad date", "seendate": "yesterday"},
]}).encode()


