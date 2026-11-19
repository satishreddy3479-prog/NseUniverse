"""A small permanent ledger of the overnight context and the high-importance calendar events of every trading day.

The global-markets store deliberately forgets: one-minute bars after a few days, calendar events two days after their date. The Entry Lab needs what was known before each past session, so the
two things worth keeping are written here once, in a few hundred bytes a day: the pre-open moves of GIFT Nifty and a few world markets, and the high-importance events (country, name, clock
time, importance, outcome). Nothing here is read by a score or by trading logic; it only feeds the lab and the day's context card.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, date_ist TEXT NOT NULL, country TEXT, name TEXT NOT NULL, impact TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0,
  actual TEXT, forecast TEXT, previous TEXT, first_seen INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
CREATE TABLE IF NOT EXISTS day_context (day TEXT PRIMARY KEY, at_ms INTEGER NOT NULL, data TEXT NOT NULL);
"""
KEEP_IMPACT = ("high",)


class ContextLedger:
    def __init__(self, data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "context_ledger.sqlite3"
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(SCHEMA)
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ------------------------------------------------------------------ events
    def add_events(self, events: Sequence[Mapping[str, Any]], now: datetime | None = None) -> int:
        """Keep the high-importance events (the latest actual and forecast replace older ones). Returns the rows written."""
        at = int((now or datetime.now(UTC)).timestamp() * 1000)
        n = 0
        with self._lock:
            for e in events:
                if e.get("impact") not in KEEP_IMPACT or not e.get("name") or e.get("ts") is None:
                    continue
                self._db.execute(
                    "INSERT INTO events (id, ts, date_ist, country, name, impact, all_day, actual, forecast, previous, first_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
                    " ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, date_ist=excluded.date_ist, all_day=excluded.all_day, actual=COALESCE(excluded.actual, actual),"
                    " forecast=COALESCE(excluded.forecast, forecast), previous=COALESCE(excluded.previous, previous)",
                    (str(e["id"]), int(e["ts"]), str(e["date_ist"]), e.get("country"), str(e["name"]), str(e["impact"]), 1 if e.get("all_day") else 0, e.get("actual"), e.get("forecast"), e.get("previous"), at),
                )
                n += 1
            self._db.commit()
        return n

    def events_between(self, start_ms: int, end_ms: int) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT ts, date_ist, country, name, impact, all_day, actual, forecast FROM events WHERE ts>? AND ts<=? ORDER BY ts", (start_ms, end_ms)).fetchall()
        return [{"ts": r[0], "date_ist": r[1], "country": r[2], "name": r[3], "impact": r[4], "all_day": bool(r[5]), "actual": r[6], "forecast": r[7]} for r in rows]

    def coverage(self) -> tuple[str, str] | None:
        """The first and the last event date held (a day outside it has no event record: its features are unknown, not zero)."""
        with self._lock:
            r = self._db.execute("SELECT MIN(date_ist), MAX(date_ist) FROM events").fetchone()
        return None if not r or r[0] is None else (str(r[0]), str(r[1]))

    # ------------------------------------------------------------------ day context
    def put_context(self, day: str, data: Mapping[str, Any], now: datetime | None = None) -> bool:
        """Store the overnight context of a day once (the first record stands: it was taken before the open). True when written."""
        at = int((now or datetime.now(UTC)).timestamp() * 1000)
        with self._lock:
            cur = self._db.execute("INSERT OR IGNORE INTO day_context (day, at_ms, data) VALUES (?,?,?)", (day, at, json.dumps(data, separators=(",", ":"))))
            self._db.commit()
            return cur.rowcount > 0

    def context(self, day: str) -> dict[str, Any] | None:
        with self._lock:
            r = self._db.execute("SELECT data FROM day_context WHERE day=?", (day,)).fetchone()
        return None if r is None else dict(json.loads(r[0]))

    def context_days(self) -> list[str]:
        with self._lock:
            return [str(r[0]) for r in self._db.execute("SELECT day FROM day_context ORDER BY day")]

    def counts(self) -> dict[str, int]:
        with self._lock:
            return {"events": int(self._db.execute("SELECT COUNT(*) FROM events").fetchone()[0]), "days": int(self._db.execute("SELECT COUNT(*) FROM day_context").fetchone()[0])}
