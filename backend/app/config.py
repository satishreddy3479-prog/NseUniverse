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
    stream_failed_retry_seconds: float = Field(default=600.0, ge=0.0)  # 0 = stay stopped
    stream_test_timeout_seconds: float = Field(default=10.0, ge=1.0)
    sampler_enabled: bool = True
    sampler_interval_seconds: int = Field(default=60, ge=30, le=3600)
    sampler_min_free_gb: float = Field(default=2.0, ge=0.1)
    history_autofetch: bool = True
    flows_history_days: int = 10  # NSE files are collected from this many days back, then daily
    risk_free_rate: float = 0.06  # annual discount rate for the IV model; an assumption
    # the Greeks and What-If engine (app/risk): read-only; the surface, the limits and the sticky
    # rule are configuration, never code
    greeks_enabled: bool = True
    # a book wider than this share of its mid is rejected
    greeks_spread_threshold_pct: float = Field(default=15.0, gt=0, le=100)
    # a quote with no book at all may use its last traded price, labelled
    greeks_allow_ltp_fallback: bool = True
    # the surface is rebuilt at most this often when something changed ...
    greeks_rebuild_interval_s: float = Field(default=1.0, ge=0.1, le=60)
    # ... or at once when this many quotes changed
    greeks_rebuild_min_changed: int = Field(default=10, ge=1, le=1000)
    greeks_default_sticky: str = Field(default="moneyness", pattern=r"^(moneyness|strike|delta)$")
    greeks_max_legs: int = Field(default=60, ge=1, le=500)
    # PortfolioConfig as JSON: limits per leg, bucket and portfolio, beta, warn fraction
    # (see app/risk/portfolio.py)
    greeks_limits_json: str = ""
    # a frozen index quote in a chain snapshot is replaced by the level its option prices imply
    chain_spot_check: bool = True
    # decision-support risk and cost assumptions (paper trading only; no orders are ever placed)
    risk_max_loss_per_trade_rs: float = 2000.0
    risk_max_daily_loss_rs: float = 5000.0
    risk_max_trades_per_day: int = 4
    risk_max_consecutive_losses: int = 2
    risk_min_reward_risk: float = 1.5
    risk_max_spread_pts: float = 2.0
    risk_max_lots: int = 10
    risk_cutoff: str = "15:00"  # IST, HH:MM
    cost_lot_size: int = 65
    cost_brokerage_per_order: float = 20.0
    cost_stt_futures_sell_pct: float = 0.05
    cost_exchange_pct: float = 0.00183
    cost_slippage_pts: float = 0.5
    breadth_enabled: bool = True  # stock breadth, heavyweights, sectors (market-breadth-plan.md)
    eod_enabled: bool = True  # after-close archive, summary, manifest, backup (storage-plan.md)
    eod_backups: bool = True  # False on the server, where deploy/backup.sh already backs up nightly
    snapshot_raw_keep_days: int = 30  # owner-approved retention (D58; 30 days from 22 Nov 2026); 0 = keep forever  # noqa: E501
    snapshot_normalized_keep_days: int = 30  # only days with a verified archive are ever removed
    # the data library (docs/data-library-plan.md): automatic zip bundles of days that are about to age out, kept until downloaded; temporary restores for backtests  # noqa: E501
    library_enabled: bool = True
    library_block_days: int = 30  # every this many days of snapshot files become one bundle, announced in the heads-up strip, deleted from the server after the download is confirmed  # noqa: E501
    library_restore_ttl_hours: int = 24
    library_restore_max_mb: int = 1024
    library_min_free_gb: float = 6.0  # below this a bundle is not built or unpacked, and the snapshot files of bundled days are removed to protect the disk  # noqa: E501
    # per-contract rows of older sessions, removable once their archive is verified (0 = keep all)
    observation_keep_sessions: int = 2
    observation_prune_dry_run: bool = True  # report only; False needs owner approval
    market_close: str = "auto"  # 'auto' follows the exchange feed, or 'HH:MM'
    backup_keep_daily: int = 7
    backup_keep_monthly: int = 6
    swing_paper_enabled: bool = True  # after-close swing scan + paper trades (paper only)
    swing_live_enabled: bool = True  # live prices for the swing paper book (shadow decisions only)
    edge_enabled: bool = True  # nightly scoring of the indicators (Edge monitor)
    # how long heavy read answers are kept, as a share of their usual few seconds
    # (0: only callers at the same moment share one computation)
    read_cache_scale: float = 1.0
    forward_enabled: bool = True  # paper forward test of short straddles/strangles (paper only)
    intelligence_enabled: bool = True  # market-intelligence dashboard
    intelligence_volatility: str = ""  # JSON, e.g. {"mode": "context"}
    intelligence_weights: str = ""  # JSON object overriding engine weights, e.g. {"futures": 30}
    swing_live_fills_enabled: bool = True  # live paper ledger; never touches the official book
    swing_paper_capital: float = Field(default=1_000_000.0, ge=10_000)
    swing_paper_cost_per_side: float = Field(default=0.0015, ge=0, le=0.02)
    swing_paper_run_after: str = "17:00"  # IST, HH:MM; heavy jobs run after 16:30
    broker_daily_login: bool = True  # fresh broker sign-in every morning
    broker_login_time: str = "08:30"  # IST, HH:MM
    intraday_autoscore: bool = True  # record the rules-based intraday score each minute in session
    flows_autofetch: bool = True  # NSE participant-wise F&O files and FII/DII cash (low rate)
    # global markets, economic calendar and news (read-only context)
    globalmkts_enabled: bool = True
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
