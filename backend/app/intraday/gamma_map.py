"""Since-open gamma statistics and the sudden-move ("gamma blast") reading, from the stored GEX history of one session (``gex_history``).

Everything here is descriptive and provisional: gamma exposure is modelled (calls +, puts - is an assumed sign convention, not observed dealer inventory),
and the score weights and thresholds below are working values that have not been tested against outcomes. A missing input is left out of the score and
reported, never replaced by zero; the score is the weighted mean of the components that exist.

"Gamma blast" here means a sudden NIFTY move. The score says how much the stored conditions favour one (dealer gamma near spot short, spot near the flip,
gamma building, little time left, the market already speeding up). It never says which direction.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Mapping, Sequence
from typing import Any

#: component weights (sum 100). Provisional working values.
WEIGHTS = {"regime": 25, "flip": 20, "build": 15, "time": 15, "speed": 25}
#: spot within this share of the flip scores 1, beyond FLIP_FAR it scores 0 (percent of spot)
FLIP_NEAR, FLIP_FAR = 0.25, 1.5
#: absolute exposure now against its session mean: at or below 1.0 scores 0, at or above BUILD_FULL scores 1
BUILD_FULL = 1.5
#: hours to expiry: at or below TIME_NEAR scores 1, at or above TIME_FAR scores 0
TIME_NEAR, TIME_FAR = 1.5, 30.0
#: 15-minute move now against the session's typical 15-minute move: 1x or less scores 0, SPEED_FULL x or more scores 1
SPEED_FULL = 3.0
#: a 5-minute step is a sudden move when it is at least this many times the session's typical step and at least MIN_STEP_PCT of spot
EVENT_MULT, MIN_STEP_PCT = 3.0, 0.15
LEVELS = ((25.0, "calm"), (50.0, "building"), (75.0, "elevated"))


def clip01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _num(v: Any) -> float | None:
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else float(v)


def average_gamma(points: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Mean and range since the open of the absolute and near-the-money net exposure (rupees crore per 1 % move), where the latest value stands against them,
    and how long near-the-money net gamma was negative (short gamma: dealer hedging that pushes with the move, under the assumed sign convention)."""

    def stat(key: str) -> dict[str, Any] | None:
        xs: list[tuple[Mapping[str, Any], float]] = []
        for p in points:
            v = _num(p.get(key))
            if v is not None:
                xs.append((p, v))
        if not xs:
            return None
        vals = [v for _, v in xs]
        now = vals[-1]
        mean = statistics.fmean(vals)
        return {"now": now, "mean": mean, "min": min(vals), "max": max(vals), "samples": len(vals), "now_vs_mean": None if mean == 0 else now / mean,
                "peak_at": max(xs, key=lambda t: abs(t[1]))[0].get("at")}  # fmt: skip

    near = [_num(p.get("near_net")) for p in points]
    have = [v for v in near if v is not None]
    return {"abs": stat("abs"), "near_net": stat("near_net"), "net": stat("net"),
            "negative_share": None if not have else sum(1 for v in have if v < 0) / len(have), "points": len(points)}  # fmt: skip


def steps(points: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """The change of spot between consecutive snapshots (points and percent), with the near-the-money net gamma at the start of the step."""
    out = []
    for a, b in zip(points, points[1:], strict=False):
        sa, sb = _num(a.get("spot")), _num(b.get("spot"))
        if sa is None or sb is None or sa <= 0:
            continue
        out.append({"at": b.get("at"), "from": a.get("at"), "move": sb - sa, "pct": (sb / sa - 1) * 100, "near_net": _num(a.get("near_net"))})
    return out


def sudden_moves(points: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Steps that were sudden: at least ``EVENT_MULT`` times the session's median absolute step and at least ``MIN_STEP_PCT`` of spot. The direction is as it happened."""
    st = steps(points)
    if len(st) < 6:
        return {"typical_step_pct": None, "threshold_pct": None, "events": [], "latest_is_sudden": None, "steps": len(st)}
    typical = statistics.median(abs(s["pct"]) for s in st)
    thr = max(EVENT_MULT * typical, MIN_STEP_PCT)
    ev = [{"at": s["at"], "move": round(s["move"], 1), "pct": round(s["pct"], 3), "direction": "up" if s["move"] > 0 else "down",
           "near_net_before": s["near_net"], "short_gamma_before": None if s["near_net"] is None else s["near_net"] < 0} for s in st if abs(s["pct"]) >= thr]  # fmt: skip
    return {"typical_step_pct": typical, "threshold_pct": thr, "events": ev, "latest_is_sudden": abs(st[-1]["pct"]) >= thr, "steps": len(st)}


def blast(points: Sequence[Mapping[str, Any]], hours_to_expiry: float | None) -> dict[str, Any]:
    """The sudden-move risk reading (0 to 100) from the latest stored snapshot against the session so far."""
    if len(points) < 2:
        return {"status": "unavailable", "message": "Fewer than two stored snapshots in this session.", "score": None, "level": None, "components": []}
    last = points[-1]
    spot = _num(last.get("spot"))
    comps: list[dict[str, Any]] = []

    def add(key: str, label: str, value: float | None, detail: str) -> None:
        comps.append({"key": key, "label": label, "weight": WEIGHTS[key], "value": None if value is None else round(value, 3), "detail": detail})

    near = _num(last.get("near_net"))
    scale = max((abs(v) for v in (_num(p.get("near_net")) for p in points) if v is not None), default=0.0)
    if near is None or scale == 0:
        add("regime", "Dealer gamma near spot", None, "no near-the-money net gamma stored")
    else:
        add("regime", "Dealer gamma near spot", clip01(0.5 - 0.5 * near / scale),
            f"{'short (moves can be pushed along)' if near < 0 else 'long (moves tend to be damped)'}: {near:+.1f} crore against a session range of ±{scale:.1f}")  # fmt: skip
    flip = _num(last.get("flip"))
    if flip is None or spot is None:
        add("flip", "Spot near the gamma flip", None, "no flip within ±8 % of spot")
    else:
        d = abs(spot - flip) / spot * 100
        add("flip", "Spot near the gamma flip", clip01((FLIP_FAR - d) / (FLIP_FAR - FLIP_NEAR)), f"spot is {d:.2f} % ({abs(spot - flip):.0f} points) from the flip at {flip:.0f}")
    ab = average_gamma(points)["abs"]
    if ab is None or ab["now_vs_mean"] is None:
        add("build", "Gamma building", None, "no absolute exposure stored")
    else:
        r = ab["now_vs_mean"]
        add("build", "Gamma building", clip01((r - 1.0) / (BUILD_FULL - 1.0)), f"absolute exposure is {r:.2f} times its session mean")
    if hours_to_expiry is None:
        add("time", "Time left to expiry", None, "expiry time unknown")
    else:
        add("time", "Time left to expiry", clip01((TIME_FAR - hours_to_expiry) / (TIME_FAR - TIME_NEAR)), f"{hours_to_expiry:.1f} calendar hours to expiry (weekends and holidays count, as in the option model): gamma concentrates as it falls")
    st = steps(points)
    if len(st) >= 6 and spot is not None:
        spots = [_num(p.get("spot")) for p in points]
        s_now, s_back = spots[-1], spots[-4] if len(spots) >= 4 else None
        moves15 = [abs(b - a) for a, b in zip(spots, spots[3:], strict=False) if a is not None and b is not None]
        typ = statistics.median(moves15) if moves15 else 0.0
        if s_now is None or s_back is None or typ == 0:
            add("speed", "Market already speeding up", None, "not enough spot history")
        else:
            m = abs(s_now - s_back)
            add("speed", "Market already speeding up", clip01((m / typ - 1.0) / (SPEED_FULL - 1.0)), f"last 15 minutes moved {m:.0f} points, {m / typ:.1f} times the session's typical 15 minutes ({typ:.0f})")
    else:
        add("speed", "Market already speeding up", None, "needs six 5-minute steps")
    have = [c for c in comps if c["value"] is not None]
    wsum = sum(c["weight"] for c in have)
    score = None if not wsum else sum(c["weight"] * c["value"] for c in have) / wsum * 100
    level = None if score is None else next((n for hi, n in LEVELS if score < hi), "high")
    sm = sudden_moves(points)
    return {"status": "ok", "score": None if score is None else round(score, 1), "level": level, "components": comps,
            "coverage_pct": round(wsum / sum(WEIGHTS.values()) * 100), "sudden": sm,
            "note": "Descriptive and provisional: modelled gamma (assumed sign convention), working weights and thresholds not yet tested against outcomes. It says how much the stored conditions favour a sudden move, never which way."}  # fmt: skip


def strike_profile(rows: Sequence[Mapping[str, Any]], spot: float, each: int = 15) -> list[dict[str, Any]]:
    """Per-strike exposure (crore per 1 % move) for the strikes nearest spot: call (+), put (-), net and absolute; a missing side stays None."""
    ks = sorted(rows, key=lambda r: r["strike"])
    if not ks:
        return []
    i = min(range(len(ks)), key=lambda j: (abs(ks[j]["strike"] - spot), ks[j]["strike"]))
    return [{k: r.get(k) for k in ("strike", "ce", "pe", "net", "abs")} for r in ks[max(0, i - each): i + each + 1]]
