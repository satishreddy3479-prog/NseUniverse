"""Daily swing paper-trading job: settle the session that just closed, then scan for the next one.

After 17:00 IST (Yahoo's daily bar is final; the server rule is heavy jobs after 16:30) it
  1. reads the Chartink quality list and the daily bars,
  2. settles the orders queued at the previous close against today's bar (fills, skips, stops, trailing),
  3. scans every stock, applies the market/sector gates and queues orders for the next session.
It is idempotent (a session is committed once, whole or not at all), catches up missed sessions in
order, and refuses to act on incomplete data. Paper only: nothing here can place a real order.
Memory stays small because one stock's history is held at a time.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import threading
from dataclasses import asdict
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from time import monotonic
from typing import Any
from zoneinfo import ZoneInfo

from app.logging_setup import log_event
from app.swing import minute_rules as mr
from app.swing.engine import (
    MAX_DIST,
    MIN_DIST,
    RULE_VERSION,
    Bar,
    Config,
    make_orders,
    settle_session,
)
from app.swing.fetch import Fetcher, FetchError
from app.swing.indicators import Bars, Setup, analyse, stage2_ok
from app.swing.store import PaperStore

IST = ZoneInfo("Asia/Kolkata")
logger = logging.getLogger(__name__)

NIFTY = "^NSEI"
SECTOR_INDICES = {
    "CNXAUTO": "^CNXAUTO", "NSEBANK": "^NSEBANK", "CNXPSUBANK": "^CNXPSUBANK", "CNXENERGY": "^CNXENERGY",
    "CNXFMCG": "^CNXFMCG", "CNXINFRA": "^CNXINFRA", "CNXIT": "^CNXIT", "CNXMETAL": "^CNXMETAL",
    "CNXPHARMA": "^CNXPHARMA", "CNXREALTY": "^CNXREALTY", "CNXPSE": "^CNXPSE",
}
DEFAULT_SECTOR = "CNXINFRA"  # the specification's default for stocks it cannot map
MIN_FETCH_RATIO = 0.90       # below this share of the Chartink list the scan is not trusted
MAX_CATCH_UP = 250           # more missed sessions than this needs a human decision


def load_sector_map(path: Path | None = None) -> dict[str, str]:
    p = path or Path(__file__).with_name("sectors.json")
    return dict(json.loads(p.read_text(encoding="utf-8"))["map"])


class SwingPaperService:
    def __init__(self, store: PaperStore, fetcher: Fetcher, *, sectors: dict[str, str] | None = None,
                 cfg: Config | None = None, enabled: bool = True, run_after: time = time(17, 0),
                 until: time = time(23, 30), retry_s: float = 900.0, clock: Any = None) -> None:
        self.store, self.fetcher, self.cfg = store, fetcher, cfg or Config()
        self.sectors = sectors if sectors is not None else load_sector_map()
        self.enabled, self.run_after, self.until, self.retry_s = enabled, run_after, until, retry_s
        self._clock = clock or (lambda: datetime.now(UTC))
        self.done_on: date | None = None
        #: called with (session, decisions, trades) after a session is committed (the live paper ledger reconciles here); never allowed to fail the run
        self.on_session: Any = None
        #: called with (session, candidate orders) once the evening scan has queued them: the scan hands the same candidates to every book, and each book keeps its own copy
        self.on_candidates: Any = None
        self._nse_days: dict[str, dict[str, Any]] = {}  # session -> NSE bhavcopy bars, one download per session per pass
        self._filled: list[tuple[str, str]] = []  # (stock, session) bars taken from NSE instead of Yahoo in this pass
        self.last_attempt: datetime | None = None
        self.last_result = "not run yet"
        self._running = False
        self._lock = threading.Lock()  # one scan at a time, whoever starts it
        self.progress: dict[str, Any] | None = None
        self._manual: asyncio.Task[dict[str, Any]] | None = None
        self._task: asyncio.Task[None] | None = None

    # ---- scheduling
    def due(self, now: datetime | None = None) -> bool:
        now = now or self._clock()
        t = now.astimezone(IST)
        if not self.enabled or self._running or self.done_on == t.date():
            return False
        if not self.run_after <= t.time() < self.until:
            return False
        return self.last_attempt is None or (now - self.last_attempt).total_seconds() >= self.retry_s

    @staticmethod
    def expected_session(today: date) -> date:
        d = today
        while d.weekday() >= 5:
            d -= timedelta(days=1)
        return d

    def run_once(self, source: str = "schedule") -> dict[str, Any]:
        """One catch-up pass. Never raises: failures are recorded and retried later.
        Only one pass runs at a time: a second caller gets `busy` and changes nothing."""
        if not self._lock.acquire(blocking=False):
            return {"state": "busy", "detail": "a scan is already running"}
        try:
            return self._run_locked(source)
        finally:
            self.progress = None
            self._lock.release()

    def trigger(self) -> bool:
        """Start a pass in the background now (the 'Run scan now' button). Returns False if one is running.
        The pass is the same one the schedule runs; it uses the last finished session."""
        if self._lock.locked() or (self._manual is not None and not self._manual.done()):
            return False
        self._manual = asyncio.create_task(self._run_in_thread("manual"), name="swing-paper-manual")
        self._manual.add_done_callback(self._log_manual_failure)
        return True

    @staticmethod
    def _log_manual_failure(task: asyncio.Task[dict[str, Any]]) -> None:
        if not task.cancelled() and (err := task.exception()) is not None:
            log_event(logger, logging.ERROR, "swing_paper_manual_failed", error=type(err).__name__)

    async def _run_in_thread(self, source: str) -> dict[str, Any]:
        """Run one pass in a thread of its own. The scan lasts minutes; on the shared worker pool (five
        threads on this server, also used by every broker call) it would hold one of them all that time."""
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()

        def deliver(result: dict[str, Any] | None, error: Exception | None) -> None:
            if fut.done():  # the waiter may have been cancelled at shutdown
                return
            if error is not None:
                fut.set_exception(error)
            else:
                fut.set_result(result or {})

        def work() -> None:
            try:
                result = self.run_once(source)
            except Exception as e:  # noqa: BLE001 - run_once catches its own failures; this is the last safety net
                loop.call_soon_threadsafe(deliver, None, e)
            else:
                loop.call_soon_threadsafe(deliver, result, None)

        threading.Thread(target=work, name="swing-paper-scan", daemon=True).start()
        return await fut

    def _fill_from_nse(self, sym: str, raw: list[Any], sessions: list[str], nifty_close: dict[str, float]) -> list[Any]:
        """A session NIFTY traded but this stock has no bar for (Yahoo sometimes sends the row without prices) is read
        from NSE's own bhavcopy instead, for that one day. Without a second source the gap stays a gap."""
        nse_day = getattr(self.fetcher, "nse_day", None)
        have = {r[0] for r in raw}
        gaps = [s for s in sessions if s not in have and s in nifty_close]
        if nse_day is None or not gaps:
            return raw
        out = list(raw)
        for s in gaps:
            if s not in self._nse_days:
                self._nse_days[s] = nse_day(s)
            bar = self._nse_days[s].get(sym)
            if bar is not None:
                out.append(bar)
                self._filled.append((sym, s))
        out.sort(key=lambda r: r[0])
        return out

    def _step(self, phase: str, done: int | None = None, total: int | None = None) -> None:
        started = self.progress["started_at"] if self.progress else self._clock().astimezone(UTC).isoformat(timespec="seconds")
        self.progress = {"phase": phase, "done": done, "total": total, "started_at": started}

    def _run_locked(self, source: str) -> dict[str, Any]:
        now = self._clock()
        began = monotonic()
        log_event(logger, logging.INFO, "swing_paper_start", source=source)
        self._running = True
        self.last_attempt = now
        self._step("Checking the latest finished session")
        try:
            result = self._process(now)
        except FetchError as e:
            result = {"state": "data_unavailable", "detail": str(e)}
        except Exception as e:  # noqa: BLE001 - the scheduler must survive; the error is visible in status
            log_event(logger, logging.ERROR, "swing_paper_error", error=type(e).__name__)
            result = {"state": "error", "detail": type(e).__name__}
        finally:
            self._running = False
        self.last_result = f"{result['state']}" + (f": {result['detail']}" if result.get("detail") else "")
        with contextlib.suppress(Exception):
            self.store.set_meta("last_run_at", now.astimezone(UTC).isoformat(timespec="seconds"))
            self.store.set_meta("last_result", self.last_result)
        today = now.astimezone(IST).date()
        latest = result.get("session")
        if result["state"] in ("ok", "up_to_date") and latest and date.fromisoformat(latest) >= self.expected_session(today):
            self.done_on = today
        log_event(logger, logging.INFO, "swing_paper_run", state=result["state"], session=result.get("session"),
                  sessions=result.get("sessions"), candidates=result.get("candidates"), detail=result.get("detail"),
                  source=source, seconds=round(monotonic() - began, 1))
        return result

    # ---- the job
    def _process(self, now: datetime) -> dict[str, Any]:
        cfg = self.cfg
        self._nse_days, self._filled = {}, []
        book, last, no, pending = self.store.load_state(cfg)
        nifty = self.fetcher.daily(NIFTY)
        if not nifty:
            raise FetchError("no NIFTY 50 bars")
        latest = nifty[-1][0]
        if last == latest:
            return {"state": "up_to_date", "session": latest}
        dates = [b[0] for b in nifty]
        sessions = [latest] if last is None else [d for d in dates if d > last]
        if not sessions:
            return {"state": "up_to_date", "session": last}
        if len(sessions) > MAX_CATCH_UP:
            raise FetchError(f"{len(sessions)} sessions missed: too many to replay safely")
        nifty_close = {b[0]: b[4] for b in nifty}
        nifty_closes_to = {s: [b[4] for b in nifty[: dates.index(s) + 1]] for s in sessions}

        # sector index closes for the gates
        sector_closes: dict[str, dict[str, float]] = {}
        for code, ticker in SECTOR_INDICES.items():
            try:
                sector_closes[code] = {b[0]: b[4] for b in self.fetcher.daily(ticker)}
            except FetchError:
                sector_closes[code] = {}

        self._step("Reading the Chartink list")
        rows = self.fetcher.universe()
        symbols = sorted({str(r["nsecode"]) for r in rows})
        if not symbols:
            raise FetchError("the Chartink list is empty")
        must = {p for p in book.positions} | {o.symbol for o in pending}
        bars_at: dict[str, dict[str, Bar]] = {s: {} for s in sessions}
        setups_at: dict[str, dict[str, Setup]] = {s: {} for s in sessions}
        ok = 0
        failed_must: list[str] = []
        todo = sorted(set(symbols) | must)
        for k, sym in enumerate(todo):
            if k % 10 == 0:
                self._step("Downloading prices", k, len(todo))
            try:
                raw = self.fetcher.daily(f"{sym}.NS")
            except FetchError:
                if sym in must:
                    failed_must.append(sym)
                continue
            if len(raw) < 2:
                if sym in must:
                    failed_must.append(sym)
                continue
            raw = self._fill_from_nse(sym, raw, sessions, nifty_close)
            ok += sym in symbols
            bars = Bars([r[0] for r in raw], [r[1] for r in raw], [r[2] for r in raw], [r[3] for r in raw],
                        [r[4] for r in raw], [r[5] for r in raw], [nifty_close.get(r[0]) for r in raw])
            where = {d: i for i, d in enumerate(bars.dates)}
            for s in sessions:
                i = where.get(s)
                if i is None:
                    continue
                bars_at[s][sym] = Bar(s, bars.o[i], bars.h[i], bars.low[i], bars.c[i], bars.v[i])
                st = analyse(bars, i)
                if st is not None:
                    setups_at[s][sym] = st
        if failed_must:
            raise FetchError(f"no bars for held or queued stocks: {', '.join(sorted(failed_must)[:5])}")
        if ok < MIN_FETCH_RATIO * len(symbols):
            raise FetchError(f"only {ok} of {len(symbols)} stocks had usable bars; scan not trusted")

        self._step("Scoring, settling and queuing orders")
        defaulted = sum(1 for s in symbols if s not in self.sectors)
        for s in sessions:
            # A held or queued stock with no bar for this day (a data hole at the source, not a market fact) must not
            # become a permanent "skipped: no price bar" decision or a silently untested stop: retry later instead.
            absent = sorted((set(book.positions) | {o.symbol for o in pending}) - set(bars_at[s]))
            if absent:
                raise FetchError(
                    f"no price bar on {s} for held or queued stocks ({', '.join(absent[:5])}); "
                    "nothing is recorded for that day, retrying"
                )
            no += 1
            settle = settle_session(book, s, no, bars_at[s], setups_at[s], pending, cfg)
            nifty_gate = stage2_ok(nifty_closes_to[s], long=False)
            sect_gate: dict[str, bool | None] = {}
            for code, by_date in sector_closes.items():
                closes = [v for d, v in sorted(by_date.items()) if d <= s]
                sect_gate[code] = stage2_ok(closes) if by_date else None
            gates = {sym: bool(nifty_gate) and bool(sect_gate.get(self.sectors.get(sym, DEFAULT_SECTOR))) for sym in setups_at[s]}
            orders, blocked = make_orders(
                s, setups_at[s], {sym: self.sectors.get(sym, DEFAULT_SECTOR) for sym in setups_at[s]}, gates, cfg)
            closes = nifty_closes_to[s]
            scan = {
                "universe_size": len(symbols), "fetched_ok": ok, "sectors_defaulted": defaulted, "capital": cfg.capital,
                "nifty_close": closes[-1], "nifty_ok": nifty_gate, "blocked": blocked,
                "nifty_sma50": sum(closes[-50:]) / 50 if len(closes) >= 50 else None,
                "sectors": [{"code": c, "ok": g} for c, g in sect_gate.items()],
                "note": "; ".join(x for x in (
                    "" if len(sessions) == 1 else f"catch-up of {len(sessions)} sessions",
                    (lambda f: f"{len(f)} bar(s) from NSE's bhavcopy because Yahoo sent none: {', '.join(sorted({a for a, _ in f})[:6])}")(
                        [(a, b) for a, b in self._filled if b == s]) if any(b == s for _, b in self._filled) else "",
                ) if x),
            }
            self.store.commit_session(
                session=s, no=no, ran_at=now, rule_version=RULE_VERSION, scan=scan,
                universe=symbols if s == latest else None, orders=orders, decisions=settle.decisions,
                trades=settle.trades, book=book, invested=settle.invested, nifty_close=nifty_close[s])
            if self.on_session is not None:
                try:
                    self.on_session(s, settle.decisions, settle.trades)
                except Exception as e:  # noqa: BLE001 - the official record is already committed; a ledger problem must not fail the run
                    log_event(logger, logging.ERROR, "swing_live_ledger_reconcile_failed", error=type(e).__name__)
            # the next session's orders are the ones just queued (ids come from the database)
            _, _, _, pending = self.store.load_state(cfg)
            if self.on_candidates is not None:
                try:
                    self.on_candidates(s, pending)
                except Exception as e:  # noqa: BLE001 - the official record is already committed; the live book's copy is retried by its own seeding
                    log_event(logger, logging.ERROR, "swing_candidate_handover_failed", error=type(e).__name__)
        return {"state": "ok", "session": latest, "sessions": len(sessions), "candidates": len(pending),
                "filled": sum(d.outcome == "filled" for d in settle.decisions), "closed": len(settle.trades)}

    def view(self) -> dict[str, Any]:
        """Everything the Swing page shows for the paper book (read-only)."""
        snap = self.store.snapshot()
        cfg, eq = self.cfg, snap["equity"]
        cap = float(snap["meta"].get("capital", cfg.capital))
        last = eq[-1] if eq else None
        positions = []
        for p in snap["positions"]:
            stage = "initial stop" if p["tsl"] <= p["initial_sl"] + 1e-9 else (
                "breakeven" if p["tsl"] <= p["fill"] * cfg.be_buf + 1e-9 else "trailing")
            positions.append(p | {
                "value": p["shares"] * p["last_close"], "unrealized_pnl": p["shares"] * (p["last_close"] - p["fill"]),
                "unrealized_pct": (p["last_close"] / p["fill"] - 1) * 100, "stop_stage": stage,
                "risk_to_stop_pct": (1 - p["tsl"] / p["last_close"]) * 100})
        first_nifty = next((r["nifty_close"] for r in eq if r["nifty_close"]), None)
        last_nifty = last["nifty_close"] if last else None
        book = {
            "capital": cap, "equity": last["equity"] if last else cap, "cash": last["cash"] if last else cap,
            "invested": last["invested"] if last else 0.0, "open_positions": len(positions), "slots": cfg.slots,
            "return_pct": ((last["equity"] / cap - 1) * 100) if last else 0.0, "as_of": last["session"] if last else None,
            "started": snap["meta"].get("started"), "sessions": len(eq),
            "nifty_return_pct": ((last_nifty / first_nifty - 1) * 100) if first_nifty and last_nifty else None,
        }
        t = snap["trade_totals"]
        totals = {"closed": t["n"], "wins": t["wins"], "net_pnl": t["pnl"], "costs": t["costs"]}
        return {
            "status": self.status(), "book": book, "positions": positions, "orders": snap["orders"], "scan": snap["scan"],
            "decisions": snap["decisions"], "trades": snap["trades"], "trade_totals": totals, "equity": snap["equity"],
            "recent_runs": snap["recent_runs"],
            "config": {"capital": cfg.capital, "slots": cfg.slots, "risk_pct": cfg.risk_pct * 100, "min_score": cfg.min_score,
                       "cost_per_side_pct": cfg.cost_per_side * 100, "cooldown": cfg.cooldown, "rule_version": RULE_VERSION,
                       # every number the Rules tab quotes, from the engine itself so the page cannot drift from the rules
                       "params": {**asdict(cfg), "dist_min": MIN_DIST, "dist_max": MAX_DIST, "min_fetch_ratio": MIN_FETCH_RATIO},
                       "live": {"entry_from_min": mr.ENTRY_FROM_MIN, "entry_until_min": mr.ENTRY_UNTIL_MIN, "day1_check_min": mr.D1_CHECK_MIN, "chase_cap": mr.CHASE_CAP,
                                "wick_fraction": mr.WICK_FRACTION, "straight_line_judge_min": mr.STRAIGHT_LINE_JUDGE_MIN, "poll_seconds": 2, "stale_after_seconds": 120}},
        }

    # ---- status and lifecycle
    def status(self) -> dict[str, Any]:
        meta = self.store.meta()
        now = self._clock().astimezone(IST)
        return {
            "enabled": self.enabled, "runs_after_ist": self.run_after.strftime("%H:%M"), "running": self._running,
            "done_today": self.done_on == now.date(), "last_result": meta.get("last_result", self.last_result),
            "last_run_at": meta.get("last_run_at"), "started_session": meta.get("started"),
            "rule_version": RULE_VERSION, "progress": self.progress,
        }

    async def _loop(self) -> None:
        while True:
            if self.due():
                try:
                    await self._run_in_thread("schedule")
                except Exception as e:  # noqa: BLE001 - the scheduler must outlive any single pass
                    log_event(logger, logging.ERROR, "swing_paper_loop_error", error=type(e).__name__)
            await asyncio.sleep(60)

    def start(self) -> None:
        if self._task is None and self.enabled:
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
