"""Sentiment fusion, regime, scenarios and divergences for the NIFTY 50 market-intelligence dashboard (pure functions, no I/O).

Everything here consumes outputs the application already computes (see docs/market-intelligence-audit.md for the map): nothing is
recalculated from raw data except small combinations of those outputs, and every term is returned as evidence. A term whose input is
missing is *unavailable*: it is left out, never scored neutral. Scores are in [-100, +100]; +100 is bullish evidence.

Evidence is split into five groups, each owning its inputs so that no input is counted twice:

    A positioning (options OI, Smart OI, futures OI, GEX)   B order-flow proxies (futures and heavyweight CVD, depth)
    C volatility (live ATM IV, skew)                        D market structure (index price: VWAP, day range, previous-day range)
    E participation (breadth of the 50 stocks and the heavyweights, from prices only)

Where two terms inside a group are built from the same underlying data they share a *family* and are averaged into one reading. A term that
reads an input another group also reads (price) carries a stated weight below 1. The aggregate command-centre score is never an input.

    group score = sum(family score x family weight) / sum(family weight)         (family score = weighted mean of its available terms)
    Overall     = sum(score_g x effective weight_g) / sum(effective weight_g)     coverage = sum(effective weight) / sum(all weights)

Confidence is separate from the score and is the product of three shown parts (coverage, agreement among the groups, freshness); it is
not derived from the size of the score and it is not a probability. Weights and thresholds are provisional and not statistically calibrated.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from app.intelligence import heavyweights as hw
from app.intelligence import voleval
from app.intraday.gex_history import flip_support as gx_flip_support

#: default engine weights (percent); overridable through ``Settings.intelligence_weights``
DEFAULT_WEIGHTS: dict[str, float] = {"positioning": 30.0, "orderflow": 20.0, "volatility": 10.0, "structure": 20.0, "participation": 20.0}
ENGINE_NAMES = {
    "positioning": "A. Derivatives positioning", "orderflow": "B. Order-flow proxies", "volatility": "C. Volatility",
    "structure": "D. Market structure", "participation": "E. Participation and breadth",
}
ENGINE_LINKS = {
    "positioning": "/tools/strike-positioning", "orderflow": "/tools/future-flow", "volatility": "/tools/volatility-skew",
    "structure": "/tools/future-dashboard", "participation": "/tools/market-movers",
}
PROVISIONAL = "Provisional weights – not yet statistically calibrated."
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
    """One piece of evidence inside a group. ``family``: terms built from the same underlying data share one and are averaged into a single reading.
    ``weight`` (default 1) is the term's weight inside its family and, when its family has one term, the family's weight against other families;
    a weight below 1 is an explicit overlap adjustment for the inputs listed in ``shares`` (inputs another group also reads)."""

    def __init__(self, name: str, score: float | None, detail: str, *, proxy: bool = False, family: str | None = None, weight: float = 1.0, shares: Sequence[str] = ()) -> None:
        self.name, self.score, self.detail, self.proxy = name, None if score is None else round(clip(score), 1), detail, proxy
        self.family, self.weight, self.shares = family or name, weight, tuple(shares)

    def public(self) -> dict[str, Any]:
        return {"name": self.name, "score": self.score, "detail": self.detail, "available": self.score is not None, "proxy": self.proxy,
                "family": self.family, "weight": self.weight, "shares": list(self.shares),
                "overlap_adjustment": None if not self.shares else f"weight {self.weight:g}: shares {', '.join(self.shares)} with another group"}


def engine(key: str, terms: Sequence[Term], inputs: Sequence[str], status: Mapping[str, Mapping[str, Any]], *, extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """An engine's score is the plain average of its available terms; the evidence lists are the terms on each side of zero."""
    avail = [t for t in terms if t.score is not None]
    fam_score: dict[str, float] = {}
    fam_w: dict[str, float] = {}
    for f in dict.fromkeys(t.family for t in terms):
        members = [t for t in avail if t.family == f]
        if members:
            w = sum(t.weight for t in members)
            fam_score[f] = sum((t.score or 0.0) * t.weight for t in members) / w
            fam_w[f] = w / len(members)
    score = None if not fam_w else round(sum(fam_score[f] * fam_w[f] for f in fam_w) / sum(fam_w.values()), 1)
    ages = [num(g(status, i, "age_s")) for i in inputs]
    errs = [i for i in inputs if g(status, i, "ok") is False]
    live = key in ("orderflow", "structure", "participation")
    limit = STALE_LIVE_S if live else STALE_STORED_S
    known = [a for a in ages if a is not None]
    worst = max(known) if known else None
    fresh = None if score is None else (not errs and (worst is None or worst <= limit))
    # the share of the group's evidence that exists is counted by family (a family is one reading however many terms it has)
    fam_all = {f: sum(t.weight for t in terms if t.family == f) / sum(1 for t in terms if t.family == f) for f in dict.fromkeys(t.family for t in terms)}
    total_w = sum(fam_all.values())
    fraction = 1.0 if not total_w else sum(fam_all[f] for f in fam_w) / total_w
    state = "UNAVAILABLE" if score is None else ("AVAILABLE" if len(avail) == len(terms) else "PARTIAL")
    return {
        "key": key, "name": ENGINE_NAMES[key], "score": score, "class": classify(score), "tilt": tilt(score), "link": ENGINE_LINKS[key],
        "status": state, "fraction": round(fraction, 3), "terms_available": len(avail), "terms_total": len(terms), "families": len({t.family for t in terms}),
        "terms": [t.public() for t in terms],
        "supporting": [f"{t.name}: {t.detail}" for t in avail if t.score is not None and abs(t.score) >= 10 and (score or 0) * t.score > 0],
        "conflicting": [f"{t.name}: {t.detail}" for t in avail if t.score is not None and abs(t.score) >= 10 and (score or 0) * t.score < 0],
        "unavailable": [f"{t.name}: {t.detail}" for t in terms if t.score is None],
        "freshness": {"fresh": fresh, "age_s": worst, "inputs": list(inputs), "failed": errs, "as_of": {i: g(status, i, "as_of") for i in inputs}},
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


def gex_state(inp: Mapping[str, Any]) -> dict[str, Any]:
    pts = g(inp.get("gex"), "points") or []
    last = pts[-1] if pts else None
    if not last:
        return {"available": False}
    spot, net, flip = num(last.get("spot")), num(last.get("net")), num(last.get("flip"))
    dist = None if flip is None or not spot else (spot - flip) / spot * 100
    dist_pts = None if flip is None or not spot else spot - flip
    fd = {k[3:]: num(v) for k, v in last.items() if k.startswith("fd_")}
    support = gx_flip_support(spot, flip, fd) if spot else {"status": "none", "reasons": []}
    alts = [v for v in (flip, fd.get("flip_both"), fd.get("flip_lo"), fd.get("flip_hi")) if v is not None]
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
            "flip_distance_pct": dist, "flip_distance_pts": dist_pts, "flip_support": support, "flip_range": None if not alts else [min(alts), max(alts)], "flip_diagnostics": fd, "call_wall": num(last.get("call_wall")), "put_wall": num(last.get("put_wall")), "peak": num(last.get("peak")), "near_net": num(last.get("near_net")),
            "regime": regime, "net_change_15m": d_net, "net_change_pct": None if d_net is None or not scale else d_net / scale * 100, "spot_change_15m_pct": d_spot, "relationship": kind,
            "session": g(inp.get("gex"), "session"), "universe": g(inp.get("gex"), "universe") or "dynamic"}


def _minutes_between(a: Any, b: Any) -> float:
    from datetime import datetime

    try:
        return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() / 60
    except (TypeError, ValueError):
        return 0.0


def _gex_terms(inp: Mapping[str, Any]) -> tuple[list[Term], dict[str, Any]]:
    """GEX evidence: a modelled exposure (calls +, puts − by assumption), never observed dealer positioning. Both terms read spot against a level, so each
    carries half weight and is marked as sharing the price input with group D."""
    st = gex_state(inp)
    if not st["available"]:
        return [Term("Spot versus the gamma flip (modelled)", None, "no rebuilt GEX snapshot", family="gex", weight=0.5, shares=("price",)),
                Term("Room to the GEX walls (modelled)", None, "no walls", family="gex", weight=0.5, shares=("price",))], st
    dist = st["flip_distance_pct"]
    spot, cw, pw = st["spot"], st["call_wall"], st["put_wall"]
    weak = (st.get("flip_support") or {}).get("status") == "unstable"
    terms = [Term("Spot versus the gamma flip (modelled)", squash(dist, 1.0), (f"spot {st['flip_distance_pts']:+.0f} pts ({dist:+.2f}%) from the modelled flip {st['flip']:.0f} (above = positive-gamma side under the assumed sign convention)" + ("; flip UNSTABLE: counted at a quarter of its weight (" + "; ".join(st["flip_support"]["reasons"]) + ")" if weak else "")) if dist is not None else "no gamma flip within ±8%",
                  family="gex", weight=0.125 if weak else 0.5, shares=("price",))]
    up, dn = (cw - spot if cw and spot else None), (spot - pw if pw and spot else None)
    asym = None if up is None or dn is None or up <= 0 or dn <= 0 else (up - dn) / (up + dn)
    terms.append(Term("Room to the GEX walls (modelled)", None if asym is None else asym * 60, f"call wall {cw:.0f} ({up:.0f} pts above), put wall {pw:.0f} ({dn:.0f} pts below)" if asym is not None else "walls not both on the expected side of spot",
                      family="gex", weight=0.5, shares=("price",)))
    return terms, st


def positioning_engine(inp: Mapping[str, Any], status: Mapping[str, Any]) -> dict[str, Any]:
    """Group A, derivatives positioning: options OI and Smart OI, futures OI, GEX. (Vega is only PARTIAL and is not scored.)

    The two options-OI terms come from the same open-interest changes (PCR change is a ratio of those very changes), so they form ONE family and are
    averaged into one reading; the PCR change itself is shown but not scored. The futures price-and-OI term and the GEX terms read price, which group
    D also reads: they carry half weight and say so."""
    o = g(inp.get("intraday"), "options") or {}
    chg = num(o.get("pcr_oi_change"))
    ce, pe = num(o.get("ce_oi_chg")), num(o.get("pe_oi_chg"))
    tot = (num(o.get("ce_oi")) or 0) + (num(o.get("pe_oi")) or 0)
    terms = [Term("OI added: puts minus calls", squash((pe - ce) / tot, 0.05) if ce is not None and pe is not None and tot else None,
                  f"put OI {pe:+,.0f}, call OI {ce:+,.0f} (ATM ±10 strikes); PCR {o.get('pcr_oi')} ({'' if chg is None else f'{chg:+.3f}'} since open, shown not scored: same OI)" if ce is not None and pe is not None else "no OI change", family="options_oi")]
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
    terms.append(Term("Smart OI: strike demand labels (15 min)", pts if has_label or pts else None,
                      ("; ".join(notes) or "labels present, none directional") + " (OI does not identify who traded)" if dem else "no positioning comparison", family="options_oi"))
    fut = inp.get("futures")
    pc, oc, _, _ = _fut_window(fut, 15)
    bu = buildup(pc, oc)
    base = {"long buildup": 60.0, "short buildup": -60.0, "short covering": 30.0, "long unwinding": -30.0}.get(bu)
    terms.append(Term("Futures price and open interest (15 min)", base, f"{bu}: price {pc:+.2f}%, OI {oc:+,.0f}" if base is not None and pc is not None and oc is not None else "needs two futures samples 15 minutes apart",
                      family="futures_oi", weight=0.5, shares=("price",)))
    gterms, st = _gex_terms(inp)
    terms += gterms
    return engine("positioning", terms, ["intraday", "positioning", "futures", "gex"], status, extra={"buildup": bu, "price_change_15m_pct": pc, "oi_change_15m": oc, "pcr": o.get("pcr_oi"),
                                                                                                      "max_ce_oi_strike": o.get("max_ce_oi_strike"), "max_pe_oi_strike": o.get("max_pe_oi_strike"), "state": st})


def orderflow_engine(inp: Mapping[str, Any], status: Mapping[str, Any]) -> dict[str, Any]:
    """Group B, order-flow PROXIES. Every CVD figure here is estimated by the quote rule then the tick rule from the quote stream: the feed carries no
    aggressor-side trade tape, so buyer- or seller-initiated volume is never observed. Session and rolling CVD of the same instrument are one family
    (the rolling window is a slice of the session total); the heavyweights are a separate instrument set and a separate family."""
    flow = g(inp.get("market"), "flow", "futures")
    cvd, share, stale = num(g(flow, "cvd_pct")), num(g(flow, "classified_share")), g(flow, "stale")
    ok_cvd = cvd is not None and stale is not True and (share is None or share >= 0.5)
    terms = [Term("Futures CVD (Proxy), session", squash(cvd, 25) if ok_cvd else None,
                  f"session CVD {cvd:+.1f}% of classified volume (quote and tick-rule estimate, not observed buyer/seller volume)" if cvd is not None else "no futures flow tracked", proxy=True, family="futures_cvd")]
    r15 = g(inp.get("rolling"), "windows", "15") or {}
    r15v = num(r15.get("cvd_pct")) if r15.get("status") == "ok" else None
    terms.append(Term("Futures CVD (Proxy), rolling 15 min", squash(r15v, 25), f"last 15 minutes {r15v:+.1f}% of classified volume (stored per-minute flow, estimate)" if r15v is not None else str(r15.get("status") or "no rolling flow"), proxy=True, family="futures_cvd"))
    acc = g(inp.get("rolling"), "acceleration") or {}
    cur_p, prev_p = num(acc.get("current_pct")), num(acc.get("previous_pct"))
    terms.append(Term("Futures CVD change (Proxy), 5 min vs previous 5 min", squash(cur_p - prev_p, 25) if acc.get("status") == "ok" and cur_p is not None and prev_p is not None else None,
                      f"current 5-minute CVD {cur_p:+.1f}% of classified volume, previous 5 minutes {prev_p:+.1f}%; rate {acc.get('current_rate')} vs {acc.get('previous_rate')} per minute" if cur_p is not None and prev_p is not None else str(acc.get("status") or "no stored flow"), proxy=True, family="futures_cvd"))
    imb = num(g(flow, "depth_imbalance"))
    terms.append(Term("Order-book depth imbalance (Proxy)", squash(imb, 0.3) if stale is not True else None, f"bid minus ask depth share {imb:+.2f} (resting quotes, not trades)" if imb is not None else "no fresh depth", proxy=True, family="depth"))
    h = inp.get("heavy") or hw.assess(inp)
    agg = h.get("aggregate") or {}
    s15, ssess = (agg.get("15") or {}).get("score"), (agg.get("session") or {}).get("score")
    mom = agg.get("momentum")
    part = h.get("participation") or {}
    rows_h = h.get("stocks") or []
    n_ok = (agg.get("session") or {}).get("valid", 0)
    why = (agg.get("15") or {}).get("status") or "no rolling heavyweight flow"
    terms.append(Term("Heavyweight CVD (Proxy), rolling 15 min", s15, f"weighted over {(agg.get('15') or {}).get('valid')} of {len(rows_h)} stocks, last 15 minutes of stored flow, each normalised then index-weighted (estimate)" if s15 is not None else why, proxy=True, family="heavy_cvd"))
    terms.append(Term("Heavyweight CVD (Proxy), session", ssess, f"{n_ok} of {len(rows_h)} stocks, each normalised then weighted by index weight (estimate)" if ssess is not None else str((agg.get("session") or {}).get("status") or "no heavyweight flow"), proxy=True, family="heavy_cvd"))
    terms.append(Term("Heavyweight CVD change (Proxy), 5 min vs previous 5 min", None if mom is None else clip(mom), f"this 5-minute score less the previous, non-overlapping 5-minute score {mom:+.0f} (positive: pressure strengthening)" if mom is not None else "needs two consecutive 5-minute windows", proxy=True, family="heavy_cvd"))
    wp, wn = part.get("weight_share_positive"), part.get("weight_share_negative")
    terms.append(Term("Heavyweight CVD participation (Proxy)", None if wp is None or wn is None else (wp - wn) * 100, f"{part.get('positive')} stocks buying, {part.get('negative')} selling of {part.get('valid')} valid; weight share {wp:.0%} vs {wn:.0%}" if wp is not None and wn is not None else "fewer than 3 valid heavyweights", proxy=True, family="heavy_cvd"))
    div = "index and heavyweight flow disagree" if part.get("class") == "Heavyweight divergence" else None
    return engine("orderflow", terms, ["market", "flow"], status, extra={"metrics": {"weighted_cvd_score": ssess, "positive_cvd": part.get("positive"), "negative_cvd": part.get("negative"), "stocks_used": [r["symbol"] for r in rows_h if r.get("valid")],
                                                                                    "weighted_cvd_15m_score": s15, "divergence": div, "symbols": [r["symbol"] for r in rows_h], "participation": part.get("class")}})


def volatility_engine(inp: Mapping[str, Any], status: Mapping[str, Any]) -> dict[str, Any]:
    """Group C, volatility: live ATM IV change and the 25Δ call-versus-put IV momentum (= the change in the 25Δ risk reversal), expiry-specific. The
    scoring rules are in ``voleval`` and configurable; India VIX, IV rank/percentile and IV-RV are daily context and never scored."""
    cfg = inp.get("vol_config") or voleval.DEFAULT
    table = g(inp.get("momentum"), "table") or {}
    row = g(table, "periods", "15") or {}
    det = voleval.analyse(row, table.get("previous_close"), cfg)
    by = {c["key"]: c for c in det["components"]}
    atm = by["atm"]
    terms: list[Term] = [Term("ATM IV change against price (15 min)", atm["score"], atm["reading"] or "no snapshot 15 minutes earlier", family="atm_iv")]
    rr = by["rr"]
    terms.append(Term("Call versus put IV momentum (25Δ, 15 min)", rr["score"], rr["reading"] or "no 25Δ momentum", family="skew"))
    iv_chg, spot = det["atm"]["avg_change"], det["spot_change_pct"]
    return engine("volatility", terms, ["momentum", "skew"], status, extra={"atm_iv_change_15m": iv_chg, "spot_change_15m_pct": spot, "skew_25d": g(inp.get("skew"), "cards", "skew_25d"), "detail": det,
                                                                           "call_minus_put_25d": g(inp.get("skew"), "cards", "call_minus_put_25d"), "butterfly_25d": g(inp.get("skew"), "cards", "butterfly_25d"),
                                                                           "context_not_scored": ["India VIX (last daily close)", "IV rank and IV percentile (from daily VIX closes)", "IV minus realised volatility (daily)"]})


def structure_engine(inp: Mapping[str, Any], status: Mapping[str, Any]) -> dict[str, Any]:
    """Group D, market structure of the INDEX: where price is against its VWAP, its day range and the previous day's range. The breadth of the
    constituents is group E's; the command-centre score is never used here because it is itself built from these same inputs."""
    ins = inp.get("intraday")
    vwap = g(ins, "vwap")
    dist_atr, dist_pct = num(g(vwap, "distance_atr")), num(g(vwap, "distance_pct"))
    vs = squash(dist_atr, 1.0) if dist_atr is not None else squash(dist_pct, 0.2)
    pos = num(g(ins, "price", "position_in_range"))
    last, ph, pl = num(g(ins, "price", "last")), num(g(ins, "daily", "prev_high")), num(g(ins, "daily", "prev_low"))
    lvl = None if last is None or ph is None or pl is None or ph <= pl else (last - pl) / (ph - pl)
    terms = [
        Term("Futures price versus futures VWAP", vs, f"NIFTY future {g(vwap, 'side')} the future's own VWAP by {g(vwap, 'distance_pts')} pts ({dist_pct:+.3f}%); spot is never compared with it (slope {g(vwap, 'slope_pts_per_15m')} pts / 15 min)" if dist_pct is not None else "no VWAP (needs the future's average traded price)", family="price"),
        Term("Position in the day's range", None if pos is None else (pos - 0.5) * 120, f"NIFTY at {pos:.0%} of the sampled day range" if pos is not None else "no range", family="price"),
        Term("Position against the previous day's range", None if lvl is None else clip((lvl - 0.5) * 120), f"NIFTY {last:.0f} against the previous day's {pl:.0f} to {ph:.0f} ({lvl:.0%} of that range; above 100% is a break higher)" if lvl is not None and last is not None and ph is not None and pl is not None else "no previous-day range", family="levels"),
    ]
    return engine("structure", terms, ["intraday"], status, extra={"owns": "index price only; constituent breadth is group E"})


def participation_engine(inp: Mapping[str, Any], status: Mapping[str, Any]) -> dict[str, Any]:
    """Group E, participation: how many NIFTY 50 stocks (and the heavyweights) are advancing, from prices only: no CVD is used, so this is independent of group B.
    The three breadth readings come from the same 50 stocks and form one family. The heavyweight terms are price-based (their contribution to the index
    is price change × weight), so they carry half weight and are marked as sharing price with group D."""
    mk = inp.get("market")
    b = g(mk, "nifty50", "breadth") or {}
    adb = num(b.get("ad_balance"))
    pa = num(g(mk, "participation", "above_vwap", "pct_above"))
    orb = g(mk, "participation", "opening_range") or {}
    orv = None if num(orb.get("pct_above_high")) is None or num(orb.get("pct_below_low")) is None else float(orb["pct_above_high"]) - float(orb["pct_below_low"])
    terms = [
        Term("Advance/decline balance", None if adb is None else adb * 100, f"balance {adb:+.2f} ({b.get('advancing')} up, {b.get('declining')} down of {b.get('covered')} covered)" if adb is not None else "no breadth", family="breadth"),
        Term("Stocks above their day VWAP", None if pa is None else (pa - 50) * 2, f"{pa:.0f}% of stocks above VWAP" if pa is not None else "no VWAP participation", family="breadth"),
        Term("Stocks against their opening range", orv, f"{orb.get('pct_above_high')}% above the opening-range high, {orb.get('pct_below_low')}% below the low" if orv is not None else "opening range not yet formed", family="breadth"),
    ]
    stocks = g(mk, "flow", "heavy5", "stocks") or []
    rows = {r.get("symbol"): r for r in (g(mk, "nifty50", "stocks") or [])}
    pts, n_pts, up_w, dn_w, n_ch = 0.0, 0, 0.0, 0.0, 0
    for s in stocks:
        rc = rows.get(s.get("symbol"), {})
        if num(rc.get("contribution")) is not None:
            pts += float(rc["contribution"])
            n_pts += 1
        chg, w = num(s.get("change_pct")), num(s.get("weight"))
        if chg is not None and w:
            n_ch += 1
            up_w += w if chg > 0 else 0.0
            dn_w += w if chg < 0 else 0.0
    ad_h = None if not n_ch or (up_w + dn_w) == 0 else (up_w - dn_w) / (up_w + dn_w) * 100
    terms.append(Term("Heavyweights advancing versus declining (by weight)", ad_h, f"{n_ch} heavyweights: weight advancing {up_w:.1f}, declining {dn_w:.1f}" if ad_h is not None else "no heavyweight prices", family="heavy_price", weight=0.5, shares=("price",)))
    terms.append(Term("Index points from the heavyweights", squash(pts, 0.15) if n_pts else None, f"{pts:+.3f}% of the index from {n_pts} stocks" if n_pts else "no contributions", family="heavy_price", weight=0.5, shares=("price",)))
    rs = (inp.get("heavy") or hw.assess(inp)).get("relative_strength_pct")
    terms.append(Term("Heavyweights versus the index (relative strength)", None if rs is None else squash(rs, 0.3), f"weight-averaged heavyweight change less the index change {rs:+.3f} pts" if rs is not None else "no heavyweight prices", family="heavy_price", weight=0.5, shares=("price",)))
    return engine("participation", terms, ["market"], status, extra={"breadth": {"advancing": b.get("advancing"), "declining": b.get("declining"), "covered": b.get("covered")},
                                                                    "metrics": {"aggregate_points_pct": round(pts, 4) if n_pts else None, "heavy_up_weight": round(up_w, 2), "heavy_down_weight": round(dn_w, 2)}})


# ------------------------------------------------------------------------------------------------ fusion
def fuse(engines: Sequence[dict[str, Any]], weights: Mapping[str, float], min_coverage: float = MIN_COVERAGE, min_engines: int = MIN_ENGINES) -> dict[str, Any]:
    """Weighted fusion with explicit coverage rules. A PARTIAL engine (some evidence terms missing) counts with its weight multiplied by the
    share of its terms that are available; an UNAVAILABLE engine counts for nothing and is never given a neutral score.

        effective weight_e = weight_e x (available terms / listed terms)
        Overall  = sum(score_e x effective weight_e) / sum(effective weight_e)
        coverage = sum(effective weight_e) / sum(all weights)
    """
    total = sum(max(0.0, weights.get(e["key"], 0.0)) for e in engines)
    avail = [e for e in engines if e["score"] is not None and weights.get(e["key"], 0.0) > 0]
    eff = {e["key"]: weights[e["key"]] * e.get("fraction", 1.0) for e in avail}
    wa = sum(eff.values())
    coverage = 0.0 if total <= 0 else wa / total
    counts = {"available": sum(1 for e in engines if e.get("status") == "AVAILABLE" or (e["score"] is not None and "status" not in e)),
              "partial": sum(1 for e in engines if e.get("status") == "PARTIAL"), "unavailable": sum(1 for e in engines if e["score"] is None)}
    for e in engines:
        e["weight"] = weights.get(e["key"], 0.0)
        e["effective_weight"] = round(eff.get(e["key"], 0.0), 3)
        e["contribution"] = None if e["score"] is None or wa == 0 else round(e["score"] * eff.get(e["key"], 0.0) / wa, 2)
    base = {"coverage": round(coverage, 3), "engines_available": len(avail), "engine_counts": counts}
    if len(avail) < min_engines or coverage < min_coverage or wa == 0:
        return {"score": None, "class": "INSUFFICIENT DATA – SENTIMENT UNRELIABLE", **base, "agreement": None, "freshness": None, "confidence": None,
                "reason": f"{len(avail)} engines available (need {min_engines}) with coverage {coverage:.0%} (need {min_coverage:.0%})"}
    score = sum(e["score"] * eff[e["key"]] for e in avail) / wa
    # Agreement is about the groups, not about the size of the score: the weight share that is directional on one side against the weight share
    # directional on the other. A group inside +-15 is neutral and opposes nobody. 1 = no group opposes another, 0 = an even split.
    pos_w = sum(eff[e["key"]] for e in avail if e["score"] >= 15)
    neg_w = sum(eff[e["key"]] for e in avail if e["score"] <= -15)
    conflict = min(pos_w, neg_w) / wa
    agreement = max(0.0, 1.0 - 2.0 * conflict)
    fresh_w = sum(eff[e["key"]] for e in avail if e["freshness"]["fresh"])
    freshness = fresh_w / wa
    cov_factor = min(1.0, coverage / 0.8)
    conf = 100 * cov_factor * agreement * freshness
    capped = conflict >= 0.25
    if capped:
        conf = min(conf, 40.0)  # a strong score from groups that disagree is never high confidence
    return {"score": round(score, 1), "class": classify(score), **base, "agreement": round(agreement, 3), "freshness": round(freshness, 3),
            "confidence": round(conf, 1), "confidence_parts": {"coverage_factor": round(cov_factor, 3), "agreement": round(agreement, 3), "freshness": round(freshness, 3), "conflict_cap_applied": capped},
            "groups_bullish": round(pos_w / wa, 3), "groups_bearish": round(neg_w / wa, 3), "reason": None,
            "weights_note": PROVISIONAL,
            "evidence_quality": round(conf, 1), "note": "Directional evidence only. EVIDENCE QUALITY measures how fresh, complete and in agreement the evidence is. It is not a probability that the direction is right and never a prediction; the weights are provisional."}


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
    fut = engines.get("positioning", {})
    bu, pc = fut.get("buildup"), fut.get("price_change_15m_pct")
    vol = engines.get("volatility", {})
    iv_chg = vol.get("atm_iv_change_15m")
    cvd_terms = [t for t in engines.get("orderflow", {}).get("terms", []) if t["name"].startswith("Futures CVD") and t["available"]]
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
    fut, vol, hv, opt = engines.get("positioning", {}), engines.get("volatility", {}), engines.get("orderflow", {}), engines.get("orderflow", {})
    spot15 = num(vol.get("spot_change_15m_pct")) if vol.get("spot_change_15m_pct") is not None else num(fut.get("price_change_15m_pct"))
    iv = num(vol.get("atm_iv_change_15m"))

    def add(id_: str, name: str, direction: str, sev: str, reading: str, why: str, invalid: str) -> None:
        out.append({"id": id_, "name": name, "direction": direction, "severity": sev, "reading": reading, "explanation": why, "invalidation": invalid})

    cvd_t = next((t for t in hv.get("terms", []) if t["name"].startswith("Futures CVD") and t["available"]), None)
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
        add("fut_opt", "Derivatives positioning versus order flow", "neutral", "medium", f"positioning group {f_s:+.0f}, order-flow proxy group {o_s:+.0f}", "Open-interest positioning and the estimated order flow point opposite ways.", "either group crosses zero")
    for sig in (inp.get("heavy") or hw.assess(inp)).get("signals", []):
        out.append(sig)
    vw = g(inp.get("intraday"), "vwap") or {}
    if cvd_t is not None and vw.get("side") in ("above", "below") and abs(cvd_t["score"]) >= 25 and ((vw["side"] == "above") != (cvd_t["score"] > 0)):
        add("vwap_cvd", "VWAP versus CVD", "bearish" if vw["side"] == "above" else "bullish", "low", f"future {vw['side']} VWAP while estimated CVD is {'negative' if cvd_t['score'] < 0 else 'positive'}", "Price location and order flow disagree.", "price crosses VWAP or CVD changes sign")
    if iv is not None and spot15 is not None and iv >= 0.5 and abs(spot15) < 0.05:
        add("vol_no_price", "Volatility expansion without price confirmation", "neutral", "medium", f"ATM IV {iv:+.2f} pts with NIFTY {spot15:+.2f}%", "Option prices are repricing risk while the underlying has not moved.", "IV falls back or price moves")
    if iv is not None and spot15 is not None and iv <= -0.3 and abs(spot15) >= 0.2:
        add("vol_contract", "Volatility contraction during a directional move", "neutral", "low", f"ATM IV {iv:+.2f} pts while NIFTY {spot15:+.2f}%", "A move with falling implied volatility is often an orderly one; not a reversal signal.", "IV starts rising")
    unavailable = ["OI migration versus price: no stored OI-migration series exists on the server yet"]
    return out, unavailable


# ------------------------------------------------------------------------------------------------ interpretation
def interpretation(fused: Mapping[str, Any], engines: Sequence[Mapping[str, Any]], reg: Mapping[str, Any], divs: Sequence[Mapping[str, Any]], gx: Mapping[str, Any], inp: Mapping[str, Any]) -> str:
    if fused["score"] is None:
        return f"{fused['class']}. {fused.get('reason') or ''} No market view is given until enough engines report."
    by = {e["key"]: e for e in engines}
    parts = [f"Market sentiment is {fused['class'].lower()} (score {fused['score']:+.0f}, evidence quality {fused['confidence']:.0f} of 100: freshness, completeness and agreement, not a probability); regime: {reg['name'].lower()}."]
    labels = {"positioning": "Derivatives positioning", "orderflow": "Order-flow proxies", "volatility": "Volatility", "structure": "Index structure", "participation": "Participation and breadth"}
    for k in ("positioning", "orderflow", "volatility", "structure", "participation"):
        e = by.get(k)
        if e and e["score"] is not None:
            top = (e["supporting"] or e["conflicting"] or [""])[0]
            parts.append(f"{labels[k]} lean {e['tilt']} ({e['score']:+.0f})" + (f": {top}." if top else "."))
        elif e:
            parts.append(f"{labels[k]}: no reading.")
    if gx.get("available") and gx.get("flip") is not None:
        parts.append(f"NIFTY is {abs(gx['flip_distance_pct']):.2f}% {'above' if gx['flip_distance_pct'] >= 0 else 'below'} the modelled gamma flip at {gx['flip']:.0f} (a model assumption, not observed dealer positioning).")
    for o in observations(inp, {e["key"]: e for e in engines}, gx)[:3]:
        parts.append(o["reading"] + ".")
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


def observations(inp: Mapping[str, Any], by: Mapping[str, Mapping[str, Any]], gx: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Plain-language observations where two readings sit side by side, each with what it does and does not mean. A conflict is described, never turned
    into a reversal call: the readings may resolve either way and the page says so."""
    out: list[dict[str, Any]] = []
    pos = by.get("positioning", {})
    spot15 = num(pos.get("price_change_15m_pct"))
    rising = spot15 is not None and spot15 >= 0.05
    h = inp.get("heavy") or {}
    agg = h.get("aggregate") or {}
    hw15 = num((agg.get("15") or {}).get("score"))
    hw15 = hw15 if hw15 is not None else num((agg.get("session") or {}).get("score"))
    acc = g(inp.get("rolling"), "acceleration") or {}
    cur_p, prev_p = num(acc.get("current_pct")), num(acc.get("previous_pct"))

    def add(id_: str, title: str, reading: str, means: str) -> None:
        out.append({"id": id_, "title": title, "reading": reading, "explanation": means + " This is a description of conflicting or confirming readings, not a reversal signal.", "reversal_signal": False})

    if rising and hw15 is not None and hw15 <= -15:
        add("up_vs_heavy_cvd", "NIFTY rising with a negative heavyweight CVD proxy", f"NIFTY future {spot15:+.2f}% over 15 minutes while the weighted heavyweight CVD proxy is {hw15:+.0f}", "The advance is not matched by estimated buying in the five largest stocks; the CVD is an estimate from quotes.")
    improving = [n for n, v in (("futures", None if cur_p is None or prev_p is None else cur_p - prev_p), ("heavyweights", num(agg.get("momentum")))) if v is not None and v > 0]
    if rising and improving:
        add("up_with_improving_cvd", "NIFTY rising with an improving five-minute CVD proxy", f"NIFTY future {spot15:+.2f}% over 15 minutes and the 5-minute CVD proxy is stronger than the previous 5 minutes ({' and '.join(improving)})", "Estimated pressure is strengthening alongside price; two consecutive equal windows are compared, so this is short-lived evidence.")
    oc = num(pos.get("oi_change_15m"))
    if rising and oc is not None and oc < 0:
        add("up_oi_down", "Futures open interest falling while price rises", f"NIFTY future {spot15:+.2f}% while futures OI changed {oc:+,.0f} over 15 minutes", "Short covering or long exits can lift price without new positions; it often fades without fresh buying but can also precede a continuation.")
    v = g(inp.get("intraday"), "vwap") or {}
    if num(v.get("distance_pts")) is not None:
        add("futures_vs_vwap", "Futures price versus futures VWAP", f"NIFTY future {v.get('side')} its own day VWAP {v.get('vwap')} by {v.get('distance_pts')} pts ({v.get('distance_pct')}%); spot is not compared with the futures VWAP because the index has no traded volume", "A location reading of one instrument against its own average traded price.")
    if gx.get("available") and (gx.get("net") or 0) > 0 and gx.get("flip_distance_pct") is not None and abs(gx["flip_distance_pct"]) >= 0.5:
        sup = (gx.get("flip_support") or {}).get("status")
        add("positive_gex_far_flip", "Positive modelled GEX with a distant gamma flip", f"modelled net GEX is positive and the modelled flip {gx['flip']:.0f} is {abs(gx['flip_distance_pts']):.0f} pts ({abs(gx['flip_distance_pct']):.2f}%) {'below' if gx['flip_distance_pct'] > 0 else 'above'} spot; flip support: {sup}", "Under the assumed sign convention the modelled exposure is stabilising at spot, but the flip is far enough away that its level depends on the model; this is not observed dealer positioning.")
    return out


def build_engines(inp: Mapping[str, Any], status: Mapping[str, Any]) -> list[dict[str, Any]]:
    fns: list[Callable[[Mapping[str, Any], Mapping[str, Any]], dict[str, Any]]] = [positioning_engine, orderflow_engine, volatility_engine, structure_engine, participation_engine]
    return [f(inp, status) for f in fns]


GEX_METHOD = (
    "Per strike and side: gamma (Black-76 on the stored option price, forward from put-call parity) x open interest in UNITS (the chain already reports units, so no lot-size "
    "multiplier is applied) x spot^2 x 0.01 / 10^7 = Rs crore of delta change per 1 % move. Sign convention ASSUMED, not observed: call exposure counts +, put exposure -, "
    "which presumes dealers are long the calls and short the puts that customers hold; the feed does not say who holds what. Net = sum over strikes that have BOTH a "
    "call and a put exposure; the CE and PE totals use every strike with an exposure on that side. Aggregated over the ATM +-10 strikes of ONE expiry (the selected "
    "weekly or monthly), never across expiries. Gamma flip = the spot level where the aggregate, re-priced at 33 spot levels within +-8 % of spot, changes sign, "
    "located by bisection; none within the range means no flip is reported. It is a model of exposure, not observed dealer positioning."
)

#: every input that more than one group could read, who owns it, and what was done about the overlap
OVERLAP_FINDINGS: list[dict[str, str]] = [
    {"input": "Aggregate command-centre score", "was": "a term inside the structure engine", "fix": "removed: it is itself built from price, VWAP, breadth, PCR and OI, so it double counted every one of them"},
    {"input": "Advance/decline, stocks above VWAP, opening-range share", "was": "structure engine (breadth) and, through the command-centre score, again", "fix": "owned by group E only, as one family (three views of the same 50 stocks)"},
    {"input": "Future's VWAP and the index's day range", "was": "futures engine, structure engine and the command-centre score", "fix": "owned by group D only, as one family"},
    {"input": "PCR change and OI added (puts minus calls)", "was": "two terms in the options engine built from the same open-interest changes", "fix": "one family: the OI-added reading is scored, the PCR change is shown but not scored"},
    {"input": "Options OI and Smart OI labels", "was": "two terms, both from option OI changes", "fix": "one family in group A, averaged into one reading"},
    {"input": "Session CVD and rolling 15-minute CVD", "was": "two terms of the same series (the window is a slice of the session)", "fix": "one family in group B"},
    {"input": "Heavyweight CVD, session and rolling", "was": "two terms of the same stocks", "fix": "one family in group B; heavyweight prices are in group E, never CVD"},
    {"input": "Index price in futures buildup, GEX spot-versus-flip, GEX walls, heavyweight points and advancing weight", "was": "each also read price, which group D reads", "fix": "kept, with an explicit weight of 0.5 on each (the overlap adjustment shown on the term)"},
    {"input": "India VIX and IV rank / percentile", "was": "daily closes shown beside live volatility", "fix": "context only, labelled 'Last Daily Close' with its date, never scored"},
]


def overlap_audit(engines: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """The audit of overlapping inputs and, per group, which family each term belongs to and any overlap adjustment applied to it."""
    return {"findings": OVERLAP_FINDINGS,
            "terms": [{"group": e["key"], "term": t["name"], "family": t["family"], "weight": t["weight"], "shares": t["shares"], "available": t["available"]} for e in engines for t in e["terms"]]}


# ------------------------------------------------------------------------------------------------ capabilities
AVAILABLE, PARTIAL, UNAVAILABLE = "AVAILABLE", "PARTIAL", "UNAVAILABLE"
ROLLOVER_NEED = ("Rollover needs, for BOTH the near-month and the next-month NIFTY future, a stored series of open interest and traded volume by contract (minute or daily). "
                 "Only the current-month contract is subscribed and stored today (each `fut` sample carries one contract's symbol and expiry), so no rollover percentage is shown.")


def capabilities(inp: Mapping[str, Any], status: Mapping[str, Any], gx: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The state of every capability named in the integration audit, from the data actually present now: AVAILABLE, PARTIAL (an incomplete
    calculation or coverage) or UNAVAILABLE (the data is not collected or stored). ``as_of`` is each source's own timestamp."""
    ins, mk, fut, skew = inp.get("intraday"), inp.get("market"), inp.get("futures"), inp.get("skew")
    rows: list[dict[str, Any]] = []

    def add(id_: str, name: str, state: str, reason: str, src: str, link: str | None = None) -> None:
        rows.append({"id": id_, "name": name, "status": state, "reason": reason, "source": src, "as_of": g(status, src, "as_of"), "link": link})

    o = g(ins, "options") or {}
    add("options_oi", "Options OI and change in OI", AVAILABLE if o.get("ce_oi") is not None else UNAVAILABLE, "ATM ±10 strikes of the stored chain; change is against the first sample of the session" if o.get("ce_oi") is not None else "no stored chain", "intraday", "/option-chain")
    pos = inp.get("positioning") or {}
    smart = AVAILABLE if pos.get("then_at") and pos.get("rows") else (PARTIAL if pos.get("rows") else UNAVAILABLE)
    add("smart_oi", "Smart OI classifications", smart, "premium and OI rule, labels are 'potential'; no buyer/seller identity" if smart == AVAILABLE else ("no earlier snapshot to compare with: changes are missing" if smart == PARTIAL else "no positioning data"), "positioning", "/tools/strike-positioning")
    add("pcr", "PCR", AVAILABLE if o.get("pcr_oi") is not None else UNAVAILABLE, "OI and volume PCR, ATM ±10", "intraday", "/tools/put-call-ratio")
    add("gex", "GEX (server rebuild)", AVAILABLE if gx.get("available") else UNAVAILABLE, "same formula as the browser (parity-tested); model sign calls +, puts −" if gx.get("available") else "no rebuilt snapshot", "gex", "/tools/gamma-exposure")
    vega_ok = bool(g(ins, "volatility", "rows"))
    add("vega", "Vega", PARTIAL if vega_ok else UNAVAILABLE, "average vega per option only; OI-weighted exposure, change and migration exist only in the browser page" if vega_ok else "no solved chain", "intraday", "/tools/vega-analysis")
    add("atm_iv", "ATM IV and change", AVAILABLE if g(ins, "volatility", "atm_iv") is not None else UNAVAILABLE, "Black-76 on the stored chain", "intraday", "/tools/iv-intraday")
    hv = g(inp.get("vix"), "hv") or []
    add("hv_rv", "HV, RV and India VIX", AVAILABLE if any(v is not None for v in hv) else UNAVAILABLE, "daily closes; VIX is a daily close, not live", "vix", "/tools/iv-hv")
    iv = [v for v in (g(inp.get("vix"), "iv") or []) if v is not None]
    add("ivr_ivp", "IV Rank and Percentile", AVAILABLE if len(iv) >= 252 else (PARTIAL if iv else UNAVAILABLE), "252-day window of VIX closes" if len(iv) >= 252 else f"only {len(iv)} VIX closes stored (252 needed for the full window)", "vix", "/tools/iv-chart")
    add("skew_term", "IV skew, risk reversal, butterfly, term structure", AVAILABLE if g(skew, "cards") else UNAVAILABLE, "interpolated in delta; one expiry per request, term across stored expiries", "skew", "/tools/volatility-skew")
    oi_series = [v for v in (g(fut, "oi") or []) if v is not None]
    add("futures_oi", "Futures OI and change", AVAILABLE if oi_series else UNAVAILABLE, "minute samples of the current-month contract", "futures", "/tools/future-price-oi")
    flow = g(mk, "flow", "futures") or {}
    add("session_cvd", "Session CVD (futures)", AVAILABLE if flow.get("cvd_pct") is not None else UNAVAILABLE, "ESTIMATE by the quote and tick rule, not a trade tape" if flow.get("cvd_pct") is not None else "no futures flow tracked", "market", "/tools/future-flow")
    ok_w = g(inp.get("rolling"), "ok_windows") or 0
    add("rolling_cvd", "Rolling 5/15/30-minute CVD", AVAILABLE if ok_w == 3 else (PARTIAL if ok_w else UNAVAILABLE),
        "derived from the stored per-minute cumulative flow (estimate)" if ok_w == 3 else ("; ".join(f"{w['minutes']} min: {w['status']}" for w in (g(inp.get("rolling"), "windows") or {}).values() if w["status"] != "ok") or "no stored flow"), "flow", "/tools/future-flow")
    add("vwap", "VWAP and deviation", AVAILABLE if g(ins, "vwap", "vwap") is not None else UNAVAILABLE, "the future's own VWAP (exchange average traded price), not the index's", "intraday", "/tools/future-flow")
    add("spot_futures", "NIFTY spot and futures", AVAILABLE if g(ins, "price", "last") is not None and g(fut, "latest", "future") is not None else (PARTIAL if g(ins, "price", "last") is not None else UNAVAILABLE), "spot from the chain sample, futures from the minute samples", "futures", "/tools/future-dashboard")
    stocks = g(mk, "flow", "heavy5", "stocks") or []
    add("heavyweights", "Heavyweight stock analytics", AVAILABLE if stocks else UNAVAILABLE, "the five largest constituents by current weight; stock prices and estimated CVD only" if stocks else "no heavyweight flow", "market", "/tools/future-flow")
    add("structure", "Market structure and breadth", AVAILABLE if g(mk, "nifty50", "breadth") else UNAVAILABLE, "advance/decline, above-VWAP share, opening range, day range", "market", "/tools/market-movers")
    h = inp.get("heavy") or {}
    q = h.get("quality") or {}
    w = q.get("weights") or {}
    add("hw_weights", "Heavyweight index weights", UNAVAILABLE if not w.get("as_of") else (PARTIAL if w.get("stale") or w.get("approximate") else AVAILABLE),
        "no stored weights" if not w.get("as_of") else f"as of {w.get('as_of')} from {w.get('source')}" + (" (STALE: older than 60 days, a newer official composition has not been loaded)" if w.get("stale") else "") + (" (approximate)" if w.get("approximate") else ""), "market", "/tools/future-flow")
    add("hw_cvd", "Heavyweight CVD (per stock, rolling 5/15/30 min, aggregate)", UNAVAILABLE if not h.get("available") else (AVAILABLE if q.get("aggregate_available") and q.get("valid") == q.get("of") else PARTIAL if q.get("aggregate_available") else UNAVAILABLE),
        "CVD PROXY by the quote and tick rule; " + ("all stocks valid" if q.get("valid") == q.get("of") else f"{q.get('valid')} of {q.get('of')} stocks valid") if h.get("available") else "no heavyweight flow", "market", "/tools/future-flow")
    add("hw_genuine_cvd", "Genuine aggressor-side CVD for the heavyweights", UNAVAILABLE, "the feed carries no aggressor-side trade tape or per-trade timestamps; only a labelled proxy exists", "market", None)
    ml = inp.get("ml") or {}
    st_ml, ev = ml.get("status") or {}, ml.get("last_evaluation") or {}
    gate_ok = bool((ev.get("gate") or {}).get("show_probabilities"))
    add("intraday_ml", "Intraday ML model", AVAILABLE if gate_ok else (PARTIAL if ml else UNAVAILABLE),
        ("passed its validation gate; shown as context, not scored" if gate_ok else f"research only: {st_ml.get('labelled_sessions', 0)} labelled session(s), stage '{st_ml.get('stage_name', 'unknown')}'; no probability may be shown until the gate passes, and it is not part of the score") if ml else "the intraday research service is not running",
        "ml", "/analysis")
    add("spot_vwap", "Spot (index) VWAP", UNAVAILABLE, "the NIFTY 50 index has no traded volume, so a spot VWAP cannot be computed; only the future's own VWAP exists and spot is never compared with it", "intraday", None)
    add("rollover", "Rollover data", UNAVAILABLE, ROLLOVER_NEED, "futures", None)
    add("stock_futures", "Individual stock futures", UNAVAILABLE, "stock futures are not subscribed or stored; heavyweight analysis uses cash-market prices and flow only", "market", None)
    add("option_aggressor", "Option trade-side (aggressor) data", UNAVAILABLE, "the feed carries no aggressor side for options; buyer- or seller-initiated trades are never inferred", "positioning", None)
    return rows
