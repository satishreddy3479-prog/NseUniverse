"""One-minute NIFTY 50 bars from the live index feed (why the Smart OI price candles had no wicks and had gaps).

The levels are a scripted feed (formula checks), not market data. Hand calculations are in each test.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.market.index_bars import IndexBarBuilder
from app.market.service import MarketService
from app.market.store import MarketStore
from app.stream.models import LiveTick

T0 = datetime(2026, 10, 29, 4, 0, tzinfo=UTC)  # 09:30 IST, a Thursday


def test_a_minute_keeps_its_first_highest_lowest_and_last_level() -> None:
    b = IndexBarBuilder()
    for s, price in [(1, 25100.0), (15, 25103.0), (30, 25099.5), (50, 25101.0)]:
        assert b.observe(T0 + timedelta(seconds=s), price, T0 + timedelta(seconds=s)) is None
    done = b.observe(T0 + timedelta(seconds=61), 25102.0, T0 + timedelta(seconds=61))  # the next minute starts: this finishes the first
    assert done is not None
    assert (done.o, done.h, done.l, done.c, done.n) == (25100.0, 25103.0, 25099.5, 25101.0, 4)
    assert done.minute == T0.isoformat()
    # the new minute began at 25,102.0; it is not final yet
    assert b.cur is not None and (b.cur.o, b.cur.c) == (25102.0, 25102.0)


def test_a_minute_with_no_fresh_level_has_no_bar_and_nothing_is_filled() -> None:
    b = IndexBarBuilder()
    b.observe(T0, 100.0, T0)
    assert b.observe(T0 + timedelta(seconds=70), None, None) is not None  # the first minute ends, even with no new level
    assert b.cur is None  # the empty minute has no bar
    assert b.observe(T0 + timedelta(seconds=130), None, None) is None
    assert b.flush() is None


def test_the_same_tick_read_twice_is_counted_once() -> None:
    b = IndexBarBuilder()
    t = T0 + timedelta(seconds=5)
    b.observe(T0 + timedelta(seconds=5), 25100.0, t)
    b.observe(T0 + timedelta(seconds=6), 25100.0, t)  # no new tick arrived between the two reads
    b.observe(T0 + timedelta(seconds=7), 25100.5, T0 + timedelta(seconds=7))
    assert b.cur is not None and b.cur.n == 2


def idx(price: float, at: datetime) -> LiveTick:
    return LiveTick(key="nse_cm|Nifty 50", kind="index", exchange_segment="nse_cm", instrument_token="Nifty 50", ltp=price, received_at=at)


def test_the_service_stores_each_finished_session_minute_once_and_serves_them(tmp_path: Path) -> None:
    svc = MarketService(MarketStore(tmp_path), clock=lambda: T0)
    feed = {"t": idx(25100.0, T0)}
    svc._index_tick = lambda: feed["t"]
    script = [(0, 25100.0), (20, 25101.5), (40, 25099.0), (59, 25100.5), (60, 25100.7), (90, 25102.0), (119, 25101.0), (120, 25101.2)]
    for s, price in script:
        at = T0 + timedelta(seconds=s)
        feed["t"] = idx(price, at)
        svc.observe_index(at)
    bars = svc.index_bars()
    assert bars["day"] == "2026-10-29" and len(bars["bars"]) == 2  # minutes 09:30 and 09:31 are finished; 09:32 is in progress
    first, second = bars["bars"]
    assert (first["o"], first["h"], first["l"], first["c"]) == (25100.0, 25101.5, 25099.0, 25100.5)  # a real wick on both sides of the body
    assert (second["o"], second["h"], second["l"], second["c"]) == (25100.7, 25102.0, 25100.7, 25101.0)
    # reading again does not write a minute twice
    svc.observe_index(T0 + timedelta(seconds=121))
    assert len(svc.index_bars()["bars"]) == 2


def test_nothing_is_recorded_outside_the_session_or_from_a_stale_tick(tmp_path: Path) -> None:
    pre = datetime(2026, 10, 29, 3, 0, tzinfo=UTC)  # 08:30 IST, before the open
    svc = MarketService(MarketStore(tmp_path), clock=lambda: pre)
    svc._index_tick = lambda: idx(100.0, pre)
    svc.observe_index(pre)
    svc.observe_index(pre + timedelta(seconds=61))
    assert svc.index_bars()["bars"] == []
    stale = MarketService(MarketStore(tmp_path / "s"), clock=lambda: T0)
    stale._index_tick = lambda: idx(100.0, T0 - timedelta(seconds=60))  # a minute old at 09:30
    stale.observe_index(T0)
    stale.observe_index(T0 + timedelta(seconds=61))
    assert stale.index_bars()["bars"] == []
    assert "No one-minute index bars" in stale.index_bars()["note"]


@pytest.mark.parametrize("seconds", [0, 30])
def test_a_finished_minute_survives_being_flushed_when_the_session_ends(tmp_path: Path, seconds: int) -> None:
    close = datetime(2026, 10, 29, 10, 10, tzinfo=UTC)  # 15:40 IST, the end of the recorded session
    svc = MarketService(MarketStore(tmp_path), clock=lambda: close)
    svc._index_tick = lambda: idx(100.0, close)
    svc.observe_index(close)  # the last session minute
    after = close + timedelta(minutes=2, seconds=seconds)
    svc._index_tick = lambda: idx(100.0, after)
    svc.observe_index(after)  # past the close: the last minute is written, nothing new starts
    assert len(svc.index_bars()["bars"]) == 1


def test_a_lone_far_read_is_dropped_and_a_confirmed_jump_is_kept() -> None:
    """17 Nov 2026: after a feed stall the first read was 25,284.35 and another read 25,580.2 inside a minute that closed at 25,450.85. A lone read more than 0.15 % from the last accepted
    level waits for the next read: 25,450.85 -> 25,284.35 is 0.65 % away, so it is held, and the next read 25,451.0 does not agree with it, so it is dropped and counted."""
    b = IndexBarBuilder()
    for i, p in enumerate([25450.0, 25450.85, 25284.35, 25451.0, 25580.2, 25452.0]):
        b.observe(T0 + timedelta(seconds=i + 1), p, T0 + timedelta(seconds=i + 1))
    assert b.cur is not None
    assert (b.cur.o, b.cur.h, b.cur.l, b.cur.c, b.cur.x) == (25450.0, 25452.0, 25450.0, 25452.0, 2)  # the wick is the reads that agree; two reads dropped
    done = b.observe(T0 + timedelta(seconds=61), 25452.0, T0 + timedelta(seconds=61))
    assert done is not None and done.payload()["x"] == 2

    # a real move: two reads in a row at the new level are accepted (the first one waited one read)
    c = IndexBarBuilder()
    for i, p in enumerate([25450.0, 25300.0, 25301.0, 25302.0]):
        c.observe(T0 + timedelta(seconds=i + 1), p, T0 + timedelta(seconds=i + 1))
    assert c.cur is not None and (c.cur.l, c.cur.c, c.cur.x) == (25301.0, 25302.0, 0)  # 25,300 was held, 25,301 agreed with it, so the move is real: 25,300 itself is not in the bar (it waited), nothing is counted as dropped


def test_the_first_read_after_minutes_of_silence_starts_a_new_stretch_instead_of_being_held() -> None:
    """19 Nov 2026: reads of 25,504 until 15:14:59, silence to 15:20:02, then 25,666.75, 25,561.0, 25,560.5 (the closing auction's first indicative values). A far read is held back for
    confirmation only while its neighbours are fresh; after 120+ seconds of silence the old level is stale and the first read opens the stretch."""
    from datetime import timedelta

    b = IndexBarBuilder()
    t = datetime(2026, 11, 19, 9, 44, 59, tzinfo=UTC)
    b.observe(t, 25504.3, t)
    t2 = datetime(2026, 11, 19, 9, 50, 2, tzinfo=UTC)  # 15:20:02 IST, 303 s later
    b.observe(t2, 25666.75, t2)
    b.observe(t2 + timedelta(seconds=1), 25561.0, t2 + timedelta(seconds=1))  # 105 points on: held for confirmation
    b.observe(t2 + timedelta(seconds=2), 25560.5, t2 + timedelta(seconds=2))  # confirms it
    done = b.observe(t2 + timedelta(seconds=60), 25560.0, t2 + timedelta(seconds=60))
    assert done is not None and done.o == 25666.75 and done.h == 25666.75 and done.c == 25560.5  # the first auction value is in the bar
    c = IndexBarBuilder()
    t_c = datetime(2026, 11, 19, 9, 44, 20, tzinfo=UTC)
    c.observe(t_c, 25504.3, t_c)
    t3 = t_c + timedelta(seconds=30)  # only 30 s of silence: the neighbour is fresh and a far lone read is a glitch
    c.observe(t3, 25666.75, t3)
    assert c.cur is not None and c.cur.h == 25504.3 and c.cur.x == 1  # held back and counted
