"""Typed data contracts shared by services, storage and the API.

Numeric market values are parsed into ``float | None`` for transport and display.
``None`` always means "missing or invalid at source" -- never zero. The verbatim
broker payload is preserved alongside each snapshot for audit/reprocessing.
"""

from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class DataSource(StrEnum):
    LIVE = "live"  # streamed from the broker feed in real time
    SNAPSHOT = "snapshot"  # fetched from the broker REST API at retrieved_at
    STORED = "stored"  # loaded from local storage (historical)


class Completeness(StrEnum):
    COMPLETE = "complete"
    PARTIAL = "partial"
    EMPTY = "empty"


class ExpiryKind(StrEnum):
    WEEKLY = "weekly"
    MONTHLY = "monthly"


class ExpirySelection(BaseModel):
    underlying: str
    as_of: date = Field(description="Date (IST) the selection was computed for")
    available: list[date]
    weekly: date | None
    monthly: date | None
    monthly_is_next_month: bool = Field(
        description="True when the current month had no remaining expiry and the "
        "monthly selection rolled to next month's last expiry"
    )
    weekly_equals_monthly: bool
    source: DataSource
    retrieved_at: datetime
    warnings: list[str] = []


class OptionQuote(BaseModel):
    exchange_segment: str | None
    instrument_token: str | None
    trading_symbol: str | None
    option_type: str  # "CE" | "PE"
    ltp: float | None
    open: float | None
    high: float | None
    low: float | None
    prev_close: float | None
    close: float | None
    volume: float | None
    oi: float | None
    oi_previous: float | None
    oi_change: float | None
    oi_change_pct: float | None
    moneyness: str | None
    invalid_fields: list[str] = []


class OptionChainRow(BaseModel):
    strike: float
    call: OptionQuote | None
    put: OptionQuote | None


class SnapshotSummary(BaseModel):
    snapshot_id: str
    session_id: str
    underlying: str
    expiry: date
    expiry_kinds: list[ExpiryKind]
    source: DataSource
    retrieved_at: datetime
    completeness: Completeness
    strikes: int
    ce_count: int
    pe_count: int
    file_ref: str
    underlying_ltp: float | None = None
    underlying_prev_close: float | None = None


class OptionChainSnapshot(BaseModel):
    snapshot_id: str
    session_id: str
    underlying: str
    expiry: date
    expiry_kinds: list[ExpiryKind]
    source: DataSource
    retrieved_at: datetime = Field(description="UTC time the backend received the response")
    exchange_timestamp: datetime | None = Field(
        default=None, description="Not provided by option_chain(); kept explicit as missing"
    )
    lot_size: float | None
    multiplier: float | None
    underlying_ltp: float | None = Field(
        default=None, description="Index spot from the same response; a snapshot value, not live"
    )
    underlying_prev_close: float | None = None
    requested_strike_count: int
    completeness: Completeness
    rows: list[OptionChainRow]
    ce_count: int
    pe_count: int
    warnings: list[str] = []

    def summary(self, file_ref: str) -> SnapshotSummary:
        return SnapshotSummary(
            snapshot_id=self.snapshot_id,
            session_id=self.session_id,
            underlying=self.underlying,
            expiry=self.expiry,
            expiry_kinds=self.expiry_kinds,
            source=self.source,
            retrieved_at=self.retrieved_at,
            completeness=self.completeness,
            strikes=len(self.rows),
            ce_count=self.ce_count,
            pe_count=self.pe_count,
            file_ref=file_ref,
            underlying_ltp=self.underlying_ltp,
            underlying_prev_close=self.underlying_prev_close,
        )
