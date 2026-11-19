"""Check of the index level in a chain snapshot against the option prices in the same snapshot.

The broker's index quote can freeze (17 Nov 2026: 25,413 repeated from 15:15 to 15:27 while
put-call parity put the index near 25,455). Every ATM choice downstream (the ATM strike of the
stored observations, the strike window, the OI and price boards) starts from ``underlying_ltp``,
so a frozen quote moved them all. Put-call parity gives an independent reading from the same
capture: for a strike K, F = K + call - put, and the index is F discounted by e^(-rT). The median
over the strikes nearest the quote is used.

Only near expiries are checked (up to 8 days): further out the dividends missing from the model
move the forward by more than the allowance. The parity level replaces the quote only when the quote
is FROZEN (the same value in three captures at least 90 seconds apart, the caller decides) and the
two readings differ by more than ``TOLERANCE`` points; the broker's own value is kept in
``underlying_ltp_broker`` and ``spot_note`` says so. The raw payload on disk is not touched.

A quote that keeps moving is not replaced: on 19 Nov 2026 the options' forward sat 10 to 66
points below the live index for the first 33 minutes (09:15-09:47 IST), the broker's quote followed
the live index within about 25 points, and replacing it 32 times put the opening strike on 25,150
instead of 25,200.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Sequence
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from app.domain.models import OptionChainRow

IST = ZoneInfo("Asia/Kolkata")
TOLERANCE = 30.0  # points: broker index level against the level the options imply
MAX_DAYS = 8.0
RATE = 0.06  # the app's assumed annual rate (Settings.risk_free_rate default)
STRIKES = 5  # nearest strikes with both prices
MIN_STRIKES = 3
EXPIRY_CLOSE = time(15, 30)


def parity_spot(
    rows: Sequence[OptionChainRow], spot: float, expiry: date, at: datetime
) -> float | None:
    """Index level implied by put-call parity near ``spot``; None if it cannot be formed."""
    end = datetime.combine(expiry, EXPIRY_CLOSE, IST)
    t_days = (end - at.astimezone(IST)).total_seconds() / 86400
    if t_days <= 0 or t_days > MAX_DAYS:
        return None
    both = [
        (r.strike, r.call.ltp, r.put.ltp)
        for r in sorted(rows, key=lambda r: abs(r.strike - spot))
        if r.call is not None
        and r.put is not None
        and r.call.ltp is not None
        and r.put.ltp is not None
        and r.call.ltp > 0
        and r.put.ltp > 0
    ][:STRIKES]
    if len(both) < MIN_STRIKES:
        return None
    grow = math.exp(RATE * t_days / 365)
    return statistics.median(k + c - p for k, c, p in both) / grow


def checked_spot(
    rows: Sequence[OptionChainRow],
    spot: float | None,
    expiry: date,
    at: datetime,
    frozen: bool = False,
) -> tuple[float | None, float | None, str | None]:
    """(level to use, the broker's level if it was replaced, a note if it was).

    A quote that is not ``frozen`` is always used as sent."""
    if spot is None or spot <= 0 or not frozen:
        return spot, None, None
    implied = parity_spot(rows, spot, expiry, at)
    if implied is None or abs(implied - spot) <= TOLERANCE:
        return spot, None, None
    side = "below" if implied > spot else "above"
    note = (
        f"The broker's index level {spot:g} has not moved for several captures and is "
        f"{abs(implied - spot):.0f} points {side} "
        "the level the "
        f"option prices imply ({implied:.0f}): the option-implied level is used for the ATM strike."
    )
    return round(implied, 2), spot, note

