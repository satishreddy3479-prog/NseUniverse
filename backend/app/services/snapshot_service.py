"""Expiry discovery and option-chain snapshot capture."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime
from typing import Any, TypeVar
from zoneinfo import ZoneInfo

from app.broker.base import BrokerError, MarketDataBroker
from app.domain.chain_quality import core_holes
from app.domain.expiry import parse_expiry_dates, select_expiries
from app.domain.models import (
    DataSource,
    ExpiryKind,
    ExpirySelection,
    OptionChainSnapshot,
    SnapshotSummary,
)
from app.domain.normalize import ChainFormatError, normalize_option_chain
from app.domain.overrides import ledger
from app.domain.session import SESSION_OPEN, spot_end
from app.domain.spot_check import checked_spot
from app.logging_setup import log_event
from app.services.state import AppState
from app.storage.observations import ObservationStore, fingerprint
from app.storage.store import SnapshotStore, StorageError

IST = ZoneInfo("Asia/Kolkata")
EXPIRY_CACHE_TTL_S = 600
ON_DEMAND_TTL_S = 10  # a chain fetched for the Strategy builder is reused this long
ON_DEMAND_MAX_CONCURRENT = 2  # broker calls in flight for such requests
CORE_RETRIES = 2  # a chain missing OI, volume or price near ATM is asked for again this often
CORE_RETRY_S = 1.5  # seconds between those asks
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
        spot_check: bool = True,
    ) -> None:
        self.spot_check = spot_check
        self.broker = broker
        self.store = store
        self.state = state
        self.underlying = underlying
        self.strike_count = strike_count
        self.max_age_s = max_age_s
        self.observations = observations
        self._expiry_cache: ExpirySelection | None = None
        self._expiry_lock = asyncio.Lock()
        self._on_demand: dict[date, tuple[float, OptionChainSnapshot]] = {}
        self._on_demand_locks: dict[date, asyncio.Lock] = {}
        self._on_demand_slots = asyncio.Semaphore(ON_DEMAND_MAX_CONCURRENT)
        self._capture_lock = asyncio.Lock()
        self._last_fingerprint: dict[date, str] = {}
        self._broker_levels: dict[date, list[tuple[datetime, float]]] = {}
        # the index level of the last capture while cash trading ran, and its day
        self._last_traded: tuple[date, float, datetime] | None = None
        self.skipped_unchanged = 0
        # Called with each stored capture, in a thread, to measure the live feed against it
        # (set by the application; see app/services/shadow.py).
        self.shadow: Callable[[OptionChainSnapshot], None] | None = None

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

    async def on_demand_chain(self, expiry: date) -> OptionChainSnapshot:
        """The chain of any LISTED expiry, fetched now from the broker and NOT stored.

        The sampler collects only the weekly and monthly expiries; the Strategy builder also
        needs the others (calendar and diagonal strategies). Nothing here touches the snapshot
        store or the observation history, so it cannot grow the disk. A fetched chain is reused
        for ``ON_DEMAND_TTL_S`` seconds per expiry, one fetch at a time per expiry, and at most
        ``ON_DEMAND_MAX_CONCURRENT`` broker calls run together.
        """
        sel = await self.expiries()
        if expiry not in sel.available:
            raise BrokerError(
                f"expiry {expiry} is not in the broker's listed expiries", code="bad_request"
            )
        lock = self._on_demand_locks.setdefault(expiry, asyncio.Lock())
        async with lock:
            hit = self._on_demand.get(expiry)
            if hit is not None and time.monotonic() - hit[0] < ON_DEMAND_TTL_S:
                return hit[1]
            exp_s = expiry.isoformat()
            async with self._on_demand_slots:
                raw = await self._with_relogin(
                    lambda: self.broker.get_option_chain(self.underlying, exp_s, self.strike_count)
                )
            received = datetime.now(UTC)
            kinds = [
                k
                for k, d in ((ExpiryKind.WEEKLY, sel.weekly), (ExpiryKind.MONTHLY, sel.monthly))
                if d == expiry
            ]
            snap = normalize_option_chain(
                raw,
                snapshot_id=new_snapshot_id(self.underlying, expiry, received),
                session_id=self.state.session_id,
                underlying=self.underlying,
                expiry=expiry,
                expiry_kinds=kinds,
                source=self.snapshot_source,
                retrieved_at=received,
                requested_strike_count=self.strike_count,
            )
            snap = self._checked(snap)
            self._on_demand[expiry] = (time.monotonic(), snap)
            log_event(logger, logging.INFO, "on_demand_chain", expiry=exp_s, strikes=len(snap.rows))
            return snap

    def _quote_frozen(self, snap: OptionChainSnapshot) -> bool:
        """The broker's index quote is the same in three captures at least 90 s apart.

        Captures closer than 20 s count once."""
        level = snap.underlying_ltp
        if level is None:
            return False
        seen = self._broker_levels.setdefault(snap.expiry, [])
        if not seen or (snap.retrieved_at - seen[-1][0]).total_seconds() >= 20:
            seen.append((snap.retrieved_at, level))
            del seen[:-4]
        last3 = seen[-3:]
        span = (last3[-1][0] - last3[0][0]).total_seconds()
        return len(last3) == 3 and all(v == level for _, v in last3) and span >= 90

    def _checked(self, snap: OptionChainSnapshot) -> OptionChainSnapshot:
        """The index level of a capture: the last traded one once the closing auction has begun.

        From the end of continuous cash trading (15:15 IST, 15:30 from 7 Dec 2026) the
        exchange publishes only indicative auction values for the index. They are not
        collected: the chain keeps the last level seen before that moment, with a note, and
        the broker's own value stays in ``underlying_ltp_broker``. Option prices, OI and
        volume are stored as always. A capture made in the auction with no earlier level
        this day (a restart) keeps the existing checks.
        """
        t = snap.retrieved_at.astimezone(IST)
        end = spot_end(t.date())
        if end is not None and t.weekday() < 5 and t.time() >= end:
            held = self._last_traded
            if held is not None and held[0] == t.date():
                note = (
                    f"Index not collected in the closing auction (from {end:%H:%M}): the level "
                    f"is the last traded one, {held[1]:g} at {held[2].astimezone(IST):%H:%M}."
                )
                update = {
                    "underlying_ltp": held[1],
                    "underlying_ltp_broker": snap.underlying_ltp,
                    "spot_note": note,
                    "warnings": [*snap.warnings, note],
                }
                return snap.model_copy(update=update)
        out = self._checked_core(snap)
        trading = t.weekday() < 5 and SESSION_OPEN <= t.time() and (end is None or t.time() < end)
        if out.underlying_ltp is not None and trading:
            self._last_traded = (t.date(), float(out.underlying_ltp), out.retrieved_at)
        return out

    def _checked_core(self, snap: OptionChainSnapshot) -> OptionChainSnapshot:
        """A frozen index quote is replaced by the level the chain's own prices imply.

        A quote that is moving is never replaced.

        See app/domain/spot_check.py; the raw payload on disk is untouched."""
        if not self.spot_check:
            return snap
        spot, broker, note = checked_spot(
            snap.rows, snap.underlying_ltp, snap.expiry, snap.retrieved_at, self._quote_frozen(snap)
        )
        if note is None:
            return snap
        log_event(
            logger, logging.WARNING, "index_quote_replaced",
            broker=broker, used=spot, expiry=snap.expiry.isoformat(),
        )
        detail = f"broker {broker} -> {spot} ({snap.expiry.isoformat()})"
        ledger.record("index_quote_replaced", detail, snap.retrieved_at)
        update = {
            "underlying_ltp": spot,
            "underlying_ltp_broker": broker,
            "spot_note": note,
            "warnings": [*snap.warnings, note],
        }
        return snap.model_copy(update=update)

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

    def _normalise(
        self, got: Any, exp: date, kinds: list[ExpiryKind], received: datetime
    ) -> tuple[OptionChainSnapshot, int]:
        one = normalize_option_chain(
            got,
            snapshot_id=new_snapshot_id(self.underlying, exp, received),
            session_id=self.state.session_id,
            underlying=self.underlying,
            expiry=exp,
            expiry_kinds=kinds,
            source=self.snapshot_source,
            retrieved_at=received,
            requested_strike_count=self.strike_count,
        )
        return one, core_holes(one)

    def _finish(self, snap: OptionChainSnapshot) -> tuple[OptionChainSnapshot, str]:
        """The index-level check and the fingerprint.

        Captures are serialised by ``_capture_lock``, so nothing else touches the state they read.
        """
        snap = self._checked(snap)
        return snap, fingerprint(snap)

    async def _capture_one(
        self, exp: date, kinds: list[ExpiryKind], skip_unchanged: bool = False
    ) -> SnapshotSummary | None:
        exp_s = exp.isoformat()
        raw, snap, holes = None, None, 0
        for attempt in range(1 + CORE_RETRIES):
            got = await self._with_relogin(
                lambda: self.broker.get_option_chain(self.underlying, exp_s, self.strike_count)
            )
            received = datetime.now(UTC)
            # Parsing the answer into models and counting its holes is CPU work (two chains
            # a minute, 80 strikes each): in a thread, not on the loop the live ticks share.
            one, n = await asyncio.to_thread(self._normalise, got, exp, kinds, received)
            if snap is None or n < holes:  # keep the more complete answer
                raw, snap, holes = got, one, n
            if holes == 0:
                break
            log_event(
                logger, logging.WARNING, "snapshot_core_holes",
                expiry=exp_s, holes=n, attempt=attempt + 1,
            )
            await asyncio.sleep(CORE_RETRY_S)
        assert snap is not None and raw is not None
        final, fp = await asyncio.to_thread(self._finish, snap)
        snap = final
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
        if self.shadow is not None:  # measures the feed against this capture; stores nothing
            try:
                await asyncio.to_thread(self.shadow, snap)
            except Exception as e:  # noqa: BLE001 - a measurement must never disturb a capture
                log_event(logger, logging.WARNING, "shadow_compare_failed", error=type(e).__name__)
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
