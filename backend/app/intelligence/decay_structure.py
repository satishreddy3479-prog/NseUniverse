"""Market-structure candidates for the decay engine's volatility (pure functions, point in time).

The engine's volatility is the market's own. A structure input is allowed to change it only if the recorded days say it helps. Each CANDIDATE below is a hypothesis with a threshold and a
multiplier FIXED IN ADVANCE (never fitted to the days it is judged on): it reads what was known at the entry minute and returns a multiplier for the volatility (1 = no change) or None when the
input cannot be formed (then no change is made, and the study counts how often that happened). ``KEPT`` lists the candidates the live engine applies: it is empty until
``decay_calibration.structure_study`` shows an improvement on both halves of at least ``MIN_DAYS`` days.

  rv_blend          the volatility used is half the implied and half the last 30 minutes' realised volatility (multiplier clipped to 0.7-1.3);
  range_expanding   the index has already moved more than half the premium: 1.15;
  trending          the last 30 minutes were a straight line (efficiency above 0.5): 1.15;
  accelerating      the last 15 minutes moved more than 1.3 times the 15 before: 1.1;
  event_in_hold     a high-importance event falls between the entry and the exit: 1.1;
  gift_gap          GIFT Nifty moved more than 0.4% overnight: 1.1 (little history: three days at first);
  pinned_by_wall    the index is within half a premium of the strike with the most open interest: 0.9 (pinning);
  gex_pinning       modelled net gamma exposure (open interest x gamma, calls positive, puts negative) above +15% of its gross: 0.9; below -15%: 1.1.
Not testable: VWAP (the index has no volume in the stored data; the futures' VWAP is not kept in the lab days).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import date, time
from typing import Any

from app.intelligence import context_signals, range_signals
from app.intelligence import straddle as sd
from app.intelligence.entry_lab import Day
from app.intraday.volatility import CALL, PUT

LOT = 65
WALL_BAND = 0.03  # the open-interest wall is looked for within this share of the index
KEPT: tuple[str, ...] = ()


def _clip(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def oi_features(oi: Mapping[tuple[float, int], int | None] | None, point: Any, premium: float) -> dict[str, float | None]:
    """The wall distance (index to the strike with most open interest, as a multiple of the premium) and the modelled net gamma share, from the open interest of one sample."""
    out: dict[str, float | None] = {"wall_ratio": None, "gex_share": None}
    if not oi:
        return out
    f = float(point.f)
    totals: dict[float, int] = {}
    for (k, _side), n in oi.items():
        if n and abs(k - f) <= WALL_BAND * f:
            totals[k] = totals.get(k, 0) + int(n)
    if totals and premium > 0:
        wall = max(totals, key=lambda k: (totals[k], -abs(k - f)))
        out["wall_ratio"] = abs(wall - f) / premium
    net = gross = 0.0
    for (k, side), n in oi.items():
        if not n or abs(k - f) > WALL_BAND * f:
            continue
        leg = point.leg(k, side)
        if leg is None:
            continue
        g = leg.g.gamma * int(n) * f * f * 0.01
        gross += g
        net += g if side == CALL else -g
    if gross > 0:
        out["gex_share"] = net / gross
    return out


def features(day: Day, i: int, point: Any, premium: float, iv: float, entry: time, exit_: time) -> dict[str, Any]:
    """Everything the candidates read, at sample ``i`` of ``day``."""
    sig = range_signals.compute(day.times, day.spots, i, premium, day.prev_close)
    rv = sd.realised(day.times, day.spots, 30, end=day.times[i]).get("vol_pct")
    sig["rv_ratio"] = None if rv is None or iv <= 0 else rv / (iv * 100)
    if day.context is not None or day.events_known:
        sig |= context_signals.features(date.fromisoformat(day.day), day.context, day.events, day.events_known, entry, exit_, sig.get("gap_pts"), day.prev_close)
    stamp = day.times[i].strftime("%H:%M")
    sig |= oi_features((day.oi or {}).get(stamp), point, premium)
    return sig


def _above(key: str, limit: float, up: float) -> Callable[[Mapping[str, Any]], float | None]:
    def fn(f: Mapping[str, Any]) -> float | None:
        v = f.get(key)
        return None if v is None else (up if v > limit else 1.0)

    return fn


def _gift(f: Mapping[str, Any]) -> float | None:
    v = f.get("gift_move_pct")
    return None if v is None else (1.1 if abs(v) > 0.4 else 1.0)


def _hold(f: Mapping[str, Any]) -> float | None:
    v = f.get("events_hold")
    return None if v is None else (1.1 if v > 0 else 1.0)


def _wall(f: Mapping[str, Any]) -> float | None:
    v = f.get("wall_ratio")
    return None if v is None else (0.9 if v < 0.5 else 1.0)


def _gex(f: Mapping[str, Any]) -> float | None:
    v = f.get("gex_share")
    return None if v is None else (0.9 if v > 0.15 else 1.1 if v < -0.15 else 1.0)


def _rv_blend(f: Mapping[str, Any]) -> float | None:
    v = f.get("rv_ratio")
    return None if v is None else _clip(0.5 + 0.5 * v, 0.7, 1.3)


CANDIDATES: dict[str, Callable[[Mapping[str, Any]], float | None]] = {
    "rv_blend": _rv_blend, "range_expanding": _above("range_ratio", 0.5, 1.15), "trending": _above("eff30", 0.5, 1.15), "accelerating": _above("acc", 1.3, 1.1),
    "event_in_hold": _hold, "gift_gap": _gift, "pinned_by_wall": _wall, "gex_pinning": _gex,
}  # fmt: skip


def multiplier(names: tuple[str, ...], feat: Mapping[str, Any]) -> float:
    """The product of the named candidates' multipliers (an input that cannot be formed counts as 1)."""
    m = 1.0
    for n in names:
        m *= CANDIDATES[n](feat) or 1.0
    return m


def has_input(name: str, feat: Mapping[str, Any]) -> bool:
    return CANDIDATES[name](feat) is not None


__all__ = ["CALL", "CANDIDATES", "KEPT", "LOT", "PUT", "features", "has_input", "multiplier", "oi_features"]
