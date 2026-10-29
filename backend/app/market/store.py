"""Append-only store for the market-breadth inputs and the minute samples (data/market.sqlite3).

Raw downloaded files are kept (gzip + sha256) so every constituent list and weight set can be traced to
the exact file it came from. Rows are never updated or deleted (SQLite triggers enforce it).
"""

from __future__ import annotations

import gzip
import hashlib
import json
import sqlite3
import threading
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from app.market.sources import BhavRow, Constituent, TokenInfo

_SCHEMA = """
CREATE TABLE IF NOT EXISTS raw_files (
  kind TEXT NOT NULL, fetched_utc TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, body BLOB NOT NULL,
  PRIMARY KEY (kind, sha256)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS constituents (
  index_name TEXT NOT NULL, list_sha TEXT NOT NULL, fetched_utc TEXT NOT NULL,
  symbol TEXT NOT NULL, name TEXT NOT NULL, industry TEXT NOT NULL, isin TEXT NOT NULL,
  PRIMARY KEY (index_name, list_sha, symbol)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bhav (
  session TEXT NOT NULL, symbol TEXT NOT NULL, prev_close REAL, close REAL, volume INTEGER, deliv_qty INTEGER,
  PRIMARY KEY (session, symbol)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS weights (
  index_name TEXT NOT NULL, as_of TEXT NOT NULL, source TEXT NOT NULL, imported_utc TEXT NOT NULL,
  symbol TEXT NOT NULL, weight_pct REAL NOT NULL,
  PRIMARY KEY (index_name, as_of, source, symbol)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tokens (
  day TEXT NOT NULL, symbol TEXT NOT NULL, token TEXT NOT NULL, trading_symbol TEXT NOT NULL,
  PRIMARY KEY (day, symbol)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS samples (
  sample_utc TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (kind, sample_utc)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS daily (
  session TEXT NOT NULL, symbol TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL, volume INTEGER,
  PRIMARY KEY (session, symbol)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS list_changes (
  index_name TEXT NOT NULL, detected_utc TEXT NOT NULL, added TEXT NOT NULL, removed TEXT NOT NULL,
  PRIMARY KEY (index_name, detected_utc)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at_utc TEXT NOT NULL, kind TEXT NOT NULL, ok INTEGER NOT NULL, note TEXT
);
"""
_IMMUTABLE = (
    "raw_files",
    "constituents",
    "bhav",
    "weights",
    "tokens",
    "samples",
    "daily",
    "list_changes",
)


class MarketStore:
    def __init__(self, data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "market.sqlite3"
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(_SCHEMA)
        for t in _IMMUTABLE:
            self._db.executescript(
                f"CREATE TRIGGER IF NOT EXISTS {t}_no_update BEFORE UPDATE ON {t} BEGIN SELECT RAISE(ABORT, 'stored market data is never changed'); END;"
                f"CREATE TRIGGER IF NOT EXISTS {t}_no_delete BEFORE DELETE ON {t} BEGIN SELECT RAISE(ABORT, 'stored market data is never deleted'); END;"
            )
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ---------------------------------------------------------------- attempts
    def attempt(self, kind: str, ok: bool, note: str = "", now: datetime | None = None) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO attempts(at_utc, kind, ok, note) VALUES (?,?,?,?)",
                ((now or datetime.now(UTC)).isoformat(), kind, int(ok), note[:300]),
            )
            self._db.commit()

    def last_attempt(self, kind: str) -> dict[str, Any] | None:
        with self._lock:
            r = self._db.execute(
                "SELECT at_utc, ok, note FROM attempts WHERE kind=? ORDER BY id DESC LIMIT 1",
                (kind,),
            ).fetchone()
        return None if r is None else {"at": r[0], "ok": bool(r[1]), "note": r[2]}

    # ---------------------------------------------------------------- constituent lists
    def save_list(
        self, index: str, items: list[Constituent], raw: bytes, now: datetime | None = None
    ) -> bool:
        """Store a list when its file is new. Returns True if it was new."""
        sha = hashlib.sha256(raw).hexdigest()
        stamp = (now or datetime.now(UTC)).isoformat()
        with self._lock:
            if self._db.execute(
                "SELECT 1 FROM raw_files WHERE kind=? AND sha256=?", (index, sha)
            ).fetchone():
                return False
            self._db.execute(
                "INSERT INTO raw_files VALUES (?,?,?,?,?)",
                (index, stamp, sha, len(raw), gzip.compress(raw, mtime=0)),
            )
            self._db.executemany(
                "INSERT INTO constituents VALUES (?,?,?,?,?,?,?)",
                [(index, sha, stamp, c.symbol, c.name, c.industry, c.isin) for c in items],
            )
            self._db.commit()
        return True

    def current_list(self, index: str) -> tuple[list[Constituent], dict[str, str]] | None:
        with self._lock:
            r = self._db.execute(
                "SELECT list_sha, fetched_utc FROM constituents WHERE index_name=? ORDER BY fetched_utc DESC LIMIT 1",
                (index,),
            ).fetchone()
            if r is None:
                return None
            rows = self._db.execute(
                "SELECT symbol, name, industry, isin FROM constituents WHERE index_name=? AND list_sha=? ORDER BY symbol",
                (index, r[0]),
            ).fetchall()
        return [Constituent(*x) for x in rows], {"sha256": r[0], "fetched_utc": r[1]}

    # ---------------------------------------------------------------- bhavcopy
    def save_bhav(self, rows: list[BhavRow]) -> int:
        with self._lock:
            before = self._db.total_changes
            self._db.executemany(
                "INSERT OR IGNORE INTO bhav VALUES (?,?,?,?,?,?)",
                [
                    (r.session.isoformat(), r.symbol, r.prev_close, r.close, r.volume, r.deliv_qty)
                    for r in rows
                ],
            )
            self._db.executemany(
                "INSERT OR IGNORE INTO daily VALUES (?,?,?,?,?,?,?)",
                [
                    (r.session.isoformat(), r.symbol, r.open, r.high, r.low, r.close, r.volume)
                    for r in rows
                    if r.close is not None
                ],
            )
            self._db.commit()
            return self._db.total_changes - before

    def bhav_sessions(self) -> list[str]:
        with self._lock:
            return [
                r[0] for r in self._db.execute("SELECT DISTINCT session FROM bhav ORDER BY session")
            ]

    def daily_sessions(self) -> list[str]:
        with self._lock:
            return [
                r[0]
                for r in self._db.execute("SELECT DISTINCT session FROM daily ORDER BY session")
            ]

    def daily_bars(
        self, symbol: str, n: int = 80
    ) -> list[tuple[str, float | None, float | None, float | None, float | None, int | None]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT session, open, high, low, close, volume FROM daily WHERE symbol=? ORDER BY session DESC LIMIT ?",
                (symbol, n),
            ).fetchall()
        return list(reversed(rows))

    def last_traded_value(self, symbols: list[str]) -> dict[str, float]:
        """close x volume of the newest session for each symbol (a liquidity ranking, not an index weight)."""
        with self._lock:
            r = self._db.execute("SELECT MAX(session) FROM bhav").fetchone()
            if not r or r[0] is None:
                return {}
            rows = self._db.execute(
                "SELECT symbol, close, volume FROM bhav WHERE session=?", (r[0],)
            ).fetchall()
        want = set(symbols)
        return {s: float(c) * float(v) for s, c, v in rows if s in want and c and v}

    def avg_volume(
        self, symbols: list[str], sessions: int = 20, min_sessions: int = 10
    ) -> dict[str, float]:
        """Mean traded quantity over the newest ``sessions`` sessions, per symbol with >= ``min_sessions`` of them."""
        days = self.bhav_sessions()[-sessions:]
        if len(days) < min_sessions:
            return {}
        marks = ",".join("?" for _ in days)
        with self._lock:
            rows = self._db.execute(
                f"SELECT symbol, AVG(volume), COUNT(volume) FROM bhav WHERE session IN ({marks}) AND volume IS NOT NULL GROUP BY symbol",  # noqa: S608 - placeholders only
                days,
            ).fetchall()
        want = set(symbols)
        return {s: float(a) for s, a, n in rows if s in want and n >= min_sessions and a}

    # ---------------------------------------------------------------- weights
    def save_weights(
        self,
        index: str,
        weights: dict[str, float],
        as_of: date,
        source: str,
        now: datetime | None = None,
    ) -> int:
        stamp = (now or datetime.now(UTC)).isoformat()
        with self._lock:
            before = self._db.total_changes
            self._db.executemany(
                "INSERT OR IGNORE INTO weights VALUES (?,?,?,?,?,?)",
                [(index, as_of.isoformat(), source, stamp, s, w) for s, w in weights.items()],
            )
            self._db.commit()
            return self._db.total_changes - before

    def latest_weights(self, index: str) -> tuple[dict[str, float], str, str] | None:
        """(symbol -> weight %, as_of, source) of the newest weight set; official sources beat approximate ones of the same date."""
        with self._lock:
            r = self._db.execute(
                "SELECT as_of, source FROM weights WHERE index_name=? GROUP BY as_of, source ORDER BY (source LIKE 'approx%') ASC, as_of DESC, source DESC LIMIT 1",
                (index,),
            ).fetchone()
            if r is None:
                return None
            rows = self._db.execute(
                "SELECT symbol, weight_pct FROM weights WHERE index_name=? AND as_of=? AND source=?",
                (index, r[0], r[1]),
            ).fetchall()
        return {s: float(w) for s, w in rows}, r[0], r[1]

    # ---------------------------------------------------------------- tokens
    def save_tokens(self, tokens: dict[str, TokenInfo], day: date) -> int:
        with self._lock:
            before = self._db.total_changes
            self._db.executemany(
                "INSERT OR IGNORE INTO tokens VALUES (?,?,?,?)",
                [(day.isoformat(), t.symbol, t.token, t.trading_symbol) for t in tokens.values()],
            )
            self._db.commit()
            return self._db.total_changes - before

    def latest_tokens(self) -> tuple[dict[str, TokenInfo], str] | None:
        with self._lock:
            r = self._db.execute("SELECT MAX(day) FROM tokens").fetchone()
            if not r or r[0] is None:
                return None
            rows = self._db.execute(
                "SELECT symbol, token, trading_symbol FROM tokens WHERE day=?", (r[0],)
            ).fetchall()
        return {s: TokenInfo(s, t, ts) for s, t, ts in rows}, r[0]

    # ---------------------------------------------------------------- minute samples
    def record_sample(self, kind: str, sample_utc: str, payload: dict[str, Any]) -> bool:
        with self._lock:
            cur = self._db.execute(
                "INSERT OR IGNORE INTO samples VALUES (?,?,?)",
                (sample_utc, kind, json.dumps(payload, separators=(",", ":"), default=str)),
            )
            self._db.commit()
            return cur.rowcount > 0

    def recent_samples(self, kind: str, limit: int = 120) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT sample_utc, payload FROM samples WHERE kind=? ORDER BY sample_utc DESC LIMIT ?",
                (kind, limit),
            ).fetchall()
        return [{"sample_utc": a, **json.loads(b)} for a, b in reversed(rows)]

    def samples_since(self, kind: str, since_utc: str) -> list[tuple[str, dict[str, Any]]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT sample_utc, payload FROM samples WHERE kind=? AND sample_utc>=? ORDER BY sample_utc",
                (kind, since_utc),
            ).fetchall()
        return [(a, json.loads(b)) for a, b in rows]

    def save_list_change(
        self, index: str, added: list[str], removed: list[str], now: datetime
    ) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR IGNORE INTO list_changes VALUES (?,?,?,?)",
                (index, now.isoformat(), ",".join(added), ",".join(removed)),
            )
            self._db.commit()

    def list_changes(self, limit: int = 10) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT index_name, detected_utc, added, removed FROM list_changes ORDER BY detected_utc DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {
                "index": a,
                "detected": b,
                "added": [x for x in c.split(",") if x],
                "removed": [x for x in d.split(",") if x],
            }
            for a, b, c, d in rows
        ]

    def counts(self) -> dict[str, int]:
        with self._lock:
            return {
                t: int(self._db.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0])  # noqa: S608 - fixed names
                for t in (*_IMMUTABLE, "attempts")
            }
