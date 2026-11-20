"""Raw SVI total-variance smile of one expiry, fitted with no-arbitrage constraints, with no dependency beyond NumPy.

Model (Gatheral 2004, "A parsimonious arbitrage-free implied volatility parameterization with application to the valuation of volatility derivatives"; Gatheral and Jacquier 2014,
"Arbitrage-free SVI volatility surfaces", Quantitative Finance 14), in log-moneyness k = ln(K / F) and total variance w(k) = sigma_imp(k)^2 T:

    w(k) = a + b ( rho (k - m) + sqrt((k - m)^2 + s^2) )          parameters a, b >= 0, |rho| < 1, m, s > 0

Constraints enforced by the fit:
  * minimum variance not negative:   a + b s sqrt(1 - rho^2) >= 0
  * Lee's moment bound (no wing arbitrage in the limit): b (1 + |rho|) <= 2   (Lee 2004, "The moment formula for implied volatility at extreme strikes")
  * no butterfly arbitrage (a non-negative risk-neutral density), Gatheral and Jacquier, Lemma 2.2:
        g(k) = (1 - k w'/(2 w))^2 - (w'^2 / 4)(1/w + 1/4) + w''/2 >= 0
    checked on a dense grid and held by a penalty during the fit; the minimum of g is reported.
  * no calendar arbitrage against the previous (nearer) expiry: w_far(k) >= w_near(k), held by a penalty and reported.

Method (Zeliade Systems 2009, "Quasi-explicit calibration of Gatheral's SVI model"): for fixed (m, s) the model is linear in (a, c = b s, d = b s rho), so those three are the weighted
least-squares solution, projected onto the constraints; (m, s) are found by Nelder-Mead from three starting points. Work is done in total variance scaled by its mean, so one penalty weight suits any maturity.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from numpy.typing import ArrayLike, NDArray

FloatArray = NDArray[np.float64]


@dataclass(frozen=True)
class SVIParams:
    a: float
    b: float
    rho: float
    m: float
    sigma: float  # the SVI width parameter (not a volatility)

    def total_variance(self, k: ArrayLike) -> FloatArray:
        x = np.asarray(k, dtype=np.float64) - self.m
        return self.a + self.b * (self.rho * x + np.sqrt(x * x + self.sigma * self.sigma))

    def d1(self, k: ArrayLike) -> FloatArray:
        x = np.asarray(k, dtype=np.float64) - self.m
        return self.b * (self.rho + x / np.sqrt(x * x + self.sigma * self.sigma))

    def d2(self, k: ArrayLike) -> FloatArray:
        x = np.asarray(k, dtype=np.float64) - self.m
        return self.b * self.sigma**2 / (x * x + self.sigma * self.sigma) ** 1.5

    def density(self, k: ArrayLike) -> FloatArray:
        """The butterfly function g(k): the risk-neutral density is proportional to g(k) / sqrt(w); arbitrage-free where g >= 0."""
        kk = np.asarray(k, dtype=np.float64)
        w, w1, w2 = self.total_variance(kk), self.d1(kk), self.d2(kk)
        w = np.maximum(w, 1e-18)
        return (1.0 - kk * w1 / (2.0 * w)) ** 2 - 0.25 * w1 * w1 * (1.0 / w + 0.25) + 0.5 * w2

    def implied_vol(self, k: ArrayLike, t_years: float) -> FloatArray:
        """Annualised implied volatility at log-moneyness k for an expiry t_years away."""
        return np.sqrt(np.maximum(self.total_variance(k), 0.0) / t_years)


def nelder_mead(
    fn: Callable[[FloatArray], float], x0: FloatArray, step: FloatArray, max_iter: int = 150, xtol: float = 1e-8, ftol: float = 1e-14
) -> tuple[FloatArray, float, int]:
    """Nelder-Mead simplex minimisation (Nelder and Mead 1965; standard coefficients 1, 2, 1/2, 1/2)."""
    n = x0.size
    pts = np.vstack([x0] + [x0 + step * np.eye(n)[i] for i in range(n)])
    vals = np.array([fn(p) for p in pts])
    for it in range(1, max_iter + 1):
        order = np.argsort(vals)
        pts, vals = pts[order], vals[order]
        if np.max(np.abs(pts[1:] - pts[0])) < xtol and abs(vals[-1] - vals[0]) < ftol:
            return pts[0], float(vals[0]), it
        centre = pts[:-1].mean(axis=0)
        xr = centre + (centre - pts[-1])
        fr = fn(xr)
        if fr < vals[0]:
            xe = centre + 2.0 * (centre - pts[-1])
            fe = fn(xe)
            pts[-1], vals[-1] = (xe, fe) if fe < fr else (xr, fr)
        elif fr < vals[-2]:
            pts[-1], vals[-1] = xr, fr
        else:
            xc = centre + 0.5 * ((xr if fr < vals[-1] else pts[-1]) - centre)
            fc = fn(xc)
            if fc < min(fr, vals[-1]):
                pts[-1], vals[-1] = xc, fc
            else:  # shrink towards the best point
                pts[1:] = pts[0] + 0.5 * (pts[1:] - pts[0])
                vals[1:] = [fn(p) for p in pts[1:]]
    i = int(np.argmin(vals))
    return pts[i], float(vals[i]), max_iter


@dataclass(frozen=True)
class SVIFit:
    params: SVIParams
    rms_total_variance: float  # root of the weighted mean squared error in total variance
    min_density: float  # smallest butterfly function g on the check grid (>= 0 when arbitrage-free)
    butterfly_ok: bool
    iterations: int


def _project(a: float, c: float, d: float, s: float, scale: float) -> tuple[float, float, float]:
    """Project the linear solution (a, c = b s, d = b s rho; in total variance divided by ``scale``) onto the constraints: c >= 0, |d| < c, Lee's bound b (1 + |rho|) <= 2 which is
    (c + |d|) scale <= 2 s, and minimum variance a + sqrt(c^2 - d^2) >= 0."""
    c = max(c, 0.0)
    d = float(np.clip(d, -c * (1.0 - 1e-9), c * (1.0 - 1e-9)))
    limit = 2.0 * s / scale * (1.0 - 1e-9)
    if c + abs(d) > limit:
        f = limit / (c + abs(d))
        c, d = c * f, d * f
    a = max(a, -float(np.sqrt(max(c * c - d * d, 0.0))) + 1e-12)
    return a, c, d


def fit_svi(
    k: ArrayLike,
    w: ArrayLike,
    weights: ArrayLike,
    near: SVIParams | None = None,
    warm: SVIParams | None = None,
    penalty: float = 1e3,
    grid_pad: float = 0.25,
    grid_points: int = 241,
    max_iter: int = 150,
) -> SVIFit:
    """Fit raw SVI to (k, w) with positive ``weights``. ``near`` is the fit of the previous (nearer) expiry: the calendar condition w(k) >= w_near(k) is held by a penalty.
    ``warm`` is the previous fit of this same expiry: when given, the search starts from its (m, s) alone, a few times cheaper than the three cold starts (the result is still checked against the constraints)."""
    kk, ww, wt = (np.asarray(x, dtype=np.float64) for x in (k, w, weights))
    if kk.size < 5:
        raise ValueError("an SVI fit needs at least five points")
    kmin, kmax = float(np.min(kk)), float(np.max(kk))
    scale = float(np.mean(ww))
    u = ww / scale
    wt = wt / np.sum(wt)
    grid = np.linspace(kmin - grid_pad, kmax + grid_pad, grid_points)
    near_grid = None if near is None else near.total_variance(grid) / scale

    def solve(m: float, s: float, lam: float) -> tuple[float, SVIParams]:
        y = (kk - m) / s
        basis = np.stack([np.ones_like(y), y, np.sqrt(y * y + 1.0)], axis=1)
        lhs = basis.T @ (basis * wt[:, None]) + 1e-12 * np.eye(3)
        rhs = basis.T @ (wt * u)
        a, d, c = (float(x) for x in np.linalg.solve(lhs, rhs))
        a, c, d = _project(a, c, d, s, scale)
        resid = u - (a + d * y + c * np.sqrt(y * y + 1.0))
        sse = float(np.sum(wt * resid * resid))
        b = c / s
        rho = d / c if c > 0 else 0.0
        p = SVIParams(a * scale, b * scale, rho, m, s)  # the model in the scaled variable is (a, c, d); back to total variance by the scale
        g = p.density(grid)
        pen = float(np.mean(np.minimum(g, 0.0) ** 2))
        if near_grid is not None:
            pen += float(np.mean(np.maximum(near_grid - p.total_variance(grid) / scale, 0.0) ** 2))
        out_of_range = max(0.0, abs(m - 0.5 * (kmin + kmax)) - (kmax - kmin) - grid_pad)
        return sse + lam * pen + 10.0 * out_of_range**2, p

    best: tuple[float, SVIParams, int] | None = None
    k_at_min = float(kk[int(np.argmin(ww))])
    for lam in (penalty, 100.0 * penalty):
        starts = ((warm.m, warm.sigma),) if warm is not None and lam == penalty else ((k_at_min, 0.02), (k_at_min, 0.1), (0.0, 0.05))
        for m0, s0 in starts:
            x0 = np.array([m0, np.log(s0)])
            def objective(z: FloatArray, lam: float = lam) -> float:
                return solve(float(z[0]), float(np.exp(z[1])), lam)[0]

            x, val, it = nelder_mead(objective, x0, np.array([0.02, 0.5]), max_iter=max_iter)
            _, p = solve(float(x[0]), float(np.exp(x[1])), lam)
            if best is None or val < best[0]:
                best = (val, p, it)
        assert best is not None
        fine = np.linspace(kmin - 2 * grid_pad, kmax + 2 * grid_pad, 4 * grid_points)
        if float(np.min(best[1].density(fine))) >= -1e-6:
            break  # arbitrage-free on the check grid: no need for the stronger penalty
    assert best is not None
    _, p, it = best
    fine = np.linspace(kmin - 2 * grid_pad, kmax + 2 * grid_pad, 4 * grid_points)
    gmin = float(np.min(p.density(fine)))
    resid = (ww - p.total_variance(kk))
    rms = float(np.sqrt(np.sum(wt * resid * resid)))
    return SVIFit(params=p, rms_total_variance=rms, min_density=gmin, butterfly_ok=gmin >= -1e-6, iterations=it)


def calendar_violation(near: SVIParams, far: SVIParams, k: ArrayLike) -> float:
    """Largest amount by which the nearer expiry's total variance exceeds the farther one's on the grid ``k`` (0 when the surface has no calendar arbitrage there)."""
    kk = np.asarray(k, dtype=np.float64)
    return float(np.max(np.maximum(near.total_variance(kk) - far.total_variance(kk), 0.0)))
