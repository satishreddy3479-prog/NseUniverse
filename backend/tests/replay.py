"""TEST-ONLY stand-ins that REPLAY real Kotak Neo responses captured on 2026-10-28 (market closed).

Nothing here is imported by the application. No numbers are invented: option-chain payloads are the
real, credential-free responses stored in tests/fixtures, and replayed ticks reuse the same real
values. The market-closed status is what the exchange feed would be reporting at that capture time.
Only two expiries were captured; they stand in for the (longer) real expiry list.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.broker.base import AuthState, AuthStatus, BrokerError
from app.domain.normalize import parse_number
from app.stream.feed import FeedSession
from app.stream.models import FeedEvent, FeedToken, LiveTick, MarketStatus

FIXTURES = Path(__file__).parent / "fixtures"
CAPTURED_EXPIRIES = [
    "2026-11-03",
    "2026-11-23",
]  # weekly and monthly as listed by Kotak on 2026-10-28


def load_payload(expiry: str) -> dict[str, Any]:
    path = FIXTURES / f"kotak_option_chain_NIFTY_{expiry}.json"
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


def _tick_from_row(item: Mapping[str, Any], now: datetime) -> LiveTick | None:
    seg_tok = str(item["inst"]["neoSymbol"])
    seg, _, tok = seg_tok.partition("|")
    q, oi = item["quote"], item["oi"]

    def f(v: Any) -> float | None:
        n, _ = parse_number(v)
        return n if n and n > 0 else None

    def i(v: Any) -> int | None:
        n, _ = parse_number(v)
        return None if n is None else int(n)

    return LiveTick(
        key=seg_tok,
        kind="scrip",
        exchange_segment=seg,
        instrument_token=tok,
        trading_symbol=item["inst"].get("symbol"),
        ltp=f(q.get("ltp")),
        open=f(q.get("o")),
        high=f(q.get("h")),
        low=f(q.get("l")),
        prev_close=f(q.get("pc")),
        volume=i(q.get("vol")),
        oi=i(oi.get("cur")),
        received_at=now,
    )


class ReplayBroker:
    name = "replay-of-real-kotak-capture"

    def __init__(self) -> None:
        self._auth = AuthStatus(state=AuthState.AUTHENTICATED)
        self.chain_calls: list[str] = []

    @property
    def auth_status(self) -> AuthStatus:
        return self._auth

    async def login(self) -> AuthStatus:
        return self._auth

    async def ensure_login(self) -> AuthStatus:
        return self._auth

    async def get_expiries(self, underlying: str) -> list[Any]:
        return list(CAPTURED_EXPIRIES)

    async def get_option_chain(self, underlying: str, expiry: str, count: int) -> Mapping[str, Any]:
        self.chain_calls.append(expiry)
        if expiry not in CAPTURED_EXPIRIES:
            raise BrokerError("expiry was not captured for replay", code="bad_request")
        return load_payload(expiry)

    async def create_feed(self) -> FeedSession:
        return ReplayFeed()

    async def close(self) -> None:
        return None


class ReplayFeed:
    """Emits, once per subscribed instrument, the real values captured in the snapshots."""

    source = "live"

    def __init__(self) -> None:
        self._queue: asyncio.Queue[FeedEvent] = asyncio.Queue()
        self._subscribed: set[str] = set()
        self._values: dict[str, LiveTick] = {}
        self._spot: tuple[float, float] | None = None
        now = datetime.now(UTC)
        for expiry in CAPTURED_EXPIRIES:
            p = load_payload(expiry)
            for item in p["call"] + p["put"]:
                t = _tick_from_row(item, now)
                if t:
                    self._values[t.key] = t
            spot = p["spot"]
            self._spot = (float(spot["ltp"]), float(spot["prevClose"]))

    async def connect(self) -> None:
        self._queue.put_nowait(FeedEvent(kind="connected"))

    async def subscribe(self, tokens: list[FeedToken]) -> None:
        now = datetime.now(UTC)
        for t in tokens:
            if t.key in self._subscribed:
                continue
            self._subscribed.add(t.key)
            if t.kind == "index" and self._spot:
                ltp, prev = self._spot
                tick = LiveTick(
                    key=t.key,
                    kind="index",
                    exchange_segment=t.exchange_segment,
                    instrument_token=t.instrument_token,
                    ltp=ltp,
                    prev_close=prev,
                    received_at=now,
                )
                self._queue.put_nowait(FeedEvent(kind="tick", tick=tick))
            elif t.key in self._values:
                tick = self._values[t.key].model_copy(update={"received_at": now})
                self._queue.put_nowait(FeedEvent(kind="tick", tick=tick))

    async def subscribe_market_status(self) -> None:
        self._queue.put_nowait(
            FeedEvent(
                kind="market_status",
                market=MarketStatus(
                    state="closed",
                    code=2,
                    text="Market closed",
                    exchange_segment="nse_fo",
                    received_at=datetime.now(UTC),
                    source="exchange_feed",
                ),
            )
        )

    async def events(self) -> AsyncIterator[FeedEvent]:
        while True:
            ev = await self._queue.get()
            yield ev
            if ev.kind == "closed":
                return

    @property
    def subscription_count(self) -> int:
        return len(self._subscribed)

    @property
    def acknowledged_count(self) -> int:
        return len(self._subscribed)

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            self._queue.put_nowait(FeedEvent(kind="closed"))
