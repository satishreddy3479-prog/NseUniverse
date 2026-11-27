"""Buyer and seller environment engines (pure functions, no I/O).

Two independent 0-100 scores built from the straddle analysis (``straddle.analyse``) and from what Market Intelligence already computes (futures flow, VWAP,
heavyweight CVD, positioning, GEX). Each component is a value in [-1, +1] oriented to the side being scored (+1 = favourable), has a weight and a plain reason;
the score is 50 + 50 x sum(weight x value) / sum(weight of the available components). A missing input drops its component and lowers the coverage: it is never
treated as neutral or zero. Weights and break points are provisional working values, not trained and not validated: the page says so, and the validation
section reports what the stored minutes show. Neither score changes the fused sentiment score, and neither is a trade signal or a profit expectation.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

PROVISIONAL = "Provisional working weights and break points: not trained, not validated. A score describes conditions; it is not a signal and not a profit expectation."
MIN_COVERAGE = 0.5
SELLER_CLASSES = ((80, "Highly favourable"), (60, "Favourable"), (40, "Neutral"), (25, "Unfavourable"), (0, "High risk"))
BUYER_CLASSES = ((75, "Strong buyer environment"), (60, "Favourable"), (45, "Selective"), (30, "Neutral"), (0, "Unfavourable"))
_ORDER_S = [n for _, n in SELLER_CLASSES][::-1]  # worst .. best


def clip(x: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def num(x: Any) -> float | None:
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) and x == x else None


def g(d: Any, *path: str) -> Any:
    for k in path:
        if not isinstance(d, Mapping):
            return None
        d = d.get(k)
    return d


def comp(id_: str, name: str, weight: float, value: float | None, text: str, source: str, proxy: bool = False) -> dict[str, Any]:
    return {"id": id_, "name": name, "weight": weight, "value": None if value is None else round(clip(value), 3), "text": text if value is not None else f"unavailable: {text}",
            "source": source, "proxy": proxy, "status": "AVAILABLE" if value is not None else "UNAVAILABLE"}  # fmt: skip


def score(comps: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Weighted evidence to a 0-100 score with every component's contribution (points away from 50)."""
    tot = sum(c["weight"] for c in comps)
    av = [c for c in comps if c["value"] is not None]
    w = sum(c["weight"] for c in av)
    cov = 0.0 if tot == 0 else w / tot
    out = []
    for c in comps:
        contrib = None if c["value"] is None or w == 0 else round(50 * c["weight"] * c["value"] / w, 1)
        out.append({**c, "contribution": contrib})
    s = None if w == 0 or cov < MIN_COVERAGE else round(50 + 50 * sum(c["weight"] * c["value"] for c in av) / w, 1)
    return {"score": s, "coverage": round(cov, 2), "components": out}


def _band(v: float | None, bands: Sequence[tuple[int, str]]) -> str:
    if v is None:
        return "Insufficient evidence"
    return next(n for lo, n in bands if v >= lo)


CONVEXITY_RATIO = 1.5  # provisional: realised gamma cost above this multiple of the expected theta decay hard-caps the seller class
PREM_SCALE_PCT = 12.0  # provisional: a straddle premium move of this many percent of its opening value is a full-strength reading
PREM_STOP_PCT, PREM_STOP_HARD_PCT = 15.0, 30.0  # provisional stop zones for a short straddle: premium up this much from the open caps the class
WINDOWS = (("open", None), ("60", 60), ("30", 30), ("15", 15))


def premium_path(a: Mapping[str, Any], kind: str) -> dict[str, Any] | None:
    """Roll-adjusted straddle premium change as a percent of the opening premium: since the open and over the last 60/30/15 minutes.
    Works from the cumulative attribution series (stored minutes), so it does not depend on the theta floor that switches the decay ratio off."""
    cum = g(a, "cumulative", kind, "actual")
    base = num(g(a, "tracker", kind, "straddle", "open"))
    if not cum or not base or base <= 0:
        return None
    last = next((x for x in reversed(cum) if x is not None), None)
    if last is None:
        return None
    pts: dict[str, float | None] = {"open": float(last)}
    for name, n in WINDOWS[1:]:
        old = cum[-1 - n] if n is not None and len(cum) > n else None
        pts[name] = None if old is None else float(last) - float(old)
    return {"base": base, "pts": {k: None if v is None else round(v, 2) for k, v in pts.items()}, "pct": {k: None if v is None else round(v / base * 100, 2) for k, v in pts.items()}}


def _prem_text(label: str, p: Mapping[str, Any]) -> str:
    pc = p["pct"]
    parts = [f"{'since open' if name == 'open' else name + ' min'} {pc[name]:+.1f}%" for name, _ in WINDOWS if pc.get(name) is not None]
    return f"{label} premium change as a percent of its opening {p['base']:.1f} points: " + ", ".join(parts)


# ------------------------------------------------------------------ evidence pulled from the straddle analysis and the MI summary
def evidence(a: Mapping[str, Any], mi: Mapping[str, Any]) -> dict[str, Any]:
    """The numbers both engines read, with their source. Anything missing is None."""
    att = a.get("attribution") or {}
    recent = (att.get("rolling") or {}).get("60") or (att.get("fixed") or {}).get("open")
    eff = None if not recent else recent["efficiency"]
    iv = a.get("iv") or {}
    mv = (iv.get("moves") or {})
    atm30 = (mv.get("rolling_atm") or {}).get("30")
    atm15 = (mv.get("rolling_atm") or {}).get("15")
    if atm30 is None:
        atm30 = g(iv, "rolling", "combined", "change")
    rvs = a.get("realised_vs_implied") or {}
    gap = (rvs.get("gap") or {})
    rv_gap = gap.get("60") if gap.get("60") is not None else gap.get("open")
    rv_src = "60" if gap.get("60") is not None else "open"
    rv_thin, rv_n = g(rvs, "windows", rv_src, "thin"), g(rvs, "windows", rv_src, "returns")
    rv_val = g(rvs, "windows", "60", "vol_pct") if g(rvs, "windows", "60", "vol_pct") is not None else g(rvs, "windows", "open", "vol_pct")
    st = a.get("structure") or {}
    regimes = iv.get("regimes") or {}
    reg30 = (regimes.get("30") or regimes.get("open") or {}).get("tags") or []
    dce30 = (mv.get("fixed_ce") or {}).get("30")
    dpe30 = (mv.get("fixed_pe") or {}).get("30")
    sk = (mv.get("skew25") or {}).get("60") if (mv.get("skew25") or {}).get("60") is not None else g(iv, "skew25", "change")
    eng = {e["key"]: e.get("score") for e in (mi.get("engines") or []) if isinstance(e, Mapping)}
    hw = g(mi, "heavyweights", "aggregate", "15", "score")
    pulse = mi.get("pulse") or {}
    opt = g(mi, "panels", "options") or {}
    return {
        "eff": eff, "iv_atm_30": atm30, "iv_atm_15": atm15, "reg30": reg30, "dce30": dce30, "dpe30": dpe30, "rv_gap": rv_gap, "rv_thin": rv_thin, "rv_n": rv_n, "rv": rv_val, "ratio": st.get("realised_vs_breakeven"),
        "config": [x["tag"] for x in (st.get("config") or [])], "gex": st.get("gex") or {}, "gex_session": st.get("gex_session") or {}, "skew_change": sk,
        "skew25": g(iv, "levels", "pe25", "current"), "ce25": g(iv, "levels", "ce25", "current"),
        "accel": g(rvs, "acceleration", "ratio"), "regime": (a.get("regime") or {}).get("label"), "eff30": g(a, "regime", "path_efficiency_30m"), "move30": rvs.get("move_30m_pts"),
        "move_vs_sd": rvs.get("move_vs_daily_sd"),
        "prem_rolling": premium_path(a, "rolling"),
        "orderflow": num(eng.get("orderflow")), "positioning": num(eng.get("positioning")), "heavy15": num(hw), "cvd": num(pulse.get("futures_cvd_pct")),
        "vwap_pct": num(g(pulse, "vwap", "distance_pct")), "vwap_side": g(pulse, "vwap", "side"), "opt": opt, "spot": num(pulse.get("spot")) or num(a.get("spot", [None])[-1] if a.get("spot") else None),
    }  # fmt: skip


def direction(ev: Mapping[str, Any]) -> dict[str, Any]:
    """Which way the evidence leans (up +, down -), averaged over the available directional readings. Describes pressure, not a forecast."""
    parts: list[tuple[str, float]] = []
    if ev["cvd"] is not None:
        parts.append(("futures CVD (proxy)", clip(ev["cvd"] / 25)))
    if ev["vwap_pct"] is not None:
        parts.append(("futures vs its VWAP", clip(ev["vwap_pct"] / 0.3)))
    if ev["heavy15"] is not None:
        parts.append(("heavyweight CVD 15 min (proxy)", clip(ev["heavy15"] / 60)))
    if ev["move30"] is not None and ev["eff30"] is not None:
        sd = None if not ev.get("sd_pts") else ev["sd_pts"]
        parts.append(("NIFTY move, last 30 min", clip(ev["move30"] / (sd * 0.5) if sd else (1 if ev["move30"] > 0 else -1) * ev["eff30"])))
    if not parts:
        return {"value": None, "label": "unavailable", "parts": []}
    v = sum(x for _, x in parts) / len(parts)
    return {"value": round(v, 2), "label": "upward pressure" if v >= 0.3 else "downward pressure" if v <= -0.3 else "mixed or balanced", "parts": [{"name": n, "value": round(x, 2)} for n, x in parts]}


# ------------------------------------------------------------------ seller
def _conf(eff: Mapping[str, Any]) -> float:
    """How far a decay efficiency can be trusted (0-1): small expected decay is dominated by price ticks, so its reading is weighed down toward neutral."""
    c = eff.get("confidence")
    return 1.0 if c is None else max(0.0, min(1.0, float(c)))


def _conf_note(eff: Mapping[str, Any]) -> str:
    c = _conf(eff)
    return "" if c >= 1.0 else f" [weighed at {c:.0%}: only {eff.get('expected_decay')} points of decay expected in this window]"


def _prem_value(p: Mapping[str, Any]) -> float:
    """Premium path to [-1, +1] (+ = premium rose): 60% since the open, 40% the last 60 minutes (just the open when the hour is not stored yet)."""
    pc = p["pct"]
    o, h = pc.get("open"), pc.get("60")
    pct = o if h is None else 0.6 * o + 0.4 * h
    return clip(pct / PREM_SCALE_PCT)


def seller_components(ev: Mapping[str, Any]) -> list[dict[str, Any]]:
    eff = ev["eff"] or {}
    e = eff.get("efficiency_pct")
    c: list[dict[str, Any]] = []
    conf = _conf(eff)
    c.append(comp("decay", "Theta decay efficiency", 8, None if e is None else (e - 50) / 50 * conf, f"recent decay {e:.0f}% of theta ({eff.get('status')}); {eff.get('reason')}{_conf_note(eff)}" if e is not None else (eff.get("reason") or "no computable efficiency"), "straddle attribution"))
    pr = ev.get("prem_rolling")
    prv = None if pr is None else _prem_value(pr)
    c.append(comp("prem_rolling", "ATM straddle premium path", 14, None if prv is None else -prv, _prem_text("At-the-money straddle (roll-adjusted)", pr) + " (a seller who re-centres; the opening strike is not scored once spot has moved away)" if pr is not None else "no premium series yet", "straddle series (stored minutes)"))
    i30 = ev["iv_atm_30"]
    c.append(comp("iv_trend", "ATM IV trend", 12, None if i30 is None else -i30 / 1.0, f"ATM IV {i30:+.2f} vol points over the recent window (falling helps a seller)" if i30 is not None else "no IV change window", "straddle IV"))
    tags = ev["reg30"]
    v = -1.0 if "both_expanding" in tags else 0.7 if "both_contracting" in tags else -0.5 if any(t in tags for t in ("put_expanding_faster", "call_expanding_faster")) else 0.0
    c.append(comp("iv_sides", "Call/put IV behaviour", 6, v if ev["dce30"] is not None else None, (("; ".join(tags) or "no clear call/put IV pattern") + " (30 min)") if ev["dce30"] is not None else "needs a 30-minute window of call and put IV (not enough samples yet)", "straddle IV"))
    gp = ev["rv_gap"]
    c.append(comp("rv_gap", "Realised versus implied vol", 12, None if gp is None else gp / 6, f"implied minus realised {gp:+.1f} vol points (positive: the premium is rich against actual movement)" + _thin(ev) if gp is not None else "no realised window", "straddle realised vs implied"))
    r = ev["ratio"]
    c.append(comp("movement", "Underlying movement vs break-even", 10, None if r is None else (1 - r) / 0.5, f"realised daily-equivalent move is {r:.2f}x the straddle's break-even move" + _thin(ev) if r is not None else "no break-even", "straddle structure"))
    cfg = ev["config"]
    gv = [{"suppressed movement": 0.6, "price stabilisation around gamma concentration": 0.6, "increasing movement": -0.6, "potential gamma-driven acceleration": -1.0}.get(t) for t in cfg]
    gvf = [x for x in gv if x is not None]
    c.append(comp("gamma", "Gamma regime (modelled)", 8, (sum(gvf) / len(gvf)) if gvf else (0.0 if cfg else None), "; ".join(cfg) or "no GEX", "GEX (modelled exposure)", proxy=True))
    rel = ev["gex"].get("relationship") if ev["gex"] else None
    cross = ev["gex_session"].get("flip_crossings") if ev["gex_session"] else None
    sv = None if rel is None else {"stabilising": 0.6, "amplifying": -0.6}.get(rel, 0.0) - (0.4 if (cross or 0) >= 3 else 0.0)
    c.append(comp("gex_stable", "GEX stability", 5, sv, f"GEX vs spot over 15 min: {rel}; flip crossed {cross} time(s) today" if sv is not None else "no GEX history", "GEX (modelled exposure)", proxy=True))
    sk = ev["skew_change"]
    c.append(comp("skew", "Skew changes", 5, None if sk is None else 0.4 - min(abs(sk), 2) / 2, f"25-delta skew changed {sk:+.2f} vol points (large repricing of tails is a risk to premium sellers)" if sk is not None else "no skew history", "straddle IV"))
    opt = ev["opt"]
    pv = None
    spot, ce_k, pe_k, pcr = ev["spot"], num(opt.get("max_ce_oi_strike")), num(opt.get("max_pe_oi_strike")), num(opt.get("pcr_oi"))
    if spot and ce_k and pe_k:
        inside = pe_k < spot < ce_k
        pv = (0.5 if inside else -0.5) + (0.0 if pcr is None else (0.2 if 0.7 <= pcr <= 1.3 else -0.2))
    c.append(comp("positioning", "Options positioning", 6, pv, f"largest put OI {pe_k:g}, largest call OI {ce_k:g}, PCR {pcr:.2f}; spot {'between' if pv is not None and pv > 0 else 'outside'} them (OI does not say who is long or short)" if pv is not None else "no positioning", "Market Intelligence positioning"))
    of = ev["orderflow"]
    c.append(comp("flow", "Futures order-flow evidence", 8, None if of is None else 0.5 - abs(of) / 100, f"order-flow group score {of:+.0f}: one-sided flow is a risk to sellers, balanced flow is not" if of is not None else "no flow group", "Market Intelligence order-flow engine", proxy=True))
    h = ev["heavy15"]
    c.append(comp("heavy", "Heavyweight participation", 8, None if h is None else 0.4 - abs(h) / 100 * 0.9, f"heavyweight CVD 15-minute score {h:+.0f}" if h is not None else "no heavyweight reading", "Market Intelligence heavyweight engine", proxy=True))
    return c


def flags(ev: Mapping[str, Any]) -> list[dict[str, str]]:
    """Conditions a premium seller should see first. They cap the seller classification; they are not predictions."""
    out: list[dict[str, str]] = []
    if ev["iv_atm_15"] is not None and ev["iv_atm_15"] >= 1.0:
        out.append({"id": "iv_spike", "text": f"Sudden IV expansion: ATM IV +{ev['iv_atm_15']:.1f} vol points in 15 minutes"})
    if ev["accel"] is not None and ev["accel"] >= 1.3:
        out.append({"id": "rv_up", "text": f"Realised volatility is rising: the last 15 minutes are {ev['accel']:.2f}x the 15 before"})
    if ev["regime"] == "directional acceleration":
        out.append({"id": "directional", "text": "Directional acceleration: the recent move is one-way and realised vol is rising"})
    pr = ev.get("prem_rolling")
    pct = None if pr is None else pr["pct"].get("open")
    if pct is not None and pct >= PREM_STOP_PCT:
        hard = pct >= PREM_STOP_HARD_PCT
        out.append({"id": "premium_up", "text": f"The at-the-money straddle premium (roll-adjusted) is {pct:+.1f}% above its open (stop zone from +{PREM_STOP_PCT:g}%): a seller who re-centres is behind", **({"cap": "Unfavourable"} if hard else {})})
    eff = ev.get("eff") or {}
    gamma_pts = (eff.get("causes") or {}).get("gamma exposure (realised convexity)")
    theta_pts = eff.get("expected_decay")
    if gamma_pts is not None and theta_pts is not None and theta_pts > 0 and gamma_pts > CONVEXITY_RATIO * theta_pts:
        out.append({"id": "convexity_blowout", "cap": "High risk",
                    "text": f"Realised convexity (+{gamma_pts:.1f} pts) is overwhelming theta ({theta_pts:.1f} pts): gamma risk is dominating decay"})  # fmt: skip
    eff_pct = eff.get("efficiency_pct")
    if eff_pct is not None and eff_pct < 0:
        out.append({"id": "premium_expansion", "cap": "Unfavourable", "text": f"Premium expansion (decay efficiency {eff_pct:.0f}%): the straddle premium is rising, not decaying"})
    d1, d2 = ev["dce30"], ev["dpe30"]
    sk = ev["skew25"]
    if (d1 is not None and d2 is not None and abs(d2 - d1) >= 1.0) or (sk is not None and ev["ce25"] is not None and abs(sk - ev["ce25"]) >= 4):
        out.append({"id": "tail", "text": "Asymmetric tail risk: call and put vols are moving apart or the 25-delta skew is wide"})
    return out


def damped_score(now: float | None, recent: Sequence[float | None]) -> float | None:
    """The score the class label is read from: the median of this minute and the two recorded minutes before it (a label changes only when two of the three agree).
    Without two recorded minutes the raw score is used. The number shown stays raw."""
    prior = [x for x in recent[-2:] if x is not None]
    if now is None or len(prior) < 2:
        return now
    return sorted([now, *prior])[1]


def seller(ev: Mapping[str, Any], dirn: Mapping[str, Any], recent: Sequence[float | None] = ()) -> dict[str, Any]:
    comps = seller_components(ev)
    base = score(comps)
    fl = flags(ev)
    cls = _band(damped_score(base["score"], recent), SELLER_CLASSES)
    cap = None
    if base["score"] is not None and fl:
        limit = "High risk" if any(f.get("cap") == "High risk" for f in fl) else "Unfavourable" if len(fl) >= 2 or any(f.get("cap") == "Unfavourable" for f in fl) else "Neutral"
        if _ORDER_S.index(cls) > _ORDER_S.index(limit):
            cap, cls = limit, limit
    by = {c["id"]: c for c in base["components"]}

    def sub(ids: Sequence[str], weights: Mapping[str, float] | None = None) -> dict[str, Any]:
        cs = [{**by[i], "weight": (weights or {}).get(i, by[i]["weight"])} for i in ids]
        r = score(cs)
        return {"score": r["score"], "class": _band(r["score"], SELLER_CLASSES), "uses": [by[i]["name"] for i in ids]}

    straddle = sub(["decay", "prem_rolling", "rv_gap", "movement", "gamma", "iv_trend", "flow"])
    strangle = sub(["iv_trend", "rv_gap", "movement", "gex_stable", "positioning", "skew", "flow"], {"positioning": 12, "movement": 6})
    if {"directional", "convexity_blowout"} & {f["id"] for f in fl} and straddle["score"] is not None:
        straddle["score"] = round(min(straddle["score"], 40), 1)
        straddle["class"] = _band(straddle["score"], SELLER_CLASSES)
    return {"score": base["score"], "class": cls, "capped_by_flags": cap, "coverage": base["coverage"], "components": base["components"], "flags": fl,
            "short_straddle": straddle, "short_strangle": strangle, "call_side_risk": side_risk(ev, dirn, +1), "put_side_risk": side_risk(ev, dirn, -1), "note": PROVISIONAL + " A favourable seller environment is not a guarantee of profit."}  # fmt: skip


def side_risk(ev: Mapping[str, Any], dirn: Mapping[str, Any], sign: int) -> dict[str, Any]:
    """Risk to premium sold on one side (sign +1 = calls, -1 = puts), 0-100 (higher = riskier), from pressure toward that strike side and that side's vol."""
    parts: list[tuple[str, float, str]] = []
    leg = ev["dce30"] if sign > 0 else ev["dpe30"]
    if leg is not None:
        parts.append((f"{'call' if sign > 0 else 'put'} IV change, 30 min", clip(leg / 1.0), f"{leg:+.2f} vol points"))
    if ev["accel"] is not None:
        parts.append(("realised vol acceleration", clip((ev["accel"] - 1) / 0.6), f"15 min vs previous 15: {ev['accel']:.2f}x"))
    gcfg = ev["config"]
    if gcfg:
        parts.append(("gamma set-up", 0.6 if "potential gamma-driven acceleration" in gcfg else 0.3 if "increasing movement" in gcfg else -0.3 if "suppressed movement" in gcfg else 0.0, "; ".join(gcfg)))
    if sign < 0 and ev["skew25"] is not None and ev["ce25"] is not None:
        sk = ev["skew25"] - ev["ce25"]
        parts.append(("put-skew richness (downside tail priced)", clip(sk / 6), f"25-delta put IV minus call IV {sk:+.1f}"))
    # The pressure reading (futures CVD proxy, VWAP, heavyweights, last 30 minutes) has no validated skill
    # (the fused direction score hit 52-53% on 7 sessions): it is shown as context and is not averaged in.
    d = dirn.get("value")
    context = None
    if d is not None:
        context = {"name": "directional pressure toward the sold strikes (unvalidated)", "value": round(clip(sign * d), 2),
                   "text": f"evidence leans {dirn['label']} ({d:+.2f}); not part of the risk score"}  # fmt: skip
    if not parts:
        return {"risk": None, "label": "Insufficient evidence", "reasons": [], "context": context}
    r = round(50 + 50 * sum(x for _, x, _ in parts) / len(parts), 1)
    label = "Low" if r < 35 else "Moderate" if r < 55 else "Elevated" if r < 75 else "High"
    return {"risk": r, "label": label, "reasons": [{"name": n, "value": round(x, 2), "text": t} for n, x, t in parts], "context": context}


# ------------------------------------------------------------------ buyer
def buyer_components(ev: Mapping[str, Any], dirn: Mapping[str, Any]) -> list[dict[str, Any]]:
    c: list[dict[str, Any]] = []
    i30 = ev["iv_atm_30"]
    c.append(comp("iv_up", "ATM IV expansion", 10, None if i30 is None else i30 / 1.0, f"ATM IV {i30:+.2f} vol points over the recent window" if i30 is not None else "no IV change window", "straddle IV"))
    tags = ev["reg30"]
    v = 1.0 if "both_expanding" in tags else 0.4 if any(t in tags for t in ("put_expanding_faster", "call_expanding_faster")) else -1.0 if "both_contracting" in tags else 0.0
    c.append(comp("iv_mom", "Call/put IV momentum", 6, v if ev["dce30"] is not None else None, (("; ".join(tags) or "no clear call/put IV pattern") + " (30 min)") if ev["dce30"] is not None else "needs a 30-minute window of call and put IV (not enough samples yet)", "straddle IV"))
    a = ev["accel"]
    c.append(comp("rv_accel", "Realised-vol acceleration", 12, None if a is None else (a - 1) / 0.6, f"last 15 minutes {a:.2f}x the previous 15" if a is not None else "needs 30 minutes of stored spots", "straddle realised vs implied"))
    e30 = ev["eff30"]
    c.append(comp("directional", "Directional price movement", 12, None if e30 is None else (e30 - 0.3) / 0.4, f"net move is {e30 * 100:.0f}% of the path travelled over 30 minutes" if e30 is not None else "needs 30 minutes of stored spots", "stored spot"))
    cfg = ev["config"]
    gv = [{"potential gamma-driven acceleration": 1.0, "increasing movement": 0.6, "suppressed movement": -0.8, "price stabilisation around gamma concentration": -0.6}.get(t) for t in cfg]
    gvf = [x for x in gv if x is not None]
    c.append(comp("gamma", "Gamma configuration (modelled)", 8, (sum(gvf) / len(gvf)) if gvf else (0.0 if cfg else None), "; ".join(cfg) or "no GEX", "GEX (modelled exposure)", proxy=True))
    rel = ev["gex"].get("relationship") if ev["gex"] else None
    c.append(comp("gex_mig", "GEX migration", 5, None if rel is None else {"amplifying": 0.6, "stabilising": -0.4}.get(rel, 0.0), f"GEX vs spot over 15 min: {rel}", "GEX (modelled exposure)", proxy=True))
    of = ev["orderflow"]
    c.append(comp("cvd", "Futures CVD (proxy)", 7, None if of is None else abs(of) / 60 - 0.2, f"order-flow group score {of:+.0f}; conviction in either direction counts, its direction is in the directional readings" if of is not None else "no flow group", "Market Intelligence order-flow engine", proxy=True))
    vp = ev["vwap_pct"]
    c.append(comp("vwap", "Futures VWAP", 5, None if vp is None else (0.6 if abs(vp) >= 0.3 else -0.3), f"future is {vp:+.2f}% from its VWAP ({ev['vwap_side']})" if vp is not None else "no futures VWAP", "Market Intelligence futures VWAP"))
    h = ev["heavy15"]
    c.append(comp("heavy", "NIFTY heavyweight CVD (proxy)", 6, None if h is None else abs(h) / 70 - 0.2, f"heavyweight CVD 15-minute score {h:+.0f}" if h is not None else "no heavyweight reading", "Market Intelligence heavyweight engine", proxy=True))
    pos = ev["positioning"]
    c.append(comp("smart_oi", "Smart OI / positioning", 5, None if pos is None else abs(pos) / 60 - 0.2, f"positioning group score {pos:+.0f} (OI does not say who is long or short)" if pos is not None else "no positioning", "Market Intelligence positioning engine", proxy=True))
    sk = ev["skew_change"]
    c.append(comp("skew", "Skew movement", 4, None if sk is None else abs(sk) / 2 - 0.2, f"25-delta skew changed {sk:+.2f} vol points" if sk is not None else "no skew history", "straddle IV"))
    pr = ev.get("prem_rolling")
    c.append(comp("prem_path", "ATM straddle premium path", 8, None if pr is None else _prem_value(pr), _prem_text("At-the-money straddle (roll-adjusted)", pr) + " (a rising premium is what a buyer is paid for)" if pr is not None else "no premium series yet", "straddle series (stored minutes)"))
    ed = ev["eff"] or {}
    eff = ed.get("efficiency_pct")
    c.append(comp("prem_exp", "Premium expansion", 8, None if eff is None else (50 - eff) / 50 * _conf(ed), f"recent decay efficiency {eff:.0f}% (low or negative means premium is holding or expanding){_conf_note(ed)}" if eff is not None else (ed.get("reason") or "no efficiency"), "straddle attribution"))
    gp = ev["rv_gap"]
    c.append(comp("justified", "Movement justifies the premium paid", 12, None if gp is None else -gp / 6, f"realised minus implied {-gp:+.1f} vol points (a buyer needs actual movement to exceed what the premium already prices)" if gp is not None else "no realised window", "straddle realised vs implied"))
    return c


def buyer(ev: Mapping[str, Any], dirn: Mapping[str, Any], sell: Mapping[str, Any]) -> dict[str, Any]:
    comps = buyer_components(ev, dirn)
    base = score(comps)
    by = {c["id"]: c for c in base["components"]}

    def sub(ids: Sequence[str]) -> dict[str, Any]:
        r = score([by[i] for i in ids])
        sc = r["score"]
        return {"score": sc, "state": "insufficient evidence" if sc is None else "active" if sc >= 60 else "partial" if sc >= 45 else "inactive", "uses": [by[i]["name"] for i in ids]}

    types = {
        "directional": {**sub(["directional", "cvd", "vwap", "heavy", "smart_oi", "justified"]), "name": "Directional option-buying environment", "direction": dirn["label"]},
        "vol_expansion": {**sub(["iv_up", "iv_mom", "rv_accel", "skew", "prem_exp", "prem_path", "justified"]), "name": "Volatility-expansion buying environment"},
        "gamma_momentum": {**sub(["gamma", "gex_mig", "rv_accel", "directional"]), "name": "Gamma-driven momentum environment"},
        "low_movement": {"score": sell["short_straddle"]["score"], "state": "decay-favourable" if (sell["short_straddle"]["score"] or 0) >= 60 else "not prominent" if sell["short_straddle"]["score"] is not None else "insufficient evidence",
                         "name": "Low-movement premium-decay environment", "uses": sell["short_straddle"]["uses"], "note": "This is the seller's short-straddle assessment: when it is high, buyers are fighting decay."},
    }  # fmt: skip
    expansion_only = (by["iv_up"]["value"] or 0) > 0.3 and (by["justified"]["value"] is not None and by["justified"]["value"] < 0)
    return {"score": base["score"], "class": "Insufficient evidence" if base["score"] is None else _band(base["score"], BUYER_CLASSES), "coverage": base["coverage"], "components": base["components"], "types": types,
            "direction": dirn, "premium_check": {"iv_rising_but_not_justified": bool(expansion_only), "text": "IV is rising but realised movement is below what the premium prices: rising IV alone does not justify paying for options." if expansion_only else "No conflict between rising IV and realised movement is flagged."},
            "note": PROVISIONAL + " IV rising is not a buy signal: the premium paid has to be justified by movement."}  # fmt: skip


# ------------------------------------------------------------------ comparison, reasons, invalidation
def _top(comps: Sequence[Mapping[str, Any]], n: int = 3) -> list[Mapping[str, Any]]:
    return sorted((c for c in comps if c["contribution"] is not None), key=lambda c: -abs(c["contribution"]))[:n]


def compare(sell: Mapping[str, Any], buy: Mapping[str, Any], ev: Mapping[str, Any]) -> dict[str, Any]:
    s, b = sell["score"], buy["score"]
    if s is None or b is None:
        verdict, text = "insufficient evidence", "Too many inputs are missing for one of the two scores (below half of the weight available), so no environment is stated."
    elif s >= 60 and b >= 60:
        verdict, text = "conflicting", "Both scores are high: different opportunity types or conflicting components are at work (see the shared and opposing components below); neither side is clean."
    elif s < 40 and b < 40:
        verdict, text = "uncertain or unattractive", "Both scores are low: conditions are uncertain or unattractive for both sides; nothing is forced."
    elif s >= 55 and s >= b + 20:
        verdict, text = "favours sellers", "Premium-decay conditions currently favour sellers, subject to the risk flags and checks shown."
    elif b >= 55 and b >= s + 20:
        verdict, text = "favours selective buying", "Volatility expansion and directional movement favour selective option buying; the premium must still be justified by movement."
    else:
        verdict, text = "mixed", "Neither side has a clear edge in the evidence."
    both = []
    for cs in sell["components"]:
        for cb in buy["components"]:
            if cs["id"] == cb["id"] and cs["value"] is not None and cb["value"] is not None and cs["value"] * cb["value"] > 0.1:
                both.append(cs["name"])
    return {"verdict": verdict, "text": text, "seller_score": s, "buyer_score": b, "top_seller": [{"name": c["name"], "contribution": c["contribution"], "text": c["text"]} for c in _top(sell["components"])],
            "top_buyer": [{"name": c["name"], "contribution": c["contribution"], "text": c["text"]} for c in _top(buy["components"])], "same_sign_in_both": both,
            "conflicting_seller": [c["name"] for c in sell["components"] if c["value"] is not None and c["value"] <= -0.3], "conflicting_buyer": [c["name"] for c in buy["components"] if c["value"] is not None and c["value"] <= -0.3]}  # fmt: skip


def invalidation(sell: Mapping[str, Any], buy: Mapping[str, Any], ev: Mapping[str, Any], cmp: Mapping[str, Any]) -> list[str]:
    out: list[str] = []
    v = cmp["verdict"]
    if v in ("favours sellers", "mixed") or (sell["score"] or 0) >= 55:
        out += ["Realised volatility over 15 minutes rises above the implied vol (today implied minus realised: " + (f"{ev['rv_gap']:+.1f}" if ev["rv_gap"] is not None else "n/a") + ")",
                "ATM IV rises by 1 vol point or more within 15 minutes", "Decay efficiency over the last 30 minutes falls below 20% of theta",
                "Spot moves beyond the modelled gamma flip or the largest OI walls"]  # fmt: skip
    if v in ("favours selective buying", "mixed") or (buy["score"] or 0) >= 55:
        out += ["Realised volatility falls back below implied (the premium paid stops being justified)", "ATM IV starts contracting while spot stalls",
                "The 30-minute path efficiency falls under 0.3 (movement stops being one-way)", "Futures CVD, VWAP and heavyweight CVD stop agreeing on direction"]  # fmt: skip
    if not out:
        out = ["Missing inputs return: the assessment is not stated while coverage is below half of the weight"]
    return out


def positioning_read(ev: Mapping[str, Any]) -> dict[str, Any]:
    """Whether stored OI positioning supports or contradicts a premium-decay environment. OI does not say who bought or sold, so every line is hedged."""
    opt = ev["opt"]
    spot, ce_k, pe_k = ev["spot"], num(opt.get("max_ce_oi_strike")), num(opt.get("max_pe_oi_strike"))
    pcr, dce, dpe = num(opt.get("pcr_oi")), num(opt.get("ce_oi_change")), num(opt.get("pe_oi_change"))
    lines: list[str] = []
    supports: bool | None = None
    if spot and ce_k and pe_k:
        supports = pe_k < spot < ce_k
        lines.append(f"Largest put OI {pe_k:g} below and largest call OI {ce_k:g} above spot: spot sits inside the OI range, which is consistent with range-bound premium decay (potential, not proof)." if supports
                     else f"Spot {spot:.0f} is outside the largest-OI range ({pe_k:g} to {ce_k:g}): positioning does not frame a range for premium decay.")  # fmt: skip
    if pcr is not None:
        lines.append(f"PCR (OI) {pcr:.2f}: " + ("near balance" if 0.7 <= pcr <= 1.3 else "lopsided") + "; PCR alone is not a direction call.")
    if dce is not None and dpe is not None:
        lines.append(f"OI change today: calls {dce:+,.0f}, puts {dpe:+,.0f} units. An OI increase is not classified as buying or selling without more evidence.")
    if not lines:
        return {"status": "UNAVAILABLE", "supports": None, "lines": ["No stored positioning reading is available."]}
    return {"status": "AVAILABLE", "supports": supports, "lines": lines}


def assess(a: Mapping[str, Any], mi: Mapping[str, Any], recent_seller: Sequence[float | None] = ()) -> dict[str, Any]:
    """Both environments for the current minute from the straddle analysis ``a`` and the Market Intelligence summary ``mi``."""
    ev = evidence(a, mi)
    ev["sd_pts"] = g(a, "realised_vs_implied", "implied_daily_sd_pts")
    dirn = direction(ev)
    sell = seller(ev, dirn, recent_seller)
    buy = buyer(ev, dirn, sell)
    cmp = compare(sell, buy, ev)
    keep = ("orderflow", "heavy15", "cvd", "vwap_pct", "positioning")
    return {"evidence": {k: ev[k] for k in keep}, "positioning": positioning_read(ev), "seller": sell, "buyer": buy, "comparison": cmp, "invalidation": invalidation(sell, buy, ev, cmp), "direction": dirn,
            "sources": {"seller_inputs": sorted({c["source"] for c in sell["components"]}), "buyer_inputs": sorted({c["source"] for c in buy["components"]})},
            "proxies": ["CVD (quote and tick rule estimate, no trade tape)", "GEX (modelled exposure, assumed dealer sign)", "OI changes (do not identify who bought or sold)"], "weights_note": PROVISIONAL}  # fmt: skip


# ------------------------------------------------------------------ the pre-flight radar
RADAR_PREM_MAX_PTS = 0.0  # provisional: the roll-adjusted at-the-money premium must not have risen over the last 15 minutes (any rise fails the gate)
RADAR_IV_MAX_PTS = 0.1  # provisional: the at-the-money IV may not have risen by more than this many vol points in 15 minutes
RADAR_FLIP_BUFFER_PTS = 15.0  # provisional: spot within this many points below the modelled gamma flip still counts as calm
RADAR_STOP_PCT = 18.0  # provisional reference stop: premium this percent above the premium sold
RADAR_RESTRIKE_PTS = 35.0  # provisional reference re-strike distance (points from the strike)
RADAR_NOTE = "Thresholds are provisional working values, not validated on enough recorded days; the gamma flip is a modelled level. A description of the straddle right now, not a trade signal."
_CONVEXITY_KEY = "gamma exposure (realised convexity)"
_REASON_NAMES = {"ACTIVE_SHORT_SQUEEZE": "SHORT SQUEEZE", "VWAP_TREND_DETACHMENT": "VWAP TREND RUNAWAY", "IB_EXPANSION_TREND": "WIDE OPENING RANGE"}


def _worst(sel: Mapping[str, Any], n: int = 2) -> list[str]:
    """The names of the seller-score readings that cost the most points (the two largest negative contributions), with their points."""
    cs = [c for c in sel.get("components") or [] if isinstance(c, Mapping) and isinstance(c.get("contribution"), (int, float)) and c["contribution"] < 0]
    return [f"{c['name']} {c['contribution']:+.1f}" for c in sorted(cs, key=lambda c: c["contribution"])[:n]]


def _thin(ev: Mapping[str, Any]) -> str:
    """A caution for a realised-vol reading made from few returns (early in the session; the opening minutes are not counted)."""
    return f" (early in the session: only {ev.get('rv_n')} minutes of returns, the opening minutes before 09:20 not counted)" if ev.get("rv_thin") and ev.get("rv_n") is not None else ""


def _gate(status: str, label: str, **extra: Any) -> dict[str, Any]:
    return {"status": status, "label": label, **extra}


def _join(names: Sequence[str]) -> str:
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " & " + names[-1]


def evaluate_preflight(a: Mapping[str, Any], env: Mapping[str, Any], live_regime: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Four gates to read before selling the at-the-money straddle by hand, from the live analysis ``a``, the seller environment ``env`` (see ``assess``) and the live regime
    (``live_regime.evaluate_live_regime``):

      premium_decay     the roll-adjusted at-the-money premium over the last 15 minutes: falling or flat passes, rising fails;
      volatility_shock  the at-the-money IV over the last 15 minutes: up to RADAR_IV_MAX_PTS vol points passes, more fails;
      regime_squeeze    FAIL when a short squeeze is on or two of (squeeze, VWAP runaway, wide opening range) are; WARN when a VWAP runaway or a wide opening range is the only trend flag, or only the put floor is advancing
                        (one provisional, unvalidated flag alone does not block: D224); PASS when none is on, UNKNOWN when no reading could be formed;
      structure_flip    spot against the modelled gamma flip: above it (or within RADAR_FLIP_BUFFER_PTS below) passes, further below warns.
    Gamma cost above CONVEXITY_RATIO x theta and a negative decay efficiency (the seller flags) also block, and are named in the headline. A gate whose input does not exist is UNKNOWN: never a pass,
    never a failure; nothing failing with something unknown is GREY (INCOMPLETE), not green. RED blocks, YELLOW is a warning only, GREEN needs all four gates to pass, GREY (NO_LIVE_DATA) is a stored or
    stale session. ``trade_setup`` repeats the current at-the-money prices and two reference levels (a stop and a re-strike distance): fixed working values, not a recommendation."""
    tracker = a.get("tracker") or {}
    flags_ = {f["id"] for f in ((env.get("seller") or {}).get("flags") or []) if isinstance(f, Mapping) and "id" in f}
    spot = num((a.get("spot") or [None])[-1]) if a.get("spot") else None
    strike = tracker.get("atm_now")
    ce, pe = num(g(tracker, "rolling", "ce", "current")), num(g(tracker, "rolling", "pe", "current"))
    total = num(g(tracker, "rolling", "straddle", "current"))
    if total is None and ce is not None and pe is not None:
        total = round(ce + pe, 2)
    stop_at = None if total is None or total <= 0 else round(total * (1 + RADAR_STOP_PCT / 100), 1)
    setup = {"strike": strike, "spot": spot, "combined_premium": total, "ce_price": ce, "pe_price": pe, "stop_loss_pts": stop_at, "stop_loss_pct": RADAR_STOP_PCT, "re_strike_pts": RADAR_RESTRIKE_PTS}
    lr = live_regime or {}
    regime = {"label": lr.get("label"), "ib_ratio": g(lr, "ib", "ratio"), "flags": lr.get("flags") or []}

    live, stale, age = bool(g(a, "quality", "live")), bool(g(a, "quality", "stale")), g(a, "quality", "age_minutes")  # the analysis keeps these under "quality"
    if not live or stale:
        why = "this is a stored session, not the live straddle" if not live else f"the newest stored sample is {age} minutes old"
        return {"verdict": "NO_LIVE_DATA", "badge": "GREY", "headline": "NO LIVE READING", "summary": f"No live reading: {why}.", "gates": {}, "reasons": [], "unknown": [], "regime": regime,
                "trade_setup": setup, "note": RADAR_NOTE}  # fmt: skip

    pr = premium_path(a, "rolling")
    prem = None if pr is None else pr["pts"].get("15")
    iv15 = num(g(a, "iv", "moves", "rolling_atm", "15"))
    flip = num(g(a, "structure", "gex", "flip"))
    eff = evidence(a, {}).get("eff") or {}
    gamma_pts, theta_pts = (eff.get("causes") or {}).get(_CONVEXITY_KEY), eff.get("expected_decay")

    gates: dict[str, dict[str, Any]] = {}
    if prem is None:
        gates["premium_decay"] = _gate("UNKNOWN", "Not enough stored minutes", val_15m=None)
    elif prem <= RADAR_PREM_MAX_PTS:
        gates["premium_decay"] = _gate("PASS", f"Decaying ({prem:+.1f} pts)", val_15m=prem)
    else:
        gates["premium_decay"] = _gate("FAIL", f"Expanding ({prem:+.1f} pts)", val_15m=prem)
    if iv15 is None:
        gates["volatility_shock"] = _gate("UNKNOWN", "No IV reading", val_15m=None)
    elif iv15 <= RADAR_IV_MAX_PTS:
        gates["volatility_shock"] = _gate("PASS", f"{'Cooling' if iv15 <= 0 else 'Stable'} ({iv15:+.2f} vol)", val_15m=iv15)
    else:
        gates["volatility_shock"] = _gate("FAIL", f"IV spike ({iv15:+.2f} vol)", val_15m=iv15)
    on = {f["id"] for f in regime["flags"]}
    trend_on = [i for i in ("ACTIVE_SHORT_SQUEEZE", "VWAP_TREND_DETACHMENT", "IB_EXPANSION_TREND") if i in on]
    hard = trend_on if ("ACTIVE_SHORT_SQUEEZE" in on or len(trend_on) >= 2) else []  # what blocks: a squeeze, or two trend flags together
    if not lr or not lr.get("any_known"):
        gates["regime_squeeze"] = _gate("UNKNOWN", "No squeeze or regime reading yet")
    elif hard:
        gates["regime_squeeze"] = _gate("FAIL", "Active squeeze / trend" if "ACTIVE_SHORT_SQUEEZE" in on else "Trend day risk: " + ", ".join(_REASON_NAMES[i].lower() for i in trend_on), flags=trend_on)
    elif trend_on:  # a lone VWAP runaway or wide opening range: a warning, not a block
        gates["regime_squeeze"] = _gate("WARN", "Trend day risk: " + ", ".join(_REASON_NAMES[i].lower() for i in trend_on), flags=trend_on)
    elif "PUT_FLOOR_ADVANCING" in on:
        gates["regime_squeeze"] = _gate("WARN", "Put floor advancing", flags=["PUT_FLOOR_ADVANCING"])
    elif lr.get("label") == "DECAY_FAVOURED":
        gates["regime_squeeze"] = _gate("PASS", f"Mean-reverting box (opening range {g(lr, 'ib', 'ratio'):.2f}x the daily move)", flags=[])
    else:
        known = sum(1 for k in ("ib", "squeeze", "put_floor", "vwap") if g(lr, k, "status") == "ok")
        gates["regime_squeeze"] = _gate("PASS", f"No squeeze or trend flag ({known} of 4 readings available)", flags=[])
    if flip is None or spot is None:
        gates["structure_flip"] = _gate("UNKNOWN", "No modelled gamma flip", flip=flip, spot=spot)
    else:
        label = f"Spot {spot - flip:+.0f} pts from flip ({flip:.0f})"
        gates["structure_flip"] = _gate("PASS" if spot >= flip - RADAR_FLIP_BUFFER_PTS else "WARN", label, flip=flip, spot=spot)

    sel = env.get("seller") or {}
    sscore, sclass = num(sel.get("score")), sel.get("class")
    if sscore is None:
        gates["seller_environment"] = _gate("UNKNOWN", "No seller score yet")
    elif sclass == "High risk":
        gates["seller_environment"] = _gate("FAIL", f"Seller environment {sclass} ({sscore:.0f})", score=sscore, top=_worst(sel))
    elif sclass == "Unfavourable":
        gates["seller_environment"] = _gate("WARN", f"Seller environment {sclass} ({sscore:.0f})", score=sscore, top=_worst(sel))
    else:
        gates["seller_environment"] = _gate("PASS", f"Seller environment {sclass} ({sscore:.0f})", score=sscore, top=[])
    reasons: list[str] = [_REASON_NAMES[i] for i in hard]
    if gates["seller_environment"]["status"] == "FAIL":
        reasons.append("SELLER ENVIRONMENT HIGH RISK")
    if gates["premium_decay"]["status"] == "FAIL" or "premium_expansion" in flags_:
        reasons.append("PREMIUM EXPANSION")
    if gates["volatility_shock"]["status"] == "FAIL":
        reasons.append("IV SPIKE")
    if "convexity_blowout" in flags_ and gamma_pts is not None and theta_pts is not None:
        reasons.append("GAMMA CONVEXITY")
    detail = [f["message"] for f in regime["flags"] if f["id"] in hard]
    if gates["premium_decay"]["status"] == "FAIL":
        detail.append(f"Premiums are expanding ({prem:+.1f} pts in 15 min).")
    if gates["volatility_shock"]["status"] == "FAIL":
        detail.append(f"ATM IV is spiking ({iv15:+.2f} vol points in 15 min).")
    if gates["seller_environment"]["status"] == "FAIL":
        detail.append(f"The seller environment score is {sscore:.0f} (High risk): " + "; ".join(gates["seller_environment"]["top"]) + ".")
    if "convexity_blowout" in flags_ and gamma_pts is not None and theta_pts is not None:
        detail.append(f"Realised convexity (+{gamma_pts:.1f} pts) is overwhelming theta ({theta_pts:.1f} pts).")
    unknown = [k for k, v in gates.items() if v["status"] == "UNKNOWN"]
    warns = [k for k, v in gates.items() if v["status"] == "WARN"]
    if reasons:
        verdict, badge = "BLOCKED", "RED"
        headline = "DO NOT SELL — " + _join(reasons) + " DETECTED"
        summary = " ".join(detail) if detail else "Do not sell."
    elif warns:
        verdict, badge = "SELECTIVE", "YELLOW"
        headline = "SELECTIVE / CAUTION"
        soft = [f["message"] for f in regime["flags"] if f["id"] in trend_on and f["id"] not in hard]
        put_floor = "PUT_FLOOR_ADVANCING" in on
        summary = " ".join(
            ["Spot is below the modelled gamma flip, where moves tend to amplify." if "structure_flip" in warns else "",
             f"The seller environment score is {sscore:.0f} (Unfavourable): " + "; ".join(gates["seller_environment"]["top"]) + "." if "seller_environment" in warns else "", *soft,
             "Put open interest is being added much faster than call open interest while the index rises." if put_floor else ""]).strip()  # fmt: skip
    elif unknown:
        verdict, badge = "INCOMPLETE", "GREY"
        headline = "NO ALL-CLEAR — INCOMPLETE DATA"
        summary = "Nothing fails, but not every gate could be read (" + ", ".join(unknown) + "): no all-clear."
    else:
        verdict, badge = "ALL_CLEAR_TO_SELL", "GREEN"
        headline = "ALL CLEAR — PREMIUMS DECAYING (OK TO SELL MANUALLY)"
        summary = f"Premiums are decaying, IV is calm, no squeeze or trend flag is on, spot is above the modelled gamma flip and the seller environment is {sclass} ({sscore:.0f})."
    return {"verdict": verdict, "badge": badge, "headline": headline, "summary": summary, "gates": gates, "reasons": reasons, "unknown": unknown, "regime": regime, "trade_setup": setup, "note": RADAR_NOTE}
