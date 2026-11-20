"""Portfolio risk: the Greeks of a set of option legs, per leg, per expiry and in total, in raw and rupee terms, beta-weighted to NIFTY, checked against configured limits.

Every leg is valued on the same surface and at the same instant as the What-If engine (this module reuses ``WhatIfEngine``'s base state: forward, time to the expiry instant, model volatility), so Greeks and
scenario P&L describe one and the same position. A leg's Greeks per unit depend only on (surface version, as-of time, expiry, strike, side), so they are kept in an LRU cache and a rebuilt surface (a new
version id) never meets a stale entry.

Units. ``raw`` is the model's own units times lot size times signed quantity: delta in units of the forward (the same as rupees per point, the index point being worth one rupee a unit), gamma in units per point,
vega per 1.00 of volatility, theta and rho per year. ``rupee`` is the conventional reading: delta and gamma in rupees per point and per point squared, vega in rupees per volatility point, theta in rupees per calendar
day, per calendar hour and per trading hour, rho per 1 % of rate, the higher orders in the matching units, and ``gamma_pnl_1pct`` the convexity P&L of a 1 % move. Long positions are positive, shorts negative.

Beta weighting converts the delta to NIFTY-equivalent units: ``beta * delta * (price of the underlying / price of NIFTY)``. For index options on NIFTY itself both factors are 1 (documented, configurable): ``beta``
comes from the configuration, or from a provider function (a hook for a future source), and an underlying with no beta falls back to ``default_beta`` with a warning.

Limits are configuration, never code: per leg, per expiry bucket and for the portfolio, each an absolute maximum (theta is a floor on the decay paid per day). A value at or above ``warn_fraction`` of its limit is a
warning, above the limit a breach. A position with a leg that cannot be valued has no complete total (NaN, with the partial sum beside it); limits are then checked on the legs that could be valued and say so.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, fields
from datetime import datetime

import numpy as np

from app.risk.cache import CacheStats, LruCache
from app.risk.greeks import (
    DEFAULT_GREEKS,
    GreeksConfig,
    HigherOrder,
    ScaledGreeks,
    greeks,
    higher_order,
    in_rupees,
    scale,
)
from app.risk.ivsurface import SurfaceSnapshot
from app.risk.pricing import DEFAULT, PricingConfig
from app.risk.whatif import Leg, WhatIfConfig, WhatIfEngine

RAW_FIELDS = ("delta", "gamma", "vega", "theta", "rho", "vanna", "charm", "vomma", "veta", "speed", "color", "zomma", "ultima")
SCALED_FIELDS = tuple(f.name for f in fields(ScaledGreeks))
LIMIT_METRICS = ("delta", "gamma", "vega", "theta_day", "quantity")


@dataclass(frozen=True)
class LimitSet:
    """Absolute maxima (rupee terms); None means no limit. ``theta_day`` is the largest decay paid per day tolerated (a floor on theta: positive theta is not limited); ``quantity`` is lots."""

    delta: float | None = None
    gamma: float | None = None
    vega: float | None = None
    theta_day: float | None = None
    quantity: float | None = None


@dataclass(frozen=True)
class PortfolioConfig:
    leg: LimitSet = field(default_factory=LimitSet)
    bucket: LimitSet = field(default_factory=LimitSet)
    portfolio: LimitSet = field(default_factory=LimitSet)
    beta_weighted_delta: float | None = None  # absolute maximum of the beta-weighted rupee delta
    warn_fraction: float = 0.8
    beta: Mapping[str, float] = field(default_factory=lambda: {"NIFTY": 1.0})
    default_beta: float = 1.0  # used (with a warning) for an underlying with no beta
    third_order: bool = True
    cache_size: int = 4096

    @classmethod
    def from_mapping(cls, d: Mapping[str, object]) -> PortfolioConfig:
        """Build from a plain mapping (JSON, environment, a settings file). Unknown keys and negative limits are errors, so a typo cannot silently disable a limit."""
        allowed = {"leg", "bucket", "portfolio", "beta_weighted_delta", "warn_fraction", "beta", "default_beta", "third_order", "cache_size"}
        unknown = set(d) - allowed
        if unknown:
            raise ValueError(f"unknown portfolio config keys: {sorted(unknown)}")

        def limits(x: object) -> LimitSet:
            if x is None:
                return LimitSet()
            if not isinstance(x, Mapping):
                raise ValueError("a limit set must be a mapping")
            bad = set(x) - set(LIMIT_METRICS)
            if bad:
                raise ValueError(f"unknown limit metrics: {sorted(bad)}")
            vals = {k: (None if v is None else float(v)) for k, v in x.items()}
            if any(v is not None and (v < 0 or not math.isfinite(v)) for v in vals.values()):
                raise ValueError("limits are non-negative numbers")
            return LimitSet(**vals)

        bw = d.get("beta_weighted_delta")
        if bw is not None and (float(bw) < 0 or not math.isfinite(float(bw))):  # type: ignore[arg-type]
            raise ValueError("limits are non-negative numbers")
        wf = float(d.get("warn_fraction", 0.8))  # type: ignore[arg-type]
        if not 0.0 < wf <= 1.0:
            raise ValueError("warn_fraction must be in (0, 1]")
        beta = d.get("beta")
        if beta is not None and not isinstance(beta, Mapping):
            raise ValueError("beta must be a mapping of underlying to beta")
        return cls(
            leg=limits(d.get("leg")), bucket=limits(d.get("bucket")), portfolio=limits(d.get("portfolio")),
            beta_weighted_delta=None if bw is None else float(bw),  # type: ignore[arg-type]
            warn_fraction=wf, beta={str(k): float(v) for k, v in (beta or {"NIFTY": 1.0}).items()},
            default_beta=float(d.get("default_beta", 1.0)),  # type: ignore[arg-type]
            third_order=bool(d.get("third_order", True)), cache_size=int(d.get("cache_size", 4096)),  # type: ignore[call-overload]
        )  # fmt: skip


DEFAULT_PORTFOLIO = PortfolioConfig()


@dataclass(frozen=True)
class UnitGreeks:
    """The Greeks of one contract per unit (immutable, cached)."""

    iv: float
    value: float
    forward: float
    t_years: float
    intrinsic: bool
    raw: tuple[float, ...]  # RAW_FIELDS order
    scaled: tuple[float, ...]  # SCALED_FIELDS order
    third_ok: bool
    third_noisy: bool


@dataclass(frozen=True)
class LegRisk:
    expiry: str
    strike: float
    cp: float
    quantity: float
    lot_size: int
    status: str
    iv: float
    value: float
    forward: float
    t_years: float
    intrinsic: bool
    third_order_ok: bool
    third_order_noisy: bool
    rupee: Mapping[str, float]  # RupeeGreeks field names; NaN where the leg could not be valued


@dataclass(frozen=True)
class NetGreeks:
    raw: Mapping[str, float]
    rupee: Mapping[str, float]


@dataclass(frozen=True)
class Bucket:
    expiry: str
    label: str  # "front" (nearest expiry), "next", "later"
    hours_to_expiry: float
    n_legs: int
    net: NetGreeks


@dataclass(frozen=True)
class Breach:
    scope: str  # "leg", "bucket", "portfolio"
    scope_id: str
    metric: str
    value: float
    limit: float
    utilisation: float  # |value| / limit (decay paid / limit for theta)
    level: str  # "warn" (at or above warn_fraction) or "breach" (above the limit)
    partial: bool  # evaluated on the legs that could be valued only


@dataclass(frozen=True)
class PortfolioRisk:
    surface_version_id: str
    as_of_ist: str
    complete: bool
    legs: tuple[LegRisk, ...]
    net: NetGreeks  # NaN everywhere when a leg could not be valued
    partial_net: NetGreeks  # over the legs that could be valued
    buckets: tuple[Bucket, ...]
    beta: float
    beta_source: str
    beta_weighted_delta_units: float
    beta_weighted_delta_rupees: float  # rupees per 1-point move of NIFTY, beta-weighted
    delta_rupees_per_1pct: float  # unweighted delta times 1 % of the forward
    breaches: tuple[Breach, ...]
    warnings: tuple[str, ...]
    cache: CacheStats


class PortfolioRiskEngine:
    """Aggregates leg Greeks; owns the LRU cache of per-unit Greeks."""

    def __init__(self, cfg: PortfolioConfig = DEFAULT_PORTFOLIO, gcfg: GreeksConfig = DEFAULT_GREEKS, pcfg: PricingConfig = DEFAULT) -> None:
        self.cfg, self.gcfg, self.pcfg = cfg, gcfg, pcfg
        self.cache: LruCache[tuple[str, str, str, float, float], UnitGreeks] = LruCache(cfg.cache_size)

    # ------------------------------------------------------------------ per-unit Greeks
    def _unit(self, eng: WhatIfEngine, idx: Sequence[int]) -> dict[int, UnitGreeks]:
        """Per-unit Greeks of the legs at ``idx`` (all valued), computed in one vectorised pass."""
        ix = np.array(idx)
        cp, f, k, t, s, r = eng.cp[ix], eng.fwd0[ix], eng.strike[ix], eng.t0[ix], eng.sigma0[ix], eng.rate0[ix]
        g = greeks(cp, f, k, t, s, r, self.pcfg)
        if self.cfg.third_order:
            h = higher_order(cp, f, k, t, s, r, self.pcfg, self.gcfg)
        else:
            nan = np.full(ix.size, np.nan)
            h = HigherOrder(nan, nan, nan, nan, np.zeros(ix.size, dtype=bool), np.ones(ix.size, dtype=bool))
        sc = scale(g, h, self.gcfg)
        out: dict[int, UnitGreeks] = {}
        for j, i in enumerate(idx):
            raw = tuple(float(getattr(g, n)[j]) if n in ("delta", "gamma", "vega", "theta", "rho", "vanna", "charm", "vomma", "veta") else float(getattr(h, n)[j]) for n in RAW_FIELDS)
            scaled = tuple(float(getattr(sc, n)[j]) for n in SCALED_FIELDS)
            out[i] = UnitGreeks(float(s[j]), float(g.price[j]), float(f[j]), float(t[j]), bool(g.intrinsic[j]), raw, scaled, not bool(h.unavailable[j]), bool(h.noisy[j]))
        return out

    def _legs(self, eng: WhatIfEngine, key_prefix: tuple[str, str]) -> dict[int, UnitGreeks]:
        have: dict[int, UnitGreeks] = {}
        miss: list[int] = []
        for i, leg in enumerate(eng.legs):
            if not eng.ok[i]:
                continue
            key = (key_prefix[0], key_prefix[1], leg.expiry, leg.strike, leg.cp)
            hit = self.cache.get(key)
            if hit is not None:
                have[i] = hit
            else:
                miss.append(i)
        if miss:
            for i, u in self._unit(eng, miss).items():
                leg = eng.legs[i]
                self.cache.put((key_prefix[0], key_prefix[1], leg.expiry, leg.strike, leg.cp), u)
                have[i] = u
        return have

    # ------------------------------------------------------------------ aggregation
    def aggregate(
        self,
        surface: SurfaceSnapshot,
        legs: Sequence[Leg],
        expiry_instants: Mapping[str, datetime],
        as_of: datetime | None = None,
        underlying: str = "NIFTY",
        beta_provider: Callable[[str], float | None] | None = None,
        whatif_cfg: WhatIfConfig | None = None,
    ) -> PortfolioRisk:
        eng = WhatIfEngine(surface, legs, expiry_instants, as_of, whatif_cfg or WhatIfConfig(), self.pcfg)
        units = self._legs(eng, (surface.version_id, eng.as_of.isoformat()))
        n = len(eng.legs)
        warnings = list(eng._unavailable())  # noqa: SLF001 - the engine's own description of the legs it cannot value
        complete = all(eng.ok)
        m = eng.mult
        rupee_arr: dict[str, np.ndarray] = {}
        raw_arr: dict[str, np.ndarray] = {}
        for j, name in enumerate(RAW_FIELDS):
            raw_arr[name] = np.array([units[i].raw[j] if i in units else np.nan for i in range(n)]) * m
        sc_arr = {name: np.array([units[i].scaled[j] if i in units else np.nan for i in range(n)]) for j, name in enumerate(SCALED_FIELDS)}
        fwd = np.where(eng.ok, eng.fwd0, np.nan)
        lots = np.array([lg.lot_size for lg in eng.legs], dtype=np.float64)
        qty = np.array([lg.quantity for lg in eng.legs], dtype=np.float64)
        rp = in_rupees(ScaledGreeks(**sc_arr), fwd, lots, qty)
        for f in fields(rp):
            rupee_arr[f.name] = getattr(rp, f.name)
        third_ok = np.array([units[i].third_ok if i in units else False for i in range(n)])
        leg_rows: list[LegRisk] = []
        for i, lg in enumerate(eng.legs):
            u = units.get(i)
            leg_rows.append(
                LegRisk(
                    lg.expiry, lg.strike, lg.cp, lg.quantity, lg.lot_size, eng.status[i], math.nan if u is None else u.iv, math.nan if u is None else u.value,
                    math.nan if u is None else u.forward, math.nan if u is None else u.t_years, bool(u.intrinsic) if u else False,
                    bool(third_ok[i]) if self.cfg.third_order else False, bool(u.third_noisy) if u else False, {k: float(v[i]) for k, v in rupee_arr.items()},
                )
            )  # fmt: skip
        third_names = {"speed", "color", "zomma", "ultima"}
        if self.cfg.third_order and eng.ok.any() and not third_ok[eng.ok].all():
            warnings.append("third-order Greeks are unavailable for some legs (too close to the expiry or the volatility limits): their net is missing")

        def net_of(mask: np.ndarray, require_all_third: bool = True) -> NetGreeks:
            def total(a: np.ndarray, third: bool) -> float:
                if not mask.any():
                    return 0.0
                if third and (not self.cfg.third_order or (require_all_third and not third_ok[mask].all())):
                    return math.nan
                return float(np.sum(a[mask]))

            return NetGreeks(
                {k: total(raw_arr[k], k in third_names) for k in RAW_FIELDS},
                {k: total(v, k in third_names) for k, v in rupee_arr.items()},
            )

        valid = eng.ok.copy()
        partial = net_of(valid)
        nan_net = NetGreeks({k: math.nan for k in RAW_FIELDS}, {k: math.nan for k in rupee_arr})
        net = partial if complete else nan_net
        # expiry buckets, nearest first
        order = sorted({lg.expiry for i, lg in enumerate(eng.legs) if eng.ok[i]}, key=lambda e: float(eng.t0[next(i for i, lg in enumerate(eng.legs) if lg.expiry == e and eng.ok[i])]))
        labels = ["front", "next"]
        buckets: list[Bucket] = []
        for rank, e in enumerate(order):
            msk = np.array([lg.expiry == e and eng.ok[i] for i, lg in enumerate(eng.legs)])
            i0 = int(np.argmax(msk))
            buckets.append(Bucket(e, labels[rank] if rank < 2 else "later", float(eng.t0[i0]) * 24.0 * self.pcfg.day_count, int(msk.sum()), net_of(msk)))
        # beta weighting
        beta, beta_source = self._beta(underlying, beta_provider, warnings)
        delta_units = partial.raw["delta"] if complete else math.nan
        bw_partial = beta * partial.raw["delta"]  # for the limit check on the legs that could be valued
        ref_forward = float(np.nanmean(fwd)) if eng.ok.any() else math.nan
        bw_units = beta * delta_units  # the underlying-to-NIFTY price ratio is 1 for NIFTY options
        bw_rupees = bw_units  # the index point is worth one rupee a unit
        per_1pct = delta_units * ref_forward * 0.01 if complete else math.nan
        breaches = self._limits(leg_rows, buckets, partial, bw_partial, not complete)
        return PortfolioRisk(
            surface.version_id, surface.as_of_ist, complete, tuple(leg_rows), net, partial, tuple(buckets), beta, beta_source, bw_units, bw_rupees, per_1pct,
            tuple(breaches), tuple(warnings), self.cache.stats(),
        )  # fmt: skip

    def _beta(self, underlying: str, provider: Callable[[str], float | None] | None, warnings: list[str]) -> tuple[float, str]:
        if provider is not None:
            b = provider(underlying)
            if b is not None and math.isfinite(b):
                return float(b), "provider"
        if underlying in self.cfg.beta:
            return float(self.cfg.beta[underlying]), "config"
        warnings.append(f"no beta for {underlying}: {self.cfg.default_beta:g} assumed")
        return self.cfg.default_beta, "default"

    # ------------------------------------------------------------------ limits
    def _limits(self, legs: Sequence[LegRisk], buckets: Sequence[Bucket], net: NetGreeks, bw_delta: float, partial: bool) -> list[Breach]:
        out: list[Breach] = []
        wf = self.cfg.warn_fraction

        def check(scope: str, scope_id: str, metric: str, value: float, limit: float | None, part: bool) -> None:
            if limit is None or not math.isfinite(value):
                return
            used = (max(-value, 0.0) if metric == "theta_day" else abs(value))  # theta: only decay paid counts
            ratio = used / limit if limit > 0 else (math.inf if used > 0 else 0.0)
            if ratio > 1.0:
                out.append(Breach(scope, scope_id, metric, value, limit, ratio, "breach", part))
            elif ratio >= wf:
                out.append(Breach(scope, scope_id, metric, value, limit, ratio, "warn", part))

        for lg in legs:
            if lg.status != "ok":
                continue
            lid = f"{lg.expiry} {lg.strike:g} {'CE' if lg.cp > 0 else 'PE'}"
            for metric in ("delta", "gamma", "vega", "theta_day"):
                check("leg", lid, metric, lg.rupee[metric], getattr(self.cfg.leg, metric), False)
            check("leg", lid, "quantity", lg.quantity, self.cfg.leg.quantity, False)
        for b in buckets:
            for metric in ("delta", "gamma", "vega", "theta_day"):
                check("bucket", f"{b.expiry} ({b.label})", metric, b.net.rupee[metric], getattr(self.cfg.bucket, metric), False)
        for metric in ("delta", "gamma", "vega", "theta_day"):
            check("portfolio", "portfolio", metric, net.rupee[metric], getattr(self.cfg.portfolio, metric), partial)
        check("portfolio", "portfolio", "beta_weighted_delta", bw_delta, self.cfg.beta_weighted_delta, partial)
        out.sort(key=lambda b: -b.utilisation)
        return out
