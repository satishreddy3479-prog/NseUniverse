"""When the per-minute recorders run."""

from __future__ import annotations

from datetime import datetime

RECORD_AT_SECOND = 15


def seconds_to_next_record(now: datetime, at_second: int = RECORD_AT_SECOND) -> float:
    """Seconds until the next :15 of a minute. The recorders used to run at :00, before the sampler had stored that minute's chain (it stores at :04-:12), so the row of minute M held the data of
    M-1 and the first row of the day came at 09:16 (09:17 after a restart) instead of 09:15 (27 Nov 2026). At :15 the row of minute M is built from M's own sample."""
    d = (at_second - now.second - now.microsecond / 1_000_000) % 60.0
    return d if d >= 1.0 else d + 60.0
