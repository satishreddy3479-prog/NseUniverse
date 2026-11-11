"""Live alerts of the straddle engine (pure): conditions found by comparing the current minute's snapshot with the recorded ones before it.

Every alert has a configurable threshold, a persistence rule (the condition must hold in the current and the previous recorded minute, unless stated) and a
cooldown (applied by the service). Alerts describe a change in readings; none is a trade signal. ``prev`` is newest first.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

CFG: dict[str, float] = {
    "iv_expansion_pts": 1.0,  # ATM IV change over 15 min
    "leg_iv_expansion_pts": 1.0,  # call or put IV change over 15 min
    "eff_drop_pts": 25.0,  # decay efficiency (30 min) fall over the last 10 minutes
    "eff_floor": 50.0,
    "accel_ratio": 1.3,  # realised vol, last 15 min against the 15 before
    "gex_change_share": 0.30,  # share of the larger |net GEX| that moved in 15 minutes
    "skew_reversal_pts": 1.0,
    "flow_jump": 30.0,  # order-flow group score jump within 5 minutes
    "flow_level": 40.0,
    "heavy_level": 30.0,
    "cvd_level": 10.0,
    "score_move": 10.0,  # environment score change over 10 minutes
    "cooldown_s": 600.0,
}


def _g(d: Mapping[str, Any] | None, *path: str) -> Any:
    for k in path:
        if not isinstance(d, Mapping):
            return None
        d = d.get(k)
    return d


def _ago(prev: Sequence[Mapping[str, Any]], n: int) -> Mapping[str, Any] | None:
    return prev[n - 1] if len(prev) >= n else None


def detect(prev: Sequence[Mapping[str, Any]], cur: Mapping[str, Any], cfg: Mapping[str, float] = CFG) -> list[dict[str, Any]]:
    """Alerts from ``cur`` (this minute's snapshot) given the earlier snapshots newest first."""
    out: list[dict[str, Any]] = []
    if not prev:
        return out
    p1 = prev[0]

    def add(kind: str, sev: str, direction: str, text: str, ev: list[str]) -> None:
        out.append({"kind": kind, "severity": sev, "direction": direction, "text": text, "evidence": ev})

    # decay slowing sharply: the class got worse and the efficiency is under the floor
    order = {"efficient": 3, "slower": 2, "none": 1, "expansion": 0}
    cs, ps = _g(cur, "eff30", "status"), _g(p1, "eff30", "status")
    ce, pe = _g(cur, "eff30", "pct"), _g(p1, "eff30", "pct")
    if cs in order and ps in order and order[cs] < order[ps] and ce is not None and ce < cfg["eff_floor"]:
        add("Straddle decay slowing sharply", "high", "neutral", f"Decay efficiency (30 min) moved from {ps} to {cs} ({ce:.0f}% of theta)", [f"previous {pe}%"])
    p10 = _ago(prev, 10)
    e10 = _g(p10, "eff30", "pct")
    if ce is not None and e10 is not None and e10 - ce >= cfg["eff_drop_pts"] and ce < cfg["eff_floor"]:
        add("Theta decay efficiency deteriorating", "medium", "neutral", f"Decay efficiency fell from {e10:.0f}% to {ce:.0f}% in 10 minutes", [])
    # ATM and leg IV expansion (persistent: this minute and the previous)
    iv, piv = _g(cur, "iv", "atm15"), _g(p1, "iv", "atm15")
    if iv is not None and piv is not None and iv >= cfg["iv_expansion_pts"] and piv >= cfg["iv_expansion_pts"] and not (_g(_ago(prev, 3), "iv", "atm15") or 0) >= cfg["iv_expansion_pts"]:
        add("Unexpected ATM IV expansion", "high", "neutral", f"ATM IV is up {iv:+.2f} vol points in 15 minutes", [f"minute before {piv:+.2f}"])
    for leg, label in (("pe15", "Put"), ("ce15", "Call")):
        v, pv = _g(cur, "iv", leg), _g(p1, "iv", leg)
        if v is not None and pv is not None and v >= cfg["leg_iv_expansion_pts"] and pv >= cfg["leg_iv_expansion_pts"] and not (_g(_ago(prev, 3), "iv", leg) or 0) >= cfg["leg_iv_expansion_pts"]:
            add(f"{label} IV expansion", "medium", "bearish" if label == "Put" else "bullish", f"{label} IV is up {v:+.2f} vol points in 15 minutes (a change in the vol, not a statement about buying or selling)", [])
    a, pa = _g(cur, "rv", "accel"), _g(p1, "rv", "accel")
    if a is not None and pa is not None and a >= cfg["accel_ratio"] and pa >= cfg["accel_ratio"] and not (_g(_ago(prev, 3), "rv", "accel") or 0) >= cfg["accel_ratio"]:
        add("Realised volatility accelerating", "high", "neutral", f"Realised vol over the last 15 minutes is {a:.2f}x the 15 before", [])
    # gamma flip crossing and significant GEX change
    f, pf = _g(cur, "gex", "side"), _g(p1, "gex", "side")
    if f is not None and pf is not None and f != pf:
        add("Gamma flip crossing", "high", "bullish" if f > 0 else "bearish", f"NIFTY crossed the modelled gamma flip {'upwards' if f > 0 else 'downwards'}", [f"flip {_g(cur, 'gex', 'flip')}"])
    n15, nn = _g(_ago(prev, 15), "gex", "net"), _g(cur, "gex", "net")
    if n15 is not None and nn is not None and max(abs(n15), abs(nn)) > 0 and abs(nn - n15) / max(abs(n15), abs(nn)) >= cfg["gex_change_share"] and not (
        _g(p1, "gex", "net") is not None and abs(_g(p1, "gex", "net") - n15) / max(abs(n15), abs(_g(p1, "gex", "net"))) >= cfg["gex_change_share"]):  # fmt: skip
        add("Significant GEX change", "medium", "neutral", f"Modelled net GEX moved {nn - n15:+.0f} in 15 minutes", [])
    # skew reversal: the 25-delta skew crossed zero by at least the threshold over 15 minutes
    s, s15 = _g(cur, "iv", "skew25"), _g(_ago(prev, 15), "iv", "skew25")
    if s is not None and s15 is not None and s * s15 < 0 and abs(s - s15) >= cfg["skew_reversal_pts"]:
        add("Skew reversal", "medium", "bullish" if s < 0 else "bearish", f"25-delta skew went from {s15:+.2f} to {s:+.2f}", [])
    # futures flow and heavyweight divergence
    fl, f5 = _g(cur, "flow", "orderflow"), _g(_ago(prev, 5), "flow", "orderflow")
    if fl is not None and f5 is not None and abs(fl) >= cfg["flow_level"] and abs(fl - f5) >= cfg["flow_jump"]:
        add("Sudden directional futures flow", "medium", "bullish" if fl > 0 else "bearish", f"Order-flow group score moved {f5:+.0f} to {fl:+.0f} in 5 minutes (CVD is an estimate)", [])
    h, cv, ph, pc = _g(cur, "flow", "heavy15"), _g(cur, "flow", "cvd"), _g(p1, "flow", "heavy15"), _g(p1, "flow", "cvd")
    if None not in (h, cv, ph, pc) and h * cv < 0 and ph * pc < 0 and abs(h) >= cfg["heavy_level"] and abs(cv) >= cfg["cvd_level"] and not (ph * pc < 0 and abs(ph) >= cfg["heavy_level"] and abs(pc) >= cfg["cvd_level"]):
        add("Heavyweight CVD divergence", "medium", "neutral", f"Heavyweight CVD ({h:+.0f}) and futures CVD ({cv:+.1f}%) point opposite ways (both estimates)", [])
    # environment scores over 10 minutes
    ss, s10 = cur.get("seller"), _g(p10, "seller")
    if ss is not None and s10 is not None and s10 - ss >= cfg["score_move"]:
        add("Seller environment deteriorating", "medium", "neutral", f"Seller environment score fell from {s10:.0f} to {ss:.0f} in 10 minutes", [str(cur.get("seller_class"))])
    bb, b10 = cur.get("buyer"), _g(p10, "buyer")
    if bb is not None and b10 is not None and bb - b10 >= cfg["score_move"]:
        add("Buyer environment improving", "medium", "neutral", f"Buyer environment score rose from {b10:.0f} to {bb:.0f} in 10 minutes", [str(cur.get("buyer_class"))])
    return out
