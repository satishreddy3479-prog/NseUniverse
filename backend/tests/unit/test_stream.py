from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

from app.stream.book import LiveBook
from app.stream.feed import classify_market_status, convert_sdk_message
from app.stream.hub import Hub
from app.stream.manager import (
    FeedAuthError,
    StreamConfig,
    StreamManager,
    Universe,
    backoff_delay,
)
from app.stream.models import FeedEvent, FeedToken, LiveTick, MarketStatus, StreamState

T0 = datetime(2026, 10, 29, 4, 0, tzinfo=UTC)
IDX = FeedToken(exchange_segment="nse_cm", instrument_token="Nifty 50", kind="index")
A = FeedToken(exchange_segment="nse_fo", instrument_token="101")
B = FeedToken(exchange_segment="nse_fo", instrument_token="102")
C = FeedToken(exchange_segment="nse_fo", instrument_token="103")


def tick(
    key_token: str = "101", ltp: float | None = 100.0, volume: int | None = 65, **kw: Any
) -> LiveTick:
    seg = "nse_cm" if key_token == "Nifty 50" else "nse_fo"
    return LiveTick(
        key=f"{seg}|{key_token}",
        kind="index" if seg == "nse_cm" else "scrip",
        exchange_segment=seg,
        instrument_token=key_token,
        ltp=ltp,
        volume=volume,
        received_at=T0,
        **kw,
    )


class Clock:
    def __init__(self) -> None:
        self.now = T0

    def __call__(self) -> datetime:
        return self.now

    def advance(self, s: float) -> None:
        self.now += timedelta(seconds=s)


class FakeFeed:
    source = "live"

    def __init__(self, *, fail_connect: Exception | None = None, close_after_connect: bool = False):
        self.q: asyncio.Queue[FeedEvent] = asyncio.Queue()
        self.subs: list[list[FeedToken]] = []
        self.market_subscribed = False
        self.closed = False
        self.fail_connect = fail_connect
        self.close_after_connect = close_after_connect

    async def connect(self) -> None:
        if self.fail_connect:
            raise self.fail_connect
        if self.close_after_connect:
            self.q.put_nowait(FeedEvent(kind="closed"))

    async def subscribe(self, tokens: list[FeedToken]) -> None:
        self.subs.append(list(tokens))

    async def subscribe_market_status(self) -> None:
        self.market_subscribed = True

    async def events(self) -> AsyncIterator[FeedEvent]:
        while True:
            ev = await self.q.get()
            yield ev
            if ev.kind == "closed":
                return

    @property
    def subscription_count(self) -> int:
        return sum(len(s) for s in self.subs)

    @property
    def acknowledged_count(self) -> int:
        return self.subscription_count

    async def close(self) -> None:
        self.closed = True
        self.q.put_nowait(FeedEvent(kind="closed"))

    def push(self, t: LiveTick) -> None:
        self.q.put_nowait(FeedEvent(kind="tick", tick=t))


UNIVERSE = Universe(tokens=[IDX, A, B, C], test_tokens=[IDX, A], expiries=["2026-11-03"])


def make_manager(
    feeds: list[FakeFeed | Exception],
    *,
    clock: Clock | None = None,
    cfg: StreamConfig | None = None,
    relogin: Callable[[], Awaitable[object]] | None = None,
) -> tuple[StreamManager, list[float], list[int]]:
    delays: list[float] = []
    calls: list[int] = []
    it = iter(feeds)

    async def factory() -> FakeFeed:
        calls.append(1)
        nxt = next(it)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt

    async def universe() -> Universe:
        return UNIVERSE

    async def fake_sleep(d: float) -> None:
        delays.append(d)
        await asyncio.sleep(0)

    m = StreamManager(
        feed_factory=factory,
        universe_provider=universe,
        config=cfg or StreamConfig(test_timeout_s=0.3),
        clock=clock or Clock(),
        sleep=fake_sleep,
        relogin=relogin,
    )
    return m, delays, calls


async def until(cond: Callable[[], bool], timeout: float = 2.0) -> None:
    end = asyncio.get_event_loop().time() + timeout
    while not cond():
        if asyncio.get_event_loop().time() > end:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.005)


# ------------------------------------------------------------------ conversion
def test_backoff_is_exponential_and_capped() -> None:
    assert [backoff_delay(n, 2, 60) for n in (1, 2, 3, 4, 5, 6, 7)] == [2, 4, 8, 16, 32, 60, 60]


def test_convert_scrip_zero_price_is_missing_but_zero_oi_volume_are_kept() -> None:
    msg = SimpleNamespace(
        type="scrip",
        exchange_segment="nse_fo",
        instrument_token="64151",
        trading_symbol="NIFTY26NOV22700CE",
        last_traded_price=0.0,
        open_price=0.0,
        high_price=0.0,
        low_price=0.0,
        close_price=464.2,
        volume_traded_today=0,
        open_interest=0,
        net_change=0.0,
        net_change_percent=0.0,
        last_trade_time=0,
        last_update_time=1234,
    )
    ev = convert_sdk_message(msg, T0)
    assert ev is not None and ev.tick is not None
    t = ev.tick
    assert t.key == "nse_fo|64151" and t.ltp is None and t.open is None
    assert t.prev_close == 464.2 and t.volume == 0 and t.oi == 0
    assert t.last_trade_time_raw is None and t.last_update_time_raw == 1234


def test_convert_index_is_keyed_by_name_and_keeps_raw_time_unconverted() -> None:
    msg = SimpleNamespace(
        type="index",
        exchange_segment="nse_cm",
        instrument_token="26000",
        trading_symbol=None,
        name="Nifty 50",
        last_traded_price=22698.85,
        open_price=22800.0,
        high_price=22850.0,
        low_price=22650.0,
        close_price=22749.75,
        change=-50.9,
        net_change_percent=-0.22,
        last_trade_time=987654321,
    )
    ev = convert_sdk_message(msg, T0)
    assert ev is not None and ev.tick is not None
    assert ev.tick.key == "nse_cm|Nifty 50" and ev.tick.kind == "index"
    assert ev.tick.ltp == 22698.85 and ev.tick.last_trade_time_raw == 987654321


def test_convert_ignores_unknown_and_handles_market_status() -> None:
    assert convert_sdk_message(SimpleNamespace(type="cas_change"), T0) is None
    ev = convert_sdk_message(
        SimpleNamespace(type="market_status", status_code=2, exchange_segment="nse_fo", status=""),
        T0,
    )
    assert ev is not None and ev.market is not None and ev.market.state == "closed"
    assert classify_market_status(1, None, None, T0).state == "open"
    assert classify_market_status(7, None, None, T0).state == "other"


def test_book_deduplicates_exact_repeats_but_keeps_changes() -> None:
    book = LiveBook()
    assert book.update(tick()) is not None
    assert book.update(tick()) is None  # same values, only received_at differs
    assert book.update(tick(ltp=101.0)) is not None
    assert book.tick_count == 2 and len(book) == 1
    assert len(book.drain_pending()) == 1 and book.drain_pending() == []


# -------------------------------------------------------------------- manager
async def test_flow_test_subscription_then_full_then_streaming() -> None:
    feed = FakeFeed()
    m, _, calls = make_manager([feed])
    await m.start()
    await until(lambda: len(feed.subs) == 1)
    assert feed.market_subscribed and feed.subs[0] == [IDX, A]
    assert m.status().phase == "test_subscription"
    feed.push(tick("Nifty 50", 22700.0, None))
    await until(lambda: len(feed.subs) == 2)
    assert feed.subs[1] == [B, C]  # full universe minus what the test already subscribed
    s = m.status()
    assert s.test_subscription_result == "received" and s.subscribed_tokens == 4
    await until(lambda: m.state is StreamState.STREAMING)
    assert m.status().effective_state == "streaming" and m.status().freshness.value == "fresh"
    assert len(calls) == 1
    await m.stop()
    assert m.state is StreamState.STOPPED and feed.closed


async def test_start_is_idempotent_no_duplicate_ingestion() -> None:
    feed = FakeFeed()
    m, _, calls = make_manager([feed])
    await asyncio.gather(m.start(), m.start(), m.start())
    await m.start()
    await asyncio.sleep(0.05)
    assert len(calls) == 1
    await m.stop()


async def test_no_data_during_test_is_reported_not_hidden() -> None:
    feed = FakeFeed()
    m, _, _ = make_manager([feed], cfg=StreamConfig(test_timeout_s=0.05))
    await m.start()
    await until(lambda: m.state is StreamState.WAITING_FOR_DATA and len(feed.subs) == 2)
    s = m.status()
    assert s.test_subscription_result == "no_data" and s.freshness.value == "none"
    assert any(e.code == "test_no_data" for e in s.recent_errors)
    feed.q.put_nowait(
        FeedEvent(
            kind="market_status",
            market=MarketStatus(state="closed", code=2, received_at=T0, source="exchange_feed"),
        )
    )
    await until(lambda: m.market.state == "closed")
    assert m.status().effective_state == "market_closed"
    await m.stop()


async def test_stale_detection_and_market_closed_overlay() -> None:
    clock = Clock()
    feed = FakeFeed()
    m, _, _ = make_manager(
        [feed], clock=clock, cfg=StreamConfig(test_timeout_s=0.3, stale_after_seconds=30)
    )
    await m.start()
    await until(lambda: len(feed.subs) == 1)
    feed.push(tick("Nifty 50", 22700.0, None))
    await until(lambda: m.state is StreamState.STREAMING)
    clock.advance(10)
    assert m.status().freshness.value == "fresh" and m.status().data_age_seconds == 10.0
    clock.advance(25)  # 35 s since the last market data
    s = m.status()
    assert s.freshness.value == "stale" and s.effective_state == "stale"
    assert (
        s.state is StreamState.STREAMING
    )  # connection state is unchanged: only freshness degrades
    feed.q.put_nowait(
        FeedEvent(
            kind="market_status",
            market=MarketStatus(
                state="closed", code=2, received_at=clock.now, source="exchange_feed"
            ),
        )
    )
    await until(lambda: m.market.state == "closed")
    assert m.status().effective_state == "market_closed"
    await m.stop()


async def test_duplicate_events_are_counted_not_rebroadcast() -> None:
    feed = FakeFeed()
    m, _, _ = make_manager([feed])
    await m.start()
    await until(lambda: len(feed.subs) == 1)
    for _ in range(3):
        feed.push(tick("Nifty 50", 22700.0, None))
    await until(lambda: m.message_count == 3)
    assert m.book.tick_count == 1 and m.duplicate_count == 2
    await m.stop()


async def test_sdk_level_disconnect_and_reconnect_update_state() -> None:
    feed = FakeFeed()
    m, _, _ = make_manager([feed])
    await m.start()
    await until(lambda: len(feed.subs) == 1)
    feed.push(tick("Nifty 50", 22700.0, None))
    await until(lambda: m.state is StreamState.STREAMING)
    feed.q.put_nowait(FeedEvent(kind="disconnected"))
    await until(lambda: m.state is StreamState.RECONNECTING)
    assert m.reconnect_count == 1 and m.status().effective_state == "reconnecting"
    feed.q.put_nowait(FeedEvent(kind="connected"))
    await until(lambda: m.state is StreamState.WAITING_FOR_DATA)
    feed.push(tick("Nifty 50", 22710.0, None))
    await until(lambda: m.state is StreamState.STREAMING)
    await m.stop()


async def test_reconnect_with_bounded_backoff_then_resubscribe() -> None:
    f1, f2 = FakeFeed(close_after_connect=True), FakeFeed()
    m, delays, calls = make_manager([f1, f2])
    await m.start()
    await until(lambda: len(f2.subs) >= 1)
    assert delays[0] == 2.0 and len(calls) == 2
    assert f2.subs[0] == [IDX, A]  # subscriptions are re-sent on the new session
    assert f1.closed
    await m.stop()


async def test_gives_up_after_bounded_attempts() -> None:
    feeds = [FakeFeed(close_after_connect=True) for _ in range(10)]
    m, delays, calls = make_manager(
        feeds, cfg=StreamConfig(max_reconnect_attempts=3, test_timeout_s=0.05)
    )
    await m.start()
    await until(lambda: m.state is StreamState.FAILED)
    assert delays == [2.0, 4.0, 8.0] and len(calls) == 4
    assert any(e.code == "retries_exhausted" for e in m.status().recent_errors)
    assert not m.running
    await m.stop()


async def test_auth_failure_triggers_relogin_then_recovers() -> None:
    relogins: list[int] = []

    async def relogin() -> object:
        relogins.append(1)
        return None

    good = FakeFeed()
    m, _, _ = make_manager([FeedAuthError("rejected"), good], relogin=relogin)
    await m.start()
    await until(lambda: len(good.subs) >= 1)
    assert relogins == [1]
    assert any(e.code == "auth" for e in m.status().recent_errors)
    await m.stop()


async def test_errors_are_sanitized_to_type_or_safe_message() -> None:
    m, _, _ = make_manager([RuntimeError("secret-token-123"), FakeFeed()])
    await m.start()
    await until(lambda: len(m.errors) >= 1)
    assert all("secret-token-123" not in e.message for e in m.errors)
    await m.stop()


async def test_status_and_stop_when_never_started() -> None:
    m, _, _ = make_manager([])
    s = m.status()
    assert (
        s.state is StreamState.STOPPED and s.data_source == "none" and s.market.state == "unknown"
    )
    await m.stop()


# ------------------------------------------------------------------------ hub
async def test_hub_limits_clients_and_drops_slow_ones() -> None:
    hub = Hub(max_clients=2, queue_size=2)
    a, b = hub.subscribe(), hub.subscribe()
    assert a and b and hub.subscribe() is None
    for i in range(5):
        hub.publish({"n": i})
    assert hub.slow_client_drops == 2 and len(hub) == 0 and a.dropped and b.dropped


async def test_market_status_resets_to_unknown_when_stopped() -> None:
    feed = FakeFeed()
    m, _, _ = make_manager([feed])
    await m.start()
    await until(lambda: len(feed.subs) == 1)
    feed.q.put_nowait(
        FeedEvent(
            kind="market_status",
            market=MarketStatus(state="open", code=1, received_at=T0, source="exchange_feed"),
        )
    )
    await until(lambda: m.market.state == "open")
    await m.stop()
    assert m.status().market.state == "unknown"


def _mkt(state: str, code: int, seg: str | None) -> FeedEvent:
    return FeedEvent(
        kind="market_status",
        market=MarketStatus(
            state=state,
            code=code,
            exchange_segment=seg,
            received_at=T0,
            source="exchange_feed",  # type: ignore[arg-type]
        ),
    )


async def test_market_state_follows_the_fo_segment_not_the_last_message() -> None:
    """Real logs showed ten status messages per connect, open and closed interleaved."""
    feed = FakeFeed()
    m, _, _ = make_manager([feed])
    await m.start()
    await until(lambda: len(feed.subs) == 1)
    for ev in (
        _mkt("open", 1, "nse_fo"),
        _mkt("closed", 2, "mcx_fo"),
        _mkt("closed", 2, "cde_fo"),
        _mkt("closed", 2, "NSE_CM"),
    ):
        feed.q.put_nowait(ev)
    await until(lambda: len(m.market_segments) == 4)
    assert m.market.state == "open"  # NSE F&O wins over every other segment
    feed.q.put_nowait(_mkt("closed", 2, "nse_fo"))
    feed.q.put_nowait(_mkt("open", 1, "mcx_fo"))
    await until(lambda: m.market.state == "closed")
    assert m.status().market_segments["mcx_fo"].state == "open"
    await m.stop()
    assert m.status().market_segments == {}


async def test_other_segments_alone_leave_the_market_unknown() -> None:
    feed = FakeFeed()
    m, _, _ = make_manager([feed])
    await m.start()
    await until(lambda: len(feed.subs) == 1)
    feed.q.put_nowait(_mkt("closed", 2, "mcx_fo"))
    await until(lambda: "mcx_fo" in m.market_segments)
    assert m.market.state == "unknown"  # never borrow another exchange's status
    await m.stop()
