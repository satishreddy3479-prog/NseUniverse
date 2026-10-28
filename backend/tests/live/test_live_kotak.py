"""LIVE Kotak Neo checks. Never part of the default test run.

Run on your own machine, with backend/.env configured (backend/.env filled in):
    $env:NSE_LIVE_TESTS="1"; python -m pytest -m live -v      (PowerShell)
These tests make real, read-only market-data calls. They print no secrets.
"""

from __future__ import annotations

import os

import pytest

from app.broker.base import AuthState
from app.broker.kotak import KotakBroker
from app.config import Settings
from app.domain.expiry import parse_expiry_dates, select_expiries
from app.domain.models import Completeness, DataSource, ExpiryKind
from app.domain.normalize import normalize_option_chain
from app.logging_setup import configure_sdk_logging_env
from app.services.snapshot_service import today_ist

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(os.getenv("NSE_LIVE_TESTS") != "1", reason="set NSE_LIVE_TESTS=1"),
]


@pytest.fixture(scope="module")
def settings() -> Settings:
    s = Settings()
    configure_sdk_logging_env(s.log_dir)  # keep the SDK log in the git-ignored logs dir
    return s


async def test_live_login(settings: Settings) -> None:
    status = await KotakBroker(settings).login()
    print(f"auth state: {status.state.value}; error: {status.last_error}")
    assert status.state is AuthState.AUTHENTICATED


async def test_live_expiries_and_weekly_snapshot(settings: Settings) -> None:
    b = KotakBroker(settings)
    raw = await b.get_expiries(settings.underlying)
    dates, warnings = parse_expiry_dates(raw)
    choice = select_expiries(dates, today_ist())
    print(f"expiries listed: {len(dates)}; first five: {[d.isoformat() for d in dates[:5]]}")
    print(
        f"weekly={choice.weekly} monthly={choice.monthly} "
        f"next_month={choice.monthly_is_next_month} warnings={warnings + choice.warnings}"
    )
    assert dates and choice.weekly is not None

    from datetime import UTC, datetime

    chain = await b.get_option_chain(
        settings.underlying, choice.weekly.isoformat(), settings.option_chain_strike_count
    )
    print(f"option_chain top-level keys: {sorted(chain.keys())}")
    snap = normalize_option_chain(
        chain,
        snapshot_id="live-check",
        session_id="live-check",
        underlying=settings.underlying,
        expiry=choice.weekly,
        expiry_kinds=[ExpiryKind.WEEKLY],
        source=DataSource.SNAPSHOT,
        retrieved_at=datetime.now(UTC),
        requested_strike_count=settings.option_chain_strike_count,
    )
    print(
        f"strikes={len(snap.rows)} CE={snap.ce_count} PE={snap.pe_count} "
        f"completeness={snap.completeness.value} lot={snap.lot_size}"
    )
    print(f"warnings (first 5): {snap.warnings[:5]}")
    if snap.rows:
        mid = snap.rows[len(snap.rows) // 2]
        print(
            f"sample strike {mid.strike}: CE ltp={mid.call.ltp if mid.call else None} "
            f"oi={mid.call.oi if mid.call else None}; PE ltp={mid.put.ltp if mid.put else None}"
        )
    assert snap.completeness is not Completeness.EMPTY
