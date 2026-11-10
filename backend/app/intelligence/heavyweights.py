"""NIFTY 50 heavyweight intelligence: per-stock CVD proxy readings, normalised weighted aggregate, participation and divergence (pure functions).

Inputs are what the application already records (nothing new is subscribed): the live per-stock flow trackers inside the market summary
(``market.flow.heavy5.stocks[].flow``), the per-minute ``heavy5`` samples the market sampler stores (cumulative buy, sell and traded volume,
price, the exchange average traded price, the index weight at that minute) and the ``fut`` samples (NIFTY level at the same minute).

**Methodology: CVD PROXY.** The feed has no aggressor-side trade tape and no per-trade timestamps. Each volume increase between two pushes is
classified by the quote rule (at or above the ask = buy, at or below the bid = sell) and otherwise the tick rule (market/flow.py). Buyer- and
seller-initiated volume are therefore never observed; every figure here is a proxy and is labelled so. Volume that traded before the tracker's
first push (opening auction, a backend restart) is not classified and is never guessed.

    window CVD %      = (CVD(now) - CVD(then)) / (classified volume(now) - classified volume(then)) x 100      (rolling 5, 15, 30 minutes)
    normalised CVD    = 100 x tanh(clip(CVD %, -100, 100) / 25)       scale-free (a share of the stock's own classified volume) and saturating, so a
                                                                       high-volume stock and an extreme reading cannot dominate
    aggregate         = sum(normalised CVD_i x w_i) / sum(w_i)        w_i = index weight, over the stocks with a valid reading only

A rolling window needs real stored samples at both ends (within 2 minutes), continuous flow (a backend restart resets the counters, so older samples
are not used) and classified volume of at least half the window's traded volume; otherwise it is unavailable with its reason. Nothing is
reconstructed. The aggregate is unavailable unless at least 3 stocks and 60 % of the top-five weight are valid: a partial aggregate is always shown
with its stock count and never as a five-stock figure.
"""

from __future__ import annotations

import math
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from typing import Any

WINDOWS = (5, 15, 30)
TOLERANCE_MIN = 2.0
SCALE = 25.0                # CVD % that counts as strong evidence (normalised about 76)
MIN_VALID = 3
MIN_WEIGHT_SHARE = 0.6
MIN_WINDOW_SHARE = 0.5      # classified share of a window's volume
NEUTRAL_BAND = 10.0         # a normalised stock reading inside this is neither buying nor selling
AGG_BAND = 15.0
STORED_STALE_S = 180.0      # the newest stored sample older than this is not used for rolling windows
STALE_WEIGHTS_DAYS = 60
IDX_MOVE_PCT = 0.10
METHOD = "CVD PROXY: quote rule (trade at or beyond the best bid/ask), then tick rule; estimated from the quote stream, no aggressor-side trade tape"
LIMITS = ["Buyer- and seller-initiated volume are not observed: every CVD figure is an estimate (CVD PROXY).",
          "Volume traded before the tracker's first push of the session (opening auction, a backend restart) is not classified.",
          "Trade timestamps are not available from the feed; observations carry the local receipt time of the push.",
          "Last traded quantity is not provided; volume deltas between pushes are used, and one push can bundle several trades.",
          "Normalisation is against each stock's own classified volume; a historical volume distribution needs several stored sessions of per-stock flow, which are only now being recorded."]


def clip(x: float, lim: float) -> float:
    return max(-lim, min(lim, x))


def norm(pct: float | None) -> float | None:
    return None if pct is None else round(100.0 * math.tanh(clip(pct, 100.0) / SCALE), 1)


def _t(s: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(s))
    except (TypeError, ValueError):
        return None


def _num(x: Any) -> float | None:
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) else None


class Pt:
    __slots__ = ("t", "cvd", "b", "s", "v", "ltp", "atp", "weight", "chg")

    def __init__(self, t: datetime, r: Sequence[Any]) -> None:
        def g(i: int) -> float | None:
            return _num(r[i]) if len(r) > i else None

        self.t, self.cvd, self.b, self.s, self.v = t, g(1), g(2), g(3), g(4)
        self.ltp, self.atp, self.weight, self.chg = g(6), g(7), g(8), g(9)


def points(samples: Sequence[tuple[str, Mapping[str, Any]]]) -> dict[str, list[Pt]]:
    """Per symbol the stored points in time order, from the last counter restart onward (older points belong to a different counter run)."""
    raw: dict[str, list[Pt]] = {}
    for stamp, pl in samples:
        t = _t(stamp)
        if t is None:
            continue
        for r in pl.get("rows", []):
            if isinstance(r, list) and len(r) >= 5 and isinstance(r[0], str):
                p = Pt(t, r)
                if None not in (p.cvd, p.b, p.s, p.v):
                    raw.setdefault(r[0], []).append(p)
    out: dict[str, list[Pt]] = {}
    for sym, pts in raw.items():
        pts.sort(key=lambda p: p.t)
        start = 0
        for i in range(1, len(pts)):
            if (pts[i].b or 0) + (pts[i].s or 0) < (pts[i - 1].b or 0) + (pts[i - 1].s or 0) or (pts[i].v or 0) < (pts[i - 1].v or 0):
                start = i
        out[sym] = pts[start:]
    return out


def window(pts: Sequence[Pt], i: int, minutes: int, times: Sequence[datetime] | None = None) -> dict[str, Any]:
    """The rolling window ending at ``pts[i]``: {cvd, pct, norm, status}."""
    base: dict[str, Any] = {"minutes": minutes, "cvd": None, "pct": None, "norm": None, "price_change_pct": None, "status": ""}
    ts = times if times is not None else [p.t for p in pts]
    target = pts[i].t - timedelta(minutes=minutes)
    j = bisect_right(ts, target, 0, i + 1) - 1
    if j < 0:
        return base | {"status": f"unavailable: fewer than {minutes} minutes of continuous stored flow"}
    if (target - pts[j].t).total_seconds() > TOLERANCE_MIN * 60:
        return base | {"status": f"unavailable: no stored sample within {TOLERANCE_MIN:.0f} minutes of {minutes} minutes ago"}
    a, b = pts[j], pts[i]
    cls = (b.b or 0) + (b.s or 0) - (a.b or 0) - (a.s or 0)
    vol = (b.v or 0) - (a.v or 0)
    if cls <= 0:
        return base | {"status": "unavailable: no classified volume in the window"}
    if vol > 0 and cls / vol < MIN_WINDOW_SHARE:
        return base | {"status": "unavailable: classified volume is under half of the window volume"}
    d = (b.cvd or 0) - (a.cvd or 0)
    pct = d / cls * 100
    pc = None if not a.ltp or not b.ltp else round((b.ltp / a.ltp - 1) * 100, 3)
    return base | {"cvd": d, "pct": round(pct, 2), "norm": norm(pct), "price_change_pct": pc, "status": "ok"}


def aggregate(items: Sequence[tuple[float, float | None]], total_weight: float) -> dict[str, Any]:
    """Weighted mean of normalised readings over the valid stocks. ``items`` = (index weight, normalised reading or None)."""
    ok = [(w, v) for w, v in items if v is not None and w > 0]
    ws = sum(w for w, _ in ok)
    share = 0.0 if total_weight <= 0 else ws / total_weight
    if len(ok) < MIN_VALID or share < MIN_WEIGHT_SHARE:
        return {"score": None, "valid": len(ok), "of": len(items), "weight_share": round(share, 3),
                "status": f"unavailable: {len(ok)} of {len(items)} stocks valid (need {MIN_VALID} and {MIN_WEIGHT_SHARE:.0%} of the weight)"}
    return {"score": round(sum(w * v for w, v in ok) / ws, 1), "valid": len(ok), "of": len(items), "weight_share": round(share, 3),
            "status": "ok" if len(ok) == len(items) else f"PARTIAL: {len(ok)} of {len(items)} stocks"}


def _classify(score: float | None, rows: Sequence[Mapping[str, Any]], idx15: float | None) -> dict[str, Any]:
    valid = [r for r in rows if r["basis_norm"] is not None]
    n = len(valid)
    if score is None or n < MIN_VALID:
        return {"class": "Unavailable", "valid": n, "positive": None, "negative": None, "neutral": None, "weight_share_positive": None, "weight_share_negative": None, "top_contributor": None,
                "reason": "fewer than 3 valid heavyweights"}
    wt = sum(r["weight"] for r in valid) or 1.0
    pos = [r for r in valid if r["basis_norm"] >= NEUTRAL_BAND]
    neg = [r for r in valid if r["basis_norm"] <= -NEUTRAL_BAND]
    wp, wn = sum(r["weight"] for r in pos) / wt, sum(r["weight"] for r in neg) / wt
    contrib = [(r["symbol"], r["weight"] / wt * r["basis_norm"]) for r in valid]
    top = max(contrib, key=lambda c: abs(c[1]))
    side_total = sum(abs(c) for _, c in contrib if c * score > 0) or 1.0
    top_share = abs(top[1]) / side_total if top[1] * score > 0 else 0.0
    need = max(3, math.ceil(0.75 * n))
    if idx15 is not None and abs(idx15) >= IDX_MOVE_PCT and abs(score) >= AGG_BAND and idx15 * score < 0:
        name = "Heavyweight divergence"
    elif score >= AGG_BAND:
        name = "Broad heavyweight buying" if len(pos) >= need and wp >= 0.7 else "Narrow heavyweight buying" if len(pos) <= 2 or top_share > 0.6 else "Mixed heavyweight participation"
    elif score <= -AGG_BAND:
        name = "Broad heavyweight selling" if len(neg) >= need and wn >= 0.7 else "Narrow heavyweight selling" if len(neg) <= 2 or top_share > 0.6 else "Mixed heavyweight participation"
    else:
        name = "Mixed heavyweight participation"
    return {"class": name, "valid": n, "positive": len(pos), "negative": len(neg), "neutral": n - len(pos) - len(neg), "weight_share_positive": round(wp, 3), "weight_share_negative": round(wn, 3),
            "top_contributor": {"symbol": top[0], "share": round(top_share, 3)}, "reason": None}


def signals(agg: Mapping[str, Any], part: Mapping[str, Any], nifty: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The seven NIFTY-versus-heavyweight observations. Analytical descriptions, never reversal signals; status (early warning / developing / confirmed /
    invalidated) is assigned by the service from how many consecutive recorded minutes carried the same signal."""
    out: list[dict[str, Any]] = []
    a15 = (agg.get("15") or {}).get("score")
    mom = agg.get("momentum")
    idx15, day = nifty.get("change_15m_pct"), nifty.get("day_change_pct")
    cls = part.get("class")

    def add(id_: str, name: str, direction: str, kind: str, reading: str, why: str, invalid: str) -> None:
        out.append({"id": id_, "name": name, "direction": direction, "severity": "medium" if kind == "divergence" else "low", "kind": kind, "reading": reading, "explanation": why, "invalidation": invalid,
                    "evidence": [f"aggregate 15-min {a15:+.0f}" if a15 is not None else "aggregate 15-min unavailable", f"NIFTY {idx15:+.2f}% (15 min)" if idx15 is not None else "NIFTY 15-min change unavailable",
                                 f"participation: {cls}"], "at": agg.get("as_of")})

    if a15 is not None and idx15 is not None:
        if idx15 >= IDX_MOVE_PCT and a15 <= -AGG_BAND:
            add("hw_up_cvd_down", "NIFTY rising while heavyweight CVD falls", "bearish", "divergence", f"NIFTY {idx15:+.2f}% while aggregate heavyweight CVD proxy is {a15:+.0f}",
                "The index is rising against estimated selling pressure in its five largest stocks.", "aggregate CVD turns positive or NIFTY stops rising")
        if idx15 <= -IDX_MOVE_PCT and a15 >= AGG_BAND:
            add("hw_down_cvd_up", "NIFTY falling while heavyweight CVD rises", "bullish", "divergence", f"NIFTY {idx15:+.2f}% while aggregate heavyweight CVD proxy is {a15:+.0f}",
                "The index is falling against estimated buying pressure in its five largest stocks.", "aggregate CVD turns negative or NIFTY stops falling")
        if idx15 >= IDX_MOVE_PCT and cls == "Broad heavyweight buying":
            add("hw_up_broad", "NIFTY rising with broad heavyweight buying", "bullish", "confirmation", f"NIFTY {idx15:+.2f}% with {part.get('positive')} of {part.get('valid')} heavyweights buying",
                "The advance is supported by most of the largest constituents (estimated).", "heavyweight participation narrows or turns negative")
        if idx15 >= IDX_MOVE_PCT and cls == "Narrow heavyweight buying":
            add("hw_up_narrow", "NIFTY rising with narrow heavyweight participation", "bearish", "divergence", f"NIFTY {idx15:+.2f}% with only {part.get('positive')} of {part.get('valid')} heavyweights buying",
                "The advance leans on one or two stocks rather than the group (estimated).", "more heavyweights turn to buying")
        if idx15 <= -IDX_MOVE_PCT and cls == "Broad heavyweight selling":
            add("hw_down_broad", "NIFTY falling with broad heavyweight selling", "bearish", "confirmation", f"NIFTY {idx15:+.2f}% with {part.get('negative')} of {part.get('valid')} heavyweights selling",
                "The decline is broad across the largest constituents (estimated).", "heavyweight selling narrows or reverses")
    if mom is not None and day is not None:
        if mom >= AGG_BAND and day <= -0.15:
            add("hw_recovering", "Heavyweight CVD recovering while NIFTY remains weak", "bullish", "divergence", f"CVD momentum {mom:+.0f} (5-min versus 15-min aggregate) while NIFTY is {day:+.2f}% on the day",
                "Estimated heavyweight pressure is improving before the index.", "momentum fades or NIFTY falls further with CVD")
        if mom <= -AGG_BAND and day >= 0.15:
            add("hw_deteriorating", "Heavyweight CVD deteriorating while NIFTY remains strong", "bearish", "divergence", f"CVD momentum {mom:+.0f} (5-min versus 15-min aggregate) while NIFTY is {day:+.2f}% on the day",
                "Estimated heavyweight pressure is weakening beneath a strong index.", "momentum recovers")
    return out


def assess(inp: Mapping[str, Any], now: datetime | None = None) -> dict[str, Any]:
    """Everything the dashboard and the sentiment engine need about the heavyweights, from one pass over the stored samples and the live trackers."""
    mk = inp.get("market") or {}
    live = (mk.get("flow") or {}).get("heavy5") or {}
    stocks_live = live.get("stocks") or []
    flow = inp.get("flow") or {}
    pts = points(flow.get("heavy5") or [])
    meta = inp.get("heavymeta") or {}
    names = {s.get("symbol"): s for s in meta.get("stocks", [])}
    now = now or _t(mk.get("generated_at")) or max((p[-1].t for p in pts.values() if p), default=None)
    syms = [s.get("symbol") for s in stocks_live] or sorted(pts)
    if not syms:
        return {"available": False, "reason": "no heavyweight flow is tracked yet", "method": METHOD, "limits": LIMITS, "stocks": [], "aggregate": {}, "participation": {"class": "Unavailable"}, "signals": [], "series": []}
    total_w = sum((_num(s.get("weight")) or 0.0) for s in stocks_live) or sum((p[-1].weight or 0.0) for p in pts.values() if p)
    live_by = {s.get("symbol"): s for s in stocks_live}
    rows: list[dict[str, Any]] = []
    series_by: dict[str, tuple[list[Pt], list[datetime]]] = {}
    for sym in syms:
        lv = live_by.get(sym) or {}
        fl = lv.get("flow") or {}
        w = _num(lv.get("weight")) or (pts[sym][-1].weight if pts.get(sym) else None) or 0.0
        p = pts.get(sym) or []
        times = [x.t for x in p]
        series_by[sym] = (p, times)
        stale = fl.get("stale")
        age = _num(fl.get("age_seconds"))
        share = _num(fl.get("classified_share"))
        pct = _num(fl.get("cvd_pct"))
        feed = "no data" if not fl else ("STALE" if stale else "live")
        fresh = bool(fl) and stale is not True
        ok_session = fresh and pct is not None and (share is None or share >= MIN_WINDOW_SHARE)
        wins: dict[str, dict[str, Any]] = {}
        for m_ in WINDOWS:
            if not p:
                wins[str(m_)] = {"minutes": m_, "cvd": None, "pct": None, "norm": None, "price_change_pct": None, "status": "unavailable: no stored flow samples today"}
            elif now is not None and (now - p[-1].t).total_seconds() > STORED_STALE_S:
                wins[str(m_)] = {"minutes": m_, "cvd": None, "pct": None, "norm": None, "price_change_pct": None, "status": "unavailable: the newest stored sample is older than 3 minutes"}
            else:
                wins[str(m_)] = window(p, len(p) - 1, m_, times)
            if not fresh and wins[str(m_)]["status"] == "ok":
                wins[str(m_)] = wins[str(m_)] | {"norm": None, "status": "unavailable: live feed is stale"}
        n5 = wins["5"]["norm"]
        n15 = wins["15"]["norm"]
        prev5 = None
        if p and len(p) > 1:
            tgt = p[-1].t - timedelta(minutes=5)
            k = bisect_right(times, tgt) - 1
            if k >= 0 and (tgt - times[k]).total_seconds() <= TOLERANCE_MIN * 60:
                prev5 = window(p, k, 5, times).get("norm")
        sess_norm = norm(pct) if ok_session else None
        basis = n15 if n15 is not None else sess_norm
        vwap, ltp = _num(fl.get("vwap")), _num(fl.get("last_price")) or (p[-1].ltp if p else None)
        pv = None if not vwap or not ltp else round((ltp / vwap - 1) * 100, 3)
        change = _num(lv.get("change_pct"))
        bias = "No reading" if basis is None else "Buying" if basis >= NEUTRAL_BAND else "Selling" if basis <= -NEUTRAL_BAND else "Neutral"
        if basis is not None and pv is not None and abs(basis) >= NEUTRAL_BAND:
            bias += " · " + ("above" if pv >= 0 else "below") + " VWAP" + (" (confirmed)" if (pv >= 0) == (basis > 0) else " (unconfirmed)")
        pc15 = wins["15"]["price_change_pct"]
        div = None
        if pc15 is not None and n15 is not None and abs(pc15) >= 0.05 and abs(n15) >= AGG_BAND and pc15 * n15 < 0:
            div = "price up, CVD proxy down" if pc15 > 0 else "price down, CVD proxy up"
        nm = names.get(sym) or {}
        rows.append({
            "symbol": sym, "name": nm.get("name"), "weight": round(w, 3), "previous_weight": nm.get("previous_weight"), "price": ltp, "change_pct": change, "vwap": vwap, "price_vs_vwap_pct": pv,
            "session": {"cvd": fl.get("cvd"), "pct": pct, "norm": sess_norm, "buy_volume": fl.get("buy_volume"), "sell_volume": fl.get("sell_volume")}, "windows": wins,
            "momentum": None if n5 is None or n15 is None else round(n5 - n15, 1), "acceleration": None if n5 is None or prev5 is None else round(n5 - prev5, 1),
            "basis_norm": basis, "bias": bias, "price_cvd_divergence": div, "bid": fl.get("bid"), "ask": fl.get("ask"), "depth_imbalance": fl.get("depth_imbalance"),
            "freshness": {"updated": fl.get("updated"), "age_s": age, "feed": feed, "fresh": fresh, "classified_share": share, "coverage_of_day_volume": _num(fl.get("coverage_of_day_volume")),
                          "quote_rule_share": _num(fl.get("quote_rule_share")), "stored_samples": len(p)},
            "methodology": "CVD PROXY", "valid": ok_session,
        })
    # aggregates
    agg: dict[str, Any] = {"session": aggregate([(r["weight"], r["session"]["norm"]) for r in rows], total_w)}
    for m_ in WINDOWS:
        agg[str(m_)] = aggregate([(r["weight"], r["windows"][str(m_)]["norm"]) for r in rows], total_w)
    s5, s15 = agg["5"]["score"], agg["15"]["score"]
    agg["momentum"] = None if s5 is None or s15 is None else round(s5 - s15, 1)
    # time series of the stored aggregate (chart, acceleration)
    spot_by: dict[datetime, float | None] = {}
    for s_, r_ in flow.get("fut") or []:
        t_ = _t(s_)
        if t_ is not None and isinstance(r_, Mapping):
            spot_by[t_] = _num(r_.get("spot"))
    stamps = sorted({p_.t for p, _ in series_by.values() for p_ in p})
    index: dict[str, dict[datetime, int]] = {sym: {x.t: i for i, x in enumerate(series_by[sym][0])} for sym in syms}
    wts = {r["symbol"]: r["weight"] for r in rows}
    series: list[dict[str, Any]] = []
    for T in stamps:
        sess_items, w5_items, w15_items = [], [], []
        for sym in syms:
            i = index[sym].get(T)
            if i is None:
                continue
            p, times = series_by[sym]
            cls = (p[i].b or 0) + (p[i].s or 0)
            sess_items.append((wts[sym], norm((p[i].cvd or 0) / cls * 100) if cls > 0 else None))
            w5_items.append((wts[sym], window(p, i, 5, times)["norm"]))
            w15_items.append((wts[sym], window(p, i, 15, times)["norm"]))
        a, b, c = aggregate(sess_items, total_w), aggregate(w5_items, total_w), aggregate(w15_items, total_w)
        iso = T.isoformat()
        series.append({"t": iso, "session": a["score"], "w5": b["score"], "w15": c["score"], "spot": spot_by.get(T)})
    acc = None
    timed = [(_t(x["t"]), x["w5"]) for x in series if x["w5"] is not None]
    if timed and timed[-1][0] is not None:
        t_end = timed[-1][0]
        tgt5 = t_end - timedelta(minutes=5)
        prev5s = [(t_, v_) for t_, v_ in timed if t_ is not None and t_ <= tgt5]
        if prev5s and prev5s[-1][0] is not None and (tgt5 - prev5s[-1][0]).total_seconds() <= TOLERANCE_MIN * 60:
            acc = round(timed[-1][1] - prev5s[-1][1], 1)
    agg["acceleration"] = acc
    agg["as_of"] = max((r["freshness"]["updated"] for r in rows if r["freshness"]["updated"]), default=None)
    # NIFTY context
    spots = [(t, s) for t, s in ((x["t"], x["spot"]) for x in series) if isinstance(s, (int, float))]
    idx15 = None
    if spots:
        t_last = _t(spots[-1][0])
        if t_last is not None:
            tgt = t_last - timedelta(minutes=15)
            old = [s for t, s in spots if (_t(t) or t_last) <= tgt]
            if old and spots[-1][1] and old[-1]:
                idx15 = round((spots[-1][1] / old[-1] - 1) * 100, 3)
    nifty = {"change_15m_pct": idx15, "day_change_pct": _num(mk.get("index_change_pct")), "vwap_side": (inp.get("intraday") or {}).get("vwap", {}).get("side") if isinstance((inp.get("intraday") or {}).get("vwap"), Mapping) else None}
    basis_score = s15 if s15 is not None else agg["session"]["score"]
    part = _classify(basis_score, rows, idx15)
    # percentage contribution of each stock to the pressure (weight x normalised reading, share of the absolute total)
    denom = sum(abs(r["weight"] / total_w * r["basis_norm"]) for r in rows if r["basis_norm"] is not None and total_w) or 0.0
    for r in rows:
        r["contribution_pct"] = None if r["basis_norm"] is None or not denom or not total_w else round(r["weight"] / total_w * r["basis_norm"] / denom * 100, 1)
    rs = None
    chg = [(r["weight"], r["change_pct"]) for r in rows if r["change_pct"] is not None and r["weight"]]
    if chg and nifty["day_change_pct"] is not None:
        rs = round(sum(w * c for w, c in chg) / sum(w for w, _ in chg) - nifty["day_change_pct"], 3)
    w_info = meta.get("weights") or (mk.get("sources") or {}).get("weights") or {}
    age_days = _num(w_info.get("age_days"))
    quality = {"valid": agg["15"]["valid"] if agg["15"]["score"] is not None else agg["session"]["valid"], "of": len(rows), "weight_share": agg["session"]["weight_share"],
               "aggregate_available": basis_score is not None, "weights": {**w_info, "stale": bool(age_days is not None and age_days > STALE_WEIGHTS_DAYS), "approximate": bool(w_info.get("approximate")), "basis": live.get("basis")}}
    return {"available": True, "method": METHOD, "limits": LIMITS, "as_of": agg["as_of"], "stocks": rows, "aggregate": agg, "participation": part, "nifty": nifty, "relative_strength_pct": rs,
            "signals": signals(agg, part, nifty), "series": series, "quality": quality, "total_weight": round(total_w, 3)}
