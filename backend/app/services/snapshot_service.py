"""Expiry discovery and option-chain snapshot capture."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime
from typing import TypeVar
from zoneinfo import ZoneInfo

from app.broker.base import BrokerError, MarketDataBroker
from app.domain.expiry import parse_expiry_dates, select_expiries
from app.domain.models import (
    DataSource,
    ExpiryKind,
    ExpirySelection,
    SnapshotSummary,
)
from app.domain.normalize import ChainFormatError, normalize_option_chain
from app.logging_setup import log_event
from app.services.state import AppState
from app.storage.observations import ObservationStore, fingerprint
from app.storage.store import SnapshotStore, StorageError

IST = ZoneInfo("Asia/Kolkata")
EXPIRY_CACHE_TTL_S = 600
logger = logging.getLogger(__name__)
T = TypeVar("T")


def today_ist(now: datetime | None = None) -> date:
    return (now or datetime.now(UTC)).astimezone(IST).date()


def new_snapshot_id(underlying: str, expiry: date, at: datetime) -> str:
    return f"{at:%Y%m%dT%H%M%S%fZ}_{underlying}_{expiry:%Y%m%d}_{uuid.uuid4().hex[:8]}"


class SnapshotService:
    def __init__(
        self,
        broker: MarketDataBroker,
        store: SnapshotStore,
        state: AppState,
        underlying: str,
        strike_count: int,
        max_age_s: int = 300,
        observations: ObservationStore | None = None,
    ) -> None:
        self.broker = broker
        self.store = store
        self.state = state
        self.underlying = underlying
        self.strike_count = strike_count
        self.max_age_s = max_age_s
        self.observations = observations
        self._expiry_cache: ExpirySelection | None = None
        self._expiry_lock = asyncio.Lock()
        self._capture_lock = asyncio.Lock()
        self._last_fingerprint: dict[date, str] = {}
        self.skipped_unchanged = 0

    @property
    def snapshot_source(self) -> DataSource:
        return DataSource.SNAPSHOT

    async def _with_relogin(self, op: Callable[[], Awaitable[T]]) -> T:
        try:
            return await op()
        except BrokerError as e:
            if e.code == "auth":
                await self.broker.login()
                return await op()
            raise

    def cached_monthly_expiry(self) -> date | None:
        """Current-monthly expiry from the last expiry lookup (None before the first lookup)."""
        c = self._expiry_cache
        return None if c is None else c.monthly

    async def expiries(self, *, force: bool = False) -> ExpirySelection:
        async with self._expiry_lock:
            now = datetime.now(UTC)
            cached = self._expiry_cache
            if (
                cached
                and not force
                and cached.as_of == today_ist(now)
                and (now - cached.retrieved_at).total_seconds() < EXPIRY_CACHE_TTL_S
            ):
                return cached
            try:
                raw = await self._with_relogin(lambda: self.broker.get_expiries(self.underlying))
            except BrokerError as e:
                self.state.record_error("expiries", e.code, e.message)
                raise
            dates, warnings = parse_expiry_dates(raw)
            today = today_ist(now)
            choice = select_expiries(dates, today)
            sel = ExpirySelection(
                underlying=self.underlying,
                as_of=today,
                available=dates,
                weekly=choice.weekly,
                monthly=choice.monthly,
                monthly_is_next_month=choice.monthly_is_next_month,
                weekly_equals_monthly=choice.weekly_equals_monthly,
                source=self.snapshot_source,
                retrieved_at=now,
                warnings=warnings + choice.warnings,
            )
            self._expiry_cache = sel
            log_event(
                logger,
                logging.INFO,
                "expiries_resolved",
                weekly=str(sel.weekly),
                monthly=str(sel.monthly),
                count=len(dates),
            )
            return sel

    async def capture(
        self, *, expiry: date | None = None, skip_unchanged: bool = False
    ) -> list[SnapshotSummary]:
        """Capture weekly + monthly (deduplicated), or one verified explicit expiry.

        With ``skip_unchanged`` (used by the scheduled sampler) a chain whose prices, OI and volume
        equal the last stored one for that expiry is not stored again; it is counted instead. That
        keeps holidays and the hours after the close from filling the disk with repeats.
        """
        sel = await self.expiries()
        targets: dict[date, list[ExpiryKind]] = {}
        if expiry is not None:
            if expiry not in sel.available:
                raise BrokerError(
                    f"expiry {expiry} is not in the broker's listed expiries", code="bad_request"
                )
            targets[expiry] = [
                k
                for k, d in ((ExpiryKind.WEEKLY, sel.weekly), (ExpiryKind.MONTHLY, sel.monthly))
                if d == expiry
            ]
        else:
            for kind, d in ((ExpiryKind.WEEKLY, sel.weekly), (ExpiryKind.MONTHLY, sel.monthly)):
                if d is not None:
                    targets.setdefault(d, []).append(kind)
        if not targets:
            raise BrokerError("no verified expiry available to capture", code="no_expiry")

        async with self._capture_lock:
            self.state.snapshots.in_progress = True
            self.state.snapshots.last_attempt_at = datetime.now(UTC)
            results: list[SnapshotSummary] = []
            try:
                for exp, kinds in targets.items():
                    saved = await self._capture_one(exp, kinds, skip_unchanged)
                    if saved is not None:
                        results.append(saved)
                self.state.snapshots.last_success_at = datetime.now(UTC)
                self.state.snapshots.last_error = None
            except (BrokerError, StorageError, ChainFormatError) as e:
                msg = e.message if isinstance(e, BrokerError) else str(e)
                code = e.code if isinstance(e, BrokerError) else type(e).__name__
                self.state.snapshots.last_error = msg
                self.state.record_error("snapshot", code, msg)
                raise
            finally:
                self.state.snapshots.in_progress = False
            return results

    async def _capture_one(
        self, exp: date, kinds: list[ExpiryKind], skip_unchanged: bool = False
    ) -> SnapshotSummary | None:
        exp_s = exp.isoformat()
        raw = await self._with_relogin(
            lambda: self.broker.get_option_chain(self.underlying, exp_s, self.strike_count)
        )
        received = datetime.now(UTC)
        snap = normalize_option_chain(
            raw,
            snapshot_id=new_snapshot_id(self.underlying, exp, received),
            session_id=self.state.session_id,
            underlying=self.underlying,
            expiry=exp,
            expiry_kinds=kinds,
            source=self.snapshot_source,
            retrieved_at=received,
            requested_strike_count=self.strike_count,
        )
        fp = fingerprint(snap)
        if skip_unchanged and self._last_fingerprint.get(exp) == fp:
            self.skipped_unchanged += 1
            if self.observations is not None:  # the time is covered: fetched, and identical
                await asyncio.to_thread(self.observations.record_snapshot, snap, unchanged=True)
            return None
        summary = await asyncio.to_thread(self.store.save, snap, raw)
        self._last_fingerprint[exp] = fp
        if self.observations is not None:
            await asyncio.to_thread(self.observations.record_snapshot, snap, unchanged=False)
        self.state.snapshots.captured_count += 1
        log_event(
            logger,
            logging.INFO,
            "snapshot_captured",
            snapshot_id=snap.snapshot_id,
            expiry=exp_s,
            strikes=len(snap.rows),
            completeness=snap.completeness.value,
        )
        return summary
