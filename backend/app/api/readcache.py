"""One computation for everyone who asks for the same thing at the same time.

A dashboard with many boxes (and a phone and a PC open together) asks the server for the same series over and over: 26 Nov 2026 had 217 strike-series, 142 outlook and 54 IV-momentum
requests in market hours, many of them within the same second, each recomputed from the database on a single CPU core (median 2.7 s, 1.6 s and 9 s while the feed was busy). Here
the first caller computes (in a worker thread), every caller that arrives meanwhile waits for that same answer, and the answer is kept for a few seconds.

The time a result is kept is shorter than the data's own rhythm (the sampler stores one chain a minute), so nobody sees data older than that. An error is never kept.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from collections.abc import Callable, Hashable
from typing import Any

from app.stream.heavy import run_heavy

MAX_ENTRIES = 256


class ReadCache:
    def __init__(self, max_entries: int = MAX_ENTRIES, clock: Callable[[], float] = time.monotonic, ttl_scale: float = 1.0) -> None:
        self._d: OrderedDict[Hashable, tuple[float, Any]] = OrderedDict()
        self._inflight: dict[Hashable, asyncio.Future[Any]] = {}
        self._max, self._clock, self._scale = max_entries, clock, ttl_scale
        self.hits = self.shared = self.computed = 0

    async def get(self, key: Hashable, ttl_s: float, compute: Callable[[], Any]) -> Any:
        """The answer for ``key``: kept (younger than ``ttl_s``), or being computed by someone else (shared), or computed now by ``compute`` in a worker thread."""
        now = self._clock()
        hit = self._d.get(key)
        if hit is not None and now - hit[0] < ttl_s * self._scale:
            self._d.move_to_end(key)
            self.hits += 1
            return hit[1]
        waiting = self._inflight.get(key)
        if waiting is not None and waiting.get_loop() is asyncio.get_running_loop():
            self.shared += 1
            return await asyncio.shield(waiting)  # a caller that gives up does not cancel the computation the others wait for
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._inflight[key] = fut
        try:
            value = await run_heavy(compute)  # one heavy computation at a time, at a lower priority than the event loop (stream/heavy.py)
        except BaseException as e:
            if not fut.done():
                fut.set_exception(e if isinstance(e, Exception) else RuntimeError("cancelled"))
                fut.exception()  # mark retrieved: with no one else waiting it must not be reported as never retrieved
            raise
        else:
            self.computed += 1
            self._d[key] = (self._clock(), value)
            self._d.move_to_end(key)
            while len(self._d) > self._max:
                self._d.popitem(last=False)
            fut.set_result(value)
            return value
        finally:
            self._inflight.pop(key, None)

    def stats(self) -> dict[str, int]:
        return {"entries": len(self._d), "hits": self.hits, "shared": self.shared, "computed": self.computed}
