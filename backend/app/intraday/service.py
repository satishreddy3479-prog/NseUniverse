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
import time as _time
from dataclasses import asdict
from datetime import UTC, date, datetime, timedelta
from statistics import pstdev
from typing import Any

from app.intraday.features import (
    CLOSE,
    IST,
    OPEN,
    DailyBar,
    Point,
    Quote,
    daily_context,
    in_session,
    options_features,
    price_features,
    session_phase,
)
from app.intraday.sentiment import (
    SCORE_CONFIG,
    SCORE_VERSION,
    FlowInput,
    GlobalInput,
    assess,
    global_component,
    institutional_component,
    narrative,
    options_component,
    price_component,
    regime,
    scenarios,
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
ML_MIN_SESSIONS = 60
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
    ) -> None:
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

    def _flows(self, prev: date | None) -> FlowInput | None:
        rows = self.flows.cash_rows()
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

    def _build(self, expiry: str, now: datetime, samples: list[Any]) -> dict[str, Any]:  # noqa: PLR0915
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
        glob = self._global(today)
        flow = self._flows(prev_session)
        comps = [
            price_component(p, ctx),
            unavailable("breadth", "Market breadth", "no NIFTY 50 constituent feed is collected yet (advances/declines unknown)"),
            unavailable("sectors", "Sector participation", "only previous-session daily sector closes are stored; no intraday sector data"),
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
            phase, chain_status, age, latest, p, ctx, prev_session, glob, flow, ev, trading
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
            "context": self._context(a, p, o, reg, glob, upcoming, chain_status),
            "levels": levels,
            "global": [asdict(g) for g in glob],
            "sectors": {"rows": sectors, "note": "Previous session's daily closes (Yahoo). Not intraday; not in the score."},
            "institutional": asdict(flow) if flow else None,
            "events": [e.public() for e in upcoming[:6]],
            "health": health,
            "ml": {
                "status": "not_trained",
                "complete_sessions": len(complete),
                "required_sessions": ML_MIN_SESSIONS,
                "sessions_with_samples": len(counts),
                "reason": f"{len(complete)} complete market-hours sessions stored (need {ML_MIN_SESSIONS} with >= {COMPLETE_SESSION_SAMPLES} samples each "
                          "before a model is trained and walk-forward tested). The sentiment above is rules-based, not ML.",  # fmt: skip
            },
            "config": {"version": SCORE_VERSION, "weights": SCORE_CONFIG["weights"], "min_coverage": SCORE_CONFIG["min_coverage"]},
            "compute_ms": None,
        }  # fmt: skip
        if latest is not None and opt_today and live and a.score is not None:
            self.store.record({
                "session": today.isoformat(), "expiry": expiry, "sample_id": latest.sample_id,
                "sample_utc": latest.received_at.astimezone(UTC).isoformat(), "version": SCORE_VERSION,
                "spot": latest.spot, "score": a.score, "label": a.label, "coverage": a.coverage,
                "regime": reg["primary"], "volatility": a.volatility,
                "components": [{"key": c.key, "score": c.score, "contribution": c.contribution, "available": c.available} for c in a.components],
            }, now=now)  # fmt: skip
        mark("record")
        result["compute_ms"] = round((_time.perf_counter() - t0) * 1000, 1)
        result["timings_ms"] = marks
        return result

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

    def _health_list(self, phase: str, chain_status: str, age: float | None, latest: Any, p: Any, ctx: Any,
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
        h.append(
            _health(
                "Market breadth",
                "not_available",
                "no constituent advance/decline feed is collected",
            )
        )
        h.append(
            _health("Intraday sector data", "not_available", "only daily sector closes are stored")
        )
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

    def _context(
        self,
        a: Any,
        p: Any,
        o: Any,
        reg: dict[str, Any],
        glob: list[GlobalInput],
        upcoming: list[Any],
        chain_status: str,
    ) -> list[dict[str, str]]:
        def q(question: str, answer: str) -> dict[str, str]:
            return {"question": question, "answer": answer}

        r30 = p.returns_pct.get(30)
        out = [
            q("Trending or rotating?", f"{reg['primary']} ({reg['reason']})"),
            q(
                "Broad or concentrated participation?",
                "Unknown: no constituent breadth data is collected yet.",
            ),
            q(
                "Sectors confirming?",
                "Unknown intraday: only previous-session sector closes are stored.",
            ),
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
