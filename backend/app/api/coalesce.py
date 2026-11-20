"""Share one computation between callers that ask for the same thing at about the same time.

Several tabs, a phone and the page's own polls call the same heavy endpoint within a second of each other; each used to run the whole computation (the market-intelligence summary:
about 350 ms at the median, 1.2 s at the slowest 5%, measured on the server on 20 Nov 2026, and the slowest endpoint under a load test with 16 clients). A caller that arrives while the
same computation is running waits for it; a result younger than ``ttl`` seconds is returned as it is. The value keeps the timestamps it was computed with, so nothing looks fresher than it is.
Errors are never kept: the next caller computes again.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Hashable
from typing import Any


class Coalescer:
    def __init__(self, ttl_s: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.ttl_s = ttl_s
        self._clock = clock
        self._done: dict[Hashable, tuple[float, Any]] = {}
        self._running: dict[Hashable, asyncio.Future[Any]] = {}

    async def get(self, key: Hashable, compute: Callable[[], Awaitable[Any]]) -> Any:
        hit = self._done.get(key)
        if hit is not None and self._clock() - hit[0] < self.ttl_s:
            return hit[1]
        running = self._running.get(key)
        if running is not None:
            return await asyncio.shield(running)
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._running[key] = fut
        try:
            value = await compute()
        except BaseException as exc:
            fut.set_exception(exc)
            fut.exception()  # mark as retrieved: waiters re-raise it, and nobody waiting is not an error
            raise
        else:
            self._done[key] = (self._clock(), value)
            fut.set_result(value)
            return value
        finally:
            self._running.pop(key, None)
            if len(self._done) > 64:  # a handful of keys in practice (one per expiry); never grow without bound
                oldest = min(self._done, key=lambda k: self._done[k][0])
                self._done.pop(oldest, None)
