"""The owner's display preferences (saved chart layouts, chosen candle lengths, theme, capital figure, read marks...), kept on the server so every browser and PC shows the same app.

Each preference is one key and its value exactly as the app wrote it (a short string, usually JSON). Removing one writes a tombstone (value NULL) with a time, so a removal on one
device reaches the others instead of the other device's old copy bringing it back. Nothing is hard-deleted. The server stamps every write with its own clock: the devices' clocks are
never compared. Not market data and not a strategy: a lost row only costs a layout.
"""

from __future__ import annotations

import re
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

MAX_VALUE_BYTES = 64_000
MAX_KEYS = 400
_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY, value TEXT, updated_utc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pref_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, value TEXT, at_utc TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS pref_no_delete BEFORE DELETE ON prefs BEGIN SELECT RAISE(ABORT, 'preferences are tombstoned, never removed'); END;
CREATE TRIGGER IF NOT EXISTS hist_no_update BEFORE UPDATE ON pref_history BEGIN SELECT RAISE(ABORT, 'history is never changed'); END;
"""


class PreferenceError(ValueError):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds")


class PreferenceStore:
    def __init__(self, data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "preferences.sqlite3"
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
    def _check_key(key: str) -> None:
        if not _KEY.match(key):
            raise PreferenceError("key must be 1-120 characters of letters, digits, '.', '_', ':' or '-'")

    def all(self) -> dict[str, dict[str, Any]]:
        """Every key with its value (None for a removed one) and the server time of its last change."""
        with self._lock:
            rows = self._db.execute("SELECT key, value, updated_utc FROM prefs").fetchall()
        return {k: {"value": v, "updatedAt": t} for k, v, t in rows}

    def put(self, key: str, value: str) -> dict[str, Any]:
        self._check_key(key)
        if len(value.encode()) > MAX_VALUE_BYTES:
            raise PreferenceError("value is too large")
        return self._write(key, value)

    def delete(self, key: str) -> dict[str, Any]:
        self._check_key(key)
        return self._write(key, None)

    def _write(self, key: str, value: str | None) -> dict[str, Any]:
        now = _now()
        with self._lock:
            row = self._db.execute("SELECT value, updated_utc FROM prefs WHERE key=?", (key,)).fetchone()
            if row is not None and row[0] == value:
                return {"value": value, "updatedAt": row[1]}  # nothing changed: the old time stands, so other devices see no change
            if row is None:
                if value is None:
                    return {"value": None, "updatedAt": now}  # removing what was never stored needs no row
                n = self._db.execute("SELECT COUNT(*) FROM prefs").fetchone()[0]
                if n >= MAX_KEYS:
                    raise PreferenceError(f"at most {MAX_KEYS} preferences are kept")
                self._db.execute("INSERT INTO prefs VALUES (?,?,?)", (key, value, now))
            else:
                self._db.execute("UPDATE prefs SET value=?, updated_utc=? WHERE key=?", (value, now, key))
            self._db.execute("INSERT INTO pref_history (key, value, at_utc) VALUES (?,?,?)", (key, value, now))
            self._db.commit()
        return {"value": value, "updatedAt": now}
