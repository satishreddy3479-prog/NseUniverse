"""Stored NSE institutional-flow data. Raw files are kept gzip-compressed and never changed."""

from __future__ import annotations

import gzip
import hashlib
import json
import sqlite3
import threading
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS raw_files (
  kind TEXT NOT NULL, session TEXT NOT NULL, url TEXT NOT NULL, sha256 TEXT NOT NULL,
  body BLOB NOT NULL, first_seen_utc TEXT NOT NULL, PRIMARY KEY (kind, session)
);
CREATE TABLE IF NOT EXISTS participant (
  kind TEXT NOT NULL, session TEXT NOT NULL, participant TEXT NOT NULL, metrics TEXT NOT NULL,
  PRIMARY KEY (kind, session, participant)
);
CREATE TABLE IF NOT EXISTS cash_flows (
  session TEXT NOT NULL, category TEXT NOT NULL, buy REAL NOT NULL, sell REAL NOT NULL, net REAL NOT NULL,
  first_seen_utc TEXT NOT NULL, PRIMARY KEY (session, category)
);
CREATE TABLE IF NOT EXISTS rejected_files (
  kind TEXT NOT NULL, session TEXT NOT NULL, reason TEXT NOT NULL, body BLOB NOT NULL, at_utc TEXT NOT NULL,
  PRIMARY KEY (kind, session)
);
CREATE TABLE IF NOT EXISTS attempts (
  kind TEXT NOT NULL, session TEXT NOT NULL, status INTEGER NOT NULL, note TEXT, at_utc TEXT NOT NULL,
  PRIMARY KEY (kind, session)
);
CREATE TABLE IF NOT EXISTS runs (
  component TEXT NOT NULL, at_utc TEXT NOT NULL, trigger TEXT NOT NULL, ok INTEGER NOT NULL,
  newest_session TEXT, note TEXT
);
CREATE TRIGGER IF NOT EXISTS raw_no_update BEFORE UPDATE ON raw_files BEGIN SELECT RAISE(ABORT, 'raw files are never changed'); END;
CREATE TRIGGER IF NOT EXISTS raw_no_delete BEFORE DELETE ON raw_files BEGIN SELECT RAISE(ABORT, 'raw files are never deleted'); END;
CREATE TRIGGER IF NOT EXISTS part_no_update BEFORE UPDATE ON participant BEGIN SELECT RAISE(ABORT, 'stored values are never changed'); END;
CREATE TRIGGER IF NOT EXISTS cash_no_update BEFORE UPDATE ON cash_flows BEGIN SELECT RAISE(ABORT, 'stored values are never changed'); END;
"""


class FlowsStore:
    def __init__(self, data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "nse_flows.sqlite3"
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def record_attempt(self, kind: str, session: date, status: int, note: str | None = None, now: datetime | None = None) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO attempts VALUES (?,?,?,?,?)",
                (kind, str(session), status, note, (now or datetime.now(UTC)).isoformat()),
            )
            self._db.commit()

    def save_rejected(self, kind: str, session: date, reason: str, body: bytes, now: datetime | None = None) -> None:
        """Keep a file that failed validation (compressed) so the failure can be inspected, never used."""
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO rejected_files VALUES (?,?,?,?,?)",
                (kind, str(session), reason, gzip.compress(body), (now or datetime.now(UTC)).isoformat()),
            )
            self._db.commit()

    def latest_participants(self, kind: str, limit: int = 15) -> list[dict[str, Any]]:
        with self._lock:
            days = [r[0] for r in self._db.execute("SELECT DISTINCT session FROM participant WHERE kind=? ORDER BY session DESC LIMIT ?", (kind, limit))]
        rows = self.participant_rows(kind)
        return [{"session": d, "participants": {p: m for p, m in rows[date.fromisoformat(d)].items() if p != "TOTAL"}} for d in days if date.fromisoformat(d) in rows]

    def record_run(self, component: str, trigger: str, ok: bool, newest_session: str | None, note: str | None, now: datetime | None = None) -> None:
        """One check of one data source: when, auto or manual, whether it worked, and what it found."""
        with self._lock:
            self._db.execute("INSERT INTO runs VALUES (?,?,?,?,?,?)", (component, (now or datetime.now(UTC)).isoformat(), trigger, 1 if ok else 0, newest_session, note))
            self._db.commit()

    def last_runs(self) -> dict[str, dict[str, Any]]:
        """Per component: the last attempt, the last successful automatic check and the last successful manual one."""
        out: dict[str, dict[str, Any]] = {}
        with self._lock:
            comps = [r[0] for r in self._db.execute("SELECT DISTINCT component FROM runs")]
            for c in comps:
                out[c] = {
                    "last": self._last_run(c, ""),
                    "last_auto_ok": self._last_run(c, "AND ok=1 AND trigger='auto'"),
                    "last_manual_ok": self._last_run(c, "AND ok=1 AND trigger='manual'"),
                }
        return out

    def _last_run(self, component: str, where: str) -> dict[str, Any] | None:
        r = self._db.execute(f"SELECT at_utc, trigger, ok, newest_session, note FROM runs WHERE component=? {where} ORDER BY at_utc DESC LIMIT 1", (component,)).fetchone()  # noqa: S608 - fixed fragments only
        return None if r is None else {"at": r[0], "trigger": r[1], "ok": bool(r[2]), "newest_session": r[3], "note": r[4]}

    def attempted(self, kind: str, session: date) -> int | None:
        with self._lock:
            r = self._db.execute("SELECT status FROM attempts WHERE kind=? AND session=?", (kind, str(session))).fetchone()
        return None if r is None else int(r[0])

    def save_participant(self, kind: str, session: date, url: str, body: bytes, parsed: dict[str, dict[str, int]], now: datetime | None = None) -> bool:
        stamp = (now or datetime.now(UTC)).isoformat()
        with self._lock:
            if self._db.execute("SELECT 1 FROM raw_files WHERE kind=? AND session=?", (kind, str(session))).fetchone():
                return False
            self._db.execute(
                "INSERT INTO raw_files VALUES (?,?,?,?,?,?)",
                (kind, str(session), url, hashlib.sha256(body).hexdigest(), gzip.compress(body), stamp),
            )
            for p, m in parsed.items():
                self._db.execute("INSERT INTO participant VALUES (?,?,?,?)", (kind, str(session), p, json.dumps(m)))
            self._db.commit()
        return True

    def save_cash(self, rows: list[dict[str, Any]], now: datetime | None = None) -> int:
        stamp = (now or datetime.now(UTC)).isoformat()
        n = 0
        with self._lock:
            for r in rows:
                cur = self._db.execute(
                    "INSERT OR IGNORE INTO cash_flows VALUES (?,?,?,?,?,?)",
                    (str(r["session"]), r["category"], r["buy"], r["sell"], r["net"], stamp),
                )
                n += cur.rowcount
            self._db.commit()
        return n

    def prune_participant(self, keep_sessions: int = 7, backup_dir: Path | None = None) -> dict[str, int]:
        """Rolling window for the participant files: keep the newest sessions per kind, delete older ones.

        This is the only sanctioned deletion of stored participant data. The first time it would delete
        anything it writes a verified backup copy of the whole database into ``backup_dir`` (kept).
        """
        with self._lock:
            kinds = [r[0] for r in self._db.execute("SELECT DISTINCT kind FROM raw_files")]
            cut: dict[str, str] = {}
            for k in kinds:
                days = [r[0] for r in self._db.execute("SELECT session FROM raw_files WHERE kind=? ORDER BY session DESC", (k,))]
                if len(days) > keep_sessions:
                    cut[k] = days[keep_sessions - 1]
            if not cut:
                return {"deleted_files": 0, "backup": 0}
            made = 0
            if backup_dir is not None:
                backup_dir.mkdir(parents=True, exist_ok=True)
                dest = backup_dir / f"nse_flows_before_prune_{datetime.now(UTC):%Y%m%d}.sqlite3"
                if not dest.exists():
                    out = sqlite3.connect(dest)
                    self._db.backup(out)
                    ok = out.execute("PRAGMA quick_check").fetchone()[0] == "ok"
                    out.close()
                    if not ok:
                        dest.unlink(missing_ok=True)
                        raise RuntimeError("backup failed its integrity check; nothing was deleted")
                    made = 1
            n = 0
            self._db.execute("DROP TRIGGER IF EXISTS raw_no_delete")
            try:
                for k, c in cut.items():
                    self._db.execute("DELETE FROM participant WHERE kind=? AND session < ?", (k, c))
                    n += self._db.execute("DELETE FROM raw_files WHERE kind=? AND session < ?", (k, c)).rowcount
                    self._db.execute("DELETE FROM rejected_files WHERE kind=? AND session < ?", (k, c))
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise
            finally:
                self._db.executescript("CREATE TRIGGER IF NOT EXISTS raw_no_delete BEFORE DELETE ON raw_files BEGIN SELECT RAISE(ABORT, 'raw files are never deleted'); END;")
        return {"deleted_files": n, "backup": made}

    def prune_cash(self, keep_sessions: int = 7) -> int:
        """Rolling window: keep the newest ``keep_sessions`` sessions of cash activity, delete older ones."""
        with self._lock:
            days = [r[0] for r in self._db.execute("SELECT DISTINCT session FROM cash_flows ORDER BY session DESC")]
            if len(days) <= keep_sessions:
                return 0
            cutoff = days[keep_sessions - 1]
            n = self._db.execute("DELETE FROM cash_flows WHERE session < ?", (cutoff,)).rowcount
            self._db.commit()
        return n

    def cash_rows(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute("SELECT session, category, buy, sell, net FROM cash_flows ORDER BY session DESC, category").fetchall()
        return [{"session": s, "category": c, "buy": b, "sell": sl, "net": n} for s, c, b, sl, n in rows]

    def participant_rows(self, kind: str) -> dict[date, dict[str, dict[str, int]]]:
        out: dict[date, dict[str, dict[str, int]]] = {}
        with self._lock:
            rows = self._db.execute("SELECT session, participant, metrics FROM participant WHERE kind=? ORDER BY session", (kind,)).fetchall()
        for s, p, m in rows:
            out.setdefault(date.fromisoformat(s), {})[p] = json.loads(m)
        return out

    def coverage(self) -> dict[str, Any]:
        with self._lock:
            kinds = {}
            for k in ("fao_participant_oi", "fao_participant_vol"):
                r = self._db.execute("SELECT MIN(session), MAX(session), COUNT(*) FROM raw_files WHERE kind=?", (k,)).fetchone()
                miss = self._db.execute("SELECT COUNT(*) FROM attempts WHERE kind=? AND status=404", (k,)).fetchone()[0]
                last_seen = self._db.execute("SELECT MAX(first_seen_utc) FROM raw_files WHERE kind=?", (k,)).fetchone()[0]
                kinds[k] = {"first": r[0], "last": r[1], "files": r[2], "not_published_404": miss, "last_stored_utc": last_seen}
            r = self._db.execute("SELECT MIN(session), MAX(session), COUNT(DISTINCT session) FROM cash_flows").fetchone()
            seen = self._db.execute("SELECT MAX(first_seen_utc) FROM cash_flows").fetchone()[0]
            kinds["fii_dii_cash"] = {"first": r[0], "last": r[1], "files": r[2], "not_published_404": 0, "last_stored_utc": seen}
        return kinds
