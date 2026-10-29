"""Collects NSE participant-wise F&O files and FII/DII cash activity, slowly and politely.

* Backfill: newest to oldest over the sessions known from the NIFTY history; one request at a time
  with a pause; stops by itself when files stop existing (history start) or when NSE refuses us
  (403/429/repeated network errors): it then reports that plainly and does not retry harder.
* Daily: after 19:30 IST it fetches the latest session's files and the FII/DII cash feed.
* A file that fails validation is logged and never stored.
"""

from __future__ import annotations

import asyncio
import contextlib
import http.cookiejar
import logging
import threading
import time
import urllib.request
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

from app.logging_setup import log_event
from app.prediction.flows_store import FlowsStore
from app.prediction.pit import IST
from app.prediction.sources.nse import (
    FII_DII_API,
    FII_DII_PAGE,
    KINDS,
    NSDL_URL,
    Fetched,
    NseParseError,
    fetch,
    file_url,
    parse_cash_csv,
    parse_fii_dii,
    parse_nsdl_fpi,
    parse_participant,
)

logger = logging.getLogger(__name__)
RUN_AFTER = (19, 30)
CASH_AFTER = (18, 45)  # IST: the exchanges post provisional FII/DII figures after about 18:00
STOP_AFTER_FINAL_404 = 40  # consecutive known trading days without a file => the history starts later
BLOCK_STATUSES = {403, 429}
MAX_NETWORK_ERRORS = 5
CASH_KEEP_SESSIONS = 7  # rolling window for FII/DII cash activity
PARTICIPANT_KEEP_SESSIONS = 7  # rolling window for the NSE participant files (user-approved 2026-10-29)
RECENT_DAYS = 3  # a 404 this recent may just mean "not published yet"
Fetcher = Callable[[str], Fetched]


class FlowsService:
    def __init__(
        self,
        store: FlowsStore,
        sessions: Callable[[], list[date]],
        *,
        fetcher: Fetcher = fetch,
        cash_fetcher: Callable[[], Fetched] | None = None,
        nsdl_fetcher: Callable[[], Fetched] | None = None,
        enabled: bool = True,
        pause_s: float = 0.7,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.store, self._sessions, self._fetch = store, sessions, fetcher
        self._cash = cash_fetcher or self._fetch_cash
        self._nsdl = nsdl_fetcher or (lambda: fetch(NSDL_URL))
        self.enabled, self._pause, self._clock = enabled, pause_s, clock
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._task: asyncio.Task[None] | None = None
        self.progress = ""
        self.blocked: str | None = None
        self.cash_note: str | None = None
        self.nsdl_note: str | None = None
        self.last_run: dict[str, Any] | None = None
        self.last_attempt: datetime | None = None
        self.last_cash_date: date | None = None
        self.last_nsdl_date: date | None = None

    # ------------------------------------------------------------------ fetching
    @staticmethod
    def _fetch_cash() -> Fetched:
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        first = fetch(FII_DII_PAGE, opener=opener)
        if first.status != 200:
            return first
        return fetch(FII_DII_API, opener=opener, headers={"Referer": FII_DII_PAGE, "Accept": "application/json"})

    def _nsdl_once(self, summary: dict[str, Any]) -> None:
        res = self._nsdl()
        if res.status != 200 or res.body is None:
            self.nsdl_note = f"NSDL FPI page unavailable ({res.error or res.status}); not stored"
            return
        try:
            rows = parse_nsdl_fpi(res.body)
        except NseParseError as e:
            self.nsdl_note = f"NSDL FPI page rejected: {e}"
            return
        summary["fpi_new"] = self.store.save_cash(rows, now=self._clock())
        self.store.prune_cash(CASH_KEEP_SESSIONS)
        self.nsdl_note = None

    def _final_404(self, session: date) -> bool:
        return session < self._clock().astimezone(IST).date() - timedelta(days=RECENT_DAYS)

    def _one(self, kind: str, session: date, summary: dict[str, Any]) -> str:
        """Returns 'stored' | 'missing' | 'skip' | 'blocked' | 'error'."""
        prev = self.store.attempted(kind, session)
        if prev is not None and (prev == 200 or (prev == 404 and self._final_404(session))):
            return "skip"
        url = file_url(kind, session)
        res = self._fetch(url)
        summary["requests"] += 1
        if res.status in BLOCK_STATUSES:
            self.blocked = f"NSE answered HTTP {res.status} for {url}; stopped. Not retrying harder."
            return "blocked"
        if res.status == 404:
            self.store.record_attempt(kind, session, 404, now=self._clock())
            summary["missing"] += 1
            return "missing"
        if res.status != 200 or res.body is None:
            summary["errors"] += 1
            return "error"
        try:
            parsed = parse_participant(res.body, kind, session)
        except NseParseError as e:
            self.store.save_rejected(kind, session, str(e), res.body, now=self._clock())
            self.store.record_attempt(kind, session, -1, str(e)[:200], now=self._clock())
            summary["rejected"].append(f"{kind} {session}: {e}")
            return "rejected"
        self.store.save_participant(kind, session, url, res.body, parsed, now=self._clock())
        self.store.record_attempt(kind, session, 200, now=self._clock())
        summary["stored"] += 1
        return "stored"

    def run(self) -> dict[str, Any]:
        self.blocked = None
        self.last_attempt = self._clock()
        summary: dict[str, Any] = {"requests": 0, "stored": 0, "missing": 0, "errors": 0, "rejected": [], "started_utc": self.last_attempt.isoformat()}
        sessions = sorted(self._sessions(), reverse=True)
        net_errors = 0
        for kind in KINDS:
            misses = 0
            for i, s in enumerate(sessions):
                if self.blocked or net_errors >= MAX_NETWORK_ERRORS:
                    break
                self.progress = f"{kind} {s} ({i + 1}/{len(sessions)})"
                out = self._one(kind, s, summary)
                if out == "stored":
                    misses = 0
                elif out == "missing" and self._final_404(s):
                    misses += 1
                    if misses >= STOP_AFTER_FINAL_404:
                        break
                elif out == "error":
                    net_errors += 1
                if out in {"stored", "missing", "error", "rejected"}:
                    time.sleep(self._pause)
        if net_errors >= MAX_NETWORK_ERRORS and not self.blocked:
            self.blocked = "repeated network errors; stopped"
        now_ist = self._clock().astimezone(IST)
        today = now_ist.date()
        evening = (now_ist.hour, now_ist.minute) >= CASH_AFTER
        if self.last_cash_date != today and evening:
            self.last_cash_date = today  # one attempt a day, success or not
            self.progress = "FII/DII cash"
            self._cash_once(summary)
        if self.last_nsdl_date != today:  # NSDL keeps the latest day on its page, so any time works
            self.last_nsdl_date = today  # one attempt a day, success or not
            self.progress = "NSDL FPI"
            self._nsdl_once(summary)
        self.progress = "trimming to the rolling window"
        try:
            summary["pruned"] = self.store.prune_participant(PARTICIPANT_KEEP_SESSIONS, self.store.path.parent / "backups")
        except Exception as e:  # noqa: BLE001 - a failed trim must never stop collection; nothing is deleted on failure
            summary["pruned"] = {"error": f"{type(e).__name__}: {e}"}
        self.progress = ""
        summary["finished_utc"] = self._clock().isoformat()
        self.last_run = summary
        log_event(logger, logging.INFO, "nse_flows_run", **{k: v for k, v in summary.items() if k != "rejected"})
        return summary

    def _cash_once(self, summary: dict[str, Any]) -> None:
        res = self._cash()
        if res.status != 200 or res.body is None:
            self.cash_note = f"FII/DII cash feed unavailable ({res.error or res.status}); not stored"
            return
        try:
            rows = parse_fii_dii(res.body)
        except NseParseError as e:
            self.cash_note = f"FII/DII cash feed rejected: {e}"
            return
        summary["cash_new"] = self.store.save_cash(rows, now=self._clock())
        self.store.prune_cash(CASH_KEEP_SESSIONS)
        self.cash_note = None

    def import_cash_csv(self, text: str) -> dict[str, Any]:
        """Store FII/DII cash activity from a file the user downloaded from NSE, then trim to the rolling window."""
        rows = parse_cash_csv(text)
        added = self.store.save_cash(rows, now=self._clock())
        removed = self.store.prune_cash(CASH_KEEP_SESSIONS)
        return {"rows": len(rows), "added": added, "removed_old": removed, "sessions_kept": len({r["session"] for r in self.store.cash_rows()})}

    # ------------------------------------------------------------------ scheduling
    def trigger(self) -> bool:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return False
            self._thread = threading.Thread(target=self.run, daemon=True, name="nse-flows")
            self._thread.start()
            return True

    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def due(self, now: datetime | None = None) -> bool:
        n = (now or self._clock()).astimezone(IST)
        if self.last_attempt is not None and n - self.last_attempt.astimezone(IST) < timedelta(hours=6):
            return False
        return (n.hour, n.minute) >= RUN_AFTER or self.last_attempt is None

    async def _loop(self) -> None:
        while True:
            try:
                if self.enabled and not self.running() and self.due():
                    self.trigger()
            except Exception:  # noqa: BLE001 - the loop must survive
                logger.exception("flows loop error")
            await asyncio.sleep(300)

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled, "running": self.running(), "progress": self.progress,
            "blocked": self.blocked, "cash_note": self.cash_note, "nsdl_note": self.nsdl_note, "last_run": self.last_run,
            "coverage": self.store.coverage(),
            "source": "NSE public archive files (archives.nseindia.com) and the NSE FII/DII feed; personal research use, low rate",
        }  # fmt: skip
