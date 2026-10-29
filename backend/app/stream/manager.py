"""StreamManager: the single owner of the broker feed.

Guarantees: at most one feed session at a time (start is idempotent), bounded reconnect backoff,
connection state kept separate from data freshness, the only data source is the live broker feed.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from app.logging_setup import log_event
from app.stream.book import LiveBook
from app.stream.feed import FeedSession
from app.stream.hub import Hub
from app.stream.models import (
    FeedEvent,
    FeedToken,
    Freshness,
    LiveTick,
    MarketStatus,
    StreamError,
    StreamState,
    StreamStatusModel,
)

logger = logging.getLogger(__name__)
ACTIVE_STATES = {
    StreamState.CONNECTING,
    StreamState.SUBSCRIBING,
    StreamState.WAITING_FOR_DATA,
    StreamState.STREAMING,
    StreamState.RECONNECTING,
}
SUBSCRIBE_CHUNK = 200


@dataclass
class Universe:
    tokens: list[FeedToken]
    test_tokens: list[FeedToken]
    expiries: list[str] = field(default_factory=list)
    #: breadth stocks: subscribed after the option universe, best effort, kept off the browser feed
    market_tokens: list[FeedToken] = field(default_factory=list)


class FeedAuthError(Exception):
    """Authentication with the feed failed; a fresh broker login may fix it."""


def backoff_delay(attempt: int, base: float, cap: float) -> float:
    """attempt 1 -> base, 2 -> 2*base, ... capped. Deterministic (no jitter) for testability."""
    return float(min(cap, base * (2 ** max(0, attempt - 1))))


@dataclass
class StreamConfig:
    stale_after_seconds: int = 30
    broadcast_interval_ms: int = 250
    status_interval_s: float = 1.0
    max_reconnect_attempts: int = 8
    backoff_base_s: float = 2.0
    backoff_cap_s: float = 60.0
    test_timeout_s: float = 10.0
    healthy_reset_s: float = 60.0  # a session that lived this long resets the retry budget


class StreamManager:
    def __init__(
        self,
        *,
        feed_factory: Callable[[], Awaitable[FeedSession]],
        universe_provider: Callable[[], Awaitable[Universe]],
        config: StreamConfig | None = None,
        hub: Hub | None = None,
        relogin: Callable[[], Awaitable[object]] | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        on_event: Callable[[str, str], None] | None = None,
    ) -> None:
        self._factory = feed_factory
        self._universe = universe_provider
        self.cfg = config or StreamConfig()
        self.hub = hub if hub is not None else Hub()
        self._relogin = relogin
        self._now = clock
        self._sleep = sleep
        self._on_event = on_event
        self.book = LiveBook()
        self._lock = asyncio.Lock()
        self._supervisor: asyncio.Task[None] | None = None
        self._bg: list[asyncio.Task[None]] = []
        self._feed: FeedSession | None = None
        self._stop = False
        self._reset(StreamState.STOPPED)

    # ------------------------------------------------------------------ state
    def _reset(self, state: StreamState) -> None:
        self.state = state
        self.state_since = self._now()
        self.phase: Literal["idle", "test_subscription", "full_subscription"] = "idle"
        self.test_result: Literal["not_run", "received", "no_data"] = "not_run"
        self.message_count = 0
        self.duplicate_count = 0
        self.reconnect_count = 0
        self.connected_since: datetime | None = None
        self.last_message_at: datetime | None = None
        self.last_market_data_at: datetime | None = None
        self.subscribed_tokens = 0
        self.market_message_count = 0
        self.on_internal: Callable[[LiveTick], None] | None = None
        self.on_internal_errors = 0
        self.market_subscribed = 0
        self.market_note = "not requested"
        self.acknowledged_tokens = 0
        self.expiries: list[str] = []
        self.market = MarketStatus()
        self.market_segments: dict[str, MarketStatus] = {}
        self.errors: deque[StreamError] = deque(maxlen=30)
        self._first_data = asyncio.Event()
        self.book.clear()

    def _emit(self, kind: str, detail: str) -> None:
        """Send a connection event to the observation log; a log failure never breaks streaming."""
        if self._on_event is not None:
            try:
                self._on_event(kind, detail)
            except Exception:  # noqa: BLE001
                logger.warning("event_log_failed")

    def _set(self, state: StreamState) -> None:
        if state is not self.state:
            self._emit("stream_state", f"{self.state.value} -> {state.value}")
            log_event(logger, logging.INFO, "stream_state", old=self.state.value, new=state.value)
            self.state = state
            self.state_since = self._now()

    def _derive_market(self) -> MarketStatus:
        """Market state that matters here: NSE F&O, else NSE cash. Other segments are ignored.

        Segment-less messages are used only when no NSE segment has reported.
        """
        segs = self.market_segments
        for key in ("nse_fo", "nse_cm", "unknown"):
            if key in segs:
                return segs[key]
        return MarketStatus()

    def _error(self, code: str, message: str) -> None:
        self.errors.appendleft(StreamError(at=self._now(), code=code, message=message[:200]))
        self._emit("stream_error", f"{code}: {message[:200]}")
        log_event(logger, logging.WARNING, "stream_error", code=code, reason=message[:200])

    @property
    def running(self) -> bool:
        return self._supervisor is not None and not self._supervisor.done()

    def status(self) -> StreamStatusModel:
        now = self._now()
        age = (now - self.last_market_data_at).total_seconds() if self.last_market_data_at else None
        if age is None:
            freshness = Freshness.NONE
        elif age <= self.cfg.stale_after_seconds:
            freshness = Freshness.FRESH
        elif self.market.state == "closed":
            freshness = Freshness.MARKET_CLOSED
        else:
            freshness = Freshness.STALE
        effective = self.state.value
        if self.state in (StreamState.STREAMING, StreamState.WAITING_FOR_DATA):
            if freshness is Freshness.STALE:
                effective = "stale"
            elif freshness is Freshness.MARKET_CLOSED or (
                self.market.state == "closed" and freshness is Freshness.NONE
            ):
                effective = "market_closed"
        note = ""
        if self.state is StreamState.WAITING_FOR_DATA:
            note = "Subscribed, but no market-data message has arrived yet." + (
                " The exchange reports the market is closed."
                if self.market.state == "closed"
                else ""
            )
        return StreamStatusModel(
            state=self.state,
            state_since=self.state_since,
            effective_state=effective,
            freshness=freshness,
            data_source="live"
            if self.state is not StreamState.STOPPED or len(self.book)
            else "none",
            phase=self.phase,
            test_subscription_result=self.test_result,
            message_count=self.message_count,
            tick_count=self.book.tick_count,
            instruments_with_data=len(self.book),
            subscribed_tokens=self.subscribed_tokens,
            acknowledged_tokens=self.acknowledged_tokens,
            reconnect_count=self.reconnect_count,
            connected_since=self.connected_since,
            last_message_at=self.last_message_at,
            last_market_data_at=self.last_market_data_at,
            data_age_seconds=None if age is None else round(age, 1),
            stale_after_seconds=self.cfg.stale_after_seconds,
            expiries=self.expiries,
            market=self.market,
            market_segments=dict(self.market_segments),
            recent_errors=list(self.errors),
            note=note,
        )

    # ---------------------------------------------------------------- control
    async def start(self) -> StreamStatusModel:
        async with self._lock:
            if self.running:
                return self.status()  # idempotent: never a second ingestion process
            self._stop = False
            self._reset(StreamState.CONNECTING)
            self._supervisor = asyncio.create_task(self._supervise())
        return self.status()

    async def stop(self) -> StreamStatusModel:
        async with self._lock:
            self._stop = True
            sup = self._supervisor
            if sup and not sup.done():
                sup.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await sup
            self._supervisor = None
            feed, self._feed = self._feed, None
            if feed is not None:
                with contextlib.suppress(Exception):
                    await feed.close()
            self._set(StreamState.STOPPED)
            self.phase = "idle"
            self.market = (
                MarketStatus()
            )  # last exchange status is not current once we stop listening
            self.market_segments = {}
        return self.status()

    def start_background(self) -> None:
        if self._bg:
            return
        self._bg = [
            asyncio.create_task(self._flush_loop()),
            asyncio.create_task(self._status_loop()),
        ]

    async def shutdown(self) -> None:
        await self.stop()
        for t in self._bg:
            t.cancel()
        for t in self._bg:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        self._bg = []

    # ------------------------------------------------------------ supervision
    async def _supervise(self) -> None:
        attempt = 0
        try:
            while not self._stop:
                started = self._now()
                try:
                    universe = await self._universe()
                    self.expiries = universe.expiries
                    feed = await self._factory()
                    self._feed = feed
                    await self._run_session(feed, universe)
                except asyncio.CancelledError:
                    raise
                except FeedAuthError as e:
                    self._set(StreamState.AUTH_FAILED)
                    self._error("auth", str(e))
                    if self._relogin:
                        with contextlib.suppress(Exception):
                            await self._relogin()
                except Exception as e:  # noqa: BLE001 - never leak raw text; type only
                    code = getattr(e, "code", type(e).__name__)
                    msg = getattr(e, "message", None) or type(e).__name__
                    self._error(str(code), str(msg))
                finally:
                    old_feed = self._feed
                    self._feed = None
                    if old_feed is not None:
                        with contextlib.suppress(Exception):
                            await old_feed.close()
                if self._stop:
                    break
                lived = (self._now() - started).total_seconds()
                attempt = 0 if lived >= self.cfg.healthy_reset_s else attempt + 1
                if attempt > self.cfg.max_reconnect_attempts:
                    self._set(StreamState.FAILED)
                    self._error(
                        "retries_exhausted",
                        f"gave up after {self.cfg.max_reconnect_attempts} reconnect attempts",
                    )
                    return
                if self.state is not StreamState.AUTH_FAILED:
                    self._set(StreamState.RECONNECTING)
                self.reconnect_count += 1
                await self._sleep(
                    backoff_delay(max(attempt, 1), self.cfg.backoff_base_s, self.cfg.backoff_cap_s)
                )
        except asyncio.CancelledError:
            raise

    async def _run_session(self, feed: FeedSession, universe: Universe) -> None:
        self._set(StreamState.CONNECTING)
        self._first_data = asyncio.Event()
        await feed.connect()
        self.connected_since = self._now()
        consumer = asyncio.create_task(self._consume(feed))
        try:
            # 1) small test subscription: index + a couple of ATM contracts
            self._set(StreamState.SUBSCRIBING)
            self.phase = "test_subscription"
            await feed.subscribe_market_status()
            await feed.subscribe(universe.test_tokens)
            self.subscribed_tokens = feed.subscription_count
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._first_data.wait(), timeout=self.cfg.test_timeout_s)
            self.test_result = "received" if self._first_data.is_set() else "no_data"
            if self.test_result == "no_data":
                self._error("test_no_data", "no market data during the test subscription")
            # 2) full universe (SDK enforces its own token limit and raises SubscriptionError)
            self.phase = "full_subscription"
            rest = [t for t in universe.tokens if t not in universe.test_tokens]
            for i in range(0, len(rest), SUBSCRIBE_CHUNK):
                await feed.subscribe(rest[i : i + SUBSCRIBE_CHUNK])
            self.subscribed_tokens = feed.subscription_count
            self.acknowledged_tokens = feed.acknowledged_count
            if self.state is not StreamState.STREAMING:
                self._set(StreamState.WAITING_FOR_DATA)
            await self._subscribe_market(feed, universe)
            self._emit(
                "stream_subscribed",
                f"tokens={self.subscribed_tokens} acknowledged={self.acknowledged_tokens}"
                f" test={self.test_result}",
            )
            log_event(
                logger,
                logging.INFO,
                "stream_subscribed",
                tokens=self.subscribed_tokens,
                acknowledged=self.acknowledged_tokens,
                test=self.test_result,
            )
            await consumer
        finally:
            if not consumer.done():
                consumer.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await consumer

    async def _subscribe_market(self, feed: FeedSession, universe: Universe) -> None:
        """Breadth stocks. Best effort: a failure is recorded and the option feed carries on."""
        if not universe.market_tokens:
            self.market_note = "not requested"
            return
        self.book.internal_keys = {t.key for t in universe.market_tokens}
        done = 0
        try:
            for i in range(0, len(universe.market_tokens), SUBSCRIBE_CHUNK):
                chunk = universe.market_tokens[i : i + SUBSCRIBE_CHUNK]
                await feed.subscribe(chunk)
                done += len(chunk)
            self.market_note = f"subscribed {done} stocks"
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - never let this reach the option feed
            total = len(universe.market_tokens)
            self.market_note = f"stopped after {done} of {total} stocks: {type(e).__name__}"
            self._emit("market_subscribe_failed", self.market_note)
        self.market_subscribed = done

    async def _consume(self, feed: FeedSession) -> None:
        async for ev in feed.events():
            self._handle(ev, feed)
            if ev.kind == "closed":
                return

    # ----------------------------------------------------------------- events
    def _handle(self, ev: FeedEvent, feed: FeedSession) -> None:
        now = self._now()
        if ev.kind == "tick" and ev.tick is not None and ev.tick.key in self.book.internal_keys:
            self.book.update_internal(ev.tick)
            self.market_message_count += 1
            if self.on_internal is not None:
                try:
                    self.on_internal(ev.tick)
                except Exception as e:  # noqa: BLE001 - analysis must never disturb the feed
                    self.on_internal_errors += 1
                    n = self.on_internal_errors
                    if n in (1, 10, 100) or n % 1000 == 0:
                        log_event(
                            logger, logging.WARNING, "market_tick_handler_failed",
                            error=type(e).__name__, count=n,
                        )  # fmt: skip
            return
        if ev.kind == "tick" and ev.tick is not None:
            self.message_count += 1
            self.last_message_at = now
            stored = self.book.update(ev.tick)
            if stored is None:
                self.duplicate_count += 1
                return
            self.last_market_data_at = now
            self.acknowledged_tokens = feed.acknowledged_count
            if not self._first_data.is_set():
                self._first_data.set()
            if self.state in (
                StreamState.WAITING_FOR_DATA,
                StreamState.SUBSCRIBING,
                StreamState.RECONNECTING,
                StreamState.CONNECTING,
            ):
                self._set(StreamState.STREAMING)
        elif ev.kind == "market_status" and ev.market is not None:
            self.message_count += 1
            self.last_message_at = now
            # The feed reports every exchange segment (cash, F&O, currency, commodity...). Keep them
            # apart: one segment's "closed" must not overwrite the F&O segment's "open".
            seg = (ev.market.exchange_segment or "unknown").strip().lower()
            before = self.market_segments.get(seg)
            if before is None or before.state != ev.market.state:
                self._emit("market_status", f"{seg}: {ev.market.state} (code {ev.market.code})")
            self.market_segments[seg] = ev.market
            self.market = self._derive_market()
            log_event(
                logger,
                logging.INFO,
                "market_status",
                segment=seg,
                state=ev.market.state,
                code=ev.market.code,
            )
            self.hub.publish({"type": "market", "market": ev.market.model_dump(mode="json")})
        elif ev.kind == "disconnected":
            self.reconnect_count += 1
            self._set(StreamState.RECONNECTING)
            self._error("disconnected", "feed connection dropped; reconnecting")
        elif ev.kind == "connected":
            self.connected_since = now
            if self.state is StreamState.RECONNECTING:
                self._set(StreamState.WAITING_FOR_DATA)
        elif ev.kind == "error":
            self._error("feed_error", ev.detail or "feed error")

    # ------------------------------------------------------------ background
    async def _flush_loop(self) -> None:
        interval = self.cfg.broadcast_interval_ms / 1000
        while True:
            await self._sleep(interval)
            ticks = self.book.drain_pending()
            if ticks and len(self.hub):
                self.hub.publish(
                    {"type": "ticks", "ticks": [t.model_dump(mode="json") for t in ticks]}
                )

    async def _status_loop(self) -> None:
        while True:
            await self._sleep(self.cfg.status_interval_s)
            if len(self.hub):
                self.hub.publish(
                    {"type": "status", "status": self.status().model_dump(mode="json")}
                )

    def hello(self) -> dict[str, object]:
        return {
            "type": "hello",
            "status": self.status().model_dump(mode="json"),
            "ticks": [t.model_dump(mode="json") for t in self.book.snapshot()],
        }


__all__ = [
    "LiveTick",
    "StreamManager",
    "StreamConfig",
    "Universe",
    "FeedAuthError",
    "backoff_delay",
]
