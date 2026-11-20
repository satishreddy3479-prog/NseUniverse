"""Black-76 pricing core: European options on a forward/futures price, vectorised over strikes, expiries and scenario axes with NumPy.

Pure functions, no global state: every tunable lives in ``PricingConfig`` (passed in, with the defaults below).

Formula (Black, F., 1976, "The pricing of commodity contracts", J. Financial Economics 3; also Hull, "Options, Futures and Other Derivatives", chapter on futures options):

    d1 = (ln(F/K) + 0.5 sigma^2 T) / (sigma sqrt(T)),    d2 = d1 - sigma sqrt(T)
    call = e^(-rT) [F N(d1) - K N(d2)]        put = e^(-rT) [K N(-d2) - F N(-d1)]

Put-call parity: call - put = e^(-rT) (F - K).  Index options are cash-settled and European, so the forward is the underlying of the formula.

Guards (documented decisions):
  * ``T`` below ``t_floor_s`` (default one second) or not positive: the option is at (or past) expiry and the discounted intrinsic value is returned (discount factor at the real,
    non-negative T). A contract with exactly the floor or more is priced by the model.
  * ``sigma`` below ``sigma_min`` (1e-4): intrinsic value. ``sigma`` above ``sigma_max`` (5.0) is clamped to ``sigma_max``.
  * ``F`` or ``K`` not finite or not positive, or any input NaN: the result is NaN (missing stays missing, never zero).
  * N(x) is computed as 0.5 erfc(-x / sqrt 2), exact in the tail, so deep out-of-the-money options underflow to 0 and never to NaN or Inf.
  * The result is held inside the no-arbitrage bounds [discounted intrinsic, e^(-rT) F (call) or e^(-rT) K (put)]; this only removes rounding noise (about 1e-13 relative) and is
    checked by the tests.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

import numpy as np
from numpy.typing import ArrayLike, NDArray

FloatArray = NDArray[np.float64]

CALL = 1.0
PUT = -1.0

_SQRT2 = math.sqrt(2.0)
_ERFC = np.frompyfunc(math.erfc, 1, 1)  # math.erfc is exact in both tails; applied element-wise in C


@dataclass(frozen=True)
class PricingConfig:
    """Numerical guards and the year convention. Defaults are the working values; the application config overrides them."""

    t_floor_s: float = 1.0  # seconds: below this the option is priced at intrinsic
    sigma_min: float = 1e-4  # annualised volatility (0.0001 = 0.01 %): below this, intrinsic
    sigma_max: float = 5.0  # annualised volatility (500 %): inputs above are clamped
    day_count: float = 365.0  # calendar days per year (ACT/365, as the rest of the application)

    @property
    def t_floor_years(self) -> float:
        return self.t_floor_s / (self.day_count * 86400.0)


DEFAULT = PricingConfig()


def years_between(now: datetime, expiry_end: datetime, cfg: PricingConfig = DEFAULT) -> float:
    """Years from ``now`` to the instant the contract stops trading (both timezone-aware); negative once it has passed."""
    if now.tzinfo is None or expiry_end.tzinfo is None:
        raise ValueError("years_between needs timezone-aware datetimes")
    return (expiry_end - now).total_seconds() / (cfg.day_count * 86400.0)


def _as_float(x: ArrayLike) -> FloatArray:
    return np.asarray(x, dtype=np.float64)


def normal_cdf(x: ArrayLike) -> FloatArray:
    """Standard normal distribution function N(x) = 0.5 erfc(-x / sqrt 2); NaN stays NaN, +-Inf give 1 and 0."""
    a = _as_float(x)
    return np.asarray(_ERFC(-a / _SQRT2), dtype=np.float64) * 0.5


def normal_pdf(x: ArrayLike) -> FloatArray:
    """Standard normal density exp(-x^2 / 2) / sqrt(2 pi); underflows to 0 in the tail."""
    a = _as_float(x)
    with np.errstate(under="ignore", over="ignore"):
        return np.asarray(np.exp(-0.5 * a * a) / math.sqrt(2.0 * math.pi), dtype=np.float64)


@dataclass(frozen=True)
class PricingState:
    """Broadcast inputs and the intermediate terms of one Black-76 evaluation, shared by the price and the Greeks (computed once).

    ``valid`` marks elements with usable inputs; ``intrinsic`` marks elements priced at intrinsic by the guards (expired or no volatility).
    ``d1``, ``d2`` and ``vol`` (= sigma sqrt T) are only meaningful where ``valid & ~intrinsic``.
    """

    cp: FloatArray  # +1 call, -1 put
    forward: FloatArray
    strike: FloatArray
    t_years: FloatArray  # as given (not floored)
    sigma: FloatArray  # clamped to [sigma_min, sigma_max] where used
    rate: FloatArray
    df: FloatArray  # exp(-r max(T, 0))
    vol: FloatArray
    d1: FloatArray
    d2: FloatArray
    valid: NDArray[np.bool_]
    intrinsic: NDArray[np.bool_]


def prepare(
    cp: ArrayLike,
    forward: ArrayLike,
    strike: ArrayLike,
    t_years: ArrayLike,
    sigma: ArrayLike,
    rate: ArrayLike = 0.0,
    cfg: PricingConfig = DEFAULT,
) -> PricingState:
    """Broadcast the inputs, apply the guards and compute d1 and d2. ``cp`` is +1 for calls and -1 for puts (any other value is invalid and gives NaN)."""
    c, f, k, t, s, r = np.broadcast_arrays(
        _as_float(cp), _as_float(forward), _as_float(strike), _as_float(t_years), _as_float(sigma), _as_float(rate)
    )
    finite = np.isfinite(c) & np.isfinite(f) & np.isfinite(k) & np.isfinite(t) & np.isfinite(s) & np.isfinite(r)
    valid = finite & ((c == CALL) | (c == PUT)) & (f > 0) & (k > 0)
    intrinsic = valid & ((t < cfg.t_floor_years) | (s < cfg.sigma_min))
    live = valid & ~intrinsic
    s_eff = np.clip(np.where(live, s, 1.0), cfg.sigma_min, cfg.sigma_max)
    t_eff = np.where(live, t, 1.0)
    f_eff = np.where(valid, f, 1.0)
    k_eff = np.where(valid, k, 1.0)
    vol = s_eff * np.sqrt(t_eff)
    with np.errstate(under="ignore", over="ignore"):
        d1 = (np.log(f_eff / k_eff) + 0.5 * s_eff * s_eff * t_eff) / vol
    d2 = d1 - vol
    df = np.exp(-np.where(finite, r, 0.0) * np.maximum(np.where(finite, t, 0.0), 0.0))
    return PricingState(cp=c, forward=f, strike=k, t_years=t, sigma=s_eff, rate=r, df=df, vol=vol, d1=d1, d2=d2, valid=valid, intrinsic=intrinsic)


def price_from_state(st: PricingState) -> FloatArray:
    """Black-76 price for a prepared state (NaN where the inputs are not valid)."""
    f = np.where(st.valid, st.forward, 1.0)
    k = np.where(st.valid, st.strike, 1.0)
    sign = np.where(st.valid, st.cp, 1.0)
    lower = st.df * np.maximum(sign * (f - k), 0.0)  # discounted intrinsic value
    upper = st.df * np.where(sign > 0, f, k)  # a call is worth at most the discounted forward, a put the discounted strike
    n1 = normal_cdf(sign * st.d1)
    n2 = normal_cdf(sign * st.d2)
    model = st.df * sign * (f * n1 - k * n2)
    out = np.where(st.intrinsic, lower, np.clip(model, lower, upper))
    return np.where(st.valid, out, np.nan)


def black76(
    cp: ArrayLike,
    forward: ArrayLike,
    strike: ArrayLike,
    t_years: ArrayLike,
    sigma: ArrayLike,
    rate: ArrayLike = 0.0,
    cfg: PricingConfig = DEFAULT,
) -> FloatArray:
    """Black-76 price of European options on a forward, vectorised (arrays broadcast against each other)."""
    return price_from_state(prepare(cp, forward, strike, t_years, sigma, rate, cfg))


def intrinsic_value(cp: ArrayLike, forward: ArrayLike, strike: ArrayLike, t_years: ArrayLike = 0.0, rate: ArrayLike = 0.0) -> FloatArray:
    """Discounted intrinsic value e^(-rT) max(cp (F - K), 0); NaN for invalid inputs."""
    c, f, k, t, r = np.broadcast_arrays(_as_float(cp), _as_float(forward), _as_float(strike), _as_float(t_years), _as_float(rate))
    ok = np.isfinite(c) & np.isfinite(f) & np.isfinite(k) & np.isfinite(t) & np.isfinite(r) & (f > 0) & (k > 0) & ((c == CALL) | (c == PUT))
    df = np.exp(-np.where(ok, r, 0.0) * np.maximum(np.where(ok, t, 0.0), 0.0))
    value = df * np.maximum(np.where(ok, c, 1.0) * (np.where(ok, f, 1.0) - np.where(ok, k, 1.0)), 0.0)
    return np.where(ok, value, np.nan)


def parity_residual(
    call: ArrayLike, put: ArrayLike, forward: ArrayLike, strike: ArrayLike, t_years: ArrayLike, rate: ArrayLike = 0.0
) -> FloatArray:
    """Put-call parity residual (call - put) - e^(-rT) (F - K): zero for prices from one model, a measure of inconsistency for market quotes."""
    cl, pu, f, k, t, r = np.broadcast_arrays(*(_as_float(x) for x in (call, put, forward, strike, t_years, rate)))
    return np.asarray(cl - pu - np.exp(-r * np.maximum(t, 0.0)) * (f - k), dtype=np.float64)
