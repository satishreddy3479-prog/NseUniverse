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
import os
from bisect import bisect_left, bisect_right
from collections.abc import Iterable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

REFERENCE = Path(__file__).parent / "reference" / "nse_cm_holidays.json"


class CalendarCoverageError(Exception):
    """Asked about a date the calendar has no verified information for."""


class SessionLookup(Protocol):
    def is_session(self, d: date) -> bool: ...
    def next_session(self, d: date, n: int = 1) -> date: ...
    def prev_session(self, d: date, n: int = 1) -> date: ...


_LOADED: dict[Path, TradingCalendar] = {}
#: Where the holidays the user entered in Settings are kept (set at start-up from the data folder). They are added to the NSE circular
#: list, never replace it: the circular list stays the verified part and the user's part carries its source note.
_USER_FILE: Path | None = None
USER_FILE_NAME = "holidays_user.json"
MAX_USER_ENTRIES = 80


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
        #: the period the NSE circular file alone covers (the user's additions are merged on top of it)
        self.reference_coverage = coverage
        self.user: dict[str, Any] | None = None

    @classmethod
    def load(cls, path: Path = REFERENCE) -> TradingCalendar:
        """The verified calendar, parsed once per file and shared (it is never modified)."""
        hit = _LOADED.get(path)
        if hit is None:
            hit = _LOADED[path] = cls._parse(path)
            if path == REFERENCE:
                hit._merge_user()
        return hit

    @classmethod
    def reload(cls) -> TradingCalendar:
        """Re-read the circular list and the user's file into the SHARED calendar in place, so every holder of it sees the change at once."""
        shared = cls.load()
        fresh = cls._parse(REFERENCE)
        shared.holidays, shared.coverage, shared.special_sessions = fresh.holidays, fresh.coverage, fresh.special_sessions
        shared.reference_coverage = fresh.coverage
        shared.user = None
        shared._merge_user()
        return shared

    def _merge_user(self) -> None:
        doc = read_user_file()
        if doc is None:
            return
        try:
            holidays = {date.fromisoformat(h["date"]): str(h["name"]) for h in doc.get("holidays", [])}
            specials = {date.fromisoformat(h["date"]): str(h["name"]) for h in doc.get("special_sessions", [])}
            to = date.fromisoformat(doc["coverage_to"])
        except (KeyError, ValueError, TypeError):
            return  # a damaged user file must never take the calendar down: the verified list stands alone
        for d, n in holidays.items():
            self.holidays.setdefault(d, n)
        for d, n in specials.items():
            self.special_sessions.setdefault(d, n)
        self.coverage = (self.coverage[0], max(self.coverage[1], to))
        self.user = doc

    @classmethod
    def _parse(cls, path: Path) -> TradingCalendar:
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


# ---------------------------------------------------------------------------------------------- holidays the user enters
def set_user_file(path: Path | None) -> None:
    """Choose the file of user-entered holidays (None: none) and re-read the shared calendar."""
    global _USER_FILE
    _USER_FILE = path
    if REFERENCE in _LOADED:
        TradingCalendar.reload()


def read_user_file() -> dict[str, Any] | None:
    if _USER_FILE is None or not _USER_FILE.exists():
        return None
    try:
        doc = json.loads(_USER_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def validate_user_holidays(doc: dict[str, Any], today: date | None = None) -> tuple[dict[str, Any] | None, list[str]]:
    """Check what the user entered against the NSE circular list. Returns the clean document, or the list of problems.

    Each rule stops a silent mistake: holidays are weekdays; no date outside the covered period or already in the circular list; the
    source (which circular) is named; extending the covered period needs the explicit statement that every holiday of it was entered,
    because after the covered period ends the app treats every weekday as a session.
    """
    today = today or datetime.now(UTC).date()
    ref = TradingCalendar._parse(REFERENCE)
    errors: list[str] = []
    try:
        to = date.fromisoformat(str(doc.get("coverage_to")))
    except ValueError:
        return None, ["Choose the date the list covers up to."]
    if to < ref.coverage[1]:
        errors.append(f"The covered period cannot end before {ref.coverage[1]} (the NSE circular list already covers that).")
    if to > today + timedelta(days=800):
        errors.append("The covered period is too far ahead.")
    source = str(doc.get("source", "")).strip()
    if len(source) < 8:
        errors.append("Name the NSE circular these dates come from (number and date).")
    out: dict[str, list[dict[str, str]]] = {"holidays": [], "special_sessions": []}
    seen: set[date] = set()
    for key, label in (("holidays", "Holiday"), ("special_sessions", "Special session")):
        for row in doc.get(key, []) or []:
            try:
                d = date.fromisoformat(str(row.get("date")))
            except ValueError:
                errors.append(f"{label}: '{row.get('date')}' is not a date.")
                continue
            name = str(row.get("name", "")).strip()
            if not name or len(name) > 80:
                errors.append(f"{label} {d}: give it a name (up to 80 characters).")
            if d in seen:
                errors.append(f"{d} is entered twice.")
            seen.add(d)
            if d < ref.coverage[0] or d > to:
                errors.append(f"{label} {d} is outside the covered period {ref.coverage[0]} to {to}.")
            if key == "holidays":
                if d.weekday() >= 5:
                    errors.append(f"Holiday {d} falls on a weekend; weekends are never sessions, so it is not needed.")
                if d in ref.holidays:
                    errors.append(f"Holiday {d} is already in the NSE circular list ({ref.holidays[d]}).")
            out[key].append({"date": d.isoformat(), "name": name})
    if len(out["holidays"]) + len(out["special_sessions"]) > MAX_USER_ENTRIES:
        errors.append(f"At most {MAX_USER_ENTRIES} entries.")
    if to > ref.coverage[1]:
        if not doc.get("confirm_complete"):
            errors.append("Tick the box to confirm you entered every holiday of the new period from the circular.")
        if not any(date.fromisoformat(h["date"]) > ref.coverage[1] for h in out["holidays"]):
            errors.append("A new period with no holiday after the old end is almost certainly incomplete; enter the circular's holidays.")
    if errors:
        return None, errors
    for k in out:
        out[k].sort(key=lambda r: r["date"])
    clean = {"coverage_to": to.isoformat(), "source": source, **out, "updated_at": datetime.now(UTC).isoformat()}
    return clean, []


def save_user_holidays(clean: dict[str, Any]) -> None:
    """Write the user's file atomically and re-read the shared calendar."""
    if _USER_FILE is None:
        raise RuntimeError("no place to keep the holidays is configured")
    _USER_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _USER_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(clean, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, _USER_FILE)
    TradingCalendar.reload()
