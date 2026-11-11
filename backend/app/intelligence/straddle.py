"""Straddle decay intelligence: why an ATM straddle's premium does or does not decay (pure functions, no I/O).

Everything is computed from the stored one-minute option-chain samples with the existing Black-76 code in ``app.intraday.volatility``
(prices, implied volatility, Greeks, parity forward, 10/25-delta interpolation). Nothing is collected twice and nothing here feeds the
fused sentiment score: this is a separate, descriptive module.

Two position views are kept apart and never mixed:
  fixed    the strike that was nearest spot at the first usable sample, held all session (one contract pair);
  rolling  the strike nearest spot at the start of each step; each step is one same-contract change, so a roll adds no jump.

Attribution. For one leg (CE or PE of one strike) between two samples a and b the market price change is split with Black-76 repricing
over three factors, time (T), forward (F) and implied volatility (V), by Shapley values: every one of the 6 orderings is repriced and the
marginal effects averaged, so no factor is favoured by the order. The implied vol of each end is solved from that end's own market price,
hence the three Shapley terms add up to the market change (the residual shows the solver and rounding error, it is not an "IV impact").
  theta  = Shapley effect of time (includes carry); vega = Shapley effect of implied vol (includes volga);
  delta  = delta(a) x dF; gamma = Shapley effect of the forward minus the delta term (convexity: ~ half gamma x dF^2 plus higher order);
  residual = market change - (theta + vega + delta + gamma).
A window is the sum of its steps (about one minute each), so gamma is the realised convexity along the path, not a two-point approximation.

Missing stays missing: a step with a missing price or unsolvable vol at either end is skipped and counted, never filled. Prices are last
traded prices, vols and Greeks come from a model with an assumed rate, the forward from put-call parity: all labelled in ``quality``.
Thresholds in ``classify`` are working definitions, not validated cut-offs.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.intraday.volatility import (
    CALL,
    DEFAULT_RATE,
    MIN_T_MINUTES,
    PUT,
    TRADING_MINUTES_PER_YEAR,
    YEAR_DAYS,
    Greeks,
    forward_from_parity,
    greeks,
    implied_vol,
    iv_at_delta,
    price,
    surface,
    years_to_expiry,
)  # fmt: skip

SIDES = (("CE", CALL), ("PE", PUT))
COMPONENTS = ("theta", "vega", "delta", "gamma", "vanna", "volga", "residual")
KEYS = (*COMPONENTS, "actual", "vega_skew")  # vega_skew is a part of vega, not an extra term
LOT_SIZE = 65  # NIFTY contract multiplier (units per lot)
EFFICIENT_PCT = 75.0  # actual decay at least this share of the theta decay
MEANINGFUL_PCT = 20.0  # below this share (and above EXPANSION_PCT) the premium has not decayed in any meaningful way
EXPANSION_PCT = -10.0  # premium rose by more than a tenth of the theta decay
IV_MOVE_PTS = 0.3  # a vol change smaller than this is "flat"
MAX_RETURN_GAP_MIN = 10.0
WINDOWS = (5, 15, 30, 60)
PROXIES = "Last traded prices (not bid/ask); implied vols and Greeks are Black-76 model values with an assumed rate; forward from put-call parity."


def rd(v: float | None, n: int = 2) -> float | None:
    return None if v is None or not math.isfinite(v) else round(v, n)


def nearest(strikes: Sequence[float], x: float) -> float | None:
    """The listed strike nearest x, the lower one on an exact tie (as everywhere in the app)."""
    best: float | None = None
    for k in strikes:
        if best is None or abs(k - x) < abs(best - x) or (abs(k - x) == abs(best - x) and k < best):
            best = k
    return best


@dataclass(frozen=True)
class Snap:
    """One stored chain sample: spot and the last traded price and OI of every contract."""

    at: datetime
    spot: float | None
    prices: Mapping[tuple[float, int], float | None]
    oi: Mapping[tuple[float, int], int | None] = field(default_factory=dict)


@dataclass(frozen=True)
class Leg:
    price: float
    iv: float
    g: Greeks


@dataclass
class Point:
    snap: Snap
    spot: float
    t: float
    f: float
    f_src: str
    strikes: list[float]
    rate: float
    _legs: dict[tuple[float, int], Leg | None] = field(default_factory=dict)
    _surf: dict[str, Any] | None = None

    def leg(self, k: float, side: int) -> Leg | None:
        key = (k, side)
        if key not in self._legs:
            px = self.snap.prices.get(key)
            iv = implied_vol(side, px, self.f, k, self.t, self.rate)
            g = None if iv is None else greeks(side, self.f, k, self.t, iv, self.rate)
            self._legs[key] = None if px is None or iv is None or g is None else Leg(px, iv, g)
        return self._legs[key]

    def surf(self, expiry_date: Any) -> dict[str, Any]:
        if self._surf is None:
            self._surf = surface(self.snap.prices, self.spot, expiry_date, self.snap.at, self.rate, each_side=10)
        return self._surf


def build_point(snap: Snap, expiry_date: Any, rate: float = DEFAULT_RATE) -> tuple[Point | None, str | None]:
    """(point, None) or (None, reason it cannot be formed)."""
    if snap.spot is None or snap.spot <= 0:
        return None, "no spot"
    t = years_to_expiry(expiry_date, snap.at)
    if t * YEAR_DAYS * 24 * 60 < MIN_T_MINUTES:
        return None, "too close to expiry"
    fw = forward_from_parity(snap.prices, snap.spot, t, rate)
    if fw is None:
        return None, "no forward"
    strikes = sorted({k for k, _ in snap.prices})
    if not strikes:
        return None, "no contracts"
    return Point(snap, snap.spot, t, fw[0], fw[1], strikes, rate), None


# ------------------------------------------------------------------ Shapley repricing of one leg
_W = {0: 1 / 3, 1: 1 / 6, 2: 1 / 3}


def attribute_leg(a: Point, b: Point, k: float, side: int) -> dict[str, float] | None:
    """Split the leg's price change a -> b into theta, vega, delta, gamma and residual. None if either end has no price or no solvable vol."""
    la, lb = a.leg(k, side), b.leg(k, side)
    if la is None or lb is None:
        return None
    r = a.rate

    def v(use_t: bool, use_f: bool, use_v: bool) -> float:
        return price(side, b.f if use_f else a.f, k, b.t if use_t else a.t, lb.iv if use_v else la.iv, r)

    cache = {s: v(*s) for s in itertools.product((False, True), repeat=3)}
    phi = [0.0, 0.0, 0.0]
    for i in range(3):
        for s in itertools.product((False, True), repeat=3):
            if s[i]:
                continue
            on = dict(zip(range(3), s, strict=True)) | {i: True}
            s2 = (on[0], on[1], on[2])
            phi[i] += _W[sum(s)] * (cache[s2] - cache[s])
    theta, spot_eff, phi_v = phi
    ds, df_ = lb.iv - la.iv, b.f - a.f
    sig, t0 = la.iv, a.t
    vs = sig * math.sqrt(t0)
    d1 = (math.log(a.f / k) + 0.5 * vs * vs) / vs
    d2 = d1 - vs
    pdf = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
    dfac = math.exp(-r * t0)
    vega_raw = dfac * a.f * pdf * math.sqrt(t0)  # dPrice / dVol (vol as 1.00 = 100 %)
    vanna = dfac * math.sqrt(t0) * pdf * (1 - d1 / vs)  # d2Price / dF dVol
    volga = vega_raw * d1 * d2 / sig  # d2Price / dVol2
    vanna_term, volga_term = vanna * df_ * ds, 0.5 * volga * ds * ds
    # the Shapley terms already contain these interaction effects (half of the F x Vol cross term sits in each); they are shown apart, so the totals do not change
    vega = phi_v - volga_term - 0.5 * vanna_term
    delta = la.g.delta * df_
    gamma = spot_eff - delta - 0.5 * vanna_term
    actual = lb.price - la.price
    resid = actual - (theta + vega + delta + gamma + vanna_term + volga_term)
    return {"theta": theta, "vega": vega, "delta": delta, "gamma": gamma, "vanna": vanna_term, "volga": volga_term, "residual": resid, "actual": actual,
            "vega_raw": vega_raw, "d_sigma": ds, "dt_min": (a.t - b.t) * YEAR_DAYS * 24 * 60, "d_f": df_, "d_iv_pts": ds * 100}  # fmt: skip


def _sum(rows: Sequence[Mapping[str, float]]) -> dict[str, float]:
    out = dict.fromkeys(KEYS, 0.0)
    for r in rows:
        for c in out:
            out[c] += r.get(c, 0.0)
    return out


def attribute_steps(points: Sequence[Point | None], held: Sequence[float | None]) -> tuple[list[dict[str, Any] | None], int]:
    """One entry per step i (points[i-1] -> points[i]) holding CE, PE and both; None for a skipped step. Also the skipped count (missing data)."""
    steps: list[dict[str, Any] | None] = [None]
    skipped = 0
    for i in range(1, len(points)):
        a, b, k = points[i - 1], points[i], held[i - 1]
        if a is None or b is None or k is None:
            steps.append(None)
            skipped += 1
            continue
        ce, pe = attribute_leg(a, b, k, CALL), attribute_leg(a, b, k, PUT)
        if ce is None or pe is None:
            steps.append(None)
            skipped += 1
            continue
        # skew effect (first order): the part of vega due to the two legs' vols moving by different amounts, vega_i x (own change - average change)
        avg = (ce["d_sigma"] + pe["d_sigma"]) / 2
        for leg in (ce, pe):
            leg["vega_skew"] = leg["vega_raw"] * (leg["d_sigma"] - avg)
        steps.append({"ce": ce, "pe": pe, "both": _sum([ce, pe]), "t": b.snap.at, "dt_min": ce["dt_min"], "d_f": ce["d_f"]})
    return steps, skipped


def window_sum(steps: Sequence[dict[str, Any] | None], since: datetime | None) -> dict[str, Any] | None:
    use = [s for s in steps if s is not None and (since is None or s["t"] > since)]
    if not use:
        return None
    return {"ce": _sum([s["ce"] for s in use]), "pe": _sum([s["pe"] for s in use]), "both": _sum([s["both"] for s in use]), "steps": len(use)}


# ------------------------------------------------------------------ decay efficiency
def classify(efficiency: float | None) -> str:
    """Working definition: efficient (>= 75 % of the theta decay), slower (20-75 %), no meaningful decay (-10 to 20 %), premium expansion (< -10 %)."""
    if efficiency is None:
        return "unavailable"
    if efficiency >= EFFICIENT_PCT:
        return "efficient"
    if efficiency >= MEANINGFUL_PCT:
        return "slower"
    if efficiency > EXPANSION_PCT:
        return "none"
    return "expansion"


def efficiency(total: Mapping[str, float] | None) -> dict[str, Any]:
    """Actual straddle decay / expected theta decay x 100 for a summed window, the shortfall (points, rupees per lot, percent of the theta decay)
    and the cause of a shortfall. Offsets are the terms that add to the premium: IV expansion (parallel vega), skew (call and put vols moving apart),
    spot movement (delta), gamma, vanna and volga (second-order vol effects) and the unexplained residual."""
    empty = {"status": "unavailable", "efficiency_pct": None, "actual_decay": None, "expected_decay": None, "shortfall": None, "shortfall_rupees": None, "shortfall_pct": None,
             "reason": None, "causes": None}  # fmt: skip
    if total is None:
        return empty
    expected, actual = -total["theta"], -total["actual"]
    if expected <= 1e-9:
        return empty | {"actual_decay": rd(actual), "expected_decay": rd(expected), "reason": "Expected theta decay is not positive here (very close to expiry, or carry dominates), so a decay efficiency is not defined; nothing is forced."}
    eff = actual / expected * 100
    status = classify(eff)
    skew = total.get("vega_skew", 0.0)
    causes = {"IV expansion (parallel)": total["vega"] - skew, "skew change (call and put vols moving apart)": skew, "underlying price movement (net delta)": total["delta"],
              "gamma exposure (realised convexity)": total["gamma"], "vanna and volga (second-order vol effects)": total.get("vanna", 0.0) + total.get("volga", 0.0), "remaining unexplained effects": total["residual"]}  # fmt: skip
    name, size = max(causes.items(), key=lambda kv: kv[1])
    reason: str | None
    short = expected - actual
    if status == "efficient":
        reason = "IV contraction added to the decay (vega negative)" if total["vega"] < -0.1 * expected else "none: decay is close to theta"
    elif size > 0.1 * expected:
        reason = f"{name} added {size:.1f} points against {expected:.1f} points of theta"
    else:
        reason = "no single offset stands out (the shortfall is small or spread across the terms)"
    return {"status": status, "efficiency_pct": rd(eff, 1), "actual_decay": rd(actual), "expected_decay": rd(expected), "shortfall": rd(short), "shortfall_rupees": rd(short * LOT_SIZE, 0),
            "shortfall_pct": rd(short / expected * 100, 1), "reason": reason, "causes": {k: rd(v, 2) for k, v in causes.items()}, "lot_size": LOT_SIZE}  # fmt: skip


# ------------------------------------------------------------------ realised volatility
def realised(times: Sequence[datetime], spots: Sequence[float | None], minutes: int | None, end: datetime | None = None) -> dict[str, Any]:
    """Annualised realised vol (percent, trading-minute basis) from log returns of consecutive stored spots over the last ``minutes`` (None = whole session).
    Returns need at least 3 and the window must be at least 80 % covered; gaps over 10 minutes are skipped and counted."""
    pts = [(t, s) for t, s in zip(times, spots, strict=True) if s is not None and s > 0 and (end is None or t <= end)]
    out: dict[str, Any] = {"minutes": minutes, "vol_pct": None, "sum_sq": None, "returns": 0, "gaps_skipped": 0}
    if len(pts) < 2:
        return out
    end = pts[-1][0]
    cut = None if minutes is None else end.timestamp() - minutes * 60
    use = [(t, s) for t, s in pts if cut is None or t.timestamp() >= cut]
    ss, dt, n, gaps = 0.0, 0.0, 0, 0
    for (t0, s0), (t1, s1) in itertools.pairwise(use):
        m = (t1 - t0).total_seconds() / 60
        if m <= 0:
            continue
        if m > MAX_RETURN_GAP_MIN:
            gaps += 1
            continue
        ss += math.log(s1 / s0) ** 2
        dt += m
        n += 1
    out |= {"returns": n, "gaps_skipped": gaps}
    if n < 3 or dt <= 0:
        return out
    if minutes is not None and dt < 0.8 * minutes:
        out["note"] = f"covered {dt:.0f} of {minutes} minutes"
        return out
    out |= {"vol_pct": rd(math.sqrt(ss / dt * TRADING_MINUTES_PER_YEAR) * 100, 2), "sum_sq": ss}
    return out


# ------------------------------------------------------------------ the engine
def _series(points: Sequence[Point | None], fn: Any) -> list[float | None]:
    return [None if p is None else fn(p) for p in points]


def _stat(vals: Sequence[float | None], n: int = 2) -> dict[str, Any]:
    ok = [(i, v) for i, v in enumerate(vals) if v is not None]
    if not ok:
        return {"open": None, "current": None, "change": None, "change_pct": None, "open_index": None, "high": None, "low": None}
    o, c = ok[0][1], ok[-1][1]
    return {"high": rd(max(v for _, v in ok), n), "low": rd(min(v for _, v in ok), n), "open": rd(o, n), "current": rd(c, n), "change": rd(c - o, n), "change_pct": rd((c - o) / o * 100, 2) if abs(o) >= 1 else None, "open_index": ok[0][0]}


def _iv_support(ce: float | None, pe: float | None) -> dict[str, Any]:
    if ce is None or pe is None:
        return {"side": "unavailable", "text": "A leg's implied volatility is missing, so the support cannot be read."}
    ce, pe = round(ce, 1), round(pe, 1)  # judge what is shown
    up_c, up_p = ce >= IV_MOVE_PTS, pe >= IV_MOVE_PTS
    dn_c, dn_p = ce <= -IV_MOVE_PTS, pe <= -IV_MOVE_PTS
    if up_c and up_p:
        side, text = "both", f"Both legs' implied vols are higher than at the open (call {ce:+.1f}, put {pe:+.1f} points): premiums are supported by both."
    elif up_c:
        side, text = "call", f"Call IV is up {ce:+.1f} points while put IV is {pe:+.1f}: the call side is carrying the support."
    elif up_p:
        side, text = "put", f"Put IV is up {pe:+.1f} points while call IV is {ce:+.1f}: the put side is carrying the support."
    elif dn_c and dn_p:
        side, text = "neither", f"Both implied vols are lower than at the open (call {ce:+.1f}, put {pe:+.1f} points): vol is pulling premiums down, not supporting them."
    else:
        side, text = "neither", f"Implied vols are about flat on both legs (call {ce:+.1f}, put {pe:+.1f} points): vol is not the support."
    return {"side": side, "text": text, "ce_change_pts": rd(ce, 2), "pe_change_pts": rd(pe, 2)}


def _diff(a: Sequence[float | None], b: Sequence[float | None]) -> list[float | None]:
    return [None if x is None or y is None else x - y for x, y in zip(a, b, strict=True)]


def _slope(xs: Sequence[float], ys: Sequence[float]) -> tuple[float | None, float | None]:
    n = len(xs)
    if n < 20:
        return None, None
    mx, my = sum(xs) / n, sum(ys) / n
    vx, vy = sum((x - mx) ** 2 for x in xs), sum((y - my) ** 2 for y in ys)
    if vx == 0 or vy == 0:
        return None, None
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    return cov / vx, cov / math.sqrt(vx * vy)



MOVE_WINDOWS = (5, 15, 30, 60)


def _moves(times: Sequence[datetime], vals: Sequence[float | None], n: int = 2) -> dict[str, float | None]:
    """Change of a series over the last 5, 15, 30 and 60 minutes: latest value minus the last value at or before the cut. None if the session is shorter
    than the window or either end is missing (nothing is filled)."""
    last = max((i for i, v in enumerate(vals) if v is not None), default=None)
    out: dict[str, float | None] = {str(m): None for m in MOVE_WINDOWS}
    if last is None:
        return out
    for m in MOVE_WINDOWS:
        cut = times[last].timestamp() - m * 60
        if times[0].timestamp() > cut:
            continue
        j = max((i for i in range(last) if times[i].timestamp() <= cut and vals[i] is not None), default=None)
        if j is not None:
            out[str(m)] = rd(vals[last] - vals[j], n)  # type: ignore[operator]
    return out


def iv_regime(dce: float | None, dpe: float | None) -> dict[str, Any]:
    """Names the call/put implied-vol behaviour from two changes in vol points. Says nothing about who is buying or selling: only how the two vols moved."""
    if dce is None or dpe is None:
        return {"tags": [], "text": "A leg's implied vol is missing, so the regime cannot be read."}
    t = IV_MOVE_PTS
    tags: list[str] = []
    if dce >= t and dpe >= t:
        tags.append("both_expanding")
    if dce <= -t and dpe <= -t:
        tags.append("both_contracting")
    if dpe >= t and dpe - dce >= t:
        tags.append("put_expanding_faster")
    if dce >= t and dce - dpe >= t:
        tags.append("call_expanding_faster")
    if dpe <= -t and dce - dpe >= t:
        tags.append("put_contracting_faster")
    if dce <= -t and dpe - dce >= t:
        tags.append("call_contracting_faster")
    names = {"both_expanding": "both call and put IV expanding", "both_contracting": "both call and put IV contracting", "put_expanding_faster": "put IV expanding faster than call IV",
             "call_expanding_faster": "call IV expanding faster than put IV", "put_contracting_faster": "put IV contracting faster than call IV", "call_contracting_faster": "call IV contracting faster than put IV"}  # fmt: skip
    text = (", ".join(names[x] for x in tags) if tags else "no clear call/put IV pattern") + f" (call {dce:+.1f}, put {dpe:+.1f} vol points). This describes how the two vols moved, not who is buying or selling."
    return {"tags": tags, "text": text, "ce_change_pts": rd(dce, 2), "pe_change_pts": rd(dpe, 2)}


def retention(fixed: Mapping[str, Any], win: Mapping[str, Any] | None) -> dict[str, Any]:
    """Which side of the fixed straddle keeps more of its opening premium, and the largest term offsetting its theta."""
    ce, pe = fixed["ce"], fixed["pe"]
    if not ce["open"] or not pe["open"] or ce["current"] is None or pe["current"] is None:
        return {"side": "unavailable", "text": "A leg's opening or current price is missing."}
    rc, rp = ce["current"] / ce["open"] * 100, pe["current"] / pe["open"] * 100
    side = "CE" if rc > rp + 2 else "PE" if rp > rc + 2 else "neither"
    out: dict[str, Any] = {"side": side, "ce_retained_pct": rd(rc, 1), "pe_retained_pct": rd(rp, 1)}
    text = (f"The {side} retains more premium: " if side != "neither" else "Both legs retain about the same share: ") + f"CE {rc:.0f}% and PE {rp:.0f}% of the opening price."
    if win is not None and side != "neither":
        leg = win["ce" if side == "CE" else "pe"]
        offs = {"IV change": leg["vega"], "price movement (delta)": leg["delta"], "gamma": leg["gamma"], "vanna and volga": leg["vanna"] + leg["volga"]}
        name, size = max(offs.items(), key=lambda kv: kv[1])
        text += f" Against its {-leg['theta']:.1f} points of theta the largest offset is {name} ({size:+.1f} points); its actual change is {leg['actual']:+.1f}."
    out["text"] = text
    return out


def vol_regime(iv_move: Mapping[str, float | None], rv: Mapping[str, Any], accel: Mapping[str, Any], eff30: float | None) -> dict[str, Any]:
    """Volatility compression, volatility expansion or directional acceleration from the ATM IV change, the change of realised vol (last 15 minutes against
    the 15 before) and how directional the last 30 minutes were (net move over total path). Working rules, not validated."""
    reasons: list[str] = []
    ivc = iv_move.get("30") if iv_move.get("30") is not None else iv_move.get("60")
    ratio = accel.get("ratio")
    directional = eff30 is not None and eff30 >= 0.5
    rising = ratio is not None and ratio >= 1.2
    if directional:
        reasons.append(f"the last 30 minutes were directional (net move {eff30 * 100:.0f}% of the path travelled)")  # type: ignore[operator]
    if ratio is not None:
        reasons.append(f"realised vol over the last 15 minutes is {ratio:.2f}x the previous 15")
    if ivc is not None:
        reasons.append(f"ATM IV moved {ivc:+.2f} points over the recent window")
    if directional and rising:
        label = "directional acceleration"
    elif (ivc is not None and ivc >= 0.5) or (ratio is not None and ratio >= 1.3):
        label = "volatility expansion"
    elif (ivc is not None and ivc <= -0.5) or (ratio is not None and ratio <= 0.7 and not directional):
        label = "volatility compression"
    elif ivc is None and ratio is None:
        label = "undetermined"
        reasons.append("not enough stored session for the 15-minute comparisons")
    else:
        label = "no clear regime"
    return {"label": label, "reasons": reasons, "accel": accel, "path_efficiency_30m": None if eff30 is None else rd(eff30, 2),
            "note": "Descriptive working rules; IV change is the rolling ATM implied vol, realised vol is annualised on trading minutes."}  # fmt: skip


def gamma_config(net: float | None, flip_dist_pct: float | None, conc_share: float | None, rv_ratio: float | None, accel: float | None, spot_near_wall: bool) -> list[dict[str, str]]:
    """What the modelled gamma set-up is associated with. GEX is modelled exposure (an assumed dealer sign convention), never an observed position."""
    out: list[dict[str, str]] = []
    near_flip = flip_dist_pct is not None and abs(flip_dist_pct) <= 0.3
    if net is not None and net > 0 and not near_flip and (rv_ratio is None or rv_ratio < 1):
        out.append({"tag": "suppressed movement", "why": "modelled net GEX is positive, spot is not near the flip, and realised movement is below the straddle's break-even"})
    if net is not None and net < 0:
        out.append({"tag": "increasing movement", "why": "modelled net GEX is negative: the model's dealer hedging would add to moves"})
    if (near_flip or (net is not None and net < 0)) and accel is not None and accel >= 1.2:
        out.append({"tag": "potential gamma-driven acceleration", "why": "spot is near or beyond the modelled flip and realised vol is rising"})
    if conc_share is not None and conc_share >= 40 and spot_near_wall and (rv_ratio is None or rv_ratio < 1):
        out.append({"tag": "price stabilisation around gamma concentration", "why": f"{conc_share:.0f}% of gamma x OI sits within two strikes of ATM and spot is near a wall"})
    if not out:
        out.append({"tag": "no clear gamma configuration", "why": "the modelled set-up does not point one way; positive GEX alone is not a low-volatility guarantee"})
    return out


def analyse(
    snaps: Sequence[Snap], spots_all: Sequence[tuple[datetime, float | None]], expiry_date: Any, *, rate: float = DEFAULT_RATE, now: datetime | None = None,
    gex: Mapping[str, Any] | None = None, live: bool = True, gex_points: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:  # fmt: skip
    """Modules 1-7 for one session of one expiry from its stored samples. ``snaps`` are the (possibly thinned) samples with contracts; ``spots_all`` every stored spot."""
    reasons: dict[str, int] = {}
    pts: list[Point | None] = []
    for s in snaps:
        p, why = build_point(s, expiry_date, rate)
        pts.append(p)
        if why:
            reasons[why] = reasons.get(why, 0) + 1
    ok = [p for p in pts if p is not None]
    base: dict[str, Any] = {"model": "Black-76 repricing, Shapley attribution over time, forward and implied vol", "rate_assumed": rate, "proxies": PROXIES,
                            "definitions": DEFINITIONS, "samples": len(snaps), "unusable": reasons}  # fmt: skip
    if len(ok) < 2:
        return base | {"status": "unavailable", "message": "Fewer than two usable stored samples (spot, prices and enough time to expiry) for this expiry.", "interpretation": []}
    times = [s.at for s in snaps]
    spot = [None if p is None else p.spot for p in pts]
    fwd = _series(pts, lambda p: p.f)
    rolling_k = [None if p is None else nearest(p.strikes, p.spot) for p in pts]

    def pair(p: Point | None, k: float | None) -> tuple[Leg | None, Leg | None]:
        return (None, None) if p is None or k is None else (p.leg(k, CALL), p.leg(k, PUT))

    # fixed strike: nearest spot at the first sample where both legs have a price and a solvable vol
    open_i = next((i for i, p in enumerate(pts) if p is not None and all(pair(p, rolling_k[i])) ), None)
    if open_i is None:
        return base | {"status": "unavailable", "message": "No stored sample has both the call and the put price (and a solvable vol) at the strike nearest spot.", "interpretation": []}
    fixed_k = rolling_k[open_i]
    fixed_held = [fixed_k] * len(pts)

    def leg_series(held: Sequence[float | None]) -> dict[str, Any]:
        ce = [pair(p, held[i])[0] for i, p in enumerate(pts)]
        pe = [pair(p, held[i])[1] for i, p in enumerate(pts)]
        sd = [None if c is None or d is None else c.price + d.price for c, d in zip(ce, pe, strict=True)]
        civ = [None if c is None else c.iv * 100 for c in ce]
        piv = [None if d is None else d.iv * 100 for d in pe]
        both = [None if a is None or b is None else (a + b) / 2 for a, b in zip(civ, piv, strict=True)]
        return {"strike": list(held), "ce": [None if c is None else c.price for c in ce], "pe": [None if d is None else d.price for d in pe], "straddle": sd,
                "ce_iv": civ, "pe_iv": piv, "iv": both}  # fmt: skip

    roll, fix = leg_series(rolling_k), leg_series(fixed_held)
    steps_roll, skip_roll = attribute_steps(pts, rolling_k)
    steps_fix, skip_fix = attribute_steps(pts, fixed_held)
    last_t = times[max(i for i, p in enumerate(pts) if p is not None)]

    def cumulative(steps: Sequence[dict[str, Any] | None]) -> dict[str, list[float | None]]:
        acc = dict.fromkeys((*COMPONENTS, "actual"), 0.0)
        out: dict[str, list[float | None]] = {c: [] for c in acc}
        for s in steps:
            if s is not None:
                for c in acc:
                    acc[c] += s["both"][c]
            for c in acc:
                out[c].append(rd(acc[c], 3))
        return out

    def windows(steps: Sequence[dict[str, Any] | None]) -> dict[str, Any]:
        spec = {"open": None, "60": 60, "30": 30}
        out: dict[str, Any] = {}
        for name, m in spec.items():
            since = None if m is None else last_t.fromtimestamp(last_t.timestamp() - m * 60, last_t.tzinfo)
            full = m is None or times[0].timestamp() <= last_t.timestamp() - m * 60
            ws = window_sum(steps, since) if full else None
            out[name] = None if ws is None else {k: ({c: rd(x, 3) for c, x in v.items()} if isinstance(v, dict) else v) for k, v in ws.items()} | {"efficiency": efficiency(ws["both"])}
        return out

    attribution = {"fixed": windows(steps_fix), "rolling": windows(steps_roll)}
    # --- module 1: premium tracker
    s_fix, s_roll = _stat(fix["straddle"]), _stat(roll["straddle"])
    tracker: dict[str, Any] = {
        "fixed": {"strike": fixed_k, "ce": _stat(fix["ce"]), "pe": _stat(fix["pe"]), "straddle": s_fix},
        "rolling": {"ce": _stat(roll["ce"]), "pe": _stat(roll["pe"]), "straddle": s_roll, "rolls": sum(1 for i in range(1, len(rolling_k)) if rolling_k[i] is not None and rolling_k[i - 1] is not None and rolling_k[i] != rolling_k[i - 1]),
                    "adjusted_change": rd(cumulative(steps_roll)["actual"][-1], 2)},
        "opening_at": times[open_i].isoformat(),
    }  # fmt: skip
    last_ok = max(i for i, p in enumerate(pts) if p is not None)
    adj_series = cumulative(steps_roll)["actual"]
    tracker["atm_open"], tracker["atm_now"] = fixed_k, rolling_k[last_ok]
    tracker["moves"] = {"fixed": {"straddle": _moves(times, fix["straddle"]), "ce": _moves(times, fix["ce"]), "pe": _moves(times, fix["pe"])},
                        "rolling_adjusted": {"straddle": _moves(times, adj_series)}}  # fmt: skip
    f_now, r_now = s_fix["current"], s_roll["current"]
    tracker["difference"] = {"fixed_minus_rolling_now": None if f_now is None or r_now is None else rd(f_now - r_now),
                             "fixed_change": s_fix["change"], "rolling_adjusted_change": tracker["rolling"]["adjusted_change"],
                             "note": "The fixed series is one contract pair; the rolling line also changes contract at every roll, so its raw change includes roll jumps. The roll-adjusted change adds only same-contract changes."}  # fmt: skip
    # --- module 2: IV analysis
    surfs = [None if p is None else p.surf(expiry_date) for p in pts]

    def at_delta(side: str, d: float) -> list[float | None]:
        return [None if s is None or s.get("status") != "ok" else iv_at_delta(s["rows"], side, d) for s in surfs]

    pe25, ce25, pe10, ce10 = at_delta("PE", 0.25), at_delta("CE", 0.25), at_delta("PE", 0.10), at_delta("CE", 0.10)
    skew25, skew10, rr25, rr10 = _diff(pe25, ce25), _diff(pe10, ce10), _diff(ce25, pe25), _diff(ce10, pe10)
    spot_move_pct = None
    sp = [v for v in spot if v is not None]
    if len(sp) >= 2 and sp[0] > 0:
        spot_move_pct = (sp[-1] / sp[0] - 1) * 100
    iv_comb = _stat(fix["iv"])
    spot_i = [(i, v) for i, v in enumerate(spot) if v is not None]
    xs, ys = [], []
    for (i0, s0), (i1, s1) in itertools.pairwise(spot_i[::5]):
        a, b = fix["iv"][i0], fix["iv"][i1]
        if a is not None and b is not None and s0 > 0:
            xs.append((s1 / s0 - 1) * 100)
            ys.append(b - a)
    slope, corr = _slope(xs, ys)
    bfly25 = [None if a is None or b is None or c is None else (a + b) / 2 - c for a, b, c in zip(pe25, ce25, roll["iv"], strict=True)]
    bfly10 = [None if a is None or b is None or c is None else (a + b) / 2 - c for a, b, c in zip(pe10, ce10, roll["iv"], strict=True)]
    ivm = {"fixed_ce": _moves(times, fix["ce_iv"]), "fixed_pe": _moves(times, fix["pe_iv"]), "rolling_atm": _moves(times, roll["iv"]), "skew25": _moves(times, skew25), "rr25": _moves(times, rr25)}
    regimes = {w: iv_regime(ivm["fixed_ce"][w], ivm["fixed_pe"][w]) for w in ("30", "60")} | {"open": iv_regime(_stat(fix["ce_iv"])["change"], _stat(fix["pe_iv"])["change"])}
    iv = {
        "levels": {"pe25": _stat(pe25), "ce25": _stat(ce25), "pe10": _stat(pe10), "ce10": _stat(ce10), "butterfly25": _stat(bfly25), "butterfly10": _stat(bfly10)},
        "moves": ivm, "regimes": regimes,
        "fixed": {"ce": _stat(fix["ce_iv"]), "pe": _stat(fix["pe_iv"]), "combined": iv_comb}, "rolling": {"ce": _stat(roll["ce_iv"]), "pe": _stat(roll["pe_iv"]), "combined": _stat(roll["iv"])},
        "skew25": _stat(skew25), "skew10": _stat(skew10), "rr25": _stat(rr25), "rr10": _stat(rr10),
        "per_spot_pct": None if spot_move_pct is None or abs(spot_move_pct) < 0.1 or iv_comb["change"] is None else rd(iv_comb["change"] / spot_move_pct, 2),
        "iv_vs_spot": {"slope_pts_per_pct": rd(slope, 2), "corr": rd(corr, 2), "pairs": len(xs), "note": "5-sample changes; needs at least 20 pairs"},
        "support": _iv_support(_stat(fix["ce_iv"])["change"], _stat(fix["pe_iv"])["change"]),
    }  # fmt: skip
    # --- module 4: realised vs implied
    spots_t = [t for t, _ in spots_all]
    spots_v = [v for _, v in spots_all]
    rv = {str(m): realised(spots_t, spots_v, m) for m in WINDOWS} | {"open": realised(spots_t, spots_v, None)}
    iv_now = _stat(roll["iv"])["current"]
    last_p = [p for p in pts if p is not None][-1]
    straddle_now = _stat(roll["straddle"])["current"]
    hi_lo = [v for v in spot if v is not None]
    daily_sd = None if iv_now is None else last_p.f * iv_now / 100 / math.sqrt(252)
    ro = rv["open"]
    rvs = {
        "windows": rv, "iv_now": rd(iv_now), "iv_open": _stat(roll["iv"])["open"],
        "gap": {k: (None if v["vol_pct"] is None or iv_now is None else rd(iv_now - v["vol_pct"], 2)) for k, v in rv.items()},
        "implied_move_pts": rd(straddle_now), "implied_move_pct": rd(straddle_now / last_p.spot * 100, 2) if straddle_now else None, "implied_daily_sd_pts": rd(daily_sd),
        "actual_move_pts": rd(hi_lo[-1] - hi_lo[0]), "actual_range_pts": rd(max(hi_lo) - min(hi_lo)),
        "move_vs_daily_sd": None if not daily_sd else rd(abs(hi_lo[-1] - hi_lo[0]) / daily_sd, 2),
        "realised_variance": {"sum_sq_returns": None if ro["sum_sq"] is None else round(ro["sum_sq"], 8), "session_move_sd_pct": None if ro["sum_sq"] is None else rd(math.sqrt(ro["sum_sq"]) * 100, 3), "returns": ro["returns"]},
        "note": "Realised vol is annualised on trading minutes (375 x 252 a year); the quoted implied vol is on calendar time, the usual way the two are compared. The gap is IV minus RV in vol points.",
    }  # fmt: skip
    last_time = times[last_ok]
    prev_end = last_time.fromtimestamp(last_time.timestamp() - 15 * 60, last_time.tzinfo)
    r_now15, r_prev15 = rv["15"]["vol_pct"], realised(spots_t, spots_v, 15, prev_end)["vol_pct"]
    accel = {"now_15m": r_now15, "previous_15m": r_prev15, "ratio": None if not r_now15 or not r_prev15 else rd(r_now15 / r_prev15, 2),
             "label": None if not r_now15 or not r_prev15 else ("accelerating" if r_now15 / r_prev15 >= 1.3 else "decelerating" if r_now15 / r_prev15 <= 0.7 else "steady")}  # fmt: skip
    cut30 = last_time.timestamp() - 30 * 60
    seg = [v for t, v in zip(spots_t, spots_v, strict=True) if v is not None and t.timestamp() >= cut30]
    path = sum(abs(b - a) for a, b in itertools.pairwise(seg))
    eff30 = abs(seg[-1] - seg[0]) / path if len(seg) >= 10 and path > 0 and spots_t[0].timestamp() <= cut30 else None
    rvs["acceleration"] = accel
    rvs["move_30m_pts"] = rd(seg[-1] - seg[0]) if len(seg) >= 10 and spots_t[0].timestamp() <= cut30 else None
    rvs["iv_state"] = "expanding" if (ivm["rolling_atm"]["30"] or 0) >= 0.5 else "contracting" if (ivm["rolling_atm"]["30"] or 0) <= -0.5 else "stable" if ivm["rolling_atm"]["30"] is not None else "unavailable"
    regime = vol_regime(ivm["rolling_atm"], rv, accel, eff30)
    # --- module 6: gamma and structure
    now_legs = [(last_p.leg(k, CALL), last_p.leg(k, PUT)) for k in [nearest(last_p.strikes, last_p.spot)] if k is not None]
    theta_day = gamma_pt = None
    if now_legs and all(now_legs[0]):
        c_, p_ = now_legs[0]
        assert c_ is not None and p_ is not None
        theta_day, gamma_pt = c_.g.theta_day + p_.g.theta_day, c_.g.gamma + p_.g.gamma
    breakeven = None if theta_day is None or not gamma_pt or gamma_pt <= 0 else math.sqrt(2 * abs(theta_day) / gamma_pt)
    sd60 = rv["60"]["vol_pct"] if rv["60"]["vol_pct"] is not None else ro["vol_pct"]
    real_day_sd = None if sd60 is None else last_p.f * sd60 / 100 / math.sqrt(252)
    surf_now = surfs[max(i for i, p in enumerate(pts) if p is not None)]
    conc = _concentration(surf_now, last_p) if surf_now else None
    structure: dict[str, Any] = {
        "gex": None if not gex or not gex.get("available") else {k: gex.get(k) for k in ("at", "net", "regime", "flip", "flip_distance_pts", "flip_distance_pct", "net_change_15m", "relationship", "spot_change_15m_pct", "call_wall", "put_wall", "near_net", "flip_support")},
        "gex_session": _gex_session(gex_points),
        "concentration": conc, "straddle_theta_per_day": rd(theta_day), "straddle_gamma": None if gamma_pt is None else round(gamma_pt, 6),
        "breakeven_daily_move_pts": rd(breakeven), "realised_daily_sd_pts": rd(real_day_sd),
        "realised_vs_breakeven": None if breakeven is None or real_day_sd is None else rd(real_day_sd / breakeven, 2),
        "spot_move_pts": rd(hi_lo[-1] - hi_lo[0]),
        "assumption": "GEX is modelled exposure under an assumed dealer sign convention (calls long, puts short gamma), not observed dealer positioning.",
        "note": "Net GEX describes dealer positioning under stated assumptions; it does not guarantee low or high volatility. Break-even move = sqrt(2 x |theta| / gamma) per day: a daily move that big makes gamma gains pay for one day of theta.",
    }  # fmt: skip
    gx_ = structure["gex"] or {}
    walls = [w for w in (gx_.get("call_wall"), gx_.get("put_wall")) if w is not None]
    structure["config"] = gamma_config(gx_.get("net"), gx_.get("flip_distance_pct"), (conc or {}).get("share_pct"), structure["realised_vs_breakeven"], accel["ratio"],
                                       any(abs(last_p.spot - w) / last_p.spot <= 0.0025 for w in walls)) if gx_ else []  # fmt: skip
    # --- quality
    last_at = max(s.at for s in snaps)
    age_min = None if now is None else (now - last_at).total_seconds() / 60
    quality = {
        "last_sample_at": last_at.isoformat(), "age_minutes": rd(age_min, 1), "stale": bool(live and age_min is not None and age_min > 10), "live": live,
        "steps_skipped_fixed": skip_fix, "steps_skipped_rolling": skip_roll, "forward_fallbacks": sum(1 for p in ok if p.f_src.startswith("spot x carry")),
        "estimated": ["implied volatility and Greeks (model, assumed rate)", "forward (put-call parity)", "opening values = first stored sample with both prices"],
        "stride_note": "Samples are about a minute apart; thinned only if a session has more than the page limit.",
    }  # fmt: skip
    out = base | {
        "status": "ok", "times": [t.isoformat() for t in times], "spot": [rd(v) for v in spot], "forward": [rd(v) for v in fwd], "tracker": tracker,
        "series": {"rolling": {k: [rd(x, 3) for x in v] if k != "strike" else v for k, v in roll.items()}, "fixed": {k: [rd(x, 3) for x in v] if k != "strike" else v for k, v in fix.items()},
                   "skew25": [rd(x, 3) for x in skew25], "skew10": [rd(x, 3) for x in skew10], "rr25": [rd(x, 3) for x in rr25], "rr10": [rd(x, 3) for x in rr10]},
        "iv": iv, "regime": regime, "retention": retention(tracker["fixed"], attribution["fixed"]["open"]), "attribution": attribution, "cumulative": {"fixed": cumulative(steps_fix), "rolling": cumulative(steps_roll)}, "realised_vs_implied": rvs, "structure": structure, "quality": quality,
    }  # fmt: skip
    out["interpretation"], out["climate"] = interpret(out)
    return out


def _gex_session(points: Sequence[Mapping[str, Any]] | None) -> dict[str, Any] | None:
    """How modelled net GEX and the flip moved through the session: first and latest net, range, and how many times spot crossed the flip."""
    pts = [x for x in (points or []) if x.get("net") is not None]
    if len(pts) < 2:
        return None
    nets = [float(x["net"]) for x in pts]
    side = [(float(x["spot"]) - float(x["flip"])) for x in pts if x.get("spot") is not None and x.get("flip") is not None]
    cross = sum(1 for a, b in itertools.pairwise(side) if a * b < 0)
    return {"first_net": rd(nets[0]), "latest_net": rd(nets[-1]), "min_net": rd(min(nets)), "max_net": rd(max(nets)), "net_change": rd(nets[-1] - nets[0]), "points": len(pts), "flip_crossings": cross}


def _concentration(s: Mapping[str, Any], p: Point) -> dict[str, Any] | None:
    """Share of gamma x open interest that sits within two strikes of the ATM strike, among the strikes the model solved (+-10 strikes)."""
    if s.get("status") != "ok":
        return None
    rows = s["rows"]
    atm = nearest(sorted({r["strike"] for r in rows}), p.spot)
    ks = sorted({r["strike"] for r in rows})
    if atm is None:
        return None
    ai = ks.index(atm)
    tot = near = 0.0
    missing = 0
    for r in rows:
        oi = p.snap.oi.get((r["strike"], CALL if r["side"] == "CE" else PUT))
        if oi is None or r["gamma"] is None:
            missing += 1
            continue
        w = r["gamma"] * oi
        tot += w
        if abs(ks.index(r["strike"]) - ai) <= 2:
            near += w
    return {"share_pct": None if tot <= 0 else rd(near / tot * 100, 1), "atm": atm, "contracts_missing": missing, "scope": "within 2 strikes of ATM, among the 10 strikes each side"}


# ------------------------------------------------------------------ module 7: reading and climate
def interpret(a: Mapping[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    att, tr, iv, rv, st = a["attribution"], a["tracker"], a["iv"], a["realised_vs_implied"], a["structure"]
    main = att["fixed"]["open"]
    recent = att["rolling"]["60"] or att["rolling"]["open"]
    out: list[dict[str, Any]] = []
    eff_m = None if main is None else main["efficiency"]
    names = {"efficient": "efficiently", "slower": "slower than theta alone would give", "none": "with no meaningful decay", "expansion": "not at all: the premium has expanded", "unavailable": "(not computable)"}
    if eff_m and eff_m["efficiency_pct"] is not None:
        out.append({"q": "Is the straddle decaying normally?", "a": f"Since the open the {tr['fixed']['strike']:g} straddle has decayed {names[eff_m['status']]}: {eff_m['actual_decay']:.1f} points actual against {eff_m['expected_decay']:.1f} expected from time alone ({eff_m['efficiency_pct']:.0f}%). {eff_m['reason'] or ''}".strip()})
    else:
        out.append({"q": "Is the straddle decaying normally?", "a": "Not computable yet: the model needs at least two samples with both prices and solvable vols."})
    if main is not None:
        v, g, d = main["both"]["vega"], main["both"]["gamma"], main["both"]["delta"]
        out.append({"q": "Is IV contraction helping decay?", "a": f"Vega contributed {v:+.1f} points to the straddle since the open (call IV {fmt_pts(iv['fixed']['ce']['change'])}, put IV {fmt_pts(iv['fixed']['pe']['change'])})." + (" IV has fallen and is adding to the decay." if v < -0.3 else " It is not adding materially to the decay.")})
        out.append({"q": "Is IV expansion supporting premiums?", "a": iv["support"]["text"] + (f" Vega added {v:+.1f} points." if v > 0.3 else "")})
        th = -main["both"]["theta"]
        out.append({"q": "Is spot movement and gamma offsetting theta?", "a": f"Gamma added {g:+.1f} and net delta {d:+.1f} points against {th:.1f} points of theta" + (f" (gamma = {g / th * 100:.0f}% of the theta decay)." if th > 0 else ".") + (" Realised movement is paying for part of the decay." if th > 0 and g > 0.25 * th else " Movement is small against the decay.")})
    f_ce, f_pe = tr["fixed"]["ce"], tr["fixed"]["pe"]
    if f_ce["open"] and f_pe["open"] and f_ce["current"] is not None and f_pe["current"] is not None:
        rc, rp = f_ce["current"] / f_ce["open"] * 100, f_pe["current"] / f_pe["open"] * 100
        side = "CE" if rc > rp + 2 else "PE" if rp > rc + 2 else "neither"
        out.append({"q": "Which side, CE or PE, is retaining more premium?", "a": (f"The {side} is retaining more: " if side != "neither" else "Both sides retain about the same: ") + f"CE at {rc:.0f}% and PE at {rp:.0f}% of their opening price (fixed {tr['fixed']['strike']:g} strike)."})
    gap60 = rv["gap"].get("60") if rv["gap"].get("60") is not None else rv["gap"].get("open")
    tally, why = 0, []
    use = recent
    if use and use["efficiency"]["efficiency_pct"] is not None:
        s_ = use["efficiency"]["status"]
        tally += {"efficient": 1, "slower": 0, "none": -1, "expansion": -2}.get(s_, 0)
        why.append(f"recent decay {s_}")
    if use:
        vv = use["both"]["vega"]
        if vv < -0.3:
            tally += 1
            why.append("IV falling")
        elif vv > 0.3:
            tally -= 1
            why.append("IV rising")
        th = -use["both"]["theta"]
        if th > 0 and use["both"]["gamma"] > 0.5 * th:
            tally -= 1
            why.append("gamma gains over half of theta")
    if gap60 is not None:
        if gap60 > 1:
            tally += 1
            why.append("realised vol below implied")
        elif gap60 < -1:
            tally -= 1
            why.append("realised vol above implied")
    label = "unknown" if not why else "favourable" if tally >= 2 else "unfavourable" if tally <= -2 else "mixed"
    climate = {"label": label, "tally": tally, "because": why, "window": "last 60 minutes" if att["rolling"]["60"] else "since open",
               "note": "A tally of the readings above, not a forecast and not part of the sentiment score. Favourable means premium has been decaying near or faster than theta with vol and movement not working against it."}  # fmt: skip
    out.append({"q": "Is the market currently favourable or unfavourable for premium decay?", "a": f"{label.capitalize()} ({', '.join(why) if why else 'not enough data'})."})
    if st.get("realised_vs_breakeven") is not None:
        out.append({"q": "Gamma and structure", "a": f"Realised daily-equivalent move {st['realised_daily_sd_pts']} points against a break-even of {st['breakeven_daily_move_pts']} points ({st['realised_vs_breakeven']}x)." + (f" Net GEX is {st['gex']['regime']}; this describes dealer positioning and does not guarantee low volatility." if st.get("gex") and st["gex"].get("regime") else "")})
    return out, climate


def fmt_pts(v: float | None) -> str:
    return "n/a" if v is None else f"{v:+.1f}"


DEFINITIONS = {
    "straddle": "Call price + put price of one strike (last traded). Decay = opening premium minus premium.",
    "fixed": "The strike nearest spot at the first usable sample, held all session.",
    "rolling": "The strike nearest spot at the start of each step; steps add only same-contract changes.",
    "theta": "Shapley effect of the passage of time (calendar time to the expiry close) on the Black-76 price, carry included.",
    "vega": "Shapley effect of the change in the leg's own implied vol.",
    "delta": "Delta at the start of the step x the change in the forward.",
    "gamma": "Shapley effect of the forward move minus the delta term: convexity.",
    "residual": "Market change minus the four terms: model and solver error only.",
    "efficiency": f"Actual straddle decay / theta decay x 100. Efficient >= {EFFICIENT_PCT:.0f}, slower {MEANINGFUL_PCT:.0f}-{EFFICIENT_PCT:.0f}, none {EXPANSION_PCT:.0f}-{MEANINGFUL_PCT:.0f}, expansion below {EXPANSION_PCT:.0f}. Working thresholds, not validated.",
    "skew": "Skew = put IV minus call IV at the delta; risk reversal = call IV minus put IV (its negative).",
}


# ------------------------------------------------------------------ validation: predicted theta decay vs actual, window by window
def window_pairs(snaps: Sequence[Snap], expiry_date: Any, minutes: int = 30, rate: float = DEFAULT_RATE) -> list[dict[str, Any]]:
    """Non-overlapping windows of ``minutes`` over one session on the fixed opening strike. The prediction is made from the window's first sample only:
    the Black-76 price change from time alone (forward and vol held at their start values). The actual is the market change of the same contract pair."""
    pts = [build_point(s, expiry_date, rate)[0] for s in snaps]
    pts_ok = [p for p in pts if p is not None]
    if len(pts_ok) < 2:
        return []
    k = None
    for p in pts_ok:
        kk = nearest(p.strikes, p.spot)
        if kk is not None and p.leg(kk, CALL) and p.leg(kk, PUT):
            k = kk
            break
    if k is None:
        return []
    out: list[dict[str, Any]] = []
    start = pts_ok[0]
    for p in pts_ok[1:]:
        if (p.snap.at - start.snap.at).total_seconds() < minutes * 60:
            continue
        pred = act = 0.0
        ok = True
        for side in (CALL, PUT):
            l0, l1 = start.leg(k, side), p.leg(k, side)
            if l0 is None or l1 is None:
                ok = False
                break
            pred += price(side, start.f, k, p.t, l0.iv, rate) - l0.price
            act += l1.price - l0.price
        if ok:
            out.append({"start": start.snap.at.isoformat(), "end": p.snap.at.isoformat(), "strike": k, "predicted": pred, "actual": act})
        start = p
    return out


def validate(sessions: Sequence[Mapping[str, Any]], min_sessions: int = 20, min_windows: int = 100) -> dict[str, Any]:
    """Aggregate window pairs of chronological sessions. Predicted and actual are price changes (negative = decay). No fitting is done, so every window is out of
    sample; sufficiency is about how many windows there are, and even then this checks the decay arithmetic, it is not a market forecast."""
    rows: list[dict[str, Any]] = []
    per: list[dict[str, Any]] = []
    for s in sessions:
        w = s["windows"]
        if not w:
            continue
        rows += w
        sp, sa = sum(x["predicted"] for x in w), sum(x["actual"] for x in w)
        per.append({"session": s["session"], "expiry": s["expiry"], "windows": len(w), "predicted": rd(sp), "actual": rd(sa), "ratio": rd(sa / sp, 2) if sp else None})

    def agg(rs: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        if not rs:
            return {"windows": 0}
        p, a = [x["predicted"] for x in rs], [x["actual"] for x in rs]
        n = len(rs)
        mae = sum(abs(x - y) for x, y in zip(p, a, strict=True)) / n
        _, corr = _slope(p, a) if n >= 20 else (None, None)
        return {"windows": n, "predicted_mean": rd(sum(p) / n, 3), "actual_mean": rd(sum(a) / n, 3), "ratio_actual_to_predicted": rd(sum(a) / sum(p), 2) if sum(p) else None,
                "mae": rd(mae, 3), "corr": rd(corr, 2), "decayed_share_pct": rd(sum(1 for x in a if x < 0) / n * 100, 1)}  # fmt: skip

    half = len(per) // 2
    names = [p["session"] for p in per]
    earlier = [w for s in sessions if s["session"] in names[:half] for w in s["windows"]]
    later = [w for s in sessions if s["session"] in names[half:] for w in s["windows"]]
    enough = len(per) >= min_sessions and len(rows) >= min_windows
    return {"sessions": per, "overall": agg(rows), "earlier_half": agg(earlier), "later_half": agg(later), "sufficient": enough,
            "message": ("Enough sessions to describe how the time-decay arithmetic compares with actual premium changes; this still does not make it a forecast." if enough else
                        f"Insufficient: {len(per)} session(s) and {len(rows)} window(s) (need {min_sessions} and {min_windows}). Treat these figures as a description of the stored days, not as evidence of accuracy."),
            "method": "Prediction from each window's first sample: Black-76 price change from time alone with forward and vol held fixed. Actual: market change of the same call and put. Negative = decay.",
            "note": "Actual includes vol, delta and gamma effects that the prediction deliberately leaves out; a ratio below 1 means premium decayed less than theta alone."}  # fmt: skip
