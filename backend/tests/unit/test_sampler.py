"""Scheduled sampling: only in session, on schedule, resilient to broker failures."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.broker.base import BrokerError
from app.services.history import build_history
from app.services.sampler import SnapshotSampler, session_open
from app.services.snapshot_service import SnapshotService
from app.services.state import AppState
from app.storage.store import SnapshotStore
from app.stream.models import MarketStatus
from tests.conftest import make_app
from tests.replay import ReplayBroker

# 2026-10-28 is a Wednesday. 05:00 UTC = 10:30 IST.
IN_SESSION = datetime(2026, 10, 28, 5, 0, tzinfo=UTC)


class Clock:
    def __init__(self, at: datetime) -> None:
        self.now = at

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


def make_sampler(
    tmp_path: Path,
    clock: Clock,
    broker: ReplayBroker | None = None,
    market: MarketStatus | None = None,
) -> tuple[SnapshotSampler, ReplayBroker, SnapshotStore]:
    b = broker or ReplayBroker()
    store = SnapshotStore(tmp_path / "data")
    store.start_session("s1", "live")
    svc = SnapshotService(b, store, AppState("s1"), "NIFTY", 40)
    return SnapshotSampler(svc, interval_s=60, market=lambda: market, clock=clock), b, store


class TestSessionClock:
    @pytest.mark.parametrize(
        ("h", "m", "expected"),
        [
            (9, 14, False),
            (9, 15, True),
            (12, 0, True),
            (15, 30, True),
            (15, 40, True),
            (15, 41, False),
            (3, 0, False),
        ],
    )
    def test_weekday_window_in_ist(self, h: int, m: int, expected: bool) -> None:
        ist = datetime(2026, 10, 28, h, m, tzinfo=UTC) - timedelta(hours=5, minutes=30)
        assert session_open(ist)[0] is expected

    def test_weekend_is_closed(self) -> None:
        sat = datetime(2026, 10, 31, 5, 0, tzinfo=UTC)
        assert session_open(sat) == (False, "weekend")

    def test_exchange_closed_today_blocks_sampling(self) -> None:
        m = MarketStatus(state="closed", received_at=IN_SESSION - timedelta(minutes=5))
        ok, why = session_open(IN_SESSION, m)
        assert not ok and "closed" in why

    def test_stale_closed_status_from_last_night_is_ignored(self) -> None:
        m = MarketStatus(state="closed", received_at=IN_SESSION - timedelta(hours=14))
        assert session_open(IN_SESSION, m)[0]

    def test_open_status_does_not_block(self) -> None:
        m = MarketStatus(state="open", received_at=IN_SESSION - timedelta(minutes=1))
        assert session_open(IN_SESSION, m)[0]


class TestSampling:
    async def test_samples_weekly_and_monthly_then_waits_for_the_interval(
        self, tmp_path: Path
    ) -> None:
        clock = Clock(IN_SESSION)
        s, broker, store = make_sampler(tmp_path, clock)
        assert await s.tick() is True
        assert sorted(broker.chain_calls) == ["2026-11-03", "2026-11-23"]
        assert len(store.list(underlying="NIFTY", limit=50)) == 2
        clock.advance(30)
        assert await s.tick() is False  # not due yet
        assert len(broker.chain_calls) == 2
        clock.advance(31)
        assert await s.tick() is True
        assert len(broker.chain_calls) == 4
        assert s.status().samples_this_run == 2

    async def test_nothing_is_captured_outside_the_session(self, tmp_path: Path) -> None:
        clock = Clock(datetime(2026, 10, 28, 11, 0, tzinfo=UTC))  # 16:30 IST
        s, broker, _ = make_sampler(tmp_path, clock)
        assert await s.tick() is False
        assert broker.chain_calls == []
        st = s.status()
        assert st.state == "waiting" and not st.in_session and "outside" in st.reason

    async def test_holiday_reported_by_the_feed_is_skipped(self, tmp_path: Path) -> None:
        m = MarketStatus(state="closed", received_at=IN_SESSION - timedelta(minutes=1))
        s, broker, _ = make_sampler(tmp_path, Clock(IN_SESSION), market=m)
        assert await s.tick() is False
        assert broker.chain_calls == []

    async def test_a_broker_failure_backs_off_and_recovers(self, tmp_path: Path) -> None:
        clock = Clock(IN_SESSION)
        s, broker, _ = make_sampler(tmp_path, clock)
        real = broker.get_option_chain

        async def failing(*a: object, **k: object) -> dict[str, object]:
            raise BrokerError("rate limited", code="rate_limit")

        broker.get_option_chain = failing  # type: ignore[method-assign]
        assert await s.tick() is True
        st = s.status()
        assert st.state == "error" and st.last_error and "rate limited" in st.last_error
        assert st.next_due_at == IN_SESSION + timedelta(seconds=120)  # interval doubled
        clock.advance(60)
        assert await s.tick() is False  # still backing off
        broker.get_option_chain = real  # type: ignore[method-assign]
        clock.advance(61)
        assert await s.tick() is True
        st = s.status()
        assert st.state == "waiting" and st.last_error is None and st.samples_this_run == 1

    async def test_disabled_sampler_never_captures(self, tmp_path: Path) -> None:
        s, broker, _ = make_sampler(tmp_path, Clock(IN_SESSION))
        s.enabled = False
        assert await s.tick() is False
        assert broker.chain_calls == []
        assert s.status().state == "off"

    async def test_sampled_snapshots_feed_the_history(self, tmp_path: Path) -> None:
        clock = Clock(IN_SESSION)
        s, _, store = make_sampler(tmp_path, clock)
        for _ in range(3):
            await s.tick()
            clock.advance(61)
        h = build_history(store, "NIFTY", "2026-11-03", 10, 1000)
        # the replayed payload never changes, so only the first sample is stored
        assert len(h.observations) == 1
        assert s.status().skipped_unchanged == 4  # 2 expiries x 2 repeated samples

    async def test_a_changed_chain_is_stored_again(self, tmp_path: Path) -> None:
        clock = Clock(IN_SESSION)
        s, broker, store = make_sampler(tmp_path, clock)
        await s.tick()
        real = broker.get_option_chain

        async def moved(*a: object, **k: object) -> dict[str, object]:
            data = dict(await real(*a, **k))  # type: ignore[arg-type]
            spot = dict(data["spot"])  # type: ignore[arg-type]
            spot["ltp"] = "22710.10"
            data["spot"] = spot
            return data

        broker.get_option_chain = moved  # type: ignore[method-assign]
        clock.advance(61)
        await s.tick()
        assert len(store.list(underlying="NIFTY", expiry="2026-11-03", limit=10)) == 2

    async def test_a_manual_capture_is_always_stored(self, tmp_path: Path) -> None:
        s, _, store = make_sampler(tmp_path, Clock(IN_SESSION))
        await s.service.capture()
        await s.service.capture()
        assert len(store.list(underlying="NIFTY", expiry="2026-11-03", limit=10)) == 2

    async def test_sampling_pauses_when_the_disk_is_nearly_full(self, tmp_path: Path) -> None:
        s, broker, _ = make_sampler(tmp_path, Clock(IN_SESSION))
        s._data_dir = tmp_path
        s.min_free_gb = 10**9  # more than any disk has
        assert await s.tick() is False
        assert broker.chain_calls == []
        st = s.status()
        assert st.state == "waiting" and "low disk space" in st.reason


def test_status_endpoint_and_history_cache_do_not_change_results(tmp_path: Path) -> None:
    app = make_app(tmp_path, sampler_enabled=False)
    with TestClient(app, client=("127.0.0.1", 50000)) as c:
        st = c.get("/api/sampler/status").json()
        assert st["enabled"] is False and st["state"] == "off"
        c.post("/api/snapshots/capture", params={"expiry": "2026-11-03"})
        c.post("/api/snapshots/capture", params={"expiry": "2026-11-03"})
        a = c.get("/api/history/observations", params={"expiry": "2026-11-03"}).json()
        b = c.get("/api/history/observations", params={"expiry": "2026-11-03"}).json()  # cached
        assert a["observations"] == b["observations"]
        assert [o["same_as_previous"] for o in b["observations"]] == [False, True]
        assert (
            c.get(
                "/api/history/observations", params={"expiry": "2026-11-03", "limit": 5000}
            ).status_code
            == 422
        )
