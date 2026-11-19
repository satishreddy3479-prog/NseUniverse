"""Overnight context and the event calendar, as point-in-time features of a trading day (pure functions, no I/O).

What was known before the session and what the calendar says is coming:
  gift_move_pct      GIFT Nifty's move between the previous NIFTY close (15:30 IST) and the pre-open (09:14 IST): the market's own forecast of the gap, free of the futures' basis;
  es_move_pct, nq_move_pct, brent_move_pct, dxy_move_pct, usdinr_move_pct   the same for the S&P 500 and Nasdaq futures, Brent, the dollar index and the rupee;
  gap_surprise_pts   the opening gap that GIFT Nifty did NOT foresee: actual gap minus (GIFT move x previous close);
  events_overnight   high-importance calendar events between the previous NIFTY close and the open (a US release or a central bank at night);
  events_hold        high-importance events between the entry and the exit minute (Europe's data at midday, a policy decision, India's own releases).
An input that is missing stays None, never zero. The calendar is published in advance, so an event feature is known at the entry minute; a market move is read at 09:14 and used from then on.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
CONTEXT_SYMBOLS = ("GIFT", "ES", "NQ", "BRENT", "DXY", "USDINR")
NIFTY_CLOSE = time(15, 30)  # the cash index close of a normal day (the closing auction, 15:15-15:35 until 4 Dec 2026, leaves the F&O market trading to 15:40)
PRE_OPEN = time(9, 14)
MAX_AGE_MS = 30 * 60_000  # a bar older than this at the target time is not used (a closed market has no price to compare)
MAX_EVENT_NAMES = 4


def prev_weekday(day: date) -> date:
    """The previous weekday (holidays are not known here: after a holiday the move is measured from the last weekday's close, which is the last time the market was open only if it was)."""
    d = day - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def ist_ms(day: date, t: time) -> int:
    return int(datetime.combine(day, t, IST).timestamp() * 1000)


def price_at(series: Sequence[tuple[int, float]], target_ms: int, max_age_ms: int = MAX_AGE_MS) -> float | None:
    """The last price at or before ``target_ms``, if it is no older than ``max_age_ms``. ``series`` is (ms, price), oldest first."""
    best: tuple[int, float] | None = None
    for ts, p in series:
        if ts > target_ms:
            break
        best = (ts, p)
    return best[1] if best is not None and target_ms - best[0] <= max_age_ms and best[1] > 0 else None


def compute_context(series_by_symbol: Mapping[str, Sequence[tuple[int, float]]], day: date) -> dict[str, Any]:
    """The overnight moves of ``day``: for each symbol, its price at the previous NIFTY close and at the pre-open and the percent move; only symbols with both prices appear."""
    prev = prev_weekday(day)
    t0, t1 = ist_ms(prev, NIFTY_CLOSE), ist_ms(day, PRE_OPEN)
    moves: dict[str, Any] = {}
    for sym in CONTEXT_SYMBOLS:
        s = series_by_symbol.get(sym) or []
        p0, p1 = price_at(s, t0), price_at(s, t1)
        if p0 is not None and p1 is not None:
            moves[sym] = {"close": round(p0, 4), "pre_open": round(p1, 4), "pct": round((p1 / p0 - 1) * 100, 3)}
    return {"day": day.isoformat(), "prev_day": prev.isoformat(), "moves": moves}


def event_window(events: Sequence[Mapping[str, Any]], start_ms: int, end_ms: int) -> list[Mapping[str, Any]]:
    """High-importance events with a set clock time in (start, end]."""
    return sorted((e for e in events if e.get("impact") == "high" and not e.get("all_day") and start_ms < int(e["ts"]) <= end_ms), key=lambda e: int(e["ts"]))


def _names(evs: Sequence[Mapping[str, Any]]) -> list[str]:
    return [f"{e.get('country')}: {e.get('name')}" for e in evs[:MAX_EVENT_NAMES]]


def features(day: date, context: Mapping[str, Any] | None, events: Sequence[Mapping[str, Any]] | None, events_known: bool, entry: time, exit_: time,
             actual_gap_pts: float | None, prev_close: float | None) -> dict[str, Any]:  # fmt: skip
    """The context and event features of one day for a rule entering at ``entry`` and leaving at ``exit_`` (IST). Anything that cannot be formed is None."""
    out: dict[str, Any] = {"gift_move_pct": None, "es_move_pct": None, "nq_move_pct": None, "brent_move_pct": None, "dxy_move_pct": None, "usdinr_move_pct": None, "gap_surprise_pts": None,
                           "events_overnight": None, "events_hold": None, "events_overnight_names": [], "events_hold_names": []}  # fmt: skip
    moves = (context or {}).get("moves") or {}
    for sym, key in (("GIFT", "gift_move_pct"), ("ES", "es_move_pct"), ("NQ", "nq_move_pct"), ("BRENT", "brent_move_pct"), ("DXY", "dxy_move_pct"), ("USDINR", "usdinr_move_pct")):
        m = moves.get(sym)
        if m is not None:
            out[key] = m["pct"]
    if out["gift_move_pct"] is not None and actual_gap_pts is not None and prev_close:
        out["gap_surprise_pts"] = round(actual_gap_pts - out["gift_move_pct"] / 100 * prev_close, 2)
    if events_known and events is not None:
        prev = prev_weekday(day)
        overnight = event_window(events, ist_ms(prev, NIFTY_CLOSE), ist_ms(day, time(9, 15)))
        hold = event_window(events, ist_ms(day, entry) - 1, ist_ms(day, exit_))
        out["events_overnight"], out["events_hold"] = len(overnight), len(hold)
        out["events_overnight_names"], out["events_hold_names"] = _names(overnight), _names(hold)
    return out
