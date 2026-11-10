"""Timeline and alert store of the market-intelligence dashboard (data/intelligence.sqlite3).

One compact row per minute of market hours (the fused score, confidence, regime, each engine's score and a few headline readings), and
the alerts raised from changes between consecutive rows. Nothing is back-filled: a minute that was not recorded has no row. A row is
roughly 0.6 KB, so a 375-minute session is about 0.2 MB; see docs/market-intelligence-audit.md for the retention note.
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
CREATE TABLE IF NOT EXISTS timeline (
  session TEXT NOT NULL, at TEXT NOT NULL, expiry TEXT NOT NULL, spot REAL, score REAL, confidence REAL, coverage REAL,
  regime TEXT, vol_regime TEXT, gamma_regime TEXT, engines TEXT NOT NULL, metrics TEXT NOT NULL, divs TEXT NOT NULL,
  PRIMARY KEY (session, at));
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL,
  direction TEXT NOT NULL, text TEXT NOT NULL, evidence TEXT NOT NULL, confirmation TEXT NOT NULL, invalidation TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_alerts_session ON alerts(session, id);
"""


class IntelligenceStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = Path(data_dir) / "intelligence.sqlite3"
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
        """Insert one minute. False if that minute already has a row (one writer per minute, never rewritten)."""
        with self._lock, closing(self._conn()) as c, c:
            cur = c.execute(
                "INSERT OR IGNORE INTO timeline VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (session, at.isoformat(timespec="seconds"), expiry, snap.get("spot"), snap.get("score"), snap.get("confidence"), snap.get("coverage"),
                 snap.get("regime"), snap.get("vol_regime"), snap.get("gamma_regime"), json.dumps(snap.get("engines", {})), json.dumps(snap.get("metrics", {})), json.dumps(snap.get("divs", []))),
            )
            return bool(cur.rowcount)

    def rows(self, session: str, limit: int = 500, newest_first: bool = False) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            order = "DESC" if newest_first else "ASC"
            sub = f"SELECT * FROM timeline WHERE session=? ORDER BY at DESC LIMIT {int(limit)}"  # noqa: S608
            q = f"SELECT * FROM ({sub}) ORDER BY at {order}"  # noqa: S608
            out = []
            for r in c.execute(q, (session,)):
                d = dict(r)
                for k in ("engines", "metrics", "divs"):
                    d[k] = json.loads(d[k])
                out.append(d)
            return out

    def sessions(self, limit: int = 30) -> list[str]:
        with self._lock, closing(self._conn()) as c:
            return [r[0] for r in c.execute("SELECT DISTINCT session FROM timeline ORDER BY session DESC LIMIT ?", (limit,))]

    def add_alert(self, session: str, at: datetime, a: dict[str, Any]) -> None:
        with self._lock, closing(self._conn()) as c, c:
            c.execute("INSERT INTO alerts (session, at, kind, severity, direction, text, evidence, confirmation, invalidation) VALUES (?,?,?,?,?,?,?,?,?)",
                      (session, at.isoformat(timespec="seconds"), a["kind"], a["severity"], a["direction"], a["text"], json.dumps(a.get("evidence", [])), a["confirmation"], a["invalidation"]))

    def alerts(self, session: str, limit: int = 40) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            out = []
            for r in c.execute("SELECT * FROM alerts WHERE session=? ORDER BY id DESC LIMIT ?", (session, limit)):
                d = dict(r)
                d["evidence"] = json.loads(d["evidence"])
                out.append(d)
            return out

    def last_alert_at(self, session: str, kind: str, direction: str) -> str | None:
        with self._lock, closing(self._conn()) as c:
            r = c.execute("SELECT at FROM alerts WHERE session=? AND kind=? AND direction=? ORDER BY id DESC LIMIT 1", (session, kind, direction)).fetchone()
            return None if r is None else str(r[0])
