"""Application settings loaded from environment variables / backend/.env.

Secrets are held as SecretStr and are never returned by the API or logged.
"""

from __future__ import annotations

import ipaddress
from datetime import date
from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    kotak_consumer_key: SecretStr | None = None
    kotak_mobile_number: SecretStr | None = None
    kotak_ucc: SecretStr | None = None
    kotak_mpin: SecretStr | None = None
    kotak_totp_secret: SecretStr | None = None

    app_host: str = "127.0.0.1"
    app_port: int = Field(default=8000, ge=1, le=65535)
    allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    data_dir: Path = Path("../data")
    log_dir: Path = Path("../logs")
    log_level: str = "INFO"
    underlying: str = "NIFTY"
    option_chain_strike_count: int = Field(default=40, ge=10, le=200)
    snapshot_stale_after_seconds: int = Field(default=300, ge=5)
    stream_autostart: bool = True
    stream_stale_after_seconds: int = Field(default=30, ge=5)
    stream_broadcast_interval_ms: int = Field(default=250, ge=50, le=5000)
    stream_max_reconnect_attempts: int = Field(default=8, ge=1, le=100)
    stream_backoff_base_seconds: float = Field(default=2.0, ge=0.5)
    stream_backoff_cap_seconds: float = Field(default=60.0, ge=1.0)
    stream_test_timeout_seconds: float = Field(default=10.0, ge=1.0)
    sampler_enabled: bool = True
    sampler_interval_seconds: int = Field(default=60, ge=30, le=3600)
    sampler_min_free_gb: float = Field(default=2.0, ge=0.1)
    history_autofetch: bool = True
    flows_history_days: int = 10  # NSE files are collected from this many days back, then daily
    news_autofetch: bool = True  # GDELT daily tone/volume (headline aggregates only)
    breadth_enabled: bool = True  # stock breadth, heavyweights, sectors (market-breadth-plan.md)
    eod_enabled: bool = True  # after-close archive, summary, manifest, backup (storage-plan.md)
    eod_backups: bool = True  # False on the server, where deploy/backup.sh already backs up nightly
    snapshot_raw_keep_days: int = 7  # owner-approved retention (D58); 0 = keep forever
    snapshot_normalized_keep_days: int = 14  # only days with a verified archive are ever removed
    backup_keep_daily: int = 7
    backup_keep_monthly: int = 6
    broker_daily_login: bool = True  # fresh broker sign-in every morning
    broker_login_time: str = "08:30"  # IST, HH:MM
    intraday_autoscore: bool = True  # record the rules-based intraday score each minute in session
    flows_autofetch: bool = True  # NSE participant-wise F&O files and FII/DII cash (low rate)
    history_start: date = date(2007, 1, 1)
    ws_max_clients: int = Field(default=10, ge=1, le=100)

    @field_validator("option_chain_strike_count")
    @classmethod
    def _multiple_of_ten(cls, v: int) -> int:
        if v % 10 != 0:
            raise ValueError("OPTION_CHAIN_STRIKE_COUNT must be a multiple of 10")
        return v

    @field_validator("underlying")
    @classmethod
    def _underlying_upper(cls, v: str) -> str:
        v = v.strip().upper()
        if not v.isalnum():
            raise ValueError("UNDERLYING must be alphanumeric, e.g. NIFTY")
        return v

    @field_validator("data_dir", "log_dir")
    @classmethod
    def _resolve_dir(cls, v: Path) -> Path:
        return v if v.is_absolute() else (BACKEND_DIR / v).resolve()

    @model_validator(mode="after")
    def _requires_credentials(self) -> Settings:
        missing = [name for name, present in self.credential_presence().items() if not present]
        if missing:
            raise ValueError(
                "These settings are required in backend/.env: "
                + ", ".join(n.upper() for n in missing)
            )
        return self

    def credential_presence(self) -> dict[str, bool]:
        """Which credentials are configured (booleans only, never values)."""
        fields = {
            "kotak_consumer_key": self.kotak_consumer_key,
            "kotak_mobile_number": self.kotak_mobile_number,
            "kotak_ucc": self.kotak_ucc,
            "kotak_mpin": self.kotak_mpin,
            "kotak_totp_secret": self.kotak_totp_secret,
        }
        return {k: bool(v and v.get_secret_value().strip()) for k, v in fields.items()}

    def secret_values(self) -> list[str]:
        """Raw secret strings, used only by the log redaction filter."""
        out: list[str] = []
        for v in (
            self.kotak_consumer_key,
            self.kotak_mobile_number,
            self.kotak_ucc,
            self.kotak_mpin,
            self.kotak_totp_secret,
        ):
            if v is not None:
                s = v.get_secret_value().strip()
                if len(s) >= 4:
                    out.append(s)
        return out

    def origins(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]

    def host_is_loopback(self) -> bool:
        if self.app_host == "localhost":
            return True
        try:
            return ipaddress.ip_address(self.app_host).is_loopback
        except ValueError:
            return False


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
