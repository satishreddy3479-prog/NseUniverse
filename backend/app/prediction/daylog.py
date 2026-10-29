"""One line per forecast day: was the forecast recorded, and if not, why not.

The forward-test ledger holds only forecasts that were locked before the outcome. A day on which nothing
could be locked (an input series was late, the report was not computed) would otherwise simply be absent,
so the forward test would look more complete than it is. This log records every forecast day, its status,
the reason, and the number the page showed that morning. A number shown for a day that was NOT recorded is a
preview: it is never counted in the forward test or the scoreboard. Rows are written once and never changed.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS days (
  horizon TEXT NOT NULL, target_session TEXT NOT NULL, reference_session TEXT NOT NULL,
  status TEXT NOT NULL, reason TEXT, stale TEXT NOT NULL, p_up REAL, p_up_climatology REAL,
  model TEXT, logged_utc TEXT NOT NULL, PRIMARY KEY (horizon, target_session)
);
CREATE TRIGGER IF NOT EXISTS days_no_update BEFORE UPDATE ON days BEGIN SELECT RAISE(ABORT, 'log rows are never changed'); END;
CREATE TRIGGER IF NOT EXISTS days_no_delete BEFORE DELETE ON days BEGIN SELECT RAISE(ABORT, 'log rows are never deleted'); END;
"""


class DayLog:
    def __init__(self, data_dir: Path | None) -> None:
        self._lock = threading.Lock()
        self._db = sqlite3.connect(":memory:" if data_dir is None else str(data_dir / "prediction_daylog.sqlite3"), check_same_thread=False)
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def log(self, horizon: str, target: date, reference: date, status: str, reason: str | None, stale: list[str], p_up: float | None, p_clim: float | None, model: str | None, now: datetime | None = None) -> bool:
        """Write the day once; a second write for the same day is ignored. Returns whether it was written."""
        with self._lock:
            cur = self._db.execute(
                "INSERT OR IGNORE INTO days VALUES (?,?,?,?,?,?,?,?,?,?)",
                (horizon, str(target), str(reference), status, reason, json.dumps(stale), p_up, p_clim, model, (now or datetime.now(UTC)).isoformat()),
            )
            self._db.commit()
        return cur.rowcount > 0

    def has(self, horizon: str, target: date) -> bool:
        with self._lock:
            return self._db.execute("SELECT 1 FROM days WHERE horizon=? AND target_session=?", (horizon, str(target))).fetchone() is not None

    def recent(self, limit: int = 40) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT horizon, target_session, reference_session, status, reason, stale, p_up, p_up_climatology, model, logged_utc FROM days ORDER BY target_session DESC, horizon LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {"horizon": h, "target_session": t, "reference_session": r, "status": s, "reason": why, "stale": json.loads(st), "p_up": p, "p_up_climatology": c, "model": m, "logged_utc": at}
            for h, t, r, s, why, st, p, c, m, at in rows
        ]
