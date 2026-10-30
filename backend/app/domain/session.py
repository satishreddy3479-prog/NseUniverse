"""The NSE regular session the intraday analysis covers (IST).

Since 3 Aug 2026 equity derivatives (NIFTY futures and options) trade 09:15-15:40, ten minutes
longer than before, to line up with the cash market's Closing Auction Session (15:15-15:35 for
F&O stocks). Every sampler, feature, label and chart reads the close from here, so if NSE changes
the timing back, change SESSION_CLOSE (and SESSION_CLOSE_MIN in frontend/src/lib/session.ts) and
nothing else.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

_IST = ZoneInfo("Asia/Kolkata")

SESSION_OPEN = time(9, 15)
SESSION_CLOSE = time(15, 40)
LABEL = f"{SESSION_OPEN:%H:%M}–{SESSION_CLOSE:%H:%M} IST"


def market_time(at: datetime, is_trading_day: Callable[[date], bool | None] | None = None) -> datetime:
    """The moment the market last showed the prices of a sample taken at ``at``.

    Inside a session it is ``at``. After the close it is that day's close; before the open, on a weekend or on an
    exchange holiday it is the close of the latest earlier trading day. A chain fetched at 02:37 the next morning
    holds the 15:40 close, so time-to-expiry (and everything that depends on it, such as implied volatility and theta)
    must be counted from 15:40, not from the fetch. ``is_trading_day`` is the exchange calendar (None = unknown, then
    only weekends are skipped).
    """

    def trading(d: date) -> bool:
        if d.weekday() >= 5:
            return False
        known = is_trading_day(d) if is_trading_day is not None else None
        return True if known is None else known

    ist = at.astimezone(_IST)
    day = ist.date()
    if trading(day) and SESSION_OPEN <= ist.time() <= SESSION_CLOSE:
        return at
    if trading(day) and ist.time() > SESSION_CLOSE:
        return datetime.combine(day, SESSION_CLOSE, _IST)
    d = day - timedelta(days=1)
    for _ in range(14):
        if trading(d):
            return datetime.combine(d, SESSION_CLOSE, _IST)
        d -= timedelta(days=1)
    return at
