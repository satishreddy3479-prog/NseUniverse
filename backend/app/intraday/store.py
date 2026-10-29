"""Append-only ledger of intraday sentiment snapshots (data/intraday.sqlite3).

One row per (expiry, observation sample, scoring version): the score is recorded when it is computed
during the session, before anything about the rest of the day is known, so it can be evaluated
against later prices. Rows are never updated or deleted (SQLite triggers enforce it).
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  computed_utc TEXT NOT NULL,
  session TEXT NOT NULL,
  expiry TEXT NOT NULL,
  sample_id INTEGER NOT NULL,
  sample_utc TEXT NOT NULL,
  version TEXT NOT NULL,
  spot REAL,
  score REAL,
  label TEXT NOT NULL,
  coverage REAL NOT NULL,
  regime TEXT,
  volatility TEXT,
  components TEXT NOT NULL,
  UNIQUE (expiry, sample_id, version)
);
CREATE INDEX IF NOT EXISTS ix_scores_session ON scores(session, expiry);
CREATE TABLE IF NOT EXISTS daily_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_utc TEXT NOT NULL,
  session TEXT NOT NULL,
  expiry TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  samples INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (session, expiry, version)
);
CREATE TABLE IF NOT EXISTS feature_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,
  expiry TEXT NOT NULL,
  sample_utc TEXT NOT NULL,
  version TEXT NOT NULL,
  spot REAL NOT NULL,
  features TEXT NOT NULL,
  labels TEXT NOT NULL,
  UNIQUE (session, expiry, sample_utc, version)
);
CREATE INDEX IF NOT EXISTS ix_feature_rows_session ON feature_rows(session, expiry);
CREATE TRIGGER IF NOT EXISTS feature_rows_no_update BEFORE UPDATE ON feature_rows
  BEGIN SELECT RAISE(ABORT, 'stored feature rows are never changed'); END;
CREATE TRIGGER IF NOT EXISTS feature_rows_no_delete BEFORE DELETE ON feature_rows
  BEGIN SELECT RAISE(ABORT, 'stored feature rows are never deleted'); END;
CREATE TRIGGER IF NOT EXISTS summaries_no_update BEFORE UPDATE ON daily_summaries
  BEGIN SELECT RAISE(ABORT, 'stored summaries are never changed'); END;
CREATE TRIGGER IF NOT EXISTS summaries_no_delete BEFORE DELETE ON daily_summaries
  BEGIN SELECT RAISE(ABORT, 'stored summaries are never deleted'); END;
CREATE TRIGGER IF NOT EXISTS scores_no_update BEFORE UPDATE ON scores
  BEGIN SELECT RAISE(ABORT, 'stored scores are never changed'); END;
CREATE TRIGGER IF NOT EXISTS scores_no_delete BEFORE DELETE ON scores
  BEGIN SELECT RAISE(ABORT, 'stored scores are never deleted'); END;
"""


class IntradayStore:
    def __init__(self, data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "intraday.sqlite3"
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def record(self, row: dict[str, Any], now: datetime | None = None) -> bool:
        """Insert once; a second call for the same sample and version is ignored. True if stored."""
        with self._lock:
            cur = self._db.execute(
                "INSERT OR IGNORE INTO scores (computed_utc, session, expiry, sample_id, sample_utc, version,"
                " spot, score, label, coverage, regime, volatility, components)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    (now or datetime.now(UTC)).isoformat(), row["session"], row["expiry"], row["sample_id"],
                    row["sample_utc"], row["version"], row["spot"], row["score"], row["label"], row["coverage"],
                    row["regime"], row["volatility"], json.dumps(row["components"], separators=(",", ":")),
                ),
            )  # fmt: skip
            self._db.commit()
            return cur.rowcount > 0

    def record_summary(self, session: str, expiry: str, version: str, status: str, samples: int, payload: dict[str, Any], now: datetime | None = None) -> bool:
        """Store one end-of-day summary; a second call for the same session/expiry/version is ignored."""
        with self._lock:
            cur = self._db.execute(
                "INSERT OR IGNORE INTO daily_summaries (created_utc, session, expiry, version, status, samples, payload)"
                " VALUES (?,?,?,?,?,?,?)",
                ((now or datetime.now(UTC)).isoformat(), session, expiry, version, status, samples, json.dumps(payload, separators=(",", ":"))),
            )
            self._db.commit()
            return cur.rowcount > 0

    def record_features(self, session: str, expiry: str, version: str, rows: list[dict[str, Any]]) -> int:
        """Store a finished session's rows in one transaction; rows that already exist are ignored."""
        with self._lock:
            before = self._db.total_changes
            self._db.executemany(
                "INSERT OR IGNORE INTO feature_rows (session, expiry, sample_utc, version, spot, features, labels)"
                " VALUES (?,?,?,?,?,?,?)",
                [(session, expiry, r["sample_utc"], version, r["spot"], json.dumps(r["features"], separators=(",", ":")), json.dumps(r["labels"], separators=(",", ":"))) for r in rows],
            )
            self._db.commit()
            return self._db.total_changes - before

    def feature_sessions(self, version: str) -> dict[str, int]:
        """Session -> number of stored feature rows (best expiry), for readiness and status."""
        with self._lock:
            rows = self._db.execute(
                "SELECT session, expiry, COUNT(*) FROM feature_rows WHERE version=? GROUP BY session, expiry", (version,)
            ).fetchall()
        out: dict[str, int] = {}
        for sess, _, n in rows:
            out[sess] = max(out.get(sess, 0), int(n))
        return out

    def feature_session_rows(self, version: str) -> dict[str, tuple[str, list[tuple[str, dict[str, Any]]]]]:
        """session -> (expiry with the most rows, [(sample_utc, features)]) for one feature version."""
        with self._lock:
            best = {}
            for sess, exp, n in self._db.execute("SELECT session, expiry, COUNT(*) FROM feature_rows WHERE version=? GROUP BY session, expiry", (version,)).fetchall():
                if sess not in best or n > best[sess][1]:
                    best[sess] = (exp, n)
            out = {}
            for sess, (exp, _) in best.items():
                rows = self._db.execute("SELECT sample_utc, features FROM feature_rows WHERE session=? AND expiry=? AND version=? ORDER BY sample_utc", (sess, exp, version)).fetchall()
                out[sess] = (exp, [(a, json.loads(b)) for a, b in rows])
        return out

    def summaries(self, limit: int = 60) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT session, expiry, version, status, samples, payload, created_utc FROM daily_summaries"
                " ORDER BY session DESC, expiry LIMIT ?",
                (limit,),
            ).fetchall()
        return [{"session": a, "expiry": b, "version": c, "status": d, "samples": e, **json.loads(f), "created_utc": g} for a, b, c, d, e, f, g in rows]

    def session_rows(self, session: str, expiry: str, limit: int = 500) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT computed_utc, sample_utc, version, spot, score, label, coverage, regime, volatility, components"
                " FROM scores WHERE session=? AND expiry=? ORDER BY sample_utc DESC LIMIT ?",
                (session, expiry, limit),
            ).fetchall()
        keys = (
            "computed_utc",
            "sample_utc",
            "version",
            "spot",
            "score",
            "label",
            "coverage",
            "regime",
            "volatility",
            "components",
        )
        out = [dict(zip(keys, r, strict=True)) for r in reversed(rows)]
        for r in out:
            r["components"] = json.loads(r["components"])
        return out

    def last_before(self, expiry: str, sample_utc: str, version: str) -> dict[str, Any] | None:
        with self._lock:
            r = self._db.execute(
                "SELECT sample_utc, score, label, components FROM scores WHERE expiry=? AND version=? AND sample_utc<?"
                " ORDER BY sample_utc DESC LIMIT 1",
                (expiry, version, sample_utc),
            ).fetchone()
        if r is None:
            return None
        return {"sample_utc": r[0], "score": r[1], "label": r[2], "components": json.loads(r[3])}

    def count(self) -> int:
        with self._lock:
            return int(self._db.execute("SELECT COUNT(*) FROM scores").fetchone()[0])
