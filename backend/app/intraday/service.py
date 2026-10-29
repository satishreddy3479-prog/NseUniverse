"""Builds the Market Sentiment Command Center payload from the stores the backend already keeps.

Sources (all real, all stored locally):
* observations.sqlite3: ~60-second option-chain samples (spot + every contract) in market hours.
* market_history.sqlite3: daily bars (NIFTY 50, sector indices, US/Asia/Europe, FX, crude, yields).
* nse_flows.sqlite3: NSE FII/DII provisional cash figures (previous session at best).
* reference/events.json: verified economic calendar.
Every section says where it came from, when it was observed and how fresh it is.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time as _time
from collections.abc import Callable
from dataclasses import asdict
from datetime import UTC, date, datetime, time, timedelta
from statistics import pstdev
from typing import Any

from app.intraday import evaluate, labels, paper, positioning, price_structure, setups
from app.intraday import volatility as volmod
from app.intraday.costs import CostModel
from app.intraday.features import (
    CLOSE,
    IST,
    OPEN,
    DailyBar,
    Point,
    Quote,
    daily_context,
    in_session,
    minutes_elapsed,
    options_features,
    price_features,
    session_phase,
)
from app.intraday.sentiment import (
    SCORE_CONFIG,
    SCORE_VERSION,
    FlowInput,
    GlobalInput,
    _no_stocks_reason,
    assess,
    breadth_component,
    global_component,
    institutional_component,
    narrative,
    options_component,
    price_component,
    regime,
    scenarios,
    sectors_component,
    unavailable,
)
from app.intraday.store import IntradayStore
from app.prediction.calendar import CalendarCoverageError, TradingCalendar
from app.prediction.events import EventCalendar
from app.prediction.flows_store import FlowsStore
from app.prediction.history_store import HistoryStore
from app.storage.observations import ObservationStore, to_ms

logger = logging.getLogger(__name__)

#: a session counts towards ML training data only if it holds this many in-session samples
COMPLETE_SESSION_SAMPLES = 300
#: documented minimum before an intraday model is even trained (docs/intraday.md)
ML_STAGES: list[dict[str, Any]] = [
    {"id": "collecting", "name": "Collecting labelled data", "from_sessions": 0, "what": "every finished session is turned into feature rows with forward-return labels"},
    {"id": "experimental", "name": "Experimental training", "from_sessions": 5, "what": "baselines and a simple model, leave-one-day-out with a purge; shown as experimental, no validity claimed"},
    {"id": "paper", "name": "Paper-testing", "from_sessions": 20, "what": "tree models vs baselines, calibration; every live prediction recorded before its outcome"},
    {"id": "validated", "name": "Eligible for 'validated'", "from_sessions": 60, "what": "label 'validated' only if it beats the baselines across regimes with calibrated probabilities"},
]
GLOBAL_KEYS = ("SPX", "NDX_COMP", "VIX", "USDINR", "BRENT", "UST10Y", "GOLD", "N225", "HSI", "DAX")
SECTOR_KEYS = (
    "NIFTYBANK",
    "NIFTYIT",
    "NIFTYAUTO",
    "NIFTYPHARMA",
    "NIFTYFMCG",
    "NIFTYMETAL",
    "NIFTYENERGY",
    "NIFTYREALTY",
)
LIVE_PHASES = {"opening", "morning", "midday", "afternoon", "closing"}
FRESH_S, DELAYED_S = 180, 600
SLOW_TTL_S = 600  # daily bars and session counts are re-read every 10 minutes
PREV_CLOSE_TOL = 0.0005  # 0.05%: feed vs stored previous-session close


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _health(name: str, status: str, detail: str, as_of: str | None = None) -> dict[str, Any]:
    return {"source": name, "status": status, "detail": detail, "as_of": as_of}


DATA_STATUS = {"fresh": "LIVE", "delayed": "DELAYED", "stale": "STALE", "historical": "HISTORICAL", "not_available": "INSUFFICIENT DATA"}
STRUCTURE_MAX_AGE_S = 180  # a breakout call needs a spot sample this fresh


class IntradayService:
    def __init__(
        self,
        observations: ObservationStore,
        history: HistoryStore,
        flows: FlowsStore,
        store: IntradayStore,
        underlying: str = "NIFTY",
        calendar: TradingCalendar | None = None,
        events: EventCalendar | None = None,
        clock: Any = None,
        market: Any = None,
    ) -> None:
        self._heavy = threading.Lock()  # one research / paper computation at a time (they are cached; this bounds the CPU a caller can cause)
        self.risk = setups.RiskConfig()  # RISK_* settings
        self.costs = CostModel()  # COST_* settings
        self.risk_free_rate = volmod.DEFAULT_RATE  # assumed discount rate (RISK_FREE_RATE); affects IV only through e^{-rT}
        self.market_error: str | None = None  # last failure of the stock-breadth summary (shown, never hidden as 'turned off')
        self.market = market  # optional MarketService: stock breadth, heavyweights, sectors
        self.obs, self.history, self.flows, self.store = observations, history, flows, store
        self.underlying = underlying
        self._cal = calendar
        self._events = events
        self._clock = clock or (lambda: datetime.now(UTC))
        self._cache: dict[tuple[str, int, int], dict[str, Any]] = {}
        self._slow: dict[tuple[str, str], tuple[float, Any]] = {}
        self._task: asyncio.Task[None] | None = None
        self.loop_note = "not started"

    # ------------------------------------------------------------------ calendars

    def calendar(self) -> TradingCalendar | None:
        if self._cal is None:
            try:
                self._cal = TradingCalendar.load()
            except Exception as e:  # noqa: BLE001 - reported in the payload
                logger.warning("trading calendar unavailable: %s", e)
        return self._cal

    def events(self) -> EventCalendar | None:
        if self._events is None:
            try:
                self._events = EventCalendar.load()
            except Exception as e:  # noqa: BLE001
                logger.warning("event calendar unavailable: %s", e)
        return self._events

    def _market_summary(self, now: datetime) -> dict[str, Any] | None:
        if self.market is None or not getattr(self.market, "enabled", False):
            return None
        try:
            out: dict[str, Any] = self.market.summary(now)
            self.market_error = None
            return out
        except Exception as e:  # noqa: BLE001 - breadth must never break the rest of the page
            logger.warning("market summary failed: %s", type(e).__name__)
            self.market_error = f"{type(e).__name__}: {e}"[:200]
            return None

    def trading_day(self, d: date) -> bool | None:
        """Exchange-calendar answer for a date (None when the calendar has no entry)."""
        return self._trading(d)

    def _trading(self, d: date) -> bool | None:
        cal = self.calendar()
        if cal is None:
            return None
        try:
            return cal.is_session(d)
        except CalendarCoverageError:
            return None

    # ------------------------------------------------------------------ inputs

    def _daily(self, key: str) -> list[DailyBar]:
        """Daily bars change twice a day at most: kept for ``SLOW_TTL_S`` (only the last 120 needed)."""
        now = _time.monotonic()
        hit = self._slow.get(("bars", key))
        if hit and now - hit[0] < SLOW_TTL_S:
            return hit[1]  # type: ignore[no-any-return]
        bars = [
            DailyBar(b.session, b.open, b.high, b.low, b.close)
            for b in self.history.bars(key)[-120:]
        ]
        self._slow[("bars", key)] = (now, bars)
        return bars

    def _session_counts(self) -> dict[str, int]:
        now = _time.monotonic()
        hit = self._slow.get(("counts", ""))
        if hit and now - hit[0] < SLOW_TTL_S:
            return hit[1]  # type: ignore[no-any-return]
        counts = self.obs.session_sample_counts(self.underlying)
        self._slow[("counts", "")] = (now, counts)
        return counts

    def _global(self, today: date) -> list[GlobalInput]:
        out = []
        for k in GLOBAL_KEYS:
            # only completed earlier sessions: a bar dated today may still be forming
            bars = [b for b in self._daily(k) if b.session < today]
            if len(bars) < 2:
                continue
            a, b = bars[-2], bars[-1]
            rets = [
                (y.close / x.close - 1) * 100
                for x, y in zip(bars[-61:], bars[-60:], strict=False)
                if x.close
            ]
            fresh = (today - b.session).days <= 4
            name = {"SPX": "S&P 500", "NDX_COMP": "Nasdaq Composite", "VIX": "CBOE VIX", "USDINR": "USD/INR",
                    "BRENT": "Brent crude", "UST10Y": "US 10Y yield", "GOLD": "Gold", "N225": "Nikkei 225",
                    "HSI": "Hang Seng", "DAX": "DAX"}[k]  # fmt: skip
            out.append(GlobalInput(k, name, b.session.isoformat(), (b.close / a.close - 1) * 100 if a.close else None,
                                   pstdev(rets) if len(rets) >= 20 else None, fresh))  # fmt: skip
        return out

    def _sectors(self, today: date, nifty_ret: float | None) -> list[dict[str, Any]]:
        out = []
        for k in SECTOR_KEYS:
            bars = [b for b in self._daily(k) if b.session < today]
            if len(bars) < 2:
                continue
            a, b = bars[-2], bars[-1]
            r = (b.close / a.close - 1) * 100
            out.append({"key": k, "name": k.replace("NIFTY", "NIFTY "), "session": b.session.isoformat(),
                        "ret_pct": r, "rel_pct": None if nifty_ret is None else r - nifty_ret})  # fmt: skip
        return sorted(out, key=lambda x: -x["ret_pct"])

    def _flows(self, prev: date | None, today: date) -> FlowInput | None:
        # only sessions before ``today``: a figure published after the close of ``today`` is not known during it, and a replay of an
        # earlier day must not see later publications
        rows = [r for r in self.flows.cash_rows() if r["session"] < today.isoformat()]
        if not rows:
            return None
        latest = max(r["session"] for r in rows)
        fii = next(
            (r["net"] for r in rows if r["session"] == latest and r["category"] == "FII/FPI"), None
        )
        dii = next(
            (r["net"] for r in rows if r["session"] == latest and r["category"] == "DII"), None
        )
        return FlowInput(latest, fii, dii, prev is not None and latest >= prev.isoformat())

    # ------------------------------------------------------------------ main

    def summary(self, expiry: str) -> dict[str, Any]:
        q0 = _time.perf_counter()
        now = self._clock()
        t = now.astimezone(IST)
        today = t.date()
        start = datetime.combine(today, OPEN, IST)
        samples = self.obs.samples(
            # up to 4 days back so the last sample before a weekend or holiday is still shown;
            # never anything after ``now`` (no look-ahead when replaying a past moment)
            self.underlying,
            expiry,
            since=start - timedelta(days=4),
            until=now,
            limit=5000,
        )
        last_id = samples[-1].sample_id if samples else -1
        key = (expiry, last_id, int(now.timestamp() // 30))
        if key in self._cache:
            return self._cache[key]
        out = self._build(expiry, now, samples)
        out["timings_ms"] = {
            "samples_query": round(
                (_time.perf_counter() - q0) * 1000 - (out["compute_ms"] or 0), 1
            ),
            **out["timings_ms"],
        }
        self._cache = {key: out}
        return out

    def _build(self, expiry: str, now: datetime, samples: list[Any], replay: bool = False) -> dict[str, Any]:  # noqa: PLR0915
        t0 = _time.perf_counter()
        marks: dict[str, float] = {}
        last_mark = [t0]

        def mark(name: str) -> None:
            n = _time.perf_counter()
            marks[name] = round((n - last_mark[0]) * 1000, 1)
            last_mark[0] = n

        t = now.astimezone(IST)
        today = t.date()
        trading = self._trading(today)
        phase = session_phase(now, trading)
        cal = self.calendar()
        prev_session: date | None = None
        try:
            prev_session = cal.prev_session(today) if cal else None
        except CalendarCoverageError:
            prev_session = None
        mark("calendar")
        nifty = self._daily("NIFTY50")
        ctx = daily_context(nifty, today)
        if prev_session is None:
            prev_session = ctx.prev_session

        mark("daily_history")
        pts_all = [Point(s.received_at, s.spot) for s in samples if s.spot is not None]
        missing_spot = sum(1 for s in samples if s.spot is None)
        pts = in_session(pts_all, today)
        session_samples = [s for s in samples if s.received_at.astimezone(IST).date() == today
                           and OPEN <= s.received_at.astimezone(IST).time() <= CLOSE]  # fmt: skip
        latest = samples[-1] if samples else None
        feed_prev = latest.prev_close if latest else None
        prev_check: dict[str, Any] | None = None
        if feed_prev and ctx.prev_close and prev_session and ctx.prev_session == prev_session:
            diff = abs(feed_prev / ctx.prev_close - 1)
            if diff > PREV_CLOSE_TOL:
                # the feed still carries an older close (e.g. before the broker rolls its day):
                # use the stored official close of the previous session and say so
                prev_check = _health(
                    "Previous close check", "warning",
                    f"feed previous close {feed_prev:,.2f} differs from the {prev_session} close "
                    f"{ctx.prev_close:,.2f} by {diff * 100:.2f}%; using the {prev_session} close",
                )  # fmt: skip
                feed_prev = None
        p = price_features(pts, now, ctx, feed_prev)

        # options: latest stored sample for this expiry (today's first in-session sample as baseline)
        chain = first_chain = None
        if latest is not None:
            chain = {
                k: Quote(c.ltp, c.oi, c.oi_prev, c.volume)
                for k, c in self.obs.contracts(latest.values_from).items()
            }
        first = session_samples[0] if session_samples else None
        if first is not None and latest is not None and first.sample_id != latest.sample_id:
            first_chain = {
                k: Quote(c.ltp, c.oi, c.oi_prev, c.volume)
                for k, c in self.obs.contracts(first.values_from).items()
            }
        o = options_features(
            chain or {}, latest.spot if latest else None, first_chain, first.spot if first else None
        )

        mark("price_and_options")
        age = (now - latest.received_at).total_seconds() if latest else None
        live = phase in LIVE_PHASES
        if latest is None:
            mode, chain_status = "unavailable", "not_available"
        elif live and age is not None and age <= FRESH_S:
            mode, chain_status = "live", "fresh"
        elif live and age is not None and age <= DELAYED_S:
            mode, chain_status = "delayed", "delayed"
        elif live:
            mode, chain_status = "stale", "stale"
        else:
            mode, chain_status = "historical", "historical"

        # scored evidence: only today's in-session samples feed price and options while the market is open
        opt_today = (
            latest is not None
            and latest.received_at.astimezone(IST).date() == today
            and bool(session_samples)
        )
        mk = None if replay else self._market_summary(now)  # a replay never reads today's live stock ticks
        glob = self._global(today)
        flow = self._flows(prev_session, today)
        comps = [
            price_component(p, ctx),
            breadth_component(mk),
            sectors_component(mk),
            options_component(o, _iso(latest.received_at) if latest else None) if opt_today
            else unavailable("options", "Options positioning", "no option-chain sample in today's session for this expiry"),
            global_component(glob),
            institutional_component(flow),
        ]  # fmt: skip
        a = assess(comps, p)
        mark("global_flows")
        ev = self.events()
        upcoming = ev.upcoming(now, days=7) if ev else []
        close_today = datetime.combine(today, CLOSE, IST)
        event_today = any(
            e.impact == "high" and e.start <= close_today + timedelta(hours=18) for e in upcoming
        )
        reg = regime(p, ctx, event_today)
        scen, scen_ruled_out = scenarios(a, p, o, ctx, reg)
        prev_score = None
        if latest is not None and a.score is not None:
            prev_score = self.store.last_before(
                expiry, latest.received_at.astimezone(UTC).isoformat(), SCORE_VERSION
            )
        changes = []
        if prev_score:
            old = {c["key"]: c for c in prev_score["components"]}
            for c in a.components:
                oc = old.get(c.key)
                if oc and oc.get("contribution") is not None and c.contribution is not None:
                    d = c.contribution - oc["contribution"]
                    if abs(d) >= 0.01:
                        changes.append({"component": c.name, "delta": d})
        changes.sort(key=lambda x: -abs(x["delta"]))

        mark("assess_regime_store")
        levels = self._levels(p, o, ctx, expiry, latest)
        health = self._health_list(
            mk, phase, chain_status, age, latest, p, ctx, prev_session, glob, flow, ev, trading
        )
        if prev_check:
            health.insert(1, prev_check)
        sectors = self._sectors(today, None)
        counts = self._session_counts()
        complete = sorted(d for d, n in counts.items() if n >= COMPLETE_SESSION_SAMPLES)
        mark("health_counts")
        result: dict[str, Any] = {
            "generated_at": now.isoformat(),
            "expiry": expiry,
            "market": {
                "date": today.isoformat(), "phase": phase, "trading_day": trading,
                "calendar_note": None if trading is not None else "exchange holiday calendar has no entry for today; weekday rule used",
                "prev_session": prev_session.isoformat() if prev_session else None,
                "mode": mode, "last_sample_at": _iso(latest.received_at) if latest else None,
                "age_seconds": age, "samples_today": len(session_samples), "missing_spot": missing_spot,
                "spot_source": "Kotak option-chain fetch (spot at each ~60 s sample)",
            },
            "price": p.public(),
            "daily": asdict(ctx) | {"prev_session": ctx.prev_session.isoformat() if ctx.prev_session else None},
            "options": o.public() | {"universe": "ATM +/-10 listed strikes"},
            "assessment": a.public(),
            "previous_score": prev_score and {k: prev_score[k] for k in ("sample_utc", "score", "label")},
            "changes": changes,
            "regime": reg,
            "scenarios": scen,
            "scenarios_ruled_out": scen_ruled_out,
            "narrative": narrative(a, p, o, reg),
            "context": self._context(a, p, o, reg, glob, upcoming, chain_status, mk),
            "stocks": mk,
            "levels": levels,
            "global": [asdict(g) for g in glob],
            "sectors": {"rows": sectors, "note": "Previous session's daily closes (Yahoo). Not intraday; not in the score."},
            "institutional": asdict(flow) if flow else None,
            "events": [e.public() for e in upcoming[:6]],
            "health": health,
            "ml": self._ml_status(len(complete), len(counts)),
            "config": {"version": SCORE_VERSION, "weights": SCORE_CONFIG["weights"], "min_coverage": SCORE_CONFIG["min_coverage"]},
            "compute_ms": None,
        }  # fmt: skip
        if not replay and latest is not None and opt_today and live and a.score is not None:
            self.store.record({
                "session": today.isoformat(), "expiry": expiry, "sample_id": latest.sample_id,
                "sample_utc": latest.received_at.astimezone(UTC).isoformat(), "version": SCORE_VERSION,
                "spot": latest.spot, "score": a.score, "label": a.label, "coverage": a.coverage,
                "regime": reg["primary"], "volatility": a.volatility,
                "components": [{"key": c.key, "score": c.score, "contribution": c.contribution, "available": c.available} for c in a.components],
            }, now=now)  # fmt: skip
        mark("record")
        fresh = live and age is not None and age <= STRUCTURE_MAX_AGE_S
        result["structure"], result["vwap"] = self._structure(mk, pts, now, fresh, replay)
        mark("structure")
        result["volatility"] = self._volatility(expiry, now, latest, session_samples, pts, chain_status)
        mark("volatility")
        result["positioning"] = self._positioning(chain, first_chain, latest, session_samples, chain_status)
        result["volatility"]["term_structure"] = self._term_structure(expiry, now, latest, result["volatility"])
        mark("positioning")
        spread = ((((mk or {}).get("flow") or {}).get("futures")) or {}).get("spread_pts")
        sctx = setups.Context(
            spot=latest.spot if latest and latest.spot else 0.0, minute=max(0, int(minutes_elapsed(now)) - 1), clock=t.time(), structure=result["structure"],
            regime=reg["primary"], daily_sd_pct=ctx.daily_sd_pct, data_live=bool(fresh), vwap=result["vwap"], spread_pts=spread, event_risk=event_today,
        )  # fmt: skip
        result["setups"] = setups.detect(sctx, self.risk, self.costs) if latest is not None and latest.spot else {"candidates": [], "decision": "NO TRADE: INSUFFICIENT EVIDENCE", "active": 0, "global_blockers": ["no spot sample"], "read_only": True}
        mark("setups")
        result["compute_ms"] = round((_time.perf_counter() - t0) * 1000, 1)
        result["timings_ms"] = marks
        return result

    def _structure(self, mk: dict[str, Any] | None, pts: list[Any], now: datetime, live: bool, replay: bool = False) -> tuple[dict[str, Any], dict[str, Any] | None]:
        """Opening-range breakout state, quality and swing structure; futures VWAP. Needs fresh spot samples to give a breakout call."""
        vb = None
        if self.market is not None and live and not replay:
            try:
                vb = self.market.vwap_block(now)
            except Exception as e:  # noqa: BLE001 - the futures VWAP must never break the page; the failure is shown
                logger.warning("futures VWAP failed: %s", type(e).__name__)
                self.market_error = f"futures VWAP: {type(e).__name__}: {e}"[:200]
        fut = ((mk or {}).get("flow") or {}).get("futures") or {}
        ad = ((mk or {}).get("nifty50") or {}).get("breadth", {}).get("ad_balance")
        side = None if not vb else {"above": "up", "below": "down"}.get(vb["side"])
        st = price_structure.analyze(pts, now, vwap_side=side, rel_volume=fut.get("relative_volume"), ad_balance=ad, live=live)
        b = st["breakout"]
        if b is not None and self.market is not None and not replay:
            stamp = now.astimezone(UTC).replace(second=0, microsecond=0).isoformat()
            self.market.store.record_sample("breakout", stamp, {"or": b["or_minutes"], "dir": b["direction"], "status": b["status"], "q": b["quality"]["score"], "ext": b["extension_ow"], "px": b["last_price"]})  # fmt: skip
        return st, vb

    def _surface_of(self, sample: Any, expiry_d: date, at: datetime) -> dict[str, Any]:
        prices = {k: c.ltp for k, c in self.obs.contracts(sample.values_from).items()}
        return volmod.surface(prices, sample.spot, expiry_d, at, self.risk_free_rate)

    def _volatility(self, expiry: str, now: datetime, latest: Any, session_samples: list[Any], pts: list[Any], chain_status: str) -> dict[str, Any]:
        """ATM IV, skew, Greeks and expected move from the latest stored chain; IV change against earlier samples of the same session."""
        if latest is None:
            return {"status": "not computed: no option-chain sample"}
        try:
            exp_d = date.fromisoformat(expiry)
        except ValueError:
            return {"status": "not computed: bad expiry"}
        at = latest.received_at
        now_s = self._surface_of(latest, exp_d, at)
        out: dict[str, Any] = now_s | {"data": DATA_STATUS[chain_status], "as_of": at.isoformat()}
        if now_s.get("status") != "ok" or now_s.get("atm_iv") is None:
            return out
        changes: dict[str, Any] = {}
        spot_chg = straddle_chg = None
        for mins in (5, 15, 30):
            ref = next((x for x in reversed(session_samples) if x.received_at <= at - timedelta(minutes=mins)), None)
            if ref is None or (at - timedelta(minutes=mins) - ref.received_at) > timedelta(minutes=3) or ref.spot is None:
                changes[str(mins)] = None
                continue
            sf = self._surface_of(ref, exp_d, ref.received_at)
            iv0 = sf.get("atm_iv") if sf.get("status") == "ok" else None
            changes[str(mins)] = None if iv0 is None else round(now_s["atm_iv"] - iv0, 3)
            if mins == 15 and iv0 is not None and latest.spot is not None:
                spot_chg = (latest.spot / ref.spot - 1) * 100
                st0, st1 = sf.get("straddle"), now_s.get("straddle")
                straddle_chg = None if not st0 or st1 is None else (st1 / st0 - 1) * 100
        out["iv_change_pts"] = changes
        rv = volmod.realized_annualised([(p.at, p.spot) for p in pts if p.at >= at - timedelta(minutes=60)])
        out["realized_vol_60m"] = None if rv is None else round(rv, 2)
        out["iv_minus_realized"] = None if rv is None else round(now_s["atm_iv"] - rv, 2)
        out["interpretation"] = volmod.interpret(spot_chg, changes.get("15"), straddle_chg) if chain_status == "fresh" else []
        return out

    def research(self, horizon: int = 15, k: float = labels.DEFAULT_K) -> dict[str, Any]:
        """Walk-forward evaluation on every stored labelled session: barrier labels from the stored spot paths, features from
        the nightly dataset (built from samples at or before each time). Probabilities are not shown unless the gate passes."""
        from app.intraday.dataset import FEATURE_VERSION

        key = ("research", horizon, k, len(self.store.feature_sessions(FEATURE_VERSION)))
        with self._heavy:
            return self._research_locked(key, horizon, k)

    def _research_locked(self, key: Any, horizon: int, k: float) -> dict[str, Any]:
        from app.intraday.dataset import FEATURE_VERSION

        hit = self._slow.get(key)
        if hit and _time.monotonic() - hit[0] < 600:
            return hit[1]  # type: ignore[no-any-return]
        rows: list[dict[str, Any]] = []
        dropped = {"ambiguous": 0, "missing": 0}
        for sess, (exp, frows) in sorted(self.store.feature_session_rows(FEATURE_VERSION).items()):
            day = date.fromisoformat(sess)
            lo = datetime.combine(day, OPEN, IST)
            samples = self.obs.samples(self.underlying, exp, since=lo, until=datetime.combine(day, CLOSE, IST), limit=2000)
            pts = in_session([Point(x.received_at, x.spot) for x in samples if x.spot is not None], day)
            ctx = daily_context([b for b in self._daily("NIFTY50") if b.session < day], day)
            by_time = {p_.at.isoformat(): i for i, p_ in enumerate(pts)}
            for stamp, feats in frows:
                i = by_time.get(datetime.fromisoformat(stamp).isoformat())
                if i is None:
                    continue
                lab = labels.label_at(pts, i, horizon, ctx.daily_sd_pct, k)
                if lab["outcome"] in evaluate.CLASSES:
                    rows.append({"session": sess, "features": feats, "outcome": lab["outcome"]})
                else:
                    dropped[lab["outcome"]] += 1
        has_vwap = any(r["features"].get("fut_vwap_dist_pct") is not None for r in rows)
        res = evaluate.walk_forward(rows, stride=max(1, horizon // 3), has_vwap=has_vwap, group_tests=True)
        res |= {"horizon_minutes": horizon, "barrier_k": k, "dropped": dropped, "effective_observations": round(len(rows) / max(1, horizon)),
                "features_version": FEATURE_VERSION, "note": "Barrier = k x daily sd x sqrt(h/375) from earlier sessions. Overlapping samples are not independent; the gate counts sessions."}  # fmt: skip
        self._slow[key] = (_time.monotonic(), res)
        return res

    def replay_sessions(self) -> dict[str, Any]:
        out = []
        for d, n in sorted(self.obs.session_sample_counts(self.underlying).items()):
            day = date.fromisoformat(d)
            lo, hi = datetime.combine(day, OPEN, IST), datetime.combine(day, CLOSE, IST)
            out.append({"session": d, "samples": n, "expiries": [e for e, _ in self.obs.day_counts(self.underlying, to_ms(lo), to_ms(hi))]})
        return {"sessions": out}

    def replay(self, session: str, expiry: str, at_hhmm: str) -> dict[str, Any]:
        """The dashboard as it stood at a past time, built only from samples stored at or before it (read-only, no live ticks, nothing recorded).
        What happened afterwards is returned separately under ``after_the_fact``."""
        day = date.fromisoformat(session)
        hh, mm = (int(x) for x in at_hhmm.split(":"))
        at = datetime.combine(day, time(hh, mm), IST)
        samples = self.obs.samples(self.underlying, expiry, since=datetime.combine(day, OPEN, IST) - timedelta(days=4), until=at, limit=5000)
        if not samples:
            return {"status": "no samples at or before that time", "session": session, "at": at.isoformat()}
        out = self._build(expiry, at, samples, replay=True)
        out.pop("ml", None)  # readiness counts reflect the present, not that moment
        full = self.obs.samples(self.underlying, expiry, since=datetime.combine(day, OPEN, IST), until=datetime.combine(day, CLOSE, IST), limit=5000)
        pts = in_session([Point(x.received_at, x.spot) for x in full if x.spot is not None], day)
        sd = daily_context([b for b in self._daily("NIFTY50") if b.session < day], day).daily_sd_pct
        i = next((k for k in range(len(pts) - 1, -1, -1) if pts[k].at <= at), None)
        after = None if i is None else {str(h): labels.label_at(pts, i, h, sd) for h in labels.HORIZONS}
        return {"status": "ok", "replay": True, "session": session, "at": at.isoformat(), "last_sample_at": samples[-1].received_at.isoformat(), "summary": out,
                "after_the_fact": after, "after_the_fact_note": "Barrier outcomes after this time; none of it was known at the time shown."}  # fmt: skip

    def paper(self) -> dict[str, Any]:
        """Cost-aware paper trading of the rule-based setups over every stored session (spot-path rules only)."""
        key = ("paper", len(self.obs.session_sample_counts(self.underlying)), self.risk, self.costs)
        with self._heavy:
            return self._paper_locked(key)

    def _paper_locked(self, key: Any) -> dict[str, Any]:
        hit = self._slow.get(key)
        if hit and _time.monotonic() - hit[0] < 600:
            return hit[1]  # type: ignore[no-any-return]
        trades: list[dict[str, Any]] = []
        n_sessions = 0
        for d, n in sorted(self.obs.session_sample_counts(self.underlying).items()):
            day = date.fromisoformat(d)
            if n < 60 or day >= self._clock().astimezone(IST).date():
                continue  # unfinished or too short
            exp = max(self.obs.day_counts(self.underlying, to_ms(datetime.combine(day, OPEN, IST)), to_ms(datetime.combine(day, CLOSE, IST))), key=lambda x: x[1], default=None)
            if exp is None:
                continue
            full = self.obs.samples(self.underlying, exp[0], since=datetime.combine(day, OPEN, IST), until=datetime.combine(day, CLOSE, IST), limit=5000)
            pts = in_session([Point(x.received_at, x.spot) for x in full if x.spot is not None], day)
            sd = daily_context([b for b in self._daily("NIFTY50") if b.session < day], day).daily_sd_pct
            n_sessions += 1
            trades += [t | {"session": d} for t in paper.simulate_session(pts, sd, self.risk, self.costs)]
        res = paper.summarize(trades, n_sessions) | {"trades_list": trades[-50:], "assumptions": {"instrument": "NIFTY future proxied by the index spot path", "lot_size": self.costs.lot_size, "slippage_pts_per_side": self.costs.slippage_pts, "risk": asdict(self.risk) | {"cutoff": f"{self.risk.cutoff:%H:%M}"}}}  # fmt: skip
        self._slow[key] = (_time.monotonic(), res)
        return res

    def _chain_of(self, sample: Any) -> dict[Any, Quote]:
        return {k: Quote(c.ltp, c.oi, c.oi_prev, c.volume) for k, c in self.obs.contracts(sample.values_from).items()}

    def _positioning(self, chain: dict[Any, Quote] | None, first_chain: dict[Any, Quote] | None, latest: Any, session_samples: list[Any], chain_status: str = "fresh") -> dict[str, Any]:
        """Window PCRs, premium/OI classification against the sample 15 minutes earlier, OI concentration and its shift since the open."""
        if latest is None or not chain:
            return {"status": "not available: no option-chain sample"}
        at = latest.received_at
        ref = next((x for x in reversed(session_samples) if x.received_at <= at - timedelta(minutes=15)), None)
        ref_chain = None if ref is None or (at - timedelta(minutes=15) - ref.received_at) > timedelta(minutes=3) else self._chain_of(ref)
        spot = latest.spot
        return {
            "status": "ok", "data": DATA_STATUS[chain_status], "as_of": at.isoformat(), "reference_minutes": 15,
            "pcr_windows": positioning.window_pcr(chain, spot),
            "oi_change_pcr_since_open": positioning.oi_change_pcr(chain, first_chain, spot),
            "classification": positioning.side_classification(chain, ref_chain, spot),
            "concentration": positioning.concentration(chain),
            "concentration_shift_since_open": positioning.concentration_shift(chain, first_chain),
        }  # fmt: skip

    def _term_structure(self, expiry: str, now: datetime, latest: Any, vol: dict[str, Any]) -> dict[str, Any]:
        """ATM IV of every expiry that has a sample within 5 minutes of the main one (same session, same moment)."""
        if latest is None or vol.get("atm_iv") is None:
            return {"rows": [], "shape": None, "reason": "no ATM IV for the selected expiry"}
        pts: list[tuple[date, float | None, float | None]] = [(date.fromisoformat(expiry), vol["time_to_expiry_days"], vol["atm_iv"])]
        at = latest.received_at
        for other in self.expiries_today():
            if other == expiry:
                continue
            ss = self.obs.samples(self.underlying, other, since=at - timedelta(minutes=5), until=at + timedelta(minutes=5), limit=1)
            if not ss or ss[-1].spot is None:
                continue
            sf = self._surface_of(ss[-1], date.fromisoformat(other), ss[-1].received_at)
            pts.append((date.fromisoformat(other), sf.get("time_to_expiry_days"), sf.get("atm_iv") if sf.get("status") == "ok" else None))
        return volmod.term_structure(pts)

    def _ml_status(self, complete_sessions: int, sessions_with_samples: int) -> dict[str, Any]:
        """Where the intraday model effort stands, from the labelled sessions actually stored."""
        from app.intraday.dataset import FEATURE_VERSION

        labelled = len(self.store.feature_sessions(FEATURE_VERSION))
        stage = max((i for i, st in enumerate(ML_STAGES) if labelled >= st["from_sessions"]), default=0)
        nxt = ML_STAGES[stage + 1] if stage + 1 < len(ML_STAGES) else None
        return {
            "status": ML_STAGES[stage]["id"], "stage_name": ML_STAGES[stage]["name"], "labelled_sessions": labelled,
            "complete_sessions": complete_sessions, "sessions_with_samples": sessions_with_samples,
            "stages": ML_STAGES, "next": None if nxt is None else {"name": nxt["name"], "at_sessions": nxt["from_sessions"], "sessions_to_go": nxt["from_sessions"] - labelled},
            "model_trained": False,
            "reason": f"{labelled} session(s) of labelled data stored (features at each sample, forward returns as labels). "
                      + (f"Next: {nxt['name'].lower()} at {nxt['from_sessions']} sessions ({nxt['from_sessions'] - labelled} to go). " if nxt else "")
                      + "No model has been trained yet; the sentiment shown is rules-based, not ML.",
        }  # fmt: skip

    # ------------------------------------------------------------------ sections

    def _levels(self, p: Any, o: Any, ctx: Any, expiry: str, latest: Any) -> list[dict[str, Any]]:
        at = _iso(p.last_at)
        rows = [
            ("Previous day high", ctx.prev_high, "Yahoo daily bar", f"NIFTY 50 high on {ctx.prev_session}", str(ctx.prev_session) if ctx.prev_session else None),
            ("Previous day low", ctx.prev_low, "Yahoo daily bar", f"NIFTY 50 low on {ctx.prev_session}", str(ctx.prev_session) if ctx.prev_session else None),
            ("Previous close", p.prev_close, p.prev_close_source or "", "official previous close", None),
            ("Sampled session high", p.sampled_high, "option-chain samples", "highest sampled spot today (ticks between samples not seen)", at),
            ("Sampled session low", p.sampled_low, "option-chain samples", "lowest sampled spot today", at),
            ("Opening range high", p.or_high, "option-chain samples", "highest sample 09:15-09:30", at),
            ("Opening range low", p.or_low, "option-chain samples", "lowest sample 09:15-09:30", at),
            ("VWAP", None, "", p.vwap_reason, None),
            ("ATM strike", o.atm_strike, "option chain", f"listed strike nearest spot, expiry {expiry}", _iso(latest.received_at) if latest else None),
            ("ATM straddle", o.straddle, "option chain", "ATM call LTP + ATM put LTP", _iso(latest.received_at) if latest else None),
            ("Largest call OI strike", o.max_ce_oi_strike, "option chain", "positioning within ATM +/-10; not a guaranteed resistance", _iso(latest.received_at) if latest else None),
            ("Largest put OI strike", o.max_pe_oi_strike, "option chain", "positioning within ATM +/-10; not a guaranteed support", _iso(latest.received_at) if latest else None),
        ]  # fmt: skip
        return [
            {"name": n, "value": v, "source": s, "method": m, "as_of": a} for n, v, s, m, a in rows
        ]

    def _health_list(self, mk: dict[str, Any] | None, phase: str, chain_status: str, age: float | None, latest: Any, p: Any, ctx: Any,
                     prev: date | None, glob: list[GlobalInput], flow: FlowInput | None, ev: Any, trading: bool | None) -> list[dict[str, Any]]:  # fmt: skip
        h = []
        if latest is None:
            h.append(
                _health("Option chain + spot", "not_available", "no stored sample for this expiry")
            )
        else:
            age = age or 0.0
            det = {"fresh": f"last sample {age:.0f} s ago", "delayed": f"last sample {age / 60:.1f} min ago",
                   "stale": f"no sample for {age / 60:.0f} min during market hours",
                   "historical": f"market {phase.replace('_', ' ')}; last sample shown is not live"}[chain_status]  # fmt: skip
            h.append(_health("Option chain + spot", chain_status, det, _iso(latest.received_at)))
        if p.max_gap_min is not None and p.max_gap_min > 5:
            h.append(
                _health(
                    "Intraday sampling gaps",
                    "warning",
                    f"largest gap between samples {p.max_gap_min:.0f} min",
                )
            )
        last_bar = ctx.prev_session
        h.append(_health("NIFTY daily history", "fresh" if last_bar and prev and last_bar >= prev else "stale",
                         f"last stored session {last_bar}; previous trading session {prev}", str(last_bar) if last_bar else None))  # fmt: skip
        h.extend(self._market_health(mk))
        if flow is None:
            h.append(_health("FII/DII cash", "not_available", "nothing stored yet"))
        else:
            h.append(_health("FII/DII cash", "fresh" if flow.fresh else "stale",
                             f"official provisional figure for {flow.session} (published after ~18:00 IST that day)", flow.session))  # fmt: skip
        spx = next((g for g in glob if g.key == "SPX"), None)
        h.append(_health("Global markets", "fresh" if spx and spx.fresh else "stale" if spx else "not_available",
                         f"latest S&P 500 daily bar {spx.session}" if spx else "no stored US bars", spx.session if spx else None))  # fmt: skip
        h.append(
            _health(
                "Economic calendar",
                "fresh" if ev else "api_failure",
                "verified reference calendar loaded" if ev else "calendar file failed to load",
            )
        )
        h.append(_health("Exchange calendar", "fresh" if trading is not None else "warning",
                         "NSE holiday list covers today" if trading is not None else "today is outside the verified holiday list"))  # fmt: skip
        h.append(
            _health(
                "Intraday ML model",
                "not_available",
                "not trained: not enough complete intraday sessions",
            )
        )
        return h

    def _market_health(self, mk: dict[str, Any] | None) -> list[dict[str, Any]]:
        if mk is None:
            err = self.market_error
            why = f"stock breadth failed: {err}" if err else "stock breadth is turned off"
            st = "api_failure" if err else "not_available"
            return [_health("Market breadth", st, why), _health("Intraday sector data", st, why)]
        why = _no_stocks_reason(mk)
        b50, b5 = mk["nifty50"]["breadth"], mk["nifty500"]["breadth"]
        out = []
        if b50["covered"]:
            status = "fresh" if b50["coverage"] >= 0.9 else "warning"
            out.append(_health("Market breadth", status, f"NIFTY 50: {b50['covered']}/{b50['total']} priced; NIFTY 500: {b5['covered']}/{b5['total']} priced", mk["generated_at"]))
            n_sec = sum(1 for r in mk["sectors"]["nifty500"] if r.get("equal_weight_return") is not None)
            out.append(_health("Intraday sector data", "fresh" if n_sec >= 6 else "warning", f"{n_sec} sectors with a return (equal-weighted NIFTY 500 stocks)", mk["generated_at"]))
        else:
            out += [_health("Market breadth", "not_available", why), _health("Intraday sector data", "not_available", why)]
        w = mk["nifty50"].get("weights")
        out.append(_health("Index weights", "fresh" if w and not w["approximate"] else "warning" if w else "not_available",
                           f"{'approximate' if w and w['approximate'] else 'official'} weights as of {w['as_of']}" if w else "no weights loaded: heavyweight contribution is not shown", w["as_of"] if w else None))  # fmt: skip
        vb = mk["sources"]["volume_baseline"]
        out.append(_health("Volume baseline", "fresh" if vb["stocks"] else "not_available", f"{vb['stocks']} stocks with a 20-day average ({vb['sessions']} of {vb['needs_sessions']} sessions needed)"))  # fmt: skip
        return out

    @staticmethod
    def _breadth_answer(mk: dict[str, Any] | None, q: Callable[[str, str], dict[str, str]]) -> dict[str, str]:
        title = "Broad or concentrated participation?"
        n50 = (mk or {}).get("nifty50")
        if not n50 or n50["breadth"]["covered"] == 0:
            return q(title, f"Unknown: {_no_stocks_reason(mk)}.")
        b, qual = n50["breadth"], n50["quality"]
        head = f"NIFTY 50: {b['advancing']} up, {b['declining']} down, {b['flat']} flat of {b['covered']} priced"
        b5 = mk["nifty500"]["breadth"] if mk else None
        if b5 and b5["covered"]:
            head += f"; NIFTY 500: {b5['advancing']} up / {b5['declining']} down of {b5['covered']}"
        label = {"broad_confirmed": "broad and confirmed by volume", "broad": "broad (volume not confirmed)", "narrow": "narrow, a few stocks carry it",
                 "thin": "thin, volume below normal", "mixed": "mixed", "no_move": "no real index move yet", "unknown": "not enough stocks priced"}[qual["state"]]  # fmt: skip
        return q(title, f"{head}. Move quality: {label}" + (f" ({'; '.join(qual['reasons'])})" if qual["reasons"] else "") + " (provisional rule).")

    @staticmethod
    def _sector_answer(mk: dict[str, Any] | None, q: Callable[[str, str], dict[str, str]]) -> dict[str, str]:
        title = "Sectors confirming?"
        rows = [r for r in (mk or {}).get("sectors", {}).get("nifty500", []) if r.get("equal_weight_return") is not None]
        if len(rows) < 3:
            return q(title, f"Unknown: {_no_stocks_reason(mk)}.")
        lead, lag = rows[0], rows[-1]
        up = sum(1 for r in rows if r["equal_weight_return"] > 0)
        return q(title, f"{up} of {len(rows)} sectors are up. Leading: {lead['sector']} {lead['equal_weight_return']:+.2f}%; lagging: {lag['sector']} {lag['equal_weight_return']:+.2f}% (equal-weighted NIFTY 500 stocks).")

    def _context(
        self,
        a: Any,
        p: Any,
        o: Any,
        reg: dict[str, Any],
        glob: list[GlobalInput],
        upcoming: list[Any],
        chain_status: str,
        mk: dict[str, Any] | None = None,
    ) -> list[dict[str, str]]:
        def q(question: str, answer: str) -> dict[str, str]:
            return {"question": question, "answer": answer}

        r30 = p.returns_pct.get(30)
        out = [
            q("Trending or rotating?", f"{reg['primary']} ({reg['reason']})"),
            self._breadth_answer(mk, q),
            self._sector_answer(mk, q),
        ]
        if o.pcr_oi_change is not None and r30 is not None:
            if o.pcr_oi_change == 0 or r30 == 0:
                verdict = "no change yet in one of them."
            elif (o.pcr_oi_change > 0) == (r30 > 0):
                verdict = "same direction (conventional reading)."
            else:
                verdict = "diverging."
            out.append(q("Options positioning vs price?", f"PCR (OI) {o.pcr_oi_change:+.2f} since the first sample, price {r30:+.2f}% in 30 min: "
                         + verdict))  # fmt: skip
        else:
            out.append(q("Options positioning vs price?", "Not enough samples yet."))
        if o.straddle_change_pct is not None:
            out.append(
                q(
                    "Volatility rising or falling?",
                    f"{a.volatility} realized ({a.volatility_detail}); ATM straddle {o.straddle_change_pct:+.1f}% since the first sample (includes time decay).",
                )
            )
        else:
            out.append(
                q(
                    "Volatility rising or falling?",
                    f"{a.volatility} realized ({a.volatility_detail}).",
                )
            )
        if p.last is not None and p.or_high is not None and p.or_low is not None:
            where = "above" if p.last > p.or_high else "below" if p.last < p.or_low else "inside"
            out.append(
                q(
                    "Accepting or rejecting levels?",
                    f"{p.last:,.2f} is {where} the opening range {p.or_low:,.2f}-{p.or_high:,.2f}.",
                )
            )
        else:
            out.append(
                q(
                    "Accepting or rejecting levels?",
                    "Opening range not formed yet (needs 3 samples 09:15-09:30).",
                )
            )
        spx = next((g for g in glob if g.key == "SPX"), None)
        if spx and spx.ret_pct is not None:
            out.append(
                q(
                    "Global conditions?",
                    f"S&P 500 {spx.ret_pct:+.2f}% on {spx.session}"
                    + ("" if spx.fresh else " (stale)")
                    + ".",
                )
            )
        hi = [e for e in upcoming if e.impact == "high"]
        out.append(q("Important event approaching?", f"{hi[0].name} at {hi[0].start.astimezone(IST):%d %b %H:%M} IST"
                     + ("" if hi[0].time_verified else " (time unconfirmed)") if hi else "No high-impact event in the next 7 days."))  # fmt: skip
        out.append(q("Data fresh enough?", {"fresh": "Yes.", "delayed": "Delayed: interpret with care.", "stale": "No: samples have stopped.",
                                             "historical": "Market not in session; values are from the last samples.",
                                             "not_available": "No data."}[chain_status]))  # fmt: skip
        return out

    # ------------------------------------------------------------------ background recording

    def expiries_today(self) -> list[str]:
        now = self._clock()
        today = now.astimezone(IST).date()
        lo = datetime.combine(today, OPEN, IST)
        return [e for e, _ in self.obs.day_counts(self.underlying, to_ms(lo), to_ms(now))]

    async def _loop(self) -> None:
        while True:
            try:
                now = self._clock()
                if session_phase(now, self._trading(now.astimezone(IST).date())) in LIVE_PHASES:
                    for e in self.expiries_today():
                        await asyncio.to_thread(self.summary, e)
                    self.loop_note = f"recorded at {now.astimezone(IST):%H:%M} IST"
            except Exception as e:  # noqa: BLE001 - must never stop collection
                self.loop_note = f"error: {type(e).__name__}: {e}"
                logger.exception("intraday scoring loop failed")
            await asyncio.sleep(60)

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
