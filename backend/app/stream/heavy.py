"""One queue for the heavy background computations, run at a lower priority.

27 Nov 2026, the open: five background threads (history re-scoring, GEX and IV surfaces, the broker's scrip master, Yahoo bars) ran their CPU-heavy work at the same time on the server's one
core, each taking the interpreter lock in turn, and the event loop that carries the live feed waited behind them: a second at a time, in bursts every five minutes. The work is not wasted
by waiting its turn, only ordered: ``run_heavy`` sends it to a single worker thread whose jobs run one after another, at a lower scheduling priority than the loop (Linux).
"""

from __future__ import annotations

import asyncio
import functools
import os
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TypeVar

T = TypeVar("T")
NICE = 10


def _lower_priority() -> None:
    try:
        os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), NICE)  # type: ignore[attr-defined,unused-ignore]
    except (AttributeError, OSError):
        pass  # Windows, or not allowed: the order of the queue still applies


HEAVY = ThreadPoolExecutor(max_workers=1, thread_name_prefix="heavy", initializer=_lower_priority)


async def run_heavy(fn: Callable[..., T], *args: Any) -> T:
    """Run ``fn(*args)`` on the heavy worker (one at a time, in the order asked) and wait for it without blocking the event loop."""
    return await asyncio.get_running_loop().run_in_executor(HEAVY, functools.partial(fn, *args))
