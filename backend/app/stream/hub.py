"""Fan-out of stream messages to browser WebSocket clients (one broker connection, many tabs).

Live values are conflated per client: a client that is slow (a phone on a weak connection)
always receives the newest value of each instrument, never a growing queue of old ones. Before
this a slow client first saw prices that were seconds old (a FIFO of 250 ms batches, up to 100
deep) and was then dropped and reconnected.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)
CONFLATED = ("ticks", "status", "market")


class Subscriber:
    def __init__(self, maxsize: int) -> None:
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=maxsize)  # other messages
        self.dropped = False
        self.ticks: dict[str, dict[str, Any]] = {}  # newest tick of each instrument not yet sent
        self.status: dict[str, Any] | None = None
        self.market: dict[str, Any] | None = None
        self.wake = asyncio.Event()
        self.oldest: float | None = None  # when the oldest unsent value arrived
        self.conflated = 0  # ticks replaced by a newer one before they were sent
        self.sent_batches = 0
        self.max_delay_ms = (
            0.0  # worst wait between a value arriving and being handed to the socket
        )

    def put(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "ticks":
            for t in msg["ticks"]:
                prev = self.ticks.get(t["key"])
                if prev is not None:
                    if t.get("seq", 0) < prev.get("seq", 0):
                        continue
                    self.conflated += 1
                self.ticks[t["key"]] = t
        elif kind == "status":
            self.status = msg
        elif kind == "market":
            self.market = msg
        else:
            self.queue.put_nowait(msg)
        if self.oldest is None:
            self.oldest = time.monotonic()
        self.wake.set()

    def take(self) -> list[dict[str, Any]]:
        """Everything waiting, newest values only: other messages, market, status, ticks."""
        out: list[dict[str, Any]] = []
        while not self.queue.empty():
            out.append(self.queue.get_nowait())
        if self.market is not None:
            out.append(self.market)
            self.market = None
        if self.status is not None:
            out.append(self.status)
            self.status = None
        if self.ticks:
            out.append({"type": "ticks", "ticks": list(self.ticks.values())})
            self.ticks = {}
        if self.oldest is not None:
            self.max_delay_ms = max(self.max_delay_ms, (time.monotonic() - self.oldest) * 1000)
            self.oldest = None
        if out:
            self.sent_batches += 1
        return out

    async def next_batch(self) -> list[dict[str, Any]]:
        while True:
            await self.wake.wait()
            self.wake.clear()
            if self.dropped:
                return []  # the hub let this client go: the caller closes the socket
            batch = self.take()
            if batch:
                return batch


class Hub:
    def __init__(self, max_clients: int = 10, queue_size: int = 100) -> None:
        self._subs: set[Subscriber] = set()
        self.max_clients = max_clients
        self._queue_size = queue_size
        self.messages_published = 0
        self.slow_client_drops = 0

    def __len__(self) -> int:
        return len(self._subs)

    def subscribe(self) -> Subscriber | None:
        if len(self._subs) >= self.max_clients:
            return None
        sub = Subscriber(self._queue_size)
        self._subs.add(sub)
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        self._subs.discard(sub)

    def publish(self, msg: dict[str, Any]) -> None:
        self.messages_published += 1
        for sub in list(self._subs):
            try:
                sub.put(msg)
            except asyncio.QueueFull:
                # Only non-live messages can fill a queue; a client that cannot keep up goes.
                sub.dropped = True
                sub.wake.set()
                self._subs.discard(sub)
                self.slow_client_drops += 1
                logger.warning("ws_client_dropped_slow")

    def stats(self) -> dict[str, Any]:
        return {
            "clients": len(self._subs),
            "published": self.messages_published,
            "slow_drops": self.slow_client_drops,
            "per_client": [
                {
                    "conflated": s.conflated,
                    "batches": s.sent_batches,
                    "max_delay_ms": round(s.max_delay_ms, 1),
                }
                for s in self._subs
            ],
        }
