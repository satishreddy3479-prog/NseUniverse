"""Range-expansion signals: how far has NIFTY already moved today, and is the move speeding up? (pure functions, point in time)

A short straddle makes money when NIFTY moves less than the premium and loses when it trends (the Entry Lab study: P&L correlates -0.90 with the realised range). These signals read only what was
known at one minute (``i0``): nothing after it. They do not forecast; the Entry Lab judges whether any of them separates good entry days from bad ones, and says how many days stand behind the answer.

  gap_pts, gap_pct   the opening level against the previous close (signed points, signed percent of the previous close); gap_ratio = |gap| / the straddle premium;
  range_so_far       high - low of the index from the first stored minute to ``i0``; range_ratio = range_so_far / premium;
  or_break           'up' or 'down' when, after the first 30 minutes, the index is outside the opening 30-minute range by more than BREAK_MARGIN points, else None;
  eff30              path efficiency over the last 30 minutes (by clock time, so a few missing stored minutes do not shift the window): |net move| / total path
                     (1.0 = a straight line, near 0 = going nowhere);
  acc                realised range of the last 15 minutes divided by that of the 15 before (above 1: speeding up);
  premium_pct        the straddle premium as a percent of the index.
A value that cannot be formed from the minutes available is None, never zero.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
BREAK_MARGIN = 10.0  # points beyond the opening range
OPENING_RANGE_MIN = 30
EFF_WINDOW = 30  # minutes
ACC_WINDOW = 15  # minutes
MIN_EFF_SAMPLES = 10
MIN_ACC_SAMPLES = 5
SLACK_MIN = 2.0  # the window may start this many minutes late (a missing stored minute) before the signal is called unavailable


def _rng(vals: Sequence[float]) -> float:
    return max(vals) - min(vals)


def compute(times: Sequence[datetime], spots: Sequence[float], i0: int, premium: float | None, prev_close: float | None) -> dict[str, Any]:
    """The signals at sample ``i0`` of one session (``times`` and ``spots`` run from the first stored minute). Only samples up to ``i0`` are read."""
    out: dict[str, Any] = {"minutes": None, "gap_pts": None, "gap_pct": None, "gap_ratio": None, "range_so_far": None, "range_ratio": None, "or_break": None,
                           "eff30": None, "acc": None, "premium_pct": None}  # fmt: skip
    if not spots or i0 < 0 or i0 >= len(spots):
        return out
    spot = spots[i0]
    out["minutes"] = round((times[i0] - times[0]).total_seconds() / 60)
    if prev_close and prev_close > 0:
        gap = spots[0] - prev_close
        out["gap_pts"], out["gap_pct"] = round(gap, 2), round(gap / prev_close * 100, 3)
        if premium and premium > 0:
            out["gap_ratio"] = round(abs(gap) / premium, 3)
    so_far = _rng(spots[: i0 + 1])
    out["range_so_far"] = round(so_far, 2)
    if premium and premium > 0:
        out["range_ratio"] = round(so_far / premium, 3)
        out["premium_pct"] = round(premium / spot * 100, 3) if spot > 0 else None
    if out["minutes"] >= OPENING_RANGE_MIN:
        cut = next((i for i, t in enumerate(times) if (t - times[0]).total_seconds() / 60 >= OPENING_RANGE_MIN), None)
        if cut is not None and cut <= i0:
            hi, lo = max(spots[: cut + 1]), min(spots[: cut + 1])
            out["or_break"] = "up" if spot > hi + BREAK_MARGIN else "down" if spot < lo - BREAK_MARGIN else None
    window = _window(times, i0, EFF_WINDOW)
    if window is not None:
        w = spots[window[0] : i0 + 1]
        path = sum(abs(b - a) for a, b in zip(w, w[1:], strict=False))
        if len(w) >= MIN_EFF_SAMPLES and path > 0:
            out["eff30"] = round(abs(w[-1] - w[0]) / path, 3)
    recent, earlier = _window(times, i0, ACC_WINDOW), _window(times, i0, 2 * ACC_WINDOW)
    if recent is not None and earlier is not None:
        last = spots[recent[0] : i0 + 1]
        before = spots[earlier[0] : recent[0] + 1]
        if len(last) >= MIN_ACC_SAMPLES and len(before) >= MIN_ACC_SAMPLES and _rng(before) > 0:
            out["acc"] = round(_rng(last) / _rng(before), 3)
    return out


def from_analysis(a: Mapping[str, Any], prev_close: float | None) -> dict[str, Any]:
    """The signals NOW for the session of a straddle analysis (``StraddleDecay.summary``): its minute-by-minute index level and the premium of the at-the-money straddle.

    Read-only description of the day so far: it does not say what the day will do. ``available`` is False with a reason when the analysis has nothing to read."""
    if a.get("status") != "ok":
        return {"available": False, "reason": a.get("message") or "no stored session to read"}
    pairs = [(datetime.fromisoformat(t), float(x)) for t, x in zip(a.get("times") or [], a.get("spot") or [], strict=False) if x is not None]
    prem = next((float(x) for x in reversed((a.get("series") or {}).get("rolling", {}).get("straddle") or []) if x is not None), None)
    if len(pairs) < 2 or prem is None:
        return {"available": False, "reason": "fewer than two stored minutes or no straddle price yet"}
    q = a.get("quality") or {}
    times, spots = [p[0] for p in pairs], [p[1] for p in pairs]
    return {"available": True, "session": a.get("session"), "as_of": times[-1].isoformat(), "live": bool(q.get("live")), "stale": bool(q.get("stale")), "spot": round(spots[-1], 2), "premium": round(prem, 2),
            "prev_close": prev_close, **compute(times, spots, len(spots) - 1, prem, prev_close),
            "note": "What the day has done so far, from the stored minutes. It describes; it does not forecast. The Entry Lab tests whether these numbers have mattered on past days."}  # fmt: skip


def _window(times: Sequence[datetime], i0: int, minutes: float) -> tuple[int, float] | None:
    """The first sample at or after ``minutes`` before sample ``i0``, if the stored minutes reach back that far (within ``SLACK_MIN``): (index, the minutes it actually spans)."""
    target = (times[i0] - times[0]).total_seconds() / 60 - minutes
    if target < -SLACK_MIN:
        return None
    for j in range(i0):
        if (times[j] - times[0]).total_seconds() / 60 >= target - 1e-9:
            return j, (times[i0] - times[j]).total_seconds() / 60
    return None
