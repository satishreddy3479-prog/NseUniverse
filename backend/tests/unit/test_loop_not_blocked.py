"""Slow work (a big file parse, a stored chain read, the SDK import) must not hold the event loop.

The loop carries the live broker feed. Each test runs the slow step while a heartbeat checks how
late the loop runs."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import app.swing.live as swing_live
from app.broker.kotak import KotakBroker
from app.services.universe import build_universe
from tests.unit.test_swing_live import Rig
from tests.unit.test_universe_offhours import NIGHT, down, stored_service

SLOW_S = 0.6
MAX_LATE_S = 0.25  # the heartbeat ticks every 20 ms: a blocked loop would be ~0.6 s late


async def worst_gap(work: Callable[[], Awaitable[Any]]) -> float:
    gap = 0.0
    stop = False

    async def beat() -> None:
        nonlocal gap
        last = time.perf_counter()
        while not stop:
            await asyncio.sleep(0.02)
            now = time.perf_counter()
            gap = max(gap, now - last - 0.02)
            last = now

    task = asyncio.create_task(beat())
    await asyncio.sleep(0.1)
    await work()
    stop = True
    await task
    return gap


async def test_the_swing_scrip_master_is_parsed_off_the_loop(
    tmp_path: Path, monkeypatch: Any
) -> None:
    def slow_parse(rows: list[dict]) -> dict:
        time.sleep(SLOW_S)
        return {}

    monkeypatch.setattr(swing_live, "parse_scrip_master_any_series", slow_parse)
    r = Rig(tmp_path)
    gap = await worst_gap(lambda: r.live.refresh())
    assert r.master_calls == 1 and gap < MAX_LATE_S


async def test_a_feed_reconnect_reads_the_stored_chains_off_the_loop(tmp_path: Path) -> None:
    svc, b = await stored_service(tmp_path)
    b.get_expiries = down  # type: ignore[method-assign]
    real = svc.store.latest

    def slow_latest(*a: Any, **k: Any) -> Any:
        time.sleep(SLOW_S / 2)
        return real(*a, **k)

    svc.store.latest = slow_latest  # type: ignore[method-assign]
    gap = await worst_gap(lambda: build_universe(svc, now=lambda: NIGHT))
    assert gap < MAX_LATE_S


async def test_the_broker_sdk_is_built_off_the_event_loop() -> None:
    def slow_factory(**kw: Any) -> Any:
        time.sleep(SLOW_S)
        return object()

    broker = KotakBroker.__new__(KotakBroker)
    broker._client = None  # noqa: SLF001
    broker._client_factory = slow_factory  # noqa: SLF001
    broker._secret = lambda name: "x"  # type: ignore[method-assign]  # noqa: SLF001
    gap = await worst_gap(broker._client_async)  # noqa: SLF001
    assert broker._client is not None and gap < MAX_LATE_S  # noqa: SLF001


async def test_the_ops_alerts_lot_size_read_is_off_the_loop() -> None:
    """25 Nov 2026: the end-of-day scan held the observations lock for seconds and this
    handler, reading the lot size on the loop, stalled the live feed for up to 13.8 s."""
    from types import SimpleNamespace

    from app.api.routes import ops_alerts

    class SlowObs:
        def latest_lot_size(self, underlying: str) -> int:
            time.sleep(SLOW_S)  # the lock held by the end-of-day scan
            return 65

    settings = SimpleNamespace(underlying="NIFTY", cost_lot_size=65)
    state = SimpleNamespace(settings=settings, observations=SlowObs())
    request: Any = SimpleNamespace(app=SimpleNamespace(state=state))
    out: dict[str, Any] = {}

    async def work() -> None:
        out.update(await ops_alerts(request))

    gap = await worst_gap(work)
    assert gap < MAX_LATE_S, f"the loop was late by {gap:.2f} s while the lot size was read"
    assert "alerts" in out
    assert not any(a["key"] == "lot-size" for a in out["alerts"])  # 65 = configured: no alert
