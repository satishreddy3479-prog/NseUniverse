"""Builds the Market Sentiment Command Center payload from the stores the backend already keeps.

Sources (all real, all stored locally):
* observations.sqlite3: ~60-second option-chain samples (spot + every contract) in market hours.
* market_history.sqlite3: daily bars (NIFTY 50 and India VIX).
* nse_flows.sqlite3: NSE FII/DII provisional cash figures (previous session at best).
* reference/events.json: verified economic calendar.
Every section says where it came from, when it was observed and how fresh it is.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time as _time
from collections import OrderedDict
from collections.abc import Callable, Sequence
from dataclasses import asdict
from datetime import UTC, date, datetime, time, timedelta
from time import perf_counter
from typing import Any

from app.domain.session import market_time, session_close
from app.intraday import (
    backtest,
    gex_history,
    labels,
    momentum,
    paper,
    positioning,
    price_structure,
    setups,
    strike_positioning,
)
from app.intraday import hv as hvmod
from app.intraday import volatility as volmod
from app.intraday.costs import CostModel
from app.intraday.features import (
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
    _no_stocks_reason,
    assess,
    breadth_component,
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


#: a day with fewer changed in-session samples than this is not a session (an exchange holiday leaves a handful of stale samples)
MIN_SESSION_SAMPLES = 10


class _Bounded(dict):  # type: ignore[type-arg]
    """A dict that forgets its oldest entries beyond ``maxlen``: results keyed by a changing value (a row count, a minute) cannot pile up for days."""

    def __init__(self, maxlen: int) -> None:
        super().__init__()
        self.maxlen = maxlen

    def __setitem__(self, key: Any, value: Any) -> None:
        super().__setitem__(key, value)
        while len(self) > self.maxlen:
            del self[next(iter(self))]


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
        # per-sample derived features of the backtest and GEX history: a stored sample never changes, so an entry is valid for as long as the
        # feature code (FEATURE_VERSION), the rate and the opening ATM it was built with are the same; bounded so it cannot grow without limit
        self._feat_cache: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()
        self._bt_results: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()
        self._bt_job: dict[str, Any] | None = None
        self._bt_lock = threading.Lock()
        self._iv_cache: dict[tuple[Any, ...], dict[str, Any]] = {}  # one entry: the latest IV series
        self._slow: dict[Any, tuple[float, Any]] = _Bounded(48)  # cached slow results, keyed by (kind, ...); the oldest are dropped
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
                           and OPEN <= s.received_at.astimezone(IST).time() <= session_close()]  # fmt: skip
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
        flow = self._flows(prev_session, today)
        comps = [
            price_component(p, ctx),
            breadth_component(mk),
            sectors_component(mk),
            options_component(o, _iso(latest.received_at) if latest else None) if opt_today
            else unavailable("options", "Options positioning", "no option-chain sample in today's session for this expiry"),
            institutional_component(flow),
        ]  # fmt: skip
        a = assess(comps, p)
        mark("global_flows")
        ev = self.events()
        upcoming = ev.upcoming(now, days=7) if ev else []
        close_today = datetime.combine(today, session_close(), IST)
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
            mk, phase, chain_status, age, latest, p, ctx, prev_session, flow, ev, trading
        )
        if prev_check:
            health.insert(1, prev_check)
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
            "context": self._context(a, p, o, reg, upcoming, chain_status, mk),
            "stocks": mk,
            "levels": levels,
            "institutional": asdict(flow) if flow else None,
            "events": [e.public() for e in upcoming[:6]],
            "health": health,
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

    def _surface_of(self, sample: Any, expiry_d: date, at: datetime, each_side: int = 15) -> dict[str, Any]:
        prices = {k: c.ltp for k, c in self.obs.contracts(sample.values_from).items()}
        # time to expiry counts from the market time the prices belong to, not from an after-hours fetch
        return volmod.surface(prices, sample.spot, expiry_d, market_time(at, self._trading), self.risk_free_rate, each_side)

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
        out: dict[str, Any] = now_s | {"data": DATA_STATUS[chain_status], "as_of": at.isoformat(), "valued_at": market_time(at, self._trading).isoformat()}
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

    def hv(self) -> dict[str, Any]:
        """Historical volatility of NIFTY 50 from the stored final daily closes (10/20/30/60 days and a 20-day series)."""
        today = self._clock().astimezone(IST).date()
        bars = self.history.bars("NIFTY50")
        prov = self._provisional_bar(bars)
        report = hvmod.hv_report([*bars, prov] if prov is not None else bars, today)
        report["provisional"] = None if prov is None else {"date": str(prov.session), "close": prov.close}
        report["iv_by_session"] = self.iv_history()
        report["iv_by_session_note"] = (
            "ATM implied volatility at the end of each stored session, nearest expiry with at least 2 days left (the expiry is named)."
        )
        return report

    def _provisional_bar(self, bars: list[Any]) -> Any:
        """The newest stored session newer than the last daily bar, as a one-price bar (close = last in-session index level
        of our own feed), or None. The daily history is published by Yahoo the next morning, so the latest day would
        otherwise be missing from HV / RV; this day is flagged provisional wherever it is shown and is never stored."""
        from app.prediction.targets import Bar

        if not bars:
            return None
        sessions = self.iv_sessions(3)
        if not sessions or date.fromisoformat(sessions[-1]) <= bars[-1].session:
            return None
        day = date.fromisoformat(sessions[-1])
        if (day - bars[-1].session).days > hvmod.MAX_GAP_DAYS or day > self._clock().astimezone(IST).date():
            return None
        lo, hi = datetime.combine(day, OPEN, IST), datetime.combine(day, session_close(), IST)
        counts = self.obs.day_counts(self.underlying, to_ms(lo), to_ms(hi))
        if not counts:
            return None
        best = max(counts, key=lambda c: c[1])[0]
        spots = [s.spot for s in self.obs.samples(self.underlying, best, since=lo, until=hi, limit=5000) if s.spot]
        return Bar(day, spots[-1], spots[-1], spots[-1], spots[-1]) if spots else None

    def iv_chart(self, window: int = 21) -> dict[str, Any]:
        """Daily India VIX (implied volatility), NIFTY close and rolling HV / RV from the stored daily history, plus the
        latest session as a flagged provisional day when the daily history is a day behind."""
        nifty = self.history.bars("NIFTY50")
        out = hvmod.iv_chart(nifty, self.history.bars("INDIAVIX"), window, provisional=self._provisional_bar(nifty))
        own = {r["date"]: r for r in self.iv_history(sessions=60, min_days_left=5, far=True)}
        out["own_iv"] = [own[d]["atm_iv"] if d in own else None for d in out["dates"]]
        out["own_iv_expiry"] = [own[d]["expiry"] if d in own else None for d in out["dates"]]
        out["own_iv_note"] = "ATM implied volatility of the farthest stored expiry with 5+ days left (the monthly), from the last stored snapshot of each session; exists only for sessions whose option chains were stored"
        return out

    def iv_sessions(self, limit: int = 30) -> list[str]:
        """IST dates with stored in-session samples, newest last."""
        counts = self.obs.session_sample_counts(self.underlying)
        return sorted(d for d, n in counts.items() if n >= MIN_SESSION_SAMPLES)[-limit:]

    def _session_samples(self, expiry: str, session: str | None, now: datetime) -> dict[str, Any]:
        """The in-session stored samples of one session of ``expiry`` (the latest unless ``session`` is given): ``exp_d``, ``day``,
        ``todays``; or a ``status`` saying why there are none."""
        try:
            exp_d = date.fromisoformat(expiry)
        except ValueError:
            return {"status": "bad expiry"}
        try:
            want = date.fromisoformat(session) if session else None
        except ValueError:
            return {"status": "bad session"}
        if want is None:
            start = datetime.combine(now.astimezone(IST).date(), OPEN, IST)
            samples = self.obs.samples(self.underlying, expiry, since=start - timedelta(days=4), until=now, limit=5000)
        else:
            lo = datetime.combine(want, OPEN, IST)
            samples = self.obs.samples(self.underlying, expiry, since=lo, until=datetime.combine(want, session_close(), IST), limit=5000)
        if not samples:
            return {"status": "no stored option-chain sample for this expiry"}
        day = samples[-1].received_at.astimezone(IST).date()
        todays = [s for s in samples if s.received_at.astimezone(IST).date() == day and OPEN <= s.received_at.astimezone(IST).time() <= session_close()]
        if not todays:
            return {"status": "no stored sample inside the session"}
        return {"exp_d": exp_d, "day": day, "todays": todays}

    def iv_momentum(self, expiry: str, session: str | None = None, tf: int = 1) -> dict[str, Any]:
        """Call-versus-put IV momentum for one stored session of ``expiry``: CE and PE IV at ATM, 25 and 10 delta through the session,
        and the change since 1, 5, 15, 30 and 60 minutes earlier and since the previous stored session's close (see ``momentum.py``)."""
        now = self._clock()
        sel = self._session_samples(expiry, session, now)
        if "status" in sel:
            return {"status": sel["status"], "expiry": expiry, "series": [], "table": None}
        exp_d, day, todays = sel["exp_d"], sel["day"], sel["todays"]
        key = ("mom", expiry, str(todays[-1].sample_id), len(todays), tf)
        if key in self._iv_cache:
            return self._iv_cache[key]
        if tf > 1:
            last: dict[int, Any] = {}
            for s in todays:
                t_ = s.received_at.astimezone(IST)
                last[int((t_.hour * 60 + t_.minute - (OPEN.hour * 60 + OPEN.minute)) // tf)] = s
            todays = list(last.values())
        pts = [momentum.delta_point(s.received_at, s.spot, self._surface_of(s, exp_d, s.received_at, 25)) for s in todays]
        prev: dict[str, Any] | None = None
        prev_day: str | None = None
        lo_prev = datetime.combine(day - timedelta(days=6), OPEN, IST)
        before = self.obs.samples(self.underlying, expiry, since=lo_prev, until=datetime.combine(day, OPEN, IST), limit=5000)
        closes = [s for s in before if s.received_at.astimezone(IST).date() < day and s.received_at.astimezone(IST).time() <= session_close() and s.spot is not None]
        if closes:
            c = closes[-1]
            prev = momentum.delta_point(c.received_at, c.spot, self._surface_of(c, exp_d, c.received_at, 25))
            prev_day = c.received_at.astimezone(IST).date().isoformat()
        valid = [p for p in pts if p["spot"] is not None]
        out = {
            "status": "ok" if valid else "no implied volatility could be computed", "expiry": expiry, "session": day.isoformat(),
            "tf_minutes": tf, "samples_in_session": len(todays), "previous_session": prev_day,
            "latest_at": todays[-1].received_at.isoformat(), "age_seconds": round((now - todays[-1].received_at).total_seconds(), 1),
            "table": momentum.momentum_table(valid, prev), "series": momentum.series(valid),
            "excluded": len(pts) - len(valid),
            "model": "Black-76; forward from put-call parity", "rate_assumed": self.risk_free_rate,
        }
        self._iv_cache = {key: out}
        return out

    def strike_positioning(self, expiry: str, window: str = "15", session: str | None = None) -> dict[str, Any]:
        """Strike-by-strike positioning of the newest stored chain of a session against the snapshot ``window`` minutes earlier
        (5, 15, 30, 60), the session's first snapshot (``open``) or the previous session's last (``prev``). See ``strike_positioning.py``."""
        now_t = self._clock()
        sel = self._session_samples(expiry, session, now_t)
        if "status" in sel:
            return {"status": sel["status"], "expiry": expiry, "rows": []}
        exp_d, day, todays = sel["exp_d"], sel["day"], sel["todays"]
        latest = todays[-1]
        if latest.spot is None:
            return {"status": "newest stored sample has no NIFTY price", "expiry": expiry, "rows": []}
        key = ("pos", expiry, str(latest.sample_id), window)
        if key in self._iv_cache:
            return self._iv_cache[key]
        then = None
        label = window
        if window == "open":
            then = todays[0] if len(todays) > 1 else None
        elif window == "prev":
            lo = datetime.combine(day - timedelta(days=6), OPEN, IST)
            before = self.obs.samples(self.underlying, expiry, since=lo, until=datetime.combine(day, OPEN, IST), limit=5000)
            closes = [x for x in before if x.received_at.astimezone(IST).date() < day and x.received_at.astimezone(IST).time() <= session_close() and x.spot is not None]
            then = closes[-1] if closes else None
        elif window.isdigit():
            target = latest.received_at - timedelta(minutes=int(window))
            tol = timedelta(minutes=2 if int(window) <= 5 else 5)
            cands = [x for x in todays[:-1] if x.received_at <= target and x.spot is not None]
            then = cands[-1] if cands and target - cands[-1].received_at <= tol else None
        else:
            return {"status": "bad window", "expiry": expiry, "rows": []}
        chain_now = self.obs.contracts(latest.values_from)
        chain_then = self.obs.contracts(then.values_from) if then is not None else None
        sf_now = self._surface_of(latest, exp_d, latest.received_at, 200)
        sf_then = self._surface_of(then, exp_d, then.received_at, 200) if then is not None else None
        rows = strike_positioning.strike_table(chain_now, chain_then, sf_now if sf_now.get("status") == "ok" else None, sf_then if sf_then and sf_then.get("status") == "ok" else None)
        atm_now = sf_now.get("atm_strike") if sf_now.get("status") == "ok" else None
        atm_then = sf_then.get("atm_strike") if sf_then and sf_then.get("status") == "ok" else None
        spot_pct = None if then is None or not then.spot else round((latest.spot / then.spot - 1) * 100, 4)
        out = {
            "status": "ok", "expiry": expiry, "session": day.isoformat(), "window": label, "at": latest.received_at.isoformat(),
            "then_at": None if then is None else then.received_at.isoformat(), "age_seconds": round((now_t - latest.received_at).total_seconds(), 1),
            "spot": latest.spot, "spot_then": None if then is None else then.spot, "spot_change_pct": spot_pct, "atm_strike": atm_now, "atm_strike_then": atm_then,
            "samples_in_session": len(todays), "rows": rows,
            "baskets": strike_positioning.baskets(chain_now, chain_then, atm_now, atm_then),
            "demand": strike_positioning.demand(rows, atm_now, spot_pct) if then is not None else [],
            "model": "Black-76; forward from put-call parity", "rate_assumed": self.risk_free_rate,
            "note": None if then is not None else "no stored snapshot for the chosen comparison: changes are not available",
        }
        self._iv_cache = {key: out}
        return out

    # ------------------------------------------------------------------ backtest and GEX history (shared per-sample features)
    FEATURE_VERSION = 3
    FEATURE_CACHE_MAX = 15000
    #: uncached snapshots a request may compute itself; more than this runs as a background job with progress
    SYNC_SNAPSHOTS = 60

    def _bt_plan(self, expiry: str, sessions: int) -> dict[str, Any]:
        """Which stored samples a run reads: the last sample of every 5-minute bucket of the last ``sessions`` sessions (in-session only),
        found with one indexed query, before any calculation. Also each session's opening ATM (nearest listed strike to the first spot)."""
        t0 = perf_counter()
        try:
            exp_d = date.fromisoformat(expiry)
        except ValueError:
            return {"error": "bad expiry"}
        now_t = self._clock()
        lo = datetime.combine(now_t.astimezone(IST).date() - timedelta(days=int(sessions * 1.6) + 5), OPEN, IST)
        by_day: dict[str, dict[int, Any]] = {}
        first: dict[str, Any] = {}
        for x in self.obs.samples(self.underlying, expiry, since=lo, until=now_t, limit=60000):
            if x.spot is None:
                continue
            t_ = x.received_at.astimezone(IST)
            if not OPEN <= t_.time() <= session_close():
                continue
            d_ = t_.date().isoformat()
            first.setdefault(d_, x)
            by_day.setdefault(d_, {})[(t_.hour * 60 + t_.minute) // 5] = x
        days = sorted(by_day)[-sessions:]
        opening: dict[str, float | None] = {}
        for d_ in days:
            ks = sorted({k for k, _ in self.obs.contracts(first[d_].values_from)})
            opening[d_] = min(ks, key=lambda k: (abs(k - first[d_].spot), k)) if ks else None
        return {"exp_d": exp_d, "days": days, "by_day": by_day, "opening": opening, "read_ms": (perf_counter() - t0) * 1000}

    def _fkey(self, x: Any, opening: float | None) -> tuple[Any, ...]:
        return (x.sample_id, self.FEATURE_VERSION, self.risk_free_rate, opening)

    def _feature(self, x: Any, exp_d: date, opening: float | None, timing: dict[str, float]) -> dict[str, Any]:
        """Everything the backtests need from one stored sample, computed once: IV features (ATM, 25 and 10 delta, skew, butterfly), OI sums,
        and the reconstructed GEX of the fixed, dynamic and full universes. ``{"skip": reason}`` when the chain cannot be solved."""
        key = self._fkey(x, opening)
        hit = self._feat_cache.get(key)
        if hit is not None:
            self._feat_cache.move_to_end(key)
            timing["cached"] = timing.get("cached", 0) + 1
            return hit
        t0 = perf_counter()
        ch = self.obs.contracts(x.values_from)
        t1 = perf_counter()
        sf = self._surface_of(x, exp_d, x.received_at, 400)
        t2 = perf_counter()
        if sf.get("status") != "ok":
            feat: dict[str, Any] = {"skip": str(sf.get("status"))}
        else:
            pt = momentum.delta_point(x.received_at, x.spot, sf)
            sk = volmod.skew_metrics(sf["rows"], sf["forward"], sf.get("atm_iv"))
            atm = sf.get("atm_strike")
            near = {k for k, _ in ch if atm is not None and abs(k - atm) <= 10 * 50}
            t_yr = volmod.years_to_expiry(exp_d, market_time(x.received_at, self._trading))
            gx = gex_history.reconstruct(sf["rows"], ch, float(x.spot), float(sf["forward"]), t_yr, self.risk_free_rate, opening)
            extra: dict[str, float | None] = {}
            for u, lv in gx["universes"].items():
                for k_ in ("ce", "pe", "net", "abs", "flip", "near_net", "call_wall", "put_wall", "peak", "fd_flip_both", "fd_flip_lo", "fd_flip_hi", "fd_crossings", "fd_slope", "fd_net_share"):
                    extra[f"{u}.{k_}"] = None if lv is None else lv[k_]
                extra[f"{u}.used"] = None if lv is None else float(lv["used"])
            feat = {
                "at": x.received_at, "spot": float(x.spot), "skew25": sk["skew_25d"], "butterfly25": sk["butterfly_25d"], "atm_iv": sf.get("atm_iv"),
                "ce25": pt["d25"]["ce"], "pe25": pt["d25"]["pe"],
                "oi_ce": sum(c.oi for (k, sd), c in ch.items() if sd == 0 and k in near and c.oi is not None) or None,
                "oi_pe": sum(c.oi for (k, sd), c in ch.items() if sd == 1 and k in near and c.oi is not None) or None,
                "extra": extra, "missing": gx["missing"],
            }
        t3 = perf_counter()
        timing["contracts_ms"] = timing.get("contracts_ms", 0.0) + (t1 - t0) * 1000
        timing["solve_ms"] = timing.get("solve_ms", 0.0) + (t2 - t1) * 1000
        timing["gex_ms"] = timing.get("gex_ms", 0.0) + (t3 - t2) * 1000
        timing["computed"] = timing.get("computed", 0) + 1
        self._feat_cache[key] = feat
        while len(self._feat_cache) > self.FEATURE_CACHE_MAX:
            self._feat_cache.popitem(last=False)
        return feat

    def _bt_snaps(self, plan: dict[str, Any], timing: dict[str, float], progress: dict[str, Any] | None = None) -> tuple[list[backtest.Snap], dict[str, Any]]:
        snaps: list[backtest.Snap] = []
        skipped: dict[str, int] = {}
        for d_ in plan["days"]:
            for _b, x in sorted(plan["by_day"][d_].items()):
                before = timing.get("computed", 0)
                f = self._feature(x, plan["exp_d"], plan["opening"][d_], timing)
                if progress is not None and timing.get("computed", 0) > before:
                    progress["done"] += 1
                    _time.sleep(0.001)  # yield the interpreter to the API threads: a long job must not starve live requests
                if "skip" in f:
                    skipped[f["skip"]] = skipped.get(f["skip"], 0) + 1
                    continue
                snaps.append(backtest.Snap(at=f["at"], session=d_, spot=f["spot"], skew25=f["skew25"], butterfly25=f["butterfly25"], atm_iv=f["atm_iv"], ce25=f["ce25"], pe25=f["pe25"], oi_ce=f["oi_ce"], oi_pe=f["oi_pe"], extra=dict(f["extra"])))
        return snaps, skipped

    def _bt_result(self, plan: dict[str, Any], expiry: str, cost_bps: float, universe: str, timing: dict[str, float], elapsed_ms: float) -> dict[str, Any]:
        snaps, skipped = self._bt_snaps(plan, timing)
        hs = [*backtest.HYPOTHESES, *backtest.gex_hypotheses(universe)]
        tests = [backtest.run(snaps, h, cost_bps) for h in hs] if snaps else []
        keys = (f"{universe}.net", f"{universe}.flip", f"{universe}.call_wall", f"{universe}.put_wall", f"{universe}.peak", f"{universe}.near_net")
        recon = {k.split(".", 1)[1]: sum(1 for x in snaps if x.extra.get(k) is not None) for k in keys}
        return {
            "status": "ok" if snaps else "no stored sessions with a solvable chain for this expiry", "expiry": expiry, "universe": universe, "sessions": plan["days"],
            "snapshots": len(snaps), "horizon_minutes": backtest.HORIZON_MIN, "oos_share": backtest.OOS_SHARE, "min_events": backtest.MIN_EVENTS, "cost_bps": cost_bps,
            "tests": tests, "not_testable": [{"id": i, "title": t, "reason": r} for i, t, r in backtest.NOT_TESTABLE],
            "reconstruction": {"snapshots_with": recon, "snapshots_skipped": skipped, "opening_atm": plan["opening"]},
            "timing": {"plan_read_ms": round(plan["read_ms"], 1), "total_ms": round(elapsed_ms, 1), **{k: round(v, 1) for k, v in timing.items()}},
            "note": "Signals are tested against NIFTY, not against an options position: option spreads, theta and gamma are not modelled. GEX history is rebuilt from the stored chains (prices and open interest) at each snapshot; the sign (calls +, puts −) is a model assumption.",
        }

    def backtest(self, expiry: str, sessions: int = 15, cost_bps: float = 5.0, universe: str = "dynamic") -> dict[str, Any]:
        """Out-of-sample test of the options and GEX signals against NIFTY's next 30 minutes, over the last ``sessions`` stored sessions of
        ``expiry`` (5-minute snapshots). Small requests are answered at once; a request that needs more than ``SYNC_SNAPSHOTS`` uncomputed
        snapshots runs as one background job (one at a time) and answers with progress until it is done. Features are cached per stored sample."""
        if universe not in ("fixed", "dynamic", "full"):
            return {"status": "bad universe", "tests": []}
        t0 = perf_counter()
        plan = self._bt_plan(expiry, sessions)
        if "error" in plan:
            return {"status": plan["error"], "tests": []}
        days = plan["days"]
        newest = max(plan["by_day"][days[-1]].values(), key=lambda x: x.sample_id).sample_id if days else None
        key = ("bt", expiry, tuple(days), newest, cost_bps, universe, self.FEATURE_VERSION, self.risk_free_rate)
        done = self._bt_results.get(key)
        if done is not None:
            return done
        total = sum(len(plan["by_day"][d_]) for d_ in days)
        job = self._bt_job
        if job is not None and job["key"] == key:  # the job for this very request answers it: never start a second computation of the same features
            if job["state"] == "failed":
                return {"status": f"failed: {job['error']}", "tests": []}
            if job["state"] == "running":
                return {"status": "computing", "expiry": expiry, "progress": {"done": job["done"], "total": job["total"]}, "tests": []}
        pending = [x for d_ in days for x in plan["by_day"][d_].values() if self._fkey(x, plan["opening"][d_]) not in self._feat_cache]
        if len(pending) <= self.SYNC_SNAPSHOTS:
            out = self._bt_result(plan, expiry, cost_bps, universe, {}, (perf_counter() - t0) * 1000)
            self._store_result(key, out)
            return out
        with self._bt_lock:
            job = self._bt_job
            if job is not None and job["state"] == "running" and job["key"] != key:
                return {"status": "busy", "message": "another large backtest is running; try again when it finishes", "progress": {"done": job["done"], "total": job["total"]}, "tests": []}
            if job is not None and job["key"] == key:
                if job["state"] == "failed":
                    return {"status": f"failed: {job['error']}", "tests": []}
                return {"status": "computing", "expiry": expiry, "progress": {"done": job["done"], "total": job["total"], "uncached": len(pending)}, "tests": []}
            job = {"key": key, "state": "running", "done": total - len(pending), "total": total, "error": None}
            self._bt_job = job

            def work() -> None:
                try:
                    timing: dict[str, float] = {}
                    tw = perf_counter()
                    self._bt_snaps(plan, timing, job)
                    out = self._bt_result(plan, expiry, cost_bps, universe, timing, (perf_counter() - tw) * 1000)
                    self._store_result(key, out)
                    job["state"] = "done"
                except Exception as exc:  # noqa: BLE001
                    job["state"], job["error"] = "failed", f"{type(exc).__name__}: {exc}"[:200]
                    logger.warning("backtest_job_failed", extra={"fields": {"error": job["error"]}})

            threading.Thread(target=work, name="backtest-job", daemon=True).start()
        return {"status": "computing", "expiry": expiry, "progress": {"done": job["done"], "total": total, "uncached": len(pending)}, "tests": []}

    def _store_result(self, key: tuple[Any, ...], out: dict[str, Any]) -> None:
        self._bt_results[key] = out
        while len(self._bt_results) > 6:
            self._bt_results.popitem(last=False)

    def gex_history(self, expiry: str, session: str | None = None, universe: str = "dynamic") -> dict[str, Any]:
        """The GEX and gamma flip rebuilt at each 5-minute snapshot of one stored session (the latest unless given), from the stored prices
        and open interest only; a snapshot that cannot be solved is listed as skipped with its reason, never filled."""
        if universe not in ("fixed", "dynamic", "full"):
            return {"status": "bad universe", "points": []}
        plan = self._bt_plan(expiry, 60)
        if "error" in plan:
            return {"status": plan["error"], "points": []}
        day = session if session else (plan["days"][-1] if plan["days"] else None)
        if day is None or day not in plan["by_day"]:
            return {"status": "no stored session", "points": [], "sessions": plan["days"]}
        timing: dict[str, float] = {}
        pts, skipped = [], []
        for _b, x in sorted(plan["by_day"][day].items()):
            f = self._feature(x, plan["exp_d"], plan["opening"][day], timing)
            if "skip" in f:
                skipped.append({"at": x.received_at.isoformat(), "reason": f["skip"]})
                continue
            pts.append({"at": f["at"].isoformat(), "spot": f["spot"], **{k.split(".", 1)[1]: v for k, v in f["extra"].items() if k.startswith(f"{universe}.")}})
        return {"status": "ok" if pts else "no solvable snapshot", "expiry": expiry, "session": day, "universe": universe, "sessions": plan["days"], "opening_atm": plan["opening"][day], "points": pts, "skipped": skipped,
                "timing": {k: round(v, 1) for k, v in timing.items()}, "units": "₹ crore per 1 % move; calls +, puts − (model sign)"}

    def premium_baskets(self, expiry: str, session: str | None = None, n: int | None = 10, kind: str = "fixed") -> dict[str, Any]:
        """Aggregate call and put premium of an ATM +/- ``n`` basket (``None`` = all strikes), fixed or dynamically recentred, at each
        5-minute stored snapshot of a session, with the change since the first snapshot and the premium asymmetry. See ``basket_series``."""
        if kind not in ("fixed", "dynamic"):
            return {"status": "bad kind", "points": []}
        now_t = self._clock()
        sel = self._session_samples(expiry, session, now_t)
        if "status" in sel:
            return {"status": sel["status"], "expiry": expiry, "points": []}
        day, todays = sel["day"], sel["todays"]
        last: dict[int, Any] = {}
        for x in todays:
            t_ = x.received_at.astimezone(IST)
            if x.spot is not None:
                last[(t_.hour * 60 + t_.minute) // 5] = x
        samples = [last[b] for b in sorted(last)]
        key = ("prem", expiry, str(samples[-1].sample_id) if samples else "", n, kind)
        if key in self._iv_cache:
            return self._iv_cache[key]
        pts = [{"at": x.received_at.isoformat(), "spot": x.spot, "chain": self.obs.contracts(x.values_from)} for x in samples]
        series = strike_positioning.basket_series(pts, n, kind)
        label = "ATM ±" + str(n) if n is not None else "all strikes"
        out = {
            "status": "ok" if series else "no snapshot with call and put premiums", "expiry": expiry, "session": day.isoformat(), "kind": kind, "window": n,
            "snapshots": len(samples), "points": series, "age_seconds": round((now_t - todays[-1].received_at).total_seconds(), 1),
            "latest_at": todays[-1].received_at.isoformat(),
            "basket": label + (" fixed at the first snapshot ATM" if kind == "fixed" else ", recentred on each snapshot ATM"),
        }
        self._iv_cache = {key: out}
        return out

    def iv_series(self, expiry: str, max_points: int = 90, session: str | None = None, tf: int = 1) -> dict[str, Any]:
        """At-the-money implied volatility through one stored session of this expiry (the latest unless ``session`` is given),
        the last snapshot of each ``tf``-minute candle counted from the open, thinned to at most ``max_points``. Same model
        and inputs as the command center's IV."""
        now = self._clock()
        sel = self._session_samples(expiry, session, now)
        if "status" in sel:
            return {"status": sel["status"], "expiry": expiry, "points": []}
        exp_d, day, todays = sel["exp_d"], sel["day"], sel["todays"]
        if tf > 1:
            def bucket(s: Any) -> int:
                t_ = s.received_at.astimezone(IST)
                return int((t_.hour * 60 + t_.minute - (OPEN.hour * 60 + OPEN.minute)) // tf)

            last: dict[int, Any] = {}
            for s in todays:
                last[bucket(s)] = s
            todays = list(last.values())
        key = (expiry, str(todays[-1].sample_id), len(todays), max_points, tf)
        if key in self._iv_cache:
            return self._iv_cache[key]
        stride = max(1, -(-len(todays) // max_points))
        pick = todays[::stride]
        if pick[-1] is not todays[-1]:
            pick.append(todays[-1])
        points: list[dict[str, Any]] = []
        for s in pick:
            sf = self._surface_of(s, exp_d, s.received_at)
            ok = sf.get("status") == "ok"
            points.append({
                "at": s.received_at.isoformat(), "spot": s.spot,
                "forward": sf.get("forward") if ok else None,
                "atm_iv": sf.get("atm_iv") if ok else None,
                "straddle": sf.get("straddle") if ok else None,
                "skew": sf.get("skew_25d_put_minus_call") if ok else None,
                "days": sf.get("time_to_expiry_days"),
                "note": None if ok else sf.get("status"),
            })
        valid = [p["atm_iv"] for p in points if p["atm_iv"] is not None]
        out = {
            "status": "ok" if valid else "no implied volatility could be computed",
            "expiry": expiry, "session": day.isoformat(), "is_today": day == now.astimezone(IST).date(), "tf_minutes": tf,
            "samples_in_session": len(todays), "points_shown": len(points), "thinned_every": stride,
            "latest_at": todays[-1].received_at.isoformat(),
            "age_seconds": round((now - todays[-1].received_at).total_seconds(), 1),
            "high": max(valid) if valid else None, "low": min(valid) if valid else None,
            "model": "Black-76; forward from put-call parity", "rate_assumed": self.risk_free_rate,
            "points": points,
        }
        self._iv_cache = {key: out}
        return out

    def expiry_sessions(self, expiry: str) -> list[str]:
        """The sessions (IST dates) with in-session stored samples of ``expiry``, oldest first: what a comparison can be made against."""
        now = self._clock()
        lo = datetime.combine(now.astimezone(IST).date() - timedelta(days=120), OPEN, IST)
        days: set[str] = set()
        for x in self.obs.samples(self.underlying, expiry, since=lo, until=now, limit=60000):
            t_ = x.received_at.astimezone(IST)
            if x.spot is not None and OPEN <= t_.time() <= session_close():
                days.add(t_.date().isoformat())
        return sorted(days)

    def iv_skew(self, expiry: str, each_side: int = 15, session: str | None = None) -> dict[str, Any]:
        """Smile of the newest stored chain of ``expiry`` (or the last in-session chain of ``session``): out-of-the-money IV by strike,
        skew measures, and the same measures for every expiry that has a sample within 5 minutes of it (term view). Comparing two
        sessions always uses the same expiry: the call for each session is made with the same ``expiry``."""
        try:
            exp_d = date.fromisoformat(expiry)
        except ValueError:
            return {"status": "bad expiry", "smile": [], "term": []}
        now = self._clock()
        if session:
            sel = self._session_samples(expiry, session, now)
            if "status" in sel:
                return {"status": sel["status"], "expiry": expiry, "smile": [], "term": []}
            ss = sel["todays"]
        else:
            start = datetime.combine(now.astimezone(IST).date(), OPEN, IST)
            ss = self.obs.samples(self.underlying, expiry, since=start - timedelta(days=4), until=now, limit=5000)
        if not ss or ss[-1].spot is None:
            return {"status": "no stored option-chain sample for this expiry", "expiry": expiry, "smile": [], "term": []}
        latest = ss[-1]
        sf = self._surface_of(latest, exp_d, latest.received_at, each_side)
        if sf.get("status") != "ok":
            return {"status": str(sf.get("status")), "expiry": expiry, "smile": [], "term": []}
        rows = sf["rows"]
        smile = [{"strike": r["strike"], "side": r["side"], "iv": r["iv"], "delta": r["delta"]} for r in rows if r["otm"]]
        cards = volmod.skew_metrics(rows, sf["forward"], sf.get("atm_iv"))
        term: list[dict[str, Any]] = []
        at = latest.received_at
        sday = at.astimezone(IST).date()  # the session the chain belongs to (not "today": it is read after the close too)
        lo_s, hi_s = datetime.combine(sday, OPEN, IST), datetime.combine(sday, session_close(), IST)
        for other, _n in self.obs.day_counts(self.underlying, to_ms(lo_s), to_ms(hi_s)):
            if other == expiry:
                of = sf
            else:
                os_ = self.obs.samples(self.underlying, other, since=at - timedelta(minutes=5), until=at + timedelta(minutes=5), limit=1)
                if not os_ or os_[-1].spot is None:
                    continue
                of = self._surface_of(os_[-1], date.fromisoformat(other), os_[-1].received_at, each_side)
            if of.get("status") != "ok":
                continue
            m = volmod.skew_metrics(of["rows"], of["forward"], of.get("atm_iv"))
            term.append({"expiry": other, "days": of.get("time_to_expiry_days"), "atm_iv": of.get("atm_iv"), **m})
        term.sort(key=lambda x: x["days"] or 0.0)
        structure = volmod.iv_term_structure(term)
        term_slope = structure["slope_per_30d"]
        return {
            "status": "ok", "expiry": expiry, "at": at.isoformat(), "age_seconds": round((now - at).total_seconds(), 1),
            "spot": latest.spot, "forward": sf["forward"], "atm_strike": sf["atm_strike"], "atm_iv": sf.get("atm_iv"),
            "days": sf.get("time_to_expiry_days"), "cards": {**cards, "term_slope_per_30d": term_slope},
            "smile": smile, "term": term, "term_structure": structure, "session": sday.isoformat(), "sessions": self.expiry_sessions(expiry),
            "model": "Black-76; forward from put-call parity", "rate_assumed": self.risk_free_rate,
        }

    def iv_history(self, sessions: int = 20, min_days_left: int = 2, far: bool = False) -> list[dict[str, Any]]:
        """ATM implied volatility at the end of each stored session, for the IV against HV chart.

        Per session: the nearest expiry that still has at least ``min_days_left`` calendar days to run (so the figure is not
        the wild last-day IV of an expiring contract; if none, the best-covered expiry), read from the last stored
        in-session snapshot of that expiry. The expiry is named, because IV differs a little between expiries.
        With ``far`` the farthest stored expiry with enough days left is used (the monthly), which keeps one maturity from
        day to day instead of switching between the weekly and the monthly."""
        out: list[dict[str, Any]] = []
        for d, _n in [(d, n) for d, n in sorted(self.obs.session_sample_counts(self.underlying).items()) if n >= MIN_SESSION_SAMPLES][-sessions:]:
            day = date.fromisoformat(d)
            lo, hi = datetime.combine(day, OPEN, IST), datetime.combine(day, session_close(), IST)
            counts = [(e, n) for e, n in self.obs.day_counts(self.underlying, to_ms(lo), to_ms(hi)) if n >= 10]
            if not counts:
                continue
            ahead = [(e, n) for e, n in counts if (date.fromisoformat(e) - day).days >= min_days_left]
            exp = (max(ahead) if far else min(ahead))[0] if ahead else max(counts, key=lambda x: x[1])[0]
            smp = self.obs.samples(self.underlying, exp, since=lo, until=hi, limit=5000)
            if not smp:
                continue
            last = smp[-1]
            sf = self._surface_of(last, date.fromisoformat(exp), last.received_at)
            if sf.get("status") != "ok" or sf.get("atm_iv") is None:
                continue
            out.append({"date": d, "atm_iv": sf["atm_iv"], "expiry": exp, "days_to_expiry": sf.get("time_to_expiry_days"), "at": last.received_at.isoformat()})
        return out

    def forward_check(self, expiry: str) -> dict[str, Any]:
        """What NIFTY did after each stored rules-based score (see forward.py); cached for ten minutes."""
        from app.intraday.forward import score_forward

        key = ("forward", expiry, self.store.count())
        hit = self._slow.get(key)
        if hit and _time.monotonic() - hit[0] < 600:
            return hit[1]  # type: ignore[no-any-return]
        sessions: dict[str, Sequence[dict[str, Any]]] = {d: self.store.session_rows(d, expiry, limit=2000) for d in self.store.score_sessions(expiry)}
        res = score_forward(sessions)
        self._slow[key] = (_time.monotonic(), res)
        return res

    def replay_sessions(self) -> dict[str, Any]:
        out = []
        for d, n in sorted(self.obs.session_sample_counts(self.underlying).items()):
            day = date.fromisoformat(d)
            lo, hi = datetime.combine(day, OPEN, IST), datetime.combine(day, session_close(), IST)
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
        full = self.obs.samples(self.underlying, expiry, since=datetime.combine(day, OPEN, IST), until=datetime.combine(day, session_close(), IST), limit=5000)
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
            exp = max(self.obs.day_counts(self.underlying, to_ms(datetime.combine(day, OPEN, IST)), to_ms(datetime.combine(day, session_close(), IST))), key=lambda x: x[1], default=None)
            if exp is None:
                continue
            full = self.obs.samples(self.underlying, exp[0], since=datetime.combine(day, OPEN, IST), until=datetime.combine(day, session_close(), IST), limit=5000)
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
                     prev: date | None, flow: FlowInput | None, ev: Any, trading: bool | None) -> list[dict[str, Any]]:  # fmt: skip
        h = []
        if latest is None:
            h.append(
                _health("Option chain + spot", "not_available", "no stored sample for this expiry")
            )
        else:
            if age is None:  # an unknown age is said to be unknown, never shown as "0 s ago"
                det = f"last sample at {_iso(latest.received_at)} (age not known)"
            else:
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
        h.append(
            _health(
                "Economic calendar",
                "fresh" if ev else "api_failure",
                "verified reference calendar loaded" if ev else "calendar file failed to load",
            )
        )
        h.append(_health("Exchange calendar", "fresh" if trading is not None else "warning",
                         "NSE holiday list covers today" if trading is not None else "today is outside the verified holiday list"))  # fmt: skip
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
