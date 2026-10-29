from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.prediction.events import EventCalendar
from app.prediction.news_service import NewsService, parse_timeline
from app.prediction.news_store import NewsStore
from app.prediction.sources.nse import Fetched

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


def test_parse_timeline() -> None:
    assert parse_timeline(GDELT) == {date(2026, 10, 27): -1.5, date(2026, 10, 28): -2.25}


def test_news_collection_is_append_only_and_reports_failures(tmp_path: Path) -> None:
    calls: list[str] = []

    def getter(url: str) -> Fetched:
        calls.append(url)
        return Fetched(429, None, "HTTP 429") if "us_fed" in url or "Federal" in url else Fetched(200, GDELT)

    now = datetime(2026, 10, 29, 3, 0, tzinfo=UTC)
    svc = NewsService(NewsStore(tmp_path), getter=getter, pause_s=0, clock=lambda: now)
    r = svc.run()
    assert r["saved"] > 0 and any("us_fed" in p for p in r["problems"])
    again = svc.run()  # same clock => same fetch stamp => nothing duplicated
    assert again["saved"] == 0
    later = NewsService(svc.store, getter=getter, pause_s=0, clock=lambda: datetime(2026, 10, 29, 15, 0, tzinfo=UTC))
    assert later.run()["saved"] > 0  # a later fetch is kept as a new record, the earlier one is not touched
    latest = svc.store.latest(7)["india_markets"]
    assert latest[0]["day"] == "2026-10-28" and latest[0]["tone"] == -2.25
    with pytest.raises(Exception, match="never changed"):
        svc.store._db.execute("UPDATE gdelt_daily SET tone=0")
