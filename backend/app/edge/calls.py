"""The calls each indicator made on one finished session, and what price did after each (pure functions over stored rows, no I/O).

Every indicator is turned into the same thing: at some minute it said "up", "down" (or "calm"), and the stored price a fixed time later says whether it was right. Nothing is invented:
a call whose outcome minute was never recorded has no outcome and is left out, a move under ``FLAT_PCT`` is "flat" (neither right nor wrong) and a minute with no spot is skipped.

Indicators (``INDICATORS``): the fused Market Intelligence verdict (with the turn cap), the intraday rules score, the 30-minute momentum read, the opening-range break, and the straddle
seller score (a "calm" claim: the next window moves little). The patterns (momentum, opening-range break) are the ones found in the stored month (docs/decisions.md D311); this job
exists to find out, session by session, whether they keep working.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

from app.intelligence import fusion as fz
from app.intelligence import pullback as pb
from app.intelligence import validation as val

IST = timezone(timedelta(hours=5, minutes=30))
OPEN_MIN = 9 * 60 + 15
CLOSE_MIN = 16 * 60  # nothing is recorded after the close; this only keeps a stray later row out
HORIZONS = (15, 30, 60)
STEP_MIN = 15  # one call at most every 15 minutes (calls a minute apart are the same call)
FIRST_CALL_MIN = 9 * 60 + 30
TOLERANCE_MIN = 4  # the outcome minute may be this late (a missed sample), never earlier
FLAT_PCT = 0.02  # a move under this is flat: neither right nor wrong
VERDICT_BAND = val.NEUTRAL_BAND  # fused score outside +-15 is a call
RULES_BAND = 0.2  # intraday rules score outside +-0.2 is a call (its Neutral band)
MOMENTUM_MIN_PCT = 0.03  # the previous 30 minutes must have moved at least this much
SELLER_MIN = 60.0  # straddle seller score at or above this claims calm
CALM_PCT_30 = 0.10  # a 30-minute move under this is calm (scaled by sqrt(time) for other horizons)

# "tuned_through": the last stored session the rule was found or tuned on: those sessions are shown but cannot count as proof (only later sessions decide the label)
INDICATORS: dict[str, dict[str, str]] = {
    "verdict": {"name": "Market Intelligence verdict", "kind": "direction", "claim": "Price moves the way the fused score leans (score outside +-15, after the turn cap).", "tuned_through": "2026-11-25"},
    "rules": {"name": "Intraday rules score", "kind": "direction", "claim": "Price moves the way the rules score leans (outside +-0.2)."},
    "momentum": {"name": "30-minute momentum", "kind": "direction", "claim": "The next window continues the last 30 minutes' move (at least 0.03 %).", "tuned_through": "2026-11-25"},
    "orb": {"name": "Opening-range break", "kind": "direction", "claim": "After price first leaves the 09:15-09:30 range it keeps going that way.", "tuned_through": "2026-11-25"},
    "seller": {"name": "Straddle seller score", "kind": "calm", "claim": "With the seller score at 60 or more, the next window moves little."},
}


def _num(x: Any) -> float | None:
    return float(x) if isinstance(x, (int, float)) and math.isfinite(x) else None


def ist_minute(at: str) -> int | None:
    try:
        t = datetime.fromisoformat(str(at)).astimezone(IST)
    except (ValueError, TypeError):
        return None
    return t.hour * 60 + t.minute


def series(rows: Sequence[Mapping[str, Any]]) -> list[tuple[int, float, int]]:
    """(IST minute of day, spot, index into rows) for the in-session rows that have a spot, oldest first."""
    out = []
    for i, r in enumerate(rows):
        m, s = ist_minute(r.get("at", "")), _num(r.get("spot"))
        if m is not None and s is not None and s > 0 and OPEN_MIN <= m <= CLOSE_MIN:
            out.append((m, s, i))
    return out


def forward_pct(pts: Sequence[tuple[int, float, int]], k: int, minutes: int) -> float | None:
    """The % move from point k to the first point at least ``minutes`` later (at most TOLERANCE_MIN late); None if the minute was not recorded."""
    m0, s0, _ = pts[k]
    for m, s, _i in pts[k + 1:]:
        if m - m0 >= minutes:
            return (s / s0 - 1) * 100 if m - m0 <= minutes + TOLERANCE_MIN else None
    return None


def _steps(pts: Sequence[tuple[int, float, int]]) -> list[int]:
    """Indexes of the points at which a call may be made: the first point from 09:30, then at least STEP_MIN later each time."""
    out: list[int] = []
    last: int | None = None
    for k, (m, _s, _i) in enumerate(pts):
        if m >= FIRST_CALL_MIN and (last is None or m - last >= STEP_MIN):
            out.append(k)
            last = m
    return out


def windows(pts: Sequence[tuple[int, float, int]]) -> list[dict[str, Any]]:
    """Every step window of the session, called or not: the market's own up share and calm share per hour and horizon (the baselines a call is compared with)."""
    acc: dict[tuple[int, int], dict[str, int]] = {}
    for k in _steps(pts):
        hour = pts[k][0] // 60
        for h in HORIZONS:
            f = forward_pct(pts, k, h)
            if f is None:
                continue
            a = acc.setdefault((h, hour), {"n": 0, "up": 0, "down": 0, "calm": 0})
            a["n"] += 1
            if abs(f) >= FLAT_PCT:
                a["up" if f > 0 else "down"] += 1
            a["calm"] += abs(f) < CALM_PCT_30 * math.sqrt(h / 30)
    return [{"horizon": h, "hour": hour, **a} for (h, hour), a in sorted(acc.items())]


def _result(kind: str, side: int, f: float, horizon: int) -> str:
    if kind == "calm":
        return "hit" if abs(f) < CALM_PCT_30 * math.sqrt(horizon / 30) else "miss"
    if abs(f) < FLAT_PCT:
        return "flat"
    return "hit" if (f > 0) == (side > 0) else "miss"


def _emit(session: str, indicator: str, rows: Sequence[Mapping[str, Any]], pts: Sequence[tuple[int, float, int]], k: int, side: int) -> list[dict[str, Any]]:
    kind = INDICATORS[indicator]["kind"]
    out = []
    for h in HORIZONS:
        f = forward_pct(pts, k, h)
        if f is None:
            continue
        out.append({"session": session, "indicator": indicator, "horizon": h, "at": rows[pts[k][2]]["at"], "side": side, "spot": pts[k][1], "fwd_pct": round(f, 4), "result": _result(kind, side, f, h)})
    return out


def verdict_calls(session: str, rows: Sequence[Mapping[str, Any]], weights: Mapping[str, float] | None = None) -> list[dict[str, Any]]:
    w = weights or fz.DEFAULT_WEIGHTS
    pts = series(rows)
    flags = pb.flags(rows)
    out: list[dict[str, Any]] = []
    for k in _steps(pts):
        i = pts[k][2]
        score, _ = pb.cap(val.rescore(rows[i], w), flags[i])
        if score is not None and abs(score) >= VERDICT_BAND:
            out += _emit(session, "verdict", rows, pts, k, 1 if score > 0 else -1)
    return out


def rules_calls(session: str, rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    pts = series(rows)
    out: list[dict[str, Any]] = []
    for k in _steps(pts):
        s = _num(rows[pts[k][2]].get("score"))
        if s is not None and abs(s) >= RULES_BAND:
            out += _emit(session, "rules", rows, pts, k, 1 if s > 0 else -1)
    return out


def momentum_calls(session: str, rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    pts = series(rows)
    out: list[dict[str, Any]] = []
    for k in _steps(pts):
        m0, s0, _ = pts[k]
        back = next((j for j in range(k - 1, -1, -1) if m0 - pts[j][0] >= 30), None)
        if back is None or m0 - pts[back][0] > 30 + TOLERANCE_MIN:
            continue
        r = (s0 / pts[back][1] - 1) * 100
        if abs(r) >= MOMENTUM_MIN_PCT:
            out += _emit(session, "momentum", rows, pts, k, 1 if r > 0 else -1)
    return out


def orb_calls(session: str, rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """One call a session: at the first point after 09:30 that is outside the 09:15-09:30 range, in the direction of the break."""
    pts = series(rows)
    box = [s for m, s, _ in pts if m < FIRST_CALL_MIN]
    if len(box) < 5:
        return []
    hi, lo = max(box), min(box)
    for k, (m, s, _i) in enumerate(pts):
        if m >= FIRST_CALL_MIN and (s > hi or s < lo):
            return _emit(session, "orb", rows, pts, k, 1 if s > hi else -1)
    return []


def seller_calls(session: str, rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    pts = series(rows)
    out: list[dict[str, Any]] = []
    for k in _steps(pts):
        s = _num(rows[pts[k][2]].get("seller"))
        if s is not None and s >= SELLER_MIN:
            out += _emit(session, "seller", rows, pts, k, 0)
    return out
