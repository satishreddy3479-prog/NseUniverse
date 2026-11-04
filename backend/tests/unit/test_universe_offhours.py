"""The streaming instrument list when the exchange is closed (a restart at night)."""

from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.broker.base import BrokerError
from app.services.snapshot_service import SnapshotService
from app.services.state import AppState
from app.services.universe import build_universe, market_hours, stored_targets
from app.storage.store import SnapshotStore
from tests.replay import ReplayBroker

IST = ZoneInfo("Asia/Kolkata")


def at(d: int, h: int, m: int, month: int = 10) -> datetime:
    return datetime(2026, month, d, h, m, tzinfo=IST)


NIGHT = at(28, 20, 30)  # Wednesday 20:30 IST, exchange closed
DAY = at(28, 11, 0)  # Wednesday 11:00 IST, exchange open


def service(tmp_path: Path) -> tuple[SnapshotService, ReplayBroker]:
    b = ReplayBroker()
    store = SnapshotStore(tmp_path / "data")
    store.start_session("s1", "live")
    return SnapshotService(b, store, AppState("s1"), "NIFTY", 40), b


async def stored_service(tmp_path: Path) -> tuple[SnapshotService, ReplayBroker]:
    svc, b = service(tmp_path)
    await svc.capture()  # the real captured weekly and monthly chains
    svc._expiry_cache = None  # so the next expiries() call really asks the broker
    return svc, b


async def down(underlying: str) -> list:
    raise BrokerError("broker unavailable", code="transport", retryable=True)


def test_market_hours_window() -> None:
    assert not market_hours(at(28, 8, 59)) and market_hours(at(28, 9, 0))
    assert market_hours(at(28, 15, 44)) and not market_hours(at(28, 15, 45))
    assert not market_hours(at(31, 11, 0))  # Saturday
    assert not market_hours(at(1, 11, 0, month=11))  # Sunday


async def test_after_hours_with_the_broker_down_it_uses_stored_chains(tmp_path: Path) -> None:
    svc, b = await stored_service(tmp_path)
    asked: list[object] = []

    async def must_not_capture(**kw: object) -> None:
        asked.append(kw)
        raise AssertionError("the broker must not be asked for a new chain at night")

    b.get_expiries = down  # type: ignore[method-assign]
    svc.capture = must_not_capture  # type: ignore[method-assign]
    uni = await build_universe(svc, now=lambda: NIGHT)
    assert uni.expiries == ["2026-11-03", "2026-11-23"] and len(uni.tokens) > 100 and not asked


async def test_after_hours_an_old_chain_is_accepted_without_the_broker(tmp_path: Path) -> None:
    svc, _ = await stored_service(tmp_path)
    svc.max_age_s = 0  # every stored chain counts as old
    asked: list[object] = []

    async def must_not_capture(**kw: object) -> None:
        asked.append(kw)

    svc.capture = must_not_capture  # type: ignore[method-assign]
    uni = await build_universe(svc, now=lambda: NIGHT)
    assert len(uni.tokens) > 100 and not asked


async def test_in_market_hours_an_old_chain_is_still_refreshed(tmp_path: Path) -> None:
    svc, _ = await stored_service(tmp_path)
    svc.max_age_s = 0
    original, asked = svc.capture, []

    async def counting(**kw):  # type: ignore[no-untyped-def]
        asked.append(kw)
        return await original(**kw)

    svc.capture = counting  # type: ignore[method-assign]
    await build_universe(svc, now=lambda: DAY)
    assert len(asked) == 2  # weekly and monthly, as before


async def test_in_market_hours_a_broker_failure_is_not_hidden(tmp_path: Path) -> None:
    svc, b = await stored_service(tmp_path)
    b.get_expiries = down  # type: ignore[method-assign]
    with pytest.raises(BrokerError):
        await build_universe(svc, now=lambda: DAY)


async def test_after_hours_with_nothing_stored_the_failure_stands(tmp_path: Path) -> None:
    svc, b = service(tmp_path)  # nothing captured yet
    b.get_expiries = down  # type: ignore[method-assign]
    with pytest.raises(BrokerError):
        await build_universe(svc, now=lambda: NIGHT)


async def test_stored_targets_skip_expired_expiries(tmp_path: Path) -> None:
    svc, _ = await stored_service(tmp_path)
    assert stored_targets(svc, date(2026, 10, 28)) == [date(2026, 11, 3), date(2026, 11, 23)]
    # by 4 Nov the weekly expiry (3 Nov) has expired
    assert stored_targets(svc, date(2026, 11, 4)) == [date(2026, 11, 23)]
    assert stored_targets(svc, date(2026, 12, 1)) == []
