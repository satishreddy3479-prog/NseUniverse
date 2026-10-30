"""Saved and closed option strategies, kept on the server so they survive a cleared browser.

Nothing is ever hard-deleted: removing a strategy marks it deleted (it stops being listed) and every
write is also appended to a revision history. A strategy document is stored exactly as the app sends it.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

KINDS = ("saved", "closed")
MAX_DOC_BYTES = 200_000
MAX_KEY_LEN = 120

_SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
  kind TEXT NOT NULL, key TEXT NOT NULL, doc TEXT NOT NULL,
  created_utc TEXT NOT NULL, updated_utc TEXT NOT NULL, deleted_utc TEXT,
  PRIMARY KEY (kind, key)
);
CREATE TABLE IF NOT EXISTS revisions (
  rev_id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, key TEXT NOT NULL,
  doc TEXT, at_utc TEXT NOT NULL, action TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_rev_item ON revisions(kind, key);
CREATE TRIGGER IF NOT EXISTS rev_no_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'history is never changed'); END;
CREATE TRIGGER IF NOT EXISTS rev_no_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'history is never deleted'); END;
CREATE TRIGGER IF NOT EXISTS item_no_delete BEFORE DELETE ON items BEGIN SELECT RAISE(ABORT, 'strategies are marked deleted, never removed'); END;
"""


class StrategyError(ValueError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat()


class StrategyStore:
    def __init__(self, data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "strategies.sqlite3"
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    @staticmethod
    def _check(kind: str, key: str) -> None:
        if kind not in KINDS:
            raise StrategyError(f"kind must be one of {KINDS}")
        if not key.strip() or len(key) > MAX_KEY_LEN:
            raise StrategyError(f"key must be 1-{MAX_KEY_LEN} characters")

    def put(self, kind: str, key: str, doc: dict[str, Any]) -> None:
        """Create or replace one strategy. A previously deleted key comes back."""
        self._check(kind, key)
        text = json.dumps(doc, separators=(",", ":"), sort_keys=True)
        if len(text.encode()) > MAX_DOC_BYTES:
            raise StrategyError("strategy document is too large")
        now = _now()
        with self._lock:
            row = self._db.execute("SELECT doc, deleted_utc FROM items WHERE kind=? AND key=?", (kind, key)).fetchone()
            if row is None:
                self._db.execute("INSERT INTO items VALUES (?,?,?,?,?,NULL)", (kind, key, text, now, now))
                action = "create"
            elif row[0] == text and row[1] is None:
                return  # identical: no new revision
            else:
                self._db.execute("UPDATE items SET doc=?, updated_utc=?, deleted_utc=NULL WHERE kind=? AND key=?", (text, now, kind, key))
                action = "update" if row[1] is None else "restore"
            self._db.execute("INSERT INTO revisions(kind, key, doc, at_utc, action) VALUES (?,?,?,?,?)", (kind, key, text, now, action))
            self._db.commit()

    def put_if_absent(self, kind: str, key: str, doc: dict[str, Any]) -> bool:
        """Import helper: store only if the key was never stored (a deleted one is not resurrected)."""
        self._check(kind, key)
        with self._lock:
            exists = self._db.execute("SELECT 1 FROM items WHERE kind=? AND key=?", (kind, key)).fetchone()
        if exists:
            return False
        self.put(kind, key, doc)
        return True

    def delete(self, kind: str, key: str) -> bool:
        self._check(kind, key)
        now = _now()
        with self._lock:
            cur = self._db.execute("UPDATE items SET deleted_utc=? WHERE kind=? AND key=? AND deleted_utc IS NULL", (now, kind, key))
            if cur.rowcount:
                self._db.execute("INSERT INTO revisions(kind, key, doc, at_utc, action) VALUES (?,?,NULL,?,'delete')", (kind, key, now))
            self._db.commit()
            return bool(cur.rowcount)

    def list(self, kind: str) -> list[dict[str, Any]]:
        self._check(kind, "x")
        with self._lock:
            rows = self._db.execute(
                "SELECT doc FROM items WHERE kind=? AND deleted_utc IS NULL ORDER BY updated_utc DESC", (kind,)
            ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def history(self, kind: str, key: str) -> list[dict[str, Any]]:
        self._check(kind, key)
        with self._lock:
            rows = self._db.execute(
                "SELECT at_utc, action, doc FROM revisions WHERE kind=? AND key=? ORDER BY rev_id", (kind, key)
            ).fetchall()
        return [{"at": a, "action": act, "doc": json.loads(d) if d else None} for a, act, d in rows]
