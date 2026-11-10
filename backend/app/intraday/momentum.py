"""Call-versus-put implied-volatility momentum, from the delta-matched IVs of stored chain snapshots of one expiry.

Pure functions (no I/O): the service feeds them the per-snapshot points. Definitions (registry ids ``iv_momentum``):

    CE IV change = CE IV now - CE IV then        PE IV change = PE IV now - PE IV then
    IV momentum  = CE IV change - PE IV change   (IV points; positive: call IV rose more / fell less than put IV)

"then" is the stored snapshot nearest to (now - N minutes) inside a stated tolerance, never an interpolated or carried value.
A missing IV on either end leaves that change missing; nothing is filled with zero.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any

BUCKETS = ("atm", "d25", "d10")
PERIODS_MIN = (1, 5, 15, 30, 60)


def delta_point(at: datetime, spot: float | None, surface: dict[str, Any]) -> dict[str, Any]:
    """One snapshot's CE/PE IV at ATM, 25 delta and 10 delta (percent), taken from a solved surface (``volatility.surface``)."""
    from app.intraday.volatility import (
        iv_at_delta,  # local import: volatility pulls in the heavier model code
    )

    ok = surface.get("status") == "ok"
    rows = surface.get("rows", []) if ok else []
    return {
        "at": at, "spot": spot,
        "atm": {"ce": surface.get("atm_call_iv") if ok else None, "pe": surface.get("atm_put_iv") if ok else None},
        "d25": {"ce": iv_at_delta(rows, "CE", 0.25), "pe": iv_at_delta(rows, "PE", 0.25)},
        "d10": {"ce": iv_at_delta(rows, "CE", 0.10), "pe": iv_at_delta(rows, "PE", 0.10)},
    }


def _diff(a: float | None, b: float | None) -> float | None:
    return None if a is None or b is None else round(a - b, 4)


def nearest_before(points: Sequence[dict[str, Any]], target: datetime, tolerance: timedelta) -> dict[str, Any] | None:
    """The snapshot closest to ``target`` among those not later than ``target``, if within ``tolerance`` of it."""
    best = None
    for p in points:
        if p["at"] <= target and (best is None or p["at"] > best["at"]):
            best = p
    return best if best is not None and target - best["at"] <= tolerance else None


def compare(now: dict[str, Any], then: dict[str, Any] | None) -> dict[str, Any]:
    """The change table between two snapshots, for ATM, 25 delta and 10 delta."""
    out: dict[str, Any] = {
        "from": None if then is None else then["at"].isoformat(),
        "spot_change": None if then is None else _diff(now["spot"], then["spot"]),
        "spot_change_pct": None if then is None or not then["spot"] or now["spot"] is None else round((now["spot"] / then["spot"] - 1) * 100, 4),
    }
    for b in BUCKETS:
        ce_now, pe_now = now[b]["ce"], now[b]["pe"]
        ce_then = None if then is None else then[b]["ce"]
        pe_then = None if then is None else then[b]["pe"]
        ce_chg, pe_chg = _diff(ce_now, ce_then), _diff(pe_now, pe_then)
        out[b] = {
            "ce_now": ce_now, "ce_then": ce_then, "ce_change": ce_chg,
            "pe_now": pe_now, "pe_then": pe_then, "pe_change": pe_chg,
            "momentum": _diff(ce_chg, pe_chg),
        }
    return out


def momentum_table(
    points: Sequence[dict[str, Any]], prev_close: dict[str, Any] | None, periods: Sequence[int] = PERIODS_MIN
) -> dict[str, Any]:
    """Momentum against each look-back period and the previous session's close, measured from the newest snapshot."""
    if not points:
        return {"now": None, "periods": {}, "previous_close": None}
    now = points[-1]
    table: dict[str, Any] = {}
    for n in periods:
        tol = timedelta(minutes=2 if n <= 5 else 5)
        then = nearest_before(points[:-1], now["at"] - timedelta(minutes=n), tol)
        table[str(n)] = compare(now, then)
    return {"now": now["at"].isoformat(), "periods": table, "previous_close": compare(now, prev_close) if prev_close else None}


def series(points: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """The CE and PE IV through the session at each bucket, for the history charts."""
    return [
        {"at": p["at"].isoformat(), "spot": p["spot"], **{b: {"ce": p[b]["ce"], "pe": p[b]["pe"]} for b in BUCKETS}}
        for p in points
    ]
