"""Paper-trading rules: hand-calculated cases, and trade-for-trade parity with the research backtest."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from app.swing.engine import Bar, Book, Config, Order, make_orders, settle_session
from app.swing.indicators import Bars, Setup, analyse

CFG = Config(cost_per_side=0.0)


def order(symbol="X", score=70.0, pivot=100.0, atr=2.0, close=99.5, **kw) -> Order:
    trig = pivot * 1.003
    stop = max(pivot - 1.5 * atr, close * 0.945)
    base = dict(session="d0", symbol=symbol, sector="CNXIT", archetype="BLUE_SKY", score=score, pillars=(1, 1, 1, 1),
                close=close, dist_pct=-0.5, pivot=pivot, trigger=trig, max_open=pivot * 1.025, initial_sl=stop,
                risk_pct=(trig - stop) / trig * 100, atr14=atr, min_volume=1250.0)
    base.update(kw)
    return Order(**base)


def bar(o, h, low, c, v=2000.0, date="d1") -> Bar:
    return Bar(date, o, h, low, c, v)


def book(cash=1_000_000.0) -> Book:
    return Book(cash=cash, equity=cash)


def settle(b, bars, orders, cfg=CFG, no=1, setups=None):
    return settle_session(b, "d1", no, bars, setups or {}, orders, cfg)


def test_fill_is_max_of_open_and_trigger_and_size_is_the_smaller_cap() -> None:
    b = book()
    r = settle(b, {"X": bar(100.1, 103.0, 100.2, 102.9)}, [order()])
    d = r.decisions[0]
    assert d.outcome == "filled" and d.fill == pytest.approx(100.3)
    # risk 3.3 -> 2% of 1,000,000 = 6060 shares; slot cap 1,000,000/5/100.3 = 1994
    assert d.shares == 1994 and b.positions["X"].initial_sl == pytest.approx(97.0)
    assert b.cash == pytest.approx(1_000_000 - 1994 * 100.3)


@pytest.mark.parametrize("bars,keyword", [
    (bar(102.6, 104, 102.5, 103), "no-chase"),
    (bar(100.0, 100.2, 99.5, 100.1), "trigger"),
    (bar(100.5, 102, 100.4, 101.9, v=1200), "volume"),
])
def test_orders_that_fail_an_entry_rule_are_skipped_with_a_reason(bars: Bar, keyword: str) -> None:
    b = book()
    d = settle(b, {"X": bars}, [order()]).decisions[0]
    assert d.outcome == "skipped" and not b.positions and keyword in d.reason


def test_day_one_cuts_exit_at_the_right_price() -> None:
    cases = [
        (bar(100.4, 101.5, 96.0, 101.0), "D1_STOP", 97.0),           # low through the stop: exit at the stop
        (bar(100.4, 101.0, 99.0, 99.5), "D1_FAIL_CLOSE", 99.5),       # closed below the pivot
        (bar(100.4, 103.0, 100.4, 100.9), "D1_REJECT_WICK", 100.9),   # closed in the bottom 35% of the range
    ]
    for bars, reason, px in cases:
        b = book()
        r = settle(b, {"X": bars}, [order()])
        assert not b.positions and r.trades[0].reason == reason and r.trades[0].exit == pytest.approx(px)


def test_breakeven_trailing_and_gap_exits_over_following_sessions() -> None:
    b = book()
    s1 = {"X": Setup("d1", 106.8, 70, (1, 1, 1, 1), 100, -1, 2.0, 100.0, 1000.0, "BLUE_SKY", 1.0)}
    settle(b, {"X": bar(100.4, 107.0, 100.4, 106.8)}, [order()], setups=s1)  # fill 100.4, R 3.4; high 107 = 1.9R
    assert b.positions["X"].tsl == pytest.approx(100.4 * 1.002)               # breakeven lock
    s2 = {"X": Setup("d2", 118.0, 70, (1, 1, 1, 1), 100, -1, 2.0, 100.0, 1000.0, "BLUE_SKY", 1.0)}
    settle(b, {"X": bar(106.0, 120.0, 105.0, 118.0, date="d2")}, [], no=2, setups=s2)
    assert b.positions["X"].tsl == pytest.approx(120.0 - 2.5 * 2.0)           # Chandelier after 2.5R
    r = settle(b, {"X": bar(90.0, 91.0, 89.0, 90.0, date="d3")}, [], no=3, setups=s2)
    assert r.trades[0].reason == "STOP_GAP" and r.trades[0].exit == 90.0      # a gap down exits at the open
    b2 = book()
    settle(b2, {"X": bar(100.4, 107.0, 100.4, 106.8)}, [order()])
    out = settle(b2, {"X": bar(104.0, 105.0, 100.0, 101.0, date="d2")}, [], no=2)
    assert out.trades[0].reason == "STOP" and out.trades[0].exit == pytest.approx(100.4 * 1.002)


def test_slots_cooldown_priority_and_costs() -> None:
    cfg = Config(slots=2, cost_per_side=0.001)
    orders = [order("B", score=66), order("A", score=70), order("C", score=70)]
    good = bar(100.4, 107.0, 100.4, 106.8)
    b = book()
    r = settle(b, {s: good for s in "ABC"}, orders, cfg)
    assert [d.order.symbol for d in r.decisions] == ["A", "C", "B"]  # score first, ties alphabetical
    assert set(b.positions) == {"A", "C"} and "slots" in r.decisions[2].reason
    b2 = book()  # sold in session 1: cannot be bought again before session 4
    b2.last_exit_no["X"] = 1
    assert "cooldown" in settle(b2, {"X": good}, [order()], cfg, no=3).decisions[0].reason
    assert settle(b2, {"X": good}, [order()], cfg, no=4).decisions[0].outcome == "filled"
    b3 = book()  # 0.1 % each side on a stop-out at the initial stop
    t = settle(b3, {"X": bar(100.4, 101.5, 96.0, 101.0)}, [order()], cfg).trades[0]
    assert t.gross_pnl == pytest.approx(t.shares * (97.0 - 100.4))
    assert t.costs == pytest.approx(t.shares * (97.0 * 0.001 + 100.4 * 0.001))
    assert t.pnl == pytest.approx(t.gross_pnl - t.costs)


def test_make_orders_applies_score_distance_gate_and_ranks() -> None:
    def s(score, dist):
        return Setup("d0", 99.5, score, (1, 1, 1, 1), 100.0, dist, 2.0, 99.0, 1000.0, "BLUE_SKY", 1.0)
    setups = {"HI": s(72, -1.0), "LO": s(64, -1.0), "FAR": s(70, -5.0), "GATED": s(70, -1.0), "MID": s(66, 0.5)}
    orders, blocked = make_orders("d0", setups, {"HI": "CNXIT"}, {"HI": True, "MID": True, "GATED": False}, Config())
    assert [(o.symbol, o.rank) for o in orders] == [("HI", 1), ("MID", 2)] and blocked == 1
    assert orders[0].sector == "CNXIT" and orders[0].trigger == pytest.approx(100.3)
    assert orders[0].initial_sl == pytest.approx(max(100 - 3.0, 99.5 * 0.945))


# --- parity with the research backtest ------------------------------------------------------------
pd = pytest.importorskip("pandas")
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "research"))
from swing import backtest as rb  # noqa: E402
from swing import indicators as ri  # noqa: E402

from tests.unit.test_swing_indicators import frame, series  # noqa: E402


def test_paper_engine_reproduces_the_research_backtest_trade_for_trade() -> None:
    names = sorted(f"S{n:02d}" for n in range(30))
    raw = {s: series(100 + i, n=400, drift=0.0010 + 0.00005 * (i % 7), vol=0.014 + 0.0004 * (i % 5)) for i, s in enumerate(names)}
    bench = raw[names[0]].bench
    data = {s: Bars(d.dates, d.o, d.h, d.low, d.c, d.v, bench) for s, d in raw.items()}  # one benchmark for all
    frames, elig = {}, {}
    for s in names:
        df, bs = frame(data[s])
        frames[s] = ri.compute(df, bs)
        elig[s] = pd.Series(True, index=df.index)
    first = 240
    cal = pd.to_datetime(data[names[0]].dates)[first:]
    ref_trades, _ = rb.run(frames, elig, {s: "X" for s in names}, cal, rb.Params(min_score=55.0, cost_per_side=0.0015, vol_mult=1.25))  # both engines at the spec's 1.25: the synthetic volumes are built for it; the property is equality of logic
    ref = [t for t in ref_trades if t.reason != "OPEN_AT_END"]
    assert len(ref) >= 20, "the scenario must produce enough trades to mean something"

    cfg = Config(min_score=55.0, cost_per_side=0.0015, vol_mult=1.25)
    bk = Book(cfg.capital, cfg.capital)
    pending: list[Order] = []
    got = []
    for k, day in enumerate(cal):
        i = first + k
        bars = {s: Bar(data[s].dates[i], data[s].o[i], data[s].h[i], data[s].low[i], data[s].c[i], data[s].v[i]) for s in names}
        setups = {s: analyse(data[s], i) for s in names}
        res = settle_session(bk, str(day.date()), k, bars, setups, pending if k > 0 else [], cfg)
        got += res.trades
        pending, _ = make_orders(str(day.date()), setups, {}, {s: True for s in names}, cfg)
    want = sorted((str(t.entry_date.date()), t.symbol, round(t.entry, 6), t.shares, str(t.exit_date.date()), round(t.exit, 6), t.reason)
                  for t in ref)
    have = sorted((t.entry_session, t.symbol, round(t.entry, 6), t.shares, t.exit_session, round(t.exit, 6), t.reason)
                  for t in got)
    assert have == want
    assert sum(t.pnl for t in got) == pytest.approx(sum(t.pnl for t in ref), rel=1e-9)


def test_the_volume_requirement_is_two_times_the_average_from_rule_version_v2() -> None:
    """swing-v2 (11 Nov 2026): the minimum volume of an order is 2.0 x the 20-day average (the spec's 1.25 before). Locked in so a change is deliberate."""
    from app.swing.engine import RULE_VERSION
    from app.swing.indicators import Setup

    assert Config().vol_mult == 2.0 and RULE_VERSION == "swing-v2"
    s = Setup("d0", 99.5, 70.0, (20, 20, 15, 15), 100.0, -0.5, 2.0, 10.0, 1000.0, "BLUE_SKY", 1.0)
    orders, _ = make_orders("d0", {"X": s}, {"X": "CNXIT"}, {"X": True}, Config())
    assert orders[0].min_volume == pytest.approx(2000.0)  # 2.0 x vol_sma20 of 1000
    # 1,500 shares traded is above the old 1.25 x (1,250) and below the new minimum (2,000): skipped now
    b = book()
    d = settle(b, {"X": bar(100.5, 102, 100.4, 101.9, v=1500)}, orders).decisions[0]
    assert d.outcome == "skipped" and "volume" in d.reason
    assert settle(book(), {"X": bar(100.5, 102, 100.4, 101.9, v=2100)}, orders).decisions[0].outcome == "filled"
