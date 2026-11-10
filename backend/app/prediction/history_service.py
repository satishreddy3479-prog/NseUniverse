"""Downloads daily price history and keeps it current, without any button presses.

* First start: downloads the full history for every configured symbol (one request per symbol).
* Afterwards: once per trading day after 18:30 IST, re-downloads the last 10 days of each symbol
  (the overlap lets us notice when Yahoo corrects an old bar) and stores anything new.
* A failure on one symbol never stops the others and is shown in the status; a failed run is retried
  after an hour. Nothing is invented or filled: missing days stay missing.
* With a trading calendar the schedule also looks at the DATA, not only the clock: when the newest NIFTY 50 bar is older than the last
  completed session, or an overnight series lacks the world session the next forecast needs, a run is due again (every 10 minutes in the
  morning, hourly otherwise). A run that "succeeded" for 24 of 25 symbols therefore no longer ends the day's attempts, and a restart of the
  program (which forgets its last attempt) cannot leave a gap unfilled.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

from app.logging_setup import log_event
from app.prediction.calendar import SessionLookup
from app.prediction.history_store import HistoryStore, InsertResult
from app.prediction.pit import IST
from app.prediction.sources.yahoo import (
    BY_KEY,
    SYMBOLS,
    Downloader,
    SymbolSpec,
    complete_after,
    final_after,
    yahoo_download,
)
from app.prediction.targets import Bar, BarError
from app.prediction.usmarket import last_us_session_on_or_before

logger = logging.getLogger(__name__)
SOURCE = "yahoo"
OVERLAP_DAYS = 10
RUN_AFTER = (18, 30)  # IST: Indian closing data is settled
RUN_MORNING = (7, 30)  # IST: the US close (01:30 IST) and overnight settlements are in
RETRY_AFTER = timedelta(hours=1)
MORNING_RETRY = timedelta(minutes=10)  # while overnight bars are missing before the forecast
MORNING_END = (9, 10)  # IST
OVERNIGHT_KEYS = ("SPX", "VIX", "BRENT", "DXY", "USDINR", "UST10Y")
POLL_S = 300.0
_COV_FIELDS = ("first", "last", "bars", "disagreements")


class HistoryService:
    def __init__(
        self,
        store: HistoryStore,
        *,
        downloader: Downloader = yahoo_download,
        start: date = date(2007, 1, 1),
        enabled: bool = True,
        symbols: list[SymbolSpec] | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        pause_between_s: float = 1.0,
        after_refresh: Callable[[], object] | None = None,
        calendar: SessionLookup | None = None,
    ) -> None:
        self._after_refresh = after_refresh
        self.calendar = calendar
        self.store = store
        self._download = downloader
        self.start_date = start
        self.enabled = enabled
        self.symbols = symbols if symbols is not None else list(SYMBOLS)
        self._clock = clock
        self._pause = pause_between_s
        self._task: asyncio.Task[None] | None = None
        self._running: asyncio.Task[dict[str, Any]] | None = None
        self.last_attempt: datetime | None = None
        self.progress: str = ""

    @staticmethod
    def _provisional(early: list[Any]) -> Bar | None:
        """Newest early row with four sane prices (a row mixed with a live tick is dropped)."""
        for r in sorted(early, key=lambda x: x.session, reverse=True):
            if None in (r.open, r.high, r.low, r.close):
                continue
            try:
                return Bar(r.session, r.open, r.high, r.low, r.close)
            except BarError:
                continue
        return None

    # ------------------------------------------------------------------ one refresh run
    def _fetch_one(self, spec: SymbolSpec, run_id: str) -> dict[str, Any]:
        last = self.store.last_session(spec.key, SOURCE)
        start = (
            max(self.start_date, last - timedelta(days=OVERLAP_DAYS)) if last else self.start_date
        )
        end = self._clock().astimezone(IST).date() + timedelta(days=1)  # end is exclusive
        downloaded = self._download(spec, start, end)
        now = self._clock()
        # a bar whose session has not finished is partial (intraday): never stored as a daily bar
        rows = [r for r in downloaded if final_after(spec, r.session) <= now]
        partial = len(downloaded) - len(rows)
        # 24-hour series: the newest bar past the regular close but not yet final is kept apart as a
        # provisional bar (valid prices only, replaced each refresh) for the morning run, flagged
        early = [
            r
            for r in downloaded
            if complete_after(spec, r.session) <= now < final_after(spec, r.session)
        ]
        prov = self._provisional(early)
        self.store.set_provisional(spec.key, prov, now.astimezone(UTC).isoformat())
        repaired = self.store.repair_shifted_dates(
            spec.key, rows, source=SOURCE, run_id=run_id, now=self._clock()
        )
        if repaired:
            log_event(
                logger, logging.WARNING, "history_dates_repaired", symbol=spec.key, bars=repaired
            )
        newest = max((r.session for r in downloaded), default=None)
        res: InsertResult = self.store.insert_bars(
            spec.key, rows, source=SOURCE, run_id=run_id, now=self._clock(), volume_meaningful=False
        )
        return {
            "symbol": spec.key, "yahoo": spec.yahoo, "downloaded": len(rows),
            "partial_skipped": partial, "dates_repaired": repaired,
            "latest_downloaded": str(newest) if newest else None,
            "provisional": str(prov.session) if prov else None,
            "corrected": res.corrected, "new": res.new,
            "unchanged": res.unchanged, "changed": res.changed, "invalid": res.invalid,
            "incomplete": res.incomplete, "error": None,
        }  # fmt: skip

    async def refresh(self) -> dict[str, Any]:
        run_id = f"{self._clock():%Y%m%dT%H%M%SZ}_{uuid.uuid4().hex[:6]}"
        await asyncio.to_thread(self.store.start_run, run_id, SOURCE, self._clock())
        self.last_attempt = self._clock()
        results: list[dict[str, Any]] = []
        for i, spec in enumerate(self.symbols):
            self.progress = f"{spec.key} ({i + 1}/{len(self.symbols)})"
            try:
                results.append(await asyncio.to_thread(self._fetch_one, spec, run_id))
            except Exception as e:  # one bad symbol must not stop the run
                msg = f"{type(e).__name__}: {e}"[:200]
                results.append({"symbol": spec.key, "yahoo": spec.yahoo, "error": msg})
                log_event(
                    logger, logging.WARNING, "history_fetch_failed", symbol=spec.key, error=msg
                )
            if self._pause and i + 1 < len(self.symbols):
                await asyncio.sleep(self._pause)  # one request per second at most
        self.progress = ""
        ok = [r for r in results if not r.get("error") and r.get("downloaded", 0) > 0]
        failed = [r["symbol"] for r in results if r.get("error")]
        empty = [r["symbol"] for r in results if not r.get("error") and not r.get("downloaded")]
        summary = {
            "ok_symbols": len(ok), "failed_symbols": failed, "empty_symbols": empty,
            "new_bars": sum(r.get("new", 0) for r in results),
            "corrected_bars": sum(r.get("corrected", 0) for r in results),
            "partial_bars_skipped": sum(r.get("partial_skipped", 0) for r in results),
            "disagreements": sum(r.get("changed", 0) for r in results), "results": results,
        }  # fmt: skip
        await asyncio.to_thread(self.store.finish_run, run_id, summary, self._clock())
        log_event(logger, logging.INFO, "history_refreshed", ok=len(ok), new=summary["new_bars"])
        if self._after_refresh is not None and (summary["new_bars"] or summary["corrected_bars"]):
            # new final bars: the daily models train on them (the callback starts the work, returns)
            try:
                await asyncio.to_thread(self._after_refresh)
            except Exception as e:  # noqa: BLE001 - a model problem must never fail the data run
                log_event(logger, logging.WARNING, "after_refresh_failed", error=type(e).__name__)
        return summary

    def trigger(self) -> bool:
        """Start a refresh in the background unless one is running. Returns True if it started."""
        if self._running is not None and not self._running.done():
            return False
        self._running = asyncio.create_task(self.refresh(), name="history-refresh")
        return True

    @property
    def running(self) -> bool:
        return self._running is not None and not self._running.done()

    # ------------------------------------------------------------------ schedule
    def overnight_missing(self, now: datetime) -> list[str]:
        """Overnight series whose newest bar is older than the last weekday (US session date)."""
        d = now.astimezone(IST).date() - timedelta(days=1)
        while d.weekday() >= 5:
            d -= timedelta(days=1)
        last = {c["symbol"]: c["last"] for c in self.store.coverage()}  # usable (final) bars only
        return [k for k in OVERNIGHT_KEYS if (last.get(k) or "") < str(d)]

    def data_gaps(self, now: datetime) -> list[str]:
        """What the stored data lacks that a forecast needs and that is already published (empty without a calendar).

        * NIFTY50: the final bar of the last completed NSE session.
        * Overnight series (OVERNIGHT_KEYS): a final or provisional bar of the US trading day the next forecast needs, once that US session is over.
        """
        cal = self.calendar
        if cal is None:
            return []
        try:
            ist = now.astimezone(IST)
            nifty = BY_KEY["NIFTY50"]
            d = ist.date()
            for _ in range(12):  # the newest session whose daily bar is final by now
                if cal.is_session(d) and final_after(nifty, d) <= now:
                    break
                d -= timedelta(days=1)
            else:
                return []
            cov = {c["symbol"]: c["last"] for c in self.store.coverage(SOURCE)}
            gaps: list[str] = []
            if (cov.get("NIFTY50") or "") < str(d):
                gaps.append(f"NIFTY50 {d}")
            first = cal.next_session(d, 1)
            req = last_us_session_on_or_before(max(d, first - timedelta(days=1)))
            if now >= datetime(req.year, req.month, req.day, 3, 0, tzinfo=IST) + timedelta(days=1):  # that US session is over
                for k in OVERNIGHT_KEYS:
                    final = cov.get(k) or ""
                    prov = self.store.provisional_bar(k, None)
                    newest = max(final, str(prov.session) if prov is not None else "")
                    if newest < str(req):
                        gaps.append(f"{k} {req}")
            return gaps
        except Exception:  # noqa: BLE001 - a calendar gap must never stop the clock-based schedule
            return []

    def _last_started(self) -> datetime | None:
        """When a run last started: this process's memory, else the stored run log (a restart empties the memory only)."""
        if self.last_attempt is not None:
            return self.last_attempt
        run = self.store.last_run()
        try:
            return datetime.fromisoformat(run["started_at"]) if run and run.get("started_at") else None
        except (TypeError, ValueError):
            return None

    def due(self, now: datetime | None = None) -> bool:
        now = now or self._clock()
        if not self.enabled or self.running:
            return False
        t0 = now.astimezone(IST)
        if self.calendar is not None and self.data_gaps(now):
            in_morning = t0.weekday() < 5 and RUN_MORNING <= (t0.hour, t0.minute) < MORNING_END
            last = self._last_started()
            if last is None or now - last >= (MORNING_RETRY if in_morning else RETRY_AFTER):
                return True  # the data the next forecast needs is published but not stored: look again, whatever the clock rules say
        morning = t0.weekday() < 5 and RUN_MORNING <= (t0.hour, t0.minute) < MORNING_END
        retry_gap = self.last_attempt is not None and now - self.last_attempt >= MORNING_RETRY
        if morning and retry_gap and self.overnight_missing(now):
            return True  # overnight bars are late: retry every 10 minutes until the forecast window
        if self.last_attempt and now - self.last_attempt < RETRY_AFTER:
            return False
        ok = self.store.last_success_utc()
        if ok is None:
            return True  # nothing downloaded yet: start straight away
        t = now.astimezone(IST)
        after_close = t.weekday() < 5 and (t.hour, t.minute) >= RUN_AFTER
        close_start = t.replace(hour=RUN_AFTER[0], minute=RUN_AFTER[1], second=0, microsecond=0)
        if after_close and ok.astimezone(IST) < close_start:
            return True  # a morning run does not count as the evening one
        h, m = RUN_MORNING
        morning_start = t.replace(hour=h, minute=m, second=0, microsecond=0)
        return t.weekday() < 5 and t >= morning_start and ok.astimezone(IST) < morning_start

    async def _loop(self) -> None:
        await asyncio.sleep(20)  # let the backend finish starting
        while True:
            try:
                if self.due():
                    self.trigger()
            except Exception as e:  # scheduling must not die
                log_event(logger, logging.ERROR, "history_loop_error", exc_type=type(e).__name__)
            await asyncio.sleep(POLL_S)

    def start(self) -> None:
        if self.enabled and self._task is None:
            self._task = asyncio.create_task(self._loop(), name="history-scheduler")

    async def stop(self) -> None:
        for t in (self._task, self._running):
            if t is not None and not t.done():
                t.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await t
        self._task = None

    # ------------------------------------------------------------------ status
    def status(self) -> dict[str, Any]:
        cov = {c["symbol"]: c for c in self.store.coverage(SOURCE)}
        run = self.store.last_run()
        return {
            "enabled": self.enabled,
            "source": "Yahoo Finance via yfinance (unofficial, personal use)",
            "running": self.running,
            "progress": self.progress,
            "data_gaps": self.data_gaps(self._clock()),
            "weekend_dated_bars": self.store.suspect_weekend_bars(SOURCE),
            "partial_bars_held_back": [
                b for b in self.store.premature_bars(SOURCE) if not b["corrected"]
            ],
            "last_run": run,
            "symbols": [
                {
                    "key": s.key, "yahoo": s.yahoo, "name": s.name, "kind": s.kind,
                    "timing_verified": s.timing_verified,
                    **{k: v for k, v in cov.get(s.key, {}).items() if k in _COV_FIELDS},
                    "has_data": s.key in cov,
                }
                for s in self.symbols
            ],
        }  # fmt: skip
