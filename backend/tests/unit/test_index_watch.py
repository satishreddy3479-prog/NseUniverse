"""The per-minute account of NIFTY index ticks in the closing quarter of an hour."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.stream.index_watch import IndexWatch

T = datetime(2026, 11, 18, 9, 45, 0, tzinfo=UTC)  # 15:15:00 IST


def test_a_minute_is_reported_when_it_rolls_over_with_repeats_counted_and_distinct_values() -> None:
    w = IndexWatch()
    assert w.observe(T, 25220.45) is None
    assert w.observe(T + timedelta(seconds=10), 25220.45) is None  # a repeat still counts as a tick
    assert w.observe(T + timedelta(seconds=30), 25221.0) is None
    done = w.observe(T + timedelta(seconds=61), 25222.0)  # 15:16: the minute 15:15 is finished
    assert done == {"minute": "15:15", "ticks": 3, "distinct": 2, "first": 25220.45, "last": 25221.0}
    assert w.observe(T + timedelta(minutes=2, seconds=5), None) == {"minute": "15:16", "ticks": 1, "distinct": 1, "first": 25222.0, "last": 25222.0}


def test_nothing_is_counted_outside_the_window() -> None:
    w = IndexWatch()
    assert w.observe(T - timedelta(minutes=6), 25200.0) is None  # 15:09
    assert w.observe(T - timedelta(minutes=5), 25200.0) is None  # 15:10 is inside: first tick of its minute
    assert w.observe(T + timedelta(minutes=20), 25200.0) is None  # 15:35 is outside
