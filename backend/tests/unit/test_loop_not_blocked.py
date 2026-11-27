"""Slow work (a big file parse, a stored chain read, the SDK import) must not hold the event loop.

The loop carries the live broker feed. Each test runs the slow step while a heartbeat checks how
late the loop runs."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest

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


def test_the_market_minute_sample_runs_in_a_thread_not_on_the_event_loop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """26 Nov 2026: ``MarketService._loop`` called ``sample()`` (the whole market summary: many database reads behind one lock) on the loop thread, and the server's loop profile showed
    one-second stalls inside it at the open. The sample must run in a worker thread."""
    import asyncio
    import threading
    from datetime import UTC, datetime

    from app.market.service import MarketService
    from app.market.store import MarketStore

    svc = MarketService(MarketStore(tmp_path), clock=lambda: datetime(2026, 11, 26, 3, 50, tzinfo=UTC))
    seen: dict[str, int] = {}

    def fake_sample() -> bool:
        seen["sample"] = threading.get_ident()
        return True

    async def no_due() -> dict[str, str]:
        return {}

    sleeps = {"n": 0}

    async def fake_sleep(_s: float) -> None:
        sleeps["n"] += 1
        if sleeps["n"] >= 2:  # the start-up wait, then one pass of the loop
            raise asyncio.CancelledError

    monkeypatch.setattr(svc, "sample", fake_sample)
    monkeypatch.setattr(svc, "run_due", no_due)
    monkeypatch.setattr("app.market.service.asyncio.sleep", fake_sleep)

    async def run() -> int:
        loop_thread = threading.get_ident()
        with pytest.raises(asyncio.CancelledError):
            await svc._loop()  # noqa: SLF001
        return loop_thread

    loop_thread = asyncio.run(run())
    assert "sample" in seen and seen["sample"] != loop_thread


def test_stream_events_are_written_by_a_worker_thread_in_order_and_at_once_without_a_loop(tmp_path: Path) -> None:
    """The stream manager reports connection events from the event loop; the insert and commit must not run there."""
    import threading

    from app.storage.observations import event_writer

    seen: list[tuple[str, str, str, int]] = []

    class Store:
        def record_event(self, kind: str, detail: str, session: str) -> None:
            seen.append((kind, detail, session, threading.get_ident()))

    write = event_writer(Store(), "s1")  # type: ignore[arg-type]
    write("a", "no loop yet")  # a script or a test: written at once, in this thread
    assert seen == [("a", "no loop yet", "s1", threading.get_ident())]

    async def burst() -> int:
        for i in range(50):
            write("stream_state", f"change {i}")
        await asyncio.sleep(0.5)
        return threading.get_ident()

    loop_thread = asyncio.run(burst())
    later = seen[1:]
    assert [d for _k, d, _s, _t in later] == [f"change {i}" for i in range(50)]  # in order
    assert all(t != loop_thread for *_x, t in later) and len({t for *_x, t in later}) == 1  # one worker, never the loop thread


async def test_heavy_jobs_run_one_at_a_time_in_order_without_blocking_the_loop() -> None:
    """27 Nov 2026: five heavy threads at once starved the event loop at the open; they now queue on one worker (stream/heavy.py)."""
    import threading
    import time

    from app.stream.heavy import run_heavy

    running, peak, order = 0, 0, []
    lock = threading.Lock()

    def job(i: int) -> int:
        nonlocal running, peak
        with lock:
            running += 1
            peak = max(peak, running)
        time.sleep(0.15)
        with lock:
            running -= 1
            order.append(i)
        return i

    ticks = 0

    async def heartbeat() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(0.02)
            ticks += 1

    hb = asyncio.create_task(heartbeat())
    got = await asyncio.gather(*(run_heavy(job, i) for i in range(4)))
    hb.cancel()
    assert got == [0, 1, 2, 3] and order == [0, 1, 2, 3] and peak == 1
    assert ticks >= 15  # the loop kept running while 0.6 s of work was queued


def test_stopping_the_heavy_worker_drops_queued_jobs_and_a_new_worker_takes_over() -> None:
    """27 Nov 2026: queued jobs held the process exit past systemd's 20 s."""
    import threading

    from app.stream import heavy

    gate, started = threading.Event(), threading.Event()
    ran: list[str] = []
    running = heavy.submit(lambda: (started.set(), gate.wait(5), ran.append("running"))[2])
    assert started.wait(10)  # other tests may have queued work before it: wait until this job really runs
    queued = [heavy.submit(lambda: ran.append("queued")) for _ in range(3)]
    heavy.stop_heavy()
    assert all(f.cancelled() for f in queued)  # dropped, they never run
    gate.set()
    running.result(timeout=5)
    assert ran == ["running"]
    assert heavy.submit(lambda: "again").result(timeout=5) == "again"  # a fresh worker serves later use
