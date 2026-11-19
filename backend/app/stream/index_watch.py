"""Per-minute account of the NIFTY index ticks that reach the server, kept for the last quarter of an hour of the session.

The one-minute index bars and the stored chain's index level freeze every day from 15:15 IST. Whether the exchange stops publishing the index, the broker stops forwarding it or the app
drops it (``LiveBook.update`` discards a tick identical to the stored one, so a repeated value does not refresh the time the tick was received) cannot be told from the stored data. This
logs, once a minute between 15:10 and 15:35 IST, how many index ticks arrived (repeats included), how many different values they carried and the first and last value; nothing else.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
WINDOW = ((15, 10), (15, 35))
SNAPSHOT_WINDOW = ((15, 15), (15, 21))  # the minutes in which the pushed index is silent in the closing auction (19 Nov 2026): the broker is asked for it on request


def in_snapshot_window(now: datetime) -> bool:
    t = now.astimezone(IST)
    return SNAPSHOT_WINDOW[0] <= (t.hour, t.minute) < SNAPSHOT_WINDOW[1]


class IndexWatch:
    def __init__(self) -> None:
        self._minute: str | None = None
        self._minute_at: datetime | None = None
        self._count = 0
        self._values: set[float] = set()
        self._first: float | None = None
        self._last: float | None = None

    def observe(self, now: datetime, ltp: float | None) -> list[dict[str, object]]:
        """Count one index tick. Returns the accounts of the minutes finished by this tick: the minute that was counting, and a ``ticks: 0`` account for every minute with no tick
        between it and this one (19 Nov 2026: 15:16-15:19 left no line at all, so the silence could only be inferred)."""
        t = now.astimezone(IST)
        if not (WINDOW[0] <= (t.hour, t.minute) < WINDOW[1]):
            return []
        t = t.replace(second=0, microsecond=0)
        minute = t.strftime("%H:%M")
        done: list[dict[str, object]] = []
        if self._minute is not None and minute != self._minute:
            done.append({"minute": self._minute, "ticks": self._count, "distinct": len(self._values), "first": self._first, "last": self._last})
            self._count, self._values, self._first, self._last = 0, set(), None, None
            m = (self._minute_at or t) + timedelta(minutes=1)
            while m < t:
                done.append({"minute": m.strftime("%H:%M"), "ticks": 0, "distinct": 0, "first": None, "last": None})
                m += timedelta(minutes=1)
        self._minute = minute
        self._minute_at = t
        self._count += 1
        if ltp is not None:
            self._values.add(ltp)
            self._first = ltp if self._first is None else self._first
            self._last = ltp
        return done
