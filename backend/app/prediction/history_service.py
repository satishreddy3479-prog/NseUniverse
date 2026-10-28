"""Downloads daily price history and keeps it current, without any button presses.

* First start: downloads the full history for every configured symbol (one request per symbol).
* Afterwards: once per trading day after 18:30 IST, re-downloads the last 10 days of each symbol
  (the overlap lets us notice when Yahoo corrects an old bar) and stores anything new.
* A failure on one symbol never stops the others and is shown in the status; a failed run is retried
  after an hour. Nothing is invented or filled: missing days stay missing.
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
from app.prediction.history_store import HistoryStore, InsertResult
from app.prediction.pit import IST
from app.prediction.sources.yahoo import SYMBOLS, Downloader, SymbolSpec, yahoo_download

logger = logging.getLogger(__name__)
SOURCE = "yahoo"
OVERLAP_DAYS = 10
RUN_AFTER = (18, 30)  # IST: Indian closing data is settled
RUN_MORNING = (7, 30)  # IST: the US close (01:30 IST) and overnight settlements are in
RETRY_AFTER = timedelta(hours=1)
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
    ) -> None:
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

    # ------------------------------------------------------------------ one refresh run
    def _fetch_one(self, spec: SymbolSpec, run_id: str) -> dict[str, Any]:
        last = self.store.last_session(spec.key, SOURCE)
        start = (
            max(self.start_date, last - timedelta(days=OVERLAP_DAYS)) if last else self.start_date
        )
        end = self._clock().astimezone(IST).date() + timedelta(days=1)  # end is exclusive
        rows = self._download(spec, start, end)
        res: InsertResult = self.store.insert_bars(
            spec.key, rows, source=SOURCE, run_id=run_id, now=self._clock(), volume_meaningful=False
        )
        return {
            "symbol": spec.key, "yahoo": spec.yahoo, "downloaded": len(rows), "new": res.new,
            "unchanged": res.unchanged, "changed": res.changed, "invalid": res.invalid,
            "incomplete": res.incomplete, "error": None,
        }  # fmt: skip

    async def refresh(self) -> dict[str, Any]:
        run_id = f"{self._clock():%Y%m%dT%H%M%SZ}_{uuid.uuid4().hex[:6]}"
        await asyncio.to_thread(self.store.start_run, run_id, SOURCE)
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
            "disagreements": sum(r.get("changed", 0) for r in results), "results": results,
        }  # fmt: skip
        await asyncio.to_thread(self.store.finish_run, run_id, summary)
        log_event(logger, logging.INFO, "history_refreshed", ok=len(ok), new=summary["new_bars"])
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
    def due(self, now: datetime | None = None) -> bool:
        now = now or self._clock()
        if not self.enabled or self.running:
            return False
        if self.last_attempt and now - self.last_attempt < RETRY_AFTER:
            return False
        ok = self.store.last_success_utc()
        if ok is None:
            return True  # nothing downloaded yet: start straight away
        t = now.astimezone(IST)
        after_close = t.weekday() < 5 and (t.hour, t.minute) >= RUN_AFTER
        if after_close and ok.astimezone(IST).date() < t.date():
            return True
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
