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
    bars[12] = bar(12, 25487.0)  # a close is compared with the NEXT minute's future (the end of the minute): 25,413 - 25,487 = -74 against the median +10 (opens): off = -84
    flag_bars(bars, futs)
    assert [i for i, b in enumerate(bars) if "off" in b] == [12]
    assert bars[12]["off"] == -84.0


def test_a_fast_minute_with_a_steady_gap_to_the_future_is_not_flagged_but_a_real_jump_is() -> None:
    # 20 Nov 2026 09:18 IST, real stored values: future 25,422.1 at the start of the minute, 25,460.0 at the start of the next; the index ran 25,445.70 -> 25,486.35 (+40.65) in the minute and
    # continued from the previous close 25,444.65. The opens sit a steady 18 to 24 below the index, so the gap is about -23.6 at the open and -26.4 at the close (25,460.0 - 25,486.35):
    # compared start-of-minute future against the close the gap was -64.2 and the bar was flagged (-41.4) though the index feed was right.
    opens = [25367.9, 25369.15, 25428.45, 25445.7, 25484.4, 25455.6, 25454.9, 25447.65, 25470.35, 25458.05, 25466.1, 25433.15]
    closes = [25370.75, 25437.3, 25444.65, 25486.35, 25457.4, 25451.7, 25447.8, 25473.4, 25454.9, 25465.55, 25433.0, 25435.5]
    fut = [25355.6, 25350.0, 25410.0, 25422.1, 25460.0, 25431.0, 25436.0, 25430.0, 25448.8, 25440.5, 25441.5, 25400.5, 25402.7]
    t0 = datetime(2026, 11, 20, 3, 45, tzinfo=UTC)  # 09:15 IST
    bars = [{"at": (t0 + timedelta(minutes=i)).isoformat(), "o": o, "h": max(o, c) + 3, "l": min(o, c) - 3, "c": c, "n": 60} for i, (o, c) in enumerate(zip(opens, closes, strict=True))]
    futs = {minute_key(t0 + timedelta(minutes=i)): f for i, f in enumerate(fut)}
    flag_bars(bars, futs)
    assert all("off" not in b for b in bars)
    bars[3]["c"] = 25486.35 + 90.0  # a feed that really jumped 90 points at the close is still caught (a hand-picked, real-sized fault)
    flag_bars(bars, futs)
    assert "off" in bars[3]


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
    """18 Nov 2026: from 15:15 the index quote froze (25,220.45), then came back at 15:20 with auction values (a bar from 25,284 to 25,580). The future kept trading; its price less the
    basis it had before 15:15 stands in for the index in the minutes the index bars are missing or silent (15:15-15:19). The 15:20 bar is an indicative closing value of the closing auction
    (D205): it is kept and marked ``ind``, not replaced by a stand-in."""
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
    assert at1520 not in stand_in  # the auction's indicative bar stands as it is...
    bar1520 = next(b for b in bars if b["at"] == at1520)
    assert bar1520["ind"] is True and "off" not in bar1520  # ...marked as an indicative value, not as an error
    at1517 = (open_ + td(minutes=47)).isoformat()
    # the future of minute 47 is 25,230 + 47 % 4 + 8 = 25,241; the basis before 15:15 was +8: the stand-in close is 25,233
    assert stand_in[at1517]["proxy"] is True and stand_in[at1517]["n"] == 0 and stand_in[at1517]["c"] == 25233.0
    assert {(open_ + td(minutes=i)).isoformat() for i in (46, 47, 48, 49)} <= set(stand_in)  # 15:16-15:19: no index reads at all    assert (open_ + td(minutes=45)).isoformat() in stand_in  # the frozen 15:15 bar (one read) is replaced
    assert all(b["at"] >= (open_ + td(minutes=45)).isoformat() for b in stand_in.values())  # nothing is made before 15:15
    # without a basis (no trusted bars in the quarter of an hour before 15:15) nothing is made
    assert proxy_bars([b for b in bars if b["at"] >= (open_ + td(minutes=44)).isoformat()], futs) == []


def test_auction_bars_of_19_nov_are_indicative_values_not_errors() -> None:
    """19 Nov 2026 (real): the index sent no reads 15:16-15:19, then about 100 ticks a minute from 15:20 whose bars closed 25,560.95, 25,573.4 and 25,525.65 while the future traded 25,536.0,
    25,533.0 and 25,533.5 (the future minus the index: -25, -40, +8 against a basis of +17 before 15:15). Before D205 the first three were flagged ``off`` (-79.5, -59.7, -56.8) and replaced."""
    from datetime import timedelta as td

    from app.market.index_check import proxy_bars

    t0 = datetime(2026, 11, 19, 9, 35, tzinfo=UTC)  # 15:05 IST
    bars: list[dict[str, object]] = []
    futs: dict[str, float] = {}
    for i in range(10):  # 15:05-15:14: future 17 points above the index
        at = t0 + td(minutes=i)
        idx = 25500.0 + i
        futs[minute_key(at)] = idx + 17.0
        bars.append({"at": at.isoformat(), "o": idx, "h": idx + 2, "l": idx - 2, "c": idx, "n": 59})
    real = {15: (25591.9, 25596.45, 25560.95, 25560.95, 49, 25536.0), 16: (25561.0, 25589.95, 25538.9, 25573.4, 59, 25533.0), 17: (25569.15, 25571.25, 25524.3, 25525.65, 57, 25533.5)}
    for i, (o, h, low, c, n, fut) in real.items():  # 15:20, 15:21, 15:22
        at = t0 + td(minutes=i)
        futs[minute_key(at)] = fut
        bars.append({"at": at.isoformat(), "o": o, "h": h, "l": low, "c": c, "n": n})
    for i, fut in zip(range(10, 15), (25525.1, 25534.9, 25535.0, 25538.7, 25533.3), strict=True):  # the future kept trading through 15:15-15:19
        futs[minute_key(t0 + td(minutes=i))] = fut
    flag_bars(bars, futs)
    auction = [b for b in bars if b["at"] >= (t0 + td(minutes=15)).isoformat()]
    assert all(b.get("ind") is True and "off" not in b for b in auction)  # kept as exchange output
    stand_in = proxy_bars(bars, futs)
    assert not any(p["at"] in {b["at"] for b in auction} for p in stand_in)  # no stand-in over the minutes the exchange did send
    assert len(stand_in) == 5 and stand_in[0]["at"] == (t0 + td(minutes=10)).isoformat()  # 15:15-15:19 only
    thin = {"at": (t0 + td(minutes=18)).isoformat(), "o": 25540.0, "h": 25540.0, "l": 25540.0, "c": 25540.0, "n": 3}  # 15:23 with three reads
    flag_bars([thin], futs)
    assert "ind" not in thin  # a bar made from a handful of reads is not vouched for
