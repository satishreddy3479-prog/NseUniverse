"""Historical (realised) volatility of the index from stored daily closes, to set beside the options' implied volatility.

HV(n) = population standard deviation (divide by n) of the last n daily log returns ln(close_t / close_t-1), times sqrt(252), in percent.
RV(n) = root mean square of the same returns (no mean taken out), times sqrt(252): the textbook realised volatility.
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
    var = sum((r - mean) ** 2 for r in returns) / n
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
        "method": "population standard deviation of daily log returns x sqrt(252), percent; final daily closes only",
    }


def rv_annual(returns: list[float]) -> float | None:
    """Realised volatility: sqrt(mean of squared returns x 252), percent. No mean is subtracted (a drift over a month is not volatility)."""
    if not returns:
        return None
    return math.sqrt(sum(r * r for r in returns) / len(returns) * TRADING_DAYS) * 100


def iv_chart(
    nifty: list[Bar], vix: list[Bar], window: int, days: int = 750, provisional: Bar | None = None
) -> dict[str, Any]:
    """Daily series for the IV / HV / IV-percentile chart: NIFTY close, India VIX close (the implied-volatility proxy, the
    market's own 30-day figure) and the rolling ``window``-day historical volatility of NIFTY, on the dates both have a bar.

    The HV at a date uses the ``window`` returns ending that day (computed over the whole history first, so the first plotted
    days are not short of returns). A date without enough returns, or without a VIX bar, is dropped rather than filled.

    ``provisional`` is a not-yet-published latest day (close taken from our own stored index feed): it is appended to the
    NIFTY closes so HV, RV and the price line reach it, and its India VIX is missing (None), never filled."""
    base = len(nifty)
    if provisional is not None and (not nifty or provisional.session > nifty[-1].session):
        nifty = [*nifty, provisional]
    else:
        provisional = None
    rets = log_returns(nifty)
    hv_at: dict[date, float | None] = {}
    rv_at: dict[date, float | None] = {}
    for i, (d, _r, _g) in enumerate(rets):
        win = [r for _, r, _ in rets[i + 1 - window : i + 1]] if i + 1 >= window else []
        hv_at[d] = stdev_annual(win) if win else None
        rv_at[d] = rv_annual(win) if win else None
    vix_at = {b.session: b.close for b in vix}
    dates: list[str] = []
    close: list[float] = []
    iv: list[float | None] = []
    hvs: list[float | None] = []
    rvs: list[float | None] = []
    for b in nifty:
        v = vix_at.get(b.session)
        is_prov = provisional is not None and b.session == provisional.session
        if (v is None and not is_prov) or b.session not in hv_at:
            continue
        dates.append(str(b.session))
        close.append(b.close)
        iv.append(None if v is None else round(v, 2))
        h = hv_at[b.session]
        hvs.append(None if h is None else round(h, 2))
        r = rv_at.get(b.session)
        rvs.append(None if r is None else round(r, 2))
    lo = max(0, len(dates) - days)
    return {
        "window": window, "dates": dates[lo:], "close": close[lo:], "iv": iv[lo:], "hv": hvs[lo:], "rv": rvs[lo:],
        "nifty_bars": base, "vix_bars": len(vix), "days": len(dates[lo:]),
        "provisional": None if provisional is None else {
            "date": str(provisional.session), "close": provisional.close,
            "note": "NIFTY close from our own stored index feed (the daily history is published the next morning); India VIX for this day is not published yet and is left empty",
        },
        "iv_source": "India VIX daily close (NSE's 30-day implied volatility of NIFTY options); not the ATM IV of one expiry",
        "rv_method": "RV = sqrt(mean of squared daily log returns x 252), percent, same window (no mean subtracted)",
        "method": "HV = population stdev of daily log returns x sqrt(252), percent; dates present in both series only",
    }
