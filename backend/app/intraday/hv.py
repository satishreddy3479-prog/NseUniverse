"""Historical (realised) volatility of the index from stored daily closes, to set beside the options' implied volatility.

HV(n) = sample standard deviation (n - 1) of the last n daily log returns ln(close_t / close_t-1), times sqrt(252), in percent.
252 trading days a year is the usual convention for daily closes; implied volatility from the option model is annualised on
calendar time to expiry, so the two are comparable but not identical in basis. Only final daily bars are used (the history
store holds nothing partial); a return that spans more than MAX_GAP_DAYS calendar days (a missing stretch) is counted and
reported, never hidden.
"""

from __future__ import annotations

import math
from datetime import date
from typing import Any

from app.prediction.targets import Bar

TRADING_DAYS = 252
WINDOWS = (10, 20, 30, 60)
MAX_GAP_DAYS = 5  # a normal weekend plus one holiday is 4 days; longer means days are missing


def log_returns(bars: list[Bar]) -> list[tuple[date, float, int]]:
    """(date of the later close, ln return, calendar days spanned) for consecutive bars with positive closes."""
    out: list[tuple[date, float, int]] = []
    for a, b in zip(bars, bars[1:], strict=False):
        if a.close > 0 and b.close > 0:
            out.append((b.session, math.log(b.close / a.close), (b.session - a.session).days))
    return out


def stdev_annual(returns: list[float]) -> float | None:
    n = len(returns)
    if n < 2:
        return None
    mean = sum(returns) / n
    var = sum((r - mean) ** 2 for r in returns) / (n - 1)
    return math.sqrt(var * TRADING_DAYS) * 100


def hv(rets: list[tuple[date, float, int]], window: int) -> float | None:
    if len(rets) < window:
        return None
    return stdev_annual([r for _, r, _ in rets[-window:]])


def hv_report(bars: list[Bar], today: date, series_len: int = 120) -> dict[str, Any]:
    rets = log_returns(bars)
    windows: dict[str, Any] = {}
    for w in WINDOWS:
        tail = rets[-w:] if len(rets) >= w else []
        windows[str(w)] = {
            "hv": None if hv(rets, w) is None else round(hv(rets, w) or 0.0, 2),
            "returns": len(tail),
            "gap_returns": sum(1 for _, _, d in tail if d > MAX_GAP_DAYS),
        }
    dates: list[str] = []
    values: list[float | None] = []
    for i in range(max(0, len(rets) - series_len), len(rets)):
        part = rets[: i + 1]
        v = hv(part, 20)
        dates.append(str(rets[i][0]))
        values.append(None if v is None else round(v, 2))
    last = bars[-1].session if bars else None
    return {
        "as_of": None if last is None else str(last),
        "days_behind": None if last is None else (today - last).days,
        "bars": len(bars),
        "windows": windows,
        "series": {"window": 20, "dates": dates, "hv": values},
        "method": "sample standard deviation of daily log returns x sqrt(252), percent; final daily closes only",
    }
