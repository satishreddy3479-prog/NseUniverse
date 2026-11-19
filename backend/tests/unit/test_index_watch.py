"""The per-minute account of NIFTY index ticks in the closing quarter of an hour."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.stream.index_watch import IndexWatch

T = datetime(2026, 11, 18, 9, 45, 0, tzinfo=UTC)  # 15:15:00 IST


def test_a_minute_is_reported_when_it_rolls_over_with_repeats_counted_and_distinct_values() -> None:
    w = IndexWatch()
    assert w.observe(T, 25220.45) == []
    assert w.observe(T + timedelta(seconds=10), 25220.45) == []  # a repeat still counts as a tick
    assert w.observe(T + timedelta(seconds=30), 25221.0) == []
    done = w.observe(T + timedelta(seconds=61), 25222.0)  # 15:16: the minute 15:15 is finished
    assert done == [{"minute": "15:15", "ticks": 3, "distinct": 2, "first": 25220.45, "last": 25221.0}]
    assert w.observe(T + timedelta(minutes=2, seconds=5), None) == [{"minute": "15:16", "ticks": 1, "distinct": 1, "first": 25222.0, "last": 25222.0}]


def test_nothing_is_counted_outside_the_window() -> None:
    w = IndexWatch()
    assert w.observe(T - timedelta(minutes=6), 25200.0) == []  # 15:09
    assert w.observe(T - timedelta(minutes=5), 25200.0) == []  # 15:10 is inside: first tick of its minute
    assert w.observe(T + timedelta(minutes=20), 25200.0) == []  # 15:35 is outside the window: nothing is counted and nothing is reported


def test_silent_minutes_are_reported_as_zero_ticks_when_the_ticks_return() -> None:
    """19 Nov 2026: 2 ticks in the 15:15 minute, none in 15:16-15:19, 94 in 15:20 (the closing auction): the old log had no line for the four silent minutes."""
    w = IndexWatch()
    assert w.observe(T, 25503.45) == [] and w.observe(T + timedelta(seconds=40), 25503.7) == []
    out = w.observe(T + timedelta(minutes=5, seconds=2), 25666.75)  # first tick back at 15:20:02
    assert [(a["minute"], a["ticks"]) for a in out] == [("15:15", 2), ("15:16", 0), ("15:17", 0), ("15:18", 0), ("15:19", 0)]
    assert out[0]["distinct"] == 2 and out[1] == {"minute": "15:16", "ticks": 0, "distinct": 0, "first": None, "last": None}
