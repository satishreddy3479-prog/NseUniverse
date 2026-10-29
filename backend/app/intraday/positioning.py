"""Window PCRs, premium/OI classification and OI concentration (pure functions on stored option chains).

Definitions (same denominators everywhere; a ratio with a zero or missing denominator is None, never 0 or inf):
* PCR (OI) = total put OI / total call OI over the strikes ATM +/- N listed strikes; PCR (volume) likewise.
  Windows are configurable; the full-chain value is the same formula over every listed strike.
* OI-change PCR = put OI change / call OI change since a reference sample, defined only when the call OI change is
  positive (a ratio with a zero or negative denominator has no useful meaning).
* Premium/OI classification compares a contract (or the sum over a side) now against a reference sample:
    premium up,   OI up    -> "Rising premium, rising OI"    tentative reading: new buying more likely
    premium down, OI up    -> "Falling premium, rising OI"   tentative reading: new writing more likely
    premium up,   OI down  -> "Rising premium, falling OI"   tentative reading: short covering more likely
    premium down, OI down  -> "Falling premium, falling OI"  tentative reading: long unwinding more likely
  Changes smaller than FLAT_PCT of the reference value count as unchanged. The readings are hypotheses: aggregate OI
  does not reveal who bought or sold, and premium also moves with the underlying, volatility and time decay.
* Concentration: share of total side OI held by the three largest strikes, and the strike with the most OI.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from app.intraday.features import CALL, PUT, Chain, nearest_strike, strike_universe

FLAT_PCT = 0.5  # percent of the reference value below which a change counts as unchanged
WINDOWS = (2, 5, 10)

READING = {
    ("up", "up"): ("Rising premium, rising OI", "new buying more likely"),
    ("down", "up"): ("Falling premium, rising OI", "new writing more likely"),
    ("up", "down"): ("Rising premium, falling OI", "short covering more likely"),
    ("down", "down"): ("Falling premium, falling OI", "long unwinding more likely"),
}
LIMITS = "Tentative: aggregate OI does not show who bought or sold, and premium also moves with the underlying, volatility and time decay."


def _ratio(a: float | None, b: float | None) -> float | None:
    return None if a is None or b is None or b <= 0 else round(a / b, 4)


def _sum(vals: Sequence[float | None]) -> float | None:
    have = [v for v in vals if v is not None]
    return float(sum(have)) if have else None


def window_pcr(chain: Chain, spot: float | None, windows: Sequence[int] = WINDOWS) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for label, each in [*[(f"atm_pm{n}", n) for n in windows], ("all", 10_000)]:
        ks = strike_universe(chain, spot, each) if each < 10_000 else sorted({k for k, _ in chain})
        ce = [chain.get((k, CALL)) for k in ks]
        pe = [chain.get((k, PUT)) for k in ks]
        ce_oi, pe_oi = _sum([q.oi if q else None for q in ce]), _sum([q.oi if q else None for q in pe])
        ce_v, pe_v = _sum([q.volume if q else None for q in ce]), _sum([q.volume if q else None for q in pe])
        out[label] = {"strikes": len(ks), "pcr_oi": _ratio(pe_oi, ce_oi), "pcr_volume": _ratio(pe_v, ce_v), "ce_oi": ce_oi, "pe_oi": pe_oi}
    return out


def oi_change_pcr(now: Chain, ref: Chain | None, spot: float | None, each: int = 10) -> dict[str, Any]:
    """Put OI change / call OI change since the reference sample, over the same strikes in both chains."""
    if ref is None:
        return {"value": None, "reason": "no reference sample"}
    ks = [k for k in strike_universe(now, spot, each) if (k, CALL) in ref and (k, PUT) in ref]

    def d(side: int) -> float | None:
        vals = [now[(k, side)].oi - ref[(k, side)].oi for k in ks if (k, side) in now and now[(k, side)].oi is not None and ref[(k, side)].oi is not None]
        return float(sum(vals)) if vals else None

    dc, dp = d(CALL), d(PUT)
    if dc is None or dp is None:
        return {"value": None, "reason": "OI missing in one of the samples", "ce_change": dc, "pe_change": dp}
    if dc <= 0:
        return {"value": None, "reason": "call OI did not increase, so the ratio is not meaningful", "ce_change": dc, "pe_change": dp}
    return {"value": round(dp / dc, 4), "reason": None, "ce_change": dc, "pe_change": dp}


def _dir(change: float, ref: float) -> str | None:
    if ref == 0:
        return None if change == 0 else ("up" if change > 0 else "down")
    pct = change / abs(ref) * 100
    return None if abs(pct) < FLAT_PCT else ("up" if pct > 0 else "down")


def classify(prem_now: float | None, prem_ref: float | None, oi_now: float | None, oi_ref: float | None) -> dict[str, Any]:
    if None in (prem_now, prem_ref, oi_now, oi_ref):
        return {"label": None, "reading": None, "reason": "a value is missing in one of the samples"}
    pd_, od = _dir(prem_now - prem_ref, prem_ref), _dir(oi_now - oi_ref, oi_ref)  # type: ignore[operator]
    if pd_ is None or od is None:
        return {"label": "Unchanged", "reading": None, "reason": f"{'premium' if pd_ is None else 'OI'} changed by less than {FLAT_PCT}%"}
    label, reading = READING[(pd_, od)]
    return {"label": label, "reading": reading, "reason": None}


def side_classification(now: Chain, ref: Chain | None, spot: float | None, each: int = 5) -> dict[str, Any]:
    """Classification of the summed premium and OI of each side over ATM +/- ``each`` strikes against the reference sample."""
    if ref is None:
        return {"available": False, "reason": "no reference sample", "limits": LIMITS}
    ks = [k for k in strike_universe(now, spot, each)]
    res: dict[str, Any] = {"available": True, "limits": LIMITS, "strikes": len(ks)}
    for name, side in (("calls", CALL), ("puts", PUT)):
        pairs = [(now.get((k, side)), ref.get((k, side))) for k in ks]
        ok = [(a, b) for a, b in pairs if a and b and a.ltp is not None and b.ltp is not None and a.oi is not None and b.oi is not None]
        if not ok:
            res[name] = {"label": None, "reading": None, "reason": "no strike has both samples"}
            continue
        c = classify(sum(a.ltp for a, _ in ok), sum(b.ltp for _, b in ok), sum(a.oi for a, _ in ok), sum(b.oi for _, b in ok))  # type: ignore[misc]
        res[name] = c | {"strikes_used": len(ok), "premium_change": round(sum(a.ltp - b.ltp for a, b in ok), 2), "oi_change": sum(a.oi - b.oi for a, b in ok)}  # type: ignore[operator]
    atm = nearest_strike(ks, spot) if ks and spot is not None else None
    rows = []
    for k in ks:
        for name, side in (("CE", CALL), ("PE", PUT)):
            a, b = now.get((k, side)), ref.get((k, side))
            if a and b and None not in (a.ltp, b.ltp, a.oi, b.oi):
                c = classify(a.ltp, b.ltp, a.oi, b.oi)
                rows.append({"strike": k, "side": name, "premium_change": round(a.ltp - b.ltp, 2), "oi_change": a.oi - b.oi, "label": c["label"], "atm": k == atm})  # type: ignore[operator]
    res["strike_rows"] = rows
    return res


def concentration(chain: Chain) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for name, side in (("calls", CALL), ("puts", PUT)):
        oi = {k: q.oi for (k, s), q in chain.items() if s == side and q.oi is not None}
        tot = sum(oi.values())
        if tot <= 0:
            out[name] = {"top3_share": None, "max_strike": None, "total_oi": tot or None}
            continue
        top = sorted(oi.items(), key=lambda kv: (-kv[1], kv[0]))
        out[name] = {"top3_share": round(sum(v for _, v in top[:3]) / tot, 4), "max_strike": top[0][0], "top3": [k for k, _ in top[:3]], "total_oi": tot}
    out["note"] = "High OI at a strike is a hypothesis for a pinning or reaction zone, not support or resistance."
    return out


def concentration_shift(now: Chain, ref: Chain | None) -> dict[str, Any] | None:
    if ref is None:
        return None
    a, b = concentration(now), concentration(ref)
    out: dict[str, Any] = {}
    for name in ("calls", "puts"):
        s0, s1 = b[name]["top3_share"], a[name]["top3_share"]
        out[name] = {"top3_share_change": None if s0 is None or s1 is None else round(s1 - s0, 4), "max_strike_from": b[name]["max_strike"], "max_strike_to": a[name]["max_strike"]}
    return out
