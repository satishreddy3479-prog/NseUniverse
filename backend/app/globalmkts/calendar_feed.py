"""Economic calendar sources.

1. The official calendar already in the project (``app/prediction/reference/events.json``: FOMC, RBI, US data releases, elections), every date from an official
   page named in its ``source``.
2. The Forex Factory public weekly JSON feed (this week and next): events of the major currencies with an impact of High, Medium or Low. It is an unofficial third-party
   feed, shown with its name and read at a low rate; High is the "three-star" level of the board.

Moneycontrol's calendar is not read: its site answers an honest client with 403 and redirects a server's address to a login page, and bot protection is not
worked around.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from app.prediction.events import REFERENCE, EventCalendar

IST = ZoneInfo("Asia/Kolkata")
FF_URLS = ["https://nfs.faireconomy.media/ff_calendar_thisweek.json", "https://nfs.faireconomy.media/ff_calendar_nextweek.json"]
FF_LABEL = "Forex Factory public feed (unofficial)"
OFFICIAL_LABEL = "Official calendar"
CURRENCY_COUNTRY = {"USD": "US", "EUR": "Euro area", "GBP": "UK", "JPY": "Japan", "CNY": "China", "AUD": "Australia", "CAD": "Canada", "CHF": "Switzerland", "NZD": "New Zealand", "INR": "India"}
IMPACT = {"high": "high", "medium": "medium", "low": "low"}


def _country_of(name: str) -> str:
    n = name.lower()
    if n.startswith("us ") or "fomc" in n or "federal reserve" in n:
        return "US"
    if n.startswith("india") or "rbi" in n or "union budget" in n or "lok sabha" in n:
        return "India"
    return ""


def official_events(path: Path = REFERENCE) -> list[dict[str, Any]]:
    cal = EventCalendar.load(path)
    out: list[dict[str, Any]] = []
    for e in cal.events:
        out.append({
            "id": f"official:{e.id}", "source": OFFICIAL_LABEL, "ts": int(e.start.timestamp() * 1000), "date_ist": e.start.astimezone(IST).date().isoformat(),
            "all_day": e.end > e.start, "country": _country_of(e.name), "name": e.name, "impact": IMPACT.get(e.impact, "high"),
            "actual": None, "forecast": None, "previous": None,
            "note": e.source + ("" if e.time_verified else " · time is the usual release time, not confirmed on the page"),
        })  # fmt: skip
    return out


def parse_ff(data: bytes) -> list[dict[str, Any]]:
    """Events of one Forex Factory weekly feed. Holidays and Low-impact items are dropped; an item without a parseable time is skipped."""
    rows = json.loads(data)
    out: list[dict[str, Any]] = []
    for r in rows if isinstance(rows, list) else []:
        impact = str(r.get("impact", "")).strip().lower()
        if impact not in ("high", "medium"):
            continue
        try:
            when = datetime.fromisoformat(str(r["date"]))
        except (KeyError, ValueError):
            continue
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        title, cur = str(r.get("title", "")).strip(), str(r.get("country", "")).strip()
        if not title:
            continue
        ts = int(when.astimezone(UTC).timestamp() * 1000)
        out.append({
            "id": "ff:" + hashlib.sha1(f"{ts}|{cur}|{title}".encode()).hexdigest()[:16],  # noqa: S324 - an identifier, not security
            "source": FF_LABEL, "ts": ts, "date_ist": when.astimezone(IST).date().isoformat(), "all_day": False,
            "country": CURRENCY_COUNTRY.get(cur, cur), "name": title, "impact": IMPACT[impact],
            "actual": (str(r.get("actual")) or None) if r.get("actual") not in (None, "") else None,
            "forecast": str(r["forecast"]) if r.get("forecast") not in (None, "") else None,
            "previous": str(r["previous"]) if r.get("previous") not in (None, "") else None, "note": None,
        })  # fmt: skip
    return out
