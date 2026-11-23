"""Historical (realised) volatility of the index from stored daily closes, to set beside the options' implied volatility.

HV(n) = sample standard deviation (divide by n - 1, the unbiased estimator of the variance) of the last n daily log returns ln(close_t / close_t-1), times sqrt(252), in percent.
RV(n) = root mean square of the same returns (no mean taken out, divide by n), times sqrt(252): realised volatility in the sense of a sum of squared returns.
Statistics use only the regular sessions' final closes: Muhurat (Diwali evening) sessions are one hour long and are left out, so the return across them is the
full overnight return between two regular closes; a provisional (not yet published) close is never part of a statistic. 252 trading days a year is the usual convention
for daily closes; India VIX (and the option model's implied volatility) is annualised on calendar time. For a window of n trading days spanning D calendar days the two
bases differ by the factor sqrt(365 n / (252 D)) in volatility, about +0.7 % for 21 days over 30 (``basis_ratio``): comparable, and the difference is stated, not hidden.
A return that spans more than MAX_GAP_DAYS calendar days (a missing stretch) is counted and reported, never hidden.
"""

from __future__ import annotations

import math
from datetime import date
from typing import Any

from app.prediction.targets import Bar

TRADING_DAYS = 252
WINDOWS = (10, 20, 30, 60)
MAX_GAP_DAYS = 5  # a normal weekend plus one holiday is 4 days; longer means days are missing
#: Muhurat (Diwali Laxmi Pujan) trading: a one-hour session on a day that is otherwise a holiday (or a weekend). Its bar is not a daily close. The dates from the NSE circulars; later years
#: come from the trading calendar's special sessions (Settings) named "Muhurat". A full special session such as the Saturday budget day (1 Feb 2025) is a regular day and is kept.
SHORT_SESSIONS: frozenset[date] = frozenset(
    date.fromisoformat(d) for d in ("2020-11-14", "2021-11-04", "2022-10-24", "2023-11-12", "2024-11-01", "2025-10-21", "2026-11-08")
)


def regular_bars(bars: list[Bar], exclude: frozenset[date] | set[date] = frozenset()) -> list[Bar]:
    """The bars of regular full sessions: the short (Muhurat) sessions are dropped, so a return runs between two regular closes."""
    skip = SHORT_SESSIONS | frozenset(exclude)
    return [b for b in bars if b.session not in skip]


def basis_ratio(trading_days: int, calendar_days: int) -> float:
    """Volatility on the calendar-time basis divided by the same volatility on the trading-time basis for a window of ``trading_days`` returns spanning ``calendar_days``."""
    return math.sqrt(365 * trading_days / (252 * calendar_days))


def log_returns(bars: list[Bar], exclude: frozenset[date] | set[date] = frozenset()) -> list[tuple[date, float, int]]:
    """(date of the later close, ln return, calendar days spanned) for consecutive regular-session bars with positive closes (short Muhurat sessions are skipped, see ``SHORT_SESSIONS``)."""
    out: list[tuple[date, float, int]] = []
    bars = regular_bars(bars, exclude)
    for a, b in zip(bars, bars[1:], strict=False):
        if a.close > 0 and b.close > 0:
            out.append((b.session, math.log(b.close / a.close), (b.session - a.session).days))
    return out


def stdev_annual(returns: list[float]) -> float | None:
    n = len(returns)
    if n < 2:
        return None
    mean = sum(returns) / n
    var = sum((r - mean) ** 2 for r in returns) / (n - 1)  # sample variance: the mean is estimated from the same returns
    return math.sqrt(var * TRADING_DAYS) * 100


def hv(rets: list[tuple[date, float, int]], window: int) -> float | None:
    if len(rets) < window:
        return None
    return stdev_annual([r for _, r, _ in rets[-window:]])


def hv_report(bars: list[Bar], today: date, series_len: int = 120, exclude: frozenset[date] | set[date] = frozenset()) -> dict[str, Any]:
    rets = log_returns(bars, exclude)
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
        "method": "sample standard deviation (n - 1) of daily log returns x sqrt(252), percent; final closes of regular sessions only",
    }


def rv_annual(returns: list[float]) -> float | None:
    """Realised volatility: sqrt(mean of squared returns x 252), percent. No mean is subtracted (a drift over a month is not volatility)."""
    if not returns:
        return None
    return math.sqrt(sum(r * r for r in returns) / len(returns) * TRADING_DAYS) * 100


def iv_chart(
    nifty: list[Bar], vix: list[Bar], window: int, days: int = 750, provisional: Bar | None = None, exclude: frozenset[date] | set[date] = frozenset()
) -> dict[str, Any]:
    """Daily series for the IV / HV / IV-percentile chart: NIFTY close, India VIX close (the implied-volatility proxy, the
    market's own 30-day figure) and the rolling ``window``-day historical volatility of NIFTY, on the dates both have a bar.

    The HV at a date uses the ``window`` returns ending that day (computed over the whole history first, so the first plotted
    days are not short of returns). A date without enough returns, or without a VIX bar, is dropped rather than filled. Short (Muhurat) sessions are not days.

    ``provisional`` is a not-yet-published latest day (close taken from our own stored index feed): it is added to the NIFTY close line only. It is not a final close, so
    no HV or RV is computed with it and its India VIX is missing (None); both are never filled."""
    base = len(nifty)
    if provisional is not None and (not nifty or provisional.session > nifty[-1].session):
        pass
    else:
        provisional = None
    rets = log_returns(nifty, exclude)
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
    for b in regular_bars(nifty, exclude):
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
    if provisional is not None:
        dates.append(str(provisional.session))
        close.append(provisional.close)
        iv.append(None)
        hvs.append(None)
        rvs.append(None)
    lo = max(0, len(dates) - days)
    return {
        "window": window, "dates": dates[lo:], "close": close[lo:], "iv": iv[lo:], "hv": hvs[lo:], "rv": rvs[lo:],
        "nifty_bars": base, "vix_bars": len(vix), "days": len(dates[lo:]),
        "provisional": None if provisional is None else {
            "date": str(provisional.session), "close": provisional.close,
            "note": "NIFTY close from our own stored index feed (the last level collected before the cash close; the official close is published with the daily history). It is drawn on the price line only: no HV, RV, rank or percentile uses it, and India VIX for this day is not published yet",
        },
        "iv_source": "India VIX daily close (NSE's 30-day implied volatility of NIFTY options); not the ATM IV of one expiry",
        "rv_method": "RV = sqrt(mean of squared daily log returns x 252), percent, same window (no mean subtracted)",
        "method": "HV = sample stdev (n - 1) of daily log returns x sqrt(252), percent; regular sessions only; dates present in both series only",
    }
