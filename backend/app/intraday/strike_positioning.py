"""Strike-by-strike positioning between two stored snapshots of one expiry: premium, OI, volume, IV and delta changes, indicative
premium/OI classification, OTM groups, aggregate premium baskets, premium asymmetry, and a rule-based demand classifier.

Pure functions: the service passes in two chains (``{(strike, side): Contract-like}``) and two solved surfaces. Nothing here says who
traded: open interest cannot identify buyers or sellers, so every label is "potential" and carries the evidence it rests on.
Registry ids: ``oi_premium_class``, ``premium_asymmetry``, ``demand_classifier``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

CALL, PUT = 0, 1
#: a premium or OI move smaller than this share of its starting value is "no clear change" (our threshold)
MOVE_PCT = 0.5
#: |delta| bands: deep out-of-the-money is at or below this
DEEP_DELTA = 0.10
#: the asymmetry ratio needs a call-premium change of at least this share of the call basket to be meaningful
MIN_BASE_PCT = 0.2
#: how many of the supporting conditions must hold before a demand label is shown
MIN_EVIDENCE = 3


def _pct(now: float | None, then: float | None) -> float | None:
    return None if now is None or then is None or then == 0 else round((now / then - 1) * 100, 4)


def _chg(now: float | None, then: float | None) -> float | None:
    return None if now is None or then is None else round(now - then, 4)


def classify(premium_pct: float | None, oi_pct: float | None) -> str:
    """Indicative reading of the premium and OI move of one option. Not a statement about who traded."""
    if premium_pct is None or oi_pct is None:
        return "insufficient data"
    if abs(premium_pct) < MOVE_PCT or abs(oi_pct) < MOVE_PCT:
        return "no clear change"
    if premium_pct > 0:
        return "potential long buildup" if oi_pct > 0 else "potential short covering"
    return "potential short buildup" if oi_pct > 0 else "potential long unwinding"


def _iv_map(surface: Mapping[str, Any] | None) -> dict[tuple[float, str], dict[str, Any]]:
    return {(r["strike"], r["side"]): r for r in (surface or {}).get("rows", [])}


def strike_table(
    now: Mapping[tuple[float, int], Any], then: Mapping[tuple[float, int], Any] | None,
    surf_now: Mapping[str, Any] | None, surf_then: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    """One row per listed strike with both sides' premium, OI, volume, IV, delta and their changes since ``then``.
    OI change over the session is OI minus previous-day OI (Kotak's own change field is a price change and is not used)."""
    iv_now, iv_then = _iv_map(surf_now), _iv_map(surf_then)
    rows: list[dict[str, Any]] = []
    for k in sorted({k for k, _ in now}):
        row: dict[str, Any] = {"strike": k}
        for side, name in ((CALL, "CE"), (PUT, "PE")):
            c = now.get((k, side))
            t = None if then is None else then.get((k, side))
            a, b = iv_now.get((k, name)), iv_then.get((k, name))
            prem, prem0 = None if c is None else c.ltp, None if t is None else t.ltp
            oi, oi0 = None if c is None else c.oi, None if t is None else t.oi
            vol, vol0 = None if c is None else c.volume, None if t is None else t.volume
            oi_pct = _pct(oi, oi0)
            prem_pct = _pct(prem, prem0)
            row[name.lower()] = {
                "premium": prem, "premium_then": prem0, "premium_change": _chg(prem, prem0), "premium_pct": prem_pct,
                "oi": oi, "oi_then": oi0, "oi_change": _chg(oi, oi0), "oi_pct": oi_pct,
                "oi_session_change": None if c is None or c.oi is None or c.oi_prev is None else c.oi - c.oi_prev,
                "oi_session_pct": None if c is None else _pct(c.oi, c.oi_prev),
                "volume": vol, "volume_change": _chg(vol, vol0),
                "iv": None if a is None else a["iv"], "iv_then": None if b is None else b["iv"],
                "iv_change": None if a is None or b is None or a["iv"] is None or b["iv"] is None else round(a["iv"] - b["iv"], 3),
                "delta": None if a is None else a["delta"],
                "class": classify(prem_pct, oi_pct),
            }
        rows.append(row)
    return rows


def _group(rows: Sequence[dict[str, Any]], side: str, atm: float | None) -> dict[str, list[dict[str, Any]]]:
    """Out-of-the-money options of one side split by |delta|: near (above the deep limit) and deep (at or below it)."""
    out: dict[str, list[dict[str, Any]]] = {"otm": [], "deep": []}
    if atm is None:
        return out
    for r in rows:
        q = r[side.lower()]
        otm = r["strike"] > atm if side == "CE" else r["strike"] < atm
        if not otm or q["delta"] is None:
            continue
        out["deep" if abs(q["delta"]) <= DEEP_DELTA else "otm"].append({**q, "strike": r["strike"]})
    return out


def group_summary(opts: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Totals over one group: OI and premium now and then (only strikes with both), volume and the mean IV change; contracts missing a
    value are counted and left out of that value, never counted as zero."""
    both_oi = [o for o in opts if o["oi"] is not None and o["oi_then"] is not None]
    both_pr = [o for o in opts if o["premium"] is not None and o["premium_then"] is not None]
    ivs = [o["iv_change"] for o in opts if o["iv_change"] is not None]
    oi, oi0 = sum(o["oi"] for o in both_oi), sum(o["oi_then"] for o in both_oi)
    pr, pr0 = sum(o["premium"] for o in both_pr), sum(o["premium_then"] for o in both_pr)
    vol = [o["volume_change"] for o in opts if o["volume_change"] is not None]
    return {
        "strikes": len(opts), "oi": oi, "oi_change": oi - oi0, "oi_pct": _pct(oi, oi0) if both_oi else None,
        "premium_pct": _pct(pr, pr0) if both_pr else None, "iv_change": round(sum(ivs) / len(ivs), 3) if ivs else None,
        "volume_change": sum(vol) if vol else None, "missing": len(opts) - min(len(both_oi), len(both_pr)),
    }


def up(v: float | None, lim: float = 0.0) -> bool:
    return v is not None and v > lim


def dn(v: float | None, lim: float = 0.0) -> bool:
    return v is not None and v < -lim


def demand(rows: Sequence[dict[str, Any]], atm: float | None, spot_pct: float | None) -> list[dict[str, Any]]:
    """Rule-based demand reading per group, each with the conditions that hold and those that do not. A label needs at least
    ``MIN_EVIDENCE`` conditions; otherwise it reads INSUFFICIENT EVIDENCE. Bid/ask trade direction is not stored, so it is never used."""
    out: list[dict[str, Any]] = []
    for side in ("CE", "PE"):
        for gname, opts in _group(rows, side, atm).items():
            g = group_summary(opts)
            spot_up, spot_dn = up(spot_pct, 0.05), dn(spot_pct, 0.05)
            cands: list[tuple[str, list[tuple[str, bool]]]] = []
            if side == "CE":
                cands = [
                    ("Upside speculation" if gname == "otm" else "Upside tail hedging" if gname == "deep" else "", [
                        ("premium rising", up(g["premium_pct"], MOVE_PCT)), ("IV rising", up(g["iv_change"])), ("OI rising", up(g["oi_pct"], MOVE_PCT)),
                        ("volume rising", up(g["volume_change"])), ("NIFTY rising" if gname == "otm" else "NIFTY not rising", spot_up if gname == "otm" else not spot_up)]),
                    ("Call writing", [("premium falling", dn(g["premium_pct"], MOVE_PCT)), ("OI rising", up(g["oi_pct"], MOVE_PCT)), ("IV not rising", not up(g["iv_change"])), ("NIFTY not rising", not spot_up)]),
                    ("Long unwinding", [("premium falling", dn(g["premium_pct"], MOVE_PCT)), ("OI falling", dn(g["oi_pct"], MOVE_PCT)), ("NIFTY not rising", not spot_up)]),
                    ("Short covering", [("premium rising", up(g["premium_pct"], MOVE_PCT)), ("OI falling", dn(g["oi_pct"], MOVE_PCT)), ("NIFTY rising", spot_up)]),
                ]
            else:
                cands = [
                    ("Downside speculation" if gname == "otm" else "Downside tail hedging", [
                        ("premium rising", up(g["premium_pct"], MOVE_PCT)), ("IV rising", up(g["iv_change"])), ("OI rising", up(g["oi_pct"], MOVE_PCT)),
                        ("volume rising", up(g["volume_change"])), ("NIFTY falling" if gname == "otm" else "NIFTY not falling", spot_dn if gname == "otm" else not spot_dn)]),
                    ("Put writing", [("premium falling", dn(g["premium_pct"], MOVE_PCT)), ("OI rising", up(g["oi_pct"], MOVE_PCT)), ("IV not rising", not up(g["iv_change"])), ("NIFTY not falling", not spot_dn)]),
                    ("Long unwinding", [("premium falling", dn(g["premium_pct"], MOVE_PCT)), ("OI falling", dn(g["oi_pct"], MOVE_PCT)), ("NIFTY not falling", not spot_dn)]),
                    ("Short covering", [("premium rising", up(g["premium_pct"], MOVE_PCT)), ("OI falling", dn(g["oi_pct"], MOVE_PCT)), ("NIFTY falling", spot_dn)]),
                ]
            have_data = g["strikes"] > 0 and g["premium_pct"] is not None and g["oi_pct"] is not None
            scored: list[dict[str, Any]] = [{"label": lab, "met": [n for n, ok in conds if ok], "unmet": [n for n, ok in conds if not ok], "score": sum(ok for _, ok in conds), "of": len(conds)} for lab, conds in cands]
            best = max(scored, key=lambda s: (s["score"] / s["of"], s["score"]), default=None)
            shown = best if have_data and best is not None and best["score"] >= MIN_EVIDENCE and best["score"] / best["of"] >= 0.75 else None
            out.append({
                "side": side, "group": gname, "summary": g, "label": shown["label"] if shown else "INSUFFICIENT EVIDENCE",
                "evidence": shown, "considered": scored if have_data else [],
            })
    return out


def baskets(
    now: Mapping[tuple[float, int], Any], then: Mapping[tuple[float, int], Any] | None, atm_now: float | None, atm_then: float | None,
    windows: Sequence[int | None] = (5, 10, 20, None),
) -> list[dict[str, Any]]:
    """Aggregate CE and PE premium now and then over ATM +/- n listed strikes (None = all strikes), for two baskets:
    ``fixed`` keeps the strikes that were within n of the ATM at ``then``; ``dynamic`` re-centres on each snapshot's own ATM.
    Only strikes with a premium at both times enter either aggregate, so a change is never a difference of two different baskets."""
    ks = sorted({k for k, _ in now})
    out: list[dict[str, Any]] = []
    if not ks or then is None or atm_now is None or atm_then is None:
        return out

    def window(centre: float, n: int | None, universe: Sequence[float]) -> set[float]:
        if n is None:
            return set(universe)
        i = min(range(len(universe)), key=lambda j: (abs(universe[j] - centre), universe[j]))
        return set(universe[max(0, i - n): i + n + 1])

    def agg(strikes_now: set[float], strikes_then: set[float], side: int) -> tuple[float | None, float | None, int]:
        pn = [now[(k, side)].ltp for k in strikes_now if (k, side) in now and now[(k, side)].ltp is not None]
        pt = [then[(k, side)].ltp for k in strikes_then if (k, side) in then and then[(k, side)].ltp is not None]
        return (float(sum(pn)) if pn else None, float(sum(pt)) if pt else None, min(len(pn), len(pt)))

    for n in windows:
        for kind in ("fixed", "dynamic"):
            s_then = window(atm_then, n, ks)
            s_now = s_then if kind == "fixed" else window(atm_now, n, ks)
            row: dict[str, Any] = {"window": n, "kind": kind, "strikes": len(s_now)}
            # a like-for-like change: the strikes in the basket at both times, each priced at both times
            for side, name in ((CALL, "ce"), (PUT, "pe")):
                strikes = s_then & s_now if kind == "fixed" else s_now
                both = {k for k in strikes if (k, side) in now and (k, side) in then and now[(k, side)].ltp is not None and then[(k, side)].ltp is not None}
                tot_now = sum(now[(k, side)].ltp for k in both) if both else None
                tot_then = sum(then[(k, side)].ltp for k in both) if both else None
                row[name] = {"now": tot_now, "then": tot_then, "change": _chg(tot_now, tot_then), "pct": _pct(tot_now, tot_then), "ratio": None if not tot_then or tot_now is None else round(tot_now / tot_then, 4), "strikes": len(both)}
            row["asymmetry"] = asymmetry(row["ce"], row["pe"])
            out.append(row)
    return out


def asymmetry(ce: Mapping[str, Any], pe: Mapping[str, Any]) -> dict[str, Any]:
    """Premium asymmetry ratio = |PE premium change| / |CE premium change|. Missing when the call change is zero or insignificant
    (below ``MIN_BASE_PCT`` of the call basket's own premium): a ratio of two tiny numbers is noise, not information."""
    dc, dp, base = ce.get("change"), pe.get("change"), ce.get("then")
    if dc is None or dp is None or not base:
        return {"ratio": None, "note": "missing premium change"}
    if abs(dc) < base * MIN_BASE_PCT / 100:
        return {"ratio": None, "note": f"call premium change below {MIN_BASE_PCT}% of the call basket: ratio not meaningful"}
    return {"ratio": round(abs(dp) / abs(dc), 4), "note": None}
