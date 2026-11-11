"""Per-minute record of the straddle decay engine (data/straddle.sqlite3) and its alerts.

One compact row per recorded minute of market hours: the inputs the engines read, fixed and rolling ATM premiums, IV readings, the attribution totals, decay
efficiency, both environment scores, the regime, and a +-2 strike premium ladder (so the later price of the same contract can be found without the chain
archive). Nothing is back-filled: a minute that was not recorded has no row. A row is about 1.2 KB, a 375-minute session about 0.45 MB (about 110 MB a year).
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS obs (
  session TEXT NOT NULL, at TEXT NOT NULL, expiry TEXT NOT NULL, spot REAL, seller REAL, buyer REAL, regime TEXT, data TEXT NOT NULL,
  PRIMARY KEY (session, at));
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL,
  direction TEXT NOT NULL, text TEXT NOT NULL, evidence TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_straddle_alerts ON alerts(session, id);
"""


class StraddleStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = Path(data_dir) / "straddle.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with closing(self._conn()) as c, c:
            c.executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        return c

    def record(self, session: str, at: datetime, expiry: str, snap: dict[str, Any]) -> bool:
        """Insert one minute; False if it already has a row (never rewritten)."""
        with self._lock, closing(self._conn()) as c, c:
            cur = c.execute("INSERT OR IGNORE INTO obs VALUES (?,?,?,?,?,?,?,?)",
                            (session, at.isoformat(timespec="seconds"), expiry, snap.get("spot"), snap.get("seller"), snap.get("buyer"), snap.get("regime"), json.dumps(snap, separators=(",", ":"))))  # fmt: skip
            return bool(cur.rowcount)

    def rows(self, session: str, limit: int = 500, newest_first: bool = False) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            order = "DESC" if newest_first else "ASC"
            q = f"SELECT * FROM (SELECT * FROM obs WHERE session=? ORDER BY at DESC LIMIT {int(limit)}) ORDER BY at {order}"  # noqa: S608
            out = []
            for r in c.execute(q, (session,)):
                d = dict(r)
                d["data"] = json.loads(d["data"])
                out.append(d)
            return out

    def sessions(self, limit: int = 60) -> list[str]:
        with self._lock, closing(self._conn()) as c:
            return [r[0] for r in c.execute("SELECT DISTINCT session FROM obs ORDER BY session DESC LIMIT ?", (limit,))]

    def add_alert(self, session: str, at: datetime, a: dict[str, Any]) -> None:
        with self._lock, closing(self._conn()) as c, c:
            c.execute("INSERT INTO alerts (session, at, kind, severity, direction, text, evidence) VALUES (?,?,?,?,?,?,?)",
                      (session, at.isoformat(timespec="seconds"), a["kind"], a["severity"], a["direction"], a["text"], json.dumps(a.get("evidence", []))))  # fmt: skip

    def alerts(self, session: str, limit: int = 40) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            out = []
            for r in c.execute("SELECT * FROM alerts WHERE session=? ORDER BY id DESC LIMIT ?", (session, limit)):
                d = dict(r)
                d["evidence"] = json.loads(d["evidence"])
                out.append(d)
            return out

    def last_alert_at(self, session: str, kind: str) -> str | None:
        with self._lock, closing(self._conn()) as c:
            r = c.execute("SELECT at FROM alerts WHERE session=? AND kind=? ORDER BY id DESC LIMIT 1", (session, kind)).fetchone()
            return None if r is None else str(r[0])

    def size_bytes(self) -> int:
        return sum(p.stat().st_size for p in self.path.parent.glob("straddle.sqlite3*") if p.exists())
