"""Hand-calculated checks of the swing engine's execution rules (research/swing)."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "research"))

from swing import backtest, indicators  # noqa: E402

CAL = pd.bdate_range("2023-01-02", periods=8)


def _frame(bars: list[tuple[float, float, float, float, float]], **over) -> pd.DataFrame:
    df = pd.DataFrame(bars, columns=["Open", "High", "Low", "Close", "Volume"], index=CAL[: len(bars)])
    df["atr14"], df["ema10"], df["vol_sma20"] = 2.0, 100.0, 1000.0
    df["pivot"], df["score"], df["dist"], df["archetype"] = 100.0, 70.0, -1.0, "CLASSIC_PIVOT"
    for k, v in over.items():
        df[k] = v
    return df


def _run(bars, **params):
    f = _frame(bars)
    f = f.reindex(CAL)
    el = pd.Series(False, index=CAL)
    el.iloc[0] = True  # signal at close of bar 0
    p = backtest.Params(**params)
    return backtest.run({"X": f}, {"X": el}, {"X": "CNXINFRA"}, CAL, p)


# Signal bar 0, pivot 100 -> trigger 100.3. ATR 2 -> SL = max(100-3, fill*0.945)
BAR0 = (99.0, 100.0, 98.0, 99.5, 1000.0)


def test_extended_open_is_skipped():
    trades, _ = _run([BAR0, (102.6, 104, 102, 103, 2000)])  # open > 100*1.025
    assert trades == []


def test_volume_expansion_required():
    trades, _ = _run([BAR0, (100.5, 102, 100.4, 101.9, 1200)])  # < 1.25 * 1000
    assert trades == []


def test_fill_is_max_open_trigger_and_sizing():
    # open 100.1 < trigger 100.3 -> fill 100.3; SL = max(97, 94.78) = 97; risk 3.3
    trades, eq = _run([BAR0, (100.1, 103, 100.2, 102.9, 1300), (103, 104, 102, 103, 1000)])
    t = trades[0]
    assert abs(t.entry - 100.3) < 1e-9 and abs(t.initial_sl - 97.0) < 1e-9
    # shares = min(1,000,000*0.02/3.3 = 6060, 1,000,000/5/100.3 = 1994)
    assert t.shares == 1994


def test_day1_fail_close_exit():
    # closes below pivot (99.5 < 100) but above SL; low 99 > SL
    trades, _ = _run([BAR0, (100.4, 101, 99.0, 99.5, 1300)])
    t = trades[0]
    assert t.reason == "D1_FAIL_CLOSE" and t.exit == 99.5


def test_day1_rejection_wick_exit():
    # close 100.9: above pivot; (100.9-100.4)/(103-100.4)=0.19 < .35
    trades, _ = _run([BAR0, (100.4, 103.0, 100.4, 100.9, 1300)])
    assert trades[0].reason == "D1_REJECT_WICK" and trades[0].exit == 100.9


def test_day1_stop_exit_at_initial_sl():
    trades, _ = _run([BAR0, (100.4, 101.5, 96.0, 101.0, 1300)])
    assert trades[0].reason == "D1_STOP" and abs(trades[0].exit - 97.0) < 1e-9


def test_breakeven_then_stop_and_pnl():
    # open 100.4 > trigger 100.3 -> fill 100.4, R 3.4, 1.8R high = 106.52. Day1 high 107 ->
    # BE stop 100.4*1.002 = 100.6008. Day2 low 100 <= stop, open 104 -> exit at the stop.
    bars = [BAR0, (100.4, 107.0, 100.4, 106.8, 1300), (104, 105, 100.0, 101, 900)]
    trades, _ = _run(bars)
    t = trades[0]
    assert t.reason == "STOP" and abs(t.exit - 100.4 * 1.002) < 1e-9
    assert abs(t.pnl - t.shares * (100.4 * 1.002 - 100.4)) < 1e-6


def test_gap_down_exits_at_open():
    bars = [BAR0, (100.4, 107.0, 100.4, 106.8, 1300), (95.0, 96, 94, 95, 900)]
    trades, _ = _run(bars)
    assert trades[0].reason == "STOP_GAP" and trades[0].exit == 95.0


def test_chandelier_trail_ratchets_up_only():
    # 2.5R = 108.55 gain. Day1 high 112 -> chand 112-2.5*2 = 107; ema10 100 -> tsl 107.
    bars = [BAR0, (100.4, 112.0, 100.4, 111.0, 1300), (111, 111.5, 106.5, 107, 900)]
    trades, _ = _run(bars)
    assert trades[0].reason == "STOP" and abs(trades[0].exit - 107.0) < 1e-9


def test_cost_reduces_pnl():
    bars = [BAR0, (100.4, 107.0, 100.4, 106.8, 1300), (104, 105, 100.0, 101, 900)]
    g, _ = _run(bars)
    n, _ = _run(bars, cost_per_side=0.001)
    assert n[0].pnl < g[0].pnl


def test_map_stock_to_index_spec_examples():
    assert indicators.map_stock_to_index("Industrials", "Aerospace & Defense") == "CNXINFRA"
    assert indicators.map_stock_to_index("Financial Services", "Banks - Regional") == "NSEBANK"
    assert indicators.map_stock_to_index("Technology", "Software - Application") == "CNXIT"
    assert indicators.map_stock_to_index(None, None) == "CNXINFRA"


def test_indicators_use_no_future_data():
    rng = np.random.default_rng(7)
    n = 400
    c = 100 + np.cumsum(rng.normal(0.1, 1, n))
    idx = pd.bdate_range("2021-06-01", periods=n)
    df = pd.DataFrame({"Open": c, "High": c + 1, "Low": c - 1, "Close": c,
                       "Volume": rng.integers(1000, 5000, n).astype(float)}, index=idx)
    bench = pd.Series(100 + np.cumsum(rng.normal(0.05, 0.5, n)), index=idx)
    full = indicators.compute(df, bench)
    cut = indicators.compute(df.iloc[:300], bench.iloc[:300])
    pd.testing.assert_series_equal(full["score"].iloc[:300], cut["score"], check_names=False)
    pd.testing.assert_series_equal(full["pivot"].iloc[:300], cut["pivot"], check_names=False)


def test_pivot_excludes_current_bar():
    idx = pd.bdate_range("2023-01-02", periods=30)
    h = pd.Series(np.arange(30, dtype=float) + 10, index=idx)
    df = pd.DataFrame({"Open": h - 1, "High": h, "Low": h - 2, "Close": h - 0.5, "Volume": 1000.0})
    out = indicators.compute(df, pd.Series(100.0, index=idx))
    assert out["pivot"].iloc[25] == h.iloc[5:25].max()  # highs of bars 5..24


def _synthetic(n: int = 420):
    rng = np.random.default_rng(3)
    c = 100 + np.cumsum(rng.normal(0.1, 1.2, n))
    idx = pd.bdate_range("2021-06-01", periods=n)
    df = pd.DataFrame({"Open": c + rng.normal(0, 0.3, n), "High": c + 1.5, "Low": c - 1.5, "Close": c,
                       "Volume": rng.integers(2_000_000, 6_000_000, n).astype(float)}, index=idx)
    bench = pd.Series(100 + np.cumsum(rng.normal(0.05, 0.5, n)), index=idx)
    return df, bench


def test_movers_features_use_only_past_bars():
    from swing import movers
    df, bench = _synthetic()
    full = movers.window_features(movers.daily_features(df, bench))
    cut = movers.window_features(movers.daily_features(df.iloc[:350], bench.iloc[:350]))
    pd.testing.assert_frame_equal(full.iloc[:350], cut, check_exact=False, rtol=1e-9)


def test_movers_label_is_next_day_close_move_5_to_15_pct():
    from swing import movers
    df, bench = _synthetic()
    t = 330
    df.iloc[t + 1, df.columns.get_loc("Close")] = df["Close"].iloc[t] * 1.08   # +8 % next day
    df.iloc[t + 2, df.columns.get_loc("Close")] = df["Close"].iloc[t + 1] * 1.20  # +20 %: not a label
    ok = pd.Series(True, index=df.index)
    x = movers.build_stock(df, bench, ok, "2022-01-01")
    assert x["y"].loc[df.index[t]] == 1.0
    assert x["y"].loc[df.index[t + 1]] == 0.0
    assert abs(x["next_ret"].loc[df.index[t]] - 8.0) < 1e-9


def _px(rows):
    a = np.array(rows, dtype=float)
    return {"O": a[:, 0], "H": a[:, 1], "L": a[:, 2], "C": a[:, 3]}


FLAT = (100.0, 100.5, 99.5, 100.0)


def test_multiday_target_hit_on_entry_day():
    from swing import exits as m
    px = _px([FLAT, (100, 109, 99, 108), FLAT, FLAT, FLAT, FLAT, FLAT])
    assert abs(m.simulate(px, 0, 0.0, (3.0, None, 8.0, 5)) - 8.0) < 1e-9


def test_multiday_stop_first_on_entry_day():
    from swing import exits as m
    px = _px([FLAT, (100, 109, 96, 108), FLAT, FLAT, FLAT, FLAT, FLAT])
    assert abs(m.simulate(px, 0, 0.0, (3.0, None, 8.0, 5)) + 3.0) < 1e-9


def test_multiday_gap_down_exits_at_open_and_time_exit_at_close():
    from swing import exits as m
    gap = _px([FLAT, FLAT, (90, 91, 89, 90), FLAT, FLAT, FLAT, FLAT])
    assert abs(m.simulate(gap, 0, 0.0, (5.0, None, None, 5)) + 10.0) < 1e-9
    held = _px([FLAT, FLAT, FLAT, (100, 101, 99.6, 103), FLAT, FLAT, FLAT])
    assert abs(m.simulate(held, 0, 0.0, (5.0, None, None, 3)) - 3.0) < 1e-9


def test_multiday_trailing_stop_ratchets():
    from swing import exits as m
    # entry 100, bar1 high 120 -> trail stop 114; bar2 low 113 <= 114 -> exit at 114
    px = _px([FLAT, (100, 120, 99.5, 118), (118, 119, 113, 115), FLAT, FLAT, FLAT, FLAT])
    assert abs(m.simulate(px, 0, 0.0, (5.0, 5.0, None, 5)) - 14.0) < 1e-9


def test_multiday_buy_stop_not_triggered_returns_none():
    from swing import exits as m
    px = _px([FLAT, (100, 100.8, 99.5, 100.2), FLAT, FLAT, FLAT, FLAT, FLAT])
    assert m.simulate(px, 0, 1.0, (5.0, None, None, 3)) is None


def test_signal_close_stop_anchor_vs_fill_anchor():
    # ATR 10 makes the 5.5 % floor decisive: fill-anchored 100.3*0.945, signal-close-anchored 99.5*0.945
    f = _frame([BAR0, (100.1, 103, 100.2, 102.9, 1300), (103, 104, 102, 103, 1000)], atr14=10.0).reindex(CAL)
    el = pd.Series(False, index=CAL)
    el.iloc[0] = True
    by_fill, _ = backtest.run({"X": f}, {"X": el}, {"X": "S"}, CAL, backtest.Params(sl_anchor="fill"))
    by_close, _ = backtest.run({"X": f}, {"X": el}, {"X": "S"}, CAL, backtest.Params())
    assert abs(by_fill[0].initial_sl - 100.3 * 0.945) < 1e-9
    assert abs(by_close[0].initial_sl - 99.5 * 0.945) < 1e-9


def test_minmax_pct_hand_calculation():
    x = pd.Series([2.0, 4.0, 3.0, 5.02, 8.0, 3.0])
    out = indicators.minmax_pct(x, window=6, min_periods=2)
    # last bar: window min 2, max 8 -> (3-2)/(8-2) = 1/6 ; fourth bar: min 2, max 5.02 -> 1.0
    assert abs(out.iloc[-1] - 1 / 6) < 1e-5
    assert abs(out.iloc[3] - 1.0) < 1e-5
    assert out.iloc[0] != out.iloc[0]  # below min_periods stays missing


def test_complete_bars_drops_a_partial_bar_for_today_only():
    from datetime import datetime

    from swing import data

    idx = pd.to_datetime(["2026-11-03", "2026-11-04"])
    df = pd.DataFrame({"Close": [1.0, 2.0]}, index=idx)
    during = datetime(2026, 11, 4, 12, 0, tzinfo=data.IST)  # session still running
    after = datetime(2026, 11, 4, 16, 30, tzinfo=data.IST)
    next_day = datetime(2026, 11, 5, 9, 0, tzinfo=data.IST)
    assert list(data.complete_bars(df, during).index) == [idx[0]]
    assert list(data.complete_bars(df, after).index) == list(idx)
    assert list(data.complete_bars(df, next_day).index) == list(idx)


def test_report_helpers_drawdown_and_json_safety():
    from swing import export_report as ex

    eq = pd.Series([100.0, 120.0, 90.0, 130.0])
    assert [round(x, 2) for x in ex.drawdown_pct(eq)] == [0.0, 0.0, -25.0, 0.0]
    out = ex.clean({"a": np.float64("nan"), "b": np.int64(3), "c": [np.bool_(True), np.float64(1.5)]})
    assert out == {"a": None, "b": 3, "c": [True, 1.5]}
