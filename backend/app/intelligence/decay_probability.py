"""The probability that a short at-the-money straddle's decay pays, from the straddle itself (pure functions, no I/O).

Question answered: "I sell this straddle now. At the exit time, or with a stop and a target on its premium, what are the odds and the typical and bad outcomes?"

Model (stated in full, because a probability is only as good as its model):
  * The forward F follows a lognormal martingale (no drift) with a constant volatility ``sigma`` x ``vol_scale``. ``sigma`` is the volatility that reproduces the straddle's market price (a
    solve on the straddle, so the model starts exactly at the premium being sold); ``vol_scale`` (default 1) is how much of it is expected to be realised: at 1 the model is the market's own
    view and the expected P&L is about zero by construction (checked in the tests). Whether the market's volatility is on average too high or too low is a question for the recorded days,
    not for this function: the scale is a parameter so that the calibration can answer it.
  * Variance is spent by TRADING minutes (the variance clock): the total variance to expiry, sigma^2 x t0, is spread evenly over the trading minutes left (``minutes_to_expiry``).
    The straddle is repriced along the path with Black-76 on the variance still to come, so its premium is a martingale in the model, as it must be.
  * The distribution is computed exactly on a grid (forward induction of the lognormal step probabilities over log-price cells), not simulated: same inputs, same answer, no noise.
  * A stop (premium up by X percent) and a target (premium down by Y percent) are checked at every step; the stop is checked first inside a step; the exit is booked AT the level
    (no gap through it, no slippage beyond ``cost``). Monitoring is discrete (``step_min`` minutes), which misses a spike between two steps.

Not in the model: volatility changing (the vol of vol), jumps, events, bid/ask, the discrete tick. The output is the model's probability, not a forecast of the market; its honesty is
measured against the recorded sessions in ``decay_calibration.py``.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.domain.session import SESSION_OPEN, default_close
from app.intraday.volatility import CALL, DEFAULT_RATE, PUT, price

IST = ZoneInfo("Asia/Kolkata")
LOT = 65
QUANTILES = (0.05, 0.25, 0.5, 0.75, 0.95)
MAX_STEPS = 120
SPAN_SD = 5.0  # the grid reaches this many standard deviations of the total move on each side
CELLS_PER_STEP_SD = 6  # cells per one-step standard deviation


def _phi(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2))


def straddle_price(f: float, k: float, tau: float, sigma: float, rate: float = DEFAULT_RATE) -> float:
    return price(CALL, f, k, tau, sigma, rate) + price(PUT, f, k, tau, sigma, rate)


def straddle_sigma(f: float, k: float, tau: float, premium: float, rate: float = DEFAULT_RATE) -> float | None:
    """The annualised volatility at which Black-76 prices the straddle at ``premium`` (None when no volatility does)."""
    if tau <= 0 or premium <= 0 or f <= 0 or k <= 0:
        return None
    lo, hi = 1e-4, 3.0
    if not straddle_price(f, k, tau, lo, rate) < premium < straddle_price(f, k, tau, hi, rate):
        return None
    for _ in range(80):
        mid = (lo + hi) / 2
        if straddle_price(f, k, tau, mid, rate) < premium:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-9:
            break
    return (lo + hi) / 2


def trading_minutes(start: datetime, end: datetime) -> float:
    """Trading minutes between two moments: weekdays, from the session open to the schedule's F&O close (exchange holidays are not known here, so a holiday counts as a trading day)."""
    start, end = start.astimezone(IST), end.astimezone(IST)
    if end <= start:
        return 0.0
    total, day = 0.0, start.date()
    while day <= end.date():
        if day.weekday() < 5:
            open_ = datetime.combine(day, SESSION_OPEN, IST)
            close = datetime.combine(day, default_close(day), IST)
            lo, hi = max(open_, start), min(close, end)
            if hi > lo:
                total += (hi - lo).total_seconds() / 60
        day += timedelta(days=1)
    return total


def _weighted_quantile(pairs: Sequence[tuple[float, float]], q: float) -> float:
    acc = 0.0
    for value, weight in sorted(pairs):
        acc += weight
        if acc >= q - 1e-12:
            return value
    return max(v for v, _ in pairs)


def _kernel(s: float, dx: float, kw: int) -> list[float]:
    """The probabilities of moving d cells (d = -kw..kw) in one step: a Gaussian log move with the drift that makes the forward an exact martingale ON THE GRID (the drift is solved so that
    the probability-weighted forward ratio is 1, which removes the bias that cell widths would otherwise put into the expected result)."""
    mu = -0.5 * s * s
    s_eff = math.sqrt(max(s * s - dx * dx / 12, 1e-18))  # rounding to cells adds dx^2/12 of variance (Sheppard): taken out so the grid spends the variance it was given
    w = [1.0]
    for _ in range(6):
        w = [_phi(((d + 0.5) * dx - mu) / s_eff) - _phi(((d - 0.5) * dx - mu) / s_eff) for d in range(-kw, kw + 1)]
        tot = sum(w)
        w = [x / tot for x in w]
        growth = sum(x * math.exp(d * dx) for x, d in zip(w, range(-kw, kw + 1), strict=True))
        if abs(growth - 1.0) < 1e-13:
            break
        mu -= math.log(growth)
    return w


def distribution(
    *, f0: float, strike: float, premium: float, sigma: float, t0: float, minutes_to_exit: float, minutes_to_expiry: float, rate: float = DEFAULT_RATE,
    stop_pct: float | None = None, target_pct: float | None = None, cost: float = 2.0, vol_scale: float = 1.0, step_min: float = 10.0,
) -> dict[str, Any]:  # fmt: skip
    """The distribution of the net result (points, per straddle sold) of selling at ``premium`` now and leaving at the exit, a stop or a target.

    ``f0`` forward, ``strike`` the straddle's strike, ``sigma`` the volatility that reproduces ``premium`` (see ``straddle_sigma``), ``t0`` calendar years to expiry (as Black-76 reads it),
    ``minutes_to_exit`` and ``minutes_to_expiry`` in trading minutes from now. ``cost`` is subtracted once from every outcome."""
    if min(f0, strike, premium, sigma, t0, minutes_to_exit) <= 0 or minutes_to_expiry < minutes_to_exit:
        raise ValueError("decay_probability needs positive inputs and an exit no later than the expiry")
    n = max(1, min(MAX_STEPS, math.ceil(minutes_to_exit / step_min)))
    h = minutes_to_exit / n
    sig = sigma * vol_scale
    s = sig * math.sqrt(t0 * h / minutes_to_expiry)  # standard deviation of the log move in one step
    dx = s / CELLS_PER_STEP_SD
    half = math.ceil(SPAN_SD * math.sqrt(n) * CELLS_PER_STEP_SD)
    nc, c = 2 * half + 1, half
    kw = math.ceil(SPAN_SD * CELLS_PER_STEP_SD)
    w = _kernel(s, dx, kw)
    fwd = [f0 * math.exp((j - c) * dx) for j in range(nc)]
    var_left = [t0 * (minutes_to_expiry - i * h) / minutes_to_expiry for i in range(n + 1)]  # variance still to come, in years of the vol clock
    stop_level = None if stop_pct is None else premium * (1 + stop_pct / 100)
    target_level = None if target_pct is None else premium * (1 - target_pct / 100)

    def step(mass: list[float]) -> list[float]:
        out = [0.0] * nc
        for i, m in enumerate(mass):
            if m <= 0.0:
                continue
            for d, wd in zip(range(-kw, kw + 1), w, strict=True):
                out[min(nc - 1, max(0, i + d))] += m * wd
        return out

    mass = [0.0] * nc
    mass[c] = 1.0
    outcomes: list[tuple[float, float, str]] = []  # (net result, probability, how it ended)
    for i in range(1, n + 1):
        mass = step(mass)
        tau = var_left[i]
        for j in range(nc):
            m = mass[j]
            if m <= 1e-15:
                continue
            p_now = straddle_price(fwd[j], strike, tau, sig, rate)
            if stop_level is not None and p_now >= stop_level:
                outcomes.append((premium - stop_level - cost, m, "stop"))
                mass[j] = 0.0
            elif target_level is not None and p_now <= target_level:
                outcomes.append((premium - target_level - cost, m, "target"))
                mass[j] = 0.0
    tau_n = var_left[n]
    for j in range(nc):
        if mass[j] > 1e-15:
            outcomes.append((premium - straddle_price(fwd[j], strike, tau_n, sig, rate) - cost, mass[j], "time"))
    total = sum(m for _, m, _ in outcomes)
    pairs = [(v, m / total) for v, m, _ in outcomes]
    mean = sum(v * m for v, m in pairs)
    by = {k: sum(m for _, m, tag in outcomes if tag == k) / total for k in ("stop", "target", "time")}
    be_up, be_dn = strike + premium, strike - premium
    touch = _touch_probability(fwd, c, w, kw, n, nc, be_dn, be_up)
    move_sd = f0 * (math.exp(sig * math.sqrt(t0 * minutes_to_exit / minutes_to_expiry)) - 1)
    return {
        "p_profit": round(sum(m for v, m in pairs if v > 0), 4), "mean": round(mean, 2), "quantiles": {f"p{int(q * 100)}": round(_weighted_quantile(pairs, q), 2) for q in QUANTILES},
        "p_stop": round(by["stop"], 4), "p_target": round(by["target"], 4), "p_exit_time": round(by["time"], 4), "p_touch_breakeven": round(touch, 4),
        "breakeven": {"down": round(be_dn, 1), "up": round(be_up, 1), "move_pts": round(premium, 1)}, "expected_move_pts": round(move_sd, 1),
        "steps": n, "step_min": round(h, 2), "sigma_used": round(sig, 4), "rupees_per_lot_mean": round(mean * LOT),
    }  # fmt: skip


def _touch_probability(fwd: Sequence[float], c: int, w: Sequence[float], kw: int, n: int, nc: int, low: float, high: float) -> float:
    """The probability that the forward is at or beyond either break-even at some step (discrete monitoring)."""
    mass = [0.0] * nc
    mass[c] = 1.0
    touched = 0.0
    for _ in range(n):
        out = [0.0] * nc
        for i, m in enumerate(mass):
            if m <= 0.0:
                continue
            for d, wd in zip(range(-kw, kw + 1), w, strict=True):
                out[min(nc - 1, max(0, i + d))] += m * wd
        for j in range(nc):
            if out[j] > 0.0 and (fwd[j] <= low or fwd[j] >= high):
                touched += out[j]
                out[j] = 0.0
        mass = out
    return touched


def for_point(point: Any, expiry_close: datetime, exit_at: datetime, *, stop_pct: float | None = None, target_pct: float | None = None, cost: float = 2.0, vol_scale: float = 1.0,
              step_min: float = 10.0) -> dict[str, Any]:  # fmt: skip
    """The distribution for the straddle at the money in a stored chain point (``straddle.Point``): its strike is the strike nearest the forward, its premium the sum of the two last traded
    prices. A dict with ``available: False`` and the reason when the straddle cannot be priced."""
    k = min(point.strikes, key=lambda x: (abs(x - point.f), x))
    ce, pe = point.snap.prices.get((k, CALL)), point.snap.prices.get((k, PUT))
    if ce is None or pe is None or ce + pe <= 0:
        return {"available": False, "reason": "no prices for the at-the-money strike"}
    prem = float(ce) + float(pe)
    sigma = straddle_sigma(point.f, k, point.t, prem, point.rate)
    if sigma is None:
        return {"available": False, "reason": "no volatility reproduces the straddle's price"}
    m_exit = trading_minutes(point.snap.at, exit_at)
    if m_exit < step_min / 2:
        return {"available": False, "reason": "too close to the exit time"}
    m_exp = max(trading_minutes(point.snap.at, expiry_close), m_exit)
    try:
        out = distribution(f0=point.f, strike=k, premium=prem, sigma=sigma, t0=point.t, minutes_to_exit=m_exit, minutes_to_expiry=m_exp, rate=point.rate, stop_pct=stop_pct, target_pct=target_pct,
                           cost=cost, vol_scale=vol_scale, step_min=step_min)  # fmt: skip
    except ValueError as e:
        return {"available": False, "reason": str(e)}
    return {"available": True, "strike": k, "premium": round(prem, 2), "implied_vol_pct": round(sigma * 100, 2), "forward": round(point.f, 1), **out}


def explain(d: Mapping[str, Any]) -> list[str]:
    """Plain sentences for a distribution: what the numbers say and what they do not."""
    q = d["quantiles"]
    lines = [
        f"In the model the straddle sold now ends lower at the exit {d['p_profit'] * 100:.0f}% of the time, with a typical result of {q['p50']:+.1f} points; one time in twenty it is {q['p5']:+.0f} or worse.",
        f"Break-evens are {d['breakeven']['down']:.0f} and {d['breakeven']['up']:.0f} (±{d['breakeven']['move_pts']:.0f} points); the index touches one of them before the exit in {d['p_touch_breakeven'] * 100:.0f}% of paths. "
        f"The one-standard-deviation move to the exit is about ±{d['expected_move_pts']:.0f} points.",
    ]
    if d["p_stop"] or d["p_target"]:
        lines.append(f"With the stop and the target: stopped out {d['p_stop'] * 100:.0f}%, target hit {d['p_target'] * 100:.0f}%, left at the exit {d['p_exit_time'] * 100:.0f}%; expected {d['mean']:+.1f} points.")
    return lines
