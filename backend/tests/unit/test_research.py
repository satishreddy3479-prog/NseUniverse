from __future__ import annotations

import json
import random
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

pytest.importorskip("numpy")

from app.prediction.features_multi import FLOW_NAMES, T1_NAMES, T5_NAMES, build_rows  # noqa: E402
from app.prediction.history_store import HistoryStore  # noqa: E402
from app.prediction.ledger import ForecastLedger  # noqa: E402
from app.prediction.models import fit_boost, fit_logistic  # noqa: E402
from app.prediction.research import ENSEMBLE, PredictionResearch  # noqa: E402
from app.prediction.sources.yahoo import SYMBOLS, RawRow  # noqa: E402
from app.prediction.targets import Bar  # noqa: E402


def _walk(n: int, seed: int, start: date = date(2018, 1, 1), px: float = 100.0) -> list[Bar]:
    rnd, d, out = random.Random(seed), start, []
    while len(out) < n:
        d += timedelta(days=1)
        if d.weekday() >= 5:
            continue
        o = px * (1 + rnd.gauss(0, 0.003))
        c = o * (1 + rnd.gauss(0, 0.01))
        out.append(Bar(d, o, max(o, c) * 1.002, min(o, c) * 0.998, c))
        px = c
    return out


def _all_series(n: int) -> dict[str, list[Bar]]:
    return {s.key: _walk(n, i + 1) for i, s in enumerate(SYMBOLS)}


def test_every_non_indian_series_is_marked_timing_verified_with_a_rule() -> None:
    assert all(s.timing_verified for s in SYMBOLS)


def test_features_are_point_in_time_for_both_horizons() -> None:
    series = _all_series(260)
    nifty = series.pop("NIFTY50")
    cut = nifty[200].session
    for h in ("T1", "T5"):
        names, base = build_rows(nifty, series, h)
        # change every bar after the cut, in every series: nothing at or before the cut may move
        alt_n = nifty[:201] + [Bar(b.session, b.open * 3, b.high * 3, b.low * 3, b.close * 3) for b in nifty[201:]]
        alt_o = {k: [b if b.session <= cut else Bar(b.session, b.open * 2, b.high * 2, b.low * 2, b.close * 2) for b in v] for k, v in series.items()}
        _, again = build_rows(alt_n, alt_o, h)
        assert len(names) == len(T1_NAMES if h == "T1" else T5_NAMES)
        for t in [t for t in base if t <= cut]:
            assert base[t] == again[t], (h, t)


def test_flow_features_ignore_files_after_the_reference_session() -> None:
    series = _all_series(120)
    nifty = series.pop("NIFTY50")
    cols = {c: 100 for c in ("Future Index Long", "Future Index Short", "Option Index Call Long", "Option Index Call Short", "Option Index Put Long", "Option Index Put Short")}
    day = lambda x: {p: {k: v + x for k, v in cols.items()} for p in ("FII", "DII", "Pro", "Client", "TOTAL")}  # noqa: E731
    flows = {b.session: day(i) for i, b in enumerate(nifty)}
    names, rows = build_rows(nifty, series, "T5", flows, with_flows=True)
    assert names[-len(FLOW_NAMES) :] == list(FLOW_NAMES) and rows
    t = nifty[100].session
    flows2 = {d: (day(10**6) if d > t else v) for d, v in flows.items()}
    _, rows2 = build_rows(nifty, series, "T5", flows2, with_flows=True)
    assert rows[t] == rows2[t]


def test_missing_input_drops_the_row_instead_of_filling_it() -> None:
    series = _all_series(200)
    nifty = series.pop("NIFTY50")
    del series["SPX"]
    _, rows = build_rows(nifty, series, "T1")
    assert rows == {}


def test_logistic_and_boost_find_planted_signals() -> None:
    rnd = random.Random(3)
    X = [[rnd.gauss(0, 1) for _ in range(6)] for _ in range(3000)]
    y = [int(rnd.random() < (0.8 if x[0] > 0.3 and x[1] < 0 else 0.35)) for x in X]
    lg = fit_logistic([[x[0]] for x in X], [int(rnd.random() < 1 / (1 + pow(2.718, -1.5 * x[0]))) for x in X])
    assert lg.weights[1] > 0.5
    m = fit_boost(X[:2000], y[:2000], rounds=150, depth=2)
    p = m.predict_proba(X[2000:])
    base = sum(y[:2000]) / 2000
    assert sum((a - b) ** 2 for a, b in zip(p, y[2000:], strict=True)) < sum((base - b) ** 2 for b in y[2000:]) - 0.01 * 1000


class _Cal:
    def is_session(self, d: date) -> bool:
        return d.weekday() < 5

    def prev_session(self, d: date, n: int = 1) -> date:
        while n:
            d -= timedelta(days=1)
            if d.weekday() < 5:
                n -= 1
        return d

    def next_session(self, d: date, n: int = 1) -> date:
        while n:
            d += timedelta(days=1)
            if d.weekday() < 5:
                n -= 1
        return d


def _service(tmp_path: Path, n: int, now: datetime, series_end_offset: int = 0) -> tuple[PredictionResearch, list[Bar]]:
    store = HistoryStore(tmp_path)
    series = _all_series(n)
    for key, bars in series.items():
        bars = bars[: len(bars) - series_end_offset] if key != "NIFTY50" else bars
        store.insert_bars(key, [RawRow(b.session, b.open, b.high, b.low, b.close, None) for b in bars], source="yahoo", run_id="r", now=datetime(2035, 1, 1, tzinfo=UTC))  # downloaded long after every session
    svc = PredictionResearch(store, ForecastLedger(tmp_path, clock=lambda: now), calendar=_Cal(), clock=lambda: now, initial_train=200, test_size=60, cache_dir=tmp_path, pause_in_market_hours=False)
    return svc, series["NIFTY50"]


def _at(last: date, hour: int, minute: int, days: int = 0) -> datetime:
    d = last + timedelta(days=days)
    return datetime(d.year, d.month, d.day, hour, minute, tzinfo=UTC) - timedelta(hours=5, minutes=30)  # IST wall clock


def test_end_to_end_noise_gives_no_edge_and_records_only_in_the_morning_window(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    nxt = _Cal().next_session(last)
    svc, _ = _service(tmp_path, 560, _at(nxt, 8, 50))
    s = svc.summary(block=True)
    assert s["ready"] and s["data"]["overnight_data_fresh"]
    for v in ("T1", "T5"):
        ev = s["evaluation"]["horizons"][v]
        assert ev["available"] and set(ev["models"]) == {"logit-all", "logit-core", "boost-all", ENSEMBLE}
        assert ev["tuning_period"][1] < ev["holdout_period"][0]
        for m in ev["models"].values():
            assert abs(m["holdout"]["skill"]) < 0.06
        assert ev["calls"]["verdict"] in {"too_few_calls", "no_edge_shown", "promising"}
        for name, f in s["forecasts"][v]["models"].items():
            assert f["recorded"] and 0 < f["payload"]["p_up_model"] < 1, name
    assert s["evaluation"]["horizons"]["T5F"]["available"] is False  # no NSE files in this test
    assert s["ledger"]["counts"]["T1"]["forecasts"] == 4
    again = svc.summary(force=True, block=True)
    assert again["ledger"]["counts"]["T1"]["forecasts"] == 4
    assert again["forecasts"]["T1"]["models"]["logit-all"]["already_recorded"] is True


def test_evening_view_is_a_preview_and_is_not_recorded(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    svc, _ = _service(tmp_path, 560, _at(last, 21, 0), series_end_offset=1)  # overnight bars not in yet
    s = svc.summary(block=True)
    assert s["data"]["overnight_data_fresh"] is False and "SPX" in s["data"]["stale_series"]
    f = s["forecasts"]["T1"]["models"]["logit-all"]
    assert f["recorded"] is False and f["preview"] is True and "not yet in" in f["reason"]
    assert s["ledger"]["counts"]["T1"]["forecasts"] == 0


def test_result_is_cached_on_disk(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    now = _at(_Cal().next_session(last), 8, 50)
    first, _ = _service(tmp_path, 560, now)
    first.summary(block=True)
    assert (tmp_path / "prediction_report.json").exists()
    second = PredictionResearch(first._store, first._ledger, calendar=_Cal(), clock=lambda: now, initial_train=200, test_size=60, cache_dir=tmp_path)
    assert second.summary()["ready"] is True


def test_too_little_history_is_reported_not_faked(tmp_path: Path) -> None:
    last = _walk(200, 1)[-1].session
    svc, _ = _service(tmp_path, 200, _at(last, 21, 0))
    s = svc.summary()
    assert s["ready"] is False and "refresh" in s["reason"]


def test_a_bar_dated_today_before_four_pm_is_not_used(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    svc, bars = _service(tmp_path, 560, _at(last, 10, 30))
    s = svc.summary(block=True)
    assert s["data"]["last"] == str(bars[-2].session)


def test_a_partial_us_bar_before_0300_ist_is_a_preview_not_a_forecast(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    svc, _ = _service(tmp_path, 560, _at(last, 21, 0))  # US bars dated today exist but the US session is still open
    s = svc.summary(block=True)
    assert s["data"]["overnight_data_fresh"] is False and "still open" in s["data"]["stale_series"][0]
    assert s["forecasts"]["T1"]["models"]["logit-all"]["recorded"] is False


def test_forward_scoreboard_scores_only_resolved_forecasts(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    svc, _ = _service(tmp_path, 560, _at(_Cal().next_session(last), 8, 50))
    s = svc.summary(block=True)
    assert s["ledger"]["scoreboard"]["T1"] == {}  # nothing has resolved yet, so nothing is scored


def test_a_high_impact_event_before_the_t1_close_withholds_the_call_only_for_t1(tmp_path: Path) -> None:
    from app.prediction.events import Event, EventCalendar

    last = _walk(560, 1)[-1].session
    nxt = _Cal().next_session(last)
    mid = datetime(last.year, last.month, last.day, 12, 0, tzinfo=UTC) + timedelta(hours=8)  # evening of the reference day
    ev = EventCalendar([Event("x", "Test central bank decision", "fomc", mid, mid, "high", True, False, "test")])
    svc, _ = _service(tmp_path, 560, _at(nxt, 8, 50))
    svc._events = ev
    s = svc.summary(block=True)
    t1 = s["forecasts"]["T1"]["models"]["ensemble"]["payload"]
    assert t1["event_risk"] and t1["event_risk"][0]["name"] == "Test central bank decision"
    assert t1["call"] is None
    assert s["forecasts"]["T5"]["models"]["ensemble"]["payload"]["event_risk"]  # still listed for T+5


def test_a_cached_report_from_an_older_schema_is_recomputed(tmp_path: Path) -> None:
    import json as _json

    last = _walk(560, 1)[-1].session
    now = _at(_Cal().next_session(last), 8, 50)
    first, _ = _service(tmp_path, 560, now)
    first.summary(block=True)
    f = tmp_path / "prediction_report.json"
    doc = _json.loads(f.read_text())
    doc["key"][3] = 3  # pretend an older program wrote this report
    del doc["body"]["data"]["inputs"]
    f.write_text(_json.dumps(doc))
    second = PredictionResearch(first._store, first._ledger, calendar=_Cal(), clock=lambda: now, initial_train=200, test_size=60, cache_dir=tmp_path)
    assert second.summary(block=True)["data"]["inputs"]  # recomputed, so the new field is present


def test_compute_now_retrains_one_horizon_and_logs_manual_vs_automatic_runs(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    svc, _ = _service(tmp_path, 560, _at(_Cal().next_session(last), 8, 50))
    first = svc.summary(block=True)
    assert set(first["runs"]) == {"T1", "T5"} and all("last_auto" in r and "last_manual" not in r for r in first["runs"].values())
    t5_before = json.dumps(first["evaluation"]["horizons"]["T5"], sort_keys=True)
    again = svc.summary(force=True, block=True, trigger="manual", only="T1")
    assert "last_manual" in again["runs"]["T1"] and "last_manual" not in again["runs"]["T5"]
    assert json.dumps(again["evaluation"]["horizons"]["T5"], sort_keys=True) == t5_before  # T+5 keeps its stored result
    assert again["forecasts"]["T1"]["models"]["logit-all"]["already_recorded"] is True  # nothing is re-recorded
    assert again["computing"] is False
    assert json.loads((tmp_path / "prediction_runs.json").read_text())["T1"]["last_manual"]["at"]


def test_a_manual_compute_is_allowed_in_market_hours(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    svc, _ = _service(tmp_path, 560, _at(_Cal().next_session(last), 11, 0))  # 11:00 IST on a session day
    svc._pause_in_market_hours = True
    assert svc.summary(block=True).get("paused") is True  # the schedule waits for the close
    s = svc.summary(force=True, block=True, trigger="manual")
    assert s["ready"] is True and "last_manual" in s["runs"]["T1"]


def test_the_morning_run_waits_for_the_overnight_bars_instead_of_giving_the_day_up(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    nxt = _Cal().next_session(last)
    late, _ = _service(tmp_path, 560, _at(nxt, 8, 50), series_end_offset=1)  # overnight bars not in yet
    assert late.morning_ready(_at(nxt, 8, 50)) is False  # in the window, but a stale run would only be a preview
    ready, _ = _service(tmp_path / "b", 560, _at(nxt, 8, 50))
    assert ready.morning_ready(_at(nxt, 8, 50)) is True
    assert ready.morning_ready(_at(nxt, 8, 20)) is False  # before 08:35
    assert ready.morning_ready(_at(nxt, 9, 20)) is False  # after 09:10
    ready._morning_done = nxt
    assert ready.morning_ready(_at(nxt, 8, 50)) is False  # already done today


def test_every_forecast_day_is_logged_with_its_status_and_a_missed_day_keeps_only_a_preview(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    nxt = _Cal().next_session(last)
    after = _at(nxt, 9, 20)
    ok, _ = _service(tmp_path / "ok", 560, _at(nxt, 8, 50))
    ok.summary(block=True)
    assert ok.log_day(_at(nxt, 9, 0)) == 0  # the window is still open: nothing is logged yet
    assert ok.log_day(after) == 2 and ok.log_day(after) == 0  # T+1 and T+5, written once
    days = {d["horizon"]: d for d in ok.summary()["days"]}
    assert days["T1"]["status"] == "recorded" and days["T1"]["counts_in_forward_test"] is True and days["T1"]["reason"] is None
    assert days["T1"]["target_session"] == str(nxt) and 0 < days["T1"]["p_up"] < 1 and days["T1"]["actual"] is None  # not resolved yet

    late, _ = _service(tmp_path / "late", 560, _at(nxt, 8, 50), series_end_offset=1)  # overnight bars missing
    late.summary(block=True)
    late.log_day(after)
    d = {x["horizon"]: x for x in late.summary()["days"]}["T1"]
    assert d["status"] == "missed" and "not yet in" in d["reason"] and "SPX" in d["stale"]
    assert d["counts_in_forward_test"] is False and d["p_up"] is not None  # the preview is kept, flagged as not counted
    assert late._ledger.counts()["T1"]["forecasts"] == 0  # and it never reaches the forward test

    none, _ = _service(tmp_path / "none", 560, _at(nxt, 8, 50))  # nothing computed at all
    none.log_day(after)
    assert none._days.recent()[0]["status"] == "missed" and "not computed" in none._days.recent()[0]["reason"]


def test_a_logged_day_cannot_be_changed(tmp_path: Path) -> None:
    import sqlite3

    svc, _ = _service(tmp_path, 560, _at(_Cal().next_session(_walk(560, 1)[-1].session), 8, 50))
    svc.summary(block=True)
    svc.log_day(_at(_Cal().next_session(_walk(560, 1)[-1].session), 9, 20))
    with pytest.raises(sqlite3.DatabaseError):
        svc._days._db.execute("UPDATE days SET status='recorded'")


def test_automatic_training_waits_for_the_data_to_settle_but_a_manual_run_does_not(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    nxt = _Cal().next_session(last)
    svc, _ = _service(tmp_path, 560, _at(nxt, 8, 50))
    svc._settle_s = 3600.0  # the data just changed, so an automatic run must hold off
    first = svc.summary()
    assert first["ready"] is False and first["computing"] is True
    assert "Waiting for the data refresh" in first["reason"]
    assert svc._worker is None  # no training was started
    svc.summary(block=False, trigger="auto")
    assert svc._worker is None
    manual = svc.summary(force=True, trigger="manual")  # "Compute now" is never held back
    assert manual["computing"] is True and svc._worker is not None
    svc._worker.join()
    done = svc.summary(trigger="auto")
    assert done["ready"] is True and done["computing"] is False and done.get("computing_since") is None


def test_training_recording_and_settling_are_logged(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("INFO", logger="app.prediction.research")
    last = _walk(560, 1)[-1].session
    nxt = _Cal().next_session(last)
    svc, _ = _service(tmp_path, 560, _at(nxt, 8, 50))
    s = svc.summary(block=True)
    assert s["ready"]
    events = [r.getMessage() for r in caplog.records]
    assert "prediction_training_started" in events and "prediction_training_finished" in events
    rec = [r for r in caplog.records if r.getMessage() == "forecast_recorded"]
    assert len(rec) == 8  # four models for each horizon
    fields = rec[0].fields  # type: ignore[attr-defined]
    assert fields["horizon"] in ("T1", "T5") and 0 < fields["p_up"] < 1 and fields["target"]
    done = [r for r in caplog.records if r.getMessage() == "prediction_training_finished"][0].fields  # type: ignore[attr-defined]
    assert done["recorded"]["T1"] and done["seconds"] >= 0
