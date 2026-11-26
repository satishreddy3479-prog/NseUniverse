"""The feed in its own thread: the main event loop receives converted events in batches and is not held by the decoding."""

from __future__ import annotations

import asyncio
import sys
import threading
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest

from app.stream import threaded_feed
from app.stream.models import FeedEvent, FeedToken, LiveTick
from app.stream.threaded_feed import ThreadedFeed

NOW = datetime(2026, 11, 26, 4, 0, tzinfo=UTC)


def tick(i: int) -> FeedEvent:
    return FeedEvent(kind="tick", tick=LiveTick(key=f"nse_fo|{i % 50}", kind="scrip", exchange_segment="nse_fo", instrument_token=str(i % 50), ltp=100.0 + i, received_at=NOW))


class Fake:
    """What the SDK adapter looks like from outside: async methods and an event stream, all running on the loop they are given."""

    source = "live"
    subscription_count = 3
    acknowledged_count = 2
    dropped_by_kind = {"cas_change": 7}

    def __init__(self, events: list[FeedEvent], gap_s: float = 0.0, burn_s: float = 0.0) -> None:
        self._events, self._gap, self._burn = events, gap_s, burn_s
        self.threads: dict[str, int] = {}
        self.subscribed: list[int] = []
        self.closed = False
        self.fail_connect = False
        self._q: asyncio.Queue[FeedEvent] | None = None

    async def connect(self) -> None:
        self.threads["connect"] = threading.get_ident()
        if self.fail_connect:
            raise ConnectionError("no route")
        self._q = asyncio.Queue()

        async def produce() -> None:
            assert self._q is not None
            self.threads["produce"] = threading.get_ident()
            if self._burn:
                end = time.perf_counter() + self._burn
                while time.perf_counter() < end:  # decoding: pure CPU on this thread
                    sum(range(200))
            for ev in self._events:
                self._q.put_nowait(ev)
                if self._gap:
                    await asyncio.sleep(self._gap)

        asyncio.get_running_loop().create_task(produce())

    async def subscribe(self, tokens: list[FeedToken]) -> None:
        self.threads["subscribe"] = threading.get_ident()
        self.subscribed.append(len(tokens))

    async def subscribe_market_status(self) -> None:
        self.threads["status"] = threading.get_ident()

    async def snapshot_index(self, tokens: list[FeedToken]) -> None:
        self.threads["snapshot"] = threading.get_ident()

    async def events(self) -> AsyncIterator[FeedEvent]:
        assert self._q is not None
        while True:
            ev = await self._q.get()
            yield ev
            if ev.kind == "closed":
                return

    async def close(self) -> None:
        self.threads["close"] = threading.get_ident()
        self.closed = True
        if self._q is not None:
            self._q.put_nowait(FeedEvent(kind="closed"))


async def drain(feed: ThreadedFeed, n: int) -> list[FeedEvent]:
    out: list[FeedEvent] = []

    async def read() -> None:
        async for ev in feed.events():
            out.append(ev)
            if len(out) >= n or ev.kind == "closed":
                return

    await asyncio.wait_for(read(), 10)
    return out


@pytest.mark.asyncio
async def test_the_feed_runs_in_its_own_thread_and_events_arrive_in_order_in_batches() -> None:
    events = [FeedEvent(kind="connected")] + [tick(i) for i in range(3000)] + [FeedEvent(kind="error", detail="Boom")] + [tick(i) for i in range(3000, 3100)]
    fake = Fake(events)
    feed = ThreadedFeed(fake)  # type: ignore[arg-type]
    main = threading.get_ident()
    await feed.connect()
    await feed.subscribe([FeedToken(exchange_segment="nse_fo", instrument_token="1")] * 4)
    await feed.subscribe_market_status()
    await feed.snapshot_index([])
    got = await drain(feed, len(events))
    assert [e.kind for e in got] == [e.kind for e in events]  # every event, in order
    assert [e.tick.ltp for e in got if e.tick] == [100.0 + i for i in list(range(3000)) + list(range(3000, 3100))]
    assert len({fake.threads[k] for k in fake.threads}) == 1 and fake.threads["connect"] != main  # connect, subscribe, the producer: all on the feed thread
    assert threading.get_ident() == main
    assert feed.handed_over == len(events) and feed.batches < len(events) / 10  # a hand-off per batch, not per message
    assert fake.subscribed == [4]
    assert (feed.subscription_count, feed.acknowledged_count, feed.dropped_by_kind) == (3, 2, {"cas_change": 7})
    await feed.close()
    assert fake.closed and fake.threads["close"] == fake.threads["connect"]


@pytest.mark.asyncio
async def test_connection_events_go_at_once_not_after_a_batch_wait() -> None:
    fake = Fake([tick(1), FeedEvent(kind="disconnected"), FeedEvent(kind="connected")])
    feed = ThreadedFeed(fake, batch_s=2.0)  # type: ignore[arg-type] - a long batch wait: only the non-tick events can arrive inside the test's time
    await feed.connect()
    t0 = time.perf_counter()
    got = await drain(feed, 3)
    assert [e.kind for e in got] == ["tick", "disconnected", "connected"] and time.perf_counter() - t0 < 1.0  # the tick rode along with the disconnect that followed it
    await feed.close()


@pytest.mark.asyncio
async def test_a_lone_tick_is_not_held_longer_than_the_batch_wait() -> None:
    fake = Fake([tick(1)])
    feed = ThreadedFeed(fake, batch_s=0.05)  # type: ignore[arg-type]
    await feed.connect()
    t0 = time.perf_counter()
    got = await drain(feed, 1)
    assert got[0].kind == "tick" and time.perf_counter() - t0 < 0.5  # a quiet feed is not delayed
    await feed.close()


@pytest.mark.asyncio
async def test_a_connection_failure_reaches_the_caller_and_close_is_safe_twice() -> None:
    fake = Fake([])
    fake.fail_connect = True
    feed = ThreadedFeed(fake)  # type: ignore[arg-type]
    with pytest.raises(ConnectionError):
        await feed.connect()
    await feed.close()
    await feed.close()  # nothing left to stop


@pytest.mark.asyncio
async def test_the_main_loop_keeps_running_while_the_feed_thread_is_busy_decoding() -> None:
    """The point of it: a second of pure CPU work on the feed thread does not stop the loop that serves the requests."""
    sys.setswitchinterval(0.001)  # as the application sets it (main.py)
    fake = Fake([tick(i) for i in range(100)], burn_s=1.0)
    feed = ThreadedFeed(fake)  # type: ignore[arg-type]
    lags: list[float] = []

    async def heartbeat() -> None:
        last = time.perf_counter()
        while True:
            await asyncio.sleep(0.01)
            now = time.perf_counter()
            lags.append(now - last - 0.01)
            last = now

    beat = asyncio.create_task(heartbeat())
    await feed.connect()
    got = await drain(feed, 100)
    beat.cancel()
    assert len(got) == 100 and len(lags) > 20  # the loop kept ticking through the second of decoding
    assert max(lags) < 0.25, f"the main loop was held for {max(lags):.3f} s"
    await feed.close()


@pytest.mark.asyncio
async def test_a_slow_consumer_loses_the_oldest_events_not_the_newest(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(threaded_feed, "QUEUE_MAX", 50)
    fake = Fake([tick(i) for i in range(500)])
    feed = ThreadedFeed(fake, batch_s=0.01)  # type: ignore[arg-type]
    await feed.connect()
    for _ in range(100):  # nobody is reading yet
        await asyncio.sleep(0.05)
        if feed.handed_over >= 500:
            break
    assert feed.handed_over == 500 and feed.queue_overflow == 450
    got = await drain(feed, 50)
    assert [e.tick.ltp for e in got if e.tick] == [100.0 + i for i in range(450, 500)]  # the newest fifty
    await feed.close()


def test_the_broker_hands_out_the_threaded_feed_only_when_it_is_switched_on(tmp_path) -> None:  # type: ignore[no-untyped-def]
    from app.broker.kotak import KotakBroker
    from app.stream.feed import KotakFeed
    from tests.conftest import make_settings

    class Ws:
        on_connect = on_disconnect = on_error = on_message = None

    class Client:
        def create_websocket(self) -> Ws:
            return Ws()

    async def run(flag: bool) -> object:
        broker = KotakBroker(make_settings(tmp_path, feed_thread=flag), client_factory=lambda **_k: Client())
        broker._client = Client()  # type: ignore[assignment]

        async def signed_in() -> None:
            return None

        broker.ensure_login = signed_in  # type: ignore[method-assign]
        from app.broker.base import AuthState

        broker._auth.state = AuthState.AUTHENTICATED
        return await broker.create_feed()

    assert isinstance(asyncio.run(run(False)), KotakFeed)  # the default: the feed as before
    assert isinstance(asyncio.run(run(True)), ThreadedFeed)
