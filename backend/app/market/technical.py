"""Daily technical read of a stock from real daily bars (NSE bhavcopy). Pure functions, no I/O."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Bar:
    session: str
    open: float | None
    high: float | None
    low: float | None
    close: float | None
    volume: int | None


def sma(values: list[float], n: int) -> float | None:
    return sum(values[-n:]) / n if len(values) >= n else None


def rsi(closes: list[float], n: int = 14) -> float | None:
    """Wilder's RSI."""
    if len(closes) < n + 1:
        return None
    ch = [b - a for a, b in zip(closes, closes[1:], strict=False)]
    gain = sum(max(c, 0) for c in ch[:n]) / n
    loss = sum(max(-c, 0) for c in ch[:n]) / n
    for c in ch[n:]:
        gain = (gain * (n - 1) + max(c, 0)) / n
        loss = (loss * (n - 1) + max(-c, 0)) / n
    if loss == 0:
        return 100.0 if gain > 0 else 50.0
    return 100 - 100 / (1 + gain / loss)


def atr(bars: list[Bar], n: int = 14) -> float | None:
    """Wilder's average true range; needs n+1 complete bars."""
    ok = [b for b in bars if b.high is not None and b.low is not None and b.close is not None]
    if len(ok) < n + 1:
        return None
    trs: list[float] = []
    for a, b in zip(ok, ok[1:], strict=False):
        assert a.close is not None and b.high is not None and b.low is not None
        trs.append(max(b.high - b.low, abs(b.high - a.close), abs(b.low - a.close)))
    cur = sum(trs[:n]) / n
    for t in trs[n:]:
        cur = (cur * (n - 1) + t) / n
    return float(cur)


def read(symbol: str, bars: list[Bar], live_price: float | None = None) -> dict[str, Any]:
    """Moving averages, RSI, ATR, 20-day range, trend and volume against the 20-day average.

    Anything that cannot be computed from the bars we hold is None (never filled)."""
    bars = [b for b in bars if b.close is not None]
    closes = [b.close for b in bars if b.close is not None]
    last = closes[-1] if closes else None
    px = live_price if live_price is not None else last
    s20, s50 = sma(closes, 20), sma(closes, 50)
    hi20 = (
        max((b.high for b in bars[-20:] if b.high is not None), default=None)
        if len(bars) >= 20
        else None
    )
    lo20 = (
        min((b.low for b in bars[-20:] if b.low is not None), default=None)
        if len(bars) >= 20
        else None
    )
    vols = [b.volume for b in bars[-20:] if b.volume is not None]
    avg_vol = sum(vols) / len(vols) if len(vols) == 20 else None
    a = atr(bars)
    trend = None
    if px is not None and s20 is not None:
        if s50 is not None:
            trend = "uptrend" if px > s20 > s50 else "downtrend" if px < s20 < s50 else "mixed"
        else:
            trend = "above 20-day average" if px > s20 else "below 20-day average"
    return {
        "symbol": symbol,
        "bars": len(bars),
        "last_session": bars[-1].session if bars else None,
        "last_close": last,
        "sma20": None if s20 is None else round(s20, 2),
        "sma50": None if s50 is None else round(s50, 2),
        "rsi14": None if (r := rsi(closes)) is None else round(r, 1),
        "atr14": None if a is None else round(a, 2),
        "atr_pct": None if a is None or not px else round(a / px * 100, 2),
        "high20": hi20,
        "low20": lo20,
        "avg_volume20": None if avg_vol is None else round(avg_vol),
        "trend": trend,
        "price_vs_sma20_pct": None if px is None or s20 is None else round((px / s20 - 1) * 100, 2),
        "range_position": None
        if px is None or hi20 is None or lo20 is None or hi20 == lo20
        else round((px - lo20) / (hi20 - lo20), 2),
        "enough_history": len(bars) >= 50,
    }
