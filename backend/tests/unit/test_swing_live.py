"""Live checks for the swing paper book: the rules, the watcher, the subscription and the shadow log."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.stream.models import FeedToken, LiveTick, StreamState
from app.swing.engine import Book, Config, Order, Position
from app.swing.live import SwingLive
from app.swing.live_rules import (
    check_entry,
    check_position,
    session_fraction,
    session_state,
    volume_pace,
)
from app.swing.store import PaperStore

IST = ZoneInfo("Asia/Kolkata")
CFG = Config()


def at(h: int, m: int = 0, day: int = 4) -> datetime:  # Wednesday 4 Nov 2026, IST
    return datetime(2026, 11, day, h, m, tzinfo=IST).astimezone(UTC)


def tick(key: str = "nse_cm|111", *, ltp=100.0, open_=99.0, high=101.0, low=98.5, volume=500_000, received=None,
         prev_close=98.0) -> LiveTick:
    return LiveTick(key=key, kind="scrip", exchange_segment="nse_cm", instrument_token=key.split("|")[1], ltp=ltp,
                    open=open_, high=high, low=low, prev_close=prev_close, volume=volume,
                    received_at=received or at(11))


def order(symbol="ABC", **kw) -> Order:
    base = dict(session="2026-11-03", symbol=symbol, sector="CNXIT", archetype="BLUE_SKY", score=70.0,
                pillars=(1, 1, 1, 1), close=99.5, dist_pct=-0.5, pivot=100.0, trigger=100.3, max_open=102.5,
                initial_sl=97.0, risk_pct=3.3, atr14=2.0, min_volume=1_000_000.0, rank=1, id=1)
    base.update(kw)
    return Order(**base)


def position(symbol="XYZ", **kw) -> Position:
    base = dict(symbol=symbol, sector="CNXIT", archetype="BLUE_SKY", score=70.0, pivot=100.0, entry_session="2026-11-02",
                entry_no=2, fill=100.4, shares=100, initial_sl=97.0, tsl=100.6, hh=104.0, last_close=103.0, order_id=2)
    base.update(kw)
    return Position(**base)


# ---------------------------------------------------------------- rules
def test_session_clock_and_volume_pace() -> None:
    assert session_state(at(9, 14)) == "closed" and session_state(at(9, 15)) == "open"
    assert session_state(at(15, 29)) == "open" and session_state(at(15, 30)) == "closed"
    assert session_state(at(11, 0, day=7)) == "closed"  # Saturday
    assert session_fraction(at(9, 0)) == 0 and session_fraction(at(16, 0)) == 1
    assert session_fraction(at(12, 22)) == pytest.approx((187) / 375, abs=0.005)
    # half the session gone, half the minimum volume done: exactly on pace
    assert volume_pace(500_000, 1_000_000, at(12, 22)) == pytest.approx(1.0, abs=0.01)
    assert volume_pace(None, 1_000_000, at(12, 0)) is None


def test_entry_states() -> None:
    o = order()
    assert check_entry(o, None, at(11)).state == "no_data"
    assert check_entry(o, tick(ltp=99.0), at(11)).state == "waiting"
    gap = check_entry(o, tick(ltp=103.0, open_=102.6), at(11))
    assert gap.state == "gap_skip" and "no-chase" in gap.note
    ok = check_entry(o, tick(ltp=100.5, volume=600_000), at(11))  # 11:00 = 28 % of the session: needs 350 k
    assert ok.state == "triggered" and ok.pace and ok.pace > 1
    short = check_entry(o, tick(ltp=100.5, volume=100_000), at(11))
    assert short.state == "volume_short" and short.pace and short.pace < 1
    assert check_entry(o, tick(ltp=100.5, volume=None), at(11)).state == "volume_short"


def test_position_checks_stop_and_targets() -> None:
    p = position()  # R = 3.4: 1.8R at 106.52, 2.5R at 108.9
    held = check_position(p, tick(ltp=103.0, low=101.0, high=105.0), CFG)
    assert held.stop_hit is False and held.r_now == pytest.approx((103.0 - 100.4) / 3.4)
    assert held.level_1_8r == pytest.approx(106.52) and held.level_2_5r == pytest.approx(108.9)
    assert not held.reached_1_8r and not held.reached_2_5r
    assert check_position(p, tick(ltp=103.0, high=107.0), CFG).reached_1_8r
    assert check_position(p, tick(ltp=103.0, high=109.5), CFG).reached_2_5r
    broke = check_position(p, tick(ltp=101.0, low=100.5, open_=102.0), CFG)  # low through the stop 100.6
    assert broke.stop_hit and broke.stop_exit_price == pytest.approx(100.6)
    gapped = check_position(p, tick(ltp=99.0, low=98.5, open_=99.5), CFG)  # opened below the stop: fills at the open
    assert gapped.stop_hit and gapped.stop_exit_price == pytest.approx(99.5)
    assert check_position(p, None, CFG).stop_hit is False


# ---------------------------------------------------------------- the watcher
MASTER = [
    {"pSymbol": "111", "pTrdSymbol": "ABC-EQ", "pExchSeg": "nse_cm"},
    {"pSymbol": "222", "pTrdSymbol": "XYZ-EQ", "pExchSeg": "nse_cm"},
    {"pSymbol": "333", "pTrdSymbol": "OTHER-EQ", "pExchSeg": "nse_cm"},
]


class Rig:
    def __init__(self, tmp_path: Path, master=MASTER) -> None:
        self.store = PaperStore(tmp_path)
        self.ticks: dict[str, LiveTick] = {}
        self.added: list[list[FeedToken]] = []
        self.now = at(11)
        self.master_calls = 0
        self.master = master

        async def scrip() -> list[dict]:
            self.master_calls += 1
            if isinstance(self.master, Exception):
                raise self.master
            return self.master

        async def add(tokens: list[FeedToken]) -> int:
            self.added.append(list(tokens))
            return len(tokens)

        self.live = SwingLive(self.store, CFG, ticks=lambda: dict(self.ticks), scrip_master=scrip, add_tokens=add,
                              feed_state=lambda: "streaming", clock=lambda: self.now)
        self.live._orders = [order("ABC")]
        self.live._last_scan = "2026-11-03"  # the scan the order came from: the day before the (Wednesday) test clock
        self.live._positions = [position("XYZ")]
        # what load_watch would read from the book, without needing a stored session
        self.live.load_watch = lambda: None  # type: ignore[method-assign]


async def test_refresh_resolves_tokens_once_and_subscribes_only_the_watched_stocks(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    await r.live.refresh()
    assert [t.key for t in r.added[0]] == ["nse_cm|111", "nse_cm|222"]  # OTHER is not watched
    assert [t.key for t in r.live.feed_tokens()] == ["nse_cm|111", "nse_cm|222"]  # also used at every reconnect
    await r.live.refresh()
    assert len(r.added) == 1 and r.master_calls == 1  # nothing new: no second subscribe, no second download
    r.live._orders.append(order("OTHER", id=3, rank=2))
    await r.live.refresh()
    assert [t.key for t in r.added[1]] == ["nse_cm|333"]


async def test_a_failed_instrument_file_degrades_the_view_and_retries_later(tmp_path: Path) -> None:
    r = Rig(tmp_path, master=OSError("down"))
    await r.live.refresh()
    assert r.live.view()["note"].startswith("Kotak instrument file not loaded (OSError)")
    assert r.live.feed_tokens() == [] and not r.added
    r.master = MASTER
    r.now += timedelta(minutes=5)
    await r.live.refresh()
    assert r.master_calls == 1  # not retried before ten minutes
    r.now += timedelta(minutes=6)
    await r.live.refresh()
    assert r.master_calls == 2 and r.live.view()["note"] is None and len(r.live.feed_tokens()) == 2


async def test_poll_records_each_event_once_a_day_and_only_while_the_market_is_open(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    await r.live.refresh()
    r.ticks["nse_cm|111"] = tick("nse_cm|111", ltp=100.5, volume=600_000, received=r.now)
    r.ticks["nse_cm|222"] = tick("nse_cm|222", ltp=101.0, low=100.5, high=107.0, open_=102.0, received=r.now)
    assert r.live.poll() == 3  # trigger for ABC, stop and 1.8R for XYZ
    assert r.live.poll() == 0  # the same facts are not logged again
    kinds = {(e["kind"], e["symbol"]) for e in r.store.live_events("2026-11-04")}
    assert kinds == {("entry_trigger", "ABC"), ("stop_hit", "XYZ"), ("target_1_8r", "XYZ")}
    trig = next(e for e in r.store.live_events("2026-11-04") if e["kind"] == "entry_trigger")
    assert trig["price"] == pytest.approx(100.5) and trig["volume"] == 600_000
    r.now = at(16, 30)  # after the close the feed still holds the last values: nothing is acted on
    r.ticks["nse_cm|111"] = tick("nse_cm|111", ltp=150.0, received=r.now)
    assert r.live.poll() == 0
    r.now = at(11, day=5)  # next day, same facts, new session: logged again
    r.live._last_scan = "2026-11-04"  # (the evening run of the 4th queued the orders for the 5th)
    for t in list(r.ticks):
        r.ticks[t] = r.ticks[t].model_copy(update={"received_at": r.now})
    assert r.live.poll() == 3


async def test_stale_ticks_are_shown_but_never_acted_on(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    await r.live.refresh()
    r.ticks["nse_cm|111"] = tick("nse_cm|111", ltp=100.5, volume=600_000, received=r.now - timedelta(minutes=10))
    assert r.live.poll() == 0
    row = next(x for x in r.live.view()["watching"] if x["symbol"] == "ABC")
    assert row["stale"] is True and row["state"] == "stale" and row["ltp"] == 100.5


async def test_view_describes_every_watched_stock(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    await r.live.refresh()
    r.ticks["nse_cm|111"] = tick("nse_cm|111", ltp=99.0, volume=200_000, received=r.now)
    r.ticks["nse_cm|222"] = tick("nse_cm|222", ltp=103.0, high=105.0, low=101.5, received=r.now)
    v = r.live.view()
    assert v["mode"] == "shadow" and v["market"] == "open" and v["feed_state"] == "streaming"
    o = next(x for x in v["watching"] if x["kind"] == "order")
    assert o["symbol"] == "ABC" and o["state"] == "waiting" and o["trigger"] == 100.3 and o["stop"] == 97.0
    assert o["change_pct"] == pytest.approx((99.0 / 98.0 - 1) * 100) and o["pace"] is not None
    p = next(x for x in v["watching"] if x["kind"] == "position")
    assert p["state"] == "holding" and p["r_now"] == pytest.approx((103.0 - 100.4) / 3.4)
    assert p["unrealized_pnl"] == pytest.approx((103.0 - 100.4) * 100) and p["level_1_8r"] == pytest.approx(106.52)
    no_tick = Rig(tmp_path / "b")
    await no_tick.live.refresh()
    assert next(x for x in no_tick.live.view()["watching"] if x["kind"] == "order")["state"] == "no_data"


def test_live_events_are_append_only_and_deduplicated(tmp_path: Path) -> None:
    import sqlite3

    store = PaperStore(tmp_path)
    assert store.record_live_event("2026-11-04", at(11), "stop_hit", "XYZ", 100.6, 1, {"a": 1}) is True
    assert store.record_live_event("2026-11-04", at(12), "stop_hit", "XYZ", 99.0, 2, {"a": 2}) is False
    assert store.live_events("2026-11-04")[0]["price"] == 100.6  # the first one stands
    with sqlite3.connect(store.path) as c:
        with pytest.raises(sqlite3.DatabaseError, match="append-only"):
            c.execute("UPDATE live_events SET price = 1")
        with pytest.raises(sqlite3.DatabaseError, match="append-only"):
            c.execute("DELETE FROM live_events")


def test_load_watch_reads_the_queued_orders_and_open_positions_from_the_book(tmp_path: Path) -> None:
    store = PaperStore(tmp_path)
    book = Book(cash=900_000.0, equity=1_000_000.0)
    book.positions["XYZ"] = position("XYZ")
    store.commit_session(
        session="2026-11-03", no=1, ran_at=at(18), rule_version="t", universe=["ABC", "XYZ"],
        scan={"universe_size": 2, "fetched_ok": 2, "sectors_defaulted": 0, "sectors": [], "blocked": 0, "capital": 1e6,
              "nifty_close": None, "nifty_ok": None},
        orders=[order("ABC")], decisions=[], trades=[], book=book, invested=1e5, nifty_close=None)
    live = SwingLive(store, CFG, ticks=dict, scrip_master=None, add_tokens=None)
    live.load_watch()
    assert live._symbols() == ["ABC", "XYZ"]
    assert live.view()["note"] == "no broker instrument file available"


async def test_the_poll_loop_survives_a_failing_cycle(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    calls = {"n": 0}
    original = r.live.poll

    def flaky(now: datetime | None = None) -> int:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom")
        return original(now)

    r.live.poll = flaky  # type: ignore[method-assign]
    r.live.poll_s = 0.01
    r.live.start()
    for _ in range(100):
        if calls["n"] >= 3:
            break
        await asyncio.sleep(0.02)
    await r.live.stop()
    assert calls["n"] >= 3  # it kept polling after the first cycle failed


async def test_stream_adds_stocks_on_a_running_feed_and_remembers_them_otherwise() -> None:
    from tests.unit.test_stream import UNIVERSE, FakeFeed, make_manager, until

    f = FakeFeed()
    m, _, _ = make_manager([f])
    await m.start()
    await until(lambda: m.state is StreamState.WAITING_FOR_DATA)
    a, b = FeedToken(exchange_segment="nse_cm", instrument_token="111"), FeedToken(exchange_segment="nse_cm", instrument_token="222")
    assert await m.add_internal_tokens([a, b]) == 2
    assert f.subs[-1] == [a, b] and {a.key, b.key} <= m.book.internal_keys  # off the browser feed
    assert await m.add_internal_tokens([a]) == 0 and len(f.subs) == len(f.subs)  # nothing new, nothing sent
    n = len(f.subs)
    assert await m.add_internal_tokens([a]) == 0 and len(f.subs) == n
    await m.stop()
    # not connected: remembered only, no feed to talk to
    m2, _, _ = make_manager([FakeFeed()])
    assert await m2.add_internal_tokens([a]) == 1 and a.key in m2.book.internal_keys
    assert UNIVERSE.tokens  # (the shared fixture is intact)


async def test_a_failed_subscribe_is_forgotten_so_the_next_call_retries() -> None:
    from tests.unit.test_stream import FakeFeed, make_manager, until

    class Failing(FakeFeed):
        fails = True

        async def subscribe(self, tokens: list[FeedToken]) -> None:
            if self.fails and len(self.subs) >= 2:  # the test and full subscriptions already happened
                raise OSError("refused")
            await super().subscribe(tokens)

    f = Failing()
    m, _, _ = make_manager([f])
    await m.start()
    await until(lambda: m.state is StreamState.WAITING_FOR_DATA and len(f.subs) >= 2)
    tok = FeedToken(exchange_segment="nse_cm", instrument_token="999")
    assert await m.add_internal_tokens([tok]) == 0 and tok.key not in m.book.internal_keys
    f.fails = False
    assert await m.add_internal_tokens([tok]) == 1 and tok.key in m.book.internal_keys
    await m.stop()


async def test_nothing_watched_means_no_broker_call(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    r.live._orders, r.live._positions = [], []
    await r.live.refresh()
    assert r.master_calls == 0 and not r.added  # no instrument file, no sign-in, no subscription


# ---------------------------------------------------------------- stale queue and early volume (5 Nov 2026 audit)
def test_volume_is_not_judged_in_the_opening_rush() -> None:
    o = order("ABC", min_volume=1_000_000.0)
    # 09:16:23: the straight-line pace (floored at 5%) says 2.26x, but the opening rush makes that meaningless
    early = check_entry(o, tick(ltp=100.5, volume=150_000), at(9, 16))
    assert early.state == "volume_early" and "before 09:45" in early.note
    # at 09:45 the same price and a pace of 1.2x is judged
    ok = check_entry(o, tick(ltp=100.5, volume=1_000_000 * 30 / 375 * 1.2, received=at(9, 45)), at(9, 45))
    assert ok.state == "triggered" and ok.pace == pytest.approx(1.2)
    short = check_entry(o, tick(ltp=100.5, volume=1_000_000 * 30 / 375 * 0.5, received=at(9, 45)), at(9, 45))
    assert short.state == "volume_short" and "50% of the pace needed" in short.note and "2 x its 20-day average" in short.note


def test_orders_from_an_old_scan_are_not_checked_against_todays_prices(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    r.live._last_scan = "2026-11-02"  # the book missed the 3 Nov evening: its queue was meant for 3 Nov, not for today
    q = r.live.queue_state(at(11))
    assert q == {"scan_session": "2026-11-02", "expected_scan_session": "2026-11-03", "current": False, "sessions_behind": 1}
    asyncio.run(r.live.refresh())
    r.ticks["nse_cm|111"] = tick("nse_cm|111", ltp=110.0, open_=101.0, volume=5_000_000, received=at(11))
    assert r.live.poll(at(11)) == 0  # through the trigger on plenty of volume, yet nothing is logged
    assert r.store.live_events("2026-11-04") == []
    view = r.live.view()
    row = next(x for x in view["watching"] if x["symbol"] == "ABC")
    assert row["state"] == "stale_queue" and "catching up" in row["note"]
    assert view["queue"]["current"] is False and "1 session(s) behind" in view["note"]
    # earlier entry events from such a queue are not shown as today's decisions
    r.store.record_live_event("2026-11-04", at(10), "entry_trigger", "ABC", 100.5, 1, {})
    r.store.record_live_event("2026-11-04", at(10), "stop_hit", "XYZ", 97.0, 1, {})
    assert [e["kind"] for e in r.live.view()["events"]] == ["stop_hit"]


def test_events_say_which_scan_the_order_came_from(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    asyncio.run(r.live.refresh())
    r.ticks["nse_cm|111"] = tick("nse_cm|111", ltp=101.0, open_=100.0, volume=3_000_000, received=at(11))
    assert r.live.poll(at(11)) == 1
    ev = r.store.live_events("2026-11-04")[0]
    assert ev["kind"] == "entry_trigger" and ev["detail"]["order_session"] == "2026-11-03"
    assert r.live.view()["queue"]["current"] is True


def test_previous_session_skips_the_weekend_and_listed_holidays() -> None:
    from datetime import date

    from app.swing.live import previous_session

    assert previous_session(date(2026, 11, 4)) == date(2026, 11, 3)
    assert previous_session(date(2026, 11, 2)) == date(2026, 10, 30)  # Monday -> Friday


async def test_a_trade_for_trade_stock_gets_a_token_from_its_be_row_and_a_truly_missing_one_says_why(tmp_path: Path) -> None:
    master = [*MASTER, {"pSymbol": "9001", "pTrdSymbol": "SWARAJ-BE", "pExchSeg": "nse_cm"}]
    r = Rig(tmp_path, master=master)
    r.live._orders.append(order("SWARAJ", id=8, rank=8))
    await r.live.refresh()
    assert "nse_cm|9001" in [t.key for t in r.added[0]]  # SWARAJ trades in the BE series: it has no -EQ row
    assert r.live.view()["note"] is None
    r.live._orders.append(order("GONE", id=9, rank=9))
    await r.live.refresh()
    note = r.live.view()["note"]
    assert note.startswith("no Kotak token found for: GONE") and "suspended, delisted or renamed" in note
