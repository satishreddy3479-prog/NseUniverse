"""Keeps the breadth inputs fresh and turns live stock ticks into breadth, contribution, volume and sector views.

Inputs and when they are refreshed (all IST):
  constituent lists    07:45 and whenever none is stored      (NSE archive, honest client)
  Kotak stock tokens   08:05 and whenever none is stored      (scrip master through the broker)
  bhavcopy             after 19:30, newest session not stored (NSE archive): volume baseline + history
  weights              imported by the owner, or approximated from float shares when yfinance is present
During the session one compact sample per kind is stored every minute. A failure of any source only marks that
source unavailable; it never stops the option-chain collection.
"""

from __future__ import annotations

import asyncio
import contextlib
import csv
import io
import logging
import time as time_mod
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from app.domain.session import SESSION_OPEN, session_close
from app.logging_setup import log_event
from app.market import metrics as m
from app.market import participation as part
from app.market import technical as tech
from app.market import vwap as vwapmod
from app.market import weights as wmod
from app.market.flow import FlowTracker, profile_fraction, volume_profile
from app.market.sources import (
    BHAV_URL,
    LIST_URL,
    SourceError,
    TokenInfo,
    fetch_text,
    parse_bhavcopy,
    parse_index_list,
    parse_nifty_future,
    parse_scrip_master,
)
from app.market.store import MarketStore
from app.stream.models import FeedToken, LiveTick

IST = ZoneInfo("Asia/Kolkata")
logger = logging.getLogger(__name__)
INDEX_KEY = "nse_cm|Nifty 50"
FUT_SYMBOL = "FUT:NIFTY"
LISTS_AT, TOKENS_AT, BHAV_AT = time(7, 45), time(8, 5), time(19, 30)
RETRY = timedelta(minutes=30)
OR_MINUTES = 15  # opening range used for stock participation
STALE_WEIGHTS_DAYS = (
    60  # NSE reviews the index in March and September; weights older than this are flagged
)
SEED_DIR = Path(__file__).parent / "seed"


def _rank_key(r: dict[str, Any]) -> float:
    """Largest contribution first; without weights, the largest move first."""
    if r["contribution"] is not None:
        return -abs(float(r["contribution"]))
    return -abs(float(r["change_pct"] or 0.0)) / 1000


class MarketService:
    def __init__(
        self,
        store: MarketStore,
        *,
        ticks: Callable[[], dict[str, LiveTick]] = lambda: {},
        scrip_master: Callable[..., Awaitable[list[dict[str, Any]]]] | None = None,
        monthly_expiry: Callable[[], date | None] = lambda: None,
        trading_day: Callable[[date], bool | None] = lambda d: d.weekday() < 5,
        approx_weights: Callable[[list[str], dict[str, float]], dict[str, float]] | None = None,
        enabled: bool = True,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.store, self._ticks, self._scrip_master = store, ticks, scrip_master
        self._trading_day, self._approx, self.enabled, self._clock = (
            trading_day,
            approx_weights,
            enabled,
            clock,
        )
        self._task: asyncio.Task[None] | None = None
        self._last_try: dict[str, datetime] = {}
        self._cache: tuple[float, dict[str, Any]] | None = None
        self._vol_cache: tuple[str, dict[str, float]] | None = None
        self.last_sample_note = "not started"
        self._monthly_expiry = monthly_expiry
        self.trackers: dict[str, FlowTracker] = {}
        self._roles: tuple[float, dict[str, str]] | None = None
        self._base_cache: tuple[str, dict[str, Any]] | None = None
        self.future_note = "not looked up yet"
        self._part_cache: tuple[str, dict[str, Any]] | None = None

    # ----------------------------------------------------------------------------- universe
    def universe(self, index: str) -> list[m.Stock]:
        cur = self.store.current_list(index)
        if cur is None:
            return []
        items, _ = cur
        wt = self.weights_now() if index == "nifty50" else None
        w = wt[0] if wt else {}
        return [m.Stock(c.symbol, c.industry or None, w.get(c.symbol)) for c in items]

    def token_map(self) -> dict[str, TokenInfo]:
        t = self.store.latest_tokens()
        return t[0] if t else {}

    def stream_tokens(self) -> list[FeedToken]:
        """Stocks of NIFTY 500 (which contains NIFTY 50) that have a Kotak token."""
        tm = self.token_map()
        syms = {s.symbol for idx in ("nifty500", "nifty50") for s in self.universe(idx)}
        heavy = set(self.heavy()[0])
        out = [
            FeedToken(
                exchange_segment="nse_cm",
                instrument_token=tm[s].token,
                kind="scrip",
                depth=s in heavy,
            )
            for s in sorted(syms)
            if s in tm
        ]
        fut = tm.get(FUT_SYMBOL)
        if fut is not None:
            out.append(
                FeedToken(
                    exchange_segment="nse_fo", instrument_token=fut.token, kind="scrip", depth=True
                )
            )
        return out

    def weights_now(self) -> tuple[dict[str, float], str, str, str | None] | None:
        """(weights %, as_of, source, rolled_to). Official weights are rolled forward to the latest stored close:
        free-float weights move with price, so w_i x (close now / close at the weights date), renormalised. Skipped
        (static weights, as of their own date) when a close is missing or a price ratio looks like a corporate action."""
        wt = self.store.latest_weights("nifty50")
        if wt is None:
            return None
        w, as_of, source = wt
        sessions = self.store.daily_sessions()
        if (
            source.startswith("approx")
            or not sessions
            or sessions[-1] <= as_of
            or as_of not in sessions
        ):
            return w, as_of, source, None
        c0, c1 = self.store.closes_on(as_of, list(w)), self.store.closes_on(sessions[-1], list(w))
        if len(c0) < len(w) or len(c1) < len(w):
            return w, as_of, source, None
        ratio = {k: c1[k] / c0[k] for k in w}
        if any(not 0.6 < r < 1.5 for r in ratio.values()):  # a split/bonus/demerger: do not guess
            return w, as_of, source, None
        raw = {k: w[k] * ratio[k] for k in w}
        tot = sum(raw.values())
        return {k: v / tot * sum(w.values()) for k, v in raw.items()}, as_of, source, sessions[-1]

    def seed_weights(self) -> str:
        """Load the official weights shipped with the code (captured from NSE's index tracker) when none are stored."""
        cur = self.store.latest_weights("nifty50")
        if cur is not None and not cur[2].startswith("approx"):
            return "official weights already stored"
        files = sorted(SEED_DIR.glob("nifty50_weights_*.csv"))
        if not files or not self.universe("nifty50"):
            return "no seed file or no NIFTY 50 list yet"
        f = files[-1]
        as_of = date.fromisoformat(f.stem.rsplit("_", 1)[1])
        try:
            res = self.import_weights(
                f.read_text(encoding="utf-8"),
                as_of,
                "NSE index tracker (nseindia.com/index-tracker/NIFTY 50)",
            )
        except SourceError as e:
            self.store.attempt("weights_seed", False, str(e), self._clock())
            return f"rejected: {e}"
        self.store.attempt(
            "weights_seed", True, f"{res['stocks']} weights as of {as_of}", self._clock()
        )
        self._cache = None
        return f"{res['stocks']} official weights as of {as_of}"

    def heavy(self) -> tuple[list[str], str]:
        """The five stocks followed in depth: the largest index weights, or (until weights exist) yesterday's traded value."""
        syms = [x.symbol for x in self.universe("nifty50")]
        wt = self.weights_now()
        if wt and wt[0]:
            top = sorted((k for k in wt[0] if k in syms), key=lambda k: -wt[0][k])[:5]
            return top, "approximate index weights" if wt[2].startswith(
                "approx"
            ) else "official index weights"
        tv = self.store.last_traded_value(syms)
        return sorted(tv, key=lambda k: -tv[k])[
            :5
        ], "previous-session traded value (a liquidity proxy until weights exist)"

    # ----------------------------------------------------------------------------- order flow (futures and top-5 stocks)
    def _flow_roles(self) -> dict[str, str]:
        now = time_mod.monotonic()
        if self._roles and now - self._roles[0] < 60:
            return self._roles[1]
        roles = {
            f"{t.exchange_segment}|{t.instrument_token}": (
                "NIFTYFUT" if t.exchange_segment == "nse_fo" else ""
            )
            for t in self.stream_tokens()
            if t.depth
        }
        by_token = {t.token: sym for sym, t in self.token_map().items()}
        for k in list(roles):
            if not roles[k]:
                roles[k] = by_token.get(k.split("|", 1)[1], "")
        roles = {k: v for k, v in roles.items() if v}
        self._roles = (now, roles)
        return roles

    def on_tick(self, tick: LiveTick) -> None:
        """Called for every breadth/depth tick; only the futures and the five heavyweights are tracked."""
        name = self._flow_roles().get(tick.key)
        if name is None:
            return
        t = tick.received_at.astimezone(IST)
        if not SESSION_OPEN <= t.time() <= session_close():
            return
        tr = self.trackers.get(name)
        if tr is None:
            tr = self.trackers[name] = FlowTracker(name)
        tr.update(
            tick.received_at,
            t.strftime("%H:%M"),
            t.date().isoformat(),
            tick.volume,
            tick.ltp,
            tick.bid,
            tick.ask,
            tick.bid_qty,
            tick.ask_qty,
            tick.avg_price,
        )

    def baselines(self, now: datetime) -> dict[str, Any]:
        """Typical intraday volume curve and daily futures volume, from our own minute recordings of earlier sessions."""
        today = now.astimezone(IST).date().isoformat()
        if self._base_cache and self._base_cache[0] == today:
            return self._base_cache[1]
        since = (now - timedelta(days=40)).astimezone(UTC).isoformat()

        def by_day(
            kind: str, pick: Callable[[dict[str, Any]], float | None]
        ) -> list[list[tuple[int, float]]]:
            days: dict[str, list[tuple[int, float]]] = {}
            for stamp, pl in self.store.samples_since(kind, since):
                t = datetime.fromisoformat(stamp).astimezone(IST)
                v = pick(pl)
                if v is not None and t.date().isoformat() != today:
                    days.setdefault(t.date().isoformat(), []).append(
                        (
                            int(
                                (t - datetime.combine(t.date(), SESSION_OPEN, IST)).total_seconds()
                                // 60
                            ),
                            v,
                        )
                    )
            return list(days.values())

        def pooled(pl: dict[str, Any]) -> float | None:
            vols = [r[2] for r in pl.get("rows", []) if r[2] is not None]
            return float(sum(vols)) if len(vols) >= 45 else None

        fut = by_day("fut", lambda pl: pl.get("v"))
        out: dict[str, Any] = {
            "fut_profile": volume_profile(fut),
            "stock_profile": volume_profile(by_day("stocks50", pooled)),
            "fut_avg": None,
            "fut_sessions": len(fut),
        }
        finals = [max(v for _, v in d) for d in fut if d and max(t for t, _ in d) >= 360]
        if len(finals) >= 5:
            out["fut_avg"] = sum(finals[-20:]) / len(finals[-20:])
        self._base_cache = (today, out)
        return out

    def flow_summary(
        self,
        now: datetime,
        elapsed: float,
        ticks: dict[str, m.StockTick],
        table: list[dict[str, Any]],
    ) -> dict[str, Any]:
        base = self.baselines(now)
        fut_tr = self.trackers.get("NIFTYFUT")
        fut: dict[str, Any] | None = None
        if fut_tr is not None and fut_tr.last_volume is not None:
            fut = fut_tr.public()
            frac = profile_fraction(base["fut_profile"], elapsed)
            avg = base["fut_avg"]
            fut["relative_volume"] = (
                None
                if not (frac and avg and elapsed >= 15)
                else round(fut_tr.last_volume / (avg * frac), 2)
            )
            fut["relative_volume_reference"] = "profile" if frac else None
        heavy, basis = self.heavy()
        rows = {r["symbol"]: r for r in table}
        stocks = []
        for sym in heavy:
            bars = [tech.Bar(*b) for b in self.store.daily_bars(sym, 80)]
            tk = ticks.get(sym)
            r = rows.get(sym, {})
            tr = self.trackers.get(sym)
            stocks.append({"symbol": sym, "weight": r.get("weight"), "change_pct": r.get("change_pct"), "volume": r.get("volume"),
                           "relative_volume": r.get("relative_volume"), "flow": None if tr is None or tr.last_volume is None else tr.public(),
                           "technical": tech.read(sym, bars, None if tk is None else tk.ltp)})  # fmt: skip
        return {
            "futures": fut,
            "futures_contract": (
                self.token_map().get(FUT_SYMBOL) or TokenInfo("", "", "")
            ).trading_symbol
            or None,
            "futures_note": self.future_note,
            "heavy5": {"basis": basis, "stocks": stocks},
            "baseline": {
                "profile_sessions_futures": base["fut_sessions"],
                "futures_profile_ready": base["fut_profile"] is not None,
                "stock_profile_ready": base["stock_profile"] is not None,
                "needs_sessions": 5,
            },
        }

    def participation(
        self,
        now: datetime,
        u50: list[m.Stock],
        chg50: dict[str, float],
        b50: m.Breadth,
        idx: float | None,
    ) -> dict[str, Any]:
        """Share of NIFTY 50 stocks above their day VWAP and opening range, breadth momentum and price/breadth divergence."""
        t = now.astimezone(IST)
        raw = self._ticks()
        by_token = {tk.token: sym for sym, tk in self.token_map().items()}
        pairs: dict[str, tuple[float | None, float | None]] = {
            s_.symbol: (None, None) for s_ in u50
        }
        for lt in raw.values():
            sym = (
                by_token.get(lt.instrument_token)
                if lt.exchange_segment == "nse_cm" and lt.kind == "scrip"
                else None
            )
            if sym in pairs and (now - lt.received_at).total_seconds() <= m.MAX_TICK_AGE_S:
                pairs[sym] = (lt.ltp, lt.avg_price)
        stamp = t.strftime("%Y%m%d%H%M")
        if self._part_cache is None or self._part_cache[0] != stamp:
            day_start = datetime.combine(t.date(), SESSION_OPEN, IST)
            or_changes: dict[str, list[float]] = {}
            for at, pl in self.store.samples_since(
                "stocks50", day_start.astimezone(UTC).isoformat()
            ):
                if (
                    datetime.fromisoformat(at).astimezone(IST) - day_start
                ).total_seconds() < OR_MINUTES * 60:
                    for r in pl.get("rows", []):
                        if r[1] is not None:
                            or_changes.setdefault(r[0], []).append(float(r[1]))
            then = None
            for at, pl in self.store.samples_since(
                "nifty50", (now - timedelta(minutes=15 + 3)).astimezone(UTC).isoformat()
            ):
                if datetime.fromisoformat(at) <= now - timedelta(minutes=15):
                    then = pl
            self._part_cache = (stamp, {"or": or_changes, "then": then})
        c = self._part_cache[1]
        elapsed = self.elapsed_minutes(now)
        then = c["then"]
        return {
            "above_vwap": part.above_vwap(pairs),
            "opening_range": None if elapsed < OR_MINUTES else part.opening_range_status({x.symbol: c["or"].get(x.symbol, []) for x in u50}, chg50) | {"minutes": OR_MINUTES},
            "momentum": part.momentum_and_divergence(
                part.balance(b50.advancing, b50.declining), None if not then else part.balance(then.get("advancing"), then.get("declining")),
                idx, None if not then else then.get("idx"),
            ),
        }  # fmt: skip

    def vwap_block(self, now: datetime) -> dict[str, Any] | None:
        """Day-VWAP description of the NIFTY future from today's minute recordings plus the live tick."""
        t = now.astimezone(IST)
        day_start = datetime.combine(t.date(), SESSION_OPEN, IST)
        rows = self.store.samples_since("fut", day_start.astimezone(UTC).isoformat())
        series = []
        for stamp, pl in rows:
            at = datetime.fromisoformat(stamp).astimezone(IST)
            if pl.get("ltp") and pl.get("atp"):
                series.append(
                    (
                        int((at - day_start).total_seconds() // 60),
                        float(pl["ltp"]),
                        float(pl["atp"]),
                    )
                )
        tr = self.trackers.get("NIFTYFUT")
        if tr is not None and tr.last_ltp and tr.last_atp and tr.day == t.date().isoformat():
            series.append((int((t - day_start).total_seconds() // 60), tr.last_ltp, tr.last_atp))
        return vwapmod.describe(series)

    def estimate_weights(self, now: datetime | None = None) -> str:
        """Weights recovered from the recorded index and stock changes (only while no official weights are loaded)."""
        now = now or self._clock()
        cur = self.store.latest_weights("nifty50")
        if cur and not cur[2].startswith("approx"):
            return "official weights loaded; nothing to estimate"
        syms = [x.symbol for x in self.universe("nifty50")]
        if not syms:
            return "no NIFTY 50 list yet"
        since = (now - timedelta(days=12)).astimezone(UTC).isoformat()
        idx: dict[str, float] = {}
        for a, p in self.store.samples_since("nifty50", since):
            if p.get("idx") is not None:
                idx[a] = float(p["idx"])
        rows: list[tuple[float, dict[str, float]]] = []
        for a, p in self.store.samples_since("stocks50", since):
            if a in idx:
                x = {r[0]: float(r[1]) for r in p.get("rows", []) if r[1] is not None}
                rows.append((idx[a], x))
        res = wmod.estimate(rows, syms)
        if res is None:
            self.store.attempt(
                "weights_est", False, f"{len(rows)} minute rows; fit not accepted yet", now
            )
            return f"not enough clean data yet ({len(rows)} rows)"
        w, rmse = res
        self.store.save_weights(
            "nifty50", w, now.astimezone(IST).date(), f"approx-regression rmse={rmse}", now
        )
        self.store.attempt("weights_est", True, f"{len(w)} weights, rmse {rmse}", now)
        self._cache = None
        return f"{len(w)} estimated weights (rmse {rmse} index points)"

    def stock_ticks(self) -> dict[str, m.StockTick]:
        by_token = {t.token: s for s, t in self.token_map().items()}
        out: dict[str, m.StockTick] = {}
        for lt in self._ticks().values():
            if lt.exchange_segment != "nse_cm" or lt.kind != "scrip":
                continue
            sym = by_token.get(lt.instrument_token)
            if sym is None:
                continue
            out[sym] = m.StockTick(
                sym, lt.ltp, lt.prev_close, lt.volume, lt.high, lt.low, lt.received_at
            )
        return out

    def index_change(self) -> float | None:
        lt = self._ticks().get(INDEX_KEY)
        return (
            None
            if lt is None
            else m.change_pct(
                m.StockTick("NIFTY", lt.ltp, lt.prev_close, None, None, None, lt.received_at)
            )
        )

    def elapsed_minutes(self, now: datetime | None = None) -> float:
        t = (now or self._clock()).astimezone(IST)
        start = datetime.combine(t.date(), SESSION_OPEN, IST)
        return max(0.0, min(float(m.SESSION_MINUTES), (t - start).total_seconds() / 60))

    def avg_volume(self) -> dict[str, float]:
        sessions = self.store.bhav_sessions()
        key = sessions[-1] if sessions else ""
        if self._vol_cache and self._vol_cache[0] == key:
            return self._vol_cache[1]
        syms = [s.symbol for s in self.universe("nifty500")]
        vol = self.store.avg_volume(syms)
        self._vol_cache = (key, vol)
        return vol

    # ----------------------------------------------------------------------------- the live view
    def summary(self, now: datetime | None = None) -> dict[str, Any]:
        now = now or self._clock()
        u50, u500 = self.universe("nifty50"), self.universe("nifty500")
        ticks = self.stock_ticks()
        idx = self.index_change()
        elapsed = self.elapsed_minutes(now)
        vols = self.avg_volume()
        b50, b500 = m.breadth(u50, ticks, now), m.breadth(u500, ticks, now)
        c50 = m.contributions(u50, ticks, now)
        base = self.baselines(now)
        frac = profile_fraction(base["stock_profile"], elapsed)
        v50 = m.relative_volume(u50, ticks, vols, elapsed, frac, now) if vols else None
        ref_change = (
            idx
            if idx is not None
            else (
                c50.cap_weight_return
                if c50 and c50.cap_weight_return is not None
                else b50.equal_weight_return
            )
        )
        q = m.move_quality(ref_change, b50 if u50 else None, c50, v50)
        chg50 = m.usable(u50, ticks, now)
        table = sorted(
            (
                {
                    "symbol": s.symbol,
                    "sector": s.sector,
                    "weight": s.weight,
                    "change_pct": round(chg50[s.symbol], 3) if s.symbol in chg50 else None,
                    "contribution": None
                    if s.weight is None or s.symbol not in chg50
                    else round(s.weight / 100 * chg50[s.symbol], 4),
                    "volume": getattr(ticks.get(s.symbol), "volume", None),
                    "relative_volume": None
                    if (t := ticks.get(s.symbol)) is None
                    or t.volume is None
                    or not vols.get(s.symbol)
                    or elapsed < 15
                    else round(
                        t.volume
                        / (vols[s.symbol] * (frac or min(1.0, elapsed / m.SESSION_MINUTES))),
                        2,
                    ),
                }
                for s in u50
            ),
            key=_rank_key,
        )
        sec50 = m.sector_table(u50, ticks, ref_change, None, vols or None, elapsed, now)
        sec500 = m.sector_table(
            u500, ticks, ref_change, None, vols or None, elapsed, now, min_covered=3
        )
        prev = self.store.recent_samples("sectors", 1)
        prev_ranks = {
            r["sector"]: r["rank"] for r in (prev[-1]["nifty500"] if prev else []) if r.get("rank")
        }
        wt = self.weights_now()
        return {
            "generated_at": now.isoformat(),
            "elapsed_minutes": round(elapsed, 1),
            "index_change_pct": idx,
            "sources": self.sources(now),
            "nifty50": {
                "breadth": b50.public(),
                "contribution": None if c50 is None else c50.public(),
                "volume": None if v50 is None else v50.public(),
                "quality": q,
                "stocks": table[:50],
                "weights": None
                if wt is None
                else {
                    "as_of": wt[1],
                    "source": wt[2],
                    "approximate": wt[2].startswith("approx"),
                    "rolled_to": wt[3],
                },
            },
            "nifty500": {"breadth": b500.public()},
            "flow": self.flow_summary(now, elapsed, ticks, table),
            "participation": self.participation(now, u50, chg50, b50, idx),
            "sectors": {
                "nifty50": [r.public() for r in sec50],
                "nifty500": [r.public() for r in sec500],
                "rotation": m.rotation(prev_ranks, sec500),
            },  # fmt: skip
        }

    def sources(self, now: datetime | None = None) -> dict[str, Any]:
        l50, l500 = self.store.current_list("nifty50"), self.store.current_list("nifty500")
        wt, tok, ses = (
            self.weights_now(),
            self.store.latest_tokens(),
            self.store.bhav_sessions(),
        )
        tm = self.token_map()
        ticks = self.stock_ticks()
        syms500 = [s.symbol for s in self.universe("nifty500")]
        return {
            "lists": {"nifty50": l50 and {"stocks": len(l50[0]), **l50[1]}, "nifty500": l500 and {"stocks": len(l500[0]), **l500[1]}, "last_attempt": self.store.last_attempt("lists")},
            "tokens": {"day": tok and tok[1], "found": len([s for s in syms500 if s in tm]), "of": len(syms500), "last_attempt": self.store.last_attempt("tokens")},
            "weights": wt and {"as_of": wt[1], "source": wt[2], "stocks": len(wt[0]), "approximate": wt[2].startswith("approx"), "rolled_to": wt[3], "age_days": (now or self._clock()).astimezone(IST).date().toordinal() - date.fromisoformat(wt[1]).toordinal(), "stale": (now or self._clock()).astimezone(IST).date().toordinal() - date.fromisoformat(wt[1]).toordinal() > STALE_WEIGHTS_DAYS and not wt[2].startswith("approx")},
            "volume_baseline": {"sessions": len(ses), "stocks": len(self.avg_volume()), "needs_sessions": 10, "history_sessions": len(self.store.daily_sessions()), "last_attempt": self.store.last_attempt("bhav")},
            "list_changes": self.store.list_changes(5),
            "live": {"stocks_with_ticks": len(ticks), "subscribed": len(self.stream_tokens())},
        }  # fmt: skip

    def coverage_report(self) -> dict[str, Any]:
        """Phase-0 verification: which stocks have a token, a tick and which fields arrived."""
        tm, ticks = self.token_map(), self.stock_ticks()
        rows = []
        for idx in ("nifty50", "nifty500"):
            for s in self.universe(idx):
                t = ticks.get(s.symbol)
                rows.append({"index": idx, "symbol": s.symbol, "token": s.symbol in tm, "tick": t is not None,
                             "ltp": bool(t and t.ltp), "prev_close": bool(t and t.prev_close), "volume": bool(t and t.volume is not None)})  # fmt: skip
        out: dict[str, Any] = {}
        for idx in ("nifty50", "nifty500"):
            r = [x for x in rows if x["index"] == idx]
            out[idx] = {"stocks": len(r), **{k: sum(1 for x in r if x[k]) for k in ("token", "tick", "ltp", "prev_close", "volume")},
                        "missing_token": [x["symbol"] for x in r if not x["token"]][:25], "token_without_tick": [x["symbol"] for x in r if x["token"] and not x["tick"]][:25]}  # fmt: skip
        return out

    # ----------------------------------------------------------------------------- refresh jobs
    def refresh_lists(self) -> dict[str, Any]:
        res: dict[str, Any] = {}
        for idx in ("nifty50", "nifty500"):
            f, text = fetch_text(LIST_URL.format(name=idx))
            if text is None:
                res[idx] = f"not fetched ({f.error or f.status})"
                continue
            try:
                items = parse_index_list(text, idx)
            except SourceError as e:
                res[idx] = f"rejected: {e}"
                continue
            assert f.body is not None
            before = self.store.current_list(idx)
            if self.store.save_list(idx, items, f.body, self._clock()):
                res[idx] = "new list stored"
                if before is not None:
                    old, new = {c.symbol for c in before[0]}, {c.symbol for c in items}
                    if old != new:
                        self.store.save_list_change(
                            idx, sorted(new - old), sorted(old - new), self._clock()
                        )
                        res[idx] = f"CHANGED: +{len(new - old)} -{len(old - new)}"
            else:
                res[idx] = "unchanged"
        ok = all(not v.startswith(("not fetched", "rejected")) for v in res.values())
        self.store.attempt(
            "lists", ok, "; ".join(f"{k}: {v}" for k, v in res.items()), self._clock()
        )
        return res

    def refresh_bhav(self, session: date) -> str:
        f, text = fetch_text(BHAV_URL.format(d=session))
        if text is None:
            note = f"not published or not fetched ({f.error or f.status})"
            self.store.attempt("bhav", False, f"{session}: {note}", self._clock())
            return note
        syms = {s.symbol for s in self.universe("nifty500")} | {
            s.symbol for s in self.universe("nifty50")
        }
        try:
            rows = parse_bhavcopy(text, syms or None)
        except SourceError as e:
            self.store.attempt("bhav", False, f"{session}: {e}", self._clock())
            return f"rejected: {e}"
        n = self.store.save_bhav(rows)
        self.store.attempt("bhav", True, f"{session}: {n} rows", self._clock())
        self._vol_cache = None
        return f"{n} rows stored"

    async def refresh_tokens(self) -> str:
        if self._scrip_master is None:
            return "no broker"
        try:
            rows = await self._scrip_master()
            tokens = parse_scrip_master(rows)
        except Exception as e:  # noqa: BLE001 - reported as an unavailable source
            self.store.attempt("tokens", False, type(e).__name__, self._clock())
            return f"failed: {type(e).__name__}"
        want = {s.symbol for idx in ("nifty500", "nifty50") for s in self.universe(idx)}
        keep = {k: v for k, v in tokens.items() if not want or k in want}
        exp = self._monthly_expiry()
        if exp is None:
            self.future_note = "NIFTY futures not subscribed: the monthly expiry is not known yet"
        else:
            try:
                fut = parse_nifty_future(await self._scrip_master("nse_fo"), exp.year, exp.month)
            except Exception as e:  # noqa: BLE001
                fut, self.future_note = None, f"NIFTY futures lookup failed: {type(e).__name__}"
            else:
                self.future_note = (
                    f"NIFTY futures contract {fut.trading_symbol}"
                    if fut
                    else f"NIFTY futures for {exp:%Y-%m} not found in the F&O scrip master"
                )
            if fut:
                keep[FUT_SYMBOL] = fut
        self.store.save_tokens(keep, self._clock().astimezone(IST).date())
        self.store.attempt(
            "tokens", bool(keep), f"{len(keep)} of {len(want)} stocks have a token", self._clock()
        )
        return f"{len(keep)} tokens"

    def import_weights(self, csv_text: str, as_of: date, source: str) -> dict[str, Any]:
        """Official weights supplied by the owner: columns symbol,weight (percent of the index). Must sum to ~100."""
        rd = csv.DictReader(io.StringIO(csv_text.lstrip("﻿")))
        cols = {(c or "").strip().lower(): c for c in (rd.fieldnames or [])}
        sc = next((cols[k] for k in ("symbol",) if k in cols), None)
        wc = next(
            (cols[k] for k in ("weight", "weight_pct", "weightage", "weight(%)") if k in cols), None
        )
        if sc is None or wc is None:
            raise SourceError("weights need columns symbol and weight")
        w: dict[str, float] = {}
        for r in rd:
            try:
                w[(r[sc] or "").strip()] = float(str(r[wc]).replace("%", "").strip())
            except (TypeError, ValueError):
                continue
        known = {s.symbol for s in self.universe("nifty50")}
        unknown = sorted(set(w) - known)
        total = sum(w.values())
        if known and unknown:
            raise SourceError(f"symbols not in the NIFTY 50 list: {unknown[:5]}")
        if not 98.0 <= total <= 102.0:
            raise SourceError(f"weights sum to {total:.2f}%, expected about 100")
        n = self.store.save_weights("nifty50", w, as_of, source, self._clock())
        self.store.attempt(
            "weights", True, f"{n} weights from {source} as of {as_of}", self._clock()
        )
        return {"stocks": len(w), "sum": round(total, 3), "stored": n}

    def refresh_weights_approx(self) -> str:
        """Approximate weights = float shares x last close (Yahoo float shares; labelled approximate)."""
        if self._approx is None:
            return "no approximation source on this machine"
        syms = [s.symbol for s in self.universe("nifty50")]
        closes: dict[str, float] = {}
        with self.store._lock:  # noqa: SLF001 - one read of the newest closes
            for sym in syms:
                r = self.store._db.execute(
                    "SELECT close FROM bhav WHERE symbol=? AND close IS NOT NULL ORDER BY session DESC LIMIT 1",
                    (sym,),
                ).fetchone()  # noqa: SLF001
                if r:
                    closes[sym] = float(r[0])
        try:
            mcap = self._approx(syms, closes)
        except Exception as e:  # noqa: BLE001
            self.store.attempt("weights", False, type(e).__name__, self._clock())
            return f"failed: {type(e).__name__}"
        tot = sum(mcap.values())
        if len(mcap) < 45 or tot <= 0:
            self.store.attempt(
                "weights",
                False,
                f"only {len(mcap)} of {len(syms)} stocks had float shares",
                self._clock(),
            )
            return "too few stocks with float shares"
        w = {s: v / tot * 100 for s, v in mcap.items()}
        ses = self.store.bhav_sessions()
        n = self.store.save_weights(
            "nifty50",
            w,
            date.fromisoformat(ses[-1]) if ses else self._clock().astimezone(IST).date(),
            "approx-yahoo-float",
            self._clock(),
        )
        self.store.attempt("weights", True, f"{n} approximate weights", self._clock())
        return f"{n} approximate weights"

    # ----------------------------------------------------------------------------- recording and scheduling
    def in_session(self, now: datetime | None = None) -> bool:
        t = (now or self._clock()).astimezone(IST)
        return bool(self._trading_day(t.date())) and SESSION_OPEN <= t.time() <= session_close()

    def sample(self, now: datetime | None = None) -> bool:
        """Store one compact row per kind for this minute (only in session and only when stocks are streaming)."""
        now = now or self._clock()
        if not self.in_session(now) or not self.stock_ticks():
            return False
        s = self.summary(now)
        stamp = now.astimezone(UTC).replace(second=0, microsecond=0).isoformat()
        b50, b500 = s["nifty50"]["breadth"], s["nifty500"]["breadth"]
        keep = (
            "total",
            "covered",
            "advancing",
            "declining",
            "flat",
            "equal_weight_return",
            "at_high",
            "at_low",
        )
        self.store.record_sample("nifty50", stamp, {k: b50[k] for k in keep} | {"quality": s["nifty50"]["quality"]["state"], "cap_weight_return": (s["nifty50"]["contribution"] or {}).get("cap_weight_return"), "top5_share": (s["nifty50"]["contribution"] or {}).get("top5_share"), "weighted_rv": (s["nifty50"]["volume"] or {}).get("weighted_rv"), "idx": s["index_change_pct"]})  # fmt: skip
        self.store.record_sample("nifty500", stamp, {k: b500[k] for k in keep})
        self.store.record_sample(
            "sectors",
            stamp,
            {
                "nifty500": [
                    {
                        "sector": r["sector"],
                        "rank": r["rank"],
                        "ew": r["equal_weight_return"],
                        "rs": r["relative_strength"],
                    }
                    for r in s["sectors"]["nifty500"]
                ]
            },
        )
        self.store.record_sample(
            "stocks50",
            stamp,
            {"rows": [[r["symbol"], r["change_pct"], r["volume"]] for r in s["nifty50"]["stocks"]]},
        )
        fut = self.trackers.get("NIFTYFUT")
        if fut is not None and fut.last_volume is not None:
            self.store.record_sample(
                "fut",
                stamp,
                {
                    "v": fut.last_volume,
                    "cvd": fut.buy - fut.sell,
                    "b": fut.buy,
                    "s": fut.sell,
                    "ltp": fut.last_ltp,
                    "di": fut.last_imbalance,
                    "atp": fut.last_atp,
                },
            )
        rows = [
            [k, tr.buy - tr.sell, tr.buy, tr.sell, tr.last_volume, tr.last_imbalance]
            for k in self.heavy()[0]
            if (tr := self.trackers.get(k)) and tr.last_volume is not None
        ]
        if rows:
            self.store.record_sample("heavy5", stamp, {"rows": rows})
        return True

    def due(self, kind: str, now: datetime) -> bool:
        t = now.astimezone(IST)
        last = self._last_try.get(kind)
        if last and now - last < RETRY:
            return False
        if kind == "lists":
            return (
                self.store.current_list("nifty50") is None
                or self.store.current_list("nifty500") is None
                or (
                    t.time() >= LISTS_AT
                    and (la := self.store.last_attempt("lists")) is not None
                    and la["at"][:10] < t.date().isoformat()
                )
            )
        if kind == "tokens":
            tok = self.store.latest_tokens()
            return self.store.current_list("nifty500") is not None and (
                tok is None or (t.time() >= TOKENS_AT and tok[1] < t.date().isoformat())
            )
        if kind == "bhav":
            if (
                t.time() < BHAV_AT
                or not self._trading_day(t.date())
                or self.store.current_list("nifty500") is None
            ):
                return False
            lb_ = self.store.last_attempt("bhav")
            return t.date().isoformat() not in self.store.bhav_sessions() and (
                lb_ is None or lb_["at"][:10] < t.date().isoformat() or not lb_["ok"]
            )
        if kind == "bhav_backfill":
            return (
                len(self.store.daily_sessions()) < 55
                and self.store.current_list("nifty500") is not None
            )
        if kind == "weights_seed":
            cur = self.store.latest_weights("nifty50")
            return (cur is None or cur[2].startswith("approx")) and bool(self.universe("nifty50"))
        if kind == "weights_est":
            la = self.store.last_attempt("weights_est")
            wt = self.store.latest_weights("nifty50")
            return (
                t.time() >= time(16, 15)
                and bool(self._trading_day(t.date()))
                and (wt is None or wt[2].startswith("approx"))
                and (la is None or la["at"][:10] < t.date().isoformat())
            )
        if kind == "weights":
            return (
                self.store.latest_weights("nifty50") is None
                and self._approx is not None
                and bool(self.store.bhav_sessions())
            )
        return False

    async def run_due(self) -> dict[str, str]:
        now = self._clock()
        out: dict[str, str] = {}
        for kind in (
            "lists",
            "weights_seed",
            "tokens",
            "bhav",
            "bhav_backfill",
            "weights",
            "weights_est",
        ):
            if not self.due(kind, now):
                continue
            self._last_try[kind] = now
            if kind == "lists":
                out[kind] = str(await asyncio.to_thread(self.refresh_lists))
            elif kind == "tokens":
                out[kind] = await self.refresh_tokens()
            elif kind == "bhav":
                out[kind] = await asyncio.to_thread(self.refresh_bhav, now.astimezone(IST).date())
            elif kind == "bhav_backfill":
                out[kind] = await asyncio.to_thread(self.backfill_bhav, now.astimezone(IST).date())
            elif kind == "weights_seed":
                out[kind] = await asyncio.to_thread(self.seed_weights)
            elif kind == "weights_est":
                out[kind] = await asyncio.to_thread(self.estimate_weights)
            else:
                out[kind] = await asyncio.to_thread(self.refresh_weights_approx)
        return out

    def backfill_bhav(self, today: date, want: int = 60, max_requests: int = 8) -> str:
        """Fetch missing recent sessions, newest first, a few per run (a polite pace); weekends are skipped."""
        have = set(self.store.daily_sessions())
        got = tried = 0
        d = today - timedelta(days=1)
        while len(have) + got < want and tried < max_requests and (today - d).days < 110:
            if d.weekday() < 5 and d.isoformat() not in have and self._trading_day(d) is not False:
                tried += 1
                if "rows stored" in self.refresh_bhav(d):
                    got += 1
            d -= timedelta(days=1)
        return f"{got} sessions added in {tried} requests"

    async def _loop(self) -> None:
        await asyncio.sleep(45)
        last_min = ""
        while True:
            try:
                await self.run_due()
                stamp = self._clock().astimezone(IST).strftime("%Y%m%d%H%M")
                if stamp != last_min and self.sample():
                    last_min = stamp
                    self.last_sample_note = f"stored {stamp[8:10]}:{stamp[10:12]} IST"
            except Exception as e:  # noqa: BLE001 - the loop must survive
                self.last_sample_note = f"error: {type(e).__name__}"
                log_event(logger, logging.WARNING, "market_loop_error", error=type(e).__name__)
            await asyncio.sleep(20)

    def start(self) -> None:
        if self._task is None and self.enabled:
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    def public_status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "sample_note": self.last_sample_note,
            "sources": self.sources(),
            "counts": self.store.counts(),
        }
