"""Pure expiry-selection logic (no I/O, independently testable).

Rules (docs/decisions.md):
- Weekly: nearest listed expiry on or after ``today``.
- Monthly: latest listed expiry within ``today``'s calendar month that is on or
  after ``today``. If none remain, roll to next calendar month's latest listed
  expiry and flag ``monthly_is_next_month``.
- No weekdays or dates are assumed; everything comes from the listed expiries.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, datetime


class ExpiryParseError(ValueError):
    pass


def parse_expiry_dates(values: Iterable[object]) -> tuple[list[date], list[str]]:
    """Parse ISO ``YYYY-MM-DD`` strings; return sorted unique dates and warnings."""
    out: set[date] = set()
    warnings: list[str] = []
    for v in values:
        if not isinstance(v, str):
            warnings.append(f"ignored non-string expiry value of type {type(v).__name__}")
            continue
        try:
            out.add(datetime.strptime(v.strip(), "%Y-%m-%d").date())
        except ValueError:
            warnings.append(f"ignored unparseable expiry {v[:20]!r}")
    return sorted(out), warnings


@dataclass(frozen=True)
class ExpiryChoice:
    weekly: date | None
    monthly: date | None
    monthly_is_next_month: bool
    warnings: list[str] = field(default_factory=list)

    @property
    def weekly_equals_monthly(self) -> bool:
        return self.weekly is not None and self.weekly == self.monthly


def _next_month(d: date) -> tuple[int, int]:
    return (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)


def select_expiries(expiries: Iterable[date], today: date) -> ExpiryChoice:
    upcoming = sorted({e for e in expiries if e >= today})
    warnings: list[str] = []
    if not upcoming:
        return ExpiryChoice(None, None, False, ["no listed expiry on or after today"])

    weekly = upcoming[0]

    this_month = [e for e in upcoming if (e.year, e.month) == (today.year, today.month)]
    if this_month:
        return ExpiryChoice(weekly, this_month[-1], False, warnings)

    ny, nm = _next_month(today)
    next_month = [e for e in upcoming if (e.year, e.month) == (ny, nm)]
    if next_month:
        warnings.append("no remaining expiry this month; monthly rolled to next month")
        return ExpiryChoice(weekly, next_month[-1], True, warnings)

    warnings.append("no expiry listed for this month or next month; monthly unavailable")
    return ExpiryChoice(weekly, None, False, warnings)
