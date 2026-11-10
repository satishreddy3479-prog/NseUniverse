from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
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
        return Fetched(500, None, "HTTP 500") if "us_fed" in url or "Federal" in url else Fetched(200, GDELT)

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


def test_one_429_is_retried_once(tmp_path: Path) -> None:
    seen: list[str] = []

    def getter(url: str) -> Fetched:
        seen.append(url)
        return Fetched(429, None, "HTTP 429") if len(seen) == 1 else Fetched(200, GDELT)

    svc = NewsService(NewsStore(tmp_path), getter=getter, pause_s=0, clock=lambda: datetime(2026, 10, 29, 3, 0, tzinfo=UTC))
    assert svc.run()["problems"] == []
    assert len(seen) == 11  # ten requests plus the one retry


ARTICLES = json.dumps({"articles": [
    {"url": "https://example.com/a", "title": "Nifty  ends   higher on banks", "seendate": "20261110T103000Z", "domain": "example.com"},
    {"url": "https://example.org/b", "title": "Sensex slips", "seendate": "20261110T093000Z", "domain": "example.org"},
    {"url": "", "title": "no link", "seendate": "20261110T093000Z"},
    {"url": "https://example.net/c", "title": "", "seendate": "20261110T093000Z"},
    {"url": "https://example.net/d", "title": "bad date", "seendate": "yesterday"},
]}).encode()


def test_parse_articles_keeps_usable_headlines_only_and_tidies_titles() -> None:
    from app.prediction.news_service import parse_articles

    got = parse_articles(ARTICLES)
    assert [g[0] for g in got] == ["https://example.com/a", "https://example.org/b"]
    assert got[0][1] == "Nifty ends higher on banks" and got[0][3] == "2026-11-10T10:30:00+00:00" and got[0][2] == "example.com"


def test_headlines_are_stored_newest_first_deduplicated_and_survive_a_restart(tmp_path: Path) -> None:
    urls: list[str] = []

    def getter(url: str) -> Fetched:
        urls.append(url)
        return Fetched(500, None, "HTTP 500") if "Federal" in url else Fetched(200, ARTICLES if "artlist" in url else GDELT)

    t0 = datetime(2026, 11, 10, 11, 0, tzinfo=UTC)
    svc = NewsService(NewsStore(tmp_path), getter=getter, pause_s=0, clock=lambda: t0)
    r = svc.run_headlines()
    assert r["saved"] == 8 and any("us_fed headlines" in p for p in r["problems"])  # four themes x two usable articles; one theme failed
    assert all("mode=artlist" in u and "sort=datedesc" in u and "timespan=24h" in u for u in urls)
    h = svc.store.headlines(5)["india_markets"]
    assert [x["title"] for x in h] == ["Nifty ends higher on banks", "Sensex slips"]  # newest seen first
    assert svc.run_headlines()["saved"] == 0  # the same links are not stored twice
    assert svc.status()["headlines"]["india_markets"][0]["url"] == "https://example.com/a" and svc.status()["headlines_fetched"]
    # a restart: new object, empty memory, same store
    again = NewsService(svc.store, getter=getter, pause_s=0, clock=lambda: t0 + timedelta(minutes=30))
    assert again.headlines_due() is False  # fetched half an hour ago
    assert NewsService(svc.store, getter=getter, pause_s=0, clock=lambda: t0 + timedelta(minutes=61)).headlines_due() is True
    svc.run()
    assert NewsService(svc.store, getter=getter, pause_s=0, clock=lambda: t0 + timedelta(hours=1)).due() is False  # the daily-tone fetch is remembered too
