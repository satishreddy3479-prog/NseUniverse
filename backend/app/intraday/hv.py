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


def parkinson_at(bars: list[Bar], window: int) -> dict[date, float | None]:
    """Range-based realised volatility (Parkinson), percent annualised, by date: sqrt(mean(ln(H/L)^2) / (4 ln 2) x 252) over
    the last ``window`` daily bars. It uses each day's high and low, so it reacts to intraday range that close-to-close HV misses.
    A date with fewer than ``window`` valid bars (high >= low > 0) is None."""
    sq = [(b.session, math.log(b.high / b.low) ** 2 if b.low > 0 and b.high >= b.low else None) for b in bars]
    out: dict[date, float | None] = {}
    for i, (d, _v) in enumerate(sq):
        win = [v for _, v in sq[max(0, i + 1 - window) : i + 1]]
        ok = i + 1 >= window and all(v is not None for v in win)
        out[d] = math.sqrt(sum(v for v in win if v is not None) / window / (4 * math.log(2)) * TRADING_DAYS) * 100 if ok else None
    return out


def iv_chart(nifty: list[Bar], vix: list[Bar], window: int, days: int = 750) -> dict[str, Any]:
    """Daily series for the IV / HV / IV-percentile chart: NIFTY close, India VIX close (the implied-volatility proxy, the
    market's own 30-day figure) and the rolling ``window``-day historical volatility of NIFTY, on the dates both have a bar.

    The HV at a date uses the ``window`` returns ending that day (computed over the whole history first, so the first plotted
    days are not short of returns). A date without enough returns, or without a VIX bar, is dropped rather than filled."""
    rets = log_returns(nifty)
    hv_at: dict[date, float | None] = {}
    for i, (d, _r, _g) in enumerate(rets):
        hv_at[d] = stdev_annual([r for _, r, _ in rets[i + 1 - window : i + 1]]) if i + 1 >= window else None
    rv_at = parkinson_at(nifty, window)
    vix_at = {b.session: b.close for b in vix}
    dates: list[str] = []
    close: list[float] = []
    iv: list[float] = []
    hvs: list[float | None] = []
    rvs: list[float | None] = []
    for b in nifty:
        v = vix_at.get(b.session)
        if v is None or b.session not in hv_at:
            continue
        dates.append(str(b.session))
        close.append(b.close)
        iv.append(round(v, 2))
        h = hv_at[b.session]
        hvs.append(None if h is None else round(h, 2))
        r = rv_at.get(b.session)
        rvs.append(None if r is None else round(r, 2))
    lo = max(0, len(dates) - days)
    return {
        "window": window, "dates": dates[lo:], "close": close[lo:], "iv": iv[lo:], "hv": hvs[lo:], "rv": rvs[lo:],
        "nifty_bars": len(nifty), "vix_bars": len(vix), "days": len(dates[lo:]),
        "iv_source": "India VIX daily close (NSE's 30-day implied volatility of NIFTY options); not the ATM IV of one expiry",
        "rv_method": "RV = Parkinson range-based volatility from each day's high and low, same window, x sqrt(252), percent",
        "method": "HV = sample stdev of daily log returns x sqrt(252), percent; dates present in both series only",
    }
