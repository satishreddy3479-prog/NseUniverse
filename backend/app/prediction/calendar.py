"""Exchange trading calendars for target construction.

Two calendars, same interface:

* ``TradingCalendar``: forward-looking, from NSE's published holiday circulars. It refuses to answer
  for years it has no circular for, because "every weekday is a session" is wrong in India.
* ``SessionCalendar``: built from the dates of an actual price history. For labelling history, the
  days that have a recorded regular session ARE the sessions, whatever holidays or special days
  happened. It needs no holiday list.

Special sessions (Muhurat trading, an occasional weekend session) are tracked separately and are
never treated as regular sessions: a regular-session target must not silently include them.
"""

from __future__ import annotations

import json
from bisect import bisect_left, bisect_right
from collections.abc import Iterable
from datetime import date, timedelta
from pathlib import Path
from typing import Protocol

REFERENCE = Path(__file__).parent / "reference" / "nse_cm_holidays.json"


class CalendarCoverageError(Exception):
    """Asked about a date the calendar has no verified information for."""


class SessionLookup(Protocol):
    def is_session(self, d: date) -> bool: ...
    def next_session(self, d: date, n: int = 1) -> date: ...
    def prev_session(self, d: date, n: int = 1) -> date: ...


class TradingCalendar:
    def __init__(
        self,
        holidays: dict[date, str],
        coverage: tuple[date, date],
        special_sessions: dict[date, str] | None = None,
    ) -> None:
        self.holidays = holidays
        self.coverage = coverage
        self.special_sessions = special_sessions or {}

    @classmethod
    def load(cls, path: Path = REFERENCE) -> TradingCalendar:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return cls(
            {date.fromisoformat(k): v for k, v in raw["weekday_holidays"].items()},
            (
                date.fromisoformat(raw["coverage"]["from"]),
                date.fromisoformat(raw["coverage"]["to"]),
            ),
            {date.fromisoformat(k): v for k, v in raw.get("special_sessions", {}).items()},
        )

    def _check(self, d: date) -> None:
        lo, hi = self.coverage
        if not lo <= d <= hi:
            raise CalendarCoverageError(
                f"{d} is outside the verified holiday coverage {lo}..{hi}; "
                "add the NSE circular first"
            )

    def is_special_session(self, d: date) -> bool:
        return d in self.special_sessions

    def is_session(self, d: date) -> bool:
        """A regular session: a weekday that is not a listed holiday."""
        self._check(d)
        return d.weekday() < 5 and d not in self.holidays

    def next_session(self, d: date, n: int = 1) -> date:
        """The n-th regular session strictly after ``d`` (d itself need not be a session)."""
        if n < 1:
            raise ValueError("n must be at least 1")
        cur, found = d, 0
        while found < n:
            cur += timedelta(days=1)
            if self.is_session(cur):
                found += 1
        return cur

    def prev_session(self, d: date, n: int = 1) -> date:
        """The n-th regular session strictly before ``d``."""
        if n < 1:
            raise ValueError("n must be at least 1")
        cur, found = d, 0
        while found < n:
            cur -= timedelta(days=1)
            if self.is_session(cur):
                found += 1
        return cur

    def sessions_between(self, start: date, end: date) -> list[date]:
        """Regular sessions in [start, end]."""
        out, cur = [], start
        while cur <= end:
            if self.is_session(cur):
                out.append(cur)
            cur += timedelta(days=1)
        return out


class SessionCalendar:
    """Sessions taken from a price history's own dates."""

    def __init__(self, dates: Iterable[date]) -> None:
        self.dates = sorted(set(dates))

    def is_session(self, d: date) -> bool:
        i = bisect_left(self.dates, d)
        return i < len(self.dates) and self.dates[i] == d

    def next_session(self, d: date, n: int = 1) -> date:
        if n < 1:
            raise ValueError("n must be at least 1")
        i = bisect_right(self.dates, d) + n - 1
        if i >= len(self.dates):
            raise CalendarCoverageError(f"history has no session {n} after {d}")
        return self.dates[i]

    def prev_session(self, d: date, n: int = 1) -> date:
        if n < 1:
            raise ValueError("n must be at least 1")
        i = bisect_left(self.dates, d) - n
        if i < 0:
            raise CalendarCoverageError(f"history has no session {n} before {d}")
        return self.dates[i]
