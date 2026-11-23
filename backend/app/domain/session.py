"""The NSE regular session the intraday analysis covers (IST).

Three schedules, by date (NSE circulars as reported by Kotak Neo, 19 Nov 2026; to be confirmed against NSE's own circular):
  before 3 Aug 2026     cash and F&O trade to 15:30 (no closing auction);
  3 Aug - 4 Dec 2026    continuous cash trading ends at 15:15 and the Closing Auction Session (CAS) runs 15:15-15:35 for F&O stocks;
                        index and stock F&O trade to 15:40. The cash segment's index is silent 15:15-15:20, then indicative values;
  from 7 Dec 2026       continuous cash trading runs to 15:30, CAS 15:30-15:40 (reference price 15:30-15:31, order entry 15:31-15:40,
                        matching 15:40-15:45); index and stock F&O trade to 15:45 (index contracts expiring that day stop at 15:30);
                        expiry settlement is back to the 15:00-15:30 VWAP.
Every sampler, feature, label and chart reads the close from here, and the close is confirmed from the exchange feed (see ``session_close``).
``closing_schedule`` gives the auction windows of a day; nothing else in the code carries a closing clock time.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

_IST = ZoneInfo("Asia/Kolkata")

SESSION_OPEN = time(9, 15)
#: the close that applies from 3 Aug 2026 until the exchange feed shows otherwise (CAS alignment); 15:30 before that
DEFAULT_CLOSE = time(15, 40)
DEFAULT_CLOSE_DEC = time(15, 45)  # from 7 Dec 2026
KNOWN_CLOSES = (time(15, 30), time(15, 40), time(15, 45))
CAS_START_DAY = date(2026, 8, 3)
CAS_SECOND_DAY = date(2026, 12, 7)


def regime(day: date) -> int:
    """0 before 3 Aug 2026, 1 from 3 Aug (cash trading ends 15:15, F&O to 15:40), 2 from 7 Dec 2026 (cash to 15:30, F&O to 15:45)."""
    return 2 if day >= CAS_SECOND_DAY else 1 if day >= CAS_START_DAY else 0


def default_close(day: date) -> time:
    """The F&O session close the schedule gives for ``day``, until the exchange feed confirms or contradicts it."""
    return {0: time(15, 30), 1: DEFAULT_CLOSE, 2: DEFAULT_CLOSE_DEC}[regime(day)]


@dataclass(frozen=True)
class ClosingSchedule:
    """The closing auction of one day, in IST. The index is silent from ``cash_end`` (continuous cash trading has ended, last traded prices pause), shows the exchange's indicative closing
    values from ``indicative_from`` to ``index_end``, and the tick account is kept from ``watch_from`` to ``watch_to``; the broker is asked for the index on request until ``snapshot_to``."""

    cash_end: time
    indicative_from: time
    index_end: time
    watch_from: time
    watch_to: time
    snapshot_to: time


_SCHEDULE_FIRST = ClosingSchedule(time(15, 15), time(15, 20), time(15, 30), time(15, 10), time(15, 35), time(15, 21))
_SCHEDULE_SECOND = ClosingSchedule(time(15, 30), time(15, 31), time(15, 40), time(15, 25), time(15, 45), time(15, 32))


def closing_schedule(day: date) -> ClosingSchedule:
    """From 7 Dec 2026 the auction moves from 15:15 to 15:30 (reference price 15:30-15:31, order entry to 15:40). The first schedule is the one observed on 19 Nov 2026."""
    return _SCHEDULE_SECOND if regime(day) == 2 else _SCHEDULE_FIRST


def spot_end(day: date) -> time | None:
    """The time from which the NIFTY index level is no longer collected on ``day``: the end of continuous cash trading (15:15 IST from 3 Aug 2026, 15:30 from 7 Dec 2026). After it the
    exchange publishes only indicative auction values for the index, which are displayed live but never stored or charted. None before 3 Aug 2026, when there was no closing auction.
    Option, future, OI and volume collection is not affected: it runs to ``session_close()``."""
    return None if regime(day) == 0 else closing_schedule(day).cash_end


class _Clock:
    """The session close the exchange feed has confirmed (see app/lifecycle/session_close.py), and the schedule regime it was seen in. Never guessed: with no confirmation for
    today's regime the schedule's default for today is used, so the close also moves on 7 Dec without a code change or a restart."""

    def __init__(self) -> None:
        self.close: time | None = None
        self.regime = 1
        self.source = "default (Closing Auction Session alignment)"


_CLOCK = _Clock()


def _today() -> date:
    return datetime.now(_IST).date()


def session_close() -> time:
    """The regular session's last minute (IST) as of now. Call it where the close is used; do not copy it at import."""
    today = _today()
    if _CLOCK.close is not None and _CLOCK.regime == regime(today):
        return _CLOCK.close
    return default_close(today)


def session_source() -> str:
    today = _today()
    if _CLOCK.close is not None and _CLOCK.regime == regime(today):
        return _CLOCK.source
    return f"schedule default for {today.isoformat()} (not yet confirmed by the exchange feed)"


def set_session_close(close: time, source: str) -> None:
    _CLOCK.close, _CLOCK.source, _CLOCK.regime = close, source, regime(_today())


def session_label() -> str:
    return f"{SESSION_OPEN:%H:%M}–{session_close():%H:%M} IST"


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
