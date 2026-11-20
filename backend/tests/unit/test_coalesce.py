"""Callers of one heavy endpoint share a computation; a result is reused for ttl seconds; errors are never kept."""

from __future__ import annotations

import asyncio

import pytest

from app.api.coalesce import Coalescer


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


def test_callers_that_arrive_together_share_one_computation_and_a_later_one_recomputes() -> None:
    async def scenario() -> None:
        clock, calls = Clock(), []
        co = Coalescer(2.0, clock)

        async def compute() -> dict[str, int]:
            calls.append(1)
            await asyncio.sleep(0.05)  # a slow computation: the second and third callers arrive while it runs
            return {"n": len(calls)}

        first = await asyncio.gather(co.get("x", compute), co.get("x", compute), co.get("x", compute))
        assert calls == [1] and all(v == {"n": 1} for v in first)  # one computation, one answer for three callers
        clock.t += 1.9
        assert await co.get("x", compute) == {"n": 1}  # younger than 2 s: reused, not recomputed
        clock.t += 0.2  # now 2.1 s old
        assert await co.get("x", compute) == {"n": 2} and len(calls) == 2
        assert await co.get("y", compute) == {"n": 3}  # another key is its own computation

    asyncio.run(scenario())


def test_an_error_is_raised_to_everyone_waiting_and_is_not_kept() -> None:
    async def scenario() -> None:
        co, calls = Coalescer(2.0, Clock()), []

        async def boom() -> int:
            calls.append(1)
            await asyncio.sleep(0.02)
            raise RuntimeError("source down")

        results = await asyncio.gather(co.get("k", boom), co.get("k", boom), return_exceptions=True)
        assert len(calls) == 1 and all(isinstance(r, RuntimeError) for r in results)

        async def fine() -> int:
            return 7

        assert await co.get("k", fine) == 7  # the failure was not remembered

    asyncio.run(scenario())


def test_the_store_stays_bounded() -> None:
    async def scenario() -> None:
        co = Coalescer(1000.0, Clock())

        async def one() -> int:
            return 1

        for i in range(200):
            await co.get(i, one)
        assert len(co._done) <= 65  # noqa: SLF001

    asyncio.run(scenario())


def test_the_summary_route_uses_the_shared_computation() -> None:
    from app.api import routes

    assert isinstance(routes._SUMMARY, Coalescer) and routes._SUMMARY.ttl_s == 2.0  # noqa: SLF001
    pytest.importorskip("fastapi")
