"""What the SDK sends and the feed adapter does not turn into an event is counted by type.

Nothing vanishes without a count (19 Nov 2026 audit: the auction messages were dropped silently).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from types import SimpleNamespace

from app.stream.feed import KotakFeed


class FakeWs:
    """The few attributes KotakFeed touches, replaying messages like the SDK's async iterator."""

    def __init__(self, msgs: list[object]) -> None:
        self._msgs = msgs
        self.on_connect = self.on_disconnect = self.on_error = None
        self.subscription_count = 0
        self.trading_symbols: dict[str, str] = {}

    async def connect(self) -> None:
        return None

    def __aiter__(self) -> AsyncIterator[object]:
        async def gen() -> AsyncIterator[object]:
            for m in self._msgs:
                yield m

        return gen()


def test_auction_messages_and_unknown_types_are_counted_while_ticks_pass() -> None:
    idx = SimpleNamespace(
        type="index", exchange_segment="nse_cm", instrument_token="26000", name="Nifty 50",
        trading_symbol=None, last_traded_price=25503.7, open_price=25400.0, high_price=25510.0,
        low_price=25390.0, close_price=25227.95, change=275.75, net_change_percent=1.09,
        last_trade_time=1,
    )  # fmt: skip
    # per-stock reference price and imbalance in the closing auction
    cas = SimpleNamespace(type="cas_change", exchange_segment="nse_cm", instrument_token="1333")
    other = SimpleNamespace(type="mystery", exchange_segment="nse_cm", instrument_token="1")
    msgs = [idx, cas, cas, cas, other]

    async def run() -> KotakFeed:
        feed = KotakFeed(FakeWs(msgs))
        await feed.connect()
        assert feed._pump is not None
        await feed._pump
        return feed

    feed = asyncio.run(run())
    assert feed.dropped_by_kind == {"cas_change": 3, "mystery": 1}
    assert feed._queue.qsize() == 2  # the index tick and the closing "closed" event
    assert feed.queue_overflow == 0
