"""LIVE Kotak SFeed check. Never part of the default run.

Run during market hours (09:15-15:30 IST) on your own machine, with backend/.env filled in:
    powershell -ExecutionPolicy Bypass -File scripts\\stream-check.ps1
It subscribes to the index plus the ATM call/put of the weekly expiry (a small test), collects
messages for NSE_STREAM_SECONDS (default 30) and prints counts and field values. No secrets are
printed. Nothing is traded; this only reads market data.
"""

from __future__ import annotations

import asyncio
import os
from collections import Counter
from datetime import UTC, datetime, timedelta

import pytest

from app.broker.kotak import KotakBroker
from app.config import Settings
from app.domain.expiry import parse_expiry_dates, select_expiries
from app.domain.models import DataSource, ExpiryKind
from app.domain.normalize import normalize_option_chain
from app.logging_setup import configure_sdk_logging_env
from app.services.snapshot_service import today_ist
from app.services.universe import tokens_from_snapshots

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.getenv("NSE_LIVE_TESTS") != "1", reason="set NSE_LIVE_TESTS=1"),
]


def _as_unix(raw: int) -> str:
    try:
        return datetime.fromtimestamp(raw, UTC).isoformat()
    except (OverflowError, OSError, ValueError):
        return "out of range"


def _as_nse_epoch(raw: int) -> str:
    try:
        return (datetime(1980, 1, 1, tzinfo=UTC) + timedelta(seconds=raw)).isoformat()
    except OverflowError:
        return "out of range"


async def test_live_stream_small_subscription() -> None:
    s = Settings()
    configure_sdk_logging_env(s.log_dir)
    broker = KotakBroker(s)
    auth = await broker.login()
    print(f"auth state: {auth.state.value}")
    assert auth.state.value == "authenticated"

    dates, _ = parse_expiry_dates(await broker.get_expiries(s.underlying))
    weekly = select_expiries(dates, today_ist()).weekly
    assert weekly is not None
    raw = await broker.get_option_chain(s.underlying, weekly.isoformat(), 10)
    snap = normalize_option_chain(
        raw,
        snapshot_id="stream-check",
        session_id="stream-check",
        underlying=s.underlying,
        expiry=weekly,
        expiry_kinds=[ExpiryKind.WEEKLY],
        source=DataSource.SNAPSHOT,
        retrieved_at=datetime.now(UTC),
        requested_strike_count=10,
    )
    universe = tokens_from_snapshots([snap], s.underlying)
    print(f"test tokens: {[t.key for t in universe.test_tokens]}")

    feed = await broker.create_feed()
    await feed.connect()
    await feed.subscribe_market_status()
    await feed.subscribe(universe.test_tokens)
    print(f"subscribed={feed.subscription_count} acknowledged={feed.acknowledged_count}")

    seconds = float(os.getenv("NSE_STREAM_SECONDS", "30"))
    kinds: Counter[str] = Counter()
    samples: dict[str, object] = {}
    deadline = asyncio.get_event_loop().time() + seconds

    async def collect() -> None:
        async for ev in feed.events():
            kinds[ev.kind] += 1
            if ev.kind == "tick" and ev.tick:
                samples.setdefault(ev.tick.key, ev.tick)
            elif ev.kind == "market_status" and ev.market:
                print(
                    f"market status event: {ev.market.state} code={ev.market.code} "
                    f"text={ev.market.text!r} segment={ev.market.exchange_segment}"
                )
            elif ev.kind in ("error", "disconnected", "connected"):
                print(f"{ev.kind}: {ev.detail or ''}")
            if asyncio.get_event_loop().time() > deadline:
                return

    try:
        await asyncio.wait_for(collect(), timeout=seconds + 5)
    except TimeoutError:
        pass
    finally:
        await feed.close()

    print(f"events by kind after {seconds:.0f}s: {dict(kinds)}")
    print(f"acknowledged tokens at end: {feed.acknowledged_count}")
    for key, t in samples.items():
        print(f"sample {key}: {t}")  # type: ignore[str-bytes-safe]
        for name in ("last_trade_time_raw", "last_update_time_raw"):
            v = getattr(t, name, None)
            if v:
                print(
                    f"  {name}={v}  as unix seconds -> {_as_unix(v)}  "
                    f"| as seconds since 1980-01-01 -> {_as_nse_epoch(v)}"
                )
    assert kinds["connected"] + kinds["tick"] + kinds["market_status"] > 0, "no events at all"
