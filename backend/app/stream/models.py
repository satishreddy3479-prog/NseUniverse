"""Data contracts for the live stream (normalized, SDK-independent)."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


class StreamState(StrEnum):
    STOPPED = "stopped"
    CONNECTING = "connecting"  # opening socket / authenticating
    SUBSCRIBING = "subscribing"  # connected, subscription requests in flight
    WAITING_FOR_DATA = "waiting_for_data"  # subscribed, no market-data message received yet
    STREAMING = "streaming"  # market-data messages arriving
    RECONNECTING = "reconnecting"
    AUTH_FAILED = "auth_failed"
    FAILED = "failed"  # bounded retries exhausted; needs a manual start


class Freshness(StrEnum):
    """Derived, separate from the connection state: is the data actually moving?"""

    NONE = "none"  # nothing received yet
    FRESH = "fresh"
    STALE = "stale"  # connected but no market data for longer than the threshold
    MARKET_CLOSED = "market_closed"  # exchange reported closed; quiet feed is expected


class MarketStatus(BaseModel):
    state: Literal["unknown", "open", "closed", "other"] = "unknown"
    code: int | None = None
    text: str | None = None
    exchange_segment: str | None = None
    received_at: datetime | None = None
    source: Literal["exchange_feed", "none"] = "none"


class LiveTick(BaseModel):
    """Latest values for one instrument from the stream.

    ``None`` = not supplied/invalid. Prices of 0 on the wire mean "no value" and become None;
    volume and open interest keep 0 because zero is a valid quantity.
    ``*_time_raw`` are the provider's integers, unconverted: their unit/epoch is not documented
    (audit F5), so no exchange timestamp is derived from them.
    """

    key: str = Field(description="'<exchange_segment>|<instrument_token>' as subscribed")
    kind: Literal["scrip", "index"]
    exchange_segment: str
    instrument_token: str
    trading_symbol: str | None = None
    ltp: float | None = None
    open: float | None = None
    high: float | None = None
    low: float | None = None
    prev_close: float | None = None
    volume: int | None = None
    oi: int | None = None
    net_change: float | None = None
    net_change_pct: float | None = None
    last_trade_time_raw: int | None = None
    last_update_time_raw: int | None = None
    received_at: datetime
    seq: int = 0
    source: Literal["live"] = "live"


class FeedToken(BaseModel):
    exchange_segment: str
    instrument_token: str
    kind: Literal["scrip", "index"] = "scrip"

    @property
    def key(self) -> str:
        return f"{self.exchange_segment}|{self.instrument_token}"


class FeedEvent(BaseModel):
    """What a feed adapter hands to the manager."""

    kind: Literal["tick", "market_status", "connected", "disconnected", "error", "closed"]
    tick: LiveTick | None = None
    market: MarketStatus | None = None
    detail: str | None = None  # sanitized, safe to display


class StreamError(BaseModel):
    at: datetime
    code: str
    message: str


class StreamStatusModel(BaseModel):
    implemented: bool = True
    state: StreamState
    state_since: datetime | None
    effective_state: str = Field(description="state, or 'stale' / 'market_closed' overlay")
    freshness: Freshness
    data_source: Literal["live", "none"]
    phase: Literal["idle", "test_subscription", "full_subscription"] = "idle"
    test_subscription_result: Literal["not_run", "received", "no_data"] = "not_run"
    message_count: int = 0
    tick_count: int = 0
    instruments_with_data: int = 0
    subscribed_tokens: int = 0
    acknowledged_tokens: int = 0
    reconnect_count: int = 0
    connected_since: datetime | None = None
    last_message_at: datetime | None = None
    last_market_data_at: datetime | None = None
    data_age_seconds: float | None = None
    stale_after_seconds: int
    expiries: list[str] = []
    market: MarketStatus
    market_segments: dict[str, MarketStatus] = {}
    recent_errors: list[StreamError] = []
    note: str = ""
