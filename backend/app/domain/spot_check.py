"""Check of the index level in a chain snapshot against the option prices in the same snapshot.

The broker's index quote can freeze (17 Nov 2026: 25,413 repeated from 15:15 to 15:27 while
put-call parity put the index near 25,455). Every ATM choice downstream (the ATM strike of the
stored observations, the strike window, the OI and price boards) starts from ``underlying_ltp``,
so a frozen quote moved them all. Put-call parity gives an independent reading from the same
capture: for a strike K, F = K + call - put, and the index is F discounted by e^(-rT). The median
over the strikes nearest the quote is used.

Only near expiries are checked (up to 8 days): further out the dividends missing from the model
move the forward by more than the allowance. When the two readings differ by more than
``TOLERANCE`` points the parity level replaces the quote, the broker's own value is kept in
``underlying_ltp_broker`` and ``spot_note`` says so. The raw payload on disk is not touched.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Sequence
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from app.domain.models import OptionChainRow

IST = ZoneInfo("Asia/Kolkata")
TOLERANCE = 15.0  # points: broker index level against the level the options imply (parity noise is a few points)
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
    rows: Sequence[OptionChainRow], spot: float | None, expiry: date, at: datetime
) -> tuple[float | None, float | None, str | None]:
    """(level to use, the broker's level if it was replaced, a note if it was)."""
    if spot is None or spot <= 0:
        return spot, None, None
    implied = parity_spot(rows, spot, expiry, at)
    if implied is None or abs(implied - spot) <= TOLERANCE:
        return spot, None, None
    side = "below" if implied > spot else "above"
    note = (
        f"The broker's index level {spot:g} is {abs(implied - spot):.0f} points {side} "
        "the level the "
        f"option prices imply ({implied:.0f}): the option-implied level is used for the ATM strike."
    )
    return round(implied, 2), spot, note

