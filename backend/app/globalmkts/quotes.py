"""Quotes of the global board from Yahoo one-minute bars (through the unofficial ``yfinance`` package, as the project's earlier daily history did).

A quote is the close of the newest one-minute bar. Its change is computed here, never copied from the source: the previous session's last bar is the
reference (the close the futures settled on or the cash market closed at, as far as one-minute bars show it). Bars are stamped at the start of their minute,
so a bar is final one minute later; ``as_of`` is that moment and ``age_s`` how old it is. Nothing is made up: a symbol with no bar has no quote.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.globalmkts.symbols import GSymbol, expected_open, session_key

LIVE_MAX_AGE_S = 8 * 60  # a bar older than this (plus the symbol's normal source delay) means the market is not trading (or the feed is not updating)


@dataclass(frozen=True)
class Bar:
    ts: datetime  # start of the minute, UTC
    close: float


@dataclass(frozen=True)
class Quote:
    key: str
    price: float
    bar_ts: datetime  # start of the newest bar
    as_of: datetime  # when that bar was complete
    age_s: float
    status: str  # "live", "closed" or "stale" (should be trading but the bars are not updating)
    session: str
    prev_close: float | None
    prev_ts: datetime | None
    change: float | None
    change_pct: float | None
    bars: tuple[Bar, ...]  # every bar of the latest session


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) and f > 0 else None


def bars_from_frame(frame: Any, yahoo: str) -> list[Bar]:
    """The one-minute bars of ``yahoo`` from a ``yfinance.download(..., group_by="ticker")`` frame (or a single-ticker frame)."""
    if frame is None or len(frame) == 0:
        return []
    try:
        sub = frame[yahoo] if hasattr(frame.columns, "levels") else frame
    except KeyError:
        return []
    out: list[Bar] = []
    for ts, row in sub.iterrows():
        price = _num(row.get("Close"))
        if price is None:
            continue
        t = ts.to_pydatetime() if hasattr(ts, "to_pydatetime") else ts
        if t.tzinfo is None:
            t = t.replace(tzinfo=UTC)
        out.append(Bar(t.astimezone(UTC), price))
    out.sort(key=lambda b: b.ts)
    return out


def build_quote(spec: GSymbol, bars: Sequence[Bar], now: datetime, earlier: Sequence[Bar] = ()) -> Quote | None:
    """The quote of one symbol from its newest bars. ``earlier`` are older stored bars: the session before the latest one gives the reference close, and a
    poll that fetched only today's bars still finds it there. A US index future is measured from the 16:00 New York cash close, the other symbols from the
    last bar of the previous session."""
    if not bars:
        return None
    first = min(b.ts for b in bars)
    bars = sorted({b.ts: b for b in [*(e for e in earlier if e.ts < first), *bars]}.values(), key=lambda b: b.ts)
    last = bars[-1]
    session = session_key(spec, last.ts)
    mine = tuple(b for b in bars if session_key(spec, b.ts) == session)
    before = [b for b in bars if session_key(spec, b.ts) < session]
    ref = before[-1] if before else None
    if ref is not None and spec.ref_close is not None:
        psession = session_key(spec, ref.ts)
        zone = ZoneInfo(spec.tz)
        at_close = [b for b in before if session_key(spec, b.ts) == psession and b.ts.astimezone(zone).time() < spec.ref_close]
        ref = at_close[-1] if at_close else ref
    as_of = last.ts + timedelta(minutes=1)
    age = max(0.0, (now - as_of).total_seconds())
    status = "live" if age <= LIVE_MAX_AGE_S + spec.delay_min * 60 else ("stale" if expected_open(spec, now) else "closed")
    change = None if ref is None else last.close - ref.close
    pct = None if ref is None or ref.close <= 0 or change is None else change / ref.close * 100
    return Quote(spec.key, last.close, last.ts, as_of, age, status, session, None if ref is None else ref.close, None if ref is None else ref.ts, change, pct, mine)


Downloader = Callable[[list[str], str], Any]


def yahoo_download(tickers: list[str], period: str = "1d") -> Any:
    """One-minute bars for ``tickers`` over ``period`` (Yahoo counts calendar days: "5d" always reaches two sessions) in one request (needs ``yfinance``)."""
    import yfinance as yf  # type: ignore[import-untyped]  # noqa: PLC0415 - optional dependency, imported when first used

    return yf.download(tickers, period=period, interval="1m", group_by="ticker", progress=False, threads=False, auto_adjust=False)


def yahoo_daily(tickers: list[str], period: str = "10d") -> Any:
    """Daily bars for ``tickers``: a cash index's daily close is its official closing value (the last one-minute bar can be taken before the closing auction)."""
    import yfinance as yf  # noqa: PLC0415 - optional dependency, imported when first used

    return yf.download(tickers, period=period, interval="1d", group_by="ticker", progress=False, threads=False, auto_adjust=False)


def daily_closes(frame: Any, yahoo: str) -> list[tuple[date, float]]:
    """(exchange date, official close) pairs of one symbol from a daily ``yfinance.download`` frame, oldest first."""
    if frame is None or len(frame) == 0:
        return []
    try:
        sub = frame[yahoo] if hasattr(frame.columns, "levels") else frame
    except KeyError:
        return []
    out: list[tuple[date, float]] = []
    for ts, row in sub.iterrows():
        price = _num(row.get("Close"))
        if price is not None:
            out.append((ts.date() if hasattr(ts, "date") else ts, price))
    out.sort(key=lambda p: p[0])
    return out
