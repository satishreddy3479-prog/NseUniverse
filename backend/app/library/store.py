"""The library's own small database: which bundles exist (and which were downloaded and confirmed) and which temporary restores are active.

Kept apart from the market databases: losing it loses no market data (a bundle's manifest says what it holds, and ``LibraryService.rescan`` re-registers bundles found on disk).
"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, start_day TEXT NOT NULL, end_day TEXT NOT NULL, days TEXT NOT NULL,
  created_utc TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, files INTEGER NOT NULL, origin TEXT NOT NULL,
  confirmed_utc TEXT, removed_utc TEXT
);
CREATE TABLE IF NOT EXISTS restores (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bundle_name TEXT NOT NULL, dir TEXT NOT NULL, days TEXT NOT NULL, bytes INTEGER NOT NULL,
  created_utc TEXT NOT NULL, expires_utc TEXT NOT NULL, removed_utc TEXT, reason TEXT
);
"""


class LibraryStore:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ---- bundles
    def add_bundle(self, name: str, days: list[str], created: str, size: int, sha: str, files: int, origin: str) -> int:
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO bundles(name,start_day,end_day,days,created_utc,bytes,sha256,files,origin) VALUES(?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes, sha256=excluded.sha256, files=excluded.files, days=excluded.days, removed_utc=NULL",
                (name, days[0], days[-1], json.dumps(days), created, size, sha, files, origin),
            )
            self._db.commit()
            row = self._db.execute("SELECT id FROM bundles WHERE name=?", (name,)).fetchone()
            return int(row["id"] if row else cur.lastrowid or 0)

    def bundles(self, include_removed: bool = False) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM bundles" + ("" if include_removed else " WHERE removed_utc IS NULL") + " ORDER BY start_day DESC, id DESC").fetchall()  # noqa: S608
        return [{**dict(r), "days": json.loads(r["days"])} for r in rows]

    def bundle(self, bid: int) -> dict[str, Any] | None:
        with self._lock:
            r = self._db.execute("SELECT * FROM bundles WHERE id=?", (bid,)).fetchone()
        return None if r is None else {**dict(r), "days": json.loads(r["days"])}

    def confirm_bundle(self, bid: int, when: str) -> None:
        with self._lock:
            self._db.execute("UPDATE bundles SET confirmed_utc=? WHERE id=?", (when, bid))
            self._db.commit()

    def mark_bundle_removed(self, bid: int, when: str) -> None:
        with self._lock:
            self._db.execute("UPDATE bundles SET removed_utc=? WHERE id=?", (when, bid))
            self._db.commit()

    # ---- restores
    def add_restore(self, bundle_name: str, dir_: str, days: list[str], size: int, created: str, expires: str) -> int:
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO restores(bundle_name,dir,days,bytes,created_utc,expires_utc) VALUES(?,?,?,?,?,?)", (bundle_name, dir_, json.dumps(days), size, created, expires)
            )
            self._db.commit()
            return int(cur.lastrowid or 0)

    def restores(self, active_only: bool = True) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM restores" + (" WHERE removed_utc IS NULL" if active_only else "") + " ORDER BY id DESC").fetchall()  # noqa: S608
        return [{**dict(r), "days": json.loads(r["days"])} for r in rows]

    def restore(self, rid: int) -> dict[str, Any] | None:
        with self._lock:
            r = self._db.execute("SELECT * FROM restores WHERE id=?", (rid,)).fetchone()
        return None if r is None else {**dict(r), "days": json.loads(r["days"])}

    def extend_restore(self, rid: int, expires: str) -> None:
        with self._lock:
            self._db.execute("UPDATE restores SET expires_utc=? WHERE id=? AND removed_utc IS NULL", (expires, rid))
            self._db.commit()

    def mark_restore_removed(self, rid: int, when: str, reason: str) -> None:
        with self._lock:
            self._db.execute("UPDATE restores SET removed_utc=?, reason=? WHERE id=?", (when, reason, rid))
            self._db.commit()
