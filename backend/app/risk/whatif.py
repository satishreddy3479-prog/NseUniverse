"""What-If scenario engine: re-value a set of option legs under a spot shock, a volatility shock, elapsed time and a rate shock, on a fitted implied-volatility surface.

Pipeline for every scenario (all vectorised over legs and over the scenario axes):
  1. New forward  F' = F + spot_shock (points, absolute): a move of the index at an unchanged basis. The rate shock moves the discount rate only (the forward is not re-carried).
  2. New time to expiry  T' = T - elapsed / (24 * day_count), T measured to the exchange expiry INSTANT (the F&O close of the expiry date, given per expiry: 15:40 IST now, 15:45 from 7 Dec 2026), never
     to midnight; below one second the pricing core returns intrinsic value.
  3. New volatility of each leg by the STICKY RULE, from the fitted smile of the leg's expiry, then the parallel shock  sigma'' = sigma' + iv_shock / 100  (volatility points, absolute):
       moneyness (default)  the smile holds as a function of log-moneyness k = ln(K / F): sigma'(K) = sigma_surface(ln(K / F'))
       strike               each strike keeps its volatility: sigma'(K) = sigma_surface(ln(K / F))
       delta                the smile holds as a function of call delta N(d1): sigma' = sigma_surface(k*) where k* solves  N(d1_base(k*)) = N(d1(F', K, T', sigma_surface(k*)))  (base delta taken at the
                            surface's maturity, the shocked option's at the scenario's time to expiry), by Newton's method on k* started from the moneyness solution. With no time elapsed this is exactly
                            the moneyness rule (the same maturity and the same volatility give the same moneyness); as time elapses strikes drift away from the money in delta terms and read the wings
                            of the smile. k* is held inside the range of strikes the surface was fitted on, widened a little: the volatility never reads outside the data.
  4. Re-price every leg with Black-76 and aggregate the change of value in rupees: sum over legs of  quantity * lot size * (V' - V)  with quantity signed (long positive, short negative).

V is the MODEL value of the leg now (Black-76 at the surface's own volatility), not its market price or entry price: a scenario P&L is the change of the theoretical value, so the zero scenario is zero
by construction (inputs equal to the base return the base value, not a recomputation). P&L against an entry price is reported alongside when the leg has one.

Time is the only thing the surface does not move with: the smile's volatility levels are annualised and held under the sticky rule, so elapsed time changes value through T alone (and, under sticky delta, through the delta of each strike).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
from numpy.typing import ArrayLike, NDArray

from app.risk.ivsurface import IST, SliceFit, SurfaceSnapshot
from app.risk.pricing import DEFAULT, PricingConfig, black76, normal_cdf, years_between
from app.risk.svi import SVIParams

FloatArray = NDArray[np.float64]
STICKY_RULES = ("moneyness", "strike", "delta")


@dataclass(frozen=True)
class WhatIfConfig:
    """Defaults of the engine and of the presets; the application config overrides them."""

    default_sticky: str = "moneyness"
    grid_spot_points: int = 21
    grid_iv_points: int = 21
    grid_spot_sd: float = 2.0  # default spot axis: +- this many standard deviations of the nearest expiry
    grid_iv_range_pts: float = 10.0  # default volatility axis: +- this many volatility points
    gap_down_pct: float = 2.0
    iv_spike_pts: float = 5.0
    crush_pts: float = 4.0  # expiry-day crush: this many volatility points lost ...
    crush_hours_before_expiry: float = 1.0  # ... with the clock moved to this long before the expiry instant
    delta_range_pad: float = 0.02  # sticky delta may read the smile this far (log-moneyness) beyond the fitted strikes, flat after that
    delta_newton_iterations: int = 12
    delta_tol: float = 1e-12


DEFAULT_WHATIF = WhatIfConfig()


@dataclass(frozen=True)
class Leg:
    """One option position. ``quantity`` is signed lots (long positive, short negative); ``entry_price`` (per unit) is optional and only used for the P&L against entry."""

    expiry: str
    strike: float
    cp: float
    quantity: float
    lot_size: int
    entry_price: float | None = None


@dataclass(frozen=True)
class Scenario:
    spot_shock: float = 0.0  # index points, absolute
    iv_shock: float = 0.0  # volatility points, absolute (+5 is five points of volatility)
    time_elapsed_hours: float = 0.0
    sticky_rule: str = "moneyness"
    rate_shock: float = 0.0  # absolute, 0.01 is one percentage point


@dataclass(frozen=True)
class LegResult:
    expiry: str
    strike: float
    cp: float
    quantity: float
    status: str  # "ok" or the reason the leg could not be valued
    base_iv: float
    new_iv: float
    base_value: float  # per unit
    new_value: float
    pnl: float  # rupees, signed: quantity * lot size * (new - base)
    pnl_vs_entry: float | None  # rupees: quantity * lot size * (new - entry), when the leg has an entry price


@dataclass(frozen=True)
class ScenarioResult:
    scenario: Scenario
    surface_version_id: str
    as_of_ist: str
    pnl: float  # rupees; NaN when any leg could not be valued (``partial_pnl`` then holds the sum of the others)
    partial_pnl: float
    legs: tuple[LegResult, ...]
    forward_after: Mapping[str, float]
    t_years_after: Mapping[str, float]
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class GridResult:
    surface_version_id: str
    as_of_ist: str
    row_axis: tuple[float, ...]  # spot shocks (points)
    col_axis: tuple[float, ...]  # volatility shocks (points) or elapsed hours
    col_kind: str  # "iv_points" or "hours"
    pnl: FloatArray  # rupees, shape (rows, cols)
    sticky_rule: str
    warnings: tuple[str, ...]


def _base_delta(params: SVIParams, k: FloatArray, t: float) -> FloatArray:
    """Call delta N(d1) of the base smile at log-moneyness ``k`` for the surface maturity ``t``."""
    sig = params.implied_vol(k, t)
    return normal_cdf((-k + 0.5 * sig * sig * t) / (sig * math.sqrt(t)))


@dataclass
class _Group:
    """Legs of one expiry: their positions in the leg arrays and the smile they are valued on."""

    idx: list[int]
    slice: SliceFit
    k_range: tuple[float, float] | None = field(default=None)  # log-moneyness range of the fitted strikes, widened


class WhatIfEngine:
    def __init__(
        self,
        surface: SurfaceSnapshot,
        legs: Sequence[Leg],
        expiry_instants: Mapping[str, datetime],
        as_of: datetime | None = None,
        cfg: WhatIfConfig = DEFAULT_WHATIF,
        pcfg: PricingConfig = DEFAULT,
    ) -> None:
        if cfg.default_sticky not in STICKY_RULES:
            raise ValueError(f"unknown sticky rule {cfg.default_sticky!r}")
        self.surface, self.legs, self.cfg, self.pcfg = surface, tuple(legs), cfg, pcfg
        self.as_of = as_of or surface.as_of
        if self.as_of.tzinfo is None:
            raise ValueError("as_of must be timezone-aware")
        n = len(self.legs)
        self.strike = np.array([lg.strike for lg in self.legs], dtype=np.float64)
        self.cp = np.array([lg.cp for lg in self.legs], dtype=np.float64)
        self.mult = np.array([lg.quantity * lg.lot_size for lg in self.legs], dtype=np.float64)
        self.fwd0 = np.full(n, np.nan)
        self.rate0 = np.full(n, np.nan)
        self.t0 = np.full(n, np.nan)
        self.ok = np.zeros(n, dtype=bool)
        self.status = ["ok"] * n
        self.groups: dict[str, _Group] = {}
        for i, lg in enumerate(self.legs):
            try:
                sl = surface.slice(lg.expiry)
            except KeyError:
                self.status[i] = "expiry not on the surface"
                continue
            inst = expiry_instants.get(lg.expiry)
            if inst is None:
                self.status[i] = "no expiry instant"
                continue
            if sl.params is None or not math.isfinite(sl.forward):
                self.status[i] = "no fitted smile for the expiry"
                continue
            self.fwd0[i], self.rate0[i] = sl.forward, sl.rate
            self.t0[i] = years_between(self.as_of, inst, pcfg)
            self.ok[i] = True
            self.groups.setdefault(lg.expiry, _Group([], sl)).idx.append(i)
        self.sigma0 = self._surface_vol(np.log(self.strike / self.fwd0)) if n else np.zeros(0)
        self.value0 = np.where(self.ok, black76(self.cp, self.fwd0, self.strike, self.t0, self.sigma0, self.rate0, pcfg), np.nan)

    # ------------------------------------------------------------------ the smile
    def _surface_vol(self, k: FloatArray) -> FloatArray:
        """Annualised volatility of each leg from its expiry's fitted smile at log-moneyness ``k`` (last axis = legs)."""
        out = np.full(k.shape, np.nan)
        for g in self.groups.values():
            assert g.slice.params is not None
            out[..., g.idx] = g.slice.params.implied_vol(k[..., g.idx], g.slice.t_years)
        return out

    def _k_range(self, g: _Group) -> tuple[float, float]:
        """Log-moneyness range of the strikes the expiry's smile was fitted on, widened by ``delta_range_pad``."""
        if g.k_range is None:
            p = g.slice.params
            assert p is not None
            used = [math.log(x.strike / g.slice.forward) for x in self.surface.strikes if x.expiry == g.slice.expiry and x.status == "used"]
            lo, hi = (min(used), max(used)) if used else (p.m - 0.05, p.m + 0.05)
            g.k_range = (lo - self.cfg.delta_range_pad, hi + self.cfg.delta_range_pad)
        return g.k_range

    def _sticky_vol(self, ds: FloatArray, dh: FloatArray, rule: str) -> FloatArray:
        """Volatility of every leg after the shock under ``rule``, shape (S, H, L)."""
        n_s, n_h, n_l = ds.size, dh.size, self.strike.size
        base = np.broadcast_to(self.sigma0, (n_s, n_h, n_l))
        if rule == "strike":
            return np.array(base)
        f = self.fwd0[None, None, :] + ds[:, None, None]
        with np.errstate(invalid="ignore", divide="ignore"):
            k_new = np.log(self.strike[None, None, :] / f)
        by_moneyness = self._surface_vol(np.broadcast_to(k_new, (n_s, n_h, n_l)).copy())
        if rule == "moneyness":
            sig = by_moneyness
        else:  # delta: the smile holds as a function of call delta
            sig = by_moneyness.copy()
            k_all = np.broadcast_to(k_new, (n_s, n_h, n_l))
            t_all = np.broadcast_to(np.maximum(self.t0[None, None, :] - dh[None, :, None] / self._hours_per_year, self.pcfg.t_floor_years), (n_s, n_h, n_l))
            for g in self.groups.values():
                params = g.slice.params
                assert params is not None
                ix = np.array(g.idx)
                kn, tn, ts = k_all[..., ix], t_all[..., ix], g.slice.t_years  # ts: the base smile's maturity
                k_lo, k_hi = self._k_range(g)

                def mismatch(k: FloatArray, kn: FloatArray = kn, tn: FloatArray = tn, ts: float = ts, params: SVIParams = params) -> FloatArray:
                    v = params.implied_vol(k, ts)
                    d_new = (-kn + 0.5 * v * v * tn) / (v * np.sqrt(tn))
                    return _base_delta(params, k, ts) - normal_cdf(d_new)  # zero where the shocked option has the delta the smile gives at k

                k = np.clip(kn, k_lo, k_hi)  # the moneyness solution is the start (and the answer when no time has elapsed)
                for _ in range(self.cfg.delta_newton_iterations):
                    g0 = mismatch(k)
                    if float(np.nanmax(np.abs(g0))) < self.cfg.delta_tol:
                        break
                    h = 1e-6
                    slope = (mismatch(k + h) - mismatch(k - h)) / (2.0 * h)
                    step = np.where(np.abs(slope) > 1e-12, g0 / np.where(np.abs(slope) > 1e-12, slope, 1.0), 0.0)
                    k = np.clip(k - np.clip(step, -0.05, 0.05), k_lo, k_hi)
                sig[..., ix] = params.implied_vol(k, ts)
        unchanged = (ds[:, None, None] == 0.0) & (dh[None, :, None] == 0.0 if rule == "delta" else True)  # nothing that moves the smile moved (time moves it only under sticky delta): the base smile, exactly
        return np.where(unchanged, base, sig)

    @property
    def _hours_per_year(self) -> float:
        return 24.0 * self.pcfg.day_count

    # ------------------------------------------------------------------ valuation over scenario axes
    def _pnl_tensor(self, ds: FloatArray, dv: FloatArray, dh: FloatArray, rule: str, dr: float) -> tuple[FloatArray, FloatArray, FloatArray, FloatArray]:
        """P&L (rupees) over spot shocks ``ds`` (S), volatility shocks ``dv`` (V) and elapsed hours ``dh`` (H): shape (S, V, H), plus the values and the volatilities used, shape (S, V, H, L)."""
        if rule not in STICKY_RULES:
            raise ValueError(f"unknown sticky rule {rule!r}")
        sig_s = self._sticky_vol(ds, dh, rule)  # (S, H, L)
        sig = sig_s[:, None, :, :] + dv[None, :, None, None] / 100.0  # (S, V, H, L)
        fwd = self.fwd0[None, None, None, :] + ds[:, None, None, None]
        t_new = self.t0[None, None, None, :] - dh[None, None, :, None] / self._hours_per_year
        rate = self.rate0[None, None, None, :] + dr
        with np.errstate(invalid="ignore", divide="ignore"):
            val = black76(self.cp[None, None, None, :], fwd, self.strike[None, None, None, :], t_new, sig, rate, self.pcfg)
        same = (ds[:, None, None, None] == 0.0) & (dv[None, :, None, None] == 0.0) & (dh[None, None, :, None] == 0.0) & (dr == 0.0)
        val = np.where(same, self.value0[None, None, None, :], val)  # inputs equal to the base give the base value, by construction
        diff = val - self.value0[None, None, None, :]
        live = self.ok
        pnl = np.sum(np.where(live, self.mult * diff, 0.0), axis=-1)
        bad = np.any(live & ~np.isfinite(diff), axis=-1) | (not bool(self.ok.all()))  # a position with a leg that cannot be valued has no total: missing stays missing
        return np.where(bad, np.nan, pnl), val, sig, fwd

    def _unavailable(self) -> list[str]:
        return [f"leg {i + 1} ({lg.expiry} {lg.strike:g} {'CE' if lg.cp > 0 else 'PE'}): {self.status[i]}" for i, lg in enumerate(self.legs) if not self.ok[i]]

    # ------------------------------------------------------------------ public API
    def run(self, sc: Scenario) -> ScenarioResult:
        """One scenario, leg by leg."""
        rule = sc.sticky_rule or self.cfg.default_sticky
        ds, dv, dh = np.array([sc.spot_shock]), np.array([sc.iv_shock]), np.array([sc.time_elapsed_hours])
        pnl, val, sig, fwd = self._pnl_tensor(ds, dv, dh, rule, sc.rate_shock)
        v, s_new, f_new = val[0, 0, 0], sig[0, 0, 0], fwd[0, 0, 0]
        t_new = self.t0 - sc.time_elapsed_hours / self._hours_per_year
        results: list[LegResult] = []
        partial = 0.0
        for i, lg in enumerate(self.legs):
            if not self.ok[i] or not math.isfinite(v[i]):
                results.append(LegResult(lg.expiry, lg.strike, lg.cp, lg.quantity, self.status[i] if not self.ok[i] else "scenario value undefined", math.nan, math.nan, math.nan, math.nan, math.nan, None))
                continue
            leg_pnl = float(self.mult[i] * (v[i] - self.value0[i]))
            partial += leg_pnl
            vs_entry = None if lg.entry_price is None else float(self.mult[i] * (v[i] - lg.entry_price))
            results.append(LegResult(lg.expiry, lg.strike, lg.cp, lg.quantity, "ok", float(self.sigma0[i]), float(s_new[i]), float(self.value0[i]), float(v[i]), leg_pnl, vs_entry))
        warnings = tuple(self._unavailable())
        fwd_after = {e: float(f_new[g.idx[0]]) for e, g in self.groups.items()}
        t_after = {e: float(t_new[g.idx[0]]) for e, g in self.groups.items()}
        total = float(pnl[0, 0, 0]) if not warnings else math.nan
        return ScenarioResult(sc, self.surface.version_id, self.surface.as_of_ist, total, partial, tuple(results), fwd_after, t_after, warnings)

    def grid_spot_iv(self, spot_shocks: ArrayLike | None = None, iv_shocks: ArrayLike | None = None, rule: str | None = None, hours: float = 0.0, rate_shock: float = 0.0) -> GridResult:
        """Risk matrix: P&L in rupees for every spot shock (rows) and volatility shock (columns), at a fixed elapsed time."""
        ds = self.default_spot_axis() if spot_shocks is None else np.asarray(spot_shocks, dtype=np.float64)
        dv = np.linspace(-self.cfg.grid_iv_range_pts, self.cfg.grid_iv_range_pts, self.cfg.grid_iv_points) if iv_shocks is None else np.asarray(iv_shocks, dtype=np.float64)
        rule = rule or self.cfg.default_sticky
        pnl, *_ = self._pnl_tensor(ds, dv, np.array([hours]), rule, rate_shock)
        return GridResult(self.surface.version_id, self.surface.as_of_ist, tuple(float(x) for x in ds), tuple(float(x) for x in dv), "iv_points", pnl[:, :, 0], rule, tuple(self._unavailable()))

    def grid_spot_time(self, spot_shocks: ArrayLike | None = None, hours: ArrayLike | None = None, rule: str | None = None, iv_shock: float = 0.0, rate_shock: float = 0.0) -> GridResult:
        """P&L in rupees for every spot shock (rows) and elapsed time in hours (columns); the default time axis runs from now to the nearest expiry in 21 steps."""
        ds = self.default_spot_axis() if spot_shocks is None else np.asarray(spot_shocks, dtype=np.float64)
        dh = np.linspace(0.0, self.hours_to_nearest_expiry(), self.cfg.grid_iv_points) if hours is None else np.asarray(hours, dtype=np.float64)
        rule = rule or self.cfg.default_sticky
        pnl, *_ = self._pnl_tensor(ds, np.array([iv_shock]), dh, rule, rate_shock)
        return GridResult(self.surface.version_id, self.surface.as_of_ist, tuple(float(x) for x in ds), tuple(float(x) for x in dh), "hours", pnl[:, 0, :], rule, tuple(self._unavailable()))

    def payoff_at_expiry(self, spot_shocks: ArrayLike | None = None, rule: str | None = None) -> GridResult:
        """P&L in rupees against the current value if the index ends at each level at the NEAREST expiry (legs of later expiries are valued then, on the same sticky rule); one column."""
        ds = self.default_spot_axis() if spot_shocks is None else np.asarray(spot_shocks, dtype=np.float64)
        rule = rule or self.cfg.default_sticky
        pnl, *_ = self._pnl_tensor(ds, np.array([0.0]), np.array([self.hours_to_nearest_expiry()]), rule, 0.0)
        return GridResult(self.surface.version_id, self.surface.as_of_ist, tuple(float(x) for x in ds), (self.hours_to_nearest_expiry(),), "hours", pnl[:, 0, :], rule, tuple(self._unavailable()))

    # ------------------------------------------------------------------ axes and presets
    def hours_to_nearest_expiry(self) -> float:
        t = self.t0[self.ok]
        return float(np.min(t)) * self._hours_per_year if t.size else 0.0

    def nearest_atm(self) -> tuple[float, float, float] | None:
        """(forward, ATM volatility, time to expiry in years) of the nearest expiry among the valued legs, or None."""
        if not self.ok.any():
            return None
        i = int(np.nanargmin(np.where(self.ok, self.t0, np.nan)))
        sl = self.surface.slice(self.legs[i].expiry)
        return float(self.fwd0[i]), float(sl.iv(0.0)), float(self.t0[i])

    def default_spot_axis(self) -> FloatArray:
        atm = self.nearest_atm()
        if atm is None:
            return np.linspace(-1.0, 1.0, self.cfg.grid_spot_points)
        f, s, t = atm
        half = self.cfg.grid_spot_sd * f * s * math.sqrt(max(t, 0.0))
        return np.linspace(-half, half, self.cfg.grid_spot_points)

    def presets(self) -> dict[str, Scenario]:
        """The standard scenarios, sized from the position's nearest expiry (see ``presets_for``)."""
        atm = self.nearest_atm()
        if atm is None:
            return {}
        f, s, t = atm
        return presets_for(f, s, t, self.hours_to_nearest_expiry(), self.cfg)


EXPIRY_CLOCK_PRESETS: tuple[tuple[str, float], ...] = (("expiry_minus_3h", 3.0), ("expiry_minus_1h", 1.0), ("expiry_minus_15m", 0.25))


def presets_for(forward: float, atm_vol: float, t_years: float, hours_to_expiry: float, cfg: WhatIfConfig = DEFAULT_WHATIF, rule: str | None = None) -> dict[str, Scenario]:
    """Named scenarios: gap down 2 %, IV spike +5, the one and two standard deviation bands (sigma_atm sqrt(T) F points either way), and the expiry-day crush (the clock moved to one hour before the
    expiry instant with four volatility points lost: a convention, configurable)."""
    rule = rule or cfg.default_sticky
    sd = forward * atm_vol * math.sqrt(max(t_years, 0.0))
    out = {
        "gap_down": Scenario(spot_shock=-cfg.gap_down_pct / 100.0 * forward, sticky_rule=rule),
        "iv_spike": Scenario(iv_shock=cfg.iv_spike_pts, sticky_rule=rule),
        "expiry_crush": Scenario(iv_shock=-cfg.crush_pts, time_elapsed_hours=max(hours_to_expiry - cfg.crush_hours_before_expiry, 0.0), sticky_rule=rule),
    }
    for key, left_h in EXPIRY_CLOCK_PRESETS:  # time only: the clock moves to this long before the expiry instant, nothing else changes (skipped when already closer)
        if hours_to_expiry > left_h:
            out[key] = Scenario(time_elapsed_hours=hours_to_expiry - left_h, sticky_rule=rule)
    for n in (1, 2):
        out[f"sd_plus_{n}"] = Scenario(spot_shock=n * sd, sticky_rule=rule)
        out[f"sd_minus_{n}"] = Scenario(spot_shock=-n * sd, sticky_rule=rule)
    return out


def expiry_instant(expiry_date: str, close: tuple[int, int]) -> datetime:
    """The instant a contract stops trading: its expiry date at the session close (hour, minute) IST. The close comes from the session schedule, never a fixed 15:30."""
    y, m, d = (int(x) for x in expiry_date.split("-"))
    return datetime(y, m, d, close[0], close[1], tzinfo=IST)


__all__ = ["DEFAULT_WHATIF", "STICKY_RULES", "GridResult", "Leg", "LegResult", "Scenario", "ScenarioResult", "WhatIfConfig", "WhatIfEngine", "expiry_instant", "presets_for"]
