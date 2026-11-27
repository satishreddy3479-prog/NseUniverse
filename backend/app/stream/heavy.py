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
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, TypeVar

T = TypeVar("T")
NICE = 10


def _lower_priority() -> None:
    try:
        os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), NICE)  # type: ignore[attr-defined,unused-ignore]
    except (AttributeError, OSError):
        pass  # Windows, or not allowed: the order of the queue still applies


def _new_worker() -> ThreadPoolExecutor:
    return ThreadPoolExecutor(max_workers=1, thread_name_prefix="heavy", initializer=_lower_priority)


HEAVY = _new_worker()


def submit(fn: Callable[[], Any]) -> Future[Any]:
    """Queue ``fn`` on the heavy worker (the worker is looked up now, so a restart of it is picked up)."""
    return HEAVY.submit(fn)


def stop_heavy() -> None:
    """At shutdown: drop the queued jobs and do not wait for the running one.

    27 Nov 2026: the interpreter waits for every queued job of a thread pool before it exits; under load that
    held the stop past systemd's 20 s and the process was killed with the broker connection still open.
    A fresh worker takes over so a later use (tests, a second app in the same process) still works."""
    global HEAVY
    old, HEAVY = HEAVY, _new_worker()
    old.shutdown(wait=False, cancel_futures=True)


async def run_heavy(fn: Callable[..., T], *args: Any) -> T:
    """Run ``fn(*args)`` on the heavy worker (one at a time, in the order asked) and wait for it without blocking the event loop."""
    return await asyncio.get_running_loop().run_in_executor(HEAVY, functools.partial(fn, *args))
