"""The NIFTY 50 closing value, kept across restarts and browser reloads.

After 15:15 IST the exchange sends only indicative auction values for the index; the last one, at the end of the auction, is the value brokers show as the close. That value was held only in
the browser that happened to be open: after a reload or a backend restart the header fell back to the stored option-chain index level, frozen since 15:15, and showed it with the time of
the latest snapshot (26 Nov 2026: 25,889.20 instead of the close 25,884.50). This keeps the last auction value of the day in a small file and serves it as it is: not stored as a bar,
not used by any analysis, shown only as "closing value (auction)" with the time it was received.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from app.domain.session import closing_schedule

IST = ZoneInfo("Asia/Kolkata")
FILE_NAME = "index-close.json"
WRITE_EVERY_S = 2.0


class IndexClose:
    def __init__(self, directory: Path) -> None:
        self._path = directory / FILE_NAME
        self._value: dict[str, Any] | None = None
        self._written_at: datetime | None = None
        self._dirty = False
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and isinstance(raw.get("ltp"), int | float) and isinstance(raw.get("day"), str):
                self._value = raw
        except (OSError, ValueError):
            pass

    def observe(self, now: datetime, ltp: float | None, prev_close: float | None) -> None:
        """Keep an index value received during the closing auction (from the first indicative value to the end of the index feed)."""
        if ltp is None:
            return
        t = now.astimezone(IST)
        if t.weekday() >= 5:
            return
        sch = closing_schedule(t.date())
        if not (sch.indicative_from <= t.time() <= sch.index_end):
            return
        if self._value and self._value.get("day") == t.date().isoformat() and self._value.get("ltp") == ltp:
            return
        self._value = {"day": t.date().isoformat(), "ltp": ltp, "prev_close": prev_close, "received_at": now.astimezone(IST).isoformat(timespec="seconds")}
        self._dirty = True
        if self._written_at is None or (now - self._written_at).total_seconds() >= WRITE_EVERY_S:
            self.flush(now)

    def flush(self, now: datetime | None = None) -> None:
        if not self._dirty or self._value is None:
            return
        tmp = self._path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(self._value), encoding="utf-8")
            os.replace(tmp, self._path)
            self._dirty = False
            self._written_at = now or datetime.now(IST)
        except OSError:
            pass  # a failed write must never disturb the feed; the next value tries again

    def latest(self) -> dict[str, Any] | None:
        """The last auction value seen, with its day; the caller decides whether it is still today's or the previous session's."""
        self.flush()
        return dict(self._value) if self._value else None
