"""The 1-minute shadow book: rules on completed candles, hand-calculated. Synthetic prices = FORMULA CHECKS, not market data.

Common order: pivot 100, trigger 100 x 1.003 = 100.3, no-chase limit 100 x 1.025 = 102.5, stop max(100 - 1.5 x 2, 99.5 x 0.945) = 97.0, ATR 2, minimum volume 1,000,000.
With a flat volume profile of 0.2 the volume needed at any time is 200,000.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.stream.models import LiveTick
from app.swing import minute_rules as mr
from app.swing.engine import Config, Decision, Order, Trade
from app.swing.minute_shadow import MinuteShadow, previous_session_default
from app.swing.minute_store import MinuteStore

IST = ZoneInfo("Asia/Kolkata")
DAY = date(2026, 11, 11)  # a Wednesday
CFG = Config()
PROFILE = dict.fromkeys(range(0, 376), 0.2)


def order(sym: str = "AAA", score: float = 70.0, rank: int = 1, pivot: float = 100.0) -> Order:
    trig = pivot * 1.003
    return Order("2026-11-10", sym, "IT", "BASE", score, (20, 20, 15, 15), pivot - 0.5, -0.5, pivot, trig, pivot * 1.025, pivot - 3.0, (trig - (pivot - 3.0)) / trig * 100, 2.0, 1_000_000.0, rank, rank)


def t(hh: int, mm: int, ss: int = 0, day: date = DAY) -> datetime:
    return datetime(day.year, day.month, day.day, hh, mm, ss, tzinfo=IST).astimezone(UTC)


def tick(px: float, now: datetime, vol: int = 250_000, day_open: float = 99.0, high: float | None = None, low: float | None = None) -> LiveTick:
    return LiveTick(key="nse_cm|1", kind="scrip", exchange_segment="nse_cm", instrument_token="1", ltp=px, open=day_open, high=high or px, low=low or px, volume=vol, received_at=now)


def candle(c: float, decision_min: int, *, session: str = "2026-11-11", day_high: float | None = None, day_low: float | None = None, vol: int = 250_000, day_open: float = 99.0) -> mr.Candle:
    return mr.Candle("AAA", session, decision_min - 1, c, c, c, c, vol, day_open, day_high, day_low)


class TestEntryRule:
    def test_signal_and_every_way_to_fail(self) -> None:
        o = order()
        assert mr.check_entry(o, candle(100.5, 10 * 60), PROFILE).state == "signal"  # 100.5 >= 100.3, <= 101.303, volume 250,000 >= 200,000
        assert mr.check_entry(o, candle(100.2, 10 * 60), PROFILE).state == "below_trigger"
        assert mr.check_entry(o, candle(100.3, 10 * 60), PROFILE).state == "signal"  # exactly the trigger counts
        assert mr.check_entry(o, candle(101.4, 10 * 60), PROFILE).state == "above_cap"  # 100.3 x 1.01 = 101.303
        assert mr.check_entry(o, candle(100.5, 10 * 60, day_open=103.0), PROFILE).state == "gap_skip"  # opened above 102.5
        assert mr.check_entry(o, candle(100.5, 10 * 60, vol=150_000), PROFILE).state == "volume_short"  # 150,000 / 200,000 = 75 %
        assert mr.check_entry(o, candle(100.5, 9 * 60 + 29), PROFILE).state == "outside_window"  # decided at 09:29
        assert mr.check_entry(o, candle(100.5, 15 * 60), PROFILE).state == "signal"  # 15:00 is the last decision minute
        assert mr.check_entry(o, candle(100.5, 15 * 60 + 1), PROFILE).state == "outside_window"

    def test_straight_line_pace_when_there_is_no_profile(self) -> None:
        o = order()
        assert mr.check_entry(o, candle(100.5, 9 * 60 + 40), None).state == "volume_early"  # not judged before 09:45 without a profile
        # 10:00: 45 of 375 minutes = 12 % of the day, so 120,000 is needed; 250,000 is on pace, 100,000 is not
        assert mr.check_entry(o, candle(100.5, 10 * 60), None).state == "signal"
        assert mr.check_entry(o, candle(100.5, 10 * 60, vol=100_000), None).state == "volume_short"
        frac, basis = mr.expected_fraction(10 * 60, None)
        assert basis == "straight-line" and frac == pytest.approx(45 / 375)
        assert mr.expected_fraction(10 * 60, PROFILE) == (0.2, "profile")


class TestPositionRules:
    pos = mr.ShadowPos("AAA", "2026-11-11", fill=100.5, shares=100, initial_sl=97.0, tsl=97.0, hh_close=100.5, atr14=2.0, pivot=100.0)  # R = 3.5

    def test_stop_is_a_candle_close_at_or_below_the_stop(self) -> None:
        assert mr.step(self.pos, candle(96.9, 11 * 60), CFG).exit_reason == "STOP_CLOSE"
        assert mr.step(self.pos, candle(97.0, 11 * 60), CFG).exit_reason == "STOP_CLOSE"  # equal counts
        assert mr.step(self.pos, candle(97.1, 11 * 60), CFG).exit_reason is None

    def test_breakeven_at_1_8_r_and_trail_at_2_5_r_on_the_highest_close(self) -> None:
        s = mr.step(self.pos, candle(106.9, 11 * 60), CFG)  # (106.9 - 100.5) / 3.5 = 1.83R (just past 1.8R: the exact boundary is not used, floating point)
        assert s.exit_reason is None and s.pos.tsl == pytest.approx(100.5 * 1.002) and s.pos.hh_close == 106.9  # 100.701
        s2 = mr.step(s.pos, candle(109.3, 11 * 60 + 1), CFG)  # 8.8 / 3.5 = 2.51R: max(100.701, 109.3 - 2.5 x 2) = 104.3
        assert s2.pos.tsl == pytest.approx(104.3)
        s3 = mr.step(s2.pos, candle(107.0, 11 * 60 + 2), CFG)  # price falls back: the stop never moves down and the high-water mark stays at 109.3
        assert s3.pos.tsl == pytest.approx(104.3) and s3.pos.hh_close == 109.3 and s3.exit_reason is None
        assert mr.step(s3.pos, candle(104.2, 11 * 60 + 3), CFG).exit_reason == "STOP_CLOSE"  # 104.2 <= 104.3

    def test_a_new_stop_level_applies_from_the_next_candle(self) -> None:
        # the candle that first reaches 1.8R closes at 106.9: it is tested against the OLD stop (97), so it cannot exit on the level it just set
        s = mr.step(self.pos, candle(106.9, 11 * 60), CFG)
        assert s.exit_reason is None
        assert mr.step(s.pos, candle(100.6, 11 * 60 + 1), CFG).exit_reason == "STOP_CLOSE"  # now the breakeven stop 100.701 is in force

    def test_day_one_checks_at_15_20_only(self) -> None:
        assert mr.step(self.pos, candle(99.9, 15 * 60 + 19), CFG).exit_reason is None  # decided at 15:19: too early
        s = mr.step(self.pos, candle(99.9, 15 * 60 + 20, day_high=101.0, day_low=99.0), CFG)
        assert s.exit_reason == "D1_FAIL_CLOSE"  # close below the pivot 100
        w = mr.step(self.pos, candle(100.4, 15 * 60 + 20, day_high=101.0, day_low=100.2), CFG)
        assert w.exit_reason == "D1_REJECT_WICK"  # (100.4 - 100.2) / (101.0 - 100.2) = 0.25 < 0.35
        ok = mr.step(self.pos, candle(100.8, 15 * 60 + 20, day_high=101.0, day_low=100.2), CFG)
        assert ok.exit_reason is None and ok.pos.d1_checked  # 0.75: passes, and it is not checked again
        later = mr.step(ok.pos, candle(99.9, 15 * 60 + 25, day_high=101.0, day_low=99.0), CFG)
        assert later.exit_reason is None
        # a position from an earlier session has no Day-1 check
        old = mr.ShadowPos("AAA", "2026-11-10", 100.5, 100, 97.0, 97.0, 100.5, 2.0, 100.0)
        assert mr.step(old, candle(99.9, 15 * 60 + 20, day_high=101.0, day_low=99.0), CFG).exit_reason is None


class Rig:
    """A shadow book fed by synthetic polls: ``minute(h, m, prices)`` sends polls at 5 s intervals inside one minute."""

    def __init__(self, tmp: Path, cfg: Config = CFG, orders: list[Order] | None = None) -> None:
        self.store = MinuteStore(tmp / "m.sqlite3")
        self.shadow = MinuteShadow(self.store, cfg, profile=lambda: PROFILE, prev_session=previous_session_default)
        self.orders = orders if orders is not None else [order()]

    def minute(self, hh: int, mm: int, prices: dict[str, list[float]] | list[float], vol: int = 250_000, day_open: float = 99.0) -> None:
        by = prices if isinstance(prices, dict) else {"AAA": prices}
        n = max(len(v) for v in by.values())
        for i in range(n):
            now = t(hh, mm, 5 + i * 5)
            ticks = {s: tick(p[min(i, len(p) - 1)], now, vol, day_open) for s, p in by.items()}
            self.shadow.on_poll(now, ticks, self.orders)


def test_a_signal_fills_at_the_next_candles_open_and_the_stop_exits_on_a_candle_close(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.minute(9, 59, [100.0, 100.6, 100.5])  # candle 09:59: close 100.5, decided at 10:00
    rig.minute(10, 0, [100.7, 100.8, 100.9])  # its first poll (100.7) is the next open and the fill; this candle closes 100.9
    f = rig.store.fills_of("2026-11-11")[0]
    assert f["fill"] == 100.7 and f["shares"] == 1986  # min(2 % x 1,000,000 / 3.7 = 5405, 1,000,000 / 5 / 100.7 = 1986)
    assert f["initial_sl"] == 97.0 and f["status"] == "open" and "next open" in f["evidence"]
    assert [e["kind"] for e in rig.store.events("2026-11-11")][::-1][:2] == ["entry_state", "entry_fill"]
    rig.minute(10, 1, [96.5, 96.7, 96.8])  # the 10:00 candle closed 100.9 (> 97): held; candle 10:01 closes 96.8
    assert rig.store.open_rows()[0]["status"] == "open"
    rig.minute(10, 2, [96.0, 96.1])  # 10:01 completes: close 96.8 <= 97, exit at this open 96.0
    c = rig.store.rows()[0]
    assert c["status"] == "closed" and c["exit_reason"] == "STOP_CLOSE" and c["exit_price"] == 96.0
    gross = 1986 * (96.0 - 100.7)
    assert c["gross_pnl"] == pytest.approx(gross) and c["costs"] == pytest.approx(1986 * (96.0 * 0.0015 + 100.7 * 0.0015)) and c["pnl"] == pytest.approx(gross - c["costs"])
    cash, equity = rig.store.cash_equity(CFG)
    assert cash == pytest.approx(1_000_000 + c["pnl"]) and equity == pytest.approx(cash)  # nothing open


def test_the_fill_is_cancelled_if_the_next_open_is_more_than_one_percent_above_the_trigger(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.minute(9, 59, [100.0, 100.6, 100.5])
    rig.minute(10, 0, [101.5, 101.6])  # 101.5 > 100.3 x 1.01 = 101.303
    assert rig.store.fills_of("2026-11-11") == []
    ev = [e for e in rig.store.events("2026-11-11") if e["kind"] == "entry_cancelled"]
    assert len(ev) == 1 and "not chased" in ev[0]["detail"]["reason"]


def test_a_state_is_logged_when_it_changes_not_on_every_candle(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    for mm in range(0, 4):  # four candles with too little volume
        rig.minute(10, mm, [100.5, 100.6], vol=100_000)
    rig.minute(10, 4, [100.5, 100.6], vol=100_000)
    states = rig.store.state_history("2026-11-11", "AAA")
    assert states == ["volume_short"]  # one event for four identical readings
    rig.minute(10, 5, [100.5, 100.6], vol=250_000)  # volume catches up
    rig.minute(10, 6, [100.5, 100.6], vol=250_000)
    assert rig.store.state_history("2026-11-11", "AAA") == ["volume_short", "signal"]


def test_slots_and_the_same_day_rule_block_a_second_entry(tmp_path: Path) -> None:
    cfg = Config(slots=1)
    rig = Rig(tmp_path, cfg, [order("AAA", 70, 1), order("BBB", 66, 2)])
    both = {"AAA": [100.5, 100.6], "BBB": [100.5, 100.6]}
    rig.minute(10, 0, both)
    rig.minute(10, 1, {"AAA": [100.7], "BBB": [100.7]})  # both completed 10:00 candles signal; the better score (AAA) takes the only slot
    assert [f["symbol"] for f in rig.store.fills_of("2026-11-11")] == ["AAA"]
    assert rig.store.last_state("2026-11-11", "BBB")["state"] == "signal_blocked"
    assert "slots" in rig.store.last_state("2026-11-11", "BBB")["note"]


def test_day_one_exit_at_15_20_and_the_last_candle_at_the_close(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.store.add_fill(session="2026-11-11", symbol="AAA", order_session="2026-11-10", rank=1, score=70, signal_at=t(10, 0), filled_at=t(10, 0), fill=100.5, shares=100, trigger=100.3,
                       pivot=100.0, initial_sl=97.0, atr14=2.0, equity=1_000_000, evidence="x")
    rig.orders = []
    rig.minute(15, 19, [99.9, 99.9])  # candle 15:19, decided at 15:20: close 99.9 is below the pivot 100
    rig.minute(15, 20, [99.8, 99.8])  # its first poll is the next open: the exit
    r = rig.store.rows()[0]
    assert r["status"] == "closed" and r["exit_reason"] == "D1_FAIL_CLOSE" and r["exit_price"] == 99.8 and r["exit_basis"] == "next open"
    # a position still open when the market closes: its last candle completes with no next price, so the fill falls back to the decision close (flagged)
    rig2 = Rig(tmp_path / "b")
    rig2.store.add_fill(session="2026-11-11", symbol="AAA", order_session="2026-11-10", rank=1, score=70, signal_at=t(10, 0), filled_at=t(10, 0), fill=100.5, shares=100, trigger=100.3,
                        pivot=100.0, initial_sl=97.0, atr14=2.0, equity=1_000_000, evidence="x")
    rig2.orders = []
    rig2.minute(15, 29, [96.0, 96.2])  # close 96.2 <= stop 97
    rig2.shadow.on_close(t(15, 31))
    r2 = rig2.store.rows()[0]
    assert r2["exit_reason"] == "STOP_CLOSE" and r2["exit_price"] == pytest.approx(96.2) and "decision close" in r2["exit_basis"]


def test_open_positions_survive_a_restart_and_are_watched(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.minute(10, 0, [100.5, 100.6])
    rig.minute(10, 1, [100.7])
    assert rig.shadow.open_symbols() == {"AAA"}
    again = MinuteShadow(MinuteStore(tmp_path / "m.sqlite3"), CFG, prev_session=previous_session_default)
    assert again.open_symbols() == {"AAA"}  # state lives in the store, not in memory


def test_comparison_with_the_official_book(tmp_path: Path) -> None:
    rig = Rig(tmp_path, CFG, [order("AAA", 70, 1), order("BBB", 66, 2), order("CCC", 65, 3)])
    rig.minute(10, 0, {"AAA": [100.5, 100.6], "BBB": [100.0], "CCC": [100.5]}, vol=250_000)
    rig.minute(10, 1, {"AAA": [100.7], "BBB": [100.0], "CCC": [100.6]})
    # AAA: shadow filled 100.7; official filled 100.3. BBB: neither. CCC: official filled, shadow also did.
    o = {o.symbol: o for o in rig.orders}
    decisions = [Decision(o["AAA"], "filled", "", 100.3, 1990), Decision(o["BBB"], "skipped", "never traded through the trigger"), Decision(o["CCC"], "skipped", "volume 1 below the minimum")]
    trade = Trade("ZZZ", "IT", "BASE", 70, "2026-11-10", 100.0, 100.0, 97.0, 100, "2026-11-11", 96.0, "STOP", -400.0, 30.0, -430.0, -1.3, 1, 5)
    s = rig.shadow.settled("2026-11-11", decisions, [trade], t(17, 5))
    assert s == {"orders": 3, "both_filled": 1, "only_official": 0, "only_shadow": 1, "neither": 1, "exits_compared": 1}
    cmp = rig.store.comparisons(1)[0]
    a = next(e for e in cmp["entries"] if e["symbol"] == "AAA")
    assert a["same"] and a["fill_diff_pct"] == pytest.approx((100.7 / 100.3 - 1) * 100, abs=0.01) and "filled 100.70" in a["shadow"] and a["official"] == "filled 100.30 x 1990"
    b = next(e for e in cmp["entries"] if e["symbol"] == "BBB")
    assert b["same"] and "not bought" in b["shadow"] and "below trigger" in b["shadow"]
    c = next(e for e in cmp["entries"] if e["symbol"] == "CCC")
    assert not c["same"] and c["shadow_filled"] and not c["official_filled"]
    assert cmp["exits"][0]["shadow_took_it"] is False  # the shadow book never held ZZZ


def test_the_page_view_and_data_coverage(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.minute(10, 0, [100.5, 100.6])
    rig.minute(10, 1, [100.7, 100.8])
    v = rig.shadow.view(t(10, 1, 30), market_open=True)
    assert v["mode"] == "shadow" and v["volume_basis"] == "profile" and v["profile_ready"] and len(v["rules"]) == 5
    assert v["book"]["open"] == 1 and v["book"]["capital"] == 1_000_000
    assert v["positions"][0]["symbol"] == "AAA" and v["positions"][0]["stage"] == "initial stop"
    assert v["data"]["bars_today"] == 1 and v["data"]["symbols_with_bars"] == 1
    assert "nothing is filled in" in v["data"]["note"]
    assert previous_session_default(date(2026, 11, 9)) == date(2026, 11, 6)  # Monday -> the Friday before


# ---------------------------------------------------------------- through the live watcher
def test_the_live_watcher_feeds_the_shadow_book_and_a_failing_shadow_never_breaks_the_poll(tmp_path: Path) -> None:
    from app.stream.models import FeedToken
    from app.swing.live import SwingLive
    from app.swing.store import PaperStore

    d4 = date(2026, 11, 4)  # Wednesday; the queued order came from the 3 Nov scan
    shadow = MinuteShadow(MinuteStore(tmp_path / "m.sqlite3"), CFG, profile=lambda: PROFILE, prev_session=previous_session_default)
    now = {"t": t(9, 59, 10, d4)}
    ticks: dict[str, LiveTick] = {}
    live = SwingLive(PaperStore(tmp_path), CFG, ticks=lambda: dict(ticks), scrip_master=None, add_tokens=None, feed_state=lambda: "streaming", clock=lambda: now["t"], minute=shadow)
    live.load_watch = lambda: None  # type: ignore[method-assign]
    o = order("ABC")
    live._orders, live._last_scan, live._positions = [o], "2026-11-03", []
    live._tokens = {"ABC": FeedToken(exchange_segment="nse_cm", instrument_token="111")}

    def poll(hh: int, mm: int, ss: int, px: float) -> None:
        now["t"] = t(hh, mm, ss, d4)
        ticks["nse_cm|111"] = LiveTick(key="nse_cm|111", kind="scrip", exchange_segment="nse_cm", instrument_token="111", ltp=px, open=99.0, high=px, low=px, volume=250_000, received_at=now["t"])
        live.poll(now["t"])

    poll(9, 59, 10, 100.0)
    poll(9, 59, 40, 100.6)
    poll(10, 0, 5, 100.7)  # completes the 09:59 candle (close 100.6): a signal, filled at this first poll of the next minute
    f = shadow.store.fills_of("2026-11-04")
    assert len(f) == 1 and f[0]["symbol"] == "ABC" and f[0]["fill"] == 100.7
    live._orders = []
    assert live._symbols() == ["ABC"]  # the shadow book's open position keeps the stock watched and subscribed
    shadow.on_poll = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))  # type: ignore[method-assign]
    poll(10, 1, 5, 100.9)  # the poll survives a failing shadow book
    now["t"] = t(15, 31, 0, d4)
    assert live.poll(now["t"]) == 0  # closed market: nothing to do, and the shadow book is told to complete its candles


def test_the_comparison_says_the_official_book_already_held_the_stock_and_the_live_book_is_separate(tmp_path: Path) -> None:
    rig = Rig(tmp_path, CFG, [order("AAA", 70, 1)])
    rig.minute(10, 0, {"AAA": [99.0]})  # below the trigger: the live book does not buy
    rig.minute(10, 1, {"AAA": [99.0]})
    decisions = [Decision(rig.orders[0], "skipped", "already holding this stock")]
    rig.shadow.settled("2026-11-11", decisions, [], t(17, 5))
    e = rig.store.comparisons(1)[0]["entries"][0]
    assert e["official"].startswith("skipped: already holding this stock") and "live book is separate" in e["official"]
    assert e["shadow"] == "not bought: last reading inside the entry window was below trigger" and e["shadow_filled"] is False


def test_the_equity_curve_is_recorded_once_a_minute_and_the_view_carries_analytics_levels_and_dates(tmp_path: Path) -> None:
    rig = Rig(tmp_path)
    rig.minute(9, 59, [100.0, 100.6, 100.5])
    rig.minute(10, 0, [100.7, 100.8, 100.9])
    rig.minute(10, 1, [101.0, 101.1])
    series = rig.store.equity_series()
    assert len(series) == 3 and [a[11:16] for a, _ in series] == ["04:29", "04:30", "04:31"]  # 09:59, 10:00, 10:01 IST, one row per minute however many polls
    assert series[0][1] == 1_000_000  # before the fill the book is flat
    v = rig.shadow.view(t(10, 1, 30), market_open=True)
    assert v["equity_curve"][0]["equity"] == 1_000_000 and v["equity_curve"][-1]["at"] == series[-1][0]
    assert v["started"]["equity_recorded_from"] == series[0][0] and v["started"]["first_fill_at"] is not None
    p = v["positions"][0]
    risk = p["fill"] - p["initial_sl"]
    assert p["level_1_8r"] == pytest.approx(p["fill"] + 1.8 * risk) and p["level_2_5r"] == pytest.approx(p["fill"] + 2.5 * risk)
    assert p["reached_1_8r"] is False and p["to_stop_pct"] == pytest.approx((p["tsl"] / p["last_price"] - 1) * 100)
    assert v["analytics"]["trades"] == 0 and v["analytics"]["win_rate_pct"] is None and v["analytics"]["profit_factor"] is None  # nothing closed: missing, not zero
