"""Heads-up rules: which calendar events and news items deserve a reminder on every page, and when each one comes back.

Events: only the catalysts that move markets (India's releases, rate decisions, inflation, jobs, growth, retail sales, ISM, the Fed chair), not every three-star item.
A reminder starts 3 days before the event, comes again 2 days before, and in the last 24 hours comes every 4 hours, with a final one in the last hour. Each of those
moments is a *phase* with its own key: a reminder the user closed stays closed until the next phase begins, with no timers to keep.

News: a headline that was stored in the last 45 minutes, was published in the last 3 hours and is about a market-moving topic; at most three, newest first.
"""

from __future__ import annotations

import math
import re
from typing import Any

LEAD_H = 72.0  # reminders start this long before the event
NEWS_FRESH_MIN, NEWS_PUBLISHED_H, NEWS_MAX, EVENTS_MAX = 45, 3.0, 3, 8

_CATALYST = re.compile(
    r"\b(rate decision|interest rate|fomc|fed chair|press conference|cpi|pce|ppi|nonfarm|payrolls?|unemployment rate|gdp|retail sales|ism (manufacturing|non-manufacturing) pmi|"
    r"rbi|monetary policy|wpi|iip|trade balance|budget)\b",
    re.I,
)


def is_catalyst(row: dict[str, Any]) -> bool:
    """India's releases (the calendar already limits them to the ones that matter) and the named US catalysts."""
    name = row["name"]
    return row["country"] == "India" or (not name.lower().startswith("adp") and bool(_CATALYST.search(name)))  # ADP's private-payrolls estimate is a minor preview of the jobs report


def phase_of(hours_to: float) -> str:
    """The reminder moment an event is in: d3 (3 to 2 days out), d2 (2 to 1 days), then a 4-hour bucket h5..h0 in the last day, and final in the last hour."""
    if hours_to <= 1:
        return "final"
    if hours_to > 48:
        return "d3"
    if hours_to > 24:
        return "d2"
    return f"h{min(5, math.floor(hours_to / 4))}"
