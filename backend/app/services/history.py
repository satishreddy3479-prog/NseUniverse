"""Observations derived from stored snapshots (real captures only; nothing is interpolated).

One observation per stored, non-empty snapshot of an expiry. The "strike universe" of an observation
is the ATM strike of that snapshot plus ``each_side`` listed strikes on both sides.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel

from app.domain.models import OptionChainSnapshot
from app.storage.store import SnapshotStore

DEFINITIONS = {
    "atm_strike": (
        "Strike carrying the broker's ATM label; if absent, the listed strike nearest the "
        "underlying price at capture."
    ),
    "universe": (
        "ATM strike of the newest stored snapshot plus N listed strikes either side "
        "(N = strikes_each_side). Every observation sums these same strikes, so totals compare."
    ),
    "total_ce_premium": (
        "Sum of last traded price (INR per unit) over call contracts in the universe; contracts "
        "without an LTP are left out and counted in missing_ltp."
    ),
    "total_pe_premium": "Same as total_ce_premium for puts.",
    "straddle": "ATM call LTP + ATM put LTP; unavailable if either is missing.",
    "total_ce_oi": "Sum of open interest (units) over calls in the universe; missing skipped.",
    "total_pe_oi": "Same for puts.",
}


class Observation(BaseModel):
    snapshot_id: str
    retrieved_at: datetime
    session_id: str
    underlying_ltp: float | None
    underlying_prev_close: float | None
    atm_strike: float | None
    atm_call_ltp: float | None
    atm_put_ltp: float | None
    straddle: float | None
    total_ce_premium: float | None
    total_pe_premium: float | None
    total_ce_oi: float | None
    total_pe_oi: float | None
    total_ce_volume: float | None
    total_pe_volume: float | None
    strikes_in_universe: int
    missing_ltp: int
    same_as_previous: bool = False


class HistoryResponse(BaseModel):
    underlying: str
    expiry: str
    strikes_each_side: int
    observations: list[Observation]
    distinct_observations: int
    definitions: dict[str, str]
    note: str


def _sum(values: list[float | None]) -> float | None:
    present = [v for v in values if v is not None]
    return sum(present) if present else None


def _universe(snap: OptionChainSnapshot, each_side: int) -> tuple[list[Any], Any]:
    """ATM +/- each_side rows of one snapshot and its ATM row (all rows when there is no ATM)."""
    rows = snap.rows
    atm_idx = next(
        (
            i
            for i, r in enumerate(rows)
            if "ATM" in {r.call.moneyness if r.call else None, r.put.moneyness if r.put else None}
        ),
        None,
    )
    if atm_idx is None and rows and snap.underlying_ltp is not None:
        atm_idx = min(range(len(rows)), key=lambda i: abs(rows[i].strike - snap.underlying_ltp))  # type: ignore[operator]
    if atm_idx is None:
        return list(rows), None
    return rows[max(0, atm_idx - each_side) : atm_idx + each_side + 1], rows[atm_idx]


def observe(
    snap: OptionChainSnapshot, each_side: int, fixed: frozenset[float] | None = None
) -> Observation:
    """One observation. ``fixed`` = the strikes to sum; without it the universe re-centres on this
    snapshot's ATM, so totals from different snapshots would cover different strikes."""
    rows = snap.rows
    uni, atm_row = _universe(snap, each_side)
    if fixed is not None:
        uni = [r for r in rows if r.strike in fixed]
    ce = [r.call for r in uni if r.call]
    pe = [r.put for r in uni if r.put]
    call_ltp = atm_row.call.ltp if atm_row and atm_row.call else None
    put_ltp = atm_row.put.ltp if atm_row and atm_row.put else None
    return Observation(
        snapshot_id=snap.snapshot_id,
        retrieved_at=snap.retrieved_at,
        session_id=snap.session_id,
        underlying_ltp=snap.underlying_ltp,
        underlying_prev_close=snap.underlying_prev_close,
        atm_strike=atm_row.strike if atm_row else None,
        atm_call_ltp=call_ltp,
        atm_put_ltp=put_ltp,
        straddle=call_ltp + put_ltp if call_ltp is not None and put_ltp is not None else None,
        total_ce_premium=_sum([q.ltp for q in ce]),
        total_pe_premium=_sum([q.ltp for q in pe]),
        total_ce_oi=_sum([q.oi for q in ce]),
        total_pe_oi=_sum([q.oi for q in pe]),
        total_ce_volume=_sum([q.volume for q in ce]),
        total_pe_volume=_sum([q.volume for q in pe]),
        strikes_in_universe=len(uni),
        missing_ltp=sum(1 for q in ce + pe if q.ltp is None),
    )


_COMPARE = (
    "underlying_ltp", "atm_strike", "atm_call_ltp", "atm_put_ltp", "total_ce_premium",
    "total_pe_premium", "total_ce_oi", "total_pe_oi", "total_ce_volume", "total_pe_volume",
)  # fmt: skip


# A stored snapshot is immutable, so its observation is computed once (a day holds hundreds).
_CACHE: dict[tuple[str, int, frozenset[float] | None], Observation] = {}
_CACHE_MAX = 20000


def _fixed_strikes(
    store: SnapshotStore, items: list[Any], each_side: int
) -> frozenset[float] | None:
    """ATM +/- each_side strikes of the newest snapshot, summed by every observation."""
    if not items:
        return None
    newest = store.load(items[-1].snapshot_id)
    if newest is None:
        return None
    return frozenset(r.strike for r in _universe(newest, each_side)[0])


def build_history(
    store: SnapshotStore, underlying: str, expiry: str, each_side: int, limit: int
) -> HistoryResponse:
    items = [
        s
        for s in store.list(underlying=underlying, expiry=expiry, limit=limit)
        if s.completeness.value != "empty"
    ]
    items.sort(key=lambda s: s.retrieved_at)  # list() is newest-first
    fixed = _fixed_strikes(store, items, each_side)
    obs: list[Observation] = []
    for s in items:
        key = (s.snapshot_id, each_side, fixed)
        cached = _CACHE.get(key)
        if cached is None:
            snap = store.load(s.snapshot_id)
            if snap is None:
                continue
            cached = observe(snap, each_side, fixed)
            if len(_CACHE) >= _CACHE_MAX:
                _CACHE.clear()
            _CACHE[key] = cached
        o = cached.model_copy()  # only same_as_previous depends on the neighbouring snapshot
        if obs and all(getattr(o, f) == getattr(obs[-1], f) for f in _COMPARE):
            o.same_as_previous = True
        obs.append(o)
    distinct = sum(1 for o in obs if not o.same_as_previous)
    note = (
        "Each point is a stored snapshot (a real Kotak response at that moment), not an intraday "
        "candle. Values captured while the market is closed repeat the last session and are "
        "flagged same_as_previous."
    )
    return HistoryResponse(
        underlying=underlying,
        expiry=expiry,
        strikes_each_side=each_side,
        observations=obs,
        distinct_observations=distinct,
        definitions=DEFINITIONS,
        note=note,
    )
