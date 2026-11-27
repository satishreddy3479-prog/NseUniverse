"""The service that feeds the risk engines from the application's data: stored chain snapshots, live ticks, the session schedule. Read-only; it never places an order.

For every requested expiry it reads the newest stored chain snapshot and, where the live stream holds a fresh tick with a book (bid and ask) for the same contract, replaces the snapshot's last traded price
by that tick (mid-price volatility needs the book; stored snapshots carry last prices only, so a quote with no book falls back to its last price, labelled, as the surface builder specifies). The surface
is rebuilt only when enough quotes changed or the configured interval passed with something changed (``RebuildScheduler``), never per request, and every rebuild gets the next sequence number.

Time. ``as_of`` is now when any live book was used, otherwise the time of the oldest stored chain: prices and the clock stay consistent for a stored session, and the response says it is stored and how old it is.
The expiry instant of each contract is its expiry date at the F&O session close of the schedule (``default_close``), or the exchange-confirmed close when the expiry is today (``session_close``); lot sizes come
from the chain snapshot, never from a constant.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

import numpy as np

from app.domain.session import default_close, session_close
from app.logging_setup import log_event
from app.risk.greeks import (
    DEFAULT_GREEKS,
    GreeksConfig,
    HigherOrder,
    greeks,
    higher_order,
    in_rupees,
    scale,
)
from app.risk.ivsurface import (
    ExpiryInput,
    Quote,
    QuoteBook,
    RebuildScheduler,
    SurfaceConfig,
    SurfaceSnapshot,
    build_surface,
)
from app.risk.portfolio import PortfolioConfig, PortfolioRiskEngine
from app.risk.pricing import DEFAULT, PricingConfig, years_between
from app.risk.whatif import STICKY_RULES, Leg, WhatIfConfig, WhatIfEngine, expiry_instant
from app.storage.store import SnapshotStore
from app.stream.book import LiveBook

IST = ZoneInfo("Asia/Kolkata")
logger = logging.getLogger(__name__)


class RiskUnavailable(Exception):
    """The surface cannot be built (no stored chain, bad configuration); carries a machine code and a message for the API."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


@dataclass(frozen=True)
class RiskSettings:
    """Everything the service decides by a number; filled from the application settings."""

    rate: float = 0.07
    spread_threshold_pct: float = 15.0
    allow_ltp_fallback: bool = True
    rebuild_interval_s: float = 1.0
    rebuild_min_changed: int = 10
    default_sticky: str = "moneyness"
    max_legs: int = 60
    stale_after_s: float = 300.0  # a stored chain older than this is reported as stale
    live_max_age_s: float = 30.0  # a live tick older than this is not used
    portfolio: PortfolioConfig = field(default_factory=PortfolioConfig)
    config_error: str | None = None


@dataclass(frozen=True)
class ExpiryData:
    expiry: str
    status: str  # "ok" or why the expiry has no data
    snapshot_id: str | None
    snapshot_at_ist: str | None
    age_s: float | None
    stale: bool
    quotes: int
    live_books: int  # quotes priced from a live bid and ask
    lot_size: int | None
    expiry_instant_ist: str | None


@dataclass(frozen=True)
class SurfaceBundle:
    surface: SurfaceSnapshot
    data: tuple[ExpiryData, ...]
    instants: dict[str, datetime]
    lot_sizes: dict[str, int]
    source: str  # "live" when any quote came from the stream's book, otherwise "stored"
    built_at: datetime


class RiskService:
    def __init__(
        self,
        store: SnapshotStore,
        underlying: str,
        book: Callable[[], LiveBook | None],
        cfg: RiskSettings,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        pcfg: PricingConfig = DEFAULT,
        gcfg: GreeksConfig = DEFAULT_GREEKS,
    ) -> None:
        self.store, self.underlying, self._book, self.cfg, self._clock, self.pcfg, self.gcfg = store, underlying, book, cfg, clock, pcfg, gcfg
        self.surface_cfg = SurfaceConfig(
            spread_threshold_pct=cfg.spread_threshold_pct, allow_ltp_fallback=cfg.allow_ltp_fallback, rebuild_min_changed=cfg.rebuild_min_changed, rebuild_max_interval_s=cfg.rebuild_interval_s
        )
        self.portfolio = PortfolioRiskEngine(cfg.portfolio, gcfg, pcfg)
        self._lock = threading.Lock()
        self._quotes = QuoteBook()
        self._sched = RebuildScheduler(cfg.rebuild_min_changed, cfg.rebuild_interval_s)
        self._bundle: SurfaceBundle | None = None
        self._expiries: set[str] = set()
        self._seq = 0
        self.rebuilds = 0

    # ------------------------------------------------------------------ inputs
    def _expiry_instant(self, expiry: str, today: date) -> datetime:
        close = session_close() if date.fromisoformat(expiry) == today else default_close(date.fromisoformat(expiry))
        return expiry_instant(expiry, (close.hour, close.minute))

    def _read(self, expiry: str, now: datetime) -> tuple[ExpiryData, tuple[Quote, ...], datetime | None, int | None]:
        snap = self.store.latest(self.underlying, expiry)
        today = now.astimezone(IST).date()
        inst = self._expiry_instant(expiry, today)
        if snap is None or not snap.rows:
            return ExpiryData(expiry, "no stored chain", None, None, None, True, 0, 0, None, inst.isoformat()), (), None, None
        lot = int(snap.lot_size) if snap.lot_size else None
        book = self._book()
        quotes: list[Quote] = []
        live = 0
        for row in snap.rows:
            for q, cp in ((row.call, 1.0), (row.put, -1.0)):
                if q is None:
                    continue
                bid = ask = None
                ltp, age = q.ltp, None
                tick = None if book is None or not q.exchange_segment or not q.instrument_token else book.get(f"{q.exchange_segment}|{q.instrument_token}")
                if tick is not None and (now - tick.received_at).total_seconds() <= self.cfg.live_max_age_s:
                    if tick.bid is not None or tick.ask is not None:
                        bid, ask = tick.bid, tick.ask
                        live += 1
                    if tick.ltp is not None:
                        ltp, age = tick.ltp, (now - tick.received_at).total_seconds()
                quotes.append(Quote(row.strike, cp, bid, ask, ltp, age))
        age_s = (now - snap.retrieved_at).total_seconds()
        data = ExpiryData(expiry, "ok", snap.snapshot_id, snap.retrieved_at.astimezone(IST).isoformat(timespec="seconds"), age_s, age_s > self.cfg.stale_after_s, len(quotes), live, lot, inst.isoformat())
        return data, tuple(quotes), snap.retrieved_at, lot

    # ------------------------------------------------------------------ the surface
    def surface(self, expiries: Sequence[str]) -> SurfaceBundle:
        """The current surface covering ``expiries`` (and every expiry asked for before). Rebuilt only when due (see the module docstring)."""
        if self.cfg.config_error:
            raise RiskUnavailable("config_error", self.cfg.config_error)
        with self._lock:
            want = self._expiries | set(expiries)
            if not want:
                raise RiskUnavailable("no_expiry", "no expiry requested")
            now = self._clock()
            reads = {e: self._read(e, now) for e in sorted(want)}
            for e, (_, quotes, _, _) in reads.items():
                self._sched.note_changes(self._quotes.update(e, quotes))
            covered = self._bundle is not None and want <= {d.expiry for d in self._bundle.data}
            if self._bundle is not None and covered and not self._sched.due():
                return self._bundle
            usable = {e: r for e, r in reads.items() if r[0].status == "ok" and r[3] is not None and r[1]}
            if not usable:
                raise RiskUnavailable("no_surface", "no stored option chain with a lot size is available for the requested expiries")
            self._expiries = want
            instants = {e: self._expiry_instant(e, now.astimezone(IST).date()) for e in usable}
            live_any = any(r[0].live_books > 0 for r in usable.values())
            as_of = now if live_any else min(r[2] for r in usable.values() if r[2] is not None)
            inputs = [ExpiryInput(e, years_between(as_of, instants[e], self.pcfg), self.cfg.rate, r[1], None) for e, r in usable.items()]
            self._seq += 1
            surface = build_surface(inputs, as_of, self.surface_cfg, self.pcfg, self._seq, self._bundle.surface if self._bundle else None)
            self.rebuilds += 1
            self._sched.mark_rebuilt()
            bundle = SurfaceBundle(surface, tuple(r[0] for r in reads.values()), instants, {e: int(r[3]) for e, r in usable.items() if r[3] is not None}, "live" if live_any else "stored", now)
            self._bundle = bundle
            log_event(logger, logging.INFO, "risk_surface_built", version=surface.version_id, expiries=len(inputs), live=live_any)
            return bundle

    # ------------------------------------------------------------------ requests
    def legs(self, bundle: SurfaceBundle, specs: Sequence[tuple[str, float, float, float, float | None]]) -> list[Leg]:
        """Legs from (expiry, strike, +1 call / -1 put, signed lots, entry price); the lot size comes from the chain."""
        out: list[Leg] = []
        for expiry, strike, cp, qty, entry in specs:
            lot = bundle.lot_sizes.get(expiry)
            if lot is None:
                raise RiskUnavailable("expiry_unavailable", f"no chain data (and so no lot size) for the expiry {expiry}")
            out.append(Leg(expiry, strike, cp, qty, lot, entry))
        return out

    def whatif(self, bundle: SurfaceBundle, legs: Sequence[Leg]) -> WhatIfEngine:
        return WhatIfEngine(bundle.surface, legs, bundle.instants, None, WhatIfConfig(default_sticky=self.cfg.default_sticky), self.pcfg)

    def chain_greeks(self, bundle: SurfaceBundle, expiry: str, each_side: int | None, third_order: bool) -> dict[str, object]:
        """Greeks of every strike of one expiry at the surface's own volatility (per unit, and in rupees for one long lot)."""
        sl = bundle.surface.slice(expiry)
        lot = bundle.lot_sizes[expiry]
        if sl.params is None:
            raise RiskUnavailable("no_fit", f"the expiry {expiry} has no fitted smile: {sl.degraded_reason}")
        market = {(x.strike, x.cp): x for x in bundle.surface.strikes if x.expiry == expiry}
        strikes = sorted({x.strike for x in market.values()})
        if each_side is not None and strikes:
            i = int(np.argmin([abs(k - sl.forward) for k in strikes]))
            strikes = strikes[max(0, i - each_side) : i + each_side + 1]
        k_arr = np.array(strikes)
        t = years_between(bundle.surface.as_of, bundle.instants[expiry], self.pcfg)
        vol = sl.iv(np.log(k_arr / sl.forward))
        rows: list[dict[str, object]] = []
        for cp, label in ((1.0, "call"), (-1.0, "put")):
            g = greeks(cp, sl.forward, k_arr, t, vol, sl.rate, self.pcfg)
            h = higher_order(cp, sl.forward, k_arr, t, vol, sl.rate, self.pcfg, self.gcfg) if third_order else None
            if h is None:
                nan = np.full(k_arr.size, np.nan)
                h = HigherOrder(nan, nan, nan, nan, np.zeros(k_arr.size, dtype=bool), np.ones(k_arr.size, dtype=bool))
            sc = scale(g, h, self.gcfg)
            rp = in_rupees(sc, sl.forward, lot, 1)
            for j, k in enumerate(strikes):
                m = market.get((k, cp))
                if len(rows) <= j:
                    rows.append({"strike": k})
                rows[j][label] = {
                    "model_iv": float(vol[j]), "market_iv": None if m is None or not np.isfinite(m.iv) else float(m.iv), "iv_status": "none" if m is None else m.status, "iv_reason": None if m is None else m.reason,
                    "price_source": None if m is None else m.source, "model_price": float(g.price[j]), "market_price": None if m is None or not np.isfinite(m.price) else float(m.price),
                    "unit": {f: float(getattr(sc, f)[j]) for f in ("delta", "gamma", "vega", "theta_day", "theta_hour", "theta_trading_hour", "rho", "vanna", "charm", "vomma", "veta", "speed", "color", "zomma", "ultima")},
                    "rupee_per_long_lot": {f: float(getattr(rp, f)[j]) for f in ("delta", "gamma", "vega", "theta_day", "theta_hour", "rho")},
                }
        return {"expiry": expiry, "forward": sl.forward, "lot_size": lot, "t_years": t, "degraded": sl.degraded, "degraded_reason": sl.degraded_reason, "rows": rows}

    def status(self) -> dict[str, object]:
        b = self._bundle
        return {
            "enabled": True, "config_error": self.cfg.config_error, "surface_version_id": None if b is None else b.surface.version_id, "as_of_ist": None if b is None else b.surface.as_of_ist,
            "source": None if b is None else b.source, "rebuilds": self.rebuilds, "pending_changes": self._sched.pending, "sticky_rules": list(STICKY_RULES), "default_sticky": self.cfg.default_sticky,
            "rebuild_interval_s": self.cfg.rebuild_interval_s, "rebuild_min_changed": self.cfg.rebuild_min_changed, "rate": self.cfg.rate, "spread_threshold_pct": self.cfg.spread_threshold_pct,
            "max_legs": self.cfg.max_legs, "greeks_cache": self.portfolio.cache.stats(),
        }  # fmt: skip
