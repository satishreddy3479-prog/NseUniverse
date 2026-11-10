# ruff: noqa: E501
"""US market (NYSE) trading days, so a US holiday is not mistaken for a late data feed.

The overnight inputs of the next-session forecast include US-dated series (S&P 500, VIX, 10-year yield, and the futures and currency series
that follow the US day). On a US holiday there is no bar dated that day, and a rule that demands "a bar on or after the reference day"
would call every such morning stale and refuse to record the forecast. The rule here asks for the latest US *trading* day instead.

Holidays are the NYSE's published full-day closures for 2026 and 2027 (Good Friday included; early closes are trading days). A date outside the
covered years is treated as a trading day on weekdays: the safe direction (it can only make a series look stale, never hide a stale one).
"""

from __future__ import annotations

from datetime import date, timedelta

NYSE_HOLIDAYS: frozenset[date] = frozenset(
    date.fromisoformat(d)
    for d in (
        # 2026
        "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
        # 2027
        "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
    )
)  # fmt: skip


def is_us_session(d: date) -> bool:
    return d.weekday() < 5 and d not in NYSE_HOLIDAYS


def last_us_session_on_or_before(d: date) -> date:
    while not is_us_session(d):
        d -= timedelta(days=1)
    return d
