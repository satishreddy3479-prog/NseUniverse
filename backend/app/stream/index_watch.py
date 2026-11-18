"""Per-minute account of the NIFTY index ticks that reach the server, kept for the last quarter of an hour of the session.

The one-minute index bars and the stored chain's index level freeze every day from 15:15 IST. Whether the exchange stops publishing the index, the broker stops forwarding it or the app
drops it (``LiveBook.update`` discards a tick identical to the stored one, so a repeated value does not refresh the time the tick was received) cannot be told from the stored data. This
logs, once a minute between 15:10 and 15:35 IST, how many index ticks arrived (repeats included), how many different values they carried and the first and last value; nothing else.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
WINDOW = ((15, 10), (15, 35))


class IndexWatch:
    def __init__(self) -> None:
        self._minute: str | None = None
        self._count = 0
        self._values: set[float] = set()
        self._first: float | None = None
        self._last: float | None = None

    def observe(self, now: datetime, ltp: float | None) -> dict[str, object] | None:
        """Count one index tick. Returns the finished minute's account when the minute rolls over inside the window, else None."""
        t = now.astimezone(IST)
        if not (WINDOW[0] <= (t.hour, t.minute) < WINDOW[1]):
            return None
        minute = t.strftime("%H:%M")
        done: dict[str, object] | None = None
        if self._minute is not None and minute != self._minute:
            done = {"minute": self._minute, "ticks": self._count, "distinct": len(self._values), "first": self._first, "last": self._last}
            self._count, self._values, self._first, self._last = 0, set(), None, None
        self._minute = minute
        self._count += 1
        if ltp is not None:
            self._values.add(ltp)
            self._first = ltp if self._first is None else self._first
            self._last = ltp
        return done
