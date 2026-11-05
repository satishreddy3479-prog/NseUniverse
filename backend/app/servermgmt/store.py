"""The Server Management Centre's own SQLite database (``server_mgmt.sqlite3`` in the data directory).

Separate from the trading stores on purpose: it is bounded by retention, may be pruned, and nothing in it is evidence
the trading side depends on. Every measurement keeps its status; a failed collection is a row with ``status =
'failed'`` and no numbers, never a zero.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from app.servermgmt import config as cfg

SCHEMA = """
CREATE TABLE IF NOT EXISTS metric_samples (
  id INTEGER PRIMARY KEY, ts_utc TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
  cpu_pct REAL, load1 REAL, load5 REAL, load15 REAL,
  mem_total INTEGER, mem_avail INTEGER, swap_total INTEGER, swap_used INTEGER,
  disk_total INTEGER, disk_used INTEGER, disk_avail INTEGER,
  net_rx INTEGER, net_tx INTEGER, io_read INTEGER, io_write INTEGER, app_rss INTEGER, collect_ms REAL);
CREATE INDEX IF NOT EXISTS ix_metric_ts ON metric_samples(ts_utc);
CREATE TABLE IF NOT EXISTS storage_snapshots (
  id INTEGER PRIMARY KEY, snapshot_date TEXT NOT NULL, kind TEXT NOT NULL, ts_utc TEXT NOT NULL,
  status TEXT NOT NULL, method TEXT NOT NULL, error TEXT,
  fs_total INTEGER, fs_used INTEGER, fs_avail INTEGER,
  nse_bytes INTEGER, nse_alloc INTEGER, files INTEGER, dirs INTEGER, duration_s REAL, own_db_bytes INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS ux_daily ON storage_snapshots(snapshot_date) WHERE kind = 'daily';
CREATE INDEX IF NOT EXISTS ix_snap_date ON storage_snapshots(snapshot_date, ts_utc);
CREATE TABLE IF NOT EXISTS storage_dirs (
  snapshot_id INTEGER NOT NULL REFERENCES storage_snapshots(id) ON DELETE CASCADE,
  area TEXT NOT NULL, name TEXT NOT NULL, bytes INTEGER NOT NULL, alloc INTEGER NOT NULL, files INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, area, name));
CREATE TABLE IF NOT EXISTS file_inventory (
  snapshot_id INTEGER NOT NULL REFERENCES storage_snapshots(id) ON DELETE CASCADE,
  area TEXT NOT NULL, rel_path TEXT NOT NULL, size INTEGER NOT NULL, mtime_utc TEXT, cls TEXT NOT NULL, protected INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, area, rel_path));
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, started_utc TEXT NOT NULL, finished_utc TEXT, status TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL, level TEXT NOT NULL, title TEXT NOT NULL, detail TEXT,
  first_utc TEXT NOT NULL, last_utc TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, resolved_utc TEXT);
CREATE INDEX IF NOT EXISTS ix_alert_key ON alerts(key, resolved_utc);
CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY, ts_utc TEXT NOT NULL, actor TEXT NOT NULL, op TEXT NOT NULL, target TEXT, mode TEXT NOT NULL,
  status TEXT NOT NULL, detail TEXT, verification TEXT);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class MgmtStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = Path(data_dir) / "server_mgmt.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(self.path, check_same_thread=False, timeout=15)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.executescript(SCHEMA)
        self._db.commit()

    # ------------------------------------------------------------ plumbing
    def q(self, sql: str, args: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(r) for r in self._db.execute(sql, args).fetchall()]

    def one(self, sql: str, args: tuple[Any, ...] = ()) -> dict[str, Any] | None:
        r = self.q(sql, args)
        return r[0] if r else None

    def x(self, sql: str, args: tuple[Any, ...] = ()) -> int:
        with self._lock:
            cur = self._db.execute(sql, args)
            self._db.commit()
            return cur.lastrowid or cur.rowcount

    def size_bytes(self) -> int:
        total = 0
        for suffix in ("", "-wal", "-shm"):
            p = Path(str(self.path) + suffix)
            if p.exists():
                total += p.stat().st_size
        return total

    # ------------------------------------------------------------ config
    def config(self) -> dict[str, Any]:
        stored = {r["key"]: json.loads(r["value"]) for r in self.q("SELECT key, value FROM config")}
        return {**cfg.defaults(), **{k: v for k, v in stored.items() if k in cfg.SCHEMA or k in cfg.LISTS}}

    def set_config(self, changes: dict[str, Any]) -> dict[str, Any]:
        clean = cfg.validate(changes, self.config())
        for k, v in clean.items():
            self.x("INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, json.dumps(v)))
        return self.config()

    # ------------------------------------------------------------ samples
    def add_sample(self, row: dict[str, Any]) -> int:
        cols = [c for c in row if c != "id"]
        return self.x(f"INSERT INTO metric_samples({','.join(cols)}) VALUES({','.join('?' * len(cols))})", tuple(row[c] for c in cols))  # noqa: S608 - column names are ours

    # ------------------------------------------------------------ snapshots
    def add_snapshot(self, snap: dict[str, Any], dirs: list[dict[str, Any]], files: list[dict[str, Any]]) -> int | None:
        """Insert one snapshot with its directory rows and file inventory. A second daily snapshot for the same IST date
        is not inserted (returns None): the logical key of a daily snapshot is its date."""
        with self._lock:
            try:
                cols = list(snap)
                cur = self._db.execute(f"INSERT INTO storage_snapshots({','.join(cols)}) VALUES({','.join('?' * len(cols))})", tuple(snap[c] for c in cols))  # noqa: S608
            except sqlite3.IntegrityError:
                self._db.rollback()
                return None
            sid = cur.lastrowid
            self._db.executemany("INSERT INTO storage_dirs VALUES(?,?,?,?,?,?)", [(sid, d["area"], d["name"], d["bytes"], d["alloc"], d["files"]) for d in dirs])
            self._db.executemany("INSERT INTO file_inventory VALUES(?,?,?,?,?,?,?)", [(sid, f["area"], f["rel_path"], f["size"], f["mtime_utc"], f["cls"], int(f["protected"])) for f in files])
            self._db.commit()
            return sid

    def snapshot(self, sid: int) -> dict[str, Any] | None:
        return self.one("SELECT * FROM storage_snapshots WHERE id=?", (sid,))

    def dirs(self, sid: int) -> list[dict[str, Any]]:
        return self.q("SELECT area, name, bytes, alloc, files FROM storage_dirs WHERE snapshot_id=? ORDER BY bytes DESC", (sid,))

    def files(self, sid: int) -> list[dict[str, Any]]:
        return self.q("SELECT area, rel_path, size, mtime_utc, cls, protected FROM file_inventory WHERE snapshot_id=? ORDER BY size DESC", (sid,))

    def daily(self) -> list[dict[str, Any]]:
        """One row per IST date: the daily snapshot if there is one, else the newest other snapshot of that date."""
        return self.q(
            "SELECT * FROM storage_snapshots s WHERE id = (SELECT id FROM storage_snapshots t WHERE t.snapshot_date = s.snapshot_date "
            "ORDER BY (t.kind = 'daily') DESC, t.ts_utc DESC LIMIT 1) ORDER BY snapshot_date"
        )

    # ------------------------------------------------------------ runs, alerts, audit
    def run_start(self, kind: str) -> int:
        return self.x("INSERT INTO runs(kind, started_utc, status) VALUES(?, ?, 'running')", (kind, now_iso()))

    def run_end(self, rid: int, status: str, detail: str | None = None) -> None:
        self.x("UPDATE runs SET finished_utc=?, status=?, detail=? WHERE id=?", (now_iso(), status, (detail or "")[:500], rid))

    def audit(self, actor: str, op: str, target: str | None, mode: str, status: str, detail: str | None = None, verification: str | None = None) -> int:
        return self.x(
            "INSERT INTO operations(ts_utc, actor, op, target, mode, status, detail, verification) VALUES(?,?,?,?,?,?,?,?)",
            (now_iso(), actor[:80], op, (target or "")[:300], mode, status, (detail or "")[:1000], (verification or "")[:500]),
        )

    def raise_alert(self, key: str, level: str, title: str, detail: str) -> None:
        """One open alert per key: a repeat updates its count and time, a level change updates the level."""
        cur = self.one("SELECT id, level FROM alerts WHERE key=? AND resolved_utc IS NULL", (key,))
        if cur is None:
            self.x("INSERT INTO alerts(key, level, title, detail, first_utc, last_utc) VALUES(?,?,?,?,?,?)", (key, level, title, detail[:500], now_iso(), now_iso()))
        else:
            self.x("UPDATE alerts SET level=?, title=?, detail=?, last_utc=?, count=count+1 WHERE id=?", (level, title, detail[:500], now_iso(), cur["id"]))

    def resolve_alerts(self, keep: set[str], prefix: str) -> None:
        """Close open alerts of this family whose key is no longer raised."""
        for a in self.q("SELECT id, key FROM alerts WHERE resolved_utc IS NULL AND key LIKE ?", (prefix + "%",)):
            if a["key"] not in keep:
                self.x("UPDATE alerts SET resolved_utc=? WHERE id=?", (now_iso(), a["id"]))

    # ------------------------------------------------------------ retention
    def prune(self, preview: bool = False) -> dict[str, int]:
        c = self.config()

        def cutoff(days: float) -> str:
            return (datetime.now(UTC) - timedelta(days=days)).isoformat(timespec="seconds")

        plan = {
            "metric_samples": ("SELECT COUNT(*) n FROM metric_samples WHERE ts_utc < ?", "DELETE FROM metric_samples WHERE ts_utc < ?", cutoff(c["metrics_retention_days"])),
            "file_inventory": ("SELECT COUNT(*) n FROM file_inventory WHERE snapshot_id IN (SELECT id FROM storage_snapshots WHERE ts_utc < ?)", "DELETE FROM file_inventory WHERE snapshot_id IN (SELECT id FROM storage_snapshots WHERE ts_utc < ?)", cutoff(c["inventory_retention_days"])),
            "storage_snapshots": ("SELECT COUNT(*) n FROM storage_snapshots WHERE ts_utc < ?", "DELETE FROM storage_snapshots WHERE ts_utc < ?", cutoff(c["snapshot_retention_days"])),
            "runs": ("SELECT COUNT(*) n FROM runs WHERE started_utc < ?", "DELETE FROM runs WHERE started_utc < ?", cutoff(c["audit_retention_days"])),
            "alerts": ("SELECT COUNT(*) n FROM alerts WHERE resolved_utc IS NOT NULL AND last_utc < ?", "DELETE FROM alerts WHERE resolved_utc IS NOT NULL AND last_utc < ?", cutoff(c["audit_retention_days"])),
        }
        out: dict[str, int] = {}
        for name, (count_sql, del_sql, cut) in plan.items():
            n = int((self.one(count_sql, (cut,)) or {"n": 0})["n"])
            out[name] = n
            if not preview and n:
                self.x(del_sql, (cut,))
        return out
