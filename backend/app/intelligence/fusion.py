"""Sentiment fusion, regime, scenarios and divergences for the NIFTY 50 market-intelligence dashboard (pure functions, no I/O).

Everything here consumes outputs the application already computes (see docs/market-intelligence-audit.md for the map): nothing is
recalculated from raw data except small combinations of those outputs, and every term is returned as evidence. A term whose input is
missing is *unavailable*: it is left out of its engine's average, and an engine with no available term is left out of the fusion
(its weight is not given a neutral score). Scores are in [-100, +100]; +100 is bullish evidence.

    Overall = sum(score_e x weight_e) / sum(weight_e over engines that have a score)
    coverage = sum(weight_e over engines that have a score) / sum(all weights)

Confidence is separate and is a product of three shown parts (coverage, agreement, freshness); it is not a probability.
Thresholds and weights are provisional judgement calls, not fitted to history.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from typing import Any

#: default engine weights (percent); overridable through ``Settings.intelligence_weights``
DEFAULT_WEIGHTS: dict[str, float] = {"futures": 25.0, "options": 20.0, "gex": 15.0, "heavyweight": 15.0, "volatility": 10.0, "structure": 15.0}
ENGINE_NAMES = {
    "futures": "Futures positioning and order flow", "options": "Options positioning and Smart OI", "gex": "Gamma exposure (GEX)",
    "heavyweight": "Heavyweight participation", "volatility": "Volatility intelligence", "structure": "Market structure and breadth",
}
ENGINE_LINKS = {
    "futures": "/tools/future-flow", "options": "/tools/strike-positioning", "gex": "/tools/gamma-exposure", "heavyweight": "/tools/future-flow",
    "volatility": "/tools/volatility-skew", "structure": "/tools/market-movers",
}
MIN_COVERAGE = 0.55
MIN_ENGINES = 3
#: (lower bound, label), checked from the top
CLASSES: list[tuple[float, str]] = [(70, "Strong Bullish"), (35, "Bullish"), (15, "Mild Bullish"), (-14.999, "Neutral"), (-34.999, "Mild Bearish"), (-69.999, "Bearish")]
STALE_LIVE_S = 120.0   # a live-feed input older than this is stale
STALE_STORED_S = 420.0  # a stored-chain input (one sample a minute, solved on demand) older than this is stale


def clip(x: float, lim: float = 100.0) -> float:
    return max(-lim, min(lim, x))


def squash(x: float | None, scale: float) -> float | None:
    """tanh scaling to [-100, 100]: ``scale`` is the size of reading that counts as strong evidence (about 76 points)."""
    return None if x is None else 100.0 * math.tanh(x / scale)


def g(d: Any, *path: str) -> Any:
    """Nested dict lookup that returns None instead of raising."""
    for k in path:
        if not isinstance(d, Mapping) or k not in d:
            return None
        d = d[k]
    return d


def num(x: Any) -> float | None:
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) else None


def classify(score: float | None) -> str:
    if score is None:
        return "Unavailable"
    for lo, name in CLASSES:
        if score >= lo:
            return name
    return "Strong Bearish"


def tilt(score: float | None) -> str:
    return "unavailable" if score is None else "bullish" if score >= 15 else "bearish" if score <= -15 else "neutral"


class Term:
    """One piece of evidence inside an engine."""

    def __init__(self, name: str, score: float | None, detail: str, *, proxy: bool = False) -> None:
        self.name, self.score, self.detail, self.proxy = name, None if score is None else round(clip(score), 1), detail, proxy

    def public(self) -> dict[str, Any]:
        return {"name": self.name, "score": self.score, "detail": self.detail, "available": self.score is not None, "proxy": self.proxy}


def engine(key: str, terms: Sequence[Term], inputs: Sequence[str], status: Mapping[str, Mapping[str, Any]], *, extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """An engine's score is the plain average of its available terms; the evidence lists are the terms on each side of zero."""
    avail = [t for t in terms if t.score is not None]
    score = None if not avail else round(sum(t.score for t in avail if t.score is not None) / len(avail), 1)
    ages = [num(g(status, i, "age_s")) for i in inputs]
    errs = [i for i in inputs if g(status, i, "ok") is False]
    live = key in ("futures", "heavyweight")
    limit = STALE_LIVE_S if live else STALE_STORED_S
    known = [a for a in ages if a is not None]
    worst = max(known) if known else None
    fresh = None if score is None else (not errs and (worst is None or worst <= limit))
    return {
        "key": key, "name": ENGINE_NAMES[key], "score": score, "class": classify(score), "tilt": tilt(score), "link": ENGINE_LINKS[key],
        "terms": [t.public() for t in terms],
        "supporting": [f"{t.name}: {t.detail}" for t in avail if t.score is not None and abs(t.score) >= 10 and (score or 0) * t.score > 0],
        "conflicting": [f"{t.name}: {t.detail}" for t in avail if t.score is not None and abs(t.score) >= 10 and (score or 0) * t.score < 0],
        "unavailable": [f"{t.name}: {t.detail}" for t in terms if t.score is None],
        "freshness": {"fresh": fresh, "age_s": worst, "inputs": list(inputs), "failed": errs},
        **(extra or {}),
    }


# ------------------------------------------------------------------------------------------------ engines
def buildup(price_chg: float | None, oi_chg: float | None) -> str:
    """The four-way futures reading (the same rule as ``buildup`` in frontend/src/lib/analytics.ts)."""
    if price_chg is None or oi_chg is None or price_chg == 0 or oi_chg == 0:
        return "unchanged" if price_chg is not None and oi_chg is not None else "missing"
    if price_chg > 0:
        return "long buildup" if oi_chg > 0 else "short covering"
    return "short buildup" if oi_chg > 0 else "long unwinding"


def _fut_window(fut: Mapping[str, Any] | None, minutes: int = 15) -> tuple[float | None, float | None, float | None, float | None]:
    """(price change %, OI change, future now, OI now) between the newest futures sample and the one about ``minutes`` earlier."""
    times, price, oi = g(fut, "times"), g(fut, "future"), g(fut, "oi")
    if not (isinstance(times, list) and isinstance(price, list) and isinstance(oi, list) and times):
        return None, None, None, None
    from datetime import datetime

    def ts(i: int) -> datetime | None:
        try:
            return datetime.fromisoformat(times[i])
        except (TypeError, ValueError):
            return None

    j = max((i for i in range(len(times)) if price[i] is not None), default=None)
    if j is None or ts(j) is None:
        return None, None, None, None
    t1 = ts(j)
    k = None
    for i in range(j - 1, -1, -1):
        t0 = ts(i)
        if t0 is not None and price[i] is not None and (t1 - t0).total_seconds() >= minutes * 60:  # type: ignore[operator]
            k = i
            break
    if k is None:
        return None, None, price[j], oi[j] if j < len(oi) else None
    pc = (price[j] / price[k] - 1) * 100 if price[k] else None
    oc = None if oi[j] is None or oi[k] is None else float(oi[j] - oi[k])
    return pc, oc, price[j], oi[j]


def futures_engine(inp: Mapping[str, Any], status: Mapping[str, Any]) -> dict[str, Any]:
    fut = inp.get("futures")
    flow = g(inp.get("market"), "flow", "futures")
    vwap = g(inp.get("intraday"), "vwap")
    pc, oc, _, _ = _fut_window(fut, 15)
    bu = buildup(pc, oc)
    base = {"long buildup": 60.0, "short buildup": -60.0, "short covering": 30.0, "long unwinding": -30.0}.get(bu)
    terms = [Term("Price and open interest (15 min)", base, f"{bu}: price {pc:+.2f}%, OI {oc:+,.0f}" if base is not None and pc is not None and oc is not None else "needs two futures samples 15 minutes apart")]
    cvd, share, stale = num(g(flow, "cvd_pct")), num(g(flow, "classified_share")), g(flow, "stale")
    ok_cvd = cvd is not None and stale is not True and (share is None or share >= 0.5)
    terms.append(Term("Futures CVD (estimated)", squash(cvd, 25) if ok_cvd else None,
                      f"session CVD {cvd:+.1f}% of classified volume (estimate by the quote and tick rule, not a trade tape)" if cvd is not None else "no futures flow tracked", proxy=True))
    dist_atr, dist_pct = num(g(vwap, "distance_atr")), num(g(vwap, "distance_pct"))
    vs = squash(dist_atr, 1.0) if dist_atr is not None else squash(dist_pct, 0.2)
    terms.append(Term("Price versus VWAP", vs, f"future {g(vwap, 'side')} its VWAP by {dist_pct:+.3f}% (slope {g(vwap, 'slope_pts_per_15m')} pts / 15 min)" if dist_pct is not None else "no VWAP (needs the future's average traded price)"))
    imb = num(g(flow, "depth_imbalance"))
    terms.append(Term("Order-book depth imbalance", squash(imb, 0.3) if stale is not True else None, f"bid minus ask depth share {imb:+.2f}" if imb is not None else "no fresh depth", proxy=True))
    return engine("futures", terms, ["futures", "market", "intraday"], status, extra={"buildup": bu, "price_change_15m_pct": pc, "oi_change_15m": oc})


def options_engine(inp: Mapping[str, Any], status: Mapping[str, Any]) -> dict[str, Any]:
    o = g(inp.get("intraday"), "options") or {}
    chg = num(o.get("pcr_oi_change"))
    ce, pe = num(o.get("ce_oi_chg")), num(o.get("pe_oi_chg"))
    tot = (num(o.get("ce_oi")) or 0) + (num(o.get("pe_oi")) or 0)
    terms = [Term("PCR change since the first sample", squash(chg, 0.2), f"PCR {o.get('pcr_oi')} ({chg:+.3f} since open)" if chg is not None else "no PCR change yet")]
    terms.append(Term("OI added: puts minus calls", squash((pe - ce) / tot, 0.05) if ce is not None and pe is not None and tot else None,
                      f"put OI {pe:+,.0f}, call OI {ce:+,.0f} (ATM ±10 strikes)" if ce is not None and pe is not None else "no OI change"))
    dem = g(inp.get("positioning"), "demand") or []
    bull = {("CE", "otm"): ("Upside speculation",), ("PE", "otm"): ("Put writing",)}
    bear = {("CE", "otm"): ("Call writing",), ("PE", "otm"): ("Downside speculation",)}
    pts, notes = 0.0, []
    for d in dem:
        lab, key = d.get("label"), (d.get("side"), d.get("group"))
        if lab in bull.get(key, ()):
            pts += 35
            notes.append(f"{d['side']} {d['group']}: {lab}")
        elif lab in bear.get(key, ()):
            pts -= 35
            notes.append(f"{d['side']} {d['group']}: {lab}")
    has_label = any(d.get("label") not in (None, "INSUFFICIENT EVIDENCE") for d in dem)
    terms.append(Term("Strike demand labels (15 min)", pts if has_label or pts else None,
                      ("; ".join(notes) or "labels present, none directional") + " (OI does not identify who traded)" if dem else "no positioning comparison"))
    return engine("options", terms, ["intraday", "positioning"], status, extra={"pcr": o.get("pcr_oi"), "max_ce_oi_strike": o.get("max_ce_oi_strike"), "max_pe_oi_strike": o.get("max_pe_oi_strike")})


def gex_state(inp: Mapping[str, Any]) -> dict[str, Any]:
    pts = g(inp.get("gex"), "points") or []
    last = pts[-1] if pts else None
    if not last:
        return {"available": False}
    spot, net, flip = num(last.get("spot")), num(last.get("net")), num(last.get("flip"))
    dist = None if flip is None or not spot else (spot - flip) / spot * 100
    regime = "unknown" if net is None else ("near flip" if dist is not None and abs(dist) <= 0.2 else "positive" if net >= 0 else "negative")
    prev = None
    for p in reversed(pts[:-1]):
        a = num(p.get("net"))
        if a is not None and _minutes_between(p.get("at"), last.get("at")) >= 15:
            prev = p
            break
    d_net = None if prev is None or net is None or num(prev.get("net")) is None else net - float(prev["net"])
    scale = max(abs(net or 0), abs(num(prev.get("net")) or 0)) if prev else 0
    d_spot = None if prev is None or not num(prev.get("spot")) or not spot else (spot / float(prev["spot"]) - 1) * 100
    kind = "unavailable"
    if d_net is not None and d_spot is not None:
        spot_dir = 0 if abs(d_spot) < 0.05 else (1 if d_spot > 0 else -1)
        gex_dir = 0 if scale == 0 or abs(d_net) < 0.05 * scale else (1 if d_net > 0 else -1)
        kind = "none" if spot_dir == 0 or gex_dir == 0 else ("amplifying" if gex_dir < 0 else "stabilising")
    return {"available": True, "at": last.get("at"), "spot": spot, "net": net, "abs": num(last.get("abs")), "ce": num(last.get("ce")), "pe": num(last.get("pe")), "flip": flip,
            "flip_distance_pct": dist, "call_wall": num(last.get("call_wall")), "put_wall": num(last.get("put_wall")), "peak": num(last.get("peak")), "near_net": num(last.get("near_net")),
            "regime": regime, "net_change_15m": d_net, "net_change_pct": None if d_net is None or not scale else d_net / scale * 100, "spot_change_15m_pct": d_spot, "relationship": kind,
            "session": g(inp.get("gex"), "session"), "universe": g(inp.get("gex"), "universe") or "dynamic"}


def _minutes_between(a: Any, b: Any) -> float:
    from datetime import datetime

    try:
        return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() / 60
    except (TypeError, ValueError):
        return 0.0


def gex_engine(inp: Mapping[str, Any], status: Mapping[str, Any]) -> dict[str, Any]:
    st = gex_state(inp)
    if not st["available"]:
        return engine("gex", [Term("Spot versus the gamma flip", None, "no rebuilt GEX snapshot"), Term("Room to the walls", None, "no walls")], ["gex"], status, extra={"state": st})
    dist = st["flip_distance_pct"]
    spot, cw, pw = st["spot"], st["call_wall"], st["put_wall"]
    terms = [Term("Spot versus the gamma flip", squash(dist, 1.0), f"spot {dist:+.2f}% from the flip {st['flip']:.0f} (above = positive-gamma side, a model assumption)" if dist is not None else "no gamma flip within ±8%")]
    up, dn = (cw - spot if cw and spot else None), (spot - pw if pw and spot else None)
    asym = None if up is None or dn is None or up <= 0 or dn <= 0 else (up - dn) / (up + dn)
    terms.append(Term("Room to the walls", None if asym is None else asym * 60, f"call wall {cw:.0f} ({up:.0f} pts above), put wall {pw:.0f} ({dn:.0f} pts below)" if asym is not None else "walls not both on the expected side of spot"))
    return engine("gex", terms, ["gex"], status, extra={"state": st})


def heavyweight_engine(inp: Mapping[str, Any], status: Mapping[str, Any]) -> dict[str, Any]:
    stocks = g(inp.get("market"), "flow", "heavy5", "stocks") or []
    rows = {r.get("symbol"): r for r in (g(inp.get("market"), "nifty50", "stocks") or [])}
    idx = num(g(inp.get("market"), "index_change_pct"))
    used, num_w, den_w, pos, neg, pts, match, covered = [], 0.0, 0.0, 0, 0, 0.0, 0, 0
    for s in stocks:
        fl, w = s.get("flow") or {}, num(s.get("weight"))
        cvd, share = num(fl.get("cvd_pct")), num(fl.get("classified_share"))
        chg = num(s.get("change_pct"))
        rc = rows.get(s.get("symbol"), {})
        if num(rc.get("contribution")) is not None:
            pts += float(rc["contribution"])
        if chg is not None and idx is not None and chg * idx > 0:
            match += 1
        if chg is not None:
            covered += 1
        if w and cvd is not None and fl.get("stale") is not True and (share is None or share >= 0.5):
            s_i = math.tanh(cvd / 25)  # normalised per stock first: raw CVDs of stocks with different volumes are never added
            num_w += w * s_i
            den_w += w
            pos += cvd > 0
            neg += cvd < 0
            used.append(s.get("symbol"))
    agg = None if den_w == 0 else 100 * num_w / den_w
    n_pts = len([1 for s in stocks if num(rows.get(s.get("symbol"), {}).get("contribution")) is not None])
    terms = [Term("Weighted heavyweight CVD (estimated)", agg, f"{len(used)} of {len(stocks)} stocks, each normalised then weighted by index weight; {pos} positive, {neg} negative" if agg is not None else "no heavyweight flow", proxy=True),
             Term("Index points from the heavyweights", squash(pts, 0.15) if n_pts else None, f"{pts:+.3f}% of the index from {n_pts} stocks" if n_pts else "no contributions")]
    part = None if not covered else match / covered
    div = None
    if agg is not None and idx is not None and abs(idx) >= 0.1 and abs(agg) >= 15 and agg * idx < 0:
        div = "index and heavyweight flow disagree"
    return engine("heavyweight", terms, ["market"], status, extra={"metrics": {"weighted_cvd_score": None if agg is None else round(agg, 1), "positive_cvd": pos, "negative_cvd": neg, "stocks_used": used,
                                                                                  "aggregate_points_pct": round(pts, 4) if n_pts else None, "participation_ratio": None if part is None else round(part, 2), "divergence": div, "symbols": [s.get("symbol") for s in stocks]}})


def volatility_engine(inp: Mapping[str, Any], status: Mapping[str, Any]) -> dict[str, Any]:
    row = g(inp.get("momentum"), "table", "periods", "15") or {}
    atm = row.get("atm") or {}
    ce, pe = num(atm.get("ce_change")), num(atm.get("pe_change"))
    iv_chg = None if ce is None or pe is None else (ce + pe) / 2
    spot = num(row.get("spot_change_pct"))
    terms: list[Term] = []
    if iv_chg is None:
        terms.append(Term("ATM IV change against price (15 min)", None, "no snapshot 15 minutes earlier"))
    else:
        rising_with_spot = spot is not None and spot > 0.1 and iv_chg > 0
        terms.append(Term("ATM IV change against price (15 min)", 0.0 if rising_with_spot else -(squash(iv_chg, 0.5) or 0.0) * 0.6,
                          f"ATM IV {iv_chg:+.2f} pts, NIFTY {spot:+.2f}%: " + ("IV up with an advance is not read as directional" if rising_with_spot else "IV up leans bearish, IV down leans bullish") if spot is not None else f"ATM IV {iv_chg:+.2f} pts"))
    d25 = num(g(row, "d25", "momentum"))
    terms.append(Term("Call versus put IV momentum (25Δ, 15 min)", squash(d25, 0.4), f"CE IV change minus PE IV change {d25:+.2f} pts (positive: call IV strengthened relative to put IV)" if d25 is not None else "no 25Δ momentum"))
    return engine("volatility", terms, ["momentum", "skew"], status, extra={"atm_iv_change_15m": iv_chg, "spot_change_15m_pct": spot, "skew_25d": g(inp.get("skew"), "cards", "skew_25d"),
                                                                           "call_minus_put_25d": g(inp.get("skew"), "cards", "call_minus_put_25d"), "butterfly_25d": g(inp.get("skew"), "cards", "butterfly_25d")})


def structure_engine(inp: Mapping[str, Any], status: Mapping[str, Any]) -> dict[str, Any]:
    b = g(inp.get("market"), "nifty50", "breadth") or {}
    adb = num(b.get("ad_balance"))
    pa = num(g(inp.get("market"), "participation", "above_vwap", "pct_above"))
    orb = g(inp.get("market"), "participation", "opening_range") or {}
    orv = None if num(orb.get("pct_above_high")) is None or num(orb.get("pct_below_low")) is None else float(orb["pct_above_high"]) - float(orb["pct_below_low"])
    pos = num(g(inp.get("intraday"), "price", "position_in_range"))
    sc = num(g(inp.get("intraday"), "assessment", "score"))
    terms = [
        Term("Advance/decline balance", None if adb is None else adb * 100, f"balance {adb:+.2f} ({b.get('advancing')} up, {b.get('declining')} down of {b.get('covered')} covered)" if adb is not None else "no breadth"),
        Term("Stocks above their day VWAP", None if pa is None else (pa - 50) * 2, f"{pa:.0f}% of stocks above VWAP" if pa is not None else "no VWAP participation"),
        Term("Opening range", orv, f"{orb.get('pct_above_high')}% above the opening-range high, {orb.get('pct_below_low')}% below the low" if orv is not None else "opening range not yet formed"),
        Term("Position in the day's range", None if pos is None else (pos - 0.5) * 120, f"NIFTY at {pos:.0%} of the sampled day range" if pos is not None else "no range"),
        Term("Existing command-centre score", None if sc is None else sc * 100, f"the intraday rules-based score ({g(inp.get('intraday'), 'assessment', 'label')}), reused as it is" if sc is not None else "command-centre score unavailable"),
    ]
    return engine("structure", terms, ["market", "intraday"], status, extra={"breadth": {"advancing": b.get("advancing"), "declining": b.get("declining"), "covered": b.get("covered")}})


# ------------------------------------------------------------------------------------------------ fusion
def fuse(engines: Sequence[dict[str, Any]], weights: Mapping[str, float], min_coverage: float = MIN_COVERAGE, min_engines: int = MIN_ENGINES) -> dict[str, Any]:
    total = sum(max(0.0, weights.get(e["key"], 0.0)) for e in engines)
    avail = [e for e in engines if e["score"] is not None and weights.get(e["key"], 0.0) > 0]
    wa = sum(weights[e["key"]] for e in avail)
    coverage = 0.0 if total <= 0 else wa / total
    for e in engines:
        e["weight"] = weights.get(e["key"], 0.0)
        e["contribution"] = None if e["score"] is None or wa == 0 else round(e["score"] * e["weight"] / wa, 2)
    if len(avail) < min_engines or coverage < min_coverage or wa == 0:
        return {"score": None, "class": "INSUFFICIENT DATA – SENTIMENT UNRELIABLE", "coverage": round(coverage, 3), "engines_available": len(avail), "agreement": None, "freshness": None, "confidence": None,
                "reason": f"{len(avail)} engines available (need {min_engines}) with coverage {coverage:.0%} (need {min_coverage:.0%})"}
    score = sum(e["score"] * weights[e["key"]] for e in avail) / wa
    sign = 1 if score > 0 else -1 if score < 0 else 0
    agree_w = 0.0
    for e in avail:
        s = e["score"]
        agree_w += weights[e["key"]] * (0.5 if abs(s) < 15 else (1.0 if sign == 0 else (1.0 if s * sign > 0 else 0.0)))
    agreement = agree_w / wa
    fresh_w = sum(weights[e["key"]] for e in avail if e["freshness"]["fresh"])
    freshness = fresh_w / wa
    conf = 100 * min(1.0, coverage / 0.8) * agreement * freshness
    return {"score": round(score, 1), "class": classify(score), "coverage": round(coverage, 3), "engines_available": len(avail), "agreement": round(agreement, 3), "freshness": round(freshness, 3),
            "confidence": round(conf, 1), "confidence_parts": {"coverage_factor": round(min(1.0, coverage / 0.8), 3), "agreement": round(agreement, 3), "freshness": round(freshness, 3)}, "reason": None}


# ------------------------------------------------------------------------------------------------ regime
def volatility_regime(inp: Mapping[str, Any], iv_chg: float | None) -> str:
    base = g(inp.get("intraday"), "assessment", "volatility")
    if iv_chg is not None and iv_chg >= 0.3:
        return "Expansion" + (f" ({base} realised)" if base else "")
    if iv_chg is not None and iv_chg <= -0.3:
        return "Contraction" + (f" ({base} realised)" if base else "")
    return str(base) if base else "Unknown"


def regime(fused: Mapping[str, Any], engines: Mapping[str, Mapping[str, Any]], inp: Mapping[str, Any], gx: Mapping[str, Any]) -> dict[str, Any]:
    score, agree = fused["score"], fused["agreement"]
    fut = engines.get("futures", {})
    bu, pc = fut.get("buildup"), fut.get("price_change_15m_pct")
    vol = engines.get("volatility", {})
    iv_chg = vol.get("atm_iv_change_15m")
    cvd_terms = [t for t in fut.get("terms", []) if t["name"].startswith("Futures CVD") and t["available"]]
    cvd = cvd_terms[0]["score"] if cvd_terms else None
    evid: list[str] = []
    if score is None:
        return {"name": "Uncertain / Conflicting signals", "evidence": [fused.get("reason") or "insufficient data"], "volatility": volatility_regime(inp, iv_chg), "gamma": gx.get("regime", "unknown")}
    name = "Uncertain / Conflicting signals"
    if pc is not None and pc >= 0.15 and bu == "short covering" and (iv_chg is None or iv_chg <= 0) and (cvd is None or cvd > 0):
        name, evid = "Short squeeze", [f"price {pc:+.2f}% on falling futures OI (short covering)", "IV not rising", "estimated CVD positive" if cvd else "no CVD confirmation"]
    elif pc is not None and pc <= -0.15 and bu == "long unwinding" and (cvd is None or cvd < 0):
        name, evid = "Long liquidation", [f"price {pc:+.2f}% on falling futures OI (long unwinding)", "estimated CVD negative" if cvd else "no CVD confirmation"]
    elif agree is not None and agree < 0.45:
        name, evid = "Uncertain / Conflicting signals", [f"engines agree on only {agree:.0%} of the weight"]
    elif abs(score) >= 70 and (agree or 0) >= 0.7:
        name, evid = ("Strong bullish trend" if score > 0 else "Strong bearish trend"), [f"score {score:+.0f} with {agree:.0%} agreement"]
    elif abs(score) >= 35 and (agree or 0) >= 0.55:
        name, evid = ("Bullish trend" if score > 0 else "Bearish trend"), [f"score {score:+.0f} with {agree:.0%} agreement"]
    elif abs(score) >= 15:
        name, evid = ("Weak bullish" if score > 0 else "Weak bearish"), [f"score {score:+.0f}"]
    else:
        contraction = iv_chg is not None and iv_chg <= -0.3
        bo = g(inp.get("intraday"), "structure", "breakout") or {}
        if gx.get("regime") == "negative" or (g(inp.get("intraday"), "assessment", "volatility") == "High"):
            name, evid = "High volatility", [f"gamma {gx.get('regime')}, realised volatility {g(inp.get('intraday'), 'assessment', 'volatility')}"]
        elif contraction and bo.get("direction"):
            name, evid = "Breakout candidate", [f"IV contracting ({iv_chg:+.2f} pts) while price tests the opening range ({bo.get('direction')}, unconfirmed)"]
        elif contraction:
            name, evid = "Compression", [f"ATM IV {iv_chg:+.2f} pts, no directional edge (score {score:+.0f})"]
        else:
            name, evid = "Sideways / Range", [f"score {score:+.0f}; gamma {gx.get('regime', 'unknown')}"]
    return {"name": name, "evidence": evid, "volatility": volatility_regime(inp, iv_chg), "gamma": gx.get("regime", "unknown")}


# ------------------------------------------------------------------------------------------------ scenarios
def horizons(spot: float | None, atm_iv_pct: float | None, minutes_left: float) -> list[dict[str, Any]]:
    """One-standard-deviation move implied by ATM IV for each horizon: spot x IV x sqrt(minutes / (252 x 375)). An estimate, not a forecast."""
    out = []
    for label, m in (("Next 15 minutes", 15.0), ("Next 30 minutes", 30.0), ("Next 60 minutes", 60.0), ("End of session", max(1.0, minutes_left)), ("Next trading session", 375.0)):
        pts = None if not spot or atm_iv_pct is None else spot * (atm_iv_pct / 100) * math.sqrt(m / (252 * 375))
        out.append({"horizon": label, "minutes": round(m), "one_sd_points": None if pts is None else round(pts, 1)})
    return out


def scenarios(fused: Mapping[str, Any], engines: Sequence[Mapping[str, Any]], gx: Mapping[str, Any], inp: Mapping[str, Any], spot: float | None) -> dict[str, Any]:
    """Three competing scenarios with heuristic scores that sum to 100. They are NOT probabilities: no calibrated model supports one."""
    score = fused["score"]
    o = g(inp.get("intraday"), "options") or {}
    vw = g(inp.get("intraday"), "vwap") or {}
    res = [x for x in (gx.get("call_wall"), num(o.get("max_ce_oi_strike")), num(g(inp.get("intraday"), "daily", "prev_high"))) if x and spot and x > spot]
    sup = [x for x in (gx.get("put_wall"), num(o.get("max_pe_oi_strike")), num(g(inp.get("intraday"), "daily", "prev_low"))) if x and spot and x < spot]
    resistance, support = (min(res) if res else None), (max(sup) if sup else None)
    atm_iv = num(g(inp.get("intraday"), "volatility", "atm_iv"))
    if score is None:
        return {"available": False, "reason": fused.get("reason"), "label": "Heuristic scores, not probabilities"}
    conf = (fused["confidence"] or 0) / 100
    raw_bull = max(0.0, score) / 100 * (0.5 + 0.5 * conf)
    raw_bear = max(0.0, -score) / 100 * (0.5 + 0.5 * conf)
    raw_side = (1 - abs(score) / 100) * (1.0 if gx.get("regime") in ("positive", "near flip", "unknown") else 0.6)
    tot = raw_bull + raw_bear + raw_side or 1.0
    vwap_px = num(vw.get("vwap"))

    def sup_signals(sign: int) -> list[str]:
        out = []
        for e in engines:
            if e["score"] is not None and e["score"] * sign >= 15:
                out += [f"{e['name']}: {s}" for s in e["supporting"][:2]] or [f"{e['name']}: score {e['score']:+.0f}"]
        return out[:6]

    return {
        "available": True, "label": "Heuristic scores (sum 100), not probabilities: no calibrated model exists for them",
        "bullish": {"score": round(raw_bull / tot * 100), "supporting": sup_signals(1), "resistance": resistance, "confirmation": None if resistance is None else f"sustained trade above {resistance:.0f}",
                    "invalidation": None if support is None and vwap_px is None else f"a hold below {max(x for x in (support, vwap_px) if x is not None):.0f} ({'VWAP' if vwap_px and (support is None or vwap_px >= support) else 'support'})"},
        "bearish": {"score": round(raw_bear / tot * 100), "supporting": sup_signals(-1), "support": support, "confirmation": None if support is None else f"sustained trade below {support:.0f}",
                    "invalidation": None if resistance is None and vwap_px is None else f"a hold above {min(x for x in (resistance, vwap_px) if x is not None):.0f}"},
        "sideways": {"score": round(raw_side / tot * 100), "range": [support, resistance], "gamma": gx.get("regime", "unknown"), "volatility": volatility_regime(inp, None),
                     "invalidation": None if support is None or resistance is None else f"a close outside {support:.0f} to {resistance:.0f}"},
        "horizons": horizons(spot, atm_iv, _minutes_left(inp)),
    }


def _minutes_left(inp: Mapping[str, Any]) -> float:
    ph = g(inp.get("intraday"), "market", "phase")
    el = num(g(inp.get("market"), "elapsed_minutes"))
    return 375.0 if el is None or ph not in ("live", "opening", "midday", "closing") else max(1.0, 375.0 - el)


# ------------------------------------------------------------------------------------------------ divergences
def divergences(inp: Mapping[str, Any], engines: Mapping[str, Mapping[str, Any]], gx: Mapping[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """The divergence checks that can be made from stored or live outputs. Each is a description, never a reversal signal.
    The second return value lists the checks that cannot be made today and why."""
    out: list[dict[str, Any]] = []
    fut, vol, hv, opt = engines.get("futures", {}), engines.get("volatility", {}), engines.get("heavyweight", {}), engines.get("options", {})
    spot15 = num(vol.get("spot_change_15m_pct")) if vol.get("spot_change_15m_pct") is not None else num(fut.get("price_change_15m_pct"))
    iv = num(vol.get("atm_iv_change_15m"))

    def add(id_: str, name: str, direction: str, sev: str, reading: str, why: str, invalid: str) -> None:
        out.append({"id": id_, "name": name, "direction": direction, "severity": sev, "reading": reading, "explanation": why, "invalidation": invalid})

    cvd_t = next((t for t in fut.get("terms", []) if t["name"].startswith("Futures CVD") and t["available"]), None)
    if spot15 is not None and cvd_t is not None and abs(spot15) >= 0.1 and abs(cvd_t["score"]) >= 25 and spot15 * cvd_t["score"] < 0:
        add("price_cvd", "Price versus futures CVD", "bearish" if spot15 > 0 else "bullish", "high" if abs(cvd_t["score"]) >= 50 else "medium", f"NIFTY {spot15:+.2f}% (15 min) while estimated CVD {cvd_t['detail'].split(' of')[0]}",
            "Price and estimated net aggressor volume point opposite ways: the move may lack participation. The CVD is an estimate.", "CVD turns to the same sign as price, or price reverses")
    bu = fut.get("buildup")
    if spot15 is not None and bu in ("short covering", "long unwinding") and abs(spot15) >= 0.1:
        add("price_oi", "Price versus futures open interest", "bearish" if bu == "short covering" else "bullish", "medium", f"price {spot15:+.2f}% on falling futures OI ({bu})",
            "The move is driven by positions closing, not new positions opening.", "futures OI starts rising in the direction of price")
    if gx.get("available") and gx.get("relationship") in ("amplifying", "stabilising") and gx.get("spot_change_15m_pct") is not None:
        add("price_gex", "Price versus net GEX", "neutral", "medium" if gx["relationship"] == "amplifying" else "low", f"NIFTY {gx['spot_change_15m_pct']:+.2f}% while net GEX changed {gx.get('net_change_pct', 0):+.0f}%: potentially {gx['relationship']}",
            "A model-based relationship (dealer positioning is not observed), not guaranteed hedging behaviour.", "net GEX or price changes less than 5% / 0.05%")
    d25_term = next((t for t in vol.get("terms", []) if t["name"].startswith("Call versus put") and t["available"]), None)
    d25 = None if d25_term is None else d25_term["score"]
    if spot15 is not None and d25 is not None and abs(spot15) >= 0.1 and abs(d25) >= 40 and spot15 * d25 < 0:
        add("price_skew", "Price versus call/put IV momentum", "bearish" if spot15 > 0 else "bullish", "medium", f"NIFTY {spot15:+.2f}% while the 25Δ call-minus-put IV momentum reads {'put' if d25 < 0 else 'call'}-side strength",
            "Option prices lean the other way from the underlying.", "momentum returns to the sign of price")
    f_s, o_s = fut.get("score"), opt.get("score")
    if f_s is not None and o_s is not None and abs(f_s) >= 25 and abs(o_s) >= 25 and f_s * o_s < 0:
        add("fut_opt", "Futures versus options", "neutral", "medium", f"futures engine {f_s:+.0f}, options engine {o_s:+.0f}", "Two independent derivatives engines disagree.", "either engine crosses zero")
    h_div = g(hv, "metrics", "divergence")
    if h_div:
        add("idx_heavy", "NIFTY versus heavyweight CVD", "bearish" if (hv["metrics"].get("weighted_cvd_score") or 0) < 0 else "bullish", "medium", f"weighted heavyweight CVD {hv['metrics']['weighted_cvd_score']:+.0f}, index move {g(inp.get('market'), 'index_change_pct')}%",
            "The index is moving against the flow in its largest stocks (estimated).", "heavyweight flow turns to the index direction")
    vw = g(inp.get("intraday"), "vwap") or {}
    if cvd_t is not None and vw.get("side") in ("above", "below") and abs(cvd_t["score"]) >= 25 and ((vw["side"] == "above") != (cvd_t["score"] > 0)):
        add("vwap_cvd", "VWAP versus CVD", "bearish" if vw["side"] == "above" else "bullish", "low", f"future {vw['side']} VWAP while estimated CVD is {'negative' if cvd_t['score'] < 0 else 'positive'}", "Price location and order flow disagree.", "price crosses VWAP or CVD changes sign")
    if iv is not None and spot15 is not None and iv >= 0.5 and abs(spot15) < 0.05:
        add("vol_no_price", "Volatility expansion without price confirmation", "neutral", "medium", f"ATM IV {iv:+.2f} pts with NIFTY {spot15:+.2f}%", "Option prices are repricing risk while the underlying has not moved.", "IV falls back or price moves")
    if iv is not None and spot15 is not None and iv <= -0.3 and abs(spot15) >= 0.2:
        add("vol_contract", "Volatility contraction during a directional move", "neutral", "low", f"ATM IV {iv:+.2f} pts while NIFTY {spot15:+.2f}%", "A move with falling implied volatility is often an orderly one; not a reversal signal.", "IV starts rising")
    unavailable = ["OI migration versus price: no stored OI-migration series exists on the server yet",
                   "Rolling 5/15/30-minute CVD divergence: the flow tracker keeps session totals only"]
    return out, unavailable


# ------------------------------------------------------------------------------------------------ interpretation
def interpretation(fused: Mapping[str, Any], engines: Sequence[Mapping[str, Any]], reg: Mapping[str, Any], divs: Sequence[Mapping[str, Any]], gx: Mapping[str, Any], inp: Mapping[str, Any]) -> str:
    if fused["score"] is None:
        return f"{fused['class']}. {fused.get('reason') or ''} No market view is given until enough engines report."
    by = {e["key"]: e for e in engines}
    parts = [f"Market sentiment is {fused['class'].lower()} (score {fused['score']:+.0f}, confidence {fused['confidence']:.0f}); regime: {reg['name'].lower()}."]
    labels = {"futures": "Futures positioning and order flow", "options": "Options positioning", "gex": "The gamma setup", "heavyweight": "Heavyweight participation", "volatility": "Volatility", "structure": "Breadth and structure"}
    for k in ("futures", "options", "heavyweight", "gex", "volatility", "structure"):
        e = by.get(k)
        if e and e["score"] is not None:
            top = (e["supporting"] or e["conflicting"] or [""])[0]
            parts.append(f"{labels[k]} lean {e['tilt']} ({e['score']:+.0f})" + (f": {top}." if top else "."))
        elif e:
            parts.append(f"{labels[k]}: no reading.")
    if gx.get("available") and gx.get("flip") is not None:
        parts.append(f"NIFTY is {abs(gx['flip_distance_pct']):.2f}% {'above' if gx['flip_distance_pct'] >= 0 else 'below'} the gamma flip at {gx['flip']:.0f} (model-based).")
    if divs:
        parts.append("Watch: " + "; ".join(d["name"].lower() for d in divs[:3]) + ".")
    sc = None
    vw = num(g(inp.get("intraday"), "vwap", "vwap"))
    if vw and fused["score"] >= 15:
        sc = f"The bullish bias weakens on a sustained move below the future's VWAP near {vw:.0f}."
    elif vw and fused["score"] <= -15:
        sc = f"The bearish bias weakens on a sustained move above the future's VWAP near {vw:.0f}."
    if sc:
        parts.append(sc)
    return " ".join(parts)


def build_engines(inp: Mapping[str, Any], status: Mapping[str, Any]) -> list[dict[str, Any]]:
    fns: list[Callable[[Mapping[str, Any], Mapping[str, Any]], dict[str, Any]]] = [futures_engine, options_engine, gex_engine, heavyweight_engine, volatility_engine, structure_engine]
    return [f(inp, status) for f in fns]
