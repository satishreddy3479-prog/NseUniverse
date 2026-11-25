"""The scoring ledger (data/scoring.sqlite3): every call an indicator made on a finished session and what price did next, plus the market's own windows (the baselines).

Derived only from stored data, so a session can always be scored again; a new scoring ``VERSION`` replaces a session's rows, nothing else is ever rewritten. About 400 rows and
a few KB per session (a few MB a year). Backed up with the other databases by the end-of-day job.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Mapping, Sequence
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

VERSION = "edge-1"
SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
  session TEXT NOT NULL, indicator TEXT NOT NULL, horizon INTEGER NOT NULL, at TEXT NOT NULL, side INTEGER NOT NULL, spot REAL, fwd_pct REAL, result TEXT NOT NULL,
  PRIMARY KEY (session, indicator, horizon, at));
CREATE TABLE IF NOT EXISTS windows (
  session TEXT NOT NULL, horizon INTEGER NOT NULL, hour INTEGER NOT NULL, n INTEGER NOT NULL, up INTEGER NOT NULL, down INTEGER NOT NULL, calm INTEGER NOT NULL,
  PRIMARY KEY (session, horizon, hour));
CREATE TABLE IF NOT EXISTS scored (
  session TEXT NOT NULL, indicator TEXT NOT NULL, version TEXT NOT NULL, scored_at TEXT NOT NULL, n_calls INTEGER NOT NULL, PRIMARY KEY (session, indicator));
"""


class EdgeStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = Path(data_dir) / "scoring.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with closing(self._conn()) as c, c:
            c.executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        return c

    def scored(self) -> dict[tuple[str, str], str]:
        """(session, indicator) -> the version that scored it."""
        with self._lock, closing(self._conn()) as c:
            return {(r["session"], r["indicator"]): r["version"] for r in c.execute("SELECT session, indicator, version FROM scored")}

    def replace_session(self, session: str, calls: Sequence[Mapping[str, Any]], windows: Sequence[Mapping[str, Any]], indicators: Mapping[str, int], now: datetime | None = None) -> None:
        """Replace everything of one session in one transaction (``indicators``: the indicators that had data, each with its number of calls)."""
        stamp = (now or datetime.now(UTC)).isoformat(timespec="seconds")
        with self._lock, closing(self._conn()) as c, c:
            for t in ("calls", "windows", "scored"):
                c.execute(f"DELETE FROM {t} WHERE session=?", (session,))  # noqa: S608
            c.executemany("INSERT OR IGNORE INTO calls VALUES (?,?,?,?,?,?,?,?)", [(x["session"], x["indicator"], x["horizon"], x["at"], x["side"], x["spot"], x["fwd_pct"], x["result"]) for x in calls])
            c.executemany("INSERT OR REPLACE INTO windows VALUES (?,?,?,?,?,?,?)", [(session, w["horizon"], w["hour"], w["n"], w["up"], w["down"], w["calm"]) for w in windows])
            c.executemany("INSERT INTO scored VALUES (?,?,?,?,?)", [(session, k, VERSION, stamp, n) for k, n in indicators.items()])

    def calls(self) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            return [dict(r) for r in c.execute("SELECT * FROM calls ORDER BY session, at")]

    def windows(self) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            return [dict(r) for r in c.execute("SELECT * FROM windows")]

    def sessions(self) -> list[str]:
        with self._lock, closing(self._conn()) as c:
            return [r[0] for r in c.execute("SELECT DISTINCT session FROM scored ORDER BY session")]
