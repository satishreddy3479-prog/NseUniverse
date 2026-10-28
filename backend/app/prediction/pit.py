"""Point-in-time (information cutoff) discipline.

Every value a feature uses carries when it happened, when it was published and when we got it. A
value
may be used in a forecast only if it was PUBLISHED at or before the forecast cutoff. When the
publication time is unknown, the value is unavailable for leakage-safe use: we never assume it.
All timestamps are timezone-aware and compared in UTC.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")

Quality = Literal["ok", "delayed", "stale", "missing", "estimated", "unavailable"]


class LeakageError(AssertionError):
    """A feature used information published after the cutoff, or of unknown publication time."""


def _utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        raise ValueError("naive datetime: every timestamp must be timezone-aware")
    return dt.astimezone(UTC)


@dataclass(frozen=True)
class Observation:
    """One value from one source, with its full timing.

    ``effective_at``: the moment the value describes (a close, an event). ``published_at``: when the
    source made it public (None = unknown). ``retrieved_at`` / ``ingested_at``: when we fetched and
    stored it (None for reconstructed history). ``version``: revision label if the source revises.
    """

    source: str
    name: str
    value: float | str | None
    effective_at: datetime
    published_at: datetime | None
    retrieved_at: datetime | None = None
    ingested_at: datetime | None = None
    version: str | None = None
    quality: Quality = "ok"
    unit: str | None = None

    def __post_init__(self) -> None:
        for dt in (self.effective_at, self.published_at, self.retrieved_at, self.ingested_at):
            if dt is not None:
                _utc(dt)

    def available_at(self, cutoff: datetime) -> bool:
        """Usable by a forecast made at ``cutoff``. Unknown publication time => not usable."""
        if (
            self.published_at is None
            or self.value is None
            or self.quality in ("missing", "unavailable")
        ):
            return False
        return _utc(self.published_at) <= _utc(cutoff)


def assert_point_in_time(observations: list[Observation], cutoff: datetime) -> None:
    """Fail loudly if any observation could not have been known at the cutoff."""
    bad = [
        f"{o.source}:{o.name} published {o.published_at} (effective {o.effective_at})"
        for o in observations
        if o.published_at is None or _utc(o.published_at) > _utc(cutoff)
    ]
    if bad:
        raise LeakageError(
            f"{len(bad)} observation(s) not available at cutoff {cutoff}: " + "; ".join(bad[:5])
        )


def select_available(
    observations: list[Observation], cutoff: datetime
) -> tuple[list[Observation], list[Observation]]:
    """Split into (usable at the cutoff, excluded). Excluded ones are returned so the record
    can state exactly what was left out and why, instead of silently dropping them."""
    use = [o for o in observations if o.available_at(cutoff)]
    skip = [o for o in observations if not o.available_at(cutoff)]
    return use, skip


def latest_available(
    observations: list[Observation], name: str, cutoff: datetime
) -> Observation | None:
    """Most recently EFFECTIVE value of ``name`` that was already published at the cutoff.

    If a value was revised, the version published latest before the cutoff wins, so history sees the
    figure that was known then, not the corrected one.
    """
    cands = [o for o in observations if o.name == name and o.available_at(cutoff)]
    if not cands:
        return None
    return max(cands, key=lambda o: (_utc(o.effective_at), _utc(o.published_at)))  # type: ignore[arg-type]


@dataclass(frozen=True)
class PublicationRule:
    """Nominal publication delay for a source whose per-record publication time is not stored.

    ``lag`` after the effective time, or ``at_ist`` a fixed IST clock time on the effective date (or
    ``next_day``). A rule only makes a feature backtestable if the delay is documented and verified;
    otherwise the feature stays unavailable for leakage-safe history.
    """

    source: str
    description: str
    verified: bool
    lag: timedelta | None = None
    at_ist: tuple[int, int] | None = None
    next_day: bool = False
    notes: str = field(default="")

    def published_at(self, effective_at: datetime) -> datetime:
        if not self.verified:
            raise LeakageError(
                f"{self.source}: publication rule is not verified; unavailable for backtests"
            )
        if self.at_ist is not None:
            d = effective_at.astimezone(IST).date()
            if self.next_day:
                d += timedelta(days=1)
            return datetime(d.year, d.month, d.day, self.at_ist[0], self.at_ist[1], tzinfo=IST)
        if self.lag is not None:
            return effective_at + self.lag
        raise LeakageError(f"{self.source}: rule has neither a lag nor a clock time")


def forecast_cutoff(session_date: Any, hour: int, minute: int) -> datetime:
    """A forecast cutoff on ``session_date`` at an IST wall-clock time (timezone-aware)."""
    return datetime(
        session_date.year, session_date.month, session_date.day, hour, minute, tzinfo=IST
    )
