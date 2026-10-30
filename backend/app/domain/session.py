"""The NSE regular session the intraday analysis covers (IST).

Since 3 Aug 2026 equity derivatives (NIFTY futures and options) trade 09:15-15:40, ten minutes
longer than before, to line up with the cash market's Closing Auction Session (15:15-15:35 for
F&O stocks). Every sampler, feature, label and chart reads the close from here, so if NSE changes
the timing back, nothing needs changing: the close is read from the exchange feed (see ``session_close``).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

_IST = ZoneInfo("Asia/Kolkata")

SESSION_OPEN = time(9, 15)
#: the close that applies until the exchange feed shows otherwise (CAS alignment since 3 Aug 2026); 15:30 before that
DEFAULT_CLOSE = time(15, 40)
KNOWN_CLOSES = (time(15, 30), time(15, 40))


class _Clock:
    """The session close in force. Set from the exchange's own market-status messages (see app/lifecycle/session_close.py),
    never guessed: when NSE removes the CAS extension the feed's 'closed' message moves from 15:40 to 15:30 and the
    close here follows without a code change."""

    def __init__(self) -> None:
        self.close = DEFAULT_CLOSE
        self.source = "default (Closing Auction Session alignment)"


_CLOCK = _Clock()


def session_close() -> time:
    """The regular session's last minute (IST) as of now. Call it where the close is used; do not copy it at import."""
    return _CLOCK.close


def session_source() -> str:
    return _CLOCK.source


def set_session_close(close: time, source: str) -> None:
    _CLOCK.close, _CLOCK.source = close, source


def session_label() -> str:
    return f"{SESSION_OPEN:%H:%M}–{_CLOCK.close:%H:%M} IST"


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
    if trading(day) and SESSION_OPEN <= ist.time() <= session_close():
        return at
    if trading(day) and ist.time() > session_close():
        return datetime.combine(day, session_close(), _IST)
    d = day - timedelta(days=1)
    for _ in range(14):
        if trading(d):
            return datetime.combine(d, session_close(), _IST)
        d -= timedelta(days=1)
    return at
