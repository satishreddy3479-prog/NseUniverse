"""Daily price history from Yahoo Finance through the unofficial `yfinance` package.

Status: the user chose free unofficial sources (2026-10-28). Yahoo's API is for personal use only,
may change or throttle without notice, and its NSE data can contain errors, so every row is kept with
its provenance and later disagreements are logged, never applied silently (see history_store).

Index series have no corporate-action adjustment problem; prices are requested unadjusted
(`auto_adjust=False`). Index "volume" from Yahoo is usually 0 or empty and is stored as missing.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal, Protocol
from zoneinfo import ZoneInfo

Kind = Literal["india_index", "india_vix", "global_index", "yield", "fx", "commodity"]


@dataclass(frozen=True)
class SymbolSpec:
    key: str  # our stable name
    yahoo: str  # Yahoo ticker
    name: str
    kind: Kind
    timezone: str  # exchange timezone of the daily bar
    close: time | None  # regular-session close in that timezone; None = no single daily close
    #: True only when the close time has been checked against the exchange. Unverified symbols are
    #: stored but are NOT usable as leakage-safe features until verified (docs/prediction/data-sources.md).
    timing_verified: bool = False
    ticker_verified: bool = False  # True once real data for the ticker was seen in our store


SYMBOLS: list[SymbolSpec] = [
    SymbolSpec("NIFTY50", "^NSEI", "NIFTY 50", "india_index", "Asia/Kolkata", time(15, 40), True),
    SymbolSpec("INDIAVIX", "^INDIAVIX", "India VIX", "india_vix", "Asia/Kolkata", time(15, 40)),
    SymbolSpec("NIFTYBANK", "^NSEBANK", "NIFTY Bank", "india_index", "Asia/Kolkata", time(15, 40)),
    SymbolSpec("NIFTYIT", "^CNXIT", "NIFTY IT", "india_index", "Asia/Kolkata", time(15, 40)),
    SymbolSpec("NIFTYAUTO", "^CNXAUTO", "NIFTY Auto", "india_index", "Asia/Kolkata", time(15, 40)),
    SymbolSpec(
        "NIFTYPHARMA", "^CNXPHARMA", "NIFTY Pharma", "india_index", "Asia/Kolkata", time(15, 40)
    ),
    SymbolSpec("NIFTYFMCG", "^CNXFMCG", "NIFTY FMCG", "india_index", "Asia/Kolkata", time(15, 40)),
    SymbolSpec(
        "NIFTYMETAL", "^CNXMETAL", "NIFTY Metal", "india_index", "Asia/Kolkata", time(15, 40)
    ),
    SymbolSpec(
        "NIFTYENERGY", "^CNXENERGY", "NIFTY Energy", "india_index", "Asia/Kolkata", time(15, 40)
    ),
    SymbolSpec(
        "NIFTYREALTY", "^CNXREALTY", "NIFTY Realty", "india_index", "Asia/Kolkata", time(15, 40)
    ),
    SymbolSpec("SPX", "^GSPC", "S&P 500", "global_index", "America/New_York", time(16, 0)),
    SymbolSpec(
        "NDX_COMP", "^IXIC", "Nasdaq Composite", "global_index", "America/New_York", time(16, 0)
    ),
    SymbolSpec(
        "DJI",
        "^DJI",
        "Dow Jones Industrial Average",
        "global_index",
        "America/New_York",
        time(16, 0),
    ),
    SymbolSpec("VIX", "^VIX", "CBOE VIX", "global_index", "America/New_York", time(16, 15)),
    SymbolSpec("N225", "^N225", "Nikkei 225", "global_index", "Asia/Tokyo", time(15, 30)),
    SymbolSpec("HSI", "^HSI", "Hang Seng", "global_index", "Asia/Hong_Kong", time(16, 0)),
    SymbolSpec(
        "SSEC", "000001.SS", "Shanghai Composite", "global_index", "Asia/Shanghai", time(15, 0)
    ),
    SymbolSpec("DAX", "^GDAXI", "DAX", "global_index", "Europe/Berlin", time(17, 30)),
    SymbolSpec("FTSE", "^FTSE", "FTSE 100", "global_index", "Europe/London", time(16, 30)),
    SymbolSpec("UST10Y", "^TNX", "US 10-year yield (CBOE, x10)", "yield", "America/New_York", None),
    SymbolSpec(
        "BRENT", "BZ=F", "Brent crude futures (continuous)", "commodity", "America/New_York", None
    ),
    SymbolSpec(
        "WTI", "CL=F", "WTI crude futures (continuous)", "commodity", "America/New_York", None
    ),
    SymbolSpec("GOLD", "GC=F", "Gold futures (continuous)", "commodity", "America/New_York", None),
    SymbolSpec("DXY", "DX-Y.NYB", "US Dollar Index", "fx", "America/New_York", None),
    SymbolSpec("USDINR", "INR=X", "USD/INR", "fx", "UTC", None),
]
# Timing check (2026-10-28, research/timing_audit.py on the real history): every series is used only
# through "the last bar dated on or before the reference session", which is complete by 08:30 IST the
# next morning (US cash close 01:30/02:30 IST, futures settlements and FX day by ~05:00 IST, Europe
# ~21:00-22:00 IST, Asia and India during the reference day). US bars dated t correlate +0.38 with
# NIFTY's next opening gap and bars dated t+1 only +0.10, which is the signature of correct dating.
SYMBOLS = [replace(s, timing_verified=True) for s in SYMBOLS]
BY_KEY = {s.key: s for s in SYMBOLS}

#: a daily bar is final only this long after its session ends; before that it is a partial,
#: intraday bar and must never enter the history the prediction models read
COMPLETE_BUFFER = timedelta(minutes=30)


def complete_after(spec: SymbolSpec, session: date) -> datetime:
    """UTC instant from which the daily bar of ``session`` is final.

    Series with a regular close use it. Series without one (futures, FX, yields) use 17:00 New York
    for US-dated series and the end of the UTC day for USD/INR, both followed by the buffer.
    """
    tz = ZoneInfo(spec.timezone)
    close = spec.close or (time(17, 0) if tz.key == "America/New_York" else time(23, 59, 59))
    return (datetime.combine(session, close, tz) + COMPLETE_BUFFER).astimezone(UTC)


@dataclass(frozen=True)
class RawRow:
    session: date
    open: float | None
    high: float | None
    low: float | None
    close: float | None
    volume: float | None


class Downloader(Protocol):
    def __call__(self, spec: SymbolSpec, start: date, end: date) -> list[RawRow]: ...


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def rows_from_frame(frame: Any) -> list[RawRow]:
    """Convert a yfinance DataFrame (index = timestamps, columns Open/High/Low/Close/Volume).

    The index timestamps are in the exchange's timezone, so ``.date()`` is the session date.
    Rows missing any price become rows with None prices; the store counts and skips them.
    """
    out: list[RawRow] = []
    if frame is None or len(frame) == 0:
        return out
    for ts, row in frame.iterrows():
        d = ts.date() if hasattr(ts, "date") else ts
        out.append(
            RawRow(
                d,
                _num(row.get("Open")),
                _num(row.get("High")),
                _num(row.get("Low")),
                _num(row.get("Close")),
                _num(row.get("Volume")),
            )  # fmt: skip
        )
    return out


def yahoo_download(spec: SymbolSpec, start: date, end: date) -> list[RawRow]:
    """Real download. Needs the `yfinance` package (requirements-research.txt) and internet access."""
    import yfinance as yf  # type: ignore[import-untyped]  # lazy: not installed on the server

    frame = yf.Ticker(spec.yahoo).history(
        start=start.isoformat(),
        end=end.isoformat(),
        interval="1d",
        auto_adjust=False,
        actions=False,
    )
    return rows_from_frame(frame)


def iter_specs(keys: Iterable[str] | None) -> list[SymbolSpec]:
    if keys is None:
        return list(SYMBOLS)
    unknown = [k for k in keys if k not in BY_KEY]
    if unknown:
        raise KeyError(f"unknown symbol keys: {unknown}")
    return [BY_KEY[k] for k in keys]
