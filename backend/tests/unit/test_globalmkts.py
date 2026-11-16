"""Global markets: hours and sessions, quotes from real captured Yahoo one-minute bars, the store, the RSS and calendar parsers, the service and its API.

Fixtures in tests/fixtures/global are real responses captured from the server on 15 Nov 2026 (Yahoo bars trimmed to the reference session, the latest session
sampled; three RSS feeds trimmed to their first items; the whole Forex Factory weekly feed).
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.globalmkts import calendar_feed, headsup, news, nseix
from app.globalmkts.quotes import Bar, bars_from_frame, build_quote
from app.globalmkts.service import GlobalService
from app.globalmkts.store import GlobalStore
from app.globalmkts.symbols import BY_KEY, BY_YAHOO, chart_url, expected_open, session_key
from tests.conftest import make_app

FIX = Path(__file__).parent.parent / "fixtures" / "global"
NY, TOKYO = ZoneInfo("America/New_York"), ZoneInfo("Asia/Tokyo")
SUNDAY_EVENING = datetime(2026, 11, 15, 18, 30, tzinfo=UTC)  # when the fixtures were captured (the futures were closed)


def yahoo_frame(symbols: list[str] | None = None) -> Any:
    raw = json.loads((FIX / "yahoo_1m.json").read_text())
    parts = {}
    for y, rows in raw.items():
        if symbols is not None and y not in symbols:
            continue
        idx = pd.DatetimeIndex([datetime.fromisoformat(t) for t, _ in rows])
        parts[y] = pd.DataFrame({"Close": [p for _, p in rows], "Open": [p for _, p in rows]}, index=idx)
    return pd.concat(parts, axis=1)


# ------------------------------------------------------------------ hours and sessions
def test_a_futures_session_runs_from_the_evening_before_and_a_cash_session_is_its_day() -> None:
    es, spx = BY_KEY["ES"], BY_KEY["SPX"]
    # Sunday 18:00 New York time reopens the week: that bar belongs to Monday's session; Friday 16:59 is Friday's
    assert session_key(es, datetime(2026, 11, 15, 18, 0, tzinfo=NY)) == "2026-11-16"
    assert session_key(es, datetime(2026, 11, 13, 16, 59, tzinfo=NY)) == "2026-11-13"
    assert session_key(es, datetime(2026, 11, 12, 18, 5, tzinfo=NY)) == "2026-11-13"  # Thursday evening starts Friday's session
    assert session_key(spx, datetime(2026, 11, 13, 15, 59, tzinfo=NY)) == "2026-11-13"


def test_expected_hours_of_futures_cash_markets_and_a_lunch_break() -> None:
    es, spx, nik = BY_KEY["ES"], BY_KEY["SPX"], BY_KEY["N225"]
    assert not expected_open(es, datetime(2026, 11, 14, 12, 0, tzinfo=NY))  # Saturday
    assert not expected_open(es, datetime(2026, 11, 13, 17, 5, tzinfo=NY))  # Friday after the close
    assert not expected_open(es, datetime(2026, 11, 15, 17, 59, tzinfo=NY))  # Sunday before the reopen
    assert expected_open(es, datetime(2026, 11, 15, 18, 1, tzinfo=NY))
    assert not expected_open(es, datetime(2026, 11, 16, 17, 30, tzinfo=NY))  # the daily break
    assert expected_open(es, datetime(2026, 11, 16, 3, 0, tzinfo=NY))  # overnight, which is the Indian morning
    assert expected_open(spx, datetime(2026, 11, 16, 10, 0, tzinfo=NY)) and not expected_open(spx, datetime(2026, 11, 16, 3, 0, tzinfo=NY))
    assert expected_open(nik, datetime(2026, 11, 16, 10, 0, tzinfo=TOKYO)) and not expected_open(nik, datetime(2026, 11, 16, 12, 0, tzinfo=TOKYO))


# ------------------------------------------------------------------ quotes from real bars
def test_bars_are_read_from_a_yahoo_frame_in_order_and_empty_or_missing_symbols_give_none() -> None:
    frame = yahoo_frame()
    bars = bars_from_frame(frame, "ES=F")
    assert bars and [b.ts for b in bars] == sorted(b.ts for b in bars)
    assert all(b.ts.tzinfo is not None and b.close > 0 for b in bars)
    assert bars_from_frame(frame, "NOPE") == [] and bars_from_frame(None, "ES=F") == []


def test_an_index_future_is_measured_from_the_cash_close_of_the_previous_session() -> None:
    q = build_quote(BY_KEY["ES"], bars_from_frame(yahoo_frame(), "ES=F"), SUNDAY_EVENING)
    assert q is not None
    # the last bar of Friday 13 Nov is 16:59 New York time = 21:59 UTC at 7583.00; the bar of Thursday 15:59 (20:59 UTC) closed at 7616.25, the cash close level
    assert q.price == 7583.0 and q.bar_ts == datetime(2026, 11, 13, 21, 59, tzinfo=UTC)
    assert q.prev_close == 7616.25 and q.prev_ts == datetime(2026, 11, 12, 20, 59, tzinfo=UTC)
    assert q.change == pytest.approx(7583.0 - 7616.25) and q.change_pct == pytest.approx((7583.0 - 7616.25) / 7616.25 * 100)  # -33.25 points, -0.4366 %
    assert q.session == "2026-11-13" and q.status == "closed"  # the market is shut on a Sunday afternoon
    assert q.as_of == datetime(2026, 11, 13, 22, 0, tzinfo=UTC) and q.age_s == (SUNDAY_EVENING - q.as_of).total_seconds()


def test_a_cash_index_and_a_yield_use_the_last_bar_of_the_previous_session() -> None:
    frame = yahoo_frame()
    spx = build_quote(BY_KEY["SPX"], bars_from_frame(frame, "^GSPC"), SUNDAY_EVENING)
    nik = build_quote(BY_KEY["N225"], bars_from_frame(frame, "^N225"), SUNDAY_EVENING)
    tnx = build_quote(BY_KEY["US10Y"], bars_from_frame(frame, "^TNX"), SUNDAY_EVENING)
    assert spx and spx.price == pytest.approx(7560.8701171875) and spx.prev_close == pytest.approx(7591.85986328125)
    assert nik and nik.price == pytest.approx(61156.08984375) and nik.prev_close == pytest.approx(60798.83984375) and nik.change and nik.change > 0
    assert tnx and tnx.change == pytest.approx(5.154000282287598 - 5.102999687194824)  # +0.051 percentage points = +5.1 basis points


def test_a_fresh_bar_is_live_an_old_one_on_a_trading_day_is_stale_and_no_bars_give_no_quote() -> None:
    bars = bars_from_frame(yahoo_frame(["ES=F"]), "ES=F")
    monday = datetime(2026, 11, 16, 9, 0, tzinfo=UTC)
    assert build_quote(BY_KEY["ES"], bars, datetime(2026, 11, 13, 21, 59, 30, tzinfo=UTC)) is not None
    live = build_quote(BY_KEY["ES"], [Bar(monday.replace(minute=0), 7500.0)], monday.replace(minute=2))
    assert live and live.status == "live" and live.age_s == 60.0  # the bar of 09:00 is complete at 09:01
    stale = build_quote(BY_KEY["ES"], [Bar(monday.replace(minute=0), 7500.0)], monday.replace(minute=30))
    assert stale and stale.status == "stale"  # the futures should be trading but no bar for 29 minutes
    assert build_quote(BY_KEY["ES"], [], monday) is None


def test_the_reference_close_can_come_from_stored_bars_when_only_todays_were_fetched() -> None:
    bars = bars_from_frame(yahoo_frame(["ES=F"]), "ES=F")
    latest = [b for b in bars if session_key(BY_KEY["ES"], b.ts) == "2026-11-13"]
    older = [b for b in bars if session_key(BY_KEY["ES"], b.ts) == "2026-11-12"]
    q = build_quote(BY_KEY["ES"], latest, SUNDAY_EVENING, older)
    assert q and q.prev_close == 7616.25
    assert build_quote(BY_KEY["ES"], latest, SUNDAY_EVENING).prev_close is None  # type: ignore[union-attr] - without the earlier session there is no reference: no change is shown


# ------------------------------------------------------------------ the store and the service
def service(tmp_path: Path, frames: list[Any] | None = None, fetch: Any = None, now: datetime = SUNDAY_EVENING) -> tuple[GlobalService, list[str]]:
    periods: list[str] = []
    frame = yahoo_frame()

    def download(tickers: list[str], period: str) -> Any:
        periods.append(period)
        if frames is not None and len(periods) <= len(frames) and isinstance(frames[len(periods) - 1], Exception):
            raise frames[len(periods) - 1]
        return frame

    def http(url: str) -> bytes:
        name = {"1977021501": "et_markets.xml", "business": "bbc_business.xml", "10000664": "cnbc_finance.xml", "thisweek": "ff_thisweek.json", "biquote.io": "biquote_calendar.json", "derivatives-watch": "nseix_derivatives_watch.json"}
        for k, f in name.items():
            if k in url:
                return (FIX / f).read_bytes()
        raise OSError("not in the fixtures: " + url)

    syms = [BY_YAHOO[y] for y in ("ES=F", "^GSPC", "^N225", "^TNX")]
    return GlobalService(GlobalStore(tmp_path), downloader=download, fetch=fetch or http, clock=lambda: now, symbols=syms, daily=lambda tickers, period: None), periods


def test_a_poll_stores_quotes_and_bars_once_and_reports_what_was_missing(tmp_path: Path) -> None:
    s, periods = service(tmp_path)
    r = s.poll_quotes()
    assert r["ok"] and r["symbols"] == 4 and r["missing"] == [] and r["new_bars"] > 0
    latest = s.store.latest_all()
    assert latest["ES"]["price"] == 7583.0 and latest["ES"]["prev_close"] == 7616.25 and latest["ES"]["status"] == "closed"
    again = s.poll_quotes()
    assert again["new_bars"] == 0  # the same bars are not stored twice
    assert periods == ["5d", "1d"]  # the first poll reaches back two sessions, the next only today


def test_a_failed_download_is_recorded_and_leaves_the_stored_quotes_alone(tmp_path: Path) -> None:
    s, _ = service(tmp_path)
    s.poll_quotes()
    before = s.store.latest_all()["ES"]
    s2, _ = service(tmp_path, frames=[ConnectionError("no route")])
    s2.store = s.store
    r = s2.poll_quotes()
    assert not r["ok"] and "ConnectionError" in r["error"]
    assert s.store.latest_all()["ES"] == before
    last = s.store.last_run("quotes")
    assert last and not last["ok"]
    ov = s2.overview()
    assert ov["meta"]["last_error"] and "ConnectionError" in ov["meta"]["last_error"]


def test_the_overview_groups_the_symbols_with_age_status_change_and_a_sparkline(tmp_path: Path) -> None:
    s, _ = service(tmp_path)
    s.poll_quotes()
    ov = s.overview()
    fut = next(g for g in ov["groups"] if g["key"] == "us_futures")["items"]
    es = next(i for i in fut if i["key"] == "ES")
    assert es["price"] == 7583.0 and es["status"] == "closed" and es["change"] == pytest.approx(-33.25) and es["spark"]
    assert [i["key"] for i in fut] == ["ES"]  # only the symbols the service polls are listed
    tnx = next(i for g in ov["groups"] for i in g["items"] if i["key"] == "US10Y")
    assert tnx["bp"] == pytest.approx(5.1, abs=0.05)  # a yield change in basis points
    assert ov["meta"]["last_poll_ok"] and not ov["meta"]["stale"]
    series = s.series("ES", hours=2)
    assert series["prices"] and len(series["times"]) == len(series["prices"]) and series["prices"][-1] == 7583.0
    assert s.series("NOPE")["error"]


# ------------------------------------------------------------------ news and calendar parsers
def test_rss_feeds_are_parsed_to_headline_summary_link_and_utc_time() -> None:
    for fixture, feed in (("et_markets.xml", news.FEEDS[1]), ("bbc_business.xml", news.FEEDS[6]), ("cnbc_finance.xml", news.FEEDS[7])):
        items, skipped = news.parse_rss((FIX / fixture).read_bytes(), feed)
        assert items and skipped == 0
        for it in items:
            assert it["title"] and it["link"].startswith("http") and it["id"] and it["region"] == feed.region and it["source"] == feed.source
            assert "<" not in it["summary"] and len(it["summary"]) <= news.SUMMARY_MAX
            assert it["published"] > 1_700_000_000_000  # a date in 2023 or later, in milliseconds
    # ET carries IST offsets: one item's pubDate is converted to UTC, hand-checked against the raw text
    raw = (FIX / "et_markets.xml").read_text()
    first_date = raw.split("<pubDate>")[1].split("</pubDate>")[0]
    items, _ = news.parse_rss((FIX / "et_markets.xml").read_bytes(), news.FEEDS[1])
    from email.utils import parsedate_to_datetime

    assert items[0]["published"] == int(parsedate_to_datetime(first_date).timestamp() * 1000)


def test_a_feed_item_without_a_date_or_link_is_skipped_and_counted_and_a_repeated_headline_summary_is_dropped() -> None:
    xml = (
        b"<rss><channel>"
        b"<item><title>Has everything</title><link>https://x.test/a</link><pubDate>Sun, 15 Nov 2026 22:00:00 +0530</pubDate><description>Has everything</description></item>"
        b"<item><title>No date</title><link>https://x.test/b</link></item>"
        b"<item><title>No link</title><pubDate>Sun, 15 Nov 2026 22:00:00 +0530</pubDate></item>"
        b"<item><title>Real summary</title><link>https://x.test/c</link><pubDate>Sun, 15 Nov 2026 22:00:00 +0530</pubDate><description>&lt;p&gt;Tags &amp;amp; entities go.&lt;/p&gt;</description></item>"
        b"</channel></rss>"
    )
    items, skipped = news.parse_rss(xml, news.FEEDS[0])
    assert [i["title"] for i in items] == ["Has everything", "Real summary"] and skipped == 2
    assert items[0]["summary"] == "" and items[1]["summary"] == "Tags & entities go."
    assert items[0]["published"] == int(datetime(2026, 11, 15, 16, 30, tzinfo=UTC).timestamp() * 1000)  # 22:00 IST is 16:30 UTC


def test_the_forex_factory_feed_keeps_high_and_medium_events_with_utc_times_and_country_names() -> None:
    ev = calendar_feed.parse_ff((FIX / "ff_thisweek.json").read_bytes())
    raw = json.loads((FIX / "ff_thisweek.json").read_text())
    assert len(ev) == sum(1 for r in raw if r["impact"] in ("High", "Medium"))  # 14 High + 14 Medium in this capture
    cpi = next(e for e in ev if e["name"] == "CPI m/m" and e["country"] == "Canada")
    assert cpi["impact"] == "high" and cpi["ts"] == int(datetime(2026, 11, 16, 13, 30, tzinfo=UTC).timestamp() * 1000)  # 08:30 New York time
    assert cpi["date_ist"] == "2026-11-16" and cpi["id"].startswith("ff:") and cpi["source"] == calendar_feed.FF_LABEL
    assert len({e["id"] for e in ev}) == len(ev)  # stable and distinct ids
    assert calendar_feed.parse_ff(b"[]") == [] and calendar_feed.parse_ff(b'{"not": "a list"}') == []


def test_the_official_calendar_is_read_with_its_own_sources_and_nothing_guessed() -> None:
    ev = calendar_feed.official_events()
    assert len(ev) >= 50 and all(e["id"].startswith("official:") and e["note"] for e in ev)
    assert any(e["country"] == "US" and "FOMC" in e["name"] for e in ev) and any(e["country"] == "India" and "RBI" in e["name"] for e in ev)


def test_events_are_updated_in_place_and_a_changed_time_or_forecast_is_a_revision(tmp_path: Path) -> None:
    store = GlobalStore(tmp_path)
    base = {"id": "ff:1", "source": "s", "ts": 1_700_000_000_000, "date_ist": "2023-11-14", "all_day": False, "country": "US", "name": "CPI", "impact": "high", "actual": None, "forecast": "0.3%", "previous": "0.4%", "note": None}
    t0 = datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
    assert store.upsert_events([base], t0) == {"new": 1, "changed": 0, "same": 0}
    assert store.upsert_events([base], t0) == {"new": 0, "changed": 0, "same": 1}
    moved = base | {"ts": base["ts"] + 3_600_000, "actual": "0.2%"}
    assert store.upsert_events([moved], t0) == {"new": 0, "changed": 1, "same": 0}
    rows = store.events_between(0, 2_000_000_000_000)
    assert len(rows) == 1 and rows[0]["actual"] == "0.2%" and rows[0]["ts"] == moved["ts"] and rows[0]["first_seen"] == int(t0.timestamp() * 1000)


# ------------------------------------------------------------------ the calendar and news views, and the API
def test_the_calendar_groups_high_impact_events_by_when_in_ist_with_countdowns(tmp_path: Path) -> None:
    now = datetime(2026, 11, 15, 19, 0, tzinfo=UTC)  # Monday 16 Nov 00:30 IST
    s, _ = service(tmp_path, now=now)
    s.poll_calendar()
    v = s.calendar_view()
    assert v["today"] == "2026-11-16"
    keys = [x["key"] for x in v["sections"]]
    assert keys == ["today", "tomorrow", "week", "nextweek", "month", "later"]
    today = next(x for x in v["sections"] if x["key"] == "today")["events"]
    cpi = next(e for e in today if e["name"] == "CPI m/m" and e["country"] == "Canada")
    assert cpi["time_ist"].startswith("2026-11-16T19:00") and cpi["state"] == "upcoming"
    assert cpi["minutes_to"] == round((datetime(2026, 11, 16, 13, 30, tzinfo=UTC) - now).total_seconds() / 60)  # 1110 minutes
    assert all(e["impact"] == "high" or (e["impact"] == "medium" and e["country"] == "India") for x in v["sections"] for e in x["events"])  # three-star, plus India two-star
    assert v["next"] and v["next"]["time_ist"] <= cpi["time_ist"]
    assert {x["name"] for x in v["sources"]} == {calendar_feed.OFFICIAL_LABEL, calendar_feed.FF_LABEL, calendar_feed.BQ_LABEL} and all(x["last_ok"] for x in v["sources"])


def test_a_calendar_feed_that_fails_is_recorded_and_the_events_already_stored_stay(tmp_path: Path) -> None:
    now = datetime(2026, 11, 15, 19, 0, tzinfo=UTC)
    s, _ = service(tmp_path, now=now)
    s.poll_calendar()
    before = len(s.store.events_between(0, 4_000_000_000_000))

    def broken(url: str) -> bytes:
        raise OSError("429 too many requests")

    s._fetch = broken  # noqa: SLF001
    r = s.poll_calendar()
    assert "errors" in r["feed"] and len(s.store.events_between(0, 4_000_000_000_000)) == before
    assert s.calendar_view()["sources"][1]["last_error"]


def test_news_polled_from_the_feeds_is_split_into_india_and_global_newest_first(tmp_path: Path) -> None:
    s, _ = service(tmp_path)
    r = s.poll_news()
    assert r["ok"] and r["added"] > 0
    assert any("error" in v for v in r["feeds"].values())  # the feeds that are not in the fixtures fail and are listed, the rest still load
    v = s.news_view()
    assert v["india"] and v["global"] and all(i["link"].startswith("http") for i in v["india"] + v["global"])
    assert [i["published"] for i in v["india"]] == sorted((i["published"] for i in v["india"]), reverse=True)
    assert {i["source"] for i in v["india"]} == {"Economic Times"} and {i["source"] for i in v["global"]} <= {"BBC News", "CNBC", "Economic Times"}
    assert v["meta"]["last_poll_ok"] and "Moneycontrol" not in json.dumps(v)


def test_the_api_serves_the_board_the_calendar_and_the_news(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    with TestClient(app) as c:
        svc, _ = service(tmp_path / "g")
        app.state.globalmkts = svc
        assert next(i for g in c.get("/api/global/overview").json()["groups"] for i in g["items"] if i["key"] == "ES")["price"] is None  # nothing polled yet: it says so
        svc.poll_quotes()
        svc.poll_news()
        svc.poll_calendar()
        ov = c.get("/api/global/overview").json()
        assert next(i for g in ov["groups"] for i in g["items"] if i["key"] == "ES")["price"] == 7583.0
        ser = c.get("/api/global/series", params={"symbol": "ES", "hours": 3}).json()
        assert ser["prices"] and ser["name"] == "S&P 500 futures"
        assert c.get("/api/global/series", params={"symbol": "ES", "hours": 500}).status_code == 422  # at most 168 hours (7 days, the retention)
        assert len(c.get("/api/calendar").json()["sections"]) == 6
        assert c.get("/api/news").json()["india"]


# ------------------------------------------------------------------ the optional local economic_calendar.json
LOCAL_DOC = {
    "status": "OK", "date": "2026-11-16", "total_events": 4,
    "events": [
        {"time_ist": "17:30", "country_code": "IND", "country_name": "India", "event": "WPI Inflation YoY", "impact": 3, "actual": "-", "previous": "1.2%", "consensus": "1.5%"},
        {"time_ist": "19:00", "country_code": "CAN", "country_name": "Canada", "event": "CPI Inflation MoM", "impact": 3, "actual": "-", "previous": "0.1%", "consensus": "0.3%"},
        {"time_ist": "-", "country_code": "USA", "country_name": "United States", "event": "Bank holiday", "impact": 2, "actual": "-", "previous": "-", "consensus": "-"},
        {"time_ist": "10:00", "country_code": "IND", "country_name": "India", "event": "Minor release", "impact": 1, "actual": "-", "previous": "-", "consensus": "-"},
    ],
}  # the layout of the user's export; the values are made up to exercise the reader, not market data


def test_a_local_file_is_read_with_missing_values_kept_missing_and_low_impact_dropped() -> None:
    ev = calendar_feed.parse_local(json.dumps(LOCAL_DOC).encode())
    assert [e["name"] for e in ev] == ["WPI Inflation YoY", "CPI Inflation MoM", "Bank holiday"]  # the one-star release is dropped
    wpi = ev[0]
    assert wpi["country"] == "India" and wpi["impact"] == "high" and wpi["actual"] is None and wpi["forecast"] == "1.5%" and wpi["previous"] == "1.2%"
    assert wpi["ts"] == int(datetime(2026, 11, 16, 12, 0, tzinfo=UTC).timestamp() * 1000)  # 17:30 IST
    assert ev[2]["all_day"] and ev[2]["country"] == "US" and ev[2]["impact"] == "medium" and ev[2]["forecast"] is None
    with pytest.raises(ValueError):
        calendar_feed.parse_local(b'{"events": "no"}')
    assert calendar_feed.parse_local(json.dumps({"events": [{"time_ist": "17:30", "event": "x", "impact": 3}]}).encode()) == []  # no date anywhere: skipped, not guessed


def test_without_the_file_nothing_changes_and_with_it_its_events_win_over_the_same_release(tmp_path: Path) -> None:
    now = datetime(2026, 11, 15, 19, 0, tzinfo=UTC)
    s, _ = service(tmp_path, now=now)
    s.poll_calendar()
    assert s.poll_local_calendar() is None  # no file: the other sources carry on alone
    base = s.calendar_view()
    assert [x["name"] for x in base["sources"]] == [calendar_feed.OFFICIAL_LABEL, calendar_feed.FF_LABEL, calendar_feed.BQ_LABEL]
    path = tmp_path / calendar_feed.LOCAL_NAME
    path.write_text(json.dumps(LOCAL_DOC))
    assert s.poll_local_calendar() == {"new": 3, "changed": 0, "same": 0}
    assert s.poll_local_calendar() is None  # unchanged file: not read again
    v = s.calendar_view()
    today = next(x for x in v["sections"] if x["key"] == "today")["events"]
    names = [(e["country"], e["name"], e["source"]) for e in today]
    assert ("India", "WPI Inflation YoY", calendar_feed.LOCAL_LABEL) in names
    canada = [n for n in names if n[0] == "Canada"]
    assert canada == [("Canada", "CPI Inflation MoM", calendar_feed.LOCAL_LABEL)]  # the Forex Factory CPI rows at the same minute are the same release
    assert [x["name"] for x in v["sources"]][-1] == calendar_feed.LOCAL_LABEL


def test_a_broken_local_file_is_reported_and_the_other_sources_stay(tmp_path: Path) -> None:
    s, _ = service(tmp_path)
    s.poll_calendar()
    (tmp_path / calendar_feed.LOCAL_NAME).write_text("{not json")
    r = s.poll_local_calendar()
    assert r and "error" in r
    v = s.calendar_view()
    assert v["sources"][-1]["last_error"] and v["sources"][-1]["name"] == calendar_feed.LOCAL_LABEL and sum(len(x["events"]) for x in v["sections"]) > 0


# ------------------------------------------------------------------ fresher news
def test_topics_are_found_by_whole_words_in_the_headline_and_summary() -> None:
    assert news.topics("Sensex, Nifty fall as Fed signals pause", "") == ["NIFTY", "Fed"]
    assert news.topics("RBI keeps repo rate unchanged", "Rupee steady, crude lower") == ["RBI", "Crude", "Rupee"]
    assert news.topics("Federation of traders meets", "A confederation of shops, Fedex parcels") == []  # "fed" inside another word does not count
    assert news.topics("Local football results", "") == []


def test_every_real_headline_in_the_fixtures_has_a_topics_list_and_a_fetch_time(tmp_path: Path) -> None:
    s, _ = service(tmp_path)
    s.poll_news()
    v = s.news_view()
    for it in v["india"] + v["global"]:
        assert isinstance(it["topics"], list) and it["fetched"].startswith("2026-11-15T18:30")


def test_an_unchanged_feed_is_not_parsed_again_and_the_validators_are_remembered(tmp_path: Path) -> None:
    s, _ = service(tmp_path)
    calls: list[dict[str, str] | None] = []

    def cond(url: str, validators: dict[str, str] | None) -> tuple[bytes | None, dict[str, str]]:
        calls.append(validators)
        if validators:
            return None, validators
        return (FIX / "bbc_business.xml").read_bytes(), {"etag": '"abc"'}

    s._cond = cond  # noqa: SLF001
    first = s.poll_news()
    assert first["added"] > 0 and calls and all(c is None for c in calls)
    second = s.poll_news()
    assert second["added"] == 0 and all(v == {"unchanged": True} for v in second["feeds"].values())
    assert all(c == {"etag": '"abc"'} for c in calls[len(calls) // 2 :])  # the second round sent the ETag each feed had given


def test_news_is_polled_every_two_minutes_in_indian_market_hours_and_every_ten_otherwise(tmp_path: Path) -> None:
    s, _ = service(tmp_path)
    assert s._news_interval(datetime(2026, 11, 16, 4, 30, tzinfo=UTC)) == 120.0  # Monday 10:00 IST  # noqa: SLF001
    assert s._news_interval(datetime(2026, 11, 16, 11, 0, tzinfo=UTC)) == 600.0  # 16:30 IST  # noqa: SLF001
    assert s._news_interval(datetime(2026, 11, 15, 5, 0, tzinfo=UTC)) == 600.0  # Sunday  # noqa: SLF001


# ------------------------------------------------------------------ biquote / MQL5 calendar (real response captured 15 Nov 2026)
def bq_events() -> list[dict[str, Any]]:
    return calendar_feed.parse_biquote((FIX / "biquote_calendar.json").read_bytes())


def test_biquote_rows_are_mapped_with_ist_dates_units_and_missing_kept_missing() -> None:
    ev = {(e["country"], e["name"], e["date_ist"]): e for e in bq_events()}
    rbi = ev[("India", "RBI Interest Rate Decision", "2026-12-04")]
    assert rbi["ts"] == int(datetime(2026, 12, 4, 4, 30, tzinfo=UTC).timestamp() * 1000) and rbi["impact"] == "medium"  # 04:30 UTC is 10:00 IST
    assert rbi["previous"] == "5.50%" and rbi["actual"] is None and rbi["forecast"] is None and not rbi["all_day"]
    cpi = ev[("India", "CPI y/y", "2026-11-12")]
    assert cpi["actual"] == "6.08%" and cpi["forecast"] is None and cpi["previous"] is None  # a reading the source did not publish is missing, not zero
    nfp = ev[("US", "Nonfarm Payrolls", "2026-12-04")]
    assert nfp["impact"] == "high" and nfp["actual"] is None and nfp["source"] == calendar_feed.BQ_LABEL
    wpi = ev[("India", "WPI y/y", "2026-11-16")]
    assert wpi["forecast"] == "7.46%" and wpi["previous"] == "11.39%"
    assert len({e["id"] for e in bq_events()}) == len(bq_events())


def test_biquote_values_carry_k_and_m_for_thousands_and_millions_and_bad_rows_are_skipped() -> None:
    raw = [
        {"id": "mql5:1", "time": "2026-11-12T15:00:00Z", "countryCode": "US", "name": "Existing Home Sales", "importance": "high", "type": "indicator", "unit": "none", "multiplier": "millions", "digits": 2, "actual": 3.75, "forecast": 4.04, "previous": 3.99, "timeMode": "exact"},
        {"id": "mql5:2", "time": "2026-11-13T13:30:00Z", "countryCode": "US", "name": "Initial Jobless Claims", "importance": "high", "type": "indicator", "unit": "none", "multiplier": "thousands", "digits": 0, "actual": 152, "forecast": None, "previous": 0, "timeMode": "exact"},
        {"id": "mql5:3", "time": "2026-11-14T00:00:00Z", "countryCode": "US", "name": "Placeholder time", "importance": "medium", "type": "event", "timeMode": "tentative"},
        {"id": "mql5:4", "time": "bad", "countryCode": "US", "name": "No time", "importance": "high", "type": "event"},
        {"id": "mql5:5", "time": "2026-11-14T00:00:00Z", "countryCode": "US", "name": "Holiday", "importance": "high", "type": "holiday"},
        {"id": "mql5:6", "time": "2026-11-14T00:00:00Z", "countryCode": "US", "name": "Minor", "importance": "low", "type": "indicator"},
        {"id": "mql5:7", "time": "2026-11-14T00:00:00Z", "countryCode": "TR", "name": "Other country", "importance": "high", "type": "indicator"},
    ]
    ev = {e["name"]: e for e in calendar_feed.parse_biquote(json.dumps(raw).encode())}
    assert set(ev) == {"Existing Home Sales", "Initial Jobless Claims", "Placeholder time"}
    assert (ev["Existing Home Sales"]["actual"], ev["Existing Home Sales"]["forecast"]) == ("3.75M", "4.04M")
    assert ev["Initial Jobless Claims"]["actual"] == "152K" and ev["Initial Jobless Claims"]["previous"] == "0K" and ev["Initial Jobless Claims"]["forecast"] is None  # a published zero stays zero
    assert ev["Placeholder time"]["all_day"] and ev["Placeholder time"]["note"]  # no clock shown for a placeholder time
    assert calendar_feed.parse_biquote(b'{"error": "Invalid importance"}') == []


def test_the_request_asks_for_india_and_us_at_medium_and_above_over_the_next_sixty_days() -> None:
    url = calendar_feed.bq_url(datetime(2026, 11, 15, 19, 0, tzinfo=UTC))
    assert url == "https://biquote.io/api/calendar?from=2026-11-16&to=2027-01-14&countries=IN,US&importance=medium&limit=500"  # importance is a minimum: "high,medium" is rejected by the API


def test_biquote_events_replace_the_same_release_from_the_official_list_and_forex_factory(tmp_path: Path) -> None:
    now = datetime(2026, 12, 1, 18, 0, tzinfo=UTC)  # Tuesday 1 Dec 23:30 IST: the RBI decision is later this week, the Fed decision next week
    s, _ = service(tmp_path, now=now)
    r = s.poll_calendar()
    assert r["biquote"]["new"] > 0
    v = s.calendar_view()
    rows = [e for x in v["sections"] for e in x["events"]]
    rbi = [e for e in rows if "RBI" in e["name"] and e["time_ist"].startswith("2026-12-04")]
    assert [(e["name"], e["source"], e["impact"]) for e in rbi] == [("RBI Interest Rate Decision", calendar_feed.BQ_LABEL, "high")]  # the official "RBI monetary policy decision" is the same release; biquote rates it medium, the page keeps the higher level
    fomc = [e for e in rows if e["time_ist"].startswith("2026-12-10T00:30") and e["country"] == "US"]
    assert any(e["name"] == "Fed Interest Rate Decision" for e in fomc) and not any(e["source"] == calendar_feed.OFFICIAL_LABEL for e in fomc)
    assert next(x for x in v["sources"] if x["name"] == calendar_feed.BQ_LABEL)["last_ok"]


def test_a_biquote_failure_is_recorded_and_the_other_sources_stay(tmp_path: Path) -> None:
    now = datetime(2026, 11, 15, 19, 0, tzinfo=UTC)
    s, _ = service(tmp_path, now=now)

    def broken(url: str) -> bytes:
        if "biquote" in url:
            raise OSError("503")
        return (FIX / "ff_thisweek.json").read_bytes()

    s._fetch = broken  # noqa: SLF001
    r = s.poll_calendar()
    assert "error" in r["biquote"] and r["feed"]["new"] > 0
    assert next(x for x in s.calendar_view()["sources"] if x["name"] == calendar_feed.BQ_LABEL)["last_error"]


def test_india_medium_releases_are_shown_with_their_two_star_rating_and_other_countries_medium_are_not(tmp_path: Path) -> None:
    s, _ = service(tmp_path, now=datetime(2026, 11, 15, 19, 0, tzinfo=UTC))  # Monday 16 Nov 00:30 IST
    s.poll_calendar()
    rows = [e for x in s.calendar_view()["sections"] for e in x["events"]]
    wpi = next(e for e in rows if e["country"] == "India" and e["name"] == "WPI y/y")
    assert wpi["impact"] == "medium" and wpi["forecast"] == "7.46%" and wpi["previous"] == "11.39%" and wpi["time_ist"].startswith("2026-11-16T12:00")  # 06:30 UTC
    assert any(e["country"] == "India" and e["name"] == "GDP y/y" for e in rows)
    assert not any(e["country"] != "India" and e["impact"] == "medium" for e in rows)  # a medium US or Canadian release stays out


def test_events_past_the_end_of_the_month_are_listed_under_coming_up(tmp_path: Path) -> None:
    s, _ = service(tmp_path, now=datetime(2026, 11, 15, 19, 0, tzinfo=UTC))  # Monday 16 Nov: the month ends 30 Nov
    s.poll_calendar()
    sec = {x["key"]: x["events"] for x in s.calendar_view()["sections"]}
    rbi = [e for e in sec["later"] if "RBI" in e["name"]]
    assert [(e["name"], e["time_ist"][:16], e["previous"], e["forecast"], e["actual"]) for e in rbi] == [("RBI Interest Rate Decision", "2026-12-04T10:00", "5.50%", None, None)]
    assert any(e["name"] == "Fed Interest Rate Decision" and e["time_ist"].startswith("2026-12-10T00:30") for e in sec["later"])
    assert not any(e["time_ist"] > "2026-12-31" for x in sec.values() for e in x)  # nothing beyond the 45-day horizon


# ------------------------------------------------------------------ GIFT Nifty (real NSE IX response captured 16 Nov 2026 01:50 IST)
GIFT_NOW = datetime(2026, 11, 15, 20, 30, tzinfo=UTC)  # Monday 16 Nov 02:00 IST


def test_gift_nifty_is_the_near_month_future_measured_from_the_exchange_previous_close() -> None:
    got = nseix.gift_quote((FIX / "nseix_derivatives_watch.json").read_bytes(), GIFT_NOW, BY_KEY["GIFT"])
    assert got is not None
    q, expiry = got
    assert expiry == "23 Nov 2026" and q.price == 25266 and q.prev_close == 25171.5
    assert q.change == pytest.approx(94.5) and q.change_pct == pytest.approx(94.5 / 25171.5 * 100)  # +0.3754 %, from the contract's own close, not the feed's column
    assert q.bar_ts == datetime(2026, 11, 13, 21, 14, tzinfo=UTC) and q.as_of == datetime(2026, 11, 13, 21, 14, 30, tzinfo=UTC)  # last trade 14 Nov 02:44:30 IST
    assert q.status == "closed" and q.session == "2026-11-13" and len(q.bars) == 1


def test_gift_nifty_rolls_to_the_next_contract_after_expiry_and_a_feed_without_a_trade_gives_no_quote() -> None:
    data = (FIX / "nseix_derivatives_watch.json").read_bytes()
    after = nseix.gift_quote(data, datetime(2026, 11, 24, 5, 0, tzinfo=UTC), BY_KEY["GIFT"])
    assert after and after[1] == "29 Dec 2026" and after[0].price == 25332.5 and after[0].prev_close == 25304
    untraded = {"data": [{"INSTRUMENTTYPE": "FUTIDX", "SYMBOL": "NIFTY", "LASTPRICE": 0, "EXPIRYDATE": "23-Nov-2026", "TIMESTMP": "14-Nov-2026 02:44:30"}]}
    assert nseix.gift_quote(json.dumps(untraded).encode(), GIFT_NOW, BY_KEY["GIFT"]) is None
    assert nseix.gift_quote(b'{"data": []}', GIFT_NOW, BY_KEY["GIFT"]) is None


def test_gift_nifty_trading_hours_cross_midnight() -> None:
    g = BY_KEY["GIFT"]
    ist = ZoneInfo("Asia/Kolkata")
    cases = [
        ((2026, 11, 16, 10, 0), True), ((2026, 11, 16, 16, 0), False), ((2026, 11, 16, 17, 0), True), ((2026, 11, 17, 2, 0), True),  # Monday: day session, break, evening session, into Tuesday
        ((2026, 11, 14, 2, 0), True), ((2026, 11, 14, 10, 0), False), ((2026, 11, 15, 2, 0), False), ((2026, 11, 16, 2, 0), False), ((2026, 11, 13, 18, 0), True), ((2026, 11, 14, 18, 0), False),
    ]
    for when, want in cases:
        assert expected_open(g, datetime(*when, tzinfo=ist)) is want, when


def test_gift_nifty_is_polled_stored_and_shown_with_its_contract_and_a_chart_link(tmp_path: Path) -> None:
    s = service(tmp_path, now=GIFT_NOW)[0]
    s.symbols = [BY_KEY["GIFT"], *s.symbols]
    assert s.poll_gift()["ok"]
    item = next(i for g in s.overview()["groups"] for i in g["items"] if i["key"] == "GIFT")
    assert item["price"] == 25266 and item["change"] == pytest.approx(94.5) and item["status"] == "closed" and item["chart_url"] == "https://www.nseix.com/get-quotes"
    assert "expires 23 Nov 2026" in item["note"] and "NSE IX" in item["note"]
    assert s.poll_quotes()["ok"] and "GIFT" not in s.poll_quotes().get("missing", [])  # the Yahoo poll leaves it alone


def test_a_gift_nifty_failure_is_recorded_and_the_stored_quote_stays(tmp_path: Path) -> None:
    s = service(tmp_path, now=GIFT_NOW)[0]
    s.symbols = [BY_KEY["GIFT"], *s.symbols]
    s.poll_gift()

    def down(url: str) -> bytes:
        raise OSError("503")

    s._fetch = down  # noqa: SLF001
    r = s.poll_gift()
    assert not r["ok"] and "OSError" in r["error"]
    assert s.store.latest_all()["GIFT"]["price"] == 25266


def test_every_symbol_has_a_full_chart_link_at_its_original_source() -> None:
    assert chart_url(BY_KEY["ES"]) == "https://finance.yahoo.com/quote/ES%3DF/"
    assert chart_url(BY_KEY["SPX"]) == "https://finance.yahoo.com/quote/%5EGSPC/"
    assert chart_url(BY_KEY["DXY"]) == "https://finance.yahoo.com/quote/DX-Y.NYB/"
    assert chart_url(BY_KEY["GIFT"]) == "https://www.nseix.com/get-quotes"


# ------------------------------------------------------------------ clean-up of days that have passed
def test_events_of_past_days_and_old_news_are_not_stored_and_are_deleted_when_their_day_passes(tmp_path: Path) -> None:
    now = datetime(2026, 11, 15, 19, 0, tzinfo=UTC)  # Monday 16 Nov 00:30 IST
    s, _ = service(tmp_path, now=now)
    s.poll_calendar()
    s.poll_news()
    all_events = s.store.events_between(0, 4_000_000_000_000)
    assert all_events and min(e["date_ist"] for e in all_events) >= "2026-11-16"  # the official list's earlier dates and the feeds' earlier days were not stored
    cutoff = int((now - timedelta(hours=48)).timestamp() * 1000)
    assert min(n["published"] for n in s.store.news("India", 500) + s.store.news("Global", 500)) >= cutoff
    # the clock moves on two days: yesterday's events and news older than 48 hours go, today's stay
    later = datetime(2026, 11, 17, 19, 0, tzinfo=UTC)  # Tuesday 18 Nov 00:30 IST
    s._clock = lambda: later  # noqa: SLF001
    before_ev, before_news = len(all_events), len(s.store.news("India", 500)) + len(s.store.news("Global", 500))
    res = s.cleanup()
    left = s.store.events_between(0, 4_000_000_000_000)
    assert res["events"] > 0 and min(e["date_ist"] for e in left) >= "2026-11-18" and len(left) == before_ev - res["events"]
    assert res["news"] > 0 and len(s.store.news("India", 500)) + len(s.store.news("Global", 500)) == before_news - res["news"]
    run = s.store.last_run("cleanup")
    assert run and run["ok"] and run["detail"]["events"] == res["events"] and run["detail"]["bytes"] > 0
    s.poll_calendar()
    s.poll_news()  # the feeds still carry the old items: they do not come back
    assert min(e["date_ist"] for e in s.store.events_between(0, 4_000_000_000_000)) >= "2026-11-18"
    assert all(n["published"] >= int((later - timedelta(hours=48)).timestamp() * 1000) for n in s.store.news("India", 500) + s.store.news("Global", 500))  # all fixture items are older: none stored


def test_prune_removes_the_revisions_of_deleted_events_and_leaves_bars_alone(tmp_path: Path) -> None:
    s, _ = service(tmp_path)
    s.poll_quotes()
    bars = s.store.bar_counts()
    base = {"id": "x:1", "source": "s", "ts": 1_700_000_000_000, "date_ist": "2026-11-10", "all_day": False, "country": "US", "name": "CPI", "impact": "high", "actual": None, "forecast": "0.3%", "previous": None, "note": None}
    t0 = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
    s.store.upsert_events([base], t0)
    s.store.upsert_events([base | {"actual": "0.2%"}], t0)  # a revision
    keep = base | {"id": "x:2", "date_ist": "2026-11-16"}
    s.store.upsert_events([keep], t0)
    out = s.store.prune("2026-11-16", 0)
    assert out == {"events": 1, "revisions": 1, "news": 0, "bars": 0}  # no bar cut-off given: bars are not touched
    assert [e["id"] for e in s.store.events_between(0, 4_000_000_000_000)] == ["x:2"]
    assert s.store.bar_counts() == bars  # price bars are not deleted by this clean-up


# ------------------------------------------------------------------ retention of price bars, health and robustness
def test_price_bars_older_than_seven_days_are_deleted_and_the_latest_quote_stays(tmp_path: Path) -> None:
    now = datetime(2026, 11, 22, 12, 0, tzinfo=UTC)
    s, _ = service(tmp_path, now=SUNDAY_EVENING)
    s.poll_quotes()  # bars of 12-13 Nov
    total = sum(s.store.bar_counts().values())
    latest = s.store.latest_all()
    s._clock = lambda: now  # noqa: SLF001  - nine days after the last bar
    res = s.cleanup()
    assert res["bars"] == total and sum(s.store.bar_counts().values()) == 0
    assert s.store.latest_all() == latest  # the board still has its last quotes, aged
    s._clock = lambda: datetime(2026, 11, 15, 20, 0, tzinfo=UTC)  # noqa: SLF001 - two days after the bars: all within seven days
    s.poll_quotes()
    kept = sum(s.store.bar_counts().values())
    assert kept > 0 and s.cleanup()["bars"] == 0 and sum(s.store.bar_counts().values()) == kept


def test_health_says_ok_stale_or_failing_per_job_with_the_database_size(tmp_path: Path) -> None:
    s, _ = service(tmp_path, now=SUNDAY_EVENING)
    h = s.health()
    assert h["status"] == "degraded" and {x["task"] for x in h["tasks"]} == {"quotes", "news", "calendar", "biquote", "local", "cleanup"}  # nothing has run, and the service has not been started
    s.poll_quotes()
    s.poll_news()
    s.poll_calendar()
    s.cleanup()
    h = s.health()
    assert h["status"] == "ok" and all(x["status"] == "ok" for x in h["tasks"]) and h["database"]["bytes"] > 0 and h["database"]["bars"] > 0
    assert h["retention"] == {"bars_days": 7, "news_hours": 48, "events": "days that have passed"}
    s._clock = lambda: SUNDAY_EVENING + timedelta(hours=1)  # noqa: SLF001
    stale = {x["task"]: x["status"] for x in s.health()["tasks"]}
    assert stale["quotes"] == "stale" and stale["news"] == "stale" and stale["calendar"] == "ok"  # 20 and 40 minute allowances, a 13 hour one for the calendar
    s._fails["news"] = 3  # noqa: SLF001
    assert next(x for x in s.health()["tasks"] if x["task"] == "news")["status"] == "failing"


def test_a_job_that_raises_does_not_stop_the_others_and_backs_off(tmp_path: Path) -> None:
    s, _ = service(tmp_path, now=SUNDAY_EVENING)
    ran: list[str] = []

    def boom() -> dict[str, object]:
        ran.append("boom")
        raise RuntimeError("disk is full")

    def fine() -> dict[str, object]:
        ran.append("fine")
        return {"ok": True}

    from app.globalmkts import service as svc_mod

    t_bad = svc_mod._Task("bad", "x", boom, lambda r: 0.0, 0.0, None)  # noqa: SLF001
    t_ok = svc_mod._Task("good", "y", fine, lambda r: 0.01, 0.0, None)  # noqa: SLF001

    async def go() -> None:
        tasks = [asyncio.create_task(s._run_task(t)) for t in (t_bad, t_ok)]  # noqa: SLF001
        await asyncio.sleep(0.5)
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(go())
    assert ran.count("boom") == 1  # backed off: the failing job is not retried at once
    assert ran.count("fine") >= 3 and s._fails["bad"] == 1 and s._fails["good"] == 0  # noqa: SLF001
    assert "disk is full" in s._last_error["bad"]  # noqa: SLF001


def test_a_damaged_database_file_is_moved_aside_and_a_fresh_one_started(tmp_path: Path) -> None:
    (tmp_path / "global.sqlite3").write_bytes(b"this is not a sqlite file" * 50)
    store = GlobalStore(tmp_path)
    assert store.counts() == {"bars": 0, "events": 0, "news": 0, "latest": 0}
    assert [p.name for p in tmp_path.glob("global.sqlite3.corrupt-*")]  # kept, not deleted


def test_the_api_serves_health_and_the_alert_list_names_a_stale_job(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    with TestClient(app) as c:
        svc, _ = service(tmp_path / "g", now=SUNDAY_EVENING)
        app.state.globalmkts = svc
        h = c.get("/api/global/health").json()
        assert h["status"] == "degraded" and h["database"]["bytes"] >= 0
        alerts = c.get("/api/ops/alerts").json()["alerts"]
        assert any(a["key"] == "global-quotes" and "stale" in a["text"] for a in alerts)


def test_a_poll_of_todays_bars_alone_keeps_the_stored_reference_close(tmp_path: Path) -> None:
    """A cash index on a weekend: the one-day download holds only Friday, so the previous session is not in it. The change must not turn into "no reference"."""
    s, _ = service(tmp_path)
    s.poll_quotes()  # the five-day poll: both sessions
    before = s.store.latest_all()["SPX"]
    assert before["prev_close"] == pytest.approx(7591.85986328125) and before["change"] == pytest.approx(-30.98974609375)
    frame = yahoo_frame()
    today_only = frame[frame.index >= pd.Timestamp("2026-11-13T00:00:00Z")]
    s._download = lambda tickers, period: today_only  # noqa: SLF001
    again = s.poll_quotes()
    after = s.store.latest_all()["SPX"]
    assert again["ok"] and after["prev_close"] == before["prev_close"] and after["change"] == pytest.approx(before["change"])
    assert next(i for g in s.overview()["groups"] for i in g["items"] if i["key"] == "SPX")["change"] == pytest.approx(-30.98974609375)


# ------------------------------------------------------------------ official closes of the cash indices (real Yahoo daily closes, captured 16 Nov 2026)
def daily_frame() -> Any:
    raw = json.loads((FIX / "yahoo_daily.json").read_text())
    parts = {y: pd.DataFrame({"Close": [c for _, c in rows]}, index=pd.DatetimeIndex([pd.Timestamp(d) for d, _ in rows])) for y, rows in raw.items()}
    return pd.concat(parts, axis=1)


def test_a_closed_cash_index_shows_its_official_close_and_the_previous_official_close(tmp_path: Path) -> None:
    s, _ = service(tmp_path)
    s._daily_dl = lambda tickers, period: daily_frame()  # noqa: SLF001
    s.poll_quotes()
    latest = s.store.latest_all()
    assert latest["SPX"]["price"] == pytest.approx(7561.669921875) and latest["SPX"]["prev_close"] == pytest.approx(7592.39990234375)
    assert latest["SPX"]["change"] == pytest.approx(7561.669921875 - 7592.39990234375)  # -30.73, as Yahoo's page shows (the last one-minute bar, 7560.87, is before the closing auction)
    assert latest["N225"]["price"] == pytest.approx(61142.3515625) and latest["N225"]["change"] == pytest.approx(61142.3515625 - 60819.359375)  # +322.99
    assert latest["ES"]["price"] == 7583.0 and latest["ES"]["prev_close"] == 7616.25  # futures are not cash indices: the one-minute quote stands


def test_a_cash_index_that_is_trading_keeps_its_live_one_minute_quote(tmp_path: Path) -> None:
    from dataclasses import replace

    s, _ = service(tmp_path)
    s._daily_dl = lambda tickers, period: daily_frame()  # noqa: SLF001
    s._refresh_official()  # noqa: SLF001
    spx = BY_KEY["SPX"]
    q = build_quote(spx, bars_from_frame(yahoo_frame(), "^GSPC"), SUNDAY_EVENING)
    assert q is not None
    live = replace(q, status="live")
    assert s._official_close(live, spx) is live  # noqa: SLF001
    assert s._official_close(q, spx).price == pytest.approx(7561.669921875)  # noqa: SLF001
    assert s._official_close(replace(q, session="2026-11-20"), spx).price == q.price  # noqa: SLF001 - no official close for that date yet


def test_a_failed_daily_download_leaves_the_one_minute_quotes_alone(tmp_path: Path) -> None:
    s, _ = service(tmp_path)

    def down(tickers: list[str], period: str) -> Any:
        raise ConnectionError("no route")

    s._daily_dl = down  # noqa: SLF001
    assert s.poll_quotes()["ok"]
    assert s.store.latest_all()["SPX"]["price"] == pytest.approx(7560.8701171875)  # the last one-minute bar


def test_a_chart_series_carries_the_previous_close_the_source_link_and_stays_light_over_days(tmp_path: Path) -> None:
    s, _ = service(tmp_path)
    s.poll_quotes()
    one = s.series("ES", hours=24)
    assert one["prev_close"] == 7616.25 and one["status"] == "closed" and one["source_url"] == "https://finance.yahoo.com/quote/ES%3DF/" and one["prices"][-1] == 7583.0
    # three days of one-minute bars (4,000+ points) are cut to at most 720, keeping the first and the last price exactly
    base = 1_800_000_000_000
    with __import__("sqlite3").connect(s.store.path) as c:
        c.executemany("INSERT OR IGNORE INTO bars VALUES (?,?,?)", [("NQ", base + i * 60_000, 28000 + (i % 50)) for i in range(4300)])
    many = s.series("NQ", hours=168)
    assert len(many["prices"]) <= 720 and len(many["times"]) == len(many["prices"])
    assert many["times"] == sorted(many["times"]) and many["prices"][-1] == 28000 + (4299 % 50)
    assert s.series("NOPE")["error"]


# ------------------------------------------------------------------ heads-up: event reminders and fresh news
def test_reminder_phases_start_three_days_out_come_daily_then_every_four_hours_with_a_final_one() -> None:
    assert headsup.phase_of(71.9) == "d3" and headsup.phase_of(48.1) == "d3"
    assert headsup.phase_of(47.9) == "d2" and headsup.phase_of(24.1) == "d2"
    assert [headsup.phase_of(h) for h in (23.9, 20.1, 19.9, 16.1, 12.0, 8.0, 4.0, 3.9, 1.1)] == ["h5", "h5", "h4", "h4", "h3", "h2", "h1", "h0", "h0"]
    assert headsup.phase_of(1.0) == "final" and headsup.phase_of(0.2) == "final"
    # ordered through the last day the phase changes exactly every 4 hours: a closed reminder returns on each change
    seen = [headsup.phase_of(h / 10) for h in range(240, 0, -1)]
    assert [p for i, p in enumerate(seen) if i == 0 or seen[i - 1] != p] == ["h5", "h4", "h3", "h2", "h1", "h0", "final"]


def test_only_market_moving_catalysts_get_a_reminder() -> None:
    yes = [("US", "Nonfarm Payrolls"), ("US", "Fed Interest Rate Decision"), ("US", "CPI y/y"), ("US", "Core PCE Price Index m/m"), ("US", "GDP q/q"), ("India", "WPI y/y"), ("India", "RBI Interest Rate Decision"), ("US", "Retail Sales m/m"), ("US", "FOMC Press Conference")]
    no = [("US", "EIA Crude Oil Stocks Change"), ("US", "Initial Jobless Claims"), ("US", "10-Year Note Auction"), ("US", "Philadelphia Fed Manufacturing Index"), ("US", "New Home Sales"), ("US", "ADP Nonfarm Employment Change")]
    assert all(headsup.is_catalyst({"country": c, "name": n}) for c, n in yes)
    assert not any(headsup.is_catalyst({"country": c, "name": n}) for c, n in no)


def test_reminders_for_the_next_three_days_carry_the_phase_previous_and_forecast(tmp_path: Path) -> None:
    # Tuesday 1 Dec 10:30 IST: the RBI decision (4 Dec 10:00 IST) is 71.5 hours away, the jobs report (4 Dec 19:00 IST) 80.5 hours: not yet
    s, _ = service(tmp_path, now=datetime(2026, 12, 1, 5, 0, tzinfo=UTC))
    s.poll_calendar()
    h = s.headsup()
    names = [(r["name"], r["phase"]) for r in h["reminders"]]
    assert ("RBI Interest Rate Decision", "d3") in names and not any("Nonfarm Payrolls" in n for n, _ in names)
    rbi = next(r for r in h["reminders"] if r["name"] == "RBI Interest Rate Decision")
    assert rbi["key"] == f"{rbi['event_id']}:d3" and rbi["previous"] == "5.50%" and rbi["forecast"] is None and rbi["minutes_to"] == 4290 and rbi["time_ist"].startswith("2026-12-04T10:00")
    assert not any("EIA" in n or "Jobless" in n for n, _ in names)  # three-star in the feed but not catalysts


def test_the_same_event_moves_through_the_phases_as_time_passes(tmp_path: Path) -> None:
    keys: list[str] = []
    for now, phase in [
        (datetime(2026, 12, 6, 19, 30, tzinfo=UTC), "d3"),   # Fed decision 9 Dec 19:00 UTC: 71.5 h
        (datetime(2026, 12, 7, 19, 30, tzinfo=UTC), "d2"),   # 47.5 h
        (datetime(2026, 12, 9, 2, 0, tzinfo=UTC), "h4"),     # 17 h
        (datetime(2026, 12, 9, 14, 30, tzinfo=UTC), "h1"),   # 4.5 h...
        (datetime(2026, 12, 9, 18, 30, tzinfo=UTC), "final"),  # 0.5 h
    ]:
        s, _ = service(tmp_path, now=now)
        s.poll_calendar()
        r = next(x for x in s.headsup()["reminders"] if x["name"] == "Fed Interest Rate Decision")
        assert r["phase"] == phase, (now, r["phase"])
        keys.append(r["key"])
    assert len(set(keys)) == 5  # each phase is a new reminder
    assert all(k.endswith(p) for k, p in zip(keys, ["d3", "d2", "h4", "h1", "final"], strict=True))


def test_a_past_event_and_one_beyond_three_days_have_no_reminder(tmp_path: Path) -> None:
    s, _ = service(tmp_path, now=datetime(2026, 12, 9, 19, 30, tzinfo=UTC))  # half an hour after the Fed decision
    s.poll_calendar()
    names = [r["name"] for r in s.headsup()["reminders"]]
    assert "Fed Interest Rate Decision" not in names
    s2, _ = service(tmp_path / "b", now=datetime(2026, 11, 20, 5, 0, tzinfo=UTC))  # 19 days before
    s2.poll_calendar()
    assert s2.headsup()["reminders"] == []


def test_fresh_market_moving_headlines_are_listed_newest_first_and_stale_or_untagged_ones_are_not(tmp_path: Path) -> None:
    now = datetime(2026, 11, 16, 5, 0, tzinfo=UTC)
    s, _ = service(tmp_path, now=now)

    def item(i: str, title: str, published_min_ago: int, fetched_min_ago: int) -> dict[str, Any]:
        return {"id": i, "source": "Economic Times", "region": "India", "section": "Markets", "title": title, "link": f"https://x.test/{i}", "summary": "",
                "published": int((now - timedelta(minutes=published_min_ago)).timestamp() * 1000), "_fetched": fetched_min_ago}

    rows = [
        item("a", "RBI keeps repo rate unchanged", 20, 10),  # fresh and tagged
        item("b", "Sensex jumps 500 points", 5, 2),  # fresher and tagged: first
        item("c", "Local fair opens", 5, 2),  # no topic
        item("d", "Fed signals a pause", 200, 5),  # published more than 3 hours ago
        item("e", "Crude falls on OPEC talk", 30, 60),  # stored more than 45 minutes ago
        item("f", "Gold edges higher", 40, 20),
        item("g", "Nifty ends flat", 50, 30),
        item("h", "Rupee steady", 55, 31),  # fourth fresh one: beyond the cap of three
    ]
    for r in rows:
        s.store.add_news([{k: v for k, v in r.items() if k != "_fetched"}], now - timedelta(minutes=r["_fetched"]))
    h = s.headsup()
    assert [n["key"] for n in h["news"]] == ["b", "a", "f"]
    assert h["news"][0]["topics"] == ["NIFTY"] and h["news"][0]["age_min"] == 5 and h["news"][0]["link"] == "https://x.test/b"


def test_the_api_serves_the_headsup(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    with TestClient(app) as c:
        svc, _ = service(tmp_path / "g", now=datetime(2026, 12, 1, 5, 0, tzinfo=UTC))
        app.state.globalmkts = svc
        svc.poll_calendar()
        body = c.get("/api/global/headsup").json()
        assert body["news"] == [] and any(r["name"] == "RBI Interest Rate Decision" and r["phase"] == "d3" for r in body["reminders"])
