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


def test_the_closing_session_gets_stand_in_bars_from_the_future_minus_its_basis() -> None:
    """18 Nov 2026: from 15:15 the index quote froze (25,220.45), then jumped (a 15:20 bar from 25,284 to 25,580). The future kept trading; its price less the basis it had before 15:15
    stands in for the index in the minutes the index bars are missing, silent or contradicted."""
    from datetime import timedelta as td

    from app.market.index_check import proxy_bars

    open_ = datetime(2026, 11, 18, 9, 0, tzinfo=UTC)  # 14:30 IST
    bars: list[dict[str, object]] = []
    futs: dict[str, float] = {}
    for i in range(0, 60):  # 14:30 to 15:29 IST: the index follows the future 8 points below it, until 15:15
        at = open_ + td(minutes=i)
        idx = 25230.0 + (i % 4)
        futs[minute_key(at)] = idx + 8.0
        if i < 45:
            bars.append({"at": at.isoformat(), "o": idx, "h": idx + 2, "l": idx - 2, "c": idx, "n": 60})
        elif i == 50:
            bars.append({"at": at.isoformat(), "o": 25284.0, "h": 25580.0, "l": 25284.0, "c": 25450.0, "n": 55})  # 15:20: the glitch bar
        elif i == 45:
            bars.append({"at": at.isoformat(), "o": 25220.45, "h": 25220.45, "l": 25220.45, "c": 25220.45, "n": 1})  # 15:15: frozen, one read
    flag_bars(bars, futs)
    stand_in = {b["at"]: b for b in proxy_bars(bars, futs)}
    at1520 = (open_ + td(minutes=50)).isoformat()
    assert at1520 in stand_in and stand_in[at1520]["proxy"] is True and stand_in[at1520]["n"] == 0
    # the future of minute 50 is 25,230 + 50 % 4 + 8 = 25,240; the basis before 15:15 was +8: the stand-in close is 25,232
    assert stand_in[at1520]["c"] == 25232.0
    assert (open_ + td(minutes=45)).isoformat() in stand_in  # the frozen 15:15 bar (one read) is replaced
    assert all(b["at"] >= (open_ + td(minutes=45)).isoformat() for b in stand_in.values())  # nothing is made before 15:15
    # without a basis (no trusted bars in the quarter of an hour before 15:15) nothing is made
    assert proxy_bars([b for b in bars if b["at"] >= (open_ + td(minutes=44)).isoformat()], futs) == []
