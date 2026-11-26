"""Runs the broker feed (its websocket, its packet decoding, our conversion to ticks) in a thread of its own.

The Kotak SDK decodes every packet with pydantic, and our adapter builds a tick object for every message: with 900 instruments streaming, that is work for hundreds of messages a second, done
on the one event loop that also serves the browsers, the minute jobs and every request. On 26 Nov 2026 it was the biggest single cause of the loop stalling (about 43 % of the stalls
that remained after the logging fix, 217 stalls in a session). Here the whole feed lives in its own thread and loop; the main loop only receives the converted events, handed over in
short batches (one thread hand-off per batch, not per message). With the interpreter lock switching every millisecond (see main.py) the two threads take turns instead of the loop
waiting for whole decodes, so a request is delayed by milliseconds, not by a second; and a second CPU core, when there is one, runs the other thread.

Switched by ``FEED_THREAD`` (default off): the feed is the live data of the whole application, so it is turned on deliberately, outside market hours, and watched.
Events keep their order; a connection error or a close reaches the manager exactly as before.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from collections.abc import AsyncIterator
from typing import Any

from app.stream.feed import FeedSession
from app.stream.models import FeedEvent, FeedToken

logger = logging.getLogger(__name__)
BATCH_S = 0.05  # events wait at most this long before they are handed to the main loop
BATCH_MAX = 500  # or this many
QUEUE_MAX = 20_000


class ThreadedFeed:
    source = "live"

    def __init__(self, inner: FeedSession, *, batch_s: float = BATCH_S) -> None:
        self._inner = inner
        self._batch_s = batch_s
        self._main: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue[FeedEvent] | None = None
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._ready = threading.Event()
        self._bridge_task: asyncio.Task[None] | None = None
        self._batch: list[FeedEvent] = []
        self._flush_handle: asyncio.TimerHandle | None = None
        self.batches = 0
        self.handed_over = 0
        self.queue_overflow = 0

    # ------------------------------------------------------------------ the feed's thread
    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        self._ready.set()
        try:
            loop.run_forever()
        finally:
            with contextlib.suppress(Exception):
                loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()

    def _start(self) -> None:
        if self._thread is not None:
            return
        self._main = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self._thread = threading.Thread(target=self._run, name="kotak-feed", daemon=True)
        self._thread.start()
        self._ready.wait(5)

    async def _on_feed(self, coro: Any) -> Any:
        """Run a coroutine in the feed's loop and wait for it here, without blocking this loop."""
        assert self._loop is not None
        return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coro, self._loop))

    # ------------------------------------------------------------------ bridge: feed loop -> main loop, in batches
    async def _bridge(self) -> None:
        loop = asyncio.get_running_loop()
        try:
            async for ev in self._inner.events():
                self._batch.append(ev)
                if ev.kind != "tick" or len(self._batch) >= BATCH_MAX:
                    self._flush()  # a connection event or a full batch goes at once, in order
                elif self._flush_handle is None:
                    self._flush_handle = loop.call_later(self._batch_s, self._flush)
        finally:
            self._flush()

    def _flush(self) -> None:
        if self._flush_handle is not None:
            self._flush_handle.cancel()
            self._flush_handle = None
        batch, self._batch = self._batch, []
        if batch and self._main is not None:
            with contextlib.suppress(RuntimeError):  # the main loop is closed: the application is stopping
                self._main.call_soon_threadsafe(self._deliver, batch)

    def _deliver(self, batch: list[FeedEvent]) -> None:
        """In the main loop: the events of one batch, in order. As in the adapter, a full queue drops the OLDEST (the feed is a latest-value stream)."""
        assert self._queue is not None
        self.batches += 1
        for ev in batch:
            self.handed_over += 1
            try:
                self._queue.put_nowait(ev)
            except asyncio.QueueFull:
                self.queue_overflow += 1
                with contextlib.suppress(asyncio.QueueEmpty):
                    self._queue.get_nowait()
                self._queue.put_nowait(ev)

    # ------------------------------------------------------------------ FeedSession
    async def connect(self) -> None:
        self._start()
        await self._on_feed(self._inner.connect())

        async def start_bridge() -> None:
            self._bridge_task = asyncio.get_running_loop().create_task(self._bridge())

        await self._on_feed(start_bridge())

    async def subscribe(self, tokens: list[FeedToken]) -> None:
        await self._on_feed(self._inner.subscribe(tokens))

    async def subscribe_market_status(self) -> None:
        await self._on_feed(self._inner.subscribe_market_status())

    async def snapshot_index(self, tokens: list[FeedToken]) -> None:
        await self._on_feed(self._inner.snapshot_index(tokens))  # type: ignore[attr-defined]

    async def events(self) -> AsyncIterator[FeedEvent]:
        assert self._queue is not None
        while True:
            ev = await self._queue.get()
            yield ev
            if ev.kind == "closed":
                return

    @property
    def subscription_count(self) -> int:
        return self._inner.subscription_count

    @property
    def acknowledged_count(self) -> int:
        return self._inner.acknowledged_count

    @property
    def dropped_by_kind(self) -> dict[str, int]:
        return dict(getattr(self._inner, "dropped_by_kind", {}))

    async def close(self) -> None:
        loop, thread = self._loop, self._thread
        if loop is None or thread is None:
            return
        with contextlib.suppress(Exception):
            await self._on_feed(self._inner.close())
        task = self._bridge_task
        if task is not None:
            loop.call_soon_threadsafe(task.cancel)
        loop.call_soon_threadsafe(loop.stop)
        await asyncio.to_thread(thread.join, 5)
        self._thread = self._loop = None
