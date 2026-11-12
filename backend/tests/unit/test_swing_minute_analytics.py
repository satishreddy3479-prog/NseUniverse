"""Analytics of the live paper book, against hand calculations."""

from __future__ import annotations

import pytest

from app.swing.minute_analytics import book_analytics, hold_minutes, max_drawdown_pct, trade_r


def row(symbol: str, fill: float, sl: float, shares: int, gross: float, costs: float, a: str, b: str) -> dict[str, object]:
    return {"symbol": symbol, "fill": fill, "initial_sl": sl, "shares": shares, "gross_pnl": gross, "costs": costs, "pnl": gross - costs, "filled_at": a, "exit_at": b}


CLOSED = [
    row("AAA", 100.0, 95.0, 100, 1000.0, 30.0, "2026-11-10T04:00:00+00:00", "2026-11-10T06:00:00+00:00"),   # +970 net, R = 1000 / (5 x 100) = 2.0, held 120 min
    row("BBB", 200.0, 190.0, 50, -500.0, 40.0, "2026-11-10T05:00:00+00:00", "2026-11-11T05:00:00+00:00"),   # -540 net, R = -500 / 500 = -1.0, held 1440 min
    row("CCC", 50.0, 48.0, 200, 400.0, 20.0, "2026-11-11T04:00:00+00:00", "2026-11-11T05:00:00+00:00"),    # +380 net, R = 400 / 400 = 1.0, held 60 min
]


def test_trade_r_and_hold_time_by_hand() -> None:
    assert trade_r(CLOSED[0]) == pytest.approx(2.0) and trade_r(CLOSED[1]) == pytest.approx(-1.0) and trade_r(CLOSED[2]) == pytest.approx(1.0)
    assert hold_minutes(CLOSED[0]) == 120 and hold_minutes(CLOSED[1]) == 1440
    assert trade_r({"fill": 100.0, "initial_sl": 100.0, "shares": 10, "gross_pnl": 5.0}) is None  # no risk: no R
    assert hold_minutes({"filled_at": "2026-11-10T04:00:00+00:00", "exit_at": None}) is None


def test_max_drawdown_is_the_largest_fall_from_a_previous_peak() -> None:
    assert max_drawdown_pct([100, 110, 99, 105, 90, 120]) == pytest.approx((110 - 90) / 110 * 100)
    assert max_drawdown_pct([100, 101, 102]) == 0.0
    assert max_drawdown_pct([100]) is None and max_drawdown_pct([]) is None


def test_book_analytics_by_hand() -> None:
    a = book_analytics(CLOSED, 1_000_000, 1_000_810, [("t1", 1_000_000), ("t2", 1_000_970), ("t3", 1_000_430), ("t4", 1_000_810)])
    assert a["trades"] == 3 and a["wins"] == 2 and a["losses"] == 1
    assert a["win_rate_pct"] == pytest.approx(200 / 3)
    assert a["net_pnl"] == pytest.approx(970 - 540 + 380) and a["gross_pnl"] == pytest.approx(900.0) and a["costs"] == pytest.approx(90.0)
    assert a["avg_win"] == pytest.approx((970 + 380) / 2) and a["avg_loss"] == pytest.approx(-540.0)
    assert a["profit_factor"] == pytest.approx(1350 / 540)
    assert a["expectancy"] == pytest.approx(810 / 3) and a["avg_r"] == pytest.approx((2.0 - 1.0 + 1.0) / 3)
    assert a["avg_hold_minutes"] == pytest.approx((120 + 1440 + 60) / 3)
    assert a["best"] == {"symbol": "AAA", "pnl": 970.0} and a["worst"] == {"symbol": "BBB", "pnl": -540.0}
    assert a["return_pct"] == pytest.approx(0.081)
    assert a["max_drawdown_pct"] == pytest.approx((1_000_970 - 1_000_430) / 1_000_970 * 100)
    assert a["equity_points"] == 4 and a["equity_from"] == "t1"


def test_nothing_is_invented_when_there_is_nothing_to_compute() -> None:
    a = book_analytics([], 1_000_000, 1_000_000, [])
    for k in ("win_rate_pct", "net_pnl", "avg_win", "avg_loss", "profit_factor", "expectancy", "avg_r", "avg_hold_minutes", "best", "worst", "max_drawdown_pct", "equity_from"):
        assert a[k] is None, k
    assert a["trades"] == 0 and a["return_pct"] == 0.0
    only_wins = book_analytics(CLOSED[:1], 1_000_000, 1_000_970, [])
    assert only_wins["profit_factor"] is None and only_wins["avg_loss"] is None  # no losing trade: no profit factor, not infinity
