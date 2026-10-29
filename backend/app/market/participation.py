"""Participation measures for the NIFTY 50 constituents (pure functions).

* Above day VWAP: the last price against the exchange's average traded price for each stock (its day VWAP).
* Opening range per stock: high/low of the stock's sampled change from the previous close over the first
  ``or_minutes`` of the session; a stock is above its range when its current change exceeds that high.
* Breadth momentum: change of the advance/decline balance (advancing - declining) / (advancing + declining) over a window.
* Divergence: the index and breadth moving in opposite directions over the same window. A description to check
  against price, not a trading rule.
Counts are over stocks with data; stocks without data are counted as missing, never as above or below.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

PRICE_MOVE_PCT = 0.15  # an index move smaller than this is not a move
BALANCE_MOVE = 0.10  # a breadth-balance change smaller than this is not a change


def above_vwap(pairs: Mapping[str, tuple[float | None, float | None]]) -> dict[str, Any]:
    above = below = at = missing = 0
    for ltp, atp in pairs.values():
        if ltp is None or atp is None or atp <= 0 or ltp <= 0:
            missing += 1
        elif ltp > atp:
            above += 1
        elif ltp < atp:
            below += 1
        else:
            at += 1
    covered = above + below + at
    return {
        "above": above,
        "below": below,
        "at": at,
        "covered": covered,
        "missing": missing,
        "pct_above": None if covered == 0 else round(above / covered * 100, 1),
    }


def opening_range_status(
    or_changes: Mapping[str, Sequence[float]],
    current: Mapping[str, float | None],
    min_samples: int = 5,
) -> dict[str, Any]:
    above = below = inside = missing = 0
    for sym, vals in or_changes.items():
        now = current.get(sym)
        if now is None or len(vals) < min_samples:
            missing += 1
        elif now > max(vals):
            above += 1
        elif now < min(vals):
            below += 1
        else:
            inside += 1
    covered = above + below + inside
    return {"above_high": above, "below_low": below, "inside": inside, "covered": covered, "missing": missing,
            "pct_above_high": None if covered == 0 else round(above / covered * 100, 1), "pct_below_low": None if covered == 0 else round(below / covered * 100, 1)}  # fmt: skip


def balance(advancing: int | None, declining: int | None) -> float | None:
    if advancing is None or declining is None or advancing + declining == 0:
        return None
    return (advancing - declining) / (advancing + declining)


def momentum_and_divergence(
    bal_now: float | None,
    bal_then: float | None,
    idx_now: float | None,
    idx_then: float | None,
    window_min: int = 15,
) -> dict[str, Any]:
    """idx_* are the index change from the previous close (%) at the two times."""
    mom = None if bal_now is None or bal_then is None else round(bal_now - bal_then, 3)
    idx_move = None if idx_now is None or idx_then is None else round(idx_now - idx_then, 3)
    state = "unknown"
    if mom is not None and idx_move is not None:
        if idx_move >= PRICE_MOVE_PCT and mom <= -BALANCE_MOVE:
            state = "bearish_divergence"  # index rising while fewer stocks take part
        elif idx_move <= -PRICE_MOVE_PCT and mom >= BALANCE_MOVE:
            state = "bullish_divergence"  # index falling while more stocks recover
        elif abs(idx_move) < PRICE_MOVE_PCT:
            state = "no_clear_index_move"
        else:
            state = "confirmed"
    return {
        "window_minutes": window_min,
        "breadth_momentum": mom,
        "index_move_pct": idx_move,
        "state": state,
    }
