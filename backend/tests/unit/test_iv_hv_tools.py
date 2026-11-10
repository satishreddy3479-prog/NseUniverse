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

from app.intraday.hv import MAX_GAP_DAYS, hv, hv_report, iv_chart, log_returns, rv_annual
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
    # mean 0.0049751; deviations +-0.0148275; population variance (divide by n = 2) = 0.0148275^2
    # sd = 0.0148275; x sqrt(252) = 0.235380 -> 23.54 %
    rets = log_returns([bar("2026-11-02", 100), bar("2026-11-03", 102), bar("2026-11-04", 101)])
    assert [round(r, 7) for _, r, _ in rets] == [0.0198026, -0.0098523]
    got = hv(rets, 2)
    assert got == pytest.approx(math.sqrt(0.0148275**2 * 252) * 100, rel=1e-4)
    assert got == pytest.approx(23.54, abs=0.02)
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
    assert out["hv"][1] == pytest.approx(23.54, abs=0.02)  # the hand calculation above (returns 0.0198026, -0.0098523)
    # 5 Nov: returns -0.0098523 and 0 -> mean -0.0049262, deviations +-0.0049262, var = 0.0049262^2, HV = 0.0049262 x sqrt(252) x 100
    assert out["hv"][2] == pytest.approx(0.0049262 * math.sqrt(252) * 100, abs=0.02)  # population sd of -0.0098523 and 0
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
    # put IV at 0.25 delta: between (0.26, 18) and (0.10, 20): 20 + (0.25-0.10)/(0.26-0.10) * (18-20) = 18.125
    # call IV at 0.25 delta: between (0.40, 15) and (0.24, 14): 14 + (0.25-0.24)/(0.40-0.24) * (15-14) = 14.0625
    assert m["put_25d_iv"] == pytest.approx(18.125, abs=1e-3) and m["call_25d_iv"] == pytest.approx(14.0625, abs=1e-3)
    assert m["skew_25d"] == pytest.approx(4.0625, abs=1e-3) and m["call_minus_put_25d"] == pytest.approx(-4.0625, abs=1e-3)
    # 0.10 delta: the put sits exactly on it (20); call between (0.24, 14) and (0.09, 13.5): 13.5 + (0.10-0.09)/(0.24-0.09) * 0.5 = 13.5333
    assert m["skew_10d"] == pytest.approx(6.4667, abs=1e-3)
    assert m["butterfly_25d"] == pytest.approx(0.09375, abs=1e-3)  # (18.125 + 14.0625) / 2 - 16
    assert m["butterfly_10d"] == pytest.approx(0.7667, abs=1e-3)  # (20 + 13.5333) / 2 - 16
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



def test_iv_skew_after_the_close_still_lists_the_expiries_of_the_session(tmp_path: Path) -> None:
    # read at 01:05 the next morning: "today" has no samples, but the term view must follow the chain's own session
    out = make(tmp_path, 30, 950).iv_skew(EXP)
    assert out["status"] == "ok" and [t["expiry"] for t in out["term"]] == [EXP]


def test_rv_is_the_root_mean_square_of_returns_and_hv_divides_by_n() -> None:
    # returns 0.0198026 and -0.0098523: squares 3.92144e-4 and 9.7068e-5, mean 2.44606e-4; x 252 = 0.061641; sqrt = 0.248277 -> 24.83 %
    rets = [0.0198026, -0.0098523]
    assert rv_annual(rets) == pytest.approx(24.83, abs=0.01)
    # HV takes the mean out and divides by n: deviations +-0.0148275 -> sd 0.0148275 x sqrt(252) = 23.54 %
    assert hv([(date(2026, 11, 3), rets[0], 1), (date(2026, 11, 4), rets[1], 1)], 2) == pytest.approx(23.54, abs=0.01)
    assert rv_annual([]) is None


def test_iv_chart_reaches_a_provisional_latest_day_with_no_india_vix() -> None:
    nifty = [bar("2026-11-02", 100), bar("2026-11-03", 102), bar("2026-11-04", 101)]
    vix = [bar("2026-11-03", 14.5), bar("2026-11-04", 15.0)]
    out = iv_chart(nifty, vix, 2, provisional=bar("2026-11-05", 103.02))
    assert out["dates"] == ["2026-11-03", "2026-11-04", "2026-11-05"]
    assert out["iv"] == [14.5, 15.0, None]  # the day's VIX is missing, not copied from the day before
    # returns 4 Nov -0.0098523 and 5 Nov ln(103.02/101) = 0.0198026: HV is the population sd = 0.0148275 x sqrt(252) = 23.54
    assert out["hv"][2] == pytest.approx(23.54, abs=0.02)
    assert out["rv"][2] == pytest.approx(24.83, abs=0.02)  # root mean square of the same two returns
    assert out["close"][2] == 103.02 and out["provisional"]["date"] == "2026-11-05" and out["nifty_bars"] == 3
    # a provisional day that is not newer than the stored bars is ignored
    assert iv_chart(nifty, vix, 2, provisional=bar("2026-11-04", 99))["provisional"] is None


def test_service_adds_the_latest_stored_session_as_a_flagged_provisional_bar(tmp_path: Path) -> None:
    from app.prediction.sources.yahoo import RawRow

    svc = make(tmp_path, 30, 30)  # stored session 2026-10-29
    svc.history.insert_bars("NIFTY50", [RawRow(date(2026, 10, 27), 24000, 24100, 23900, 24050, 0), RawRow(date(2026, 10, 28), 24050, 24200, 24000, 24100, 0)],
                            source="yahoo", run_id="t", volume_meaningful=False)
    bars = svc.history.bars("NIFTY50")
    prov = svc._provisional_bar(bars)
    assert prov is not None and prov.session == date(2026, 10, 29)
    last_spot = svc.obs.samples("NIFTY", EXP, since=ist(9, 0), until=ist(16, 0), limit=5000)[-1].spot
    assert prov.close == last_spot  # our own feed's last in-session level, nothing invented
    assert svc.hv()["provisional"] == {"date": "2026-10-29", "close": last_spot}
    assert svc.iv_chart(2)["provisional"]["date"] == "2026-10-29"
    # once the real bar for that day is stored there is no provisional day
    svc.history.insert_bars("NIFTY50", [RawRow(date(2026, 10, 29), 24100, 24300, 24050, 24250, 0)], source="yahoo", run_id="t2", volume_meaningful=False)
    assert svc._provisional_bar(svc.history.bars("NIFTY50")) is None


def test_iv_chart_carries_our_own_atm_iv_for_stored_sessions_and_leaves_other_days_empty(tmp_path: Path) -> None:
    from app.prediction.sources.yahoo import RawRow

    svc = make(tmp_path, 30, 30)  # one stored session, 2026-10-29, expiry EXP (5 days ahead)
    svc.history.insert_bars("NIFTY50", [RawRow(date(2026, 10, 27), 24000, 24100, 23900, 24050, 0), RawRow(date(2026, 10, 28), 24050, 24200, 24000, 24100, 0)],
                            source="yahoo", run_id="t", volume_meaningful=False)
    svc.history.insert_bars("INDIAVIX", [RawRow(date(2026, 10, 28), 14, 15, 13, 14.5, 0)], source="yahoo", run_id="t", volume_meaningful=False)
    out = svc.iv_chart(2)
    assert out["dates"] == ["2026-10-28", "2026-10-29"]  # 29 Oct is the provisional day
    assert out["own_iv"][0] is None  # no option chain was stored on 28 Oct: missing, not copied from the VIX
    assert out["own_iv"][1] == pytest.approx(16.54, abs=0.3) and out["own_iv_expiry"][1] == EXP
    assert out["iv"] == [14.5, None]  # India VIX of the provisional day is still unpublished


def test_iv_momentum_service_returns_a_table_and_series_from_stored_samples(tmp_path: Path) -> None:
    out = make(tmp_path, 30, 30).iv_momentum(EXP)
    assert out["status"] == "ok" and out["samples_in_session"] == 30 and len(out["series"]) >= 25
    assert set(out["table"]["periods"]) == {"1", "5", "15", "30", "60"}
    five = out["table"]["periods"]["5"]
    assert set(five) >= {"atm", "d25", "d10", "spot_change"} and set(five["d25"]) >= {"ce_change", "pe_change", "momentum"}
    assert out["table"]["periods"]["60"]["from"] is None  # only 30 minutes stored: no hour-earlier snapshot, so no figure
    assert make(tmp_path / "e", 0, 30).iv_momentum(EXP)["series"] == []


def test_strike_positioning_service_compares_with_an_earlier_snapshot(tmp_path: Path) -> None:
    svc = make(tmp_path, 30, 30)
    out = svc.strike_positioning(EXP, "15")
    assert out["status"] == "ok" and out["then_at"] is not None and len(out["rows"]) > 10
    row = next(r for r in out["rows"] if r["strike"] == out["atm_strike"])
    assert {"premium", "premium_pct", "oi", "oi_session_change", "iv", "delta", "class"} <= set(row["ce"])
    assert out["baskets"] and {b["kind"] for b in out["baskets"]} == {"fixed", "dynamic"}
    assert svc.strike_positioning(EXP, "prev")["then_at"] is None  # nothing stored for an earlier session: no comparison, said plainly
    assert svc.strike_positioning(EXP, "x")["status"] == "bad window"


def test_backtest_service_reports_insufficient_sample_instead_of_a_result(tmp_path: Path) -> None:
    out = make(tmp_path, 30, 30).backtest(EXP, 5)
    assert out["status"] in ("ok", "no stored sessions with a solvable chain for this expiry")
    assert len(out["not_testable"]) == 4
    for t in out["tests"]:
        assert t["status"].startswith("insufficient") or t["status"] == "ok"
        assert t["out_of_sample"]["events"] < 20  # a single synthetic session cannot support a result
