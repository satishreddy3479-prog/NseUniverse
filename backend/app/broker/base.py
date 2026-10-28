"""Broker interface used by services (implementation: KotakBroker)."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from enum import StrEnum
from typing import Any, Protocol

from pydantic import BaseModel

from app.stream.feed import FeedSession


class BrokerError(Exception):
    """Sanitized broker failure. ``message`` is safe to show in the UI."""

    def __init__(self, message: str, *, code: str = "broker_error", retryable: bool = False):
        super().__init__(message)
        self.message = message
        self.code = code
        self.retryable = retryable


class AuthState(StrEnum):
    NOT_ATTEMPTED = "not_attempted"
    AUTHENTICATING = "authenticating"
    AUTHENTICATED = "authenticated"
    FAILED = "failed"


class AuthStatus(BaseModel):
    state: AuthState
    last_attempt_at: datetime | None = None
    last_success_at: datetime | None = None
    last_error: str | None = None


class MarketDataBroker(Protocol):
    name: str

    @property
    def auth_status(self) -> AuthStatus: ...

    async def login(self) -> AuthStatus: ...

    async def ensure_login(self) -> AuthStatus: ...

    async def get_expiries(self, underlying: str) -> list[Any]:
        """Return raw expiry values (ISO date strings) for options on ``underlying``."""
        ...

    async def get_option_chain(self, underlying: str, expiry: str, count: int) -> Mapping[str, Any]:
        """Return the raw option_chain() response body."""
        ...

    async def create_feed(self) -> FeedSession:
        """Create (not connect) a streaming session. Raises BrokerError if not signed in."""
        ...

    async def close(self) -> None: ...
