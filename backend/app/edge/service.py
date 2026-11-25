"""The nightly scoring job: after every close it scores each finished, not yet scored session, and keeps the report the Edge monitor shows.

Runs by itself: a catch-up pass shortly after start (every stored session, so a restart or a missed night loses nothing) and then a check every ten minutes. Read-only on the
stored data (intelligence timeline, intraday rules scores, straddle minutes); it writes only its own ledger. A failure is logged and shown on the page; it never touches collection.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
import time as _time
from collections.abc import Callable, Mapping, Sequence
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from app.domain.session import session_close
from app.edge import calls as ec
from app.edge import stats
from app.edge.store import VERSION, EdgeStore
from app.logging_setup import log_event

logger = logging.getLogger(__name__)
IST = timezone(timedelta(hours=5, minutes=30))
FINAL_AFTER = timedelta(minutes=10)  # a session is final this long after the exchange close (session_close(): 15:40 now, 15:45 from 7 Dec 2026)
CHECK_EVERY_S = 600
MIN_POINTS = 60  # a source needs this many recorded minutes of a session to be scored
RowsFn = Callable[[str], Sequence[Mapping[str, Any]]]


class EdgeService:
    def __init__(self, store: EdgeStore, *, sessions: Callable[[], Sequence[str]], intel_rows: RowsFn, rules_rows: RowsFn, straddle_rows: RowsFn,
                 clock: Callable[[], datetime] | None = None, enabled: bool = True) -> None:
        self.store, self.enabled = store, enabled
        self._sessions, self._intel, self._rules, self._straddle = sessions, intel_rows, rules_rows, straddle_rows
        self._clock = clock or (lambda: datetime.now(IST))
        self._lock = threading.Lock()
        self._task: asyncio.Task[None] | None = None
        self._cache: tuple[float, dict[str, Any]] | None = None
        self._empty: set[str] = set()  # sessions found to have too few recorded minutes (not asked again until a restart)
        self.last_run: str | None = None
        self.last_error: str | None = None
        self.last_scored: list[str] = []

    @staticmethod
    def run_after() -> time:
        """The time of day from which today's session counts as finished."""
        return (datetime.combine(date.today(), session_close()) + FINAL_AFTER).time()

    def _final(self, session: str) -> bool:
        now = self._clock().astimezone(IST)
        today = now.date().isoformat()
        return session < today or (session == today and now.time() >= self.run_after())

    def pending(self) -> list[str]:
        """Finished sessions that are not scored (or were scored by an older scoring version), oldest first."""
        done = self.store.scored()
        have: dict[str, set[str]] = {}
        for (s, _k), ver in done.items():
            have.setdefault(s, set()).add(ver)
        return [s for s in sorted(set(self._sessions())) if self._final(s) and s not in self._empty and (s not in have or have[s] != {VERSION})]

    def score_session(self, session: str) -> dict[str, int] | None:
        """Score one finished session from the stored rows; None if it has too few recorded minutes."""
        intel, rules, strad = list(self._intel(session)), list(self._rules(session)), list(self._straddle(session))
        base = intel if len(ec.series(intel)) >= MIN_POINTS else rules
        pts = ec.series(base)
        if len(pts) < MIN_POINTS:
            self._empty.add(session)
            return None
        out: list[dict[str, Any]] = []
        have: dict[str, int] = {}
        for key, rows, fn in (("verdict", intel, ec.verdict_calls), ("rules", rules, ec.rules_calls), ("momentum", base, ec.momentum_calls), ("orb", base, ec.orb_calls), ("seller", strad, ec.seller_calls)):
            if len(ec.series(rows)) < MIN_POINTS:
                continue
            got = fn(session, rows)
            out += got
            have[key] = len(got)
        self.store.replace_session(session, out, ec.windows(pts), have)
        self._cache = None
        return have

    def catch_up(self) -> list[str]:
        """Score every pending finished session (oldest first). Safe to call at any time; one pass at a time."""
        if not self._lock.acquire(blocking=False):
            return []
        done: list[str] = []
        failed = False
        try:
            for s in self.pending():
                try:
                    if self.score_session(s) is not None:
                        done.append(s)
                except Exception as e:  # noqa: BLE001 - one bad session must not stop the rest; it is shown on the page
                    failed = True
                    self.last_error = f"{s}: {type(e).__name__}: {e}"
                    log_event(logger, logging.ERROR, "edge_score_failed", session=s, error=type(e).__name__)
            self.last_run = self._clock().isoformat(timespec="seconds")
            if not failed:
                self.last_error = None
            if done:
                self.last_scored = done
                log_event(logger, logging.INFO, "edge_scored", sessions=done)
        finally:
            self._lock.release()
        return done

    def report(self) -> dict[str, Any]:
        if self._cache is not None and _time.monotonic() - self._cache[0] < 120:
            return self._cache[1]
        calls, wins, sessions = self.store.calls(), self.store.windows(), self.store.sessions()
        body = stats.summarise(calls, wins)
        rep = {
            "generated_at": self._clock().isoformat(timespec="seconds"), "version": VERSION, "sessions_scored": len(sessions), "first_session": sessions[0] if sessions else None,
            "last_session": sessions[-1] if sessions else None, "headline": stats.headline(body["indicators"], len(sessions)), **body,
            "job": {"enabled": self.enabled, "last_run": self.last_run, "last_error": self.last_error, "last_scored": self.last_scored, "pending": self.pending(),
                    "runs": f"after {self.run_after().strftime('%H:%M')} IST each trading day and on every start; checks every {CHECK_EVERY_S // 60} minutes"},
            "method": [
                "Each indicator's calls are taken every 15 minutes from 09:30 and compared with the stored price 15, 30 and 60 minutes later; moves under 0.02 % are flat.",
                "Luck is measured from the same stored windows: a coin with the indicator's long / short mix, given how often NIFTY rose. 'Edge over drift' is hit rate minus that.",
                "'Timing edge' uses each day's own up share, so it only counts when the indicator is right about WHEN within a day, not just which way the day went.",
                f"The interval is a bootstrap over sessions (minutes of one day overlap). Nothing is called an edge before {stats.MIN_SESSIONS} sessions and {stats.MIN_CALLS} decided calls.",
                "A description of the past, not a forecast and not advice; the stored sessions started on 29 Oct 2026 and the market has mostly risen since.",
            ],
        }
        self._cache = (_time.monotonic(), rep)
        return rep

    async def _loop(self) -> None:
        await asyncio.sleep(45)
        while True:
            await asyncio.to_thread(self.catch_up)
            await asyncio.sleep(CHECK_EVERY_S)

    def start(self) -> None:
        if self.enabled and self._task is None:
            self._task = asyncio.create_task(self._loop(), name="edge-scoring")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
