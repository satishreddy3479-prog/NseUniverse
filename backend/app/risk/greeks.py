"""Greeks of Black-76 options: analytic first and second order, bump-and-reprice third order, unit conversions and rupee terms. Vectorised, pure functions.

Derivatives are taken with respect to the forward F (the futures price: a one-point move of the index with the basis unchanged is a one-point move of F), the volatility sigma (annualised, 0.15 = 15 %),
the time to expiry T in years (ACT/365) and the rate r, with the other inputs held fixed. With V the price, df = e^(-rT), phi the standard normal density, d1, d2 and sigma sqrt(T) as in ``pricing``,
and cp = +1 for a call and -1 for a put (Black 1976; Hull, "Options, Futures and Other Derivatives"; Haug, "The Complete Guide to Option Pricing Formulas", for the second-order names):

    delta  = dV/dF        = cp df N(cp d1)
    gamma  = d2V/dF2      = df phi(d1) / (F sigma sqrt T)
    vega   = dV/dsigma    = df F phi(d1) sqrt T
    theta  = dV/dt        = -df F phi(d1) sigma / (2 sqrt T) + r V          (t is calendar time: it grows as T shrinks)
    rho    = dV/dr        = -T V
    vanna  = d2V/dF dsigma = -df phi(d1) d2 / sigma
    vomma  = d2V/dsigma2  = vega d1 d2 / sigma
    charm  = d(delta)/dt  = r delta + df phi(d1) d2 / (2T)
    veta   = d(vega)/dt   = vega [ r - (1 + d1 d2) / (2T) ]

Third order (speed = d gamma/dF, color = d gamma/dt, zomma = d gamma/dsigma, ultima = d vomma/dsigma) is NOT taken from closed forms, which lose all precision near expiry: it is a central difference of the
analytic second-order Greeks with a step proportional to the parameter (``fd_frac``), checked against a step twice as large; the two are combined by Richardson extrapolation and an element is flagged
``noisy`` when floating-point rounding is estimated to be more than ``fd_noise_tol`` of the result or the plain differences at the two steps disagree by more than ``fd_trunc_tol`` (the function is not smooth at that step). Where the time step would cross the expiry floor
the value is NaN and ``unavailable`` is True.

Guards follow ``pricing``: elements priced at intrinsic (expired or no volatility) get delta of +-df (in the money), 0 (out of the money) or +-df/2 (exactly at the money) and zero for gamma, vega, vanna, vomma, charm
and veta; invalid or missing inputs give NaN for everything. Raw units: per unit of F, per 1.00 of volatility, per year, per 1.00 of rate.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, fields

import numpy as np
from numpy.typing import ArrayLike, NDArray

from app.risk.pricing import (
    DEFAULT,
    FloatArray,
    PricingConfig,
    PricingState,
    normal_cdf,
    normal_pdf,
    prepare,
    price_from_state,
)

_EPS = float(np.finfo(np.float64).eps)


@dataclass(frozen=True)
class GreeksConfig:
    """Unit conversions and the finite-difference settings. Defaults are working values; the application config overrides them."""

    day_count: float = 365.0  # calendar days per year
    trading_hours_per_day: float = 6.416666666666667  # F&O session 09:15 to 15:40 IST; the service sets it from the session schedule
    fd_frac: float = 0.02  # bump size as a fraction of the parameter (F: of F sigma sqrt T), checked against twice this size
    fd_noise_tol: float = 1e-4  # flag a result when estimated rounding noise exceeds this fraction of it
    fd_trunc_tol: float = 0.05  # flag a result when the plain differences at the two step sizes disagree by more than this fraction (the extrapolated value is far better than either)


DEFAULT_GREEKS = GreeksConfig()


@dataclass(frozen=True)
class Greeks:
    """Raw first- and second-order Greeks (see the module docstring for the units); arrays share the broadcast shape of the inputs."""

    price: FloatArray
    delta: FloatArray
    gamma: FloatArray
    vega: FloatArray
    theta: FloatArray
    rho: FloatArray
    vanna: FloatArray
    charm: FloatArray
    vomma: FloatArray
    veta: FloatArray
    valid: NDArray[np.bool_]
    intrinsic: NDArray[np.bool_]


@dataclass(frozen=True)
class HigherOrder:
    """Raw third-order Greeks from bump-and-reprice, with the quality flags."""

    speed: FloatArray  # d gamma / dF
    color: FloatArray  # d gamma / dt (per year)
    zomma: FloatArray  # d gamma / dsigma
    ultima: FloatArray  # d vomma / dsigma
    noisy: NDArray[np.bool_]  # rounding noise or step disagreement above tolerance in any of the four
    unavailable: NDArray[np.bool_]  # the bump would cross the expiry floor, the volatility floor, or the inputs are invalid


def _greeks_from_state(st: PricingState) -> Greeks:
    live = st.valid & ~st.intrinsic
    s, t, df, d1, d2, cp = st.sigma, np.where(live, st.t_years, 1.0), st.df, st.d1, st.d2, st.cp  # t is 1.0 where the guards or missing inputs apply: no division by zero
    f = np.where(st.valid, st.forward, 1.0)
    price = price_from_state(st)
    phi = normal_pdf(d1)
    sqt = np.sqrt(np.maximum(t, 1e-300))
    delta = cp * df * normal_cdf(cp * d1)
    gamma = df * phi / (f * s * sqt)
    vega = df * f * phi * sqt
    theta = -df * f * phi * s / (2.0 * sqt) + st.rate * price
    rho = -np.maximum(np.where(np.isfinite(st.t_years), st.t_years, 0.0), 0.0) * price
    vanna = -df * phi * d2 / s
    vomma = vega * d1 * d2 / s
    charm = st.rate * delta + df * phi * d2 / (2.0 * t)
    veta = vega * (st.rate - (1.0 + d1 * d2) / (2.0 * t))
    # elements priced at intrinsic: step-function delta, no curvature, no volatility or time sensitivity beyond discounting
    kf = np.where(st.valid, st.strike, 1.0)
    moneyness = np.sign(np.where(st.valid, cp, 1.0) * (f - kf))
    delta_i = np.where(st.valid, cp, 1.0) * df * np.where(moneyness > 0, 1.0, np.where(moneyness == 0, 0.5, 0.0))
    zero = np.zeros_like(price)
    expired = st.t_years <= 0.0
    out = {
        "delta": np.where(st.intrinsic, delta_i, delta),
        "gamma": np.where(st.intrinsic, zero, gamma),
        "vega": np.where(st.intrinsic, zero, vega),
        "theta": np.where(st.intrinsic, np.where(expired, zero, st.rate * price), theta),
        "rho": rho,
        "vanna": np.where(st.intrinsic, zero, vanna),
        "charm": np.where(st.intrinsic, zero, charm),
        "vomma": np.where(st.intrinsic, zero, vomma),
        "veta": np.where(st.intrinsic, zero, veta),
    }
    nan = np.full_like(price, np.nan)
    return Greeks(price=price, valid=st.valid, intrinsic=st.intrinsic, **{k: np.where(st.valid, v, nan) for k, v in out.items()})


def greeks(
    cp: ArrayLike,
    forward: ArrayLike,
    strike: ArrayLike,
    t_years: ArrayLike,
    sigma: ArrayLike,
    rate: ArrayLike = 0.0,
    cfg: PricingConfig = DEFAULT,
) -> Greeks:
    """Analytic first- and second-order Greeks of European options on a forward, for a whole chain in one call (inputs broadcast against each other)."""
    return _greeks_from_state(prepare(cp, forward, strike, t_years, sigma, rate, cfg))


def _central(
    fn: Callable[[FloatArray], FloatArray], x: FloatArray, h: FloatArray, gcfg: GreeksConfig
) -> tuple[FloatArray, NDArray[np.bool_]]:
    """Richardson-extrapolated central difference of ``fn`` at ``x`` with step ``h`` (and 2h); returns the derivative and a noisy flag."""
    f1p, f1m, f2p, f2m = fn(x + h), fn(x - h), fn(x + 2.0 * h), fn(x - 2.0 * h)
    d1 = (f1p - f1m) / (2.0 * h)
    d2 = (f2p - f2m) / (4.0 * h)
    best = (4.0 * d1 - d2) / 3.0  # the error of a central difference is c h^2: this cancels it, leaving order h^4
    scale = np.maximum(np.maximum(np.abs(f1p), np.abs(f1m)), np.maximum(np.abs(f2p), np.abs(f2m)))
    rounding = 4.0 * _EPS * scale / h  # worst-case roundoff of the h-step difference
    tiny = scale < 1e-300  # everything underflowed: the derivative is zero, not noise
    magnitude = np.abs(best)
    noisy = ~tiny & ((rounding > gcfg.fd_noise_tol * magnitude) | (np.abs(d1 - d2) > gcfg.fd_trunc_tol * np.maximum(magnitude, rounding)))
    return np.where(tiny, 0.0, best), noisy


def higher_order(
    cp: ArrayLike,
    forward: ArrayLike,
    strike: ArrayLike,
    t_years: ArrayLike,
    sigma: ArrayLike,
    rate: ArrayLike = 0.0,
    cfg: PricingConfig = DEFAULT,
    gcfg: GreeksConfig = DEFAULT_GREEKS,
) -> HigherOrder:
    """Speed, color, zomma and ultima by bump-and-reprice of the analytic second-order Greeks (central differences, steps relative to the parameter)."""
    c, f, k, t, s, r = np.broadcast_arrays(*(np.asarray(x, dtype=np.float64) for x in (cp, forward, strike, t_years, sigma, rate)))
    base = prepare(c, f, k, t, s, r, cfg)
    ok = base.valid & ~base.intrinsic
    f_ = np.where(ok, f, 100.0)
    k_ = np.where(ok, k, 100.0)
    t_ = np.where(ok, t, 1.0)
    s_ = np.where(ok, s, 0.2)
    r_ = np.where(ok, r, 0.0)
    c_ = np.where(ok, c, 1.0)
    frac = gcfg.fd_frac
    s_eff = np.clip(s_, cfg.sigma_min, cfg.sigma_max)
    hf = frac * np.maximum(s_eff * np.sqrt(t_), 1e-4) * f_  # a fraction of the width of the Greeks' variation in F
    hs = frac * s_eff
    ht = frac * t_
    room_t = (t_ - 2.0 * ht) >= cfg.t_floor_years  # the time bumps must stay above the expiry floor
    room_s = ((s_ - 2.0 * hs) >= cfg.sigma_min) & ((s_ + 2.0 * hs) <= cfg.sigma_max)

    def gamma_of_f(x: FloatArray) -> FloatArray:
        return greeks(c_, x, k_, t_, s_, r_, cfg).gamma

    def gamma_of_s(x: FloatArray) -> FloatArray:
        return greeks(c_, f_, k_, t_, x, r_, cfg).gamma

    def vomma_of_s(x: FloatArray) -> FloatArray:
        return greeks(c_, f_, k_, t_, x, r_, cfg).vomma

    def gamma_of_t(x: FloatArray) -> FloatArray:
        return greeks(c_, f_, k_, x, s_, r_, cfg).gamma

    speed, n1 = _central(gamma_of_f, f_, hf, gcfg)
    zomma, n2 = _central(gamma_of_s, s_, hs, gcfg)
    ultima, n3 = _central(vomma_of_s, s_, hs, gcfg)
    d_gamma_dt, n4 = _central(gamma_of_t, t_, ht, gcfg)
    color = -d_gamma_dt  # t is calendar time, T = expiry - t
    avail = ok & room_t & room_s
    nan = np.full_like(f_, np.nan)
    return HigherOrder(
        speed=np.where(avail, speed, nan),
        color=np.where(avail, color, nan),
        zomma=np.where(avail, zomma, nan),
        ultima=np.where(avail, ultima, nan),
        noisy=avail & (n1 | n2 | n3 | n4),
        unavailable=~avail,
    )


@dataclass(frozen=True)
class ScaledGreeks:
    """Greeks per conventional unit: delta per point of F, gamma per point squared, vega per volatility point, theta per day / calendar hour / trading hour, rho per 1 % rate, and so on."""

    delta: FloatArray
    gamma: FloatArray
    vega: FloatArray  # per 1 vol point
    theta_day: FloatArray  # per calendar day
    theta_hour: FloatArray  # per calendar hour (theta_day / 24)
    theta_trading_hour: FloatArray  # per trading hour: the day's decay spread over the session hours (a variance-clock reading)
    rho: FloatArray  # per 1 % rate
    vanna: FloatArray  # delta change per vol point
    charm: FloatArray  # delta change per day
    vomma: FloatArray  # vega change per vol point
    veta: FloatArray  # vega (per vol point) change per day
    speed: FloatArray  # gamma change per point
    color: FloatArray  # gamma change per day
    zomma: FloatArray  # gamma change per vol point
    ultima: FloatArray  # vomma (per vol point) change per vol point


def scale(g: Greeks, h: HigherOrder, gcfg: GreeksConfig = DEFAULT_GREEKS) -> ScaledGreeks:
    """Convert raw Greeks to conventional units (volatility points are 0.01, days are calendar days)."""
    day = gcfg.day_count
    theta_day = g.theta / day
    return ScaledGreeks(
        delta=g.delta,
        gamma=g.gamma,
        vega=g.vega / 100.0,
        theta_day=theta_day,
        theta_hour=theta_day / 24.0,
        theta_trading_hour=theta_day / gcfg.trading_hours_per_day,
        rho=g.rho / 100.0,
        vanna=g.vanna / 100.0,
        charm=g.charm / day,
        vomma=g.vomma / 1e4,
        veta=g.veta / (100.0 * day),
        speed=h.speed,
        color=h.color / day,
        zomma=h.zomma / 100.0,
        ultima=h.ultima / 1e6,
    )


@dataclass(frozen=True)
class RupeeGreeks:
    """A position's Greeks in rupees: every ``ScaledGreeks`` field times lot size times signed quantity (long positive, short negative), plus the convexity P&L of a 1 % move."""

    delta: FloatArray  # rupees per 1-point move of the index
    gamma: FloatArray  # change of the rupee delta per 1-point move
    gamma_pnl_1pct: FloatArray  # rupees gained from convexity in a 1 % move: 0.5 gamma (0.01 F)^2
    vega: FloatArray  # rupees per volatility point
    theta_day: FloatArray  # rupees per calendar day
    theta_hour: FloatArray  # rupees per calendar hour
    theta_trading_hour: FloatArray  # rupees per trading hour
    rho: FloatArray  # rupees per 1 % rate
    vanna: FloatArray
    charm: FloatArray
    vomma: FloatArray
    veta: FloatArray
    speed: FloatArray
    color: FloatArray
    zomma: FloatArray
    ultima: FloatArray


def in_rupees(s: ScaledGreeks, forward: ArrayLike, lot_size: ArrayLike, quantity: ArrayLike) -> RupeeGreeks:
    """Position Greeks in rupees. ``quantity`` is signed lots (negative for a short position); the index point is worth one rupee per unit, so a lot of 65 is 65 rupees a point."""
    m = np.asarray(lot_size, dtype=np.float64) * np.asarray(quantity, dtype=np.float64)
    f = np.asarray(forward, dtype=np.float64)
    vals = {fld.name: getattr(s, fld.name) * m for fld in fields(s)}
    return RupeeGreeks(gamma_pnl_1pct=0.5 * s.gamma * (0.01 * f) ** 2 * m, **vals)
