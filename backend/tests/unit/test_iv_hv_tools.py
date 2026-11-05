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

from app.intraday.hv import MAX_GAP_DAYS, hv, hv_report, log_returns
from app.intraday.service import IntradayService
from app.intraday.store import IntradayStore
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
