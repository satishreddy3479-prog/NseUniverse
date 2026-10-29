"""Scheduled snapshot sampling during market hours.

Every ``interval_s`` seconds, while the market is open, the weekly and monthly option chains are
captured exactly as the manual "Refresh snapshot" does (read-only REST calls). The stored snapshots
are what the time-series widgets plot. Nothing is sampled outside the session, so the history never
fills up with repeats of the closing values.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import shutil
from collections.abc import Callable
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from app.domain.session import LABEL
from app.domain.session import SESSION_CLOSE as _SESSION_CLOSE
from app.domain.session import SESSION_OPEN as _SESSION_OPEN
from app.logging_setup import log_event
from app.services.snapshot_service import IST, SnapshotService
from app.stream.models import MarketStatus

logger = logging.getLogger(__name__)

SESSION_OPEN = _SESSION_OPEN
SESSION_CLOSE = _SESSION_CLOSE
FEED_TRUST_FROM = time(9, 0)  # earlier "closed" messages are treated as stale
MAX_BACKOFF_S = 300
POLL_S = 5.0

SamplerState = Literal["off", "waiting", "sampling", "error"]


class SamplerStatus(BaseModel):
    enabled: bool
    interval_seconds: int
    session: str = f"{LABEL}, Mon–Fri"
    state: SamplerState = "off"
    reason: str = ""
    in_session: bool = False
    last_attempt_at: datetime | None = None
    last_success_at: datetime | None = None
    last_error: str | None = None
    next_due_at: datetime | None = None
    samples_this_run: int = 0
    skipped_unchanged: int = 0
    free_disk_gb: float | None = None


def session_open(now: datetime, market: MarketStatus | None = None) -> tuple[bool, str]:
    """Is the regular NSE session on? The clock decides, unless the feed said 'closed' today.

    The feed check catches trading holidays on weekdays. A 'closed' message from a previous day is
    ignored, so a stale status can never block the morning's first sample.
    """
    t = now.astimezone(IST)
    if t.weekday() >= 5:
        return False, "weekend"
    if not SESSION_OPEN <= t.time() <= SESSION_CLOSE:
        return False, f"outside {LABEL}"
    if market is not None and market.state == "closed" and market.received_at is not None:
        r = market.received_at.astimezone(IST)
        if r.date() == t.date() and r.time() >= FEED_TRUST_FROM and r <= t:
            return False, "exchange feed reports the market closed"
    return True, ""


class SnapshotSampler:
    def __init__(
        self,
        service: SnapshotService,
        *,
        interval_s: int,
        enabled: bool = True,
        market: Callable[[], MarketStatus | None] = lambda: None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        min_free_gb: float = 2.0,
        data_dir: Path | None = None,
    ) -> None:
        self.service = service
        self.interval_s = interval_s
        self.enabled = enabled
        self._market = market
        self._clock = clock
        self._failures = 0
        self.min_free_gb = min_free_gb
        self._data_dir = data_dir
        self._next_due: datetime | None = None
        self._sampling = False
        self._task: asyncio.Task[None] | None = None
        self.last_attempt_at: datetime | None = None
        self.last_success_at: datetime | None = None
        self.last_error: str | None = None
        self.samples = 0

    def free_disk_gb(self) -> float | None:
        if self._data_dir is None:
            return None
        try:
            return shutil.disk_usage(self._data_dir).free / 1e9
        except OSError:
            return None

    def _disk_low(self) -> str | None:
        free = self.free_disk_gb()
        if free is not None and free < self.min_free_gb:
            return f"low disk space ({free:.1f} GB free, need {self.min_free_gb:g} GB)"
        return None

    def status(self) -> SamplerStatus:
        now = self._clock()
        if not self.enabled:
            return SamplerStatus(
                enabled=False,
                interval_seconds=self.interval_s,
                state="off",
                reason="disabled (SAMPLER_ENABLED=false)",
            )
        ok, why = session_open(now, self._market())
        low = self._disk_low()
        if ok and low:
            ok, why = False, low
        if self._sampling:
            state: SamplerState = "sampling"
        elif not ok:
            state = "waiting"
        elif self._failures:
            state = "error"
        else:
            state = "waiting"
        reason = why if not ok else (self.last_error or "" if self._failures else "")
        return SamplerStatus(
            enabled=True,
            interval_seconds=self.interval_s,
            state=state,
            reason=reason,
            in_session=ok,
            last_attempt_at=self.last_attempt_at,
            last_success_at=self.last_success_at,
            last_error=self.last_error,
            next_due_at=self._next_due if ok else None,
            samples_this_run=self.samples,
            skipped_unchanged=self.service.skipped_unchanged,
            free_disk_gb=self.free_disk_gb(),
        )

    async def tick(self) -> bool:
        """One scheduling step. Returns True when a sample was attempted."""
        if not self.enabled:
            return False
        now = self._clock()
        ok, _ = session_open(now, self._market())
        if not ok or self._disk_low():
            self._next_due = None
            return False
        if self._next_due is not None and now < self._next_due:
            return False
        await self._sample(now)
        return True

    async def _sample(self, now: datetime) -> None:
        self._sampling = True
        self.last_attempt_at = now
        try:
            await self.service.capture(skip_unchanged=True)
        except Exception as e:  # keep the loop alive whatever the broker does
            self._failures += 1
            self.last_error = f"{type(e).__name__}: {getattr(e, 'message', str(e))}"[:200]
            delay = min(MAX_BACKOFF_S, self.interval_s * (2 ** min(self._failures, 4)))
            obs = self.service.observations
            if obs is not None:
                obs.record_event("sample_failed", self.last_error)
            log_event(
                logger, logging.WARNING, "sample_failed", failures=self._failures, retry_in_s=delay
            )
        else:
            self._failures = 0
            self.last_error = None
            self.last_success_at = self._clock()
            self.samples += 1
            delay = self.interval_s
        finally:
            self._sampling = False
        self._next_due = self._clock() + timedelta(seconds=delay)

    async def _run(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # defensive: scheduling itself must never die
                log_event(logger, logging.ERROR, "sampler_loop_error", exc_type=type(e).__name__)
            await asyncio.sleep(POLL_S)

    def start(self) -> None:
        if self.enabled and self._task is None:
            self._task = asyncio.create_task(self._run(), name="snapshot-sampler")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
