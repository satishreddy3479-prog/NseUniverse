"""Order-flow, technical-read and weight-estimation tests.

Hand calculations are written out in each test. Synthetic numbers here are FORMULA CHECKS (labelled), not market data.
The bhavcopy open/high/low values are the real NSE 28 Oct 2026 line for 360ONE.
"""

from __future__ import annotations

import random
from datetime import UTC, datetime
from pathlib import Path

from app.market.flow import FlowTracker, profile_fraction, volume_profile
from app.market.sources import parse_bhavcopy, parse_nifty_future
from app.market.store import MarketStore
from app.market.technical import Bar, atr, read, rsi, sma
from app.market.weights import estimate

T0 = datetime(2026, 10, 29, 4, 0, tzinfo=UTC)
DAY = "2026-10-29"


def test_flow_classifies_by_quote_then_tick_rule_and_leaves_the_start_unclassified() -> None:
    f = FlowTracker("NIFTYFUT")
    f.update(T0, "09:20", DAY, 1000, 100.00)  # first push: 1000 already traded, not classified, not guessed
    assert (f.buy, f.sell, f.unclassified, f.last_volume) == (0, 0, 0, 1000)
    f.update(T0, "09:21", DAY, 1100, 100.05, bid=100.00, ask=100.05)  # at the ask -> 100 buy (quote rule)
    f.update(T0, "09:22", DAY, 1150, 100.00, bid=100.00, ask=100.05)  # at the bid -> 50 sell
    f.update(T0, "09:23", DAY, 1170, 100.02, bid=100.00, ask=100.05)  # between quotes, price up -> 20 buy (tick rule)
    f.update(T0, "09:24", DAY, 1190, 100.02, bid=100.00, ask=100.05)  # unchanged: previous side (buy) -> 20 buy
    p = f.public()
    assert (p["buy_volume"], p["sell_volume"], p["cvd"]) == (140, 50, 90)  # 100+20+20, 50, 140-50
    assert p["cvd_pct"] == round(90 / 190 * 100, 2)
    assert p["quote_rule_share"] == round(150 / 190, 3)  # 100 + 50 were classified by the bid/ask
    assert p["estimated"] is True


def test_flow_unclassifiable_volume_stays_unclassified_and_a_new_day_resets() -> None:
    f = FlowTracker("X")
    f.update(T0, "09:20", DAY, 500, 50.0)
    f.update(T0, "09:21", DAY, 530, 50.0)  # no quotes, price unchanged, no earlier side
    assert (f.buy, f.sell, f.unclassified) == (0, 0, 30)
    assert f.public()["classified_share"] == 0.0 and f.public()["cvd_pct"] is None
    f.update(T0, "09:20", "2026-10-30", 10, 51.0)  # next trading day
    assert f.unclassified == 0 and f.last_volume == 10
    f.update(T0, "09:25", "2026-10-30", 5, 51.0)  # the counter went backwards: restart, do not guess
    assert f.last_volume == 5 and f.buy == f.sell == 0


def test_divergence_flags_price_up_while_sellers_lead() -> None:
    f = FlowTracker("NIFTYFUT")
    price, vol = 100.0, 1000
    f.update(T0, "09:15", DAY, vol, price)
    for i in range(1, 36):
        # price creeps up 0.01 a minute but every push trades at the bid -> sells
        price += 0.01
        vol += 10
        f.update(T0, f"09:{15 + i:02d}" if i < 45 else "10:00", DAY, vol, price, bid=price, ask=price + 0.05)
    d = f.divergence()
    assert d is not None and d["state"] == "bearish_divergence" and d["cvd_change"] < 0 and d["price_change_pct"] > 0.05


def test_volume_profile_is_the_median_share_and_waits_for_five_sessions() -> None:
    def day(front: float) -> list[tuple[int, float]]:  # cumulative volume reaching 1000 at minute 375
        return [(t, 1000 * (t / 375) ** front) for t in range(0, 376)]

    assert volume_profile([day(0.5)] * 4) is None  # 4 sessions: not enough
    prof = volume_profile([day(0.5)] * 5)
    assert prof is not None
    assert round(prof[93], 3) == round((93 / 375) ** 0.5, 3)  # front-loaded: 49.8% done after a quarter of the day
    assert profile_fraction(prof, 93.4) == prof[93]
    assert profile_fraction(None, 93) is None
    assert volume_profile([day(0.5)[:50]] * 6) is None  # partial sessions are ignored


def test_sma_rsi_atr_match_hand_calculations() -> None:
    assert sma([1, 2, 3, 4], 2) == 3.5 and sma([1], 2) is None
    # closes 10,11,10,12 with n=2: first window changes +1,-1 -> gain .5 loss .5; then +2 -> gain 1.25, loss .25
    assert round(rsi([10, 11, 10, 12], 2) or 0, 3) == round(100 - 100 / (1 + 5), 3)  # 83.333
    assert rsi([1, 2, 3, 4, 5], 3) == 100.0 and rsi([1, 2], 14) is None
    bars = [Bar("a", 9, 10, 8, 9, 1), Bar("b", 9, 11, 9, 10, 1), Bar("c", 10, 12, 10, 11, 1), Bar("d", 11, 13, 10, 12, 1)]
    # true ranges: 2, 2, 3 -> first 2 average 2, then (2*1 + 3)/2
    assert atr(bars, 2) == 2.5 and atr(bars[:2], 2) is None


def test_technical_read_leaves_missing_values_missing() -> None:
    bars = [Bar(f"d{i}", 100 + i, 101 + i, 99 + i, 100.5 + i, 1000 + i) for i in range(25)]
    r = read("ABC", bars, live_price=130.0)
    assert r["sma50"] is None and r["enough_history"] is False and r["bars"] == 25
    assert r["sma20"] == round(sum(100.5 + i for i in range(5, 25)) / 20, 2)  # mean of the last 20 closes
    assert r["trend"] == "above 20-day average" and r["high20"] == 125 and r["low20"] == 104
    assert read("ABC", [], None)["sma20"] is None and read("ABC", [], None)["trend"] is None


def test_bhavcopy_now_keeps_the_real_open_high_low_and_the_daily_store_holds_them(tmp_path: Path) -> None:
    text = (
        "SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER\n"
        "360ONE, EQ, 28-Oct-2026, 973.00, 973.00, 995.30, 965.70, 991.00, 991.00, 979.05, 330282, 3233.62, 12364, 208810, 63.22\n"
    )
    row = parse_bhavcopy(text)[0]
    assert (row.open, row.high, row.low, row.close) == (973.0, 995.3, 965.7, 991.0)
    st = MarketStore(tmp_path)
    st.save_bhav([row])
    assert st.daily_bars("360ONE") == [("2026-10-28", 973.0, 995.3, 965.7, 991.0, 330282)]
    assert st.daily_sessions() == ["2026-10-28"]


def test_nifty_future_is_picked_by_contract_month() -> None:
    rows = [
        {"pSymbol": "1", "pTrdSymbol": "NIFTY26OCTFUT", "pExchSeg": "nse_fo"},
        {"pSymbol": "2", "pTrdSymbol": "NIFTY26NOVFUT", "pExchSeg": "nse_fo"},
        {"pSymbol": "3", "pTrdSymbol": "BANKNIFTY26NOVFUT", "pExchSeg": "nse_fo"},
        {"pSymbol": "4", "pTrdSymbol": "NIFTY26NOV24000CE", "pExchSeg": "nse_fo"},
    ]
    t = parse_nifty_future(rows, 2026, 11)
    assert t is not None and (t.token, t.trading_symbol, t.symbol) == ("2", "NIFTY26NOVFUT", "FUT:NIFTY")
    assert parse_nifty_future(rows, 2026, 12) is None


def test_list_change_is_recorded(tmp_path: Path) -> None:
    st = MarketStore(tmp_path)
    st.save_list_change("nifty50", ["NEWCO"], ["OLDCO"], T0)
    assert st.list_changes() == [{"index": "nifty50", "detected": T0.isoformat(), "added": ["NEWCO"], "removed": ["OLDCO"]}]


def test_weight_estimation_recovers_known_weights_and_refuses_a_bad_fit() -> None:
    """FORMULA CHECK on synthetic returns: index = sum(weight x stock change). Not market data."""
    random.seed(7)
    syms = [f"S{i}" for i in range(6)]
    true = [0.35, 0.25, 0.15, 0.12, 0.08, 0.05]
    rows = []
    for _ in range(200):
        x = {s: random.gauss(0, 0.6) for s in syms}
        rows.append((sum(w * x[s] for w, s in zip(true, syms, strict=True)), x))
    got = estimate(rows, syms)
    assert got is not None
    w, rmse = got
    assert rmse < 0.001 and all(abs(w[s] - t * 100) < 0.05 for s, t in zip(syms, true, strict=True))
    noisy = [(y + random.gauss(0, 1.0), x) for y, x in rows]
    assert estimate(noisy, syms) is None  # does not reproduce the index: no weights are produced
    assert estimate(rows[:50], syms) is None  # too few rows
