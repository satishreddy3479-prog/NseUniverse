"""The cross-check of one-minute index bars against the future (17 Nov 2026: the index froze, then printed 25,498 and 25,325 while the future traded about 25,430)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.market.index_check import flag_bars, minute_key

T0 = datetime(2026, 11, 17, 9, 30, tzinfo=UTC)  # 15:00 IST


def bar(i: int, c: float, h: float | None = None, low: float | None = None, n: int = 60) -> dict[str, object]:
    return {"at": (T0 + timedelta(minutes=i)).isoformat(), "o": c, "h": h if h is not None else c + 3, "l": low if low is not None else c - 3, "c": c, "n": n}


def test_a_bar_far_from_the_future_is_flagged_and_the_rest_are_not() -> None:
    # 30 minutes with the future 10 points above the index (basis +10); minute 12 closes 75 points above where the future says the index is
    bars = [bar(i, 25400.0 + (i % 5)) for i in range(30)]
    futs = {minute_key(T0 + timedelta(minutes=i)): 25410.0 + (i % 5) for i in range(30)}
    bars[12] = bar(12, 25487.0)  # the future of minute 12 is 25,412, so this bar's basis is 25,412 - 25,487 = -75 against the median +10: off = -85
    flag_bars(bars, futs)
    assert [i for i, b in enumerate(bars) if "off" in b] == [12]
    assert bars[12]["off"] == -85.0


def test_a_wild_high_or_low_inside_a_good_close_is_flagged_with_the_wider_allowance() -> None:
    bars = [bar(i, 25400.0) for i in range(30)]
    futs = {minute_key(T0 + timedelta(minutes=i)): 25410.0 for i in range(30)}
    bars[10] = bar(10, 25400.0, h=25580.0)  # the 25,580 read of 17 Nov: 170 above the future-implied level
    bars[11] = bar(11, 25400.0, h=25440.0, low=25370.0)  # a 40-point range either way is normal and stays
    flag_bars(bars, futs)
    assert "off" in bars[10] and "off" not in bars[11]


def test_the_opening_minutes_a_thin_bar_and_a_missing_future_are_not_judged() -> None:
    opening = datetime(2026, 11, 17, 3, 45, tzinfo=UTC)  # 09:15 IST
    bars = [{"at": (opening + timedelta(minutes=i)).isoformat(), "o": 25300.0, "h": 25310.0, "l": 25290.0, "c": 25300.0 if i != 0 else 25200.0, "n": 60} for i in range(30)]
    futs = {minute_key(opening + timedelta(minutes=i)): 25310.0 for i in range(30)}
    flag_bars(bars, futs)
    assert "off" not in bars[0]  # 09:15: futures and index open apart; left out of the check
    few = [bar(i, 25400.0) for i in range(3)]
    flag_bars(few, {minute_key(T0): 25410.0})  # no future price for most minutes and too few neighbours: nothing to judge against
    assert all("off" not in b for b in few)
