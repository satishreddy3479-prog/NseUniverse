"""One computation for everyone who asks for the same thing at the same time (see app/api/readcache.py)."""

from __future__ import annotations

import asyncio
import threading
import time

import pytest

from app.api.readcache import ReadCache


class Clock:
    t = 0.0

    def __call__(self) -> float:
        return self.t


def slow(counter: list[int], value: str = "answer", secs: float = 0.2) -> object:
    def run() -> str:
        counter.append(1)
        time.sleep(secs)
        return value

    return run


@pytest.mark.asyncio
async def test_callers_at_the_same_moment_share_one_computation() -> None:
    cache, n = ReadCache(), []
    answers = await asyncio.gather(*(cache.get(("strike-series", "2026-12-01"), 5.0, slow(n)) for _ in range(12)))  # type: ignore[arg-type]
    assert answers == ["answer"] * 12 and len(n) == 1  # twelve boxes, one computation
    assert cache.stats() == {"entries": 1, "hits": 0, "shared": 11, "computed": 1}


@pytest.mark.asyncio
async def test_an_answer_is_kept_for_its_time_and_then_computed_again() -> None:
    clock, n = Clock(), []
    cache = ReadCache(clock=clock)
    assert await cache.get("k", 5.0, slow(n, secs=0)) == "answer"  # type: ignore[arg-type]
    clock.t = 4.9
    await cache.get("k", 5.0, slow(n, secs=0))  # type: ignore[arg-type]
    assert len(n) == 1 and cache.hits == 1  # still fresh
    clock.t = 5.1
    await cache.get("k", 5.0, slow(n, secs=0))  # type: ignore[arg-type]
    assert len(n) == 2  # older than its time: new data
    await cache.get("other", 5.0, slow(n, secs=0))  # type: ignore[arg-type]
    assert len(n) == 3  # a different question is a different answer


@pytest.mark.asyncio
async def test_an_error_reaches_everyone_waiting_and_is_never_kept() -> None:
    cache, calls = ReadCache(), []

    def boom() -> str:
        calls.append(1)
        time.sleep(0.1)
        raise ValueError("database busy")

    results = await asyncio.gather(*(cache.get("k", 5.0, boom) for _ in range(5)), return_exceptions=True)
    assert all(isinstance(r, ValueError) for r in results) and len(calls) == 1
    assert cache.stats()["entries"] == 0
    assert await cache.get("k", 5.0, lambda: "recovered") == "recovered"  # the next caller tries again


@pytest.mark.asyncio
async def test_a_caller_that_gives_up_does_not_stop_the_computation_the_others_wait_for() -> None:
    cache, n = ReadCache(), []
    first = asyncio.create_task(cache.get("k", 5.0, slow(n, secs=0.3)))  # type: ignore[arg-type]
    await asyncio.sleep(0.05)
    second = asyncio.create_task(cache.get("k", 5.0, slow(n)))  # type: ignore[arg-type]
    third = asyncio.create_task(cache.get("k", 5.0, slow(n)))  # type: ignore[arg-type]
    await asyncio.sleep(0.05)
    second.cancel()  # a browser tab closed
    assert await third == "answer" and await first == "answer" and len(n) == 1


@pytest.mark.asyncio
async def test_the_computation_runs_in_a_worker_thread_and_the_cache_is_bounded() -> None:
    cache = ReadCache(max_entries=3)
    where: list[int] = []
    await cache.get("t", 1.0, lambda: where.append(threading.get_ident()))
    assert where[0] != threading.get_ident()  # never on the event loop
    for i in range(10):
        await cache.get(("many", i), 1.0, lambda i=i: i)  # type: ignore[misc]
    assert cache.stats()["entries"] == 3  # the oldest are dropped


@pytest.mark.asyncio
async def test_the_heavy_read_endpoints_compute_once_for_callers_at_the_same_time_and_stay_correct() -> None:
    """Through the real route: twelve boxes asking for the same IV momentum at the same moment cost one computation; another question is another computation."""
    from types import SimpleNamespace

    import httpx
    from fastapi import FastAPI

    from app.api import routes

    calls: list[tuple[str, str | None, int]] = []

    def iv_momentum(expiry: str, session: str | None, tf: int) -> dict[str, object]:
        calls.append((expiry, session, tf))
        time.sleep(0.3)
        return {"expiry": expiry, "tf": tf, "n": len(calls)}

    app = FastAPI()
    app.include_router(routes.router)
    app.state.intraday = SimpleNamespace(iv_momentum=iv_momentum)
    app.state.readcache = ReadCache()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        rs = await asyncio.gather(*(c.get("/api/intraday/iv-momentum?expiry=2026-12-01&tf=1") for _ in range(12)))
        bodies = [r.json() for r in rs]
        assert len(calls) == 1 and all(b == bodies[0] for b in bodies) and bodies[0]["tf"] == 1
        assert (await c.get("/api/intraday/iv-momentum?expiry=2026-12-01&tf=5")).json()["tf"] == 5 and len(calls) == 2  # another window is another answer
        assert (await c.get("/api/intraday/iv-momentum?expiry=2026-12-01&tf=7")).status_code == 422  # checks still happen before any computation
        assert len(calls) == 2
        app.state.readcache = None  # an application built without the wiring: it just runs
        assert (await c.get("/api/intraday/iv-momentum?expiry=2026-12-01&tf=3")).json()["tf"] == 3
