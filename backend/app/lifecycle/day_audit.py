"""After-the-close consistency audit of one day's stored data (pure functions).

Cross-checks two independent records of the same thing. The stored index level of the chain captures (``spot``, one a minute) must lie inside the live index feed's one-minute bar
for that minute, give or take ``RANGE_MARGIN`` points. On 19 Nov 2026 the chain's own spot-replacement check put the stored level 10 to 66 points below the live bars for the first 33
minutes (the opening strike became 25150 instead of 25200) and nothing noticed for hours. The check is not applied in the closing auction (the index is silent or indicative then) and
skips bars made from fewer than ``THIN_READS`` reads. Findings are warnings for the owner to read; nothing is repaired or deleted.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.domain.session import closing_schedule

IST = ZoneInfo("Asia/Kolkata")
RANGE_MARGIN = 15.0  # points beyond the minute's low or high
MIN_MINUTES = 3  # outside-range minutes that make a finding
THIN_READS = 10


def minute_key(at: datetime) -> str:
    return at.replace(second=0, microsecond=0).isoformat()


def spot_vs_index_bars(day: date, spots: Sequence[tuple[datetime, float]], bars: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """Stored spot per capture against the live index bar of the same minute. ``bars`` maps ``minute_key(UTC minute start)`` to {l, h, n}."""
    sch = closing_schedule(day)
    checked = 0
    outside: list[dict[str, Any]] = []
    for at, spot in spots:
        t = at.astimezone(IST)
        if sch.cash_end <= t.time() < sch.index_end:
            continue  # the closing auction: the index is silent or indicative
        bar = bars.get(minute_key(at))
        if bar is None or not isinstance(bar.get("l"), (int, float)) or not isinstance(bar.get("h"), (int, float)):
            continue
        n = bar.get("n")
        if isinstance(n, int) and n < THIN_READS:
            continue
        checked += 1
        lo, hi = float(bar["l"]), float(bar["h"])
        off = spot - hi if spot > hi + RANGE_MARGIN else spot - lo if spot < lo - RANGE_MARGIN else 0.0
        if off:
            outside.append({"at": t.strftime("%H:%M"), "spot": round(spot, 2), "bar_low": lo, "bar_high": hi, "off": round(off, 1)})
    worst = max(outside, key=lambda r: abs(r["off"])) if outside else None
    return {"checked": checked, "outside": len(outside), "worst": worst, "first_at": outside[0]["at"] if outside else None, "margin": RANGE_MARGIN}


def audit_day(day: date, spots: Sequence[tuple[datetime, float]], bars: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """The findings for one day: [] means every check that could be made passed."""
    sv = spot_vs_index_bars(day, spots, bars)
    findings: list[dict[str, str]] = []
    if sv["checked"] == 0:
        findings.append({"id": "no_index_bars", "level": "info", "text": "No live index bars were stored for this day (or none overlap the chain captures), so the stored spot could not be cross-checked."})
    elif sv["outside"] >= MIN_MINUTES:
        w = sv["worst"]
        findings.append({"id": "spot_vs_index", "level": "warning",
                         "text": f"The stored index level of the chain captures was more than {RANGE_MARGIN:g} points outside the live index bar in {sv['outside']} of {sv['checked']} minutes (first at {sv['first_at']}); "
                                 f"worst {w['off']:+.1f} at {w['at']} (stored {w['spot']:,.2f}, index bar {w['bar_low']:,.2f}-{w['bar_high']:,.2f}). The ATM strike, the opening strike and the stored spot of those minutes may be wrong."})  # fmt: skip
    return {"day": day.isoformat(), "findings": findings, "spot_vs_index": sv}


def audit_alerts(manifest: Callable[[date], dict[str, Any] | None], now: datetime, days: int = 3) -> list[dict[str, str]]:
    """Alert-list entries (key, level, text) for the warnings the audits of the last ``days`` days stored in their manifests."""
    today = now.astimezone(IST).date()
    out: list[dict[str, str]] = []
    for back in range(days):
        day = today - timedelta(days=back)
        for f in ((manifest(day) or {}).get("audit") or {}).get("findings", []):
            if f.get("level") == "warning":
                out.append({"key": f"audit-{day.isoformat()}-{f.get('id')}", "level": "warning", "text": f"After-close audit of {day.isoformat()}: {f.get('text')}"})
    return out
