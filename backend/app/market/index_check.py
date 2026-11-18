"""Cross-check of the one-minute index bars against the NIFTY future, an independent feed.

The index quote can freeze and then print reads that no other market agrees with (17 Nov 2026, 15:15 to 15:27: frozen at 25,413, then bars closing 25,498 and 25,325 while the future
traded about 25,430 and the options implied about 25,445). The future minus the index (the basis) moves slowly, so a bar whose basis is far from the basis of the minutes around it is
suspect. The reference is the median basis of the neighbouring minutes (a robust middle, so a few bad minutes do not drag it); nothing is repaired or filled in: a suspect bar is only
flagged, and the pages leave it out of the price candles.
"""

from __future__ import annotations

import statistics
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

TOLERANCE = 40.0  # points: the basis of a bar's close may differ this much from its neighbours' median before it is flagged
EXTREME_TOLERANCE = 80.0  # the same for a bar's high or low (a minute can range widely, so the allowance is wider)
CLOSING_TOLERANCE, CLOSING_EXTREME_TOLERANCE = 25.0, 40.0  # points, inside the closing session (15:15-15:30)
FIRST_MINUTE = (9, 17)  # IST: the opening minutes are left out, the future and the index open apart
NEIGHBOURS = 15  # minutes on each side
MIN_NEIGHBOURS = 5
IST = ZoneInfo("Asia/Kolkata")
THIN_READS = 10  # bars made from fewer reads were made while the feed was silent: they are not used as a reference


def minute_key(at: datetime) -> str:
    return at.replace(second=0, microsecond=0).isoformat()


def bar_offsets(bars: Sequence[Mapping[str, object]], futures: Mapping[str, float], field: str = "c") -> list[float | None]:
    """For each bar (``at`` ISO minute start, ``c`` close, ``n`` reads) the basis of ``field`` (c, h or l) minus the median basis of the bars within ``NEIGHBOURS`` minutes (itself excluded), in points.
    ``futures`` maps a minute key to the future's last price in that minute. None where the bar or its neighbours have no future price."""
    keys = [minute_key(datetime.fromisoformat(str(b["at"]))) for b in bars]
    basis: list[float | None] = []
    for b, k in zip(bars, keys, strict=True):
        f, c = futures.get(k), b.get("c")  # the neighbours' reference is always built from closes
        thin = isinstance(b.get("n"), int) and int(b["n"]) < THIN_READS  # type: ignore[call-overload]
        basis.append(None if f is None or not isinstance(c, (int, float)) or thin else float(f) - float(c))
    out: list[float | None] = []
    stamps = [datetime.fromisoformat(str(b["at"])).timestamp() for b in bars]
    for i, b in enumerate(bars):
        c, f, x = b.get("c"), futures.get(keys[i]), b.get(field)
        if f is None or not isinstance(c, (int, float)) or not isinstance(x, (int, float)):
            out.append(None)
            continue
        near = [
            b
            for j, b in enumerate(basis)
            if j != i and b is not None and abs(stamps[j] - stamps[i]) <= NEIGHBOURS * 60
        ]
        if len(near) < MIN_NEIGHBOURS:
            out.append(None)
            continue
        out.append(float(f) - float(x) - statistics.median(near))
    return out


def flag_bars(bars: list[dict[str, object]], futures: Mapping[str, float]) -> None:
    """Set ``off`` (points, signed) on each bar whose close, high or low is further from the future-implied level than the tolerances allow. Bars are not changed otherwise."""
    close, high, low = bar_offsets(bars, futures, "c"), bar_offsets(bars, futures, "h"), bar_offsets(bars, futures, "l")
    for b, oc, oh, ol in zip(bars, close, high, low, strict=True):
        at = datetime.fromisoformat(str(b["at"])).astimezone(IST)
        if (at.hour, at.minute) < FIRST_MINUTE:
            continue
        tight = CLOSING_START <= (at.hour, at.minute) < CLOSING_END  # in the closing session the index quote is not to be trusted: a narrower allowance
        tol_c, tol_x = (CLOSING_TOLERANCE, CLOSING_EXTREME_TOLERANCE) if tight else (TOLERANCE, EXTREME_TOLERANCE)
        worst = max(((abs(v) / tol, v) for v, tol in ((oc, tol_c), (oh, tol_x), (ol, tol_x)) if v is not None), default=None)
        if worst is not None and worst[0] > 1:
            b["off"] = round(worst[1], 1)


CLOSING_START = (15, 15)  # IST: from here to the close the exchange's cash market is in its closing session and the index quote stops moving, every day (seen 11, 17 and 18 Nov 2026)
CLOSING_END = (15, 30)
BASIS_MINUTES = 15  # the basis (future minus index) is taken from the trusted bars of this many minutes before the closing session starts


def proxy_bars(bars: Sequence[Mapping[str, object]], futures: Mapping[str, float]) -> list[dict[str, object]]:
    """Stand-in bars for the minutes of the closing session (15:15 to 15:30 IST) in which the index quote is missing, silent or contradicted by the future.

    The future keeps trading, so its price less the basis it had in the quarter of an hour before 15:15 (the median of future minus index over the trusted bars of that stretch) is a
    stand-in for the index. A proxy bar runs from the previous minute's stand-in to this minute's, ``proxy`` is True and ``n`` is 0; nothing is made for a minute without a future
    price or when there is no basis to take. Bars the index feed delivered and the future confirms are left alone: callers keep those and add only the proxies for the other minutes."""
    day_first = next((datetime.fromisoformat(str(b["at"])).astimezone(IST) for b in bars), None)
    if day_first is None:
        return []
    start = day_first.replace(hour=CLOSING_START[0], minute=CLOSING_START[1], second=0, microsecond=0)
    end = day_first.replace(hour=CLOSING_END[0], minute=CLOSING_END[1], second=0, microsecond=0)
    def trusted(b: Mapping[str, object]) -> bool:
        n = b.get("n")
        return "off" not in b and not (isinstance(n, int) and n < THIN_READS)
    stamp = {id(b): datetime.fromisoformat(str(b["at"])).astimezone(IST) for b in bars}
    before = [
        float(futures[minute_key(stamp[id(b)].astimezone(UTC))]) - float(b["c"])  # type: ignore[arg-type]
        for b in bars
        if start - timedelta(minutes=BASIS_MINUTES) <= stamp[id(b)] < start and trusted(b) and minute_key(stamp[id(b)].astimezone(UTC)) in futures
    ]
    if len(before) < MIN_NEIGHBOURS:
        return []
    basis = statistics.median(before)
    have = {minute_key(stamp[id(b)].astimezone(UTC)): b for b in bars if start <= stamp[id(b)] < end and trusted(b)}
    out: list[dict[str, object]] = []
    prev: float | None = None
    t = start
    while t < end:
        key = minute_key(t.astimezone(UTC))
        f = futures.get(key)
        level = None if f is None else float(f) - basis
        if key not in have and level is not None:
            o = prev if prev is not None else level
            out.append({"at": key, "o": round(o, 2), "h": round(max(o, level), 2), "l": round(min(o, level), 2), "c": round(level, 2), "n": 0, "proxy": True})
        prev = level if level is not None else prev
        t += timedelta(minutes=1)
    return out
