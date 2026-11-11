"""Why forecasts went unrecorded and inputs looked stale: holidays, restarts, partial refreshes, a training already running."""

from __future__ import annotations

import threading
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

pytest.importorskip("numpy")

from app.prediction.calendar import SessionCalendar  # noqa: E402
from app.prediction.features_multi import build_rows  # noqa: E402
from app.prediction.history_service import HistoryService  # noqa: E402
from app.prediction.history_store import HistoryStore  # noqa: E402
from app.prediction.research import FRESH_KEYS, PredictionResearch  # noqa: E402
from app.prediction.sources.yahoo import RawRow  # noqa: E402
from app.prediction.targets import Bar  # noqa: E402
from app.prediction.usmarket import is_us_session, last_us_session_on_or_before  # noqa: E402
from tests.unit.test_research import _all_series, _at, _Cal, _service, _walk  # noqa: E402

IST_OFFSET = timedelta(hours=5, minutes=30)


def ist(y: int, m: int, d: int, hh: int, mm: int = 0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=UTC) - IST_OFFSET


def nse_calendar(holidays: tuple[str, ...] = ("2026-11-10",)) -> SessionCalendar:
    d, out = date(2026, 9, 1), []
    hol = {date.fromisoformat(h) for h in holidays}
    while d < date(2027, 3, 1):
        if d.weekday() < 5 and d not in hol:
            out.append(d)
        d += timedelta(days=1)
    return SessionCalendar(out)


# ---------------------------------------------------------------- US trading days
def test_us_holidays_are_not_trading_days() -> None:
    assert not is_us_session(date(2026, 11, 26)) and not is_us_session(date(2026, 4, 3))  # Thanksgiving, Good Friday
    assert is_us_session(date(2026, 11, 25)) and not is_us_session(date(2026, 11, 28))
    assert last_us_session_on_or_before(date(2026, 11, 26)) == date(2026, 11, 25)
    assert last_us_session_on_or_before(date(2026, 11, 29)) == date(2026, 11, 27)  # Sunday: the Friday after Thanksgiving was open
    assert last_us_session_on_or_before(date(2026, 11, 27)) == date(2026, 11, 27)


# ---------------------------------------------------------------- features after an Indian holiday
def test_after_an_indian_holiday_the_models_see_the_world_session_that_traded_meanwhile() -> None:
    series = _all_series(260)
    nifty = series.pop("NIFTY50")
    hol = nifty[200].session  # the day India was shut: its bar is removed, the world's bars stay
    nifty_h = [b for b in nifty if b.session != hol]
    t = nifty[199].session  # the last session before the holiday
    for h in ("T1", "T5"):
        _, rows = build_rows(nifty_h, series, h)
        spx = series["SPX"]
        i = next(k for k, b in enumerate(spx) if b.session == hol)
        if h == "T1":
            names, _ = build_rows(nifty_h, series, h)
            ret = rows[t][names.index("spx_ret")]
            assert ret == pytest.approx(spx[i].close / spx[i - 1].close - 1)  # the S&P bar dated the holiday, not the one dated t
    # the bar dated after the holiday still moves nothing
    alt = {k: [b if b.session <= hol else Bar(b.session, b.open * 2, b.high * 2, b.low * 2, b.close * 2) for b in v] for k, v in series.items()}
    _, again = build_rows(nifty_h, alt, "T1")
    _, base = build_rows(nifty_h, series, "T1")
    assert again[t] == base[t]
    # and the bar dated the holiday does move it (so it is really used)
    alt2 = {k: [Bar(b.session, b.open * 2, b.high * 2, b.low * 2, b.close * 2) if b.session == hol else b for b in v] for k, v in series.items()}
    _, moved = build_rows(nifty_h, alt2, "T1")
    assert moved[t] != base[t]
    # an ordinary weekday and a weekend are unchanged by the rule: row t-1 (next session = t) uses bars dated t-1 itself
    _, rows2 = build_rows(nifty_h, alt2, "T1")
    assert rows2[nifty[150].session] == base[nifty[150].session]


def test_the_last_row_uses_the_calendar_for_its_next_session() -> None:
    series = _all_series(260)
    nifty = series.pop("NIFTY50")
    last = nifty[-1].session
    nxt = last + timedelta(days=4)  # pretend a holiday: the next session is four days on, so the world bars of the days between count
    extra = {k: [*v, Bar(last + timedelta(days=1), v[-1].close, v[-1].close * 1.06, v[-1].close * 0.99, v[-1].close * 1.05)] for k, v in series.items() if k in ("SPX", "NDX_COMP", "DJI", "VIX", "BRENT", "GOLD", "DXY", "USDINR", "UST10Y", "N225", "HSI", "SSEC", "DAX", "FTSE", "INDIAVIX")}
    series2 = {**series, **extra}
    names, with_cal = build_rows(nifty, series2, "T1", next_session=lambda d: nxt)
    _, without = build_rows(nifty, series2, "T1")
    assert with_cal[last][names.index("spx_ret")] == pytest.approx(0.05, abs=1e-9) and without[last][names.index("spx_ret")] != with_cal[last][names.index("spx_ret")]


# ---------------------------------------------------------------- freshness rule
def _research(tmp_path: Path, cal: SessionCalendar) -> PredictionResearch:
    from app.prediction.ledger import ForecastLedger

    return PredictionResearch(HistoryStore(tmp_path), ForecastLedger(tmp_path), calendar=cal, initial_train=200, test_size=60, cache_dir=None)


def _bars(last: date) -> list[Bar]:
    return [Bar(last, 1.0, 1.0, 1.0, 1.0)]


def test_an_indian_holiday_makes_the_models_wait_for_the_world_session_of_that_day(tmp_path: Path) -> None:
    r = _research(tmp_path, nse_calendar())
    ref = date(2026, 11, 9)  # Monday; Tuesday 10 Nov is an Indian holiday, so the next session is Wednesday 11
    assert r.cutoff_date(ref) == date(2026, 11, 10) and r.required_us_session(ref) == date(2026, 11, 10)
    stale_data = {k: _bars(date(2026, 11, 9)) for k in FRESH_KEYS}
    ok, stale = r._fresh(stale_data, ref, ist(2026, 11, 11, 8, 50))
    assert not ok and set(stale) == set(FRESH_KEYS)  # the S&P and the rest are a session behind: not usable
    fresh_data = {k: _bars(date(2026, 11, 10)) for k in FRESH_KEYS}
    assert r._fresh(fresh_data, ref, ist(2026, 11, 11, 8, 50)) == (True, [])
    ok2, why = r._fresh(fresh_data, ref, ist(2026, 11, 11, 0, 20))  # 00:20 IST: the US session of the 10th is still open
    assert not ok2 and "still open" in why[0]


def test_a_us_holiday_does_not_make_the_morning_stale(tmp_path: Path) -> None:
    r = _research(tmp_path, nse_calendar())
    ref = date(2026, 11, 26)  # Thursday, a normal Indian session; the US was shut (Thanksgiving)
    assert r.required_us_session(ref) == date(2026, 11, 25)
    data = {k: _bars(date(2026, 11, 25)) for k in FRESH_KEYS}
    assert r._fresh(data, ref, ist(2026, 11, 27, 8, 50)) == (True, [])  # Wednesday's bar is the newest there is: not "late"
    behind = {k: _bars(date(2026, 11, 24)) for k in FRESH_KEYS}
    assert not r._fresh(behind, ref, ist(2026, 11, 27, 8, 50))[0]  # a genuinely late feed is still caught


def test_an_ordinary_day_and_a_weekend_keep_the_old_requirement(tmp_path: Path) -> None:
    r = _research(tmp_path, nse_calendar())
    assert r.required_us_session(date(2026, 11, 11)) == date(2026, 11, 11)  # Wednesday -> Thursday
    assert r.required_us_session(date(2026, 11, 13)) == date(2026, 11, 13)  # Friday -> Monday: the Friday bar
    detail = r.freshness_detail({}, date(2026, 11, 13), ist(2026, 11, 16, 8, 50))
    assert detail["required_session"] == "2026-11-13" and set(detail["series"]) == set(FRESH_KEYS) and all(not s["ok"] for s in detail["series"].values())


# ---------------------------------------------------------------- the log tells the truth after a restart
def test_a_restart_does_not_turn_a_recorded_day_into_a_missed_one(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    nxt = _Cal().next_session(last)
    a, _ = _service(tmp_path, 560, _at(nxt, 8, 50))
    a.summary(block=True)
    assert a._ledger.counts()["T1"]["forecasts"] == 4
    # the program restarts after the window: new object, empty memory, the same stores
    from app.prediction.ledger import ForecastLedger

    b = PredictionResearch(a._store, ForecastLedger(tmp_path), calendar=_Cal(), clock=lambda: _at(nxt, 9, 20), initial_train=200, test_size=60, cache_dir=None, pause_in_market_hours=False)
    assert b._cache is None
    assert b.log_day(_at(nxt, 9, 20)) == 2
    days = {d["horizon"]: d for d in b._days.recent()}
    assert days["T1"]["status"] == "recorded" and 0 < days["T1"]["p_up"] < 1 and days["T1"]["model"] == "ensemble" and days["T1"]["reason"] is None
    assert b._recorded_today(_at(nxt, 8, 50)) is True and b.morning_ready(_at(nxt, 8, 50)) is False  # nothing left to do this morning


def test_a_missed_day_names_the_report_it_did_have(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    nxt = _Cal().next_session(last)
    svc, _ = _service(tmp_path, 560, _at(nxt, 8, 50), series_end_offset=1)
    svc.summary(block=True)
    svc._cache = None  # as after a restart; the disk copy answers
    svc.log_day(_at(nxt, 9, 20))
    d = {x["horizon"]: x for x in svc._days.recent()}["T1"]
    assert d["status"] == "missed" and "not yet in" in d["reason"] and "SPX" in d["stale"]


def test_a_forced_run_is_not_swallowed_by_a_training_that_was_already_running(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    nxt = _Cal().next_session(last)
    svc, _ = _service(tmp_path, 560, _at(nxt, 8, 50))
    other = threading.Thread(target=time.sleep, args=(0.4,))  # a training started by a data refresh before the window opened
    other.start()
    svc._worker = other
    s = svc.summary(force=True, block=True)
    assert s["ready"] and s["ledger"]["counts"]["T1"]["forecasts"] == 4  # it waited, then trained itself and recorded


# ---------------------------------------------------------------- the refresh looks at the data, not only the clock
def _gap_service(tmp_path: Path, cal: SessionCalendar | None, now: datetime) -> HistoryService:
    store = HistoryStore(tmp_path)
    svc = HistoryService(store, downloader=lambda *a: [], calendar=cal, clock=lambda: now, pause_between_s=0.0)
    return svc


def _store_bars(svc: HistoryService, keys: list[str], days: list[str]) -> None:
    for k in keys:
        svc.store.insert_bars(k, [RawRow(date.fromisoformat(d), 100, 101, 99, 100.5, None) for d in days], source="yahoo", run_id="r", now=datetime(2035, 1, 1, tzinfo=UTC))


OVERNIGHT = ["SPX", "VIX", "BRENT", "DXY", "USDINR", "UST10Y"]


def test_a_run_that_succeeded_for_most_symbols_does_not_end_the_day_when_nifty_is_still_missing(tmp_path: Path) -> None:
    now = ist(2026, 11, 11, 8, 0)  # Wednesday morning; Tuesday was a holiday, the last session was Monday 9 Nov
    svc = _gap_service(tmp_path, nse_calendar(), now)
    _store_bars(svc, ["NIFTY50"], ["2026-11-05", "2026-11-06"])  # the 9 Nov bar never arrived
    _store_bars(svc, OVERNIGHT, ["2026-11-09", "2026-11-10"])
    svc.store.start_run("r1", "yahoo", now - timedelta(minutes=12))
    svc.store.finish_run("r1", {"ok_symbols": 24, "failed_symbols": ["NIFTY50"]}, now - timedelta(minutes=11))  # "success": the old rule stops here
    assert svc.data_gaps(now) == ["NIFTY50 2026-11-09"]
    svc.last_attempt = None  # a restart forgot the last attempt; the run log still has it
    assert svc.due(now) is True  # 12 minutes in the morning window: look again
    svc.last_attempt = now - timedelta(minutes=5)
    assert svc.due(now) is False  # but never faster than every 10 minutes
    svc.last_attempt = now - timedelta(minutes=70)
    later = ist(2026, 11, 11, 14, 0)  # outside the morning window the spacing is an hour
    assert svc.due(later) is True
    svc.last_attempt = later - timedelta(minutes=30)
    assert svc.due(later) is False


def test_the_overnight_series_are_required_only_once_the_us_session_is_over_and_a_us_holiday_is_not_a_gap(tmp_path: Path) -> None:
    cal = nse_calendar()
    svc = _gap_service(tmp_path, cal, ist(2026, 11, 11, 0, 20))
    _store_bars(svc, ["NIFTY50"], ["2026-11-06", "2026-11-09"])
    _store_bars(svc, OVERNIGHT, ["2026-11-09"])
    assert svc.data_gaps(ist(2026, 11, 11, 0, 20)) == []  # the US session of the 10th is still open: nothing is expected yet
    gaps = svc.data_gaps(ist(2026, 11, 11, 3, 40))
    assert sorted(g.split()[0] for g in gaps) == sorted(OVERNIGHT) and all(g.endswith("2026-11-10") for g in gaps)
    _store_bars(svc, OVERNIGHT, ["2026-11-10"])
    assert svc.data_gaps(ist(2026, 11, 11, 3, 40)) == []
    # Thanksgiving: Thursday 26 Nov is a US holiday and an Indian session; Friday morning needs only Wednesday's US bar
    svc2 = _gap_service(tmp_path / "t", cal, ist(2026, 11, 27, 8, 0))
    _store_bars(svc2, ["NIFTY50"], ["2026-11-25", "2026-11-26"])
    _store_bars(svc2, OVERNIGHT, ["2026-11-24", "2026-11-25"])
    assert svc2.data_gaps(ist(2026, 11, 27, 8, 0)) == []


def test_without_a_calendar_only_the_clock_schedule_runs(tmp_path: Path) -> None:
    svc = _gap_service(tmp_path, None, ist(2026, 11, 11, 8, 0))
    assert svc.data_gaps(ist(2026, 11, 11, 8, 0)) == []
    assert "data_gaps" in svc.status()


# ---------------------------------------------------------------- "why is it still a preview?"
def test_a_forecast_locked_in_the_morning_window_is_shown_as_locked_at_any_later_time(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    nxt = _Cal().next_session(last)
    svc, _ = _service(tmp_path, 560, _at(nxt, 8, 50))
    first = svc.summary(block=True)
    assert all(m["recorded"] for m in first["forecasts"]["T1"]["models"].values())
    # three hours later the models are retrained (a data refresh, a restart, a manual compute): the window is closed, but the card must still say locked
    svc._clock = lambda: _at(nxt, 12, 0)
    later = svc.summary(force=True, block=True, trigger="manual")
    for h in ("T1", "T5"):
        for name, m in later["forecasts"][h]["models"].items():
            assert m["recorded"] is True and m.get("preview") is None and m["already_recorded"] is True and m["forecast_id"], (h, name)
    assert later["ledger"]["counts"]["T1"]["forecasts"] == 4  # nothing was recorded twice
    assert later["recording"]["state"] == "recorded" and "locked in the ledger" in later["recording"]["reason"]


def test_a_view_outside_the_window_without_a_locked_forecast_is_a_preview_and_says_why(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    nxt = _Cal().next_session(last)
    svc, _ = _service(tmp_path, 560, _at(nxt, 12, 0))
    s = svc.summary(block=True)
    m = s["forecasts"]["T1"]["models"]["ensemble"]
    assert m["recorded"] is False and m["preview"] is True and "08:35 and 09:10" in m["reason"]
    assert s["recording"]["state"] == "missed" and "window closed at 09:10" in s["recording"]["reason"] and "never recorded later" in s["recording"]["reason"]


def test_recording_status_names_each_stage_of_the_morning(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    nxt = _Cal().next_session(last)
    svc, _ = _service(tmp_path, 560, _at(nxt, 8, 50))
    assert svc.recording_status(_at(nxt, 7, 0))["state"] == "before_window" and svc.recording_status(_at(nxt, 8, 50))["state"] == "ready"
    late, _ = _service(tmp_path / "late", 560, _at(nxt, 8, 50), series_end_offset=1)  # an overnight series has not arrived
    w = late.recording_status(_at(nxt, 8, 50))
    assert w["state"] == "waiting_for_data" and "SPX" in w["stale_series"] and "checked every 4 minutes" in w["reason"]
    missed = late.recording_status(_at(nxt, 9, 30))
    assert missed["state"] == "missed" and "SPX" in missed["reason"]
    assert svc.recording_status(_at(last, 12, 0, days=1 if _Cal().is_session(last + timedelta(days=1)) else 0))["state"] in ("before_window", "missed", "ready", "recorded", "not_a_session_day")
    svc.summary(block=True)
    assert svc.recording_status(_at(nxt, 9, 30))["state"] == "recorded"


def test_the_recorded_forecast_stays_visible_in_market_hours_when_the_data_stamp_has_changed(tmp_path: Path) -> None:
    """Regression (11 Nov 2026): after a restart or a refreshed bar the saved report no longer matched, and in market hours the page showed only
    'models are trained after the market closes': this morning's recorded forecast was invisible until 15:50."""
    last = _walk(560, 1)[-1].session
    nxt = _Cal().next_session(last)
    svc, _ = _service(tmp_path, 560, _at(nxt, 8, 50))
    first = svc.summary(block=True)
    assert first["ready"] and first["forecasts"]["T1"]["models"]["ensemble"]["recorded"] is True
    # later the same day: a new object (restart), the stored data changed, market hours, training paused
    from app.prediction.ledger import ForecastLedger

    store = svc._store
    store.set_provisional("BRENT", None, "2026-01-01T00:00:00+00:00")  # any change of the stored data changes the report key
    noon = _at(nxt, 11, 0)
    b = PredictionResearch(store, ForecastLedger(tmp_path), calendar=_Cal(), clock=lambda: noon, initial_train=200, test_size=60, cache_dir=tmp_path, pause_in_market_hours=True)
    b._key = lambda bars: ["changed"]  # type: ignore[method-assign]
    s = b.summary()
    assert s["ready"] is True and s["paused"] is True and s["stale_report"] is True and "paused during market hours" in s["stale_report_note"]
    assert all(m["recorded"] for m in s["forecasts"]["T1"]["models"].values()) and s["recording"]["state"] == "recorded"
    (tmp_path / "x").mkdir()
    (tmp_path / "empty").mkdir()
    none = PredictionResearch(store, ForecastLedger(tmp_path / "x"), calendar=_Cal(), clock=lambda: noon, initial_train=200, test_size=60, cache_dir=tmp_path / "empty", pause_in_market_hours=True)
    assert none.summary().get("ready") is False  # with no saved report at all the old message stands
