"""The implied-volatility surface: quotes in, an immutable, versioned, arbitrage-checked SVI surface out.

Per expiry:
  1. Each quote becomes a price. A book (bid and ask) is judged as it is: no bid, no ask, a crossed book or a spread wider than ``spread_threshold_pct`` of the mid is REJECTED with its reason (a stale
     last price is never used to override a bad book). Only a quote with no book at all falls back to the last traded price, labelled ``ltp`` and given a lower fit weight; a last price older than
     ``ltp_max_age_s`` is rejected as stale. The price is the mid, ``(bid + ask) / 2``, never the last price, whenever a book exists.
  2. The price is inverted to a volatility with Brent's method (``ivsolve``). No time value, a price above the bound and a price below ``min_price`` are rejected with their reasons.
  3. One volatility per strike is kept: the out-of-the-money side (call at or above the forward, put below). The in-the-money side is used only when the chain has no out-of-the-money quote at that
     strike at all; if the out-of-the-money quote exists and was rejected the strike is dropped, because an in-the-money price is nearly all intrinsic value.
  4. The kept prices, converted to calls by put-call parity, are tested for arbitrage: vertical spread bounds (call price non-increasing in strike with slope between -df and 0) and butterfly convexity.
     A strike that fails is FLAGGED with its reason, listed in the output and left out of the fit: nothing is smoothed away silently.
  5. A raw SVI smile is fitted (``svi``) with butterfly and calendar constraints. The residuals in volatility points are reported per strike; the expiry is marked ``degraded`` (never hidden) when the
     RMS residual exceeds ``degraded_rms_vol_pts`` (0.5), the largest exceeds ``degraded_max_vol_pts``, the density is negative anywhere on the check grid, the calendar condition fails, or there are too few points.

The surface is an immutable ``SurfaceSnapshot`` with a ``version_id`` ("v<sequence>-<content hash>"): the hash is of the inputs and the configuration only, so the same quotes always give the same hash and
every downstream number can name the surface it came from. ``RebuildScheduler`` decides when a rebuild is worth doing (enough strikes changed, or the maximum interval passed with something changed).

Inputs are neutral dataclasses (``Quote``, ``ExpiryInput``); an adapter in the service layer fills them from the application's chain snapshots and live ticks.
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
from numpy.typing import ArrayLike, NDArray

from app.risk.greeks import greeks
from app.risk.ivsolve import implied_vol
from app.risk.pricing import DEFAULT, PricingConfig
from app.risk.svi import SVIFit, SVIParams, calendar_violation, fit_svi

IST = ZoneInfo("Asia/Kolkata")
FloatArray = NDArray[np.float64]
CALL, PUT = 1.0, -1.0


@dataclass(frozen=True)
class SurfaceConfig:
    """Everything the surface builder decides by a number. Defaults are the working values; the application config overrides them."""

    spread_threshold_pct: float = 15.0  # a spread above this percentage of the mid rejects the quote
    allow_ltp_fallback: bool = True  # a quote with no bid and no ask at all may use its last traded price (labelled, lower weight)
    ltp_max_age_s: float = 600.0  # a last traded price older than this is stale
    ltp_weight: float = 0.5  # fit weight of a last-price point relative to a mid point
    min_price: float = 0.05  # rupees: one tick; below this a price carries no volatility information
    arb_tol: float = 0.05  # rupees: slack of the vertical and butterfly checks (one tick)
    min_points: int = 7  # least number of points for a five-parameter fit
    degraded_rms_vol_pts: float = 0.5  # RMS fit residual above this marks the expiry degraded
    degraded_max_vol_pts: float = 2.0  # so does a single residual above this
    calendar_tol: float = 1e-9  # total variance: calendar violations above this mark the expiry degraded
    forward_strikes: int = 3  # strikes nearest the money whose parity forwards are averaged (median) when no forward is supplied
    rebuild_min_changed: int = 10  # rebuild when at least this many strikes changed ...
    rebuild_max_interval_s: float = 0.3  # ... or when this long has passed since the last rebuild and something changed


DEFAULT_SURFACE = SurfaceConfig()


@dataclass(frozen=True)
class Quote:
    """One option quote. ``cp`` is +1 for a call and -1 for a put; a missing field is None (never zero)."""

    strike: float
    cp: float
    bid: float | None = None
    ask: float | None = None
    ltp: float | None = None
    ltp_age_s: float | None = None  # age of the last traded price, when known


@dataclass(frozen=True)
class ExpiryInput:
    expiry: str  # ISO date of the expiry
    t_years: float  # time to the expiry instant (ACT/365)
    rate: float
    quotes: tuple[Quote, ...]
    forward: float | None = None  # when None it is estimated from put-call parity


@dataclass(frozen=True)
class StrikeIV:
    expiry: str
    strike: float
    cp: float
    price: float  # NaN when rejected before a price was formed
    source: str  # "mid", "ltp" or "none"
    iv: float  # market implied volatility, NaN when none
    status: str  # "used", "unused" (the other side was kept), "rejected" or "flagged"
    reason: str | None
    fit_iv: float  # the SVI value at this strike, NaN when no fit
    residual_vol_pts: float  # market minus fit, volatility points, NaN when no fit or no market volatility
    weight: float


@dataclass(frozen=True)
class SliceFit:
    expiry: str
    t_years: float
    forward: float
    rate: float
    forward_source: str  # "supplied" or "parity(n)"
    params: SVIParams | None
    n_quotes: int
    n_used: int
    n_rejected: int
    n_flagged: int
    rms_vol_pts: float
    max_vol_pts: float
    min_density: float
    butterfly_ok: bool
    calendar_ok: bool
    calendar_max_violation: float
    degraded: bool
    degraded_reason: str | None

    def iv(self, log_moneyness: ArrayLike) -> FloatArray:
        """Fitted implied volatility at log-moneyness k = ln(K / F) (NaN when the expiry has no fit)."""
        k = np.asarray(log_moneyness, dtype=np.float64)
        if self.params is None:
            return np.full_like(k, np.nan)
        return self.params.implied_vol(k, self.t_years)


@dataclass(frozen=True)
class SurfaceSnapshot:
    version_id: str
    content_hash: str
    seq: int
    as_of: datetime
    config: SurfaceConfig
    slices: tuple[SliceFit, ...]
    strikes: tuple[StrikeIV, ...]
    pricing: PricingConfig = field(default=DEFAULT)

    @property
    def as_of_ist(self) -> str:
        return self.as_of.astimezone(IST).isoformat(timespec="seconds")

    def slice(self, expiry: str) -> SliceFit:
        for s in self.slices:
            if s.expiry == expiry:
                return s
        raise KeyError(expiry)

    def iv(self, expiry: str, log_moneyness: ArrayLike) -> FloatArray:
        return self.slice(expiry).iv(log_moneyness)


# ------------------------------------------------------------------ quotes to prices
def _num(x: float | None) -> float | None:
    return x if x is not None and math.isfinite(x) else None


def quote_price(q: Quote, cfg: SurfaceConfig) -> tuple[float | None, str, float, str | None]:
    """(price, source, weight, rejection reason) of one quote: the mid of a sound book, the last price only when there is no book at all."""
    bid, ask, ltp = _num(q.bid), _num(q.ask), _num(q.ltp)
    if bid is not None or ask is not None:  # a book exists: judge it, never replace it with a last price
        if bid is None or bid <= 0.0:
            return None, "none", 0.0, "no bid"
        if ask is None or ask <= 0.0:
            return None, "none", 0.0, "no ask"
        if bid > ask:
            return None, "none", 0.0, "crossed book"
        mid = 0.5 * (bid + ask)
        if (ask - bid) / mid * 100.0 > cfg.spread_threshold_pct:
            return None, "none", 0.0, f"spread above {cfg.spread_threshold_pct:g}% of the mid"
        price, source, weight = mid, "mid", 1.0
    elif cfg.allow_ltp_fallback and ltp is not None and ltp > 0.0:
        if q.ltp_age_s is not None and q.ltp_age_s > cfg.ltp_max_age_s:
            return None, "none", 0.0, "stale last price"
        price, source, weight = ltp, "ltp", cfg.ltp_weight
    else:
        return None, "none", 0.0, "no quote"
    if price < cfg.min_price:
        return None, "none", 0.0, "price below the minimum"
    return price, source, weight, None


def parity_forward(
    prices: Mapping[tuple[float, float], float], t_years: float, rate: float, n: int = 3
) -> tuple[float, int] | None:
    """Forward from put-call parity, F = K + (C - P) / df, as the median over the ``n`` strikes where call and put prices are closest (at the money). None when no strike has both sides."""
    df = math.exp(-rate * t_years)
    both = sorted({k for (k, cp) in prices if cp == CALL} & {k for (k, cp) in prices if cp == PUT})
    if not both:
        return None
    gaps = sorted((abs(prices[(k, CALL)] - prices[(k, PUT)]), k) for k in both)[:n]
    est = [k + (prices[(k, CALL)] - prices[(k, PUT)]) / df for _, k in gaps]
    return float(np.median(est)), len(est)


# ------------------------------------------------------------------ no-arbitrage tests on prices
def arbitrage_flags(strikes: Sequence[float], calls: Sequence[float], df: float, tol: float) -> dict[float, str]:
    """Strikes whose (call-equivalent) prices break the vertical-spread bounds or butterfly convexity, with the reason. ``strikes`` ascending."""
    flags: dict[float, str] = {}
    n = len(strikes)
    for i in range(n - 1):
        dk = strikes[i + 1] - strikes[i]
        step = calls[i] - calls[i + 1]  # a call loses value as the strike rises, by at most df dK
        if step < -tol:
            flags.setdefault(strikes[i + 1], "vertical spread: call price rises with the strike")
        elif step > df * dk + tol:
            flags.setdefault(strikes[i + 1], "vertical spread: call price falls faster than the discounted strike gap")
    for i in range(1, n - 1):
        k0, k1, k2 = strikes[i - 1], strikes[i], strikes[i + 1]
        s1 = (calls[i] - calls[i - 1]) / (k1 - k0)
        s2 = (calls[i + 1] - calls[i]) / (k2 - k1)
        if s2 < s1 - tol / min(k1 - k0, k2 - k1):
            flags.setdefault(k1, "butterfly: negative convexity")
    return flags


# ------------------------------------------------------------------ one expiry
@dataclass
class _Row:
    """One quote on its way through a slice (mutable: the reason and the volatility are filled in as the steps run)."""

    q: Quote
    price: float | None
    source: str
    weight: float
    reason: str | None
    iv: float = math.nan


_IV_REASONS = {"no_time_value": "no time value", "above_bound": "price above the bound", "invalid": "invalid inputs", "no_root": "no root"}


def _slice(
    e: ExpiryInput, cfg: SurfaceConfig, pcfg: PricingConfig, near: SVIParams | None, warm: SVIParams | None
) -> tuple[SliceFit, list[StrikeIV], SVIFit | None]:
    rows: list[_Row] = []
    prices: dict[tuple[float, float], float] = {}
    for q in e.quotes:
        price, source, weight, reason = quote_price(q, cfg)
        rows.append(_Row(q, price, source, weight, reason))
        if price is not None:
            prices[(q.strike, q.cp)] = price
    forward, f_source = e.forward, "supplied"
    if forward is None:
        pf = parity_forward(prices, e.t_years, e.rate, cfg.forward_strikes)
        forward, f_source = (pf[0], f"parity({pf[1]})") if pf is not None else (math.nan, "none")
    if not (math.isfinite(forward) and forward > 0.0):
        failed = [StrikeIV(e.expiry, r.q.strike, r.q.cp, math.nan, "none", math.nan, "rejected", r.reason or "no forward", math.nan, math.nan, 0.0) for r in rows]
        empty = SliceFit(e.expiry, e.t_years, math.nan, e.rate, "none", None, len(rows), 0, len(rows), 0, math.nan, math.nan, math.nan, False, True, 0.0, True, "no forward")
        return empty, failed, None
    for r in rows:  # implied volatility of every priced quote
        if r.price is None:
            continue
        res = implied_vol(r.q.cp, r.price, forward, r.q.strike, e.t_years, e.rate, pcfg)
        r.iv = res.iv
        if res.status != "ok":
            r.reason = _IV_REASONS[res.status]
    # one volatility per strike: the out-of-the-money side. The in-the-money side is used only when the chain has no out-of-the-money quote at that strike at all; when the out-of-the-money quote
    # exists but was rejected, the strike is dropped (an in-the-money price is nearly all intrinsic value, so its volatility is dominated by the width of its book)
    sides_present: dict[float, set[float]] = {}
    by_strike: dict[float, list[_Row]] = {}
    for r in rows:
        sides_present.setdefault(r.q.strike, set()).add(r.q.cp)
        if r.reason is None:
            by_strike.setdefault(r.q.strike, []).append(r)
    keep: dict[float, _Row] = {}
    for k, cands in by_strike.items():
        otm = CALL if k >= forward else PUT
        mine = next((c for c in cands if c.q.cp == otm), None)
        if mine is not None:
            keep[k] = mine
        elif otm not in sides_present[k]:
            keep[k] = cands[0]
    unused: set[int] = set()
    for k, cands in by_strike.items():
        for c in cands:
            if k not in keep or c is not keep[k]:
                unused.add(id(c))
                c.reason = "other side kept (out of the money preferred)" if k in keep else "out-of-the-money side rejected: in-the-money price not used"
    df = math.exp(-e.rate * e.t_years)
    ks = sorted(keep)
    calls = [(keep[k].price or 0.0) + (0.0 if keep[k].q.cp == CALL else df * (forward - k)) for k in ks]  # every kept price as a call price, by put-call parity
    flags = arbitrage_flags(ks, calls, df, cfg.arb_tol)
    used = [k for k in ks if k not in flags]
    fit: SVIFit | None = None
    fitted_iv: dict[float, float] = {}
    rms = mx = math.nan
    if len(used) >= cfg.min_points:
        kk = np.log(np.array(used) / forward)
        iv = np.array([keep[k].iv for k in used])
        cp_arr = np.array([keep[k].q.cp for k in used])
        vega = greeks(cp_arr, forward, np.array(used), e.t_years, iv, e.rate, pcfg).vega
        wt = np.array([keep[k].weight for k in used]) * np.maximum(vega / float(np.max(vega)), 0.05)
        fit = fit_svi(kk, iv * iv * e.t_years, wt, near=near, warm=warm)
        fitted = fit.params.implied_vol(kk, e.t_years)
        resid = (iv - fitted) * 100.0
        rms, mx = float(np.sqrt(np.mean(resid**2))), float(np.max(np.abs(resid)))
        fitted_iv = dict(zip(used, (float(x) for x in fitted), strict=True))
    out: list[StrikeIV] = []
    for r in rows:
        k = r.q.strike
        is_kept = keep.get(k) is r
        status, reason = "rejected", r.reason
        if r.price is not None and r.reason is None and is_kept:
            if k in flags:
                status, reason = "flagged", flags[k]
            elif fit is not None:
                status, reason = "used", None
            else:
                reason = "too few points for a fit"
        elif id(r) in unused:
            status = "unused"
        fit_val = math.nan
        if fit is not None and math.isfinite(r.iv):
            if status == "used":
                fit_val = fitted_iv[k]
            elif status in ("flagged", "unused"):
                fit_val = float(fit.params.implied_vol(math.log(k / forward), e.t_years))
        out.append(
            StrikeIV(
                e.expiry, k, r.q.cp, r.price if r.price is not None else math.nan, r.source, r.iv, status, reason, fit_val,
                (r.iv - fit_val) * 100.0 if math.isfinite(r.iv) and math.isfinite(fit_val) else math.nan, r.weight,
            )
        )  # fmt: skip
    n_rej = sum(1 for o in out if o.status == "rejected")
    n_flag = sum(1 for o in out if o.status == "flagged")
    reasons: list[str] = []
    if fit is None:
        reasons.append(f"only {len(used)} usable points (need {cfg.min_points})")
    else:
        if rms > cfg.degraded_rms_vol_pts:
            reasons.append(f"RMS residual {rms:.2f} vol points above {cfg.degraded_rms_vol_pts:g}")
        if mx > cfg.degraded_max_vol_pts:
            reasons.append(f"largest residual {mx:.2f} vol points above {cfg.degraded_max_vol_pts:g}")
        if not fit.butterfly_ok:
            reasons.append(f"negative density (min g {fit.min_density:.3g})")
    sl = SliceFit(
        e.expiry, e.t_years, forward, e.rate, f_source, None if fit is None else fit.params, len(rows), len(used) if fit is not None else 0, n_rej, n_flag, rms, mx,
        math.nan if fit is None else fit.min_density, False if fit is None else fit.butterfly_ok, True, 0.0, bool(reasons), "; ".join(reasons) or None,
    )  # fmt: skip
    return sl, out, fit


def _hash(expiries: Sequence[ExpiryInput], cfg: SurfaceConfig, pcfg: PricingConfig) -> str:
    payload = {
        "expiries": [
            {"expiry": e.expiry, "t": repr(e.t_years), "r": repr(e.rate), "f": None if e.forward is None else repr(e.forward),
             "quotes": [[repr(q.strike), q.cp, q.bid, q.ask, q.ltp, q.ltp_age_s] for q in sorted(e.quotes, key=lambda x: (x.strike, x.cp))]}
            for e in sorted(expiries, key=lambda x: x.expiry)
        ],
        "cfg": asdict(cfg), "pricing": asdict(pcfg),
    }  # fmt: skip
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=repr).encode()).hexdigest()[:12]


def build_surface(
    expiries: Iterable[ExpiryInput],
    as_of: datetime,
    cfg: SurfaceConfig = DEFAULT_SURFACE,
    pcfg: PricingConfig = DEFAULT,
    seq: int = 1,
    previous: SurfaceSnapshot | None = None,
) -> SurfaceSnapshot:
    """Build an immutable surface from the quotes of one or more expiries. ``previous`` supplies warm starts for the fits (the result does not depend on it beyond the optimiser's start)."""
    if as_of.tzinfo is None:
        raise ValueError("as_of must be timezone-aware")
    exps = sorted(expiries, key=lambda e: e.t_years)
    slices: list[SliceFit] = []
    strikes: list[StrikeIV] = []
    near: SVIParams | None = None
    for e in exps:
        warm = None
        if previous is not None:
            warm = next((s.params for s in previous.slices if s.expiry == e.expiry and s.params is not None), None)
        s, rows, fit = _slice(e, cfg, pcfg, near, warm)
        if fit is not None and near is not None:  # calendar condition against the nearer expiry, on the strikes' range widened by 25 % of the forward
            grid = np.linspace(-0.4, 0.4, 161)
            viol = calendar_violation(near, fit.params, grid)
            s = SliceFit(**{**s.__dict__, "calendar_ok": viol <= cfg.calendar_tol, "calendar_max_violation": viol})
            if viol > cfg.calendar_tol:
                extra = f"calendar arbitrage against the nearer expiry (total variance {viol:.3g})"
                s = SliceFit(**{**s.__dict__, "degraded": True, "degraded_reason": "; ".join(x for x in (s.degraded_reason, extra) if x)})
        if fit is not None:
            near = fit.params
        slices.append(s)
        strikes.extend(rows)
    digest = _hash(exps, cfg, pcfg)
    return SurfaceSnapshot(f"v{seq}-{digest}", digest, seq, as_of, cfg, tuple(slices), tuple(strikes), pcfg)


# ------------------------------------------------------------------ when to rebuild
class RebuildScheduler:
    """Debounce: rebuild when at least ``min_changed`` strikes changed, or when ``max_interval_s`` has passed since the last rebuild and anything changed. Never per tick."""

    def __init__(self, min_changed: int, max_interval_s: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.min_changed, self.max_interval_s, self._clock = min_changed, max_interval_s, clock
        self._pending = 0
        self._last: float | None = None

    def note_changes(self, n_changed: int) -> None:
        self._pending += max(0, n_changed)

    def due(self) -> bool:
        if self._pending <= 0:
            return False
        if self._pending >= self.min_changed or self._last is None:
            return True
        return self._clock() - self._last >= self.max_interval_s

    def mark_rebuilt(self) -> None:
        self._pending = 0
        self._last = self._clock()

    @property
    def pending(self) -> int:
        return self._pending


class QuoteBook:
    """The latest quote of every (expiry, strike, side); ``update`` returns how many quotes actually changed."""

    def __init__(self) -> None:
        self._q: dict[tuple[str, float, float], Quote] = {}

    def update(self, expiry: str, quotes: Iterable[Quote]) -> int:
        changed = 0
        for q in quotes:
            key = (expiry, q.strike, q.cp)
            if self._q.get(key) != q:
                self._q[key] = q
                changed += 1
        return changed

    def quotes(self, expiry: str) -> tuple[Quote, ...]:
        return tuple(sorted((q for (e, _, _), q in self._q.items() if e == expiry), key=lambda x: (x.strike, x.cp)))
