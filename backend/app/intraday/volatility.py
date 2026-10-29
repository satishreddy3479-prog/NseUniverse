"""Implied volatility, Greeks and expected move from real option prices (pure functions, no I/O).

Model: Black-76 (options on a forward). NIFTY options are European and cash-settled, so the forward
F = K + e^{rT} (C - P) is taken from put-call parity at the strike nearest the money: it is market implied and needs
no dividend or carry assumption. Only the discount factor e^{-rT} uses an assumed rate (configurable, default in
``DEFAULT_RATE``); for the days to expiry involved it moves prices by far less than a tick of IV.
If parity cannot be formed the forward falls back to spot x e^{rT} (no dividend) and the result says so.

T = calendar time from now to 15:30 IST on the expiry date, in years of 365 days. Closer than ``MIN_T_MINUTES`` to
expiry nothing is computed: theta and gamma explode and the market price is mostly noise.
Greeks are per forward: delta is with respect to F; theta per calendar day; vega per one volatility point (1 %).
Implied volatility is solved by bisection on the option price; a price outside its no-arbitrage bounds gives None.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
EXPIRY_TIME = time(15, 30)
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
    end = datetime.combine(expiry, EXPIRY_TIME, IST)
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
    for _ in range(100):
        mid = (lo + hi) / 2
        if price(side, f, k, t, mid, r) < mkt:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-8:
            break
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
    """(forward, source). Parity at the strike nearest spot that has both prices; else spot x e^{rT}."""
    if spot is None or spot <= 0 or t <= 0:
        return None
    ks = sorted({k for k, _ in prices}, key=lambda k: (abs(k - spot), k))
    for k in ks[:3]:
        c, p = prices.get((k, CALL)), prices.get((k, PUT))
        if c is not None and p is not None and c > 0 and p > 0:
            return k + math.exp(r * t) * (c - p), f"put-call parity at {k:g}"
    return spot * math.exp(r * t), "spot x carry (no dividend): put-call parity unavailable"


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
    puts = [r_ for r_ in rows if r_["side"] == "PE" and r_["otm"] and r_["delta"] is not None and r_["strike"] < atm]
    calls = [r_ for r_ in rows if r_["side"] == "CE" and r_["otm"] and r_["delta"] is not None and r_["strike"] > atm]
    p25 = min(puts, key=lambda r_: abs(abs(r_["delta"]) - 0.25), default=None)
    c25 = min(calls, key=lambda r_: abs(r_["delta"] - 0.25), default=None)
    skew = None
    if p25 and c25 and abs(abs(p25["delta"]) - 0.25) <= 0.1 and abs(c25["delta"] - 0.25) <= 0.1:
        skew = round(p25["iv"] - c25["iv"], 3)  # put IV minus call IV at about 25 delta
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
