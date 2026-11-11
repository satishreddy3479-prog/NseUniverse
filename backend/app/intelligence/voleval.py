# ruff: noqa: E501
"""Volatility evidence: the readings behind the volatility group, each component's contribution, and a plain interpretation (pure functions).

Sign convention (one, used everywhere in this module and checked by ``analyse``):

    risk reversal (RR) = CE IV - PE IV at the same delta              (positive: calls richer than puts)
    skew               = PE IV - CE IV = -RR                           (positive: puts richer than calls)
    change in RR       = (CE IV change) - (PE IV change) = the "call-versus-put IV momentum"
    score              +: bullish evidence, -: bearish evidence, from the sign of the RR change (calls strengthening relative to puts is bullish)

The two scored terms are unchanged from the original methodology and are configurable (``VolConfig``):

    ATM IV term    legacy : 0 when IV rises while spot rises by more than ``spot_flat`` %, else  -tanh(ATM IV change / atm_scale) x atm_factor x 100
                   context: scored only when IV and price agree about fear: price up and IV down +, price down and IV up -, otherwise 0
    RR term        tanh(RR change / skew_scale) x 100

ATM IV falling is not treated as bullish by itself in ``context`` mode, and neither mode treats IV rising as bearish by itself in the interpretation: the
interpretation reports expansion/contraction as a regime fact and judges direction only from the call-versus-put movement and the price.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, fields
from typing import Any

MODES = ("legacy", "context")


@dataclass(frozen=True)
class VolConfig:
    mode: str = "legacy"       # "legacy" reproduces the original ATM rule; "context" scores ATM IV only when it agrees with the price move
    atm_scale: float = 0.5     # ATM IV change (points) that counts as a strong reading
    atm_factor: float = 0.6    # share of the full scale the ATM term may reach
    skew_scale: float = 0.4    # RR change (points) that counts as a strong reading
    flat_pts: float = 0.1      # a leg that moved less than this (points) is "little changed"
    move_pts: float = 0.3      # ATM IV change at or beyond this is expansion / contraction
    rr_move: float = 0.2       # RR change at or beyond this is a movement
    spot_flat: float = 0.1     # a spot move smaller than this (%) has no direction


DEFAULT = VolConfig()


def parse_config(raw: str | None) -> VolConfig:
    """JSON object over the defaults (``{"mode": "context", "atm_scale": 0.6}``); unknown keys, wrong types and an unknown mode keep the default. Never raises."""
    import json

    base = DEFAULT
    try:
        d = json.loads(raw) if raw else {}
        kw: dict[str, Any] = {}
        for f in fields(VolConfig):
            if f.name in d:
                v = d[f.name]
                if f.name == "mode":
                    if v in MODES:
                        kw["mode"] = v
                elif isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
                    kw[f.name] = float(v)
        return VolConfig(**{**base.__dict__, **kw})
    except (ValueError, AttributeError, TypeError):
        return base


def _num(x: Any) -> float | None:
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) else None


def _f(v: float | None, spec: str = "+.2f") -> str:
    return "n/a" if v is None else format(v, spec)


def _clip(x: float) -> float:
    return max(-100.0, min(100.0, x))


def atm_score(iv_chg: float | None, spot_pct: float | None, c: VolConfig) -> tuple[float | None, str]:
    """(score, rule applied) of the ATM IV term."""
    if iv_chg is None:
        return None, "no snapshot 15 minutes earlier"
    raw = -100.0 * math.tanh(iv_chg / c.atm_scale) * c.atm_factor
    if c.mode == "legacy":
        if spot_pct is not None and spot_pct > c.spot_flat and iv_chg > 0:
            return 0.0, "legacy rule: IV up while spot rises is not read as directional"
        return _clip(raw), "legacy rule: IV down leans bullish, IV up leans bearish (a convention, not a law)"
    if spot_pct is None or abs(spot_pct) < c.spot_flat:
        return 0.0, "context rule: no price direction, so the ATM IV move is not scored"
    if spot_pct > 0 and iv_chg < 0:
        return _clip(raw), "context rule: price up with IV falling (orderly advance) scores bullish"
    if spot_pct < 0 and iv_chg > 0:
        return _clip(raw), "context rule: price down with IV rising (fear) scores bearish"
    return 0.0, "context rule: IV and price do not agree about fear (price up with IV up, or price down with IV down), so not scored"


def rr_score(rr_change: float | None, c: VolConfig) -> float | None:
    return None if rr_change is None else _clip(100.0 * math.tanh(rr_change / c.skew_scale))


def movement(chg: float | None, c: VolConfig) -> str | None:
    return None if chg is None else "expansion" if chg >= c.move_pts else "contraction" if chg <= -c.move_pts else "little changed"


def mechanism(ce: float | None, pe: float | None, c: VolConfig) -> str | None:
    """Which leg moved: separates a put IV expansion from a call IV contraction even though both lower the risk reversal."""
    if ce is None or pe is None:
        return None
    f = c.flat_pts
    cu, cd, pu, pd = ce >= f, ce <= -f, pe >= f, pe <= -f
    if not (cu or cd or pu or pd):
        return "neither call IV nor put IV moved materially"
    if pu and cd:
        return f"put IV expansion ({pe:+.2f}) together with call IV contraction ({ce:+.2f})"
    if pd and cu:
        return f"call IV expansion ({ce:+.2f}) together with put IV contraction ({pe:+.2f})"
    if pu and cu:
        return f"both rose, put IV expanded more ({pe:+.2f} against {ce:+.2f})" if pe > ce else f"both rose, call IV expanded more ({ce:+.2f} against {pe:+.2f})"
    if pd and cd:
        return f"both fell, put IV contracted more ({pe:+.2f} against {ce:+.2f})" if pe < ce else f"both fell, call IV contracted more ({ce:+.2f} against {pe:+.2f})"
    if pu:
        return f"put IV expansion ({pe:+.2f}) with call IV little changed ({ce:+.2f})"
    if pd:
        return f"put IV contraction ({pe:+.2f}) with call IV little changed ({ce:+.2f})"
    if cu:
        return f"call IV expansion ({ce:+.2f}) with put IV little changed ({pe:+.2f})"
    return f"call IV contraction ({ce:+.2f}) with put IV little changed ({pe:+.2f})"


def _bucket(row: Mapping[str, Any], prev: Mapping[str, Any] | None, name: str, c: VolConfig) -> dict[str, Any]:
    b = row.get(name) or {}
    pb = (prev or {}).get(name) or {}
    ce_n, pe_n, ce_c, pe_c = _num(b.get("ce_now")), _num(b.get("pe_now")), _num(b.get("ce_change")), _num(b.get("pe_change"))
    rr = None if ce_n is None or pe_n is None else round(ce_n - pe_n, 3)
    ce_p, pe_p = _num(pb.get("ce_now")), _num(pb.get("pe_now"))  # the previous session's close, as the momentum table stored it, is in "then"
    ce_prev, pe_prev = _num(pb.get("ce_then")), _num(pb.get("pe_then"))
    rr_prev = None if ce_prev is None or pe_prev is None else round(ce_prev - pe_prev, 3)
    mom = _num(b.get("momentum"))
    # one sign convention: the RR change over the window must equal (CE change - PE change); a table that disagrees is flagged, never silently used
    check = None if ce_c is None or pe_c is None or mom is None else abs((ce_c - pe_c) - mom) < 0.01
    del ce_p, pe_p
    return {
        "ce_iv": ce_n, "pe_iv": pe_n, "ce_change": ce_c, "pe_change": pe_c, "risk_reversal": rr, "skew": None if rr is None else -rr,
        "rr_change": round(ce_c - pe_c, 3) if ce_c is not None and pe_c is not None else mom, "rr_previous_session": rr_prev,
        "rr_change_since_previous_session": None if rr is None or rr_prev is None else round(rr - rr_prev, 3),
        "skew_previous_session": None if rr_prev is None else -rr_prev, "mechanism": mechanism(ce_c, pe_c, c), "sign_consistent": check,
    }


def analyse(row: Mapping[str, Any], prev: Mapping[str, Any] | None, c: VolConfig = DEFAULT, window_label: str = "15 min") -> dict[str, Any]:
    """Everything the volatility panel shows, from one momentum-table row (``table.periods["15"]``) and the previous-session comparison
    (``table.previous_close``)."""
    atm, d25, d10 = _bucket(row, prev, "atm", c), _bucket(row, prev, "d25", c), _bucket(row, prev, "d10", c)
    spot = _num(row.get("spot_change_pct"))
    chg = None if atm["ce_change"] is None or atm["pe_change"] is None else round((atm["ce_change"] + atm["pe_change"]) / 2, 3)
    a_score, a_rule = atm_score(chg, spot, c)
    r_chg = d25["rr_change"]
    r_score = rr_score(r_chg, c)
    comps: list[dict[str, Any]] = []
    avail = [x for x in (a_score, r_score) if x is not None]
    n = len(avail)
    for name, key, score, reading in (
        ("ATM IV change against price", "atm", a_score, None if chg is None else f"ATM IV {chg:+.2f} pts (CE {_f(atm['ce_change'])}, PE {_f(atm['pe_change'])}) while spot {'is unavailable' if spot is None else f'{spot:+.2f}%'}; {a_rule}"),
        ("Call versus put IV momentum (25Δ)", "rr", r_score, None if r_chg is None else f"25Δ CE IV {_f(d25['ce_change'])} less PE IV {_f(d25['pe_change'])} = risk-reversal change {r_chg:+.2f} pts ({d25['mechanism'] or 'one leg missing'})"),
    ):
        comps.append({"key": key, "name": name, "reading": reading, "score": None if score is None else round(score, 1), "contribution": None if score is None or not n else round(score / n, 1)})
    bull = [x["name"] for x in comps if x["score"] is not None and x["score"] >= 15]
    bear = [x["name"] for x in comps if x["score"] is not None and x["score"] <= -15]
    verdict = "CONFLICTING" if bull and bear else "BULLISH" if bull else "BEARISH" if bear else "NEUTRAL" if n else "UNAVAILABLE"
    total = None if not n else round(sum(avail) / n, 1)
    evidence: dict[str, list[str]] = {"bullish": [], "bearish": [], "conflicting": []}
    for x in comps:
        if x["score"] is None or abs(x["score"]) < 15:
            continue
        evidence["bullish" if x["score"] > 0 else "bearish"].append(f"{x['name']} {x['score']:+.0f}: {x['reading']}")
    if verdict == "CONFLICTING":
        evidence["conflicting"] = [f"the components disagree: {', '.join(bull)} against {', '.join(bear)}"]
    # information that is shown but not scored
    info = []
    if d25["rr_change_since_previous_session"] is not None and abs(d25["rr_change_since_previous_session"]) >= c.rr_move:
        v = d25["rr_change_since_previous_session"]
        info.append(f"25Δ risk reversal {_f(d25['risk_reversal'])} against {_f(d25['rr_previous_session'])} at the previous session's close ({v:+.2f}): calls {'strengthened' if v > 0 else 'weakened'} relative to puts since then (not scored)")
    if d10["rr_change"] is not None and abs(d10["rr_change"]) >= c.rr_move:
        info.append(f"10Δ risk-reversal change {d10['rr_change']:+.2f} pts ({d10['mechanism'] or 'one leg missing'}) (not scored)")
    # ---- interpretation
    mv = movement(chg, c)
    put_c, call_c = d25["pe_change"], d25["ce_change"]

    def side(v: float | None) -> str | None:
        return None if v is None else "strengthening" if v >= c.flat_pts else "weakening" if v <= -c.flat_pts else "little changed"

    interp: list[dict[str, str]] = []

    interp.append({"id": "atm", "title": "ATM volatility", "reading": "unavailable" if chg is None else f"{mv}: ATM IV {chg:+.2f} pts over {window_label}" + ("" if mv == "little changed" else "; a change in the level of risk, not a direction by itself")})
    interp.append({"id": "put_side", "title": "Put-side IV (25Δ)", "reading": "unavailable" if put_c is None else f"{side(put_c)}: {put_c:+.2f} pts, now {_f(d25['pe_iv'], '.2f')}"})
    interp.append({"id": "call_side", "title": "Call-side IV (25Δ)", "reading": "unavailable" if call_c is None else f"{side(call_c)}: {call_c:+.2f} pts, now {_f(d25['ce_iv'], '.2f')}"})
    rr_txt = "unavailable" if d25["risk_reversal"] is None else f"25Δ risk reversal {_f(d25['risk_reversal'])} (CE IV − PE IV)" + ("" if r_chg is None else f", {r_chg:+.2f} over {window_label}") + ("" if d25["rr_previous_session"] is None else f", {d25['rr_previous_session']:+.2f} at the previous close")
    interp.append({"id": "risk_reversal", "title": "Risk reversal movement", "reading": rr_txt})
    div = "no divergence between price and volatility"
    if spot is not None and r_chg is not None and spot >= c.spot_flat and r_chg <= -c.rr_move:
        div = f"price up {spot:+.2f}% while puts get richer relative to calls ({r_chg:+.2f}): hedging demand against the advance"
    elif spot is not None and r_chg is not None and spot <= -c.spot_flat and r_chg >= c.rr_move:
        div = f"price down {spot:+.2f}% while calls strengthen relative to puts ({r_chg:+.2f}): upside demand against the decline"
    elif spot is not None and chg is not None and abs(spot) < c.spot_flat and chg >= 0.5:
        div = f"ATM IV expanding ({chg:+.2f}) with price flat ({spot:+.2f}%): risk is being repriced before price moves"
    interp.append({"id": "vol_price", "title": "Volatility versus price", "reading": div})
    up, dn = spot is not None and spot >= c.spot_flat, spot is not None and spot <= -c.spot_flat
    if verdict in ("UNAVAILABLE", "NEUTRAL"):
        conf = "no volatility evidence of its own to confirm or contradict price"
    elif not (up or dn):
        conf = "price has no clear direction over the window, so there is nothing for volatility to confirm"
    elif verdict == "CONFLICTING":
        conf = "mixed: the volatility components disagree, so volatility does not confirm the price move"
    elif (verdict == "BULLISH") == up:
        conf = f"confirms the {'advance' if up else 'decline'}"
    else:
        conf = f"does not confirm: volatility evidence is {verdict.lower()} while price is {'rising' if up else 'falling'}"
    interp.append({"id": "confirmation", "title": "Overall volatility confirmation", "reading": conf})
    parts = [x for x in comps if x["score"] is not None]
    explanation = (
        f"Volatility evidence is {verdict}" + ("" if total is None else f" (group score {total:+.0f})") + ": "
        + "; ".join(f"{x['name']} {x['score']:+.0f} ({x['reading']})" for x in parts)
        + ("" if not parts else f". Each component contributes its score divided by {n}: " + ", ".join(f"{x['contribution']:+.1f}" for x in parts))
        + (". The components disagree, so the net score understates the conflict." if verdict == "CONFLICTING" else ".")
    ) if parts else "Volatility evidence is UNAVAILABLE: no two comparable snapshots."
    return {
        "window": window_label, "spot_change_pct": spot, "atm": {**atm, "avg_change": chg, "movement": mv}, "d25": d25, "d10": d10, "components": comps, "total": total, "verdict": verdict,
        "evidence": evidence, "not_scored": info, "interpretation": interp, "explanation": explanation, "scoring": {"mode": c.mode, "atm_scale": c.atm_scale, "atm_factor": c.atm_factor, "skew_scale": c.skew_scale},
        "sign_convention": "risk reversal = CE IV − PE IV; skew = PE IV − CE IV = −risk reversal; change in risk reversal = CE IV change − PE IV change (the call-versus-put IV momentum); positive = calls strengthening relative to puts = bullish evidence",
        "sign_consistent": all(x["sign_consistent"] is not False for x in (atm, d25, d10)),
    }
