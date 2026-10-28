"""In-memory application state: counters and a ring buffer of sanitized errors."""

from __future__ import annotations

from collections import deque
from datetime import UTC, datetime

from pydantic import BaseModel


class ErrorEvent(BaseModel):
    at: datetime
    component: str
    code: str
    message: str  # already sanitized; never contains secrets


class SnapshotActivity(BaseModel):
    last_attempt_at: datetime | None = None
    last_success_at: datetime | None = None
    last_error: str | None = None
    in_progress: bool = False
    captured_count: int = 0


class AppState:
    def __init__(self, session_id: str, max_errors: int = 50) -> None:
        self.session_id = session_id
        self.started_at = datetime.now(UTC)
        self.errors: deque[ErrorEvent] = deque(maxlen=max_errors)
        self.snapshots = SnapshotActivity()

    def record_error(self, component: str, code: str, message: str) -> None:
        self.errors.appendleft(
            ErrorEvent(at=datetime.now(UTC), component=component, code=code, message=message[:300])
        )
