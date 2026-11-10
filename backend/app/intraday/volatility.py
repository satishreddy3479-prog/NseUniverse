"""Implied volatility, Greeks and expected move from real option prices (pure functions, no I/O).

Model: Black-76 (options on a forward). NIFTY options are European and cash-settled, so the forward
F = K + e^{rT} (C - P) is taken from put-call parity (the median over the five strikes nearest the money, as in the
strategy builder): it is market implied and needs
no dividend or carry assumption. Only the discount factor e^{-rT} uses an assumed rate (configurable, default in
``DEFAULT_RATE``); for the days to expiry involved it moves prices by far less than a tick of IV.
If parity cannot be formed the forward falls back to spot x e^{rT} (no dividend) and the result says so.

T = calendar time from now to the session close (``session_close()``, 15:40 IST with the auction alignment) on the expiry date, in years of 365 days. Closer than ``MIN_T_MINUTES`` to
expiry nothing is computed: theta and gamma explode and the market price is mostly noise.
Greeks are per forward: delta is with respect to F; theta per calendar day; vega per one volatility point (1 %).
Implied volatility is solved by bisection on the option price; a price outside its no-arbitrage bounds gives None.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from app.domain.session import session_close

IST = ZoneInfo("Asia/Kolkata")
DEFAULT_RATE = 0.06
MIN_T_MINUTES = 15
MAX_IV = 3.0
YEAR_DAYS = 365.0
TRADING_MINUTES_PER_YEAR = 375 * 252
CALL, PUT = 0, 1


def _n(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2))


def _pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def years_to_expiry(expiry: date, now: datetime) -> float:
    end = datetime.combine(expiry, session_close(), IST)
    return (end - now.astimezone(IST)).total_seconds() / (YEAR_DAYS * 86400)


def price(side: int, f: float, k: float, t: float, sigma: float, r: float = DEFAULT_RATE) -> float:
    df = math.exp(-r * t)
    if sigma <= 0 or t <= 0:
        return df * max(f - k, 0.0) if side == CALL else df * max(k - f, 0.0)
    v = sigma * math.sqrt(t)
    d1 = (math.log(f / k) + 0.5 * v * v) / v
    d2 = d1 - v
    if side == CALL:
        return df * (f * _n(d1) - k * _n(d2))
    return df * (k * _n(-d2) - f * _n(-d1))


def implied_vol(side: int, mkt: float | None, f: float, k: float, t: float, r: float = DEFAULT_RATE) -> float | None:
    """Annualised implied volatility (0.15 = 15 %), or None when the price admits none."""
    if mkt is None or not math.isfinite(mkt) or mkt <= 0 or not (math.isfinite(f) and math.isfinite(k) and math.isfinite(t)) or f <= 0 or k <= 0 or t <= 0:
        return None
    df = math.exp(-r * t)
    intrinsic = df * (max(f - k, 0.0) if side == CALL else max(k - f, 0.0))
    upper = df * (f if side == CALL else k)
    if mkt <= intrinsic + 1e-9 or mkt >= upper:
        return None  # at/below intrinsic or above the model's ceiling: no volatility reproduces it
    lo, hi = 1e-4, MAX_IV  # beyond 300 % the price is a stale or bad quote, not a volatility
    if price(side, f, k, t, hi, r) < mkt:
        return None
    # safeguarded Newton: a bracket [lo, hi] is kept and narrowed every step, and a Newton step that leaves it (or a vanishing vega) is
    # replaced by bisection, so it always converges to the same root as plain bisection (to 1e-8) in a handful of iterations
    sigma = min(max(math.sqrt(2 * abs(math.log(f / k)) / t) if abs(math.log(f / k)) > 1e-12 else 0.2, 0.05), 1.5)
    sqrt_t = math.sqrt(t)
    for _ in range(100):
        p_ = price(side, f, k, t, sigma, r)
        if p_ < mkt:
            lo = sigma
        else:
            hi = sigma
        if hi - lo < 1e-8:
            break
        v = sigma * sqrt_t
        d1 = (math.log(f / k) + 0.5 * v * v) / v
        vega = df * f * _pdf(d1) * sqrt_t
        nxt = sigma - (p_ - mkt) / vega if vega > 1e-12 else lo - 1
        if not lo < nxt < hi:
            nxt = (lo + hi) / 2
        if abs(nxt - sigma) < 1e-10:
            return nxt
        sigma = nxt
    return (lo + hi) / 2


@dataclass(frozen=True)
class Greeks:
    delta: float
    gamma: float
    theta_day: float
    vega_pt: float


def greeks(side: int, f: float, k: float, t: float, sigma: float, r: float = DEFAULT_RATE) -> Greeks | None:
    if f <= 0 or k <= 0 or t <= 0 or sigma <= 0:
        return None
    df = math.exp(-r * t)
    v = sigma * math.sqrt(t)
    d1 = (math.log(f / k) + 0.5 * v * v) / v
    pdf = _pdf(d1)
    delta = df * (_n(d1) if side == CALL else _n(d1) - 1)
    gamma = df * pdf / (f * v)
    vega = df * f * pdf * math.sqrt(t) / 100
    theta = r * price(side, f, k, t, sigma, r) - df * f * pdf * sigma / (2 * math.sqrt(t))
    return Greeks(delta, gamma, theta / YEAR_DAYS, vega)


def forward_from_parity(prices: Mapping[tuple[float, int], float | None], spot: float | None, t: float, r: float = DEFAULT_RATE) -> tuple[float, str] | None:
    """(forward, source): the median of the forwards implied by put-call parity at the five strikes nearest spot
    that have both prices (needs three; the strategy builder uses the same rule); else the nearest such strike
    alone, else spot x e^{rT}."""
    if spot is None or spot <= 0 or t <= 0:
        return None
    grow = math.exp(r * t)
    ks = sorted({k for k, _ in prices}, key=lambda k: (abs(k - spot), k))
    both: list[tuple[float, float, float]] = []
    for k in ks:
        c, p = prices.get((k, CALL)), prices.get((k, PUT))
        if c is not None and p is not None and c > 0 and p > 0:
            both.append((k, c, p))
    both = both[:5]
    if len(both) >= 3:
        fs = sorted(k + grow * (c - p) for k, c, p in both)
        mid = fs[len(fs) // 2] if len(fs) % 2 else (fs[len(fs) // 2 - 1] + fs[len(fs) // 2]) / 2
        return mid, f"median of put-call parity at {len(fs)} strikes nearest spot"
    if both:
        k, c, p = both[0]
        return k + grow * (c - p), f"put-call parity at {k:g}"
    return spot * grow, "spot x carry (no dividend): put-call parity unavailable"


def surface(prices: Mapping[tuple[float, int], float | None], spot: float | None, expiry: date, now: datetime, r: float = DEFAULT_RATE, each_side: int = 5) -> dict[str, Any]:
    """ATM IV, near-ATM IV, skew and OTM-option Greeks from one option chain."""
    t = years_to_expiry(expiry, now)
    base: dict[str, Any] = {
        "model": "Black-76; forward from put-call parity", "rate_assumed": r, "dividends": "none assumed (forward is market implied)",
        "time_to_expiry_days": None if t <= 0 else round(t * YEAR_DAYS, 4), "status": "ok",
    }  # fmt: skip
    if t * YEAR_DAYS * 24 * 60 < MIN_T_MINUTES:
        return base | {"status": f"not computed: less than {MIN_T_MINUTES} minutes to expiry (or expired)"}
    fw = forward_from_parity(prices, spot, t, r)
    if fw is None:
        return base | {"status": "not computed: no spot price"}
    f, src = fw
    ks = sorted({k for k, _ in prices})
    if not ks or spot is None:
        return base | {"status": "not computed: no option prices"}
    atm = min(ks, key=lambda k: (abs(k - f), k))
    i = ks.index(atm)
    near = ks[max(0, i - each_side) : i + each_side + 1]
    rows: list[dict[str, Any]] = []
    for k in near:
        for side in (CALL, PUT):
            otm = (k >= atm) if side == CALL else (k <= atm)
            px = prices.get((k, side))
            iv = implied_vol(side, px, f, k, t, r)
            g = None if iv is None else greeks(side, f, k, t, iv, r)
            rows.append({"strike": k, "side": "CE" if side == CALL else "PE", "price": px, "otm": otm, "iv": None if iv is None else round(iv * 100, 3),
                         "delta": None if g is None else round(g.delta, 4), "gamma": None if g is None else round(g.gamma, 6),
                         "theta_day": None if g is None else round(g.theta_day, 3), "vega_pt": None if g is None else round(g.vega_pt, 3)})  # fmt: skip
    by = {(r_["strike"], r_["side"]): r_ for r_ in rows}
    c_iv, p_iv = (by.get((atm, "CE")) or {}).get("iv"), (by.get((atm, "PE")) or {}).get("iv")
    atm_vals = [x for x in (c_iv, p_iv) if x is not None]
    atm_iv = sum(atm_vals) / len(atm_vals) if atm_vals else None
    otm_near = [r_["iv"] for r_ in rows if r_["otm"] and r_["iv"] is not None and abs(near.index(r_["strike"]) - near.index(atm)) <= 2]
    near_iv = sum(otm_near) / len(otm_near) if otm_near else None
    p25, c25 = iv_at_delta(rows, "PE", 0.25), iv_at_delta(rows, "CE", 0.25)
    skew = None if p25 is None or c25 is None else round(p25 - c25, 3)  # put IV minus call IV at 0.25 delta, the same definition as skew_metrics
    cp, pp = prices.get((atm, CALL)), prices.get((atm, PUT))
    straddle = cp + pp if cp is not None and pp is not None else None
    one_sd = None if atm_iv is None else f * (atm_iv / 100) * math.sqrt(t)
    return base | {
        "forward": round(f, 2), "forward_source": src, "atm_strike": atm, "atm_iv": None if atm_iv is None else round(atm_iv, 3),
        "atm_call_iv": c_iv, "atm_put_iv": p_iv, "near_atm_iv": None if near_iv is None else round(near_iv, 3),
        "skew_25d_put_minus_call": skew, "rows": rows,
        "straddle": straddle, "expected_move_straddle_pts": straddle,
        "expected_move_iv_1sd_pts": None if one_sd is None else round(one_sd, 1),
        "expected_move_note": "Both are measures to expiry implied by option prices, not forecasts and not probabilities. The straddle approximates 0.8 of a one-standard-deviation move.",
    }  # fmt: skip


def iv_at_delta(rows: Sequence[dict[str, Any]], side: str, target: float) -> float | None:
    """IV (percent) of the out-of-the-money ``side`` option at absolute delta ``target``, by linear interpolation in delta between the
    two neighbouring solved contracts that bracket it (exact when a contract sits on the target). No extrapolation: a target outside the
    listed range, or a side with fewer than two solved contracts, gives None. Mirrors ``ivAtDelta`` in frontend/src/lib/skew.ts."""
    pts = sorted(
        {round(abs(r["delta"]), 6): r["iv"] for r in rows if r["side"] == side and r["otm"] and r["iv"] is not None and r["delta"] is not None}.items(),
        reverse=True,
    )
    for (d_hi, iv_hi), (d_lo, iv_lo) in zip(pts, pts[1:], strict=False):
        if d_hi >= target >= d_lo:
            return float(iv_hi) if d_hi == d_lo else float(iv_lo + (target - d_lo) / (d_hi - d_lo) * (iv_hi - iv_lo))
    return None


def skew_metrics(rows: Sequence[dict[str, Any]], forward: float, atm_iv: float | None) -> dict[str, Any]:
    """Smile measures from one chain's solved rows (IV in percent), at 25 and 10 absolute delta found by interpolation (``iv_at_delta``).
    Skew = put IV minus call IV (positive: puts richer; the call-minus-put figure is its negation); butterfly = mean of the two wing
    IVs minus ATM IV; slope = least-squares IV points per 1% of moneyness (strike / forward - 1) over the out-of-the-money options."""
    p25, c25 = iv_at_delta(rows, "PE", 0.25), iv_at_delta(rows, "CE", 0.25)
    p10, c10 = iv_at_delta(rows, "PE", 0.10), iv_at_delta(rows, "CE", 0.10)
    pts = [((r["strike"] / forward - 1) * 100, r["iv"]) for r in rows if r["otm"] and r["iv"] is not None and forward > 0]
    slope = None
    if len(pts) >= 4:
        mx, my = sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts)
        vx = sum((x - mx) ** 2 for x, _ in pts)
        slope = None if vx == 0 else sum((x - mx) * (y - my) for x, y in pts) / vx
    def r3(v: float | None) -> float | None:
        return None if v is None else round(v, 3)

    return {
        "skew_25d": None if p25 is None or c25 is None else r3(p25 - c25),
        "skew_10d": None if p10 is None or c10 is None else r3(p10 - c10),
        "call_minus_put_25d": None if p25 is None or c25 is None else r3(c25 - p25),
        "call_minus_put_10d": None if p10 is None or c10 is None else r3(c10 - p10),
        "butterfly_25d": None if p25 is None or c25 is None or atm_iv is None else r3((p25 + c25) / 2 - atm_iv),
        "butterfly_10d": None if p10 is None or c10 is None or atm_iv is None else r3((p10 + c10) / 2 - atm_iv),
        "slope_per_pct": None if slope is None else round(slope, 4),
        "put_25d_iv": r3(p25), "call_25d_iv": r3(c25), "put_10d_iv": r3(p10), "call_10d_iv": r3(c10),
    }


#: an expiry with less than this many days left is on its last session: its IV is dominated by expiry-day effects and a time
#: difference this small makes the slope explode, so it stays in the table but is left out of the slope
MIN_TERM_DAYS = 0.5
#: a term slope within this many IV points per 30 days counts as flat
FLAT_TERM_SLOPE = 0.5


TERM_KEYS = ("atm_iv", "call_25d_iv", "put_25d_iv", "call_10d_iv", "put_10d_iv", "skew_25d", "skew_10d")


def _term_series(term: Sequence[dict[str, Any]], key: str) -> dict[str, Any]:
    """Slope of one series (``key``) across expiries: (far - near) / (DTE_far - DTE_near) x 30 between the nearest and the farthest
    expiry that has that value and at least ``MIN_TERM_DAYS`` left; ``pairs`` is the same slope between neighbouring expiries."""
    usable = [t for t in term if t.get(key) is not None and t.get("days") is not None]
    used = [t for t in usable if t["days"] >= MIN_TERM_DAYS]
    left_out = [{"expiry": t["expiry"], "reason": f"{t['days']:.2f} days left: expiry-day effects"} for t in usable if t["days"] < MIN_TERM_DAYS]
    left_out += [{"expiry": t["expiry"], "reason": "no solved ATM IV" if key == "atm_iv" else f"no {key.replace('_', ' ')}"} for t in term if t.get(key) is None or t.get("days") is None]
    pairs = [
        {"near": a["expiry"], "far": b["expiry"], "slope": round((b[key] - a[key]) / (b["days"] - a["days"]) * 30, 3)}
        for a, b in zip(used, used[1:], strict=False) if b["days"] != a["days"]
    ]
    out: dict[str, Any] = {"slope_per_30d": None, "shape": None, "near": None, "far": None, "difference": None, "pairs": pairs, "left_out": left_out}
    if len(used) >= 2 and used[-1]["days"] != used[0]["days"]:
        near, far = used[0], used[-1]
        slope = round((far[key] - near[key]) / (far["days"] - near["days"]) * 30, 3)
        out.update(
            slope_per_30d=slope,
            shape="contango" if slope > FLAT_TERM_SLOPE else "backwardation" if slope < -FLAT_TERM_SLOPE else "flat",
            near={"expiry": near["expiry"], "days": near["days"], "value": near[key]},
            far={"expiry": far["expiry"], "days": far["days"], "value": far[key]},
            difference=round(far[key] - near[key], 3),
        )
    return out


def iv_term_structure(term: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Term structure across the expiries of one moment (rows with ``expiry``, ``days`` and the per-expiry IV measures, sorted by days).
    Term slope = (far - near) / (DTE_far - DTE_near) x 30, IV points per 30 days, for ATM IV (the top-level fields, kept as before) and
    for each of ``TERM_KEYS`` under ``series`` (ATM, 25 and 10 delta call and put IV, and the 25 and 10 delta skews). Contango when a slope
    is above ``FLAT_TERM_SLOPE``, backwardation below minus it, otherwise flat. Delta IVs are the interpolated ones of ``iv_at_delta`` at the
    same moment for every expiry; an expiry lacking one is left out of that series only. Mirrors the registry entry ``term_slope``."""
    series = {k: _term_series(term, k) for k in TERM_KEYS}
    atm = series["atm_iv"]

    def shape_pts(x: dict[str, Any] | None) -> dict[str, Any] | None:
        return None if x is None else {"expiry": x["expiry"], "days": x["days"], "atm_iv": x["value"]}

    return {
        "slope_per_30d": atm["slope_per_30d"], "shape": atm["shape"], "near": shape_pts(atm["near"]), "far": shape_pts(atm["far"]),
        "pairs": atm["pairs"], "left_out": atm["left_out"], "iv_difference": atm["difference"], "series": series,
    }


def realized_annualised(points: Sequence[tuple[datetime, float]]) -> float | None:
    """Annualised realised volatility (%) from consecutive samples over their actual elapsed time. Needs >= 5 points."""
    if len(points) < 5:
        return None
    sumsq = sum(math.log(b[1] / a[1]) ** 2 for a, b in zip(points, points[1:], strict=False) if a[1] > 0 and b[1] > 0)
    minutes = (points[-1][0] - points[0][0]).total_seconds() / 60
    if minutes <= 0 or sumsq <= 0:
        return None
    return math.sqrt(sumsq / minutes * TRADING_MINUTES_PER_YEAR) * 100


def interpret(spot_change_pct: float | None, iv_change_pts: float | None, straddle_change_pct: float | None) -> list[str]:
    """Contextual observations over the same window; none of these is a trading rule."""
    out: list[str] = []
    if spot_change_pct is not None and iv_change_pts is not None:
        up, down = spot_change_pct >= 0.1, spot_change_pct <= -0.1
        iv_up, iv_dn = iv_change_pts >= 0.3, iv_change_pts <= -0.3
        if up and iv_dn:
            out.append("Underlying rising while IV falls (calls being repriced lower in volatility: a calm advance).")
        elif up and iv_up:
            out.append("Underlying rising while IV rises (demand for options along with the move).")
        elif down and iv_up:
            out.append("Underlying falling while IV rises (protection being bought or stress rising).")
        elif down and iv_dn:
            out.append("Underlying falling while IV falls (an orderly decline).")
        elif not up and not down and iv_dn:
            out.append("Underlying flat while IV falls (volatility being sold).")
    if spot_change_pct is not None and straddle_change_pct is not None:
        if abs(spot_change_pct) < 0.1 and straddle_change_pct <= -3:
            out.append("Underlying range-bound while the ATM straddle contracts (time decay and falling IV).")
        if abs(spot_change_pct) >= 0.3 and straddle_change_pct >= 0:
            out.append("Underlying moving quickly while the ATM straddle stays elevated.")
    return out


FLAT_TERM_PTS = 0.3


def term_structure(points: Sequence[tuple[date, float | None, float | None]]) -> dict[str, Any]:
    """points = [(expiry, days to expiry, ATM IV %)]. Slope in IV points per 30 days between the nearest and farthest expiry
    that have a value; 'flat' inside +/- FLAT_TERM_PTS points in total."""
    have = sorted((p for p in points if p[2] is not None and p[1] is not None), key=lambda p: p[1] or 0.0)
    rows = [{"expiry": e.isoformat(), "days": None if d is None else round(d, 2), "atm_iv": iv} for e, d, iv in sorted(points, key=lambda p: (p[1] is None, p[1] or 0.0))]
    if len(have) < 2:
        return {"rows": rows, "shape": None, "reason": "needs ATM IV for at least two expiries"}
    (_, d0, iv0), (_, d1, iv1) = have[0], have[-1]
    assert d0 is not None and d1 is not None and iv0 is not None and iv1 is not None
    diff = iv1 - iv0
    shape = "flat" if abs(diff) < FLAT_TERM_PTS else ("upward (far expiry richer)" if diff > 0 else "inverted (near expiry richer)")
    return {"rows": rows, "shape": shape, "iv_far_minus_near": round(diff, 3), "slope_per_30d": None if d1 == d0 else round(diff / (d1 - d0) * 30, 3), "reason": None,
            "note": "Near-expiry IV carries event and expiry-day effects; a difference is an observation, not a signal."}  # fmt: skip
