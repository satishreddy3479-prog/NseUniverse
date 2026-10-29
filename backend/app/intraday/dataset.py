"""Labelled intraday research dataset, built once per finished session (no model is involved).

For every in-session sample t of an expiry (after a 15-sample warm-up) one row holds
  * features computed ONLY from samples at or before t (the path so far, the option chain at t and the
    first chain of the day, the clock, the day's gap), and
  * labels computed ONLY from samples after t: the forward NIFTY return over 5, 15, 30 and 60 minutes
    and to the last sample of the session.
A label is None when no sample exists close enough to the target time (no interpolation, no filling).
Rows are written after the close, when every label is already known, so a row can never be "updated
with what happened"; the table is append-only. ``FEATURE_VERSION`` changes whenever a definition does.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from datetime import date, datetime, timedelta
from typing import Any

from app.domain.session import SESSION_CLOSE
from app.intraday.features import (
    CLOSE,
    IST,
    OPEN,
    SESSION_MINUTES,
    DailyContext,
    Point,
    Quote,
    as_of,
    options_features,
    price_features,
)

FEATURE_VERSION = "if-2"  # if-2 adds implied volatility, futures VWAP/flow, breadth and breakout-state columns (enrich.py)
HORIZONS = (5, 15, 30, 60)  # minutes
WARMUP_SAMPLES = 15
LABEL_SLACK_MIN = 3.0  # a target time needs a sample within 3 minutes at or before it
CLOSE_MIN_AT = (SESSION_CLOSE.hour, SESSION_CLOSE.minute - 5)  # the "to the close" label needs a sample in the last 5 minutes


def _r(v: float | None, n: int = 6) -> float | None:
    return None if v is None or not math.isfinite(v) else round(v, n)


def labels_for(points: Sequence[Point], i: int) -> dict[str, float | None]:
    """Forward returns in percent from sample ``i``. Uses points after i only."""
    t = points[i]
    out: dict[str, float | None] = {}
    for h in HORIZONS:
        target = t.at + timedelta(minutes=h)
        later = points[i + 1 :]
        hit = as_of(later, target, LABEL_SLACK_MIN) if later and later[-1].at >= target - timedelta(minutes=LABEL_SLACK_MIN) else None
        # the sample must also not be later than the target (as_of returns at-or-before)
        out[f"fwd_{h}m"] = None if hit is None else _r((hit.spot / t.spot - 1) * 100)
    last = points[-1]
    ist = last.at.astimezone(IST)
    out["fwd_close"] = _r((last.spot / t.spot - 1) * 100) if (ist.hour, ist.minute) >= CLOSE_MIN_AT and i < len(points) - 1 else None
    return out


def build_rows(
    points: Sequence[Point],
    chain_at: Callable[[int], dict[tuple[float, int], Quote]],
    prev_close: float | None,
    ctx: DailyContext,
    expiry: date,
    day: date,
    extra: Callable[[int], dict[str, float | None]] | None = None,
) -> list[dict[str, Any]]:
    """One row per sample from the warm-up on. ``points`` are the day's in-session samples, oldest first;
    ``chain_at(i)`` returns the option chain of sample i (never called with an index after the row's own)."""
    rows: list[dict[str, Any]] = []
    if len(points) <= WARMUP_SAMPLES:
        return rows
    first_chain = chain_at(0)
    for i in range(WARMUP_SAMPLES, len(points)):
        past = points[: i + 1]  # features see the past and the present only
        t = points[i]
        p = price_features(past, t.at, ctx, prev_close)
        o = options_features(chain_at(i), t.spot, first_chain, points[0].spot)
        ist = t.at.astimezone(IST)
        minutes = (ist.hour * 60 + ist.minute) - (OPEN.hour * 60 + OPEN.minute)
        tot = (o.ce_oi + o.pe_oi) if o.ce_oi is not None and o.pe_oi is not None else None
        feats: dict[str, float | None] = {
            "minutes_since_open": float(minutes),
            "minutes_to_close": float(SESSION_MINUTES - minutes),
            "weekday": float(ist.weekday()),
            "days_to_expiry": float((expiry - day).days),
            "gap_pct": _r(p.gap_pct),
            "from_prev_close_pct": _r(p.change_pct),
            "ret_5m": _r(p.returns_pct.get(5)), "ret_15m": _r(p.returns_pct.get(15)),
            "ret_30m": _r(p.returns_pct.get(30)), "ret_60m": _r(p.returns_pct.get(60)),
            "er_5m": _r(p.er_5m), "er_30": _r(p.er_30),
            "rv_ratio": _r(p.rv_ratio), "range_ratio": _r(p.range_ratio),
            "position_in_range": _r(p.position_in_range),
            "above_or_high": None if p.or_high is None else float(t.spot > p.or_high),
            "below_or_low": None if p.or_low is None else float(t.spot < p.or_low),
            "pcr_oi": _r(o.pcr_oi), "pcr_oi_change": _r(o.pcr_oi_change), "pcr_vol": _r(o.pcr_vol),
            "straddle_pct_of_spot": _r(None if o.straddle is None else o.straddle / t.spot * 100),
            "straddle_change_pct": _r(o.straddle_change_pct),
            "oi_imbalance": _r(None if tot is None or o.ce_oi_chg is None or o.pe_oi_chg is None or tot == 0 else (o.pe_oi_chg - o.ce_oi_chg) / tot),
        }  # fmt: skip
        if extra is not None:
            feats |= extra(i)  # as-of i only (enrich.py)
        rows.append({"sample_utc": t.at.isoformat(), "spot": t.spot, "features": feats, "labels": labels_for(points, i)})
    return rows


def in_session_window(at: datetime) -> bool:
    t = at.astimezone(IST).time()
    return OPEN <= t <= CLOSE
