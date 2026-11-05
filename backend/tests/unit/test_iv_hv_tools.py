"""Historical volatility and the intraday implied-volatility series (Options Lab tools IV - HV and IV - Intraday).

HV is checked against hand calculations; the IV series uses the real captured NIFTY chain (the same chain the command
center's IV tests use, ATM IV about 16.5 %), so it checks wiring, thinning, ordering and missing handling, not the model.
"""

from __future__ import annotations

import math
from datetime import UTC, date, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.intraday.hv import MAX_GAP_DAYS, hv, hv_report, iv_chart, log_returns, parkinson_at
from app.intraday.service import IntradayService
from app.intraday.store import IntradayStore
from app.intraday.volatility import skew_metrics
from app.prediction.flows_store import FlowsStore
from app.prediction.history_store import HistoryStore
from app.prediction.targets import Bar
from tests.unit.test_intraday import EXP, ist, make_app, seed


def bar(d: str, c: float) -> Bar:
    return Bar(date.fromisoformat(d), c, c, c, c)


def test_hv_matches_the_hand_calculation() -> None:
    # closes 100, 102, 101 -> returns ln(1.02) = 0.0198026, ln(101/102) = -0.0098523
    # mean 0.0049751; deviations +-0.0148275; sample variance (n-1 = 1) = 2 * 0.0148275^2 = 0.00043971
    # sd = 0.0209693; x sqrt(252) = 0.332871 -> 33.29 %
    rets = log_returns([bar("2026-11-02", 100), bar("2026-11-03", 102), bar("2026-11-04", 101)])
    assert [round(r, 7) for _, r, _ in rets] == [0.0198026, -0.0098523]
    got = hv(rets, 2)
    assert got == pytest.approx(math.sqrt(2 * 0.0148275**2 * 252) * 100, rel=1e-4)
    assert got == pytest.approx(33.29, abs=0.02)
    assert hv(rets, 3) is None  # not enough returns: missing, never a shorter window passed off as longer


def test_hv_report_windows_gaps_and_series() -> None:
    days = [date(2026, 9, 1) + timedelta(days=i) for i in range(70)]
    bars = [bar(str(d), 100 + (i % 7)) for i, d in enumerate(days)]
    out = hv_report(bars, today=days[-1])
    assert out["as_of"] == str(days[-1]) and out["days_behind"] == 0 and out["bars"] == 70
    assert out["windows"]["60"]["returns"] == 60 and out["windows"]["60"]["hv"] is not None
    assert out["series"]["window"] == 20 and len(out["series"]["dates"]) == len(out["series"]["hv"]) == 69  # 69 returns
    assert out["series"]["hv"][0] is None and out["series"]["hv"][18] is None and out["series"]["hv"][19] is not None  # first full 20-return window
    short = hv_report(bars[:15], today=days[14])
    assert short["windows"]["20"]["hv"] is None and short["windows"]["10"]["hv"] is not None
    # a hole in the history is reported in the window it falls in
    holed = [bar("2026-10-01", 100), bar("2026-10-02", 101), bar(f"2026-10-{2 + MAX_GAP_DAYS + 3:02d}", 103), bar("2026-10-13", 102)]
    assert hv_report(holed, today=date(2026, 10, 13))["windows"]["10"]["gap_returns"] == 0  # fewer than 10 returns: nothing to report
    many = [bar(str(date(2026, 8, 1) + timedelta(days=i)), 100 + i % 5) for i in range(12)]
    many.append(bar("2026-09-01", 101))  # 20 days after the previous bar
    assert hv_report(many, today=date(2026, 9, 1))["windows"]["10"]["gap_returns"] == 1


def make(tmp: Path, n: int, now_min: int) -> IntradayService:
    times = [ist(9, 15) + timedelta(minutes=i) for i in range(n)]
    return IntradayService(seed(tmp, times), HistoryStore(tmp), FlowsStore(tmp), IntradayStore(tmp),
                           clock=lambda: (ist(9, 15) + timedelta(minutes=now_min)).astimezone(UTC))  # fmt: skip


def test_iv_series_gives_one_atm_iv_per_snapshot_in_time_order(tmp_path: Path) -> None:
    out = make(tmp_path, 30, 30).iv_series(EXP)
    assert out["status"] == "ok" and out["is_today"] is True and out["samples_in_session"] == 30
    ivs = [p["atm_iv"] for p in out["points"]]
    assert len(ivs) == 30 and all(v == pytest.approx(16.54, abs=0.1) for v in ivs)  # same real chain every minute
    assert [p["at"] for p in out["points"]] == sorted(p["at"] for p in out["points"])
    assert out["high"] == max(ivs) and out["low"] == min(ivs) and out["age_seconds"] == 60.0  # newest sample 09:44, now 09:45


def test_iv_series_is_thinned_but_always_ends_on_the_newest_snapshot(tmp_path: Path) -> None:
    svc = make(tmp_path, 30, 30)
    out = svc.iv_series(EXP, max_points=10)
    assert out["thinned_every"] == 3 and out["points_shown"] == len(out["points"]) <= 11
    assert out["points"][-1]["at"] == out["latest_at"]  # the newest value is never dropped


def test_iv_series_says_so_when_there_is_nothing_to_show(tmp_path: Path) -> None:
    empty = make(tmp_path / "a", 0, 30).iv_series(EXP)
    assert empty["points"] == [] and "no stored" in empty["status"]
    assert make(tmp_path / "b", 3, 30).iv_series("not-a-date")["status"] == "bad expiry"


def test_api_exposes_both_tools(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path)) as c:
        r = c.get('/api/intraday/hv')
        assert r.status_code == 200 and set(r.json()) >= {'as_of', 'windows', 'series', 'method'}
        r2 = c.get('/api/intraday/iv-series', params={'expiry': EXP})
        assert r2.status_code == 200 and r2.json()['points'] == []  # nothing stored in the test app: says so
        assert c.get('/api/intraday/iv-series', params={'expiry': 'bad'}).status_code == 422


# ---------------------------------------------------------------- IV by session
def test_iv_by_session_names_the_expiry_and_feeds_the_hv_report(tmp_path: Path) -> None:
    svc = make(tmp_path, 30, 30)
    rows = svc.iv_history()
    assert len(rows) == 1 and rows[0]["date"] == "2026-10-29" and rows[0]["expiry"] == EXP
    assert rows[0]["atm_iv"] == pytest.approx(16.54, abs=0.2) and rows[0]["days_to_expiry"] > 2  # a contract with days left, not an expiring one
    report = svc.hv()
    assert report["iv_by_session"] == rows and "at least 2 days" in report["iv_by_session_note"]


def test_iv_chart_aligns_vix_with_rolling_hv_and_drops_unpaired_days() -> None:
    nifty = [bar("2026-11-02", 100), bar("2026-11-03", 102), bar("2026-11-04", 101), bar("2026-11-05", 101)]
    vix = [bar("2026-11-03", 14.5), bar("2026-11-04", 15.0), bar("2026-11-05", 16.123)]  # no VIX bar for 2 Nov
    out = iv_chart(nifty, vix, 2)
    # 2 Nov has no return and no VIX; 3 Nov has one return only, so its 2-day HV is missing (not a shorter window)
    assert out["dates"] == ["2026-11-03", "2026-11-04", "2026-11-05"]
    assert out["hv"][0] is None
    assert out["hv"][1] == pytest.approx(33.29, abs=0.02)  # the hand calculation above (returns 0.0198026, -0.0098523)
    # 5 Nov: returns -0.0098523 and 0 -> mean -0.0049262, deviations +-0.0049262, var = 2 x 0.0049262^2, HV = 0.0049262 x sqrt(2 x 252) x 100
    assert out["hv"][2] == pytest.approx(0.0049262 * math.sqrt(504) * 100, abs=0.02)
    assert out["iv"] == [14.5, 15.0, 16.12] and out["close"] == [102, 101, 101]
    assert "India VIX" in out["iv_source"]


def test_api_iv_chart_validates_the_window(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path)) as c:
        r = c.get("/api/intraday/iv-chart", params={"hv": 20})
        assert r.status_code == 200 and set(r.json()) >= {"dates", "iv", "hv", "close", "iv_source"}
        assert c.get("/api/intraday/iv-chart", params={"hv": 7}).status_code == 422


def test_skew_metrics_match_the_hand_calculation() -> None:
    def r(k: float, side: str, iv: float, d: float) -> dict[str, object]:
        return {"strike": k, "side": side, "otm": True, "iv": iv, "delta": d}

    rows = [r(23900, "PE", 17, -0.40), r(23800, "PE", 18, -0.26), r(23600, "PE", 20, -0.10),
            r(24100, "CE", 15, 0.40), r(24200, "CE", 14, 0.24), r(24400, "CE", 13.5, 0.09)]
    m = skew_metrics(rows, 24000, 16.0)
    assert m["skew_25d"] == 4.0  # 18 - 14 (the 0.26 and 0.24 delta contracts)
    assert m["skew_10d"] == 6.5  # 20 - 13.5
    assert m["butterfly_25d"] == 0.0  # (18 + 14) / 2 - 16
    # moneyness % = -0.41667, -0.83333, -1.66667, +0.41667, +0.83333, +1.66667; mean IV 16.25; Sxy = -15.0; Sxx = 7.29167
    assert m["slope_per_pct"] == pytest.approx(-2.0571, abs=1e-3)
    far = skew_metrics([r(23000, "PE", 30, -0.02), r(25000, "CE", 12, 0.02)], 24000, 16.0)
    assert far["skew_25d"] is None and far["slope_per_pct"] is None  # no contract near the target delta: missing


def test_iv_series_for_a_chosen_session_and_candle_size(tmp_path: Path) -> None:
    svc = make(tmp_path, 30, 30)
    five = svc.iv_series(EXP, max_points=400, tf=5)
    assert five["tf_minutes"] == 5 and five["samples_in_session"] == 6  # 30 one-minute samples = six 5-minute candles
    assert five["points"][-1]["at"] == five["latest_at"]  # each candle keeps its last snapshot
    named = svc.iv_series(EXP, session="2026-10-29")
    assert named["session"] == "2026-10-29" and named["status"] == "ok"
    assert svc.iv_series(EXP, session="2026-10-01")["points"] == []  # a session with nothing stored says so
    assert svc.iv_series(EXP, session="nope")["status"] == "bad session"
    assert svc.iv_sessions() == ["2026-10-29"]


def test_iv_skew_gives_a_smile_cards_and_the_term_row(tmp_path: Path) -> None:
    out = make(tmp_path, 30, 30).iv_skew(EXP)
    assert out["status"] == "ok" and out["atm_iv"] == pytest.approx(16.54, abs=0.2)
    strikes = [p["strike"] for p in out["smile"]]
    assert len(strikes) >= 20 and all(p["iv"] is None or 1 < p["iv"] < 80 for p in out["smile"])
    assert out["atm_strike"] in strikes and {"skew_25d", "skew_10d", "butterfly_25d", "slope_per_pct", "term_slope_per_30d"} <= set(out["cards"])
    assert [t["expiry"] for t in out["term"]] == [EXP]  # one expiry stored: no term slope, said as missing
    assert out["cards"]["term_slope_per_30d"] is None
    assert make(tmp_path / "e", 0, 30).iv_skew(EXP)["smile"] == []


def test_api_iv_series_options_and_skew(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path)) as c:
        assert c.get("/api/intraday/iv-series", params={"expiry": EXP, "tf": 2}).status_code == 422
        assert c.get("/api/intraday/iv-series", params={"expiry": EXP, "tf": 5, "session": "2026-10-29"}).status_code == 200
        assert c.get("/api/intraday/iv-sessions").json() == {"sessions": []}
        assert c.get("/api/intraday/iv-skew", params={"expiry": EXP}).json()["smile"] == []


def test_parkinson_rv_matches_the_hand_calculation() -> None:
    # ranges ln(102/100) = 0.0198026 and ln(103/100) = 0.0295588; squares 3.92144e-4 and 8.73721e-4, mean 6.32933e-4
    # sqrt(6.32933e-4 / (4 ln 2) x 252) = sqrt(0.0575257) = 0.239845 -> 23.98 %
    bars = [Bar(date(2026, 11, 2), 100, 102, 100, 101), Bar(date(2026, 11, 3), 100, 103, 100, 102), Bar(date(2026, 11, 4), 100, 100, 100, 100)]
    out = parkinson_at(bars, 2)
    assert out[date(2026, 11, 2)] is None  # one bar is not a 2-day window
    assert out[date(2026, 11, 3)] == pytest.approx(23.98, abs=0.02)
    assert out[date(2026, 11, 4)] == pytest.approx(math.sqrt((8.73721e-4 / 2) / (4 * math.log(2)) * 252) * 100, abs=0.02)  # a flat day adds zero range
    bad = parkinson_at([Bar(date(2026, 11, 2), 100, 100, 100, 100), Bar(date(2026, 11, 3), 100, 100, 100, 100)], 2)
    assert bad[date(2026, 11, 3)] == 0.0


def test_iv_skew_after_the_close_still_lists_the_expiries_of_the_session(tmp_path: Path) -> None:
    # read at 01:05 the next morning: "today" has no samples, but the term view must follow the chain's own session
    out = make(tmp_path, 30, 950).iv_skew(EXP)
    assert out["status"] == "ok" and [t["expiry"] for t in out["term"]] == [EXP]
