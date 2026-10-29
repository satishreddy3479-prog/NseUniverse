"""Daily news-tone and news-volume series from GDELT, stored append-only with the time we fetched them.

GDELT's DOC API serves daily series only for the last three months, so there is no multi-year
history to train on: this store builds that history forward from the day collection started.
Each fetch is kept (a day's value can change while the day is still being processed), nothing is
overwritten, and a value is only usable by a forecast made after its ``fetched_utc``.
"""

from __future__ import annotations

import sqlite3
import threading
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS gdelt_daily (
  theme TEXT NOT NULL, day TEXT NOT NULL, tone REAL, volume_pct REAL, fetched_utc TEXT NOT NULL,
  PRIMARY KEY (theme, day, fetched_utc)
);
CREATE TRIGGER IF NOT EXISTS gdelt_no_update BEFORE UPDATE ON gdelt_daily BEGIN SELECT RAISE(ABORT, 'stored news values are never changed'); END;
CREATE TRIGGER IF NOT EXISTS gdelt_no_delete BEFORE DELETE ON gdelt_daily BEGIN SELECT RAISE(ABORT, 'stored news values are never deleted'); END;
"""


class NewsStore:
    def __init__(self, data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "news.sqlite3"
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def save(self, theme: str, rows: list[tuple[date, float | None, float | None]], now: datetime | None = None) -> int:
        stamp = (now or datetime.now(UTC)).isoformat()
        with self._lock:
            n = 0
            for d, tone, vol in rows:
                n += self._db.execute("INSERT OR IGNORE INTO gdelt_daily VALUES (?,?,?,?,?)", (theme, str(d), tone, vol, stamp)).rowcount
            self._db.commit()
        return n

    def latest(self, days: int = 7) -> dict[str, list[dict[str, Any]]]:
        """Most recently fetched value for each theme and day, newest days first."""
        with self._lock:
            rows = self._db.execute(
                "SELECT theme, day, tone, volume_pct, fetched_utc FROM gdelt_daily g WHERE fetched_utc = "
                "(SELECT MAX(fetched_utc) FROM gdelt_daily WHERE theme=g.theme AND day=g.day) ORDER BY theme, day DESC"
            ).fetchall()
        out: dict[str, list[dict[str, Any]]] = {}
        for t, d, tone, vol, f in rows:
            if len(out.setdefault(t, [])) < days:
                out[t].append({"day": d, "tone": tone, "volume_pct": vol, "fetched_utc": f})
        return out

    def coverage(self) -> dict[str, Any]:
        with self._lock:
            r = self._db.execute("SELECT MIN(day), MAX(day), COUNT(DISTINCT day), MIN(fetched_utc), MAX(fetched_utc) FROM gdelt_daily").fetchone()
        return {"first_day": r[0], "last_day": r[1], "days": r[2], "collecting_since": r[3], "last_fetch": r[4]}
