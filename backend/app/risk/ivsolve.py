"""Implied volatility of one Black-76 price: Brenner-Subrahmanyam seed, Brent's method for the root.

Brenner and Subrahmanyam (1988, "A simple formula to compute the implied standard deviation", Financial Analysts Journal 44): for an at-the-money option the price is about
C = df F sigma sqrt(T) / sqrt(2 pi), so sigma ~ sqrt(2 pi / T) C / (df F). Away from the money the forward is replaced by the average of F and K and the out-of-the-money price is used.
The seed only places a bracket; Brent's method (Brent 1973, "Algorithms for Minimization without Derivatives", ch. 4; Press et al., "Numerical Recipes", zbrent) then finds the root and cannot fail
inside a valid bracket, whatever the seed, because the price is strictly increasing in volatility.

The solver is scalar and uses ``math`` only (about a microsecond a price), which is faster than the vectorised pricer for the ten or so evaluations one root needs.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app.risk.pricing import DEFAULT, PricingConfig

_SQRT2 = math.sqrt(2.0)
_SQRT2PI = math.sqrt(2.0 * math.pi)


def price_scalar(cp: float, forward: float, strike: float, t_years: float, sigma: float, rate: float) -> float:
    """Black-76 price without guards, for T > 0 and sigma > 0 (the solver only calls it inside its valid range). Equal to ``pricing.black76`` to rounding."""
    df = math.exp(-rate * t_years)
    vol = sigma * math.sqrt(t_years)
    d1 = (math.log(forward / strike) + 0.5 * vol * vol) / vol
    d2 = d1 - vol
    n1 = 0.5 * math.erfc(-cp * d1 / _SQRT2)
    n2 = 0.5 * math.erfc(-cp * d2 / _SQRT2)
    return df * cp * (forward * n1 - strike * n2)


def seed_brenner_subrahmanyam(cp: float, price: float, forward: float, strike: float, t_years: float, rate: float) -> float:
    """Starting volatility: sigma0 = sqrt(2 pi / T) * V / (df * (F + K) / 2), with V the out-of-the-money price (an in-the-money price less its intrinsic value)."""
    df = math.exp(-rate * t_years)
    intrinsic = df * max(cp * (forward - strike), 0.0)
    time_value = max(price - intrinsic, 1e-12)
    return math.sqrt(2.0 * math.pi / t_years) * time_value / (df * 0.5 * (forward + strike))


def brent(f, a: float, b: float, xtol: float = 1e-13, max_iter: int = 100) -> tuple[float, int]:  # type: ignore[no-untyped-def]
    """Root of ``f`` in [a, b] with f(a) and f(b) of opposite signs (Brent 1973). Returns the root and the number of iterations."""
    fa, fb = f(a), f(b)
    if fa == 0.0:
        return a, 0
    if fb == 0.0:
        return b, 0
    if fa * fb > 0.0:
        raise ValueError("the root is not bracketed")
    c, fc = a, fa
    d = e = b - a
    for it in range(1, max_iter + 1):
        if fb * fc > 0.0:
            c, fc = a, fa
            d = e = b - a
        if abs(fc) < abs(fb):
            a, b, c = b, c, b
            fa, fb, fc = fb, fc, fb
        tol = 2.0 * 2.220446049250313e-16 * abs(b) + 0.5 * xtol
        m = 0.5 * (c - b)
        if abs(m) <= tol or fb == 0.0:
            return b, it
        if abs(e) >= tol and abs(fa) > abs(fb):
            s = fb / fa
            if a == c:  # secant
                p, q = 2.0 * m * s, 1.0 - s
            else:  # inverse quadratic interpolation
                q, r = fa / fc, fb / fc
                p = s * (2.0 * m * q * (q - r) - (b - a) * (r - 1.0))
                q = (q - 1.0) * (r - 1.0) * (s - 1.0)
            if p > 0.0:
                q = -q
            p = abs(p)
            if 2.0 * p < min(3.0 * m * q - abs(tol * q), abs(e * q)):
                e, d = d, p / q
            else:
                d = e = m
        else:
            d = e = m
        a, fa = b, fb
        b += d if abs(d) > tol else math.copysign(tol, m)
        fb = f(b)
    return b, max_iter


@dataclass(frozen=True)
class IVResult:
    iv: float  # NaN when there is none
    status: str  # "ok", "invalid", "no_time_value", "above_bound", "no_root"
    iterations: int = 0
    seed: float = float("nan")


def implied_vol(
    cp: float, price: float, forward: float, strike: float, t_years: float, rate: float, cfg: PricingConfig = DEFAULT, xtol: float = 1e-12
) -> IVResult:
    """Implied volatility (annualised, 0.15 = 15 %) of a European option on a forward, or the reason there is none.

    Status ``no_time_value``: the price is not above the discounted intrinsic value (a volatility cannot be read from it); ``above_bound``: the price exceeds what any volatility up to ``sigma_max``
    can produce; ``invalid``: a non-finite or non-positive input, or less than the expiry floor left.
    """
    nan = float("nan")
    if not all(math.isfinite(x) for x in (cp, price, forward, strike, t_years, rate)) or forward <= 0 or strike <= 0 or price <= 0 or cp not in (1.0, -1.0) or t_years < cfg.t_floor_years:
        return IVResult(nan, "invalid")
    df = math.exp(-rate * t_years)
    lower = df * max(cp * (forward - strike), 0.0)
    upper = df * (forward if cp > 0 else strike)
    if price <= lower + 1e-12 * forward:
        return IVResult(nan, "no_time_value")
    if price >= upper:
        return IVResult(nan, "above_bound")
    lo_cap, hi_cap = cfg.sigma_min, cfg.sigma_max
    if price_scalar(cp, forward, strike, t_years, hi_cap, rate) < price:
        return IVResult(nan, "above_bound")
    if price_scalar(cp, forward, strike, t_years, lo_cap, rate) > price:
        return IVResult(nan, "no_time_value")
    seed = min(max(seed_brenner_subrahmanyam(cp, price, forward, strike, t_years, rate), 10.0 * lo_cap), hi_cap)
    lo, hi = max(seed * 0.5, lo_cap), min(seed * 2.0, hi_cap)

    def g(s: float) -> float:
        return price_scalar(cp, forward, strike, t_years, s, rate) - price

    while g(lo) > 0.0 and lo > lo_cap:  # widen the bracket downwards until the price is below the target (the price is increasing in volatility)
        lo = max(lo * 0.5, lo_cap)
    while g(hi) < 0.0 and hi < hi_cap:
        hi = min(hi * 2.0, hi_cap)
    if g(lo) > 0.0 or g(hi) < 0.0:
        return IVResult(nan, "no_root", 0, seed)
    root, n = brent(g, lo, hi, xtol=xtol)
    return IVResult(root, "ok", n, seed)
