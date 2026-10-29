from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

import pytest

from app.config import Settings
from app.main import create_app
from tests.replay import ReplayBroker

# Placeholder values only (not real credentials). The TOTP secret is a well-known base32 example.
CREDS: dict[str, str] = {
    "kotak_consumer_key": "ck-abcdef123456",
    "kotak_mobile_number": "+910000000000",
    "kotak_ucc": "UCC1234",
    "kotak_mpin": "246810",
    "kotak_totp_secret": "JBSWY3DPEHPK3PXP",
}


def make_settings(tmp_path: Path, **overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "data_dir": tmp_path / "data",
        "log_dir": tmp_path / "logs",
        "stream_autostart": False,
        "history_autofetch": False,
        "flows_autofetch": False,
        "news_autofetch": False,
        "intraday_autoscore": False,
        "eod_enabled": False,
        "breadth_enabled": False,
        **CREDS,
    }
    base.update(overrides)
    return Settings(_env_file=None, **base)  # never read a developer's real backend/.env


def make_app(tmp_path: Path, **overrides: Any) -> Any:
    """App wired to a replay of real Kotak responses (no network, no credentials used)."""
    return create_app(make_settings(tmp_path, **overrides), broker=ReplayBroker())


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return make_settings(tmp_path)


@pytest.fixture(autouse=True)
def _freeze_today(monkeypatch: pytest.MonkeyPatch) -> None:
    """The captured expiries are only 'weekly/monthly' relative to the capture day."""
    monkeypatch.setattr(
        "app.services.snapshot_service.today_ist", lambda now=None: date(2026, 10, 28)
    )
