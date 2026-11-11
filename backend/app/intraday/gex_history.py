"""Gamma exposure of one stored chain snapshot, rebuilt from the stored prices and open interest (registry ids ``gex_core``,
``gex_universes``): the same definitions as the browser's ``gammaAnalysis.ts`` / ``gexIntel.ts`` so a historical value equals what the page
would have shown at that moment.

    GEX_strike = gamma x OI x spot^2 x 0.01 / 10^7     (rupees crore of underlying per 1 % move; OI already in units)
    call GEX = +GEX of the call, put GEX = -GEX of the put (a model sign convention, not observed dealer inventory)
    net = call + put, absolute = call + |put|; a strike counts toward net/absolute only when both sides have an exposure
    gamma (per unit of spot) = e^(-r t) phi(d1) q / (s sigma sqrt(t)),  q = forward / spot,  held fixed when spot is re-priced
    gamma flip = the spot level within +-8 % where the aggregate net GEX (each side counted when it has an exposure) changes sign,
                 every contract re-priced there with its own implied volatility; the crossing nearest spot, None when there is none

Only information stored for the snapshot is used. A contract with no solved volatility or no open interest gives no exposure and is
counted as missing, never as zero.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any

CRORE = 1e7
FLIP_SPAN = 0.08
FLIP_STEPS = 32
EACH = 10
NEAR_EACH = 5


def _pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def spot_gamma(spot: float, q: float, k: float, t: float, iv: float, r: float) -> float | None:
    """Gamma per unit of spot for a contract whose forward is ``q x spot``, at volatility ``iv`` (a fraction)."""
    if spot <= 0 or k <= 0 or t <= 0 or iv <= 0 or q <= 0:
        return None
    v = iv * math.sqrt(t)
    d1 = (math.log(spot * q / k) + 0.5 * v * v) / v
    return math.exp(-r * t) * _pdf(d1) * q / (spot * v)


def exposure(gamma: float | None, oi: float | None, spot: float) -> float | None:
    return None if gamma is None or oi is None else gamma * oi * spot * spot * 0.01 / CRORE


def contracts_of(rows: Sequence[Mapping[str, Any]], chain: Mapping[tuple[float, int], Any]) -> list[dict[str, Any]]:
    """Every listed contract with its solved volatility (fraction) and open interest; None where either is missing."""
    out = []
    for r in rows:
        c = chain.get((r["strike"], 0 if r["side"] == "CE" else 1))
        out.append({
            "strike": r["strike"], "side": r["side"], "iv": None if r.get("iv") is None else r["iv"] / 100,
            "oi": None if c is None or c.oi is None else float(c.oi),
        })
    return out


_SQRT2PI = math.sqrt(2 * math.pi)


def _prepare(cs: Sequence[Mapping[str, Any]], q: float, t: float, r: float) -> list[tuple[float, float, float, float]]:
    """Per-contract constants of the flip search, so that re-pricing at many trial spots costs one exponential per contract:
    contribution(s) = sign x OI x 0.01 / 10^7 x e^(-r t) x q x s x phi(d1) / v, with d1 = (ln(s q / k) + v^2 / 2) / v and v = iv sqrt(t)."""
    out = []
    df = math.exp(-r * t)
    for c in cs:
        if c["iv"] is None or c["oi"] is None or c["iv"] <= 0 or c["strike"] <= 0 or t <= 0:
            continue
        v = c["iv"] * math.sqrt(t)
        sign = 1.0 if c["side"] == "CE" else -1.0
        out.append((sign * c["oi"] * 0.01 / CRORE * df * q / (_SQRT2PI * v), math.log(c["strike"]), v, 0.5 * v * v))
    return out


def _net_prepared(prep: Sequence[tuple[float, float, float, float]], s: float, q: float) -> float | None:
    if not prep or s <= 0:
        return None
    ls = math.log(s * q)
    total = 0.0
    for coef, lnk, v, hv2 in prep:
        d1 = (ls - lnk + hv2) / v
        total += coef * s * math.exp(-0.5 * d1 * d1)
    return total


def net_at(cs: Sequence[Mapping[str, Any]], s: float, q: float, t: float, r: float) -> float | None:
    """Aggregate net GEX with every contract's gamma re-priced at spot ``s`` (its own IV, forward ratio ``q`` held)."""
    return _net_prepared(_prepare(cs, q, t, r), s, q)


def gamma_flip(cs: Sequence[Mapping[str, Any]], spot: float, q: float, t: float, r: float, span: float = FLIP_SPAN, steps: int = FLIP_STEPS) -> float | None:
    prep = _prepare(cs, q, t, r)
    pts: list[tuple[float, float]] = []
    for i in range(steps + 1):
        s = spot * (1 - span + 2 * span * i / steps)
        v = _net_prepared(prep, s, q)
        if v is not None:
            pts.append((s, v))
    best: float | None = None
    for (s0, v0), (s1, v1) in zip(pts, pts[1:], strict=False):
        if v0 == 0 or (v0 < 0) != (v1 < 0):
            lo, hi, vlo = s0, s1, v0
            for _ in range(22):  # the profile is curved: refine the bracket instead of interpolating a straight line
                mid = (lo + hi) / 2
                vm = _net_prepared(prep, mid, q)
                if vm is None:
                    break
                if (vm < 0) == (vlo < 0):
                    lo, vlo = mid, vm
                else:
                    hi = mid
            x = (lo + hi) / 2
            if best is None or abs(x - spot) < abs(best - spot):
                best = x
    return best


def crossings(cs: Sequence[Mapping[str, Any]], spot: float, q: float, t: float, r: float, span: float = FLIP_SPAN, steps: int = FLIP_STEPS) -> list[float]:
    """Every spot level inside +-span where the aggregate changes sign (bisected), nearest to spot first. ``gamma_flip`` returns the first of these."""
    prep = _prepare(cs, q, t, r)
    pts = [(s, _net_prepared(prep, s, q)) for s in (spot * (1 - span + 2 * span * i / steps) for i in range(steps + 1))]
    out: list[float] = []
    for (s0, v0), (s1, v1) in zip(pts, pts[1:], strict=False):
        if v0 is None or v1 is None or not (v0 == 0 or (v0 < 0) != (v1 < 0)):
            continue
        lo, hi, vlo = s0, s1, v0
        for _ in range(22):
            mid = (lo + hi) / 2
            vm = _net_prepared(prep, mid, q)
            if vm is None:
                break
            if (vm < 0) == (vlo < 0):
                lo, vlo = mid, vm
            else:
                hi = mid
        out.append((lo + hi) / 2)
    return sorted(out, key=lambda x: abs(x - spot))


def both_sided(cs: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Contracts of the strikes that have a usable call AND put exposure: the set the net and absolute totals are built from."""
    ok = {(c["strike"], c["side"]) for c in cs if c["iv"] is not None and c["oi"] is not None}
    return [c for c in cs if (c["strike"], "CE") in ok and (c["strike"], "PE") in ok]


def flip_diagnostics(cs: Sequence[Mapping[str, Any]], spot: float, q: float, t: float, r: float, flip: float | None) -> dict[str, float | None]:
    """How far the gamma flip can be trusted. Numbers only (the label is made in ``flip_support``).

    * ``flip_both``: the flip when only strikes with both a call and a put exposure are used (the same strikes as the net total).
    * ``flip_lo`` / ``flip_hi``: the flip when call OI is scaled by 0.9 and put OI by 1.1, and the reverse (a 10 % disagreement in who holds what).
    * ``crossings``: how many sign changes the profile has inside +-8 % of spot.
    * ``slope``: net GEX change per 1 % of spot at the flip (a flat profile makes the zero poorly located).
    * ``net_share``: |net at spot| / absolute exposure: near 0 the book is balanced and the flip is close, near 1 it is one-sided and the flip is far.
    """
    cb = both_sided(cs)
    f_both = gamma_flip(cb, spot, q, t, r) if cb else None

    def scaled(a: float, b: float) -> list[dict[str, Any]]:
        return [{**c, "oi": None if c["oi"] is None else c["oi"] * (a if c["side"] == "CE" else b)} for c in cs]

    f_lo, f_hi = gamma_flip(scaled(0.9, 1.1), spot, q, t, r), gamma_flip(scaled(1.1, 0.9), spot, q, t, r)
    n = len(crossings(cs, spot, q, t, r))
    slope = None
    if flip is not None:
        a, b = net_at(cs, flip * 0.995, q, t, r), net_at(cs, flip * 1.005, q, t, r)
        slope = None if a is None or b is None else (b - a)
    net0, tot = net_at(cb, spot, q, t, r) if cb else None, sum(abs(x) for x in [net_at([c], spot, q, t, r) or 0.0 for c in cb]) if cb else 0.0
    return {"flip_both": f_both, "flip_lo": f_lo, "flip_hi": f_hi, "crossings": float(n), "slope": slope, "net_share": None if net0 is None or not tot else abs(net0) / tot}


def flip_support(spot: float, flip: float | None, d: dict[str, Any]) -> dict[str, Any]:
    """A plain verdict on the flip from its diagnostics: 'none', 'supported' or 'unstable', with the reasons. Nothing is corrected: a flip that is not
    supported is labelled, never replaced by a better-looking number."""
    if flip is not None and not any(v is not None for v in d.values()):
        return {"status": "unassessed", "reasons": ["no stability diagnostics were stored with this snapshot"], "spread_pts": None}
    if flip is None:
        return {"status": "none", "reasons": ["no sign change of the modelled net GEX within +-8 % of spot"]}
    reasons: list[str] = []
    pts_alt = [v for v in (d.get("flip_both"), d.get("flip_lo"), d.get("flip_hi")) if v is not None]
    spread = (max([flip, *pts_alt]) - min([flip, *pts_alt])) if pts_alt else 0.0
    if spread / spot * 100 > 0.25:
        reasons.append(f"moves {spread:.0f} points ({spread / spot * 100:.2f} % of spot) with the strike set or a 10 % OI disagreement")
    if (d.get("crossings") or 0) > 1:
        reasons.append(f"the profile changes sign {int(d['crossings'] or 0)} times inside +-8 % of spot")
    dist = abs(flip - spot) / spot * 100
    if dist > 1.0:
        reasons.append(f"{dist:.2f} % from spot: the net exposure is one-sided near spot, so the flip is an extrapolation")
    if "slope" in d and not d.get("slope"):
        reasons.append("the profile is too flat at the flip to locate it")
    return {"status": "unstable" if reasons else "supported", "reasons": reasons, "spread_pts": round(spread, 1)}


def strike_rows(cs: Sequence[Mapping[str, Any]], spot: float, q: float, t: float, r: float) -> list[dict[str, Any]]:
    by: dict[float, dict[str, Any]] = {}
    for c in cs:
        row = by.setdefault(c["strike"], {"strike": c["strike"], "ce": None, "pe": None})
        e = None if c["iv"] is None else exposure(spot_gamma(spot, q, c["strike"], t, c["iv"], r), c["oi"], spot)
        if e is not None:
            row["ce" if c["side"] == "CE" else "pe"] = e if c["side"] == "CE" else -e
    rows = sorted(by.values(), key=lambda x: x["strike"])
    for x in rows:
        both = x["ce"] is not None and x["pe"] is not None
        x["net"] = x["ce"] + x["pe"] if both else None
        x["abs"] = x["ce"] - x["pe"] if both else None
    return rows


def _argmax(rows: Sequence[Mapping[str, Any]], f: Any) -> float | None:
    best, bv = None, -math.inf
    for r in rows:
        v = f(r)
        if v is not None and v > bv:
            best, bv = r["strike"], v
    return best


def levels(cs: Sequence[Mapping[str, Any]], spot: float, q: float, t: float, r: float) -> dict[str, Any]:
    """Totals, walls, peak, near-ATM and flip of one set of contracts."""
    rows = strike_rows(cs, spot, q, t, r)
    used = [x for x in rows if x["net"] is not None]
    atm = min(rows, key=lambda x: (abs(x["strike"] - spot), x["strike"]), default=None)
    i = rows.index(atm) if atm is not None else -1
    near = [x for x in rows[max(0, i - NEAR_EACH): i + NEAR_EACH + 1] if x["net"] is not None] if i >= 0 else []
    ces = [x["ce"] for x in rows if x["ce"] is not None]
    pes = [x["pe"] for x in rows if x["pe"] is not None]
    return {
        "strikes": len(rows), "used": len(used), "excluded": len(rows) - len(used),
        "ce": sum(ces) if ces else None, "pe": sum(pes) if pes else None,
        "net": sum(x["net"] for x in used) if used else None, "abs": sum(x["abs"] for x in used) if used else None,
        "near_net": sum(x["net"] for x in near) if near else None,
        "peak": _argmax(rows, lambda x: x["abs"]),
        "call_wall": _argmax([x for x in rows if x["strike"] >= spot], lambda x: x["ce"]),
        "put_wall": _argmax([x for x in rows if x["strike"] <= spot], lambda x: None if x["pe"] is None else -x["pe"]),
        "flip": (flip := gamma_flip(cs, spot, q, t, r)),
        **{f"fd_{k}": v for k, v in flip_diagnostics(cs, spot, q, t, r, flip).items()},
    }


def _around(strikes: Sequence[float], centre: float, each: int) -> set[float]:
    ks = sorted(set(strikes))
    if not ks:
        return set()
    i = min(range(len(ks)), key=lambda j: (abs(ks[j] - centre), ks[j]))
    return set(ks[max(0, i - each): i + each + 1])


def reconstruct(
    rows: Sequence[Mapping[str, Any]], chain: Mapping[tuple[float, int], Any], spot: float, forward: float, t: float, r: float,
    opening_atm: float | None, each: int = EACH,
) -> dict[str, Any]:
    """The three universes (fixed opening ATM +- each, dynamic current ATM +- each, full chain) of one snapshot, plus a missing-data count.
    ``rows`` are the solved rows of a surface covering every listed strike."""
    cs = contracts_of(rows, chain)
    q = forward / spot
    strikes = [c["strike"] for c in cs]
    fixed = _around(strikes, opening_atm, each) if opening_atm is not None else None
    dyn = _around(strikes, spot, each)
    sets: dict[str, list[dict[str, Any]] | None] = {
        "fixed": None if fixed is None else [c for c in cs if c["strike"] in fixed],
        "dynamic": [c for c in cs if c["strike"] in dyn],
        "full": cs,
    }
    return {
        "universes": {k: None if v is None else levels(v, spot, q, t, r) for k, v in sets.items()},
        "missing": {"contracts": len(cs), "no_iv": sum(1 for c in cs if c["iv"] is None), "no_oi": sum(1 for c in cs if c["oi"] is None)},
        "opening_atm": opening_atm,
    }
