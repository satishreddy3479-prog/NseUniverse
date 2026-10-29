"""Local snapshot storage: JSON files + a SQLite index (stdlib only).

Layout under DATA_DIR:
  index.sqlite3                          sessions + snapshot index
  snapshots/YYYY-MM-DD/<snapshot_id>.json.gz      normalized snapshot (gzip)
  snapshots/YYYY-MM-DD/<snapshot_id>.raw.json.gz  verbatim broker payload (scrubbed, gzip)
  (snapshots written by earlier builds are plain .json / .raw.json and are still read)
  exports/<snapshot_id>.csv              on-demand CSV export

Files are created with exclusive mode ('x'); nothing is ever overwritten.
Storage knows nothing about the broker or the UI.
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import sqlite3
import threading
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.domain.models import OptionChainSnapshot, SnapshotSummary

_SENSITIVE_KEYS = {
    "token",
    "sid",
    "rid",
    "auth",
    "authorization",
    "consumer_key",
    "mpin",
    "totp",
    "password",
    "secret",
    "access_token",
}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  data_mode TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  underlying TEXT NOT NULL,
  expiry TEXT NOT NULL,
  source TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  completeness TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  file_ref TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_snap_lookup ON snapshots(underlying, expiry, retrieved_at);
"""


class StorageError(Exception):
    pass


def scrub(obj: Any) -> Any:
    """Recursively drop credential-like keys from a payload before persisting it."""
    if isinstance(obj, Mapping):
        return {k: scrub(v) for k, v in obj.items() if str(k).lower() not in _SENSITIVE_KEYS}
    if isinstance(obj, list):
        return [scrub(v) for v in obj]
    return obj


class SnapshotStore:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.snap_dir = data_dir / "snapshots"
        self.export_dir = data_dir / "exports"
        self.snap_dir.mkdir(parents=True, exist_ok=True)
        self.export_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(data_dir / "index.sqlite3", check_same_thread=False)
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # --- sessions -------------------------------------------------------------
    def start_session(self, session_id: str, data_mode: str) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO sessions(session_id, started_at, data_mode) VALUES (?,?,?)",
                (session_id, datetime.now(UTC).isoformat(), data_mode),
            )
            self._db.commit()

    def end_session(self, session_id: str) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE sessions SET ended_at=? WHERE session_id=?",
                (datetime.now(UTC).isoformat(), session_id),
            )
            self._db.commit()

    def list_sessions(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            cur = self._db.execute(
                "SELECT s.session_id, s.started_at, s.ended_at, s.data_mode, "
                "(SELECT COUNT(*) FROM snapshots n WHERE n.session_id=s.session_id) "
                "FROM sessions s WHERE s.data_mode != 'mock' ORDER BY s.started_at DESC LIMIT ?",
                (limit,),
            )
            rows = cur.fetchall()
        return [
            {
                "session_id": r[0],
                "started_at": r[1],
                "ended_at": r[2],
                "data_mode": r[3],
                "snapshot_count": r[4],
            }
            for r in rows
        ]

    # --- snapshots ------------------------------------------------------------
    def save(self, snap: OptionChainSnapshot, raw: Mapping[str, Any]) -> SnapshotSummary:
        day = snap.retrieved_at.astimezone(UTC).strftime("%Y-%m-%d")
        folder = self.snap_dir / day
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{snap.snapshot_id}.json.gz"
        raw_path = folder / f"{snap.snapshot_id}.raw.json.gz"
        file_ref = path.relative_to(self.data_dir).as_posix()
        summary = snap.summary(file_ref)
        try:
            # JSON compresses about 8x; a day of one-minute captures stays in the tens of MB.
            with gzip.open(path, "xt", encoding="utf-8", compresslevel=6) as f:
                f.write(snap.model_dump_json())
            with gzip.open(raw_path, "xt", encoding="utf-8", compresslevel=6) as f:
                json.dump(scrub(raw), f, default=str)
            with self._lock:
                self._db.execute(
                    "INSERT INTO snapshots VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        snap.snapshot_id,
                        snap.session_id,
                        snap.underlying,
                        snap.expiry.isoformat(),
                        snap.source.value,
                        snap.retrieved_at.isoformat(),
                        snap.completeness.value,
                        summary.model_dump_json(),
                        file_ref,
                    ),
                )
                self._db.commit()
        except FileExistsError as e:
            raise StorageError(f"snapshot {snap.snapshot_id} already exists") from e
        except OSError as e:
            raise StorageError(f"failed to write snapshot: {type(e).__name__}") from e
        return summary

    def list(
        self, *, underlying: str | None = None, expiry: str | None = None, limit: int = 50
    ) -> list[SnapshotSummary]:
        # Rows written by early demo builds (source 'mock') are never read or shown.
        q = "SELECT summary_json FROM snapshots WHERE source != 'mock'"
        args: list[Any] = []
        if underlying:
            q += " AND underlying=?"
            args.append(underlying)
        if expiry:
            q += " AND expiry=?"
            args.append(expiry)
        q += " ORDER BY retrieved_at DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self._db.execute(q, args).fetchall()
        return [SnapshotSummary.model_validate_json(r[0]) for r in rows]

    def latest(
        self, underlying: str, expiry: str, *, prefer_non_empty: bool = True
    ) -> OptionChainSnapshot | None:
        """Newest snapshot for the expiry. An empty (failed-parse) snapshot never hides an
        earlier usable one; it is returned only when nothing better exists."""
        items = self.list(underlying=underlying, expiry=expiry, limit=200)
        if prefer_non_empty:
            good = [i for i in items if i.completeness.value != "empty"]
            if good:
                items = good
        return self.load(items[0].snapshot_id) if items else None

    def load(self, snapshot_id: str) -> OptionChainSnapshot | None:
        with self._lock:
            row = self._db.execute(
                "SELECT file_ref FROM snapshots WHERE snapshot_id=? AND source != 'mock'",
                (snapshot_id,),
            ).fetchone()
        if not row:
            return None
        path = (self.data_dir / row[0]).resolve()
        if self.data_dir.resolve() not in path.parents:
            raise StorageError("snapshot path escapes data dir")
        try:
            if path.suffix == ".gz":
                with gzip.open(path, "rt", encoding="utf-8") as f:
                    return OptionChainSnapshot.model_validate_json(f.read())
            return OptionChainSnapshot.model_validate_json(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None  # removed by the approved retention policy (the day stays in the archive)
        except (OSError, EOFError) as e:
            raise StorageError(f"failed to read snapshot: {type(e).__name__}") from e

    @staticmethod
    def to_csv(snap: OptionChainSnapshot) -> str:
        cols = [
            "ltp",
            "prev_close",
            "volume",
            "oi",
            "oi_change",
            "oi_change_pct",
            "trading_symbol",
            "instrument_token",
        ]
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(
            ["underlying", "expiry", "retrieved_at_utc", "source", "strike"]
            + [f"ce_{c}" for c in cols]
            + [f"pe_{c}" for c in cols]
        )
        for r in snap.rows:

            def vals(q: Any) -> list[Any]:
                return ["" if q is None or getattr(q, c) is None else getattr(q, c) for c in cols]

            w.writerow(
                [
                    snap.underlying,
                    snap.expiry.isoformat(),
                    snap.retrieved_at.isoformat(),
                    snap.source.value,
                    r.strike,
                ]
                + vals(r.call)
                + vals(r.put)
            )
        return buf.getvalue()
