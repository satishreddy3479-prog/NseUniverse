"""Global markets: hours and sessions, quotes from real captured Yahoo one-minute bars, the store, the RSS and calendar parsers, the service and its API.

Fixtures in tests/fixtures/global are real responses captured from the server on 15 Nov 2026 (Yahoo bars trimmed to the reference session, the latest session
sampled; three RSS feeds trimmed to their first items; the whole Forex Factory weekly feed).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.globalmkts import calendar_feed, news
from app.globalmkts.quotes import Bar, bars_from_frame, build_quote
from app.globalmkts.service import GlobalService
from app.globalmkts.store import GlobalStore
from app.globalmkts.symbols import BY_KEY, BY_YAHOO, expected_open, session_key
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
        name = {"1977021501": "et_markets.xml", "business": "bbc_business.xml", "10000664": "cnbc_finance.xml", "thisweek": "ff_thisweek.json", "biquote.io": "biquote_calendar.json"}
        for k, f in name.items():
            if k in url:
                return (FIX / f).read_bytes()
        raise OSError("not in the fixtures: " + url)

    syms = [BY_YAHOO[y] for y in ("ES=F", "^GSPC", "^N225", "^TNX")]
    return GlobalService(GlobalStore(tmp_path), downloader=download, fetch=fetch or http, clock=lambda: now, symbols=syms), periods


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
    assert keys == ["today", "tomorrow", "week", "nextweek", "month"]
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
        assert c.get("/api/global/series", params={"symbol": "ES", "hours": 500}).status_code == 422  # at most 72 hours
        assert len(c.get("/api/calendar").json()["sections"]) == 5
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
    assert url == "https://biquote.io/api/calendar?from=2026-11-14&to=2027-01-14&countries=IN,US&importance=medium&limit=500"  # importance is a minimum: "high,medium" is rejected by the API


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
