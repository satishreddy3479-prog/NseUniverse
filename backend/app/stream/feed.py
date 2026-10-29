"""Feed adapters. The manager only sees ``FeedSession``; only this module touches the SDK.

KotakFeed wraps the official SFeed WebSocket (kotakneoapi 3.0.x, ``client.create_websocket()``):
  subscribe_scrips / subscribe_index / subscribe_exchange; messages SFeedScrip, SFeedIndex,
  SFeedMarketStatus; SDK reconnects up to ``max_reconnect_attempts`` then ends iteration.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from app.stream.models import FeedEvent, FeedToken, LiveTick, MarketStatus

logger = logging.getLogger(__name__)

MARKET_OPEN_CODES = {1, 4}  # BCAST_OPEN_MESSAGE, BCAST_NORMAL_MKT_PREOPEN_ENDED
MARKET_CLOSED_CODES = {2}  # BCAST_CLOSE_MESSAGE


class FeedSession(Protocol):
    source: str

    async def connect(self) -> None: ...
    async def subscribe(self, tokens: list[FeedToken]) -> None: ...
    async def subscribe_market_status(self) -> None: ...
    def events(self) -> AsyncIterator[FeedEvent]: ...
    @property
    def subscription_count(self) -> int: ...
    @property
    def acknowledged_count(self) -> int: ...
    async def close(self) -> None: ...


def _price(v: Any) -> float | None:
    """Wire price -> float; 0 or invalid means 'no value'."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def _qty(v: Any) -> int | None:
    try:
        i = int(v)
    except (TypeError, ValueError):
        return None
    return i if i >= 0 else None


def _raw_time(v: Any) -> int | None:
    try:
        i = int(v)
    except (TypeError, ValueError):
        return None
    return i if i > 0 else None


def classify_market_status(
    code: int | None, text: str | None, segment: str | None, now: datetime
) -> MarketStatus:
    state: Literal["unknown", "open", "closed", "other"]
    if code in MARKET_OPEN_CODES:
        state = "open"
    elif code in MARKET_CLOSED_CODES:
        state = "closed"
    else:
        state = "other"
    return MarketStatus(
        state=state,
        code=code,
        text=text,
        exchange_segment=segment,
        received_at=now,
        source="exchange_feed",
    )


def convert_sdk_message(msg: Any, now: datetime) -> FeedEvent | None:
    """SDK message object -> FeedEvent. Uses only fields verified in SDK models.py (3.0.13)."""
    kind = getattr(msg, "type", None)
    if kind == "market_status":
        code = getattr(msg, "status_code", None)
        text = None
        try:
            from neo_api_client.websocket.feed import MARKET_STATUS_TEXT

            text = MARKET_STATUS_TEXT.get(code) if code is not None else None
        except Exception:  # noqa: BLE001 - text is cosmetic
            text = getattr(msg, "status", None)
        return FeedEvent(
            kind="market_status",
            market=classify_market_status(code, text, getattr(msg, "exchange_segment", None), now),
        )
    seg = getattr(msg, "exchange_segment", None)
    tok = getattr(msg, "instrument_token", None)
    if kind not in ("scrip", "scrip_lite", "index") or seg is None or tok is None:
        return None
    symbol = getattr(msg, "trading_symbol", None)
    if kind == "index":
        name = getattr(msg, "name", None)
        # Index messages carry the numeric token the server resolved; key by the subscribed name.
        key_token = str(name or symbol or tok)
        tick = LiveTick(
            key=f"{seg}|{key_token}",
            kind="index",
            exchange_segment=str(seg),
            instrument_token=key_token,
            trading_symbol=symbol or name,
            ltp=_price(getattr(msg, "last_traded_price", None)),
            open=_price(getattr(msg, "open_price", None)),
            high=_price(getattr(msg, "high_price", None)),
            low=_price(getattr(msg, "low_price", None)),
            prev_close=_price(getattr(msg, "close_price", None)),
            net_change=getattr(msg, "change", None),
            net_change_pct=getattr(msg, "net_change_percent", None),
            last_trade_time_raw=_raw_time(getattr(msg, "last_trade_time", None)),
            received_at=now,
        )
        return FeedEvent(kind="tick", tick=tick)
    full = kind == "scrip"
    buy = list(getattr(msg, "buy", None) or []) if full else []
    sell = list(getattr(msg, "sell", None) or []) if full else []
    best_bid = _price(getattr(buy[0], "price", None)) if buy else None
    best_ask = _price(getattr(sell[0], "price", None)) if sell else None
    tick = LiveTick(
        key=f"{seg}|{tok}",
        kind="scrip",
        exchange_segment=str(seg),
        instrument_token=str(tok),
        trading_symbol=symbol,
        ltp=_price(getattr(msg, "last_traded_price", None)),
        open=_price(getattr(msg, "open_price", None)) if full else None,
        high=_price(getattr(msg, "high_price", None)) if full else None,
        low=_price(getattr(msg, "low_price", None)) if full else None,
        prev_close=_price(getattr(msg, "close_price", None)),
        volume=_qty(getattr(msg, "volume_traded_today", None)) if full else None,
        oi=_qty(getattr(msg, "open_interest", None)) if full else None,
        net_change=getattr(msg, "net_change", None),
        net_change_pct=getattr(msg, "net_change_percent", None),
        last_trade_time_raw=_raw_time(getattr(msg, "last_trade_time", None)),
        last_update_time_raw=_raw_time(getattr(msg, "last_update_time", None)) if full else None,
        bid=best_bid,
        ask=best_ask,
        bid_qty=sum(int(getattr(x, "quantity", 0) or 0) for x in buy) if buy else None,
        ask_qty=sum(int(getattr(x, "quantity", 0) or 0) for x in sell) if sell else None,
        total_buy_qty=_qty(getattr(msg, "total_buy_quantity", None)) if full else None,
        total_sell_qty=_qty(getattr(msg, "total_sell_quantity", None)) if full else None,
        last_trade_qty=_qty(getattr(msg, "last_trade_qty", None)) if full else None,
        avg_price=_price(getattr(msg, "average_trade_price", None)) if full else None,
        received_at=now,
    )
    return FeedEvent(kind="tick", tick=tick)


class KotakFeed:
    """One SFeed connection. Created by KotakBroker.create_feed() from the signed-in session."""

    source = "live"

    def __init__(self, ws: Any, now: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._ws = ws
        self._now = now
        self._queue: asyncio.Queue[FeedEvent] = asyncio.Queue(maxsize=20000)
        self._pump: asyncio.Task[None] | None = None
        self._ws.on_connect = lambda: self._emit(FeedEvent(kind="connected"))
        self._ws.on_disconnect = lambda: self._emit(FeedEvent(kind="disconnected"))
        self._ws.on_error = self._on_error

    def _emit(self, ev: FeedEvent) -> None:
        try:
            self._queue.put_nowait(ev)
        except asyncio.QueueFull:
            # Keep newest: drop the oldest (feed is a latest-value stream).
            with contextlib.suppress(asyncio.QueueEmpty):
                self._queue.get_nowait()
            self._queue.put_nowait(ev)

    def _on_error(self, exc: Exception) -> None:
        # Exception text can contain URLs/tokens: only the type is surfaced.
        self._emit(FeedEvent(kind="error", detail=type(exc).__name__))

    async def connect(self) -> None:
        await self._ws.connect()
        self._pump = asyncio.create_task(self._run_pump())

    async def _run_pump(self) -> None:
        try:
            async for msg in self._ws:
                ev = convert_sdk_message(msg, self._now())
                if ev is not None:
                    self._emit(ev)
        except Exception as exc:  # noqa: BLE001 - report type only
            self._emit(FeedEvent(kind="error", detail=type(exc).__name__))
        finally:
            self._emit(FeedEvent(kind="closed"))

    async def subscribe(self, tokens: list[FeedToken]) -> None:
        from neo_api_client.websocket.feed import WsToken

        scrips = [
            WsToken(t.exchange_segment, t.instrument_token)
            for t in tokens
            if t.kind == "scrip" and not t.depth
        ]
        depth = [
            WsToken(t.exchange_segment, t.instrument_token)
            for t in tokens
            if t.kind == "scrip" and t.depth
        ]
        idx = [WsToken(t.exchange_segment, t.instrument_token) for t in tokens if t.kind == "index"]
        if scrips:
            await self._ws.subscribe_scrips(scrips)
        if depth:
            await self._ws.subscribe_depth(depth)
        if idx:
            await self._ws.subscribe_index(idx)

    async def subscribe_market_status(self) -> None:
        await self._ws.subscribe_exchange()

    async def events(self) -> AsyncIterator[FeedEvent]:
        while True:
            ev = await self._queue.get()
            yield ev
            if ev.kind == "closed":
                return

    @property
    def subscription_count(self) -> int:
        return int(self._ws.subscription_count)

    @property
    def acknowledged_count(self) -> int:
        return len(self._ws.trading_symbols)

    async def close(self) -> None:
        if self._pump:
            self._pump.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._pump
        with contextlib.suppress(Exception):
            await self._ws.close()
