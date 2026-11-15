"""Economic calendar sources.

1. The official calendar already in the project (``app/prediction/reference/events.json``: FOMC, RBI, US data releases, elections), every date from an official
   page named in its ``source``.
2. The Forex Factory public weekly JSON feed (this week and next): events of the major currencies with an impact of High, Medium or Low. It is an unofficial third-party
   feed, shown with its name and read at a low rate; High is the "three-star" level of the board.

3. An optional local file ``economic_calendar.json`` in the data directory (see ``parse_local``): the user's own export of the Moneycontrol calendar. Nothing here
   fetches it; if the file is absent the other two sources are used alone.

Moneycontrol's site is not read by this program: its site answers an honest client with 403 and redirects a server's address to a login page, and bot protection is not
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
LOCAL_LABEL = "Moneycontrol export (local file)"
LOCAL_NAME = "economic_calendar.json"
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


COUNTRY_ALIASES = {
    "IND": "India", "IN": "India", "INDIA": "India", "USA": "US", "US": "US", "UNITED STATES": "US", "EUR": "Euro area", "EU": "Euro area", "EURO AREA": "Euro area",
    "EUROZONE": "Euro area", "GBR": "UK", "UK": "UK", "UNITED KINGDOM": "UK", "JPN": "Japan", "CHN": "China", "CAN": "Canada", "AUS": "Australia",
}
_IMPACT_NUM = {"3": "high", "2": "medium", "1": "low", "high": "high", "medium": "medium", "low": "low"}


def parse_local(data: bytes) -> list[dict[str, Any]]:
    """Events of a local ``economic_calendar.json``: ``{"date": "YYYY-MM-DD", "events": [{"time_ist": "17:30", "country_name" or "country_code", "event", "impact": 1-3,
    "actual", "previous", "consensus"}]}``. An event's own ``date`` overrides the file's; times are IST. A value of "-" or an empty one is missing, never zero.
    An event with no usable date is skipped (a time of "-" or "All day" makes it an all-day event). Only High and Medium events are kept."""
    doc = json.loads(data)
    if not isinstance(doc, dict) or not isinstance(doc.get("events"), list):
        raise ValueError("expected an object with an events list")
    file_date = str(doc.get("date") or "")
    out: list[dict[str, Any]] = []
    for r in doc["events"]:
        if not isinstance(r, dict):
            continue
        impact = _IMPACT_NUM.get(str(r.get("impact", "")).strip().lower())
        name = str(r.get("event") or r.get("title") or "").strip()
        if impact not in ("high", "medium") or not name:
            continue
        day = str(r.get("date") or file_date)[:10]
        tstr = str(r.get("time_ist") or "").strip()
        all_day = tstr.lower() in ("", "-", "all day", "all-day", "tentative")
        try:
            hh, mm = (0, 0) if all_day else (int(tstr[:2]), int(tstr[3:5]))
            when = datetime.fromisoformat(day).replace(hour=hh, minute=mm, tzinfo=IST)
        except (ValueError, IndexError):
            continue
        code = str(r.get("country_name") or r.get("country_code") or "").strip()
        country = COUNTRY_ALIASES.get(code.upper(), code)

        def val(k: str, r: dict[str, Any] = r) -> str | None:
            v = str(r.get(k) if r.get(k) is not None else "").strip()
            return None if v in ("", "-", "--", "N/A") else v

        ts = int(when.astimezone(UTC).timestamp() * 1000)
        out.append({
            "id": "local:" + hashlib.sha1(f"{ts}|{country}|{name}".encode()).hexdigest()[:16],  # noqa: S324 - an identifier, not security
            "source": LOCAL_LABEL, "ts": ts, "date_ist": when.date().isoformat(), "all_day": all_day, "country": country, "name": name, "impact": impact,
            "actual": val("actual"), "forecast": val("consensus") or val("forecast"), "previous": val("previous"), "note": None,
        })  # fmt: skip
    return out


_STOP = {"the", "and", "yoy", "mom", "qoq", "y/y", "m/m", "q/q", "data", "index", "final", "prelim", "flash", "rate"}


def _words(name: str) -> set[str]:
    clean = name.lower().replace("(", " ").replace(")", " ").replace(".", " ")
    return {w for w in clean.split() if len(w) >= 3 and w not in _STOP}


def same_event(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Whether two rows of different sources are the same release: same country, times within 5 minutes and a shared keyword in the names."""
    if a["country"] != b["country"] or abs(a["ts"] - b["ts"]) > 5 * 60_000:
        return False
    return bool(_words(a["name"]) & _words(b["name"]))
