"""Signs in to the broker once every morning so the day starts on a fresh session.

* At ``at`` (IST, default 08:30) it runs a full login (TOTP + MPIN), then restarts the live stream
  if it was running so the feed uses the new session.
* A failed attempt is retried every ``retry_s`` seconds until ``until`` (09:10 IST), then it gives up
  for the day and says so in the status (the existing 'sign in on demand' paths still work).
* It runs once per calendar day after a success. Nothing here reads or logs credentials.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo

from app.logging_setup import log_event

IST = ZoneInfo("Asia/Kolkata")
logger = logging.getLogger(__name__)


class DailyLogin:
    def __init__(
        self,
        login: Callable[[], Awaitable[Any]],
        after_login: Callable[[], Awaitable[Any]] | None = None,
        *,
        at: time = time(8, 30),
        until: time = time(9, 10),
        retry_s: float = 300.0,
        enabled: bool = True,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._login, self._after = login, after_login
        self.at, self.until, self.retry_s, self.enabled, self._clock = at, until, retry_s, enabled, clock
        self.done_on: date | None = None
        self.last_attempt: datetime | None = None
        self.last_result: str = "not run yet"
        self._task: asyncio.Task[None] | None = None

    def due(self, now: datetime | None = None) -> bool:
        now = now or self._clock()
        t = now.astimezone(IST)
        if not self.enabled or self.done_on == t.date():
            return False
        if not self.at <= t.time() < self.until:
            return False
        return self.last_attempt is None or (now - self.last_attempt).total_seconds() >= self.retry_s

    async def run_once(self) -> bool:
        now = self._clock()
        self.last_attempt = now
        try:
            status = await self._login()
        except Exception as e:  # noqa: BLE001 - the scheduler must survive
            self.last_result = f"error: {type(e).__name__}"
            log_event(logger, logging.WARNING, "daily_login_error", error=type(e).__name__)
            return False
        state = str(getattr(getattr(status, "state", None), "value", getattr(status, "state", "")))
        if state != "authenticated":
            self.last_result = f"sign-in not successful ({state}); will retry"
            return False
        self.done_on = now.astimezone(IST).date()
        self.last_result = f"signed in at {now.astimezone(IST):%H:%M} IST"
        log_event(logger, logging.INFO, "daily_login_ok")
        if self._after is not None:
            with contextlib.suppress(Exception):
                await self._after()
        return True

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled, "time_ist": self.at.strftime("%H:%M"), "done_today": self.done_on == self._clock().astimezone(IST).date(),
            "last_attempt_at": self.last_attempt.isoformat() if self.last_attempt else None, "last_result": self.last_result,
        }  # fmt: skip

    async def _loop(self) -> None:
        while True:
            if self.due():
                await self.run_once()
            await asyncio.sleep(30)

    def start(self) -> None:
        if self._task is None and self.enabled:
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
