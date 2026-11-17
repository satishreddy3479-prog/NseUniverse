"""Cross-check of the one-minute index bars against the NIFTY future, an independent feed.

The index quote can freeze and then print reads that no other market agrees with (17 Nov 2026, 15:15 to 15:27: frozen at 25,413, then bars closing 25,498 and 25,325 while the future
traded about 25,430 and the options implied about 25,445). The future minus the index (the basis) moves slowly, so a bar whose basis is far from the basis of the minutes around it is
suspect. The reference is the median basis of the neighbouring minutes (a robust middle, so a few bad minutes do not drag it); nothing is repaired or filled in: a suspect bar is only
flagged, and the pages leave it out of the price candles.
"""

from __future__ import annotations

import statistics
from collections.abc import Mapping, Sequence
from datetime import datetime
from zoneinfo import ZoneInfo

TOLERANCE = 40.0  # points: the basis of a bar's close may differ this much from its neighbours' median before it is flagged
EXTREME_TOLERANCE = 80.0  # the same for a bar's high or low (a minute can range widely, so the allowance is wider)
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
        near = [basis[j] for j in range(len(bars)) if j != i and basis[j] is not None and abs(stamps[j] - stamps[i]) <= NEIGHBOURS * 60]
        if len(near) < MIN_NEIGHBOURS:
            out.append(None)
            continue
        out.append(float(f) - float(x) - statistics.median(near))  # type: ignore[type-var]
    return out


def flag_bars(bars: list[dict[str, object]], futures: Mapping[str, float]) -> None:
    """Set ``off`` (points, signed) on each bar whose close, high or low is further from the future-implied level than the tolerances allow. Bars are not changed otherwise."""
    close, high, low = bar_offsets(bars, futures, "c"), bar_offsets(bars, futures, "h"), bar_offsets(bars, futures, "l")
    for b, oc, oh, ol in zip(bars, close, high, low, strict=True):
        at = datetime.fromisoformat(str(b["at"])).astimezone(IST)
        if (at.hour, at.minute) < FIRST_MINUTE:
            continue
        worst = max(((abs(v) / tol, v) for v, tol in ((oc, TOLERANCE), (oh, EXTREME_TOLERANCE), (ol, EXTREME_TOLERANCE)) if v is not None), default=None)
        if worst is not None and worst[0] > 1:
            b["off"] = round(worst[1], 1)
