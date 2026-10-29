"""Day VWAP descriptors for the NIFTY current-month future (pure).

NIFTY 50 is an index and has no traded volume, so its own VWAP cannot be computed. The future trades the
same underlying and the exchange feed carries the contract's average traded price (ATP), which is the
contract's volume-weighted day price. All figures below are for the future, not the index, and the future
trades at a basis to spot, so only the future's own distance to its own VWAP is used.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

HOLD = 3  # samples a side change must hold to count as a reclaim / rejection
SLOPE_MIN = 15


def describe(
    series: Sequence[tuple[int, float, float]], atr_pts: float | None = None
) -> dict[str, Any] | None:
    """series = [(minute since 09:15, future price, ATP)] in time order. None without data."""
    s = [(m, p, a) for m, p, a in series if a and a > 0 and p and p > 0]
    if not s:
        return None
    m, p, a = s[-1]
    dist = p - a
    sides = [1 if x[1] > x[2] else -1 if x[1] < x[2] else 0 for x in s]
    nz = [x for x in sides if x != 0]
    crosses = sum(1 for x, y in zip(nz, nz[1:], strict=False) if x != y)
    events: list[dict[str, Any]] = []
    run_side, run_len, run_start = 0, 0, 0
    prev_stable = 0
    for i, sd in enumerate(sides):
        if sd != 0 and sd == run_side:
            run_len += 1
        elif sd != 0:
            run_side, run_len, run_start = sd, 1, i
        if run_len == HOLD and run_side != prev_stable:
            if prev_stable != 0:
                events.append(
                    {
                        "event": "vwap_reclaim" if run_side > 0 else "vwap_rejection",
                        "minute": s[run_start][0],
                    }
                )
            prev_stable = run_side
    ref = next((x for x in reversed(s) if x[0] <= m - SLOPE_MIN), None)
    return {
        "price": p, "vwap": round(a, 2), "distance_pts": round(dist, 2), "distance_pct": round(dist / a * 100, 3),
        "distance_atr": None if not atr_pts else round(dist / atr_pts, 2),
        "side": "above" if dist > 0 else "below" if dist < 0 else "at",
        "slope_pts_per_15m": None if ref is None else round(a - ref[2], 2),
        "crosses": crosses, "minutes_above": sum(1 for x in sides if x > 0), "minutes_below": sum(1 for x in sides if x < 0),
        "events": events[-4:], "samples": len(s),
        "note": "VWAP of the NIFTY current-month future (exchange average traded price), not of the index. A side is a description, not a signal.",
    }  # fmt: skip
