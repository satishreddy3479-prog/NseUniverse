"""Rules-based intraday sentiment, regime and scenarios (transparent baseline, NOT a validated model).

Scoring method (config ``SCORE_CONFIG``; its version is stored with every score snapshot):

* Evidence is grouped so that correlated measures count once. All price measures (move since the
  previous close, last-30-minute move) form ONE group; they are averaged inside the group before
  the group gets its single weight.
* Every component is normalised to [-1, +1] by dividing by a typical move size taken from the data
  (60-session daily standard deviation, scaled to the horizon) and clipping. +1 = bullish evidence.
* Groups with no usable data are marked unavailable and their weight is left out:
  ``score = sum(w_g * s_g) / sum(w_g over available groups)``. Coverage is
  ``sum(w_g over available) / sum(all w_g)`` and is shown next to the score. Below
  ``min_coverage``, or without the price group, the result is "insufficient data".
* Volatility and scheduled events are not directional: they set the volatility regime and risk
  flags, not the score.
* The weights and scales are provisional judgement calls. They have NOT been fitted or validated
  on history; the stored snapshots exist so they can be evaluated later.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from typing import Any

from app.intraday.features import SESSION_MINUTES, DailyContext, OptionsFeatures, PriceFeatures

SCORE_CONFIG: dict[str, Any] = {
    "name": "intraday-rules",
    "version": "1",
    "weights": {
        "price": 0.35,
        "breadth": 0.15,
        "sectors": 0.10,
        "options": 0.20,
        "global": 0.10,
        "institutional": 0.10,
    },
    "min_coverage": 0.45,
    "min_price_samples": 3,
    "trend_min_samples": 10,
    "labels": [
        (0.5, "Bullish"),
        (0.2, "Moderately bullish"),
        (-0.2, "Neutral / range-bound"),
        (-0.5, "Moderately bearish"),
    ],
    "options_oi_scale": 0.05,  # (dPE - dCE) / total OI of 5% = full-strength component
    "options_pcr_scale": 0.20,  # PCR change of 0.20 since the first sample = full strength
    "fii_scale_cr": 3000.0,  # tanh(net / 3000 crore)
    "vol_high": 1.5,
    "vol_low": 0.6,
}
SCORE_VERSION = (
    f"{SCORE_CONFIG['name']}-v{SCORE_CONFIG['version']}-"
    + hashlib.sha256(json.dumps(SCORE_CONFIG, sort_keys=True).encode()).hexdigest()[:8]
)


def clip(x: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


@dataclass
class Component:
    key: str
    name: str
    weight: float
    available: bool
    score: float | None = None
    reason: str = ""
    formula: str = ""
    inputs: list[dict[str, Any]] = field(default_factory=list)
    source: str = ""
    as_of: str | None = None

    @property
    def contribution(self) -> float | None:
        return None if self.score is None else self.score * self.weight

    def public(self) -> dict[str, Any]:
        return {**self.__dict__, "contribution": self.contribution}


@dataclass
class GlobalInput:
    key: str
    name: str
    session: str
    ret_pct: float | None
    sd_pct: float | None
    fresh: bool


@dataclass
class FlowInput:
    session: str
    fii_net: float | None
    dii_net: float | None
    fresh: bool


def price_component(p: PriceFeatures, ctx: DailyContext) -> Component:
    c = Component("price", "NIFTY price action", SCORE_CONFIG["weights"]["price"], False,
                  formula="mean of clip(change since previous close / 60-day daily sd) and clip(30-min return / (daily sd x sqrt(30/375)))",
                  source="Kotak option-chain samples (spot at each fetch)")  # fmt: skip
    if p.samples < SCORE_CONFIG["min_price_samples"] or p.change_pct is None:
        c.reason = (
            f"{p.samples} in-session spot samples so far (need {SCORE_CONFIG['min_price_samples']})"
        )
        return c
    if not ctx.daily_sd_pct:
        c.reason = "no 60-session daily volatility from stored NIFTY history"
        return c
    sd = ctx.daily_sd_pct
    parts = [clip(p.change_pct / sd)]
    c.inputs.append({"name": "Change since previous close", "value": p.change_pct, "unit": "%"})
    c.inputs.append({"name": "Typical daily move (sd, 60 sessions)", "value": sd, "unit": "%"})
    r30 = p.returns_pct.get(30)
    if r30 is not None and p.samples >= SCORE_CONFIG["trend_min_samples"]:
        parts.append(clip(r30 / (sd * math.sqrt(30 / SESSION_MINUTES))))
        c.inputs.append({"name": "Last 30 min", "value": r30, "unit": "%"})
    else:
        c.inputs.append(
            {"name": "Last 30 min", "value": None, "unit": "%", "note": "not enough samples yet"}
        )
    c.available, c.score = True, sum(parts) / len(parts)
    c.as_of = p.last_at.isoformat() if p.last_at else None
    return c


def options_component(o: OptionsFeatures, as_of: str | None) -> Component:
    c = Component("options", "Options positioning", SCORE_CONFIG["weights"]["options"], False,
                  formula="mean of clip(((put OI change - call OI change) / total OI) / 5%) and clip(PCR(OI) change since first sample / 0.20); "
                          "reads added put OI as supportive and added call OI as capping (a convention, not trader intent)",
                  source="Kotak option chain, ATM +/-10 strikes", as_of=as_of)  # fmt: skip
    parts: list[float] = []
    tot = (o.ce_oi or 0) + (o.pe_oi or 0) if o.ce_oi is not None and o.pe_oi is not None else None
    if o.ce_oi_chg is not None and o.pe_oi_chg is not None and tot:
        parts.append(clip((o.pe_oi_chg - o.ce_oi_chg) / tot / SCORE_CONFIG["options_oi_scale"]))
        c.inputs += [{"name": "Call OI change vs previous day", "value": o.ce_oi_chg, "unit": "units"},
                     {"name": "Put OI change vs previous day", "value": o.pe_oi_chg, "unit": "units"}]  # fmt: skip
    if o.pcr_oi_change is not None:
        parts.append(clip(o.pcr_oi_change / SCORE_CONFIG["options_pcr_scale"]))
        c.inputs.append(
            {"name": "PCR (OI) change since first sample", "value": o.pcr_oi_change, "unit": ""}
        )
    if o.pcr_oi is not None:
        c.inputs.append({"name": "PCR (OI)", "value": o.pcr_oi, "unit": ""})
    if not parts:
        c.reason = "no option-chain sample with OI for this expiry today"
        return c
    c.available, c.score = True, sum(parts) / len(parts)
    return c


def global_component(items: list[GlobalInput]) -> Component:
    c = Component("global", "Global markets (overnight)", SCORE_CONFIG["weights"]["global"], False,
                  formula="mean of clip(S&P 500 return / its 60-day sd) and clip(-USD/INR return / its 60-day sd); last completed daily bars",
                  source="Yahoo Finance daily bars (stored)")  # fmt: skip
    parts = []
    for key, sign in (("SPX", 1), ("USDINR", -1)):
        g = next((x for x in items if x.key == key), None)
        if g and g.fresh and g.ret_pct is not None and g.sd_pct:
            parts.append(clip(sign * g.ret_pct / g.sd_pct))
            c.inputs.append({"name": g.name, "value": g.ret_pct, "unit": "%", "session": g.session})
            c.as_of = g.session
    if not parts:
        c.reason = "no fresh S&P 500 or USD/INR bar"
        return c
    c.available, c.score = True, sum(parts) / len(parts)
    return c


def institutional_component(f: FlowInput | None) -> Component:
    c = Component("institutional", "Institutional cash flows", SCORE_CONFIG["weights"]["institutional"], False,
                  formula="tanh(FII/FPI net cash / 3000 crore), previous session's official provisional figure",
                  source="NSE FII/DII provisional cash data (stored)")  # fmt: skip
    if f is None or f.fii_net is None:
        c.reason = "no stored FII/DII cash figure"
        return c
    if not f.fresh:
        c.reason = f"latest stored figure is for {f.session}, not the previous session"
        c.inputs.append(
            {"name": "FII/FPI net", "value": f.fii_net, "unit": "Rs cr", "session": f.session}
        )
        return c
    c.available, c.score, c.as_of = (
        True,
        math.tanh(f.fii_net / SCORE_CONFIG["fii_scale_cr"]),
        f.session,
    )
    c.inputs.append({"name": "FII/FPI net (previous session)", "value": f.fii_net, "unit": "Rs cr"})
    if f.dii_net is not None:
        c.inputs.append(
            {"name": "DII net (context, not scored)", "value": f.dii_net, "unit": "Rs cr"}
        )
    return c


def _no_stocks_reason(mk: dict[str, Any] | None) -> str:
    """Why stock-based evidence is missing, from the market service's own source report."""
    if mk is None:
        return "stock breadth is turned off or not running"
    s = mk.get("sources", {})
    lists, tokens, live = s.get("lists", {}), s.get("tokens", {}), s.get("live", {})
    if not lists.get("nifty50") or not lists.get("nifty500"):
        return "the NIFTY 50 / NIFTY 500 constituent lists have not been downloaded yet"
    if not tokens.get("found"):
        return "no Kotak instrument tokens for the stocks yet (scrip master not loaded)"
    if not live.get("stocks_with_ticks"):
        return "no live stock prices (market closed, or the stocks are not subscribed yet)"
    return "too few stocks have a fresh price"


def breadth_component(mk: dict[str, Any] | None) -> Component:
    c = Component("breadth", "Market breadth", SCORE_CONFIG["weights"]["breadth"], False,
                  formula="mean of (advancing - declining) / (advancing + declining) for NIFTY 50 and NIFTY 500, live price vs previous close; each needs >= 70% of its stocks priced",
                  source="Kotak live stock prices", as_of=None if mk is None else mk.get("generated_at"))  # fmt: skip
    parts: list[float] = []
    for key, label in (("nifty50", "NIFTY 50"), ("nifty500", "NIFTY 500")):
        b = (mk or {}).get(key, {}).get("breadth")
        if not b or not b.get("total") or b.get("coverage", 0) < 0.7 or b.get("ad_balance") is None:
            continue
        parts.append(clip(b["ad_balance"]))
        c.inputs.append({"name": f"{label}: advancing / declining", "value": b["ad_balance"], "unit": f"{b['advancing']} / {b['declining']} of {b['covered']}"})
    if not parts:
        c.reason = _no_stocks_reason(mk)
        return c
    c.available, c.score = True, sum(parts) / len(parts)
    return c


def sectors_component(mk: dict[str, Any] | None) -> Component:
    c = Component("sectors", "Sector participation", SCORE_CONFIG["weights"]["sectors"], False,
                  formula="(sectors up - sectors down) / sectors with a return, equal-weighted NIFTY 500 sector returns; needs >= 6 sectors with >= 3 priced stocks",
                  source="Kotak live stock prices, NSE industry classification", as_of=None if mk is None else mk.get("generated_at"))  # fmt: skip
    rows = [r for r in (mk or {}).get("sectors", {}).get("nifty500", []) if r.get("equal_weight_return") is not None]
    if len(rows) < 6:
        c.reason = _no_stocks_reason(mk) if not rows else f"only {len(rows)} sectors have a return so far (need 6)"
        return c
    up = sum(1 for r in rows if r["equal_weight_return"] > FLAT_BAND)
    dn = sum(1 for r in rows if r["equal_weight_return"] < -FLAT_BAND)
    c.inputs += [{"name": "Sectors up / down / flat", "value": None, "unit": f"{up} / {dn} / {len(rows) - up - dn} of {len(rows)}"}]
    if up + dn == 0:
        c.available, c.score = True, 0.0
        return c
    c.available, c.score = True, (up - dn) / (up + dn)
    return c


FLAT_BAND = 0.05  # percent: a sector within this of 0 is flat


def unavailable(key: str, name: str, reason: str) -> Component:
    return Component(key, name, SCORE_CONFIG["weights"][key], False, reason=reason)


def label_for(score: float) -> str:
    for th, name in SCORE_CONFIG["labels"]:
        if score >= th:
            return str(name)
    return "Bearish"


def vol_regime(p: PriceFeatures) -> tuple[str, str]:
    r = p.rv_ratio if p.rv_ratio is not None else p.range_ratio
    if r is None:
        return "Unknown", "not enough samples or no daily history to compare against"
    basis = (
        "realized volatility so far vs the typical daily sd scaled to elapsed time"
        if p.rv_ratio is not None
        else "sampled range vs 14-day average range"
    )
    if r >= SCORE_CONFIG["vol_high"]:
        return "High", f"{r:.2f}x normal ({basis})"
    if r <= SCORE_CONFIG["vol_low"]:
        return "Low", f"{r:.2f}x normal ({basis})"
    return "Normal", f"{r:.2f}x normal ({basis})"


@dataclass
class Assessment:
    score: float | None
    label: str
    direction: str
    coverage: float
    volatility: str
    volatility_detail: str
    components: list[Component]

    def public(self) -> dict[str, Any]:
        return {**{k: v for k, v in self.__dict__.items() if k != "components"},
                "components": [c.public() for c in self.components], "version": SCORE_VERSION,
                "provisional": True}  # fmt: skip


def assess(components: list[Component], p: PriceFeatures) -> Assessment:
    total = sum(c.weight for c in components)
    avail = [c for c in components if c.available and c.score is not None]
    cov = sum(c.weight for c in avail) / total if total else 0.0
    vol, vdetail = vol_regime(p)
    price_ok = any(c.key == "price" for c in avail)
    if not price_ok or cov < SCORE_CONFIG["min_coverage"]:
        return Assessment(None, "Insufficient data", "Unknown", cov, vol, vdetail, components)
    score = sum(c.weight * (c.score or 0.0) for c in avail) / sum(c.weight for c in avail)
    label = label_for(score)
    direction = "Up" if score >= 0.2 else "Down" if score <= -0.2 else "Flat"
    if vol == "High" and abs(score) < 0.2:
        label = "High volatility / unstable"
    return Assessment(score, label, direction, cov, vol, vdetail, components)


# ----------------------------------------------------------------------------------- regime


def regime(p: PriceFeatures, ctx: DailyContext, event_today: bool) -> dict[str, Any]:
    """Observed state of the session so far (a description, not a forecast).

    Trend = the move is large for its length AND directional. "Large" is a z-score against what a
    random walk with the 60-session daily volatility would typically do over the same time; the
    larger of the 60-minute move and the whole-session move counts. "Directional" = the 5-minute path
    is not just back-and-forth (efficiency ratio >= 0.20). One-minute efficiency is not used for the
    decision: it is low even in a clean trend because minute samples zigzag.
    """
    tags: list[str] = []
    if p.samples < 15 or ctx.daily_sd_pct is None:
        return {"primary": "Unclassified", "tags": tags,
                "reason": f"{p.samples} in-session samples (need 15) and daily history for scale"}  # fmt: skip
    sd = ctx.daily_sd_pct
    r60 = p.returns_pct.get(60)
    exp60 = sd * math.sqrt(60 / SESSION_MINUTES)
    z60 = None if r60 is None else r60 / exp60
    zs = None
    if p.net_pct is not None and p.net_minutes and p.net_minutes >= 30:
        zs = p.net_pct / (sd * math.sqrt(p.net_minutes / SESSION_MINUTES))
    zs_list = [z for z in (z60, zs) if z is not None]
    z = max(zs_list, key=abs) if zs_list else None
    er5 = p.er_5m
    primary = "Sideways consolidation"
    if z is not None and abs(z) >= 1.5 and er5 is not None and er5 >= 0.20:
        primary = "Uptrend" if z > 0 else "Downtrend"
    elif er5 is not None and er5 < 0.20 and (z is None or abs(z) < 1.0):
        primary = "Mean-reverting / choppy"
    if p.or_high is not None and p.last is not None and p.last > p.or_high:
        tags.append("Above opening range (breakout attempt)")
    if p.or_low is not None and p.last is not None and p.last < p.or_low:
        tags.append("Below opening range (breakdown attempt)")
    if p.gap_pct is not None and abs(p.gap_pct) >= 0.5 * sd:
        tags.append(f"Gap {'up' if p.gap_pct > 0 else 'down'} {p.gap_pct:+.2f}% at the open")
    vol, _ = vol_regime(p)
    if vol == "High":
        tags.append("Volatility expansion")
    elif vol == "Low":
        tags.append("Volatility contraction")
    r15 = p.returns_pct.get(15)
    if primary in ("Uptrend", "Downtrend") and r15 is not None and r60 is not None and r15 * r60 < 0 and abs(r15) > 0.4 * abs(r60):
        tags.append("Trend exhaustion risk (last 15 min against the hour)")
    if event_today:
        tags.append("Event risk later today")
    bits = []
    if z60 is not None:
        bits.append(f"60-min move {r60:+.2f}% = {z60:+.1f}x its typical size ({exp60:.2f}%)")
    if zs is not None:
        bits.append(f"session move {p.net_pct:+.2f}% over {p.net_minutes:.0f} min = {zs:+.1f}x typical")
    bits.append("5-min path efficiency " + ("n/a" if er5 is None else f"{er5:.2f}"))
    return {"primary": primary, "tags": tags, "reason": "; ".join(bits)}


# --------------------------------------------------------------------------------- scenarios


def _fmt(v: float | None) -> str:
    return "n/a" if v is None else f"{v:,.2f}"


CHOPPY = ("Sideways consolidation", "Mean-reverting / choppy")


def scenarios(
    a: Assessment, p: PriceFeatures, o: OptionsFeatures, ctx: DailyContext, reg: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Qualitative scenarios that are relevant now, plus the ones ruled out and why.

    Relevance rules: bullish needs at least one available evidence group above +0.10, bearish at least
    one below -0.10; range-bound is shown unless the observed regime is an up/downtrend
    with a strong score (|score| >= 0.5), and always when nothing else is relevant. Order: the observed
    regime first (range-bound when choppy), then by agreement with the score. No probabilities: there is
    no validated intraday model, and numbers would be invented.
    """
    if a.score is None or p.last is None:
        return [], []
    primary = (reg or {}).get("primary")
    bull = [c for c in a.components if c.available and (c.score or 0) > 0.1]
    bear = [c for c in a.components if c.available and (c.score or 0) < -0.1]
    up = max(x for x in (p.or_high, p.sampled_high) if x is not None)
    dn = min(x for x in (p.or_low, p.sampled_low) if x is not None)
    common = {"horizon": "rest of today's session", "probability": None,
              "status": "rules-based, no probability (no validated intraday model)"}  # fmt: skip
    out: list[dict[str, Any]] = [
        {"name": "Bullish continuation / recovery", **common,
         "supporting": [f"{c.name}: {c.score:+.2f}" for c in bull],
         "conflicting": [f"{c.name}: {c.score:+.2f}" for c in bear],
         "levels": {"trigger above": up, "call OI concentration": o.max_ce_oi_strike, "previous day high": ctx.prev_high},
         "strengthens": f"Sustained trade above {_fmt(up)} with the score staying above +0.2",
         "weakens": f"Falls back below {_fmt(p.prev_close)} (previous close) or below {_fmt(dn)}"},
        {"name": "Range-bound consolidation", **common,
         "supporting": [f"Observed regime: {primary}"] if primary in CHOPPY else [],
         "conflicting": [f"Observed regime: {primary}"] if primary in ("Uptrend", "Downtrend") else [],
         "levels": {"range high": up, "range low": dn},
         "strengthens": f"Price keeps rotating between {_fmt(dn)} and {_fmt(up)}",
         "weakens": f"A sustained move outside {_fmt(dn)}-{_fmt(up)}"},
        {"name": "Bearish continuation / reversal", **common,
         "supporting": [f"{c.name}: {c.score:+.2f}" for c in bear],
         "conflicting": [f"{c.name}: {c.score:+.2f}" for c in bull],
         "levels": {"trigger below": dn, "put OI concentration": o.max_pe_oi_strike, "previous day low": ctx.prev_low},
         "strengthens": f"Sustained trade below {_fmt(dn)} with the score staying below -0.2",
         "weakens": f"Recovers above {_fmt(p.prev_close)} (previous close) or above {_fmt(up)}"},
    ]  # fmt: skip
    n_av = sum(1 for c in a.components if c.available)
    trending = (reg or {}).get("primary") in ("Uptrend", "Downtrend") and abs(a.score) >= 0.5
    why: dict[int, str] = {}
    if not bull:
        why[0] = f"none of the {n_av} available evidence groups is above +0.10"
    if not bear:
        why[2] = f"none of the {n_av} available evidence groups is below -0.10" + (f" ({len(bull)} are bullish)" if bull else "")
    if trending and not (why.get(0) and why.get(2)):
        why[1] = f"a clear {(reg or {}).get('primary', 'trend').lower()} with score {a.score:+.2f}"
    if len(why) == 3:  # nothing directional is supported: range-bound is the honest default
        del why[1]
    if primary in CHOPPY:
        key = [1, 0, 2] if len(bull) >= len(bear) else [1, 2, 0]
    else:
        key = {"Up": [0, 1, 2], "Down": [2, 1, 0]}.get(a.direction, [1, 0, 2])
    shown = [out[i] for i in key if i not in why]
    ruled = [{"name": out[i]["name"], "reason": why[i]} for i in key if i in why]
    return shown, ruled


def narrative(a: Assessment, p: PriceFeatures, o: OptionsFeatures, reg: dict[str, Any]) -> str:
    """One paragraph built only from values that exist."""
    if a.score is None:
        return "Not enough current data for an assessment."
    bits = [
        f"Current assessment: {a.label} (score {a.score:+.2f}, coverage {a.coverage:.0%}, provisional rules)."
    ]
    if p.change_pct is not None and p.last is not None:
        bits.append(f"NIFTY {p.last:,.2f} is {p.change_pct:+.2f}% from the previous close.")
    r30 = p.returns_pct.get(30)
    if r30 is not None:
        bits.append(f"Last 30 minutes {r30:+.2f}%.")
    if o.pcr_oi is not None:
        s = f"PCR (OI, ATM +/-10) {o.pcr_oi:.2f}"
        if o.pcr_oi_change is not None:
            s += f", {o.pcr_oi_change:+.2f} since the first sample"
        bits.append(s + ".")
    bits.append(f"Observed regime: {reg['primary']}; volatility {a.volatility.lower()}.")
    missing = [c.name.lower() for c in a.components if not c.available]
    if missing:
        bits.append("Not included: " + ", ".join(missing) + ".")
    return " ".join(bits)
