"""The NIFTY index futures a strategy can hold: which contract is "current", its live price and its expiry.

The current contract follows the monthly option expiry the app already resolves (it rolls to the next month by itself once the
month's last expiry has passed), so "current month, and the next one after expiry" needs no second rule. The next-month contract is
offered for rolling. A price that is missing or older than ``FRESH_S`` is reported as missing (never zero, never last-known).
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, datetime
from typing import Any

from app.market.futures import FRESH_S, FoQuote


def month_expiry(available: Iterable[date], year: int, month: int) -> date | None:
    """The monthly expiry of a calendar month: the last listed option expiry in it (None when none is listed)."""
    ds = [d for d in available if d.year == year and d.month == month]
    return max(ds) if ds else None


def _contract(
    role: str, symbol: str | None, token: str | None, expiry: date | None, q: FoQuote, now: datetime
) -> dict[str, Any]:
    fresh = q.fresh(now) and q.ltp is not None and q.ltp > 0
    return {
        "role": role,
        "symbol": symbol,
        "key": f"nse_fo|{token}" if token else None,
        "expiry": expiry.isoformat() if expiry else None,
        "ltp": q.ltp if fresh else None,
        "as_of": q.at.isoformat() if q.at else None,
        "fresh": bool(fresh),
        "note": None
        if fresh
        else ("no price yet" if q.at is None else f"last price is older than {int(FRESH_S)} s"),
    }


def future_contracts(
    *,
    monthly: date | None,
    available: Iterable[date],
    cur_symbol: str | None,
    cur_token: str | None,
    cur: FoQuote,
    next_symbol: str | None,
    next_token: str | None,
    nxt: FoQuote,
    now: datetime,
) -> dict[str, Any]:
    """Current and next-month contracts. The next month is the calendar month after the current contract's."""
    avail = list(available)
    nxt_expiry: date | None = None
    if monthly is not None:
        y, m = (monthly.year + 1, 1) if monthly.month == 12 else (monthly.year, monthly.month + 1)
        nxt_expiry = month_expiry(avail, y, m)
    return {
        "current": _contract("current", cur_symbol, cur_token, monthly, cur, now),
        "next": _contract("next", next_symbol, next_token, nxt_expiry, nxt, now),
    }
