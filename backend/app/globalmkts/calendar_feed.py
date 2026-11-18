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
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from app.prediction.events import REFERENCE, EventCalendar

IST = ZoneInfo("Asia/Kolkata")
FF_URLS = ["https://nfs.faireconomy.media/ff_calendar_thisweek.json", "https://nfs.faireconomy.media/ff_calendar_nextweek.json"]
BQ_LABEL = "biquote / MQL5 (third-party feed)"
BQ_URL = "https://biquote.io/api/calendar"
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


_SAME_WORD = {"inflation": "cpi"}  # the sources name one release differently: Forex Factory "CPI y/y", biquote "Inflation Rate YoY"
_STOP = {"the", "and", "yoy", "mom", "qoq", "y/y", "m/m", "q/q", "data", "index", "final", "prelim", "flash", "rate"}


def _words(name: str) -> set[str]:
    clean = name.lower().replace("(", " ").replace(")", " ").replace(".", " ")
    return {_SAME_WORD.get(w, w) for w in clean.split() if len(w) >= 3 and w not in _STOP}


def same_event(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Whether two rows of different sources are the same release: same country, times within 5 minutes and a shared keyword in the names."""
    if a["country"] != b["country"] or abs(a["ts"] - b["ts"]) > 5 * 60_000:
        return False
    return bool(_words(a["name"]) & _words(b["name"]))


BQ_COUNTRIES = {"IN": "India", "US": "US", "GB": "UK", "EU": "Euro area", "JP": "Japan", "CN": "China", "AU": "Australia", "CA": "Canada", "CH": "Switzerland", "NZ": "New Zealand"}
BQ_HOME = ("IN", "US")  # asked for at medium importance and up (India's two-star releases are shown); the other countries only at high importance
_BQ_SCALE = {"thousands": "K", "millions": "M", "billions": "B", "trillions": "T"}


def bq_url(now: datetime) -> str:
    """The biquote request: India and the US, medium importance and above (the API's importance is a minimum), from two days ago (IST, so the outcomes of the last two days keep
    being refreshed and a late actual is still caught) to 60 days ahead."""
    start, end = now.astimezone(IST).date() - timedelta(days=2), (now + timedelta(days=60)).date()
    return f"{BQ_URL}?from={start}&to={end}&countries=IN,US&importance=medium&limit=500"


def bq_url_world(now: datetime) -> str:
    """The same request for the other countries the page shows (UK, Euro area, Japan, China, ...), at high importance only and 30 days ahead: Forex Factory lists them but its public
    feed carries no actual values, so a release like the UK CPI never got its outcome (18 Nov 2026)."""
    start, end = now.astimezone(IST).date() - timedelta(days=2), (now + timedelta(days=30)).date()
    others = ",".join(c for c in BQ_COUNTRIES if c not in BQ_HOME)
    return f"{BQ_URL}?from={start}&to={end}&countries={others}&importance=high&limit=500"


def _bq_value(v: Any, e: dict[str, Any]) -> str | None:
    """A reading as text with its unit: null stays missing (not zero); percent gets %, thousands and millions their K / M."""
    if v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    digits = e.get("digits") if isinstance(e.get("digits"), int) and 0 <= e["digits"] <= 6 else 2
    text = f"{x:.{digits}f}"
    if e.get("unit") == "percent":
        return text + "%"
    return text + _BQ_SCALE.get(str(e.get("multiplier") or "").lower(), "") if e.get("multiplier") not in (None, "none") else text


def parse_biquote(data: bytes) -> list[dict[str, Any]]:
    """Events of one biquote calendar response (a bare JSON array of MQL5 calendar rows). Holidays and low-importance rows are dropped; a row without a parseable UTC time is
    skipped. When the clock is only a placeholder (timeMode other than exact) the event is shown as all-day, never at a made-up time."""
    rows = json.loads(data)
    out: list[dict[str, Any]] = []
    for e in rows if isinstance(rows, list) else []:
        impact = str(e.get("importance", "")).lower()
        if impact not in ("high", "medium") or e.get("type") == "holiday" or not e.get("name") or e.get("countryCode") not in BQ_COUNTRIES:
            continue
        try:
            when = datetime.fromisoformat(str(e["time"]).replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        exact = e.get("timeMode", "exact") == "exact"
        ts = int(when.astimezone(UTC).timestamp() * 1000)
        out.append({
            "id": "bq:" + str(e.get("id") or hashlib.sha1(f"{ts}|{e['countryCode']}|{e['name']}".encode()).hexdigest()[:16]),  # noqa: S324 - an identifier, not security
            "source": BQ_LABEL, "ts": ts, "date_ist": when.astimezone(IST).date().isoformat(), "all_day": not exact, "country": BQ_COUNTRIES[e["countryCode"]], "name": str(e["name"]).strip(),
            "impact": impact, "actual": _bq_value(e.get("actual"), e), "forecast": _bq_value(e.get("forecast"), e), "previous": _bq_value(e.get("previous"), e),
            "note": None if exact else "time not set by the source",
        })  # fmt: skip
    return out


# ------------------------------------------------------------------ the surprise: how the actual came out against the forecast
HIGHER_IS_HOT = ("cpi", "wpi", "ppi", "pce", "inflation", "import price", "price index", "deflator")  # a higher reading than forecast is hot (hawkish), a lower one cooling
LOWER_IS_BETTER = ("unemployment", "jobless", "claims", "deficit")  # a higher reading than forecast is worse
NO_VERDICT = ("interest rate", "rate decision", "repo", "fed funds", "minutes", "speech", "speaks", "testifies", "press conference", "auction", "holiday")  # above or below, but not good or bad
_SCALE = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}


def reading_value(text: str | None) -> tuple[float, str, str] | None:
    """(number in plain units, its unit, its scale letter) of a reading such as "5.4%", "-1.2M" or "223K"; None when it is missing or not a number. The unit keeps a % apart from a count."""
    if text is None:
        return None
    t = text.strip().replace(",", "")
    if not t:
        return None
    unit = "%" if t.endswith("%") else ""
    t = t.rstrip("%")
    mult, scale = 1.0, ""
    if t and t[-1].upper() in _SCALE:
        scale = t[-1].upper()
        mult, t = _SCALE[scale], t[:-1]
    try:
        return float(t) * mult, unit, scale
    except ValueError:
        return None


def surprise(name: str, actual: str | None, forecast: str | None) -> dict[str, Any] | None:
    """The outcome of a release against its forecast, or None when it has none yet or the two readings cannot be compared (a missing one, or a % against a count).

    status: BEAT or MISS (higher is better), HOT or COOLING (inflation: higher is hot), INLINE, and for releases that are neither good nor bad (a rate decision, a speech) ABOVE or BELOW.
    ``diff`` is actual minus forecast in the units of the reading, ``tone`` is up (green), down (red) or flat for the page. A plain comparison of the two numbers: it says how far the
    release was from what was expected, not what it does to the market."""
    a, f = reading_value(actual), reading_value(forecast)
    if a is None or f is None or a[1] != f[1]:
        return None
    diff = a[0] - f[0]
    shown = diff / _SCALE.get(f[2], 1.0)  # in the unit the forecast is written in: 0.3%, 20K, -0.4M
    text = f"{shown:+.2f}".rstrip("0").rstrip(".") + (f[2] or "") + f[1] if abs(diff) >= 1e-9 * max(1.0, abs(f[0])) else "0"
    if abs(diff) < 1e-9 * max(1.0, abs(f[0])):
        return {"status": "INLINE", "label": "In line", "tone": "flat", "diff": 0.0, "diff_text": "0"}
    n = name.lower()
    up = diff > 0
    if any(k in n for k in NO_VERDICT):
        return {"status": "ABOVE" if up else "BELOW", "label": "Above forecast" if up else "Below forecast", "tone": "flat", "diff": diff, "diff_text": text}
    if any(k in n for k in HIGHER_IS_HOT):
        return {"status": "HOT" if up else "COOLING", "label": "Hot" if up else "Cooling", "tone": "down" if up else "up", "diff": diff, "diff_text": text}
    if any(k in n for k in LOWER_IS_BETTER):
        return {"status": "MISS" if up else "BEAT", "label": "Miss" if up else "Beat", "tone": "down" if up else "up", "diff": diff, "diff_text": text}
    return {"status": "BEAT" if up else "MISS", "label": "Beat" if up else "Miss", "tone": "up" if up else "down", "diff": diff, "diff_text": text}

