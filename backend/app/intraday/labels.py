"""Barrier ("which threshold is touched first") labels for the intraday prediction research (pure, no I/O).

For a sample at time t with price p0 and horizon h minutes, the targets are
    up barrier   p0 + k x s_h        down barrier   p0 - k x s_h
where s_h is the normal move for h minutes known at t: daily sd x sqrt(h / 375) (daily sd from earlier sessions only),
and k is configurable (default 0.5). The same function defines the barriers in training and live use.
Outcome classes: "up" (up barrier touched first), "down", "none" (neither within the horizon), "ambiguous", "missing".
The path is the stored samples (about one per minute), so a touch is a *sampled* touch:
* ambiguous: the sample that crosses a barrier follows a gap longer than MAX_GAP_MIN, so the unobserved stretch could
  have touched the other barrier first (never resolved in favour of either side).
* missing: the samples do not cover the horizon (last sample earlier than t + h - SLACK_MIN) or none follows t.
Only samples after t are read for the label; features must be built from samples at or before t (see dataset.py).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import timedelta
from typing import Any

from app.intraday.features import SESSION_MINUTES, Point

HORIZONS = (5, 15, 30, 60)
DEFAULT_K = 0.5
MAX_GAP_MIN = 3.0
SLACK_MIN = 3.0


def barrier_pts(spot: float, daily_sd_pct: float, horizon_min: int, k: float = DEFAULT_K) -> float:
    return k * (daily_sd_pct / 100) * math.sqrt(horizon_min / SESSION_MINUTES) * spot


def label_at(points: Sequence[Point], i: int, horizon_min: int, daily_sd_pct: float | None, k: float = DEFAULT_K) -> dict[str, Any]:
    """Outcome of sample ``i`` for one horizon. Reads points[i+1:] only."""
    if daily_sd_pct is None or daily_sd_pct <= 0:
        return {"outcome": "missing", "reason": "no daily volatility scale"}
    t0 = points[i]
    if not t0.spot > 0:
        return {"outcome": "missing", "reason": "no valid price at the sample"}
    width = barrier_pts(t0.spot, daily_sd_pct, horizon_min, k)
    up, dn = t0.spot + width, t0.spot - width
    end = t0.at + timedelta(minutes=horizon_min)
    later = points[i + 1 :]
    if not later or later[-1].at < end - timedelta(minutes=SLACK_MIN):
        return {"outcome": "missing", "reason": "samples do not cover the horizon", "barrier_pts": round(width, 2)}
    prev_at = t0.at
    mfe = mae = 0.0
    last_in = t0.spot
    for p in later:
        if p.at > end:
            break
        gap = (p.at - prev_at).total_seconds() / 60
        mfe, mae = max(mfe, p.spot - t0.spot), min(mae, p.spot - t0.spot)
        hit_up, hit_dn = p.spot >= up, p.spot <= dn
        if hit_up or hit_dn:
            minutes = (p.at - t0.at).total_seconds() / 60
            base = {"barrier_pts": round(width, 2), "minutes_to_touch": round(minutes, 2), "mfe_pts": round(mfe, 2), "mae_pts": round(mae, 2)}
            if gap > MAX_GAP_MIN:
                return {"outcome": "ambiguous", "reason": f"{gap:.1f} minute gap before the touch: the other barrier may have been touched first"} | base
            return {"outcome": "up" if hit_up else "down"} | base
        prev_at = p.at
        last_in = p.spot
    return {"outcome": "none", "barrier_pts": round(width, 2), "mfe_pts": round(mfe, 2), "mae_pts": round(mae, 2), "return_pct": round((last_in / t0.spot - 1) * 100, 4)}


def label_session(points: Sequence[Point], daily_sd_pct: float | None, horizons: Sequence[int] = HORIZONS, k: float = DEFAULT_K) -> dict[str, dict[int, dict[str, Any]]]:
    """sample time (ISO) -> horizon -> label, for every sample of one session."""
    return {p.at.isoformat(): {h: label_at(points, i, h, daily_sd_pct, k) for h in horizons} for i, p in enumerate(points)}
