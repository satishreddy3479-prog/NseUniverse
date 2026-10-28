"""Fan-out of stream messages to browser WebSocket clients (one broker connection, many tabs)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


class Subscriber:
    def __init__(self, maxsize: int) -> None:
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=maxsize)
        self.dropped = False


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
                sub.queue.put_nowait(msg)
            except asyncio.QueueFull:
                # A client that cannot keep up must not slow the others or grow memory.
                sub.dropped = True
                self._subs.discard(sub)
                self.slow_client_drops += 1
                logger.warning("ws_client_dropped_slow")
