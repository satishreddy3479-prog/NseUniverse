"""Daily price history store with provenance (`data/market_history.sqlite3`).

First-seen values are never overwritten. If a later download disagrees with a stored bar, the
disagreement is logged in ``bar_changes`` and the stored bar is left as it was, so a backtest can be
reproduced and a Yahoo correction (or error) can be reviewed instead of silently changing history.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from app.prediction.sources.yahoo import RawRow
from app.prediction.targets import Bar, BarError

_SCHEMA = """
CREATE TABLE IF NOT EXISTS daily_bars (
  symbol TEXT NOT NULL, session TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
  low REAL NOT NULL, close REAL NOT NULL, volume REAL, source TEXT NOT NULL,
  retrieved_utc TEXT NOT NULL, run_id TEXT NOT NULL,
  PRIMARY KEY (symbol, session, source)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bar_changes (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, session TEXT NOT NULL,
  source TEXT NOT NULL, stored TEXT NOT NULL, seen TEXT NOT NULL, detected_utc TEXT NOT NULL,
  run_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fetch_runs (
  run_id TEXT PRIMARY KEY, source TEXT NOT NULL, started_utc TEXT NOT NULL, finished_utc TEXT,
  summary TEXT
);
CREATE TRIGGER IF NOT EXISTS daily_bars_no_update BEFORE UPDATE ON daily_bars
  BEGIN SELECT RAISE(ABORT, 'stored bars are never overwritten'); END;
CREATE TRIGGER IF NOT EXISTS daily_bars_no_delete BEFORE DELETE ON daily_bars
  BEGIN SELECT RAISE(ABORT, 'stored bars are never deleted'); END;
"""
_TOL = 1e-9


@dataclass
class InsertResult:
    new: int = 0
    unchanged: int = 0
    changed: int = 0
    invalid: int = 0
    incomplete: int = 0  # rows with a missing price


class HistoryStore:
    def __init__(self, data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "market_history.sqlite3"
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def insert_bars(
        self, symbol: str, rows: list[RawRow], *, source: str, run_id: str, now: datetime | None = None,
        volume_meaningful: bool = False,
    ) -> InsertResult:  # fmt: skip
        res = InsertResult()
        stamp = (now or datetime.now(UTC)).astimezone(UTC).isoformat()
        with self._lock:
            for r in rows:
                if None in (r.open, r.high, r.low, r.close):
                    res.incomplete += 1
                    continue
                try:
                    bar = Bar(r.session, r.open, r.high, r.low, r.close)  # type: ignore[arg-type]
                except BarError:
                    res.invalid += 1
                    continue
                vol = r.volume if volume_meaningful and r.volume and r.volume > 0 else None
                cur = self._db.execute(
                    "SELECT open, high, low, close FROM daily_bars WHERE symbol=? AND session=? AND source=?",
                    (symbol, str(bar.session), source),
                ).fetchone()
                if cur is None:
                    self._db.execute(
                        "INSERT INTO daily_bars VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (
                            symbol,
                            str(bar.session),
                            bar.open,
                            bar.high,
                            bar.low,
                            bar.close,
                            vol,
                            source,
                            stamp,
                            run_id,
                        ),
                    )
                    res.new += 1
                elif all(
                    abs(a - b) <= _TOL * max(1.0, abs(a))
                    for a, b in zip(cur, (bar.open, bar.high, bar.low, bar.close), strict=True)
                ):
                    res.unchanged += 1
                else:
                    self._db.execute(
                        "INSERT INTO bar_changes(symbol, session, source, stored, seen, detected_utc, run_id) VALUES (?,?,?,?,?,?,?)",
                        (
                            symbol,
                            str(bar.session),
                            source,
                            json.dumps(cur),
                            json.dumps([bar.open, bar.high, bar.low, bar.close]),
                            stamp,
                            run_id,
                        ),
                    )
                    res.changed += 1
            self._db.commit()
        return res

    def bars(self, symbol: str, source: str = "yahoo") -> list[Bar]:
        with self._lock:
            rows = self._db.execute(
                "SELECT session, open, high, low, close FROM daily_bars WHERE symbol=? AND source=? ORDER BY session",
                (symbol, source),
            ).fetchall()
        return [Bar(date.fromisoformat(s), o, h, lo, c) for s, o, h, lo, c in rows]

    def last_session(self, symbol: str, source: str = "yahoo") -> date | None:
        with self._lock:
            r = self._db.execute(
                "SELECT MAX(session) FROM daily_bars WHERE symbol=? AND source=?", (symbol, source)
            ).fetchone()
        return date.fromisoformat(r[0]) if r and r[0] else None

    def coverage(self, source: str = "yahoo") -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT symbol, MIN(session), MAX(session), COUNT(*), MAX(retrieved_utc) FROM daily_bars"
                " WHERE source=? GROUP BY symbol ORDER BY symbol",
                (source,),
            ).fetchall()
            changes = dict(
                self._db.execute(
                    "SELECT symbol, COUNT(*) FROM bar_changes GROUP BY symbol"
                ).fetchall()
            )
        return [
            {
                "symbol": s,
                "first": a,
                "last": b,
                "bars": n,
                "last_retrieved": r,
                "disagreements": changes.get(s, 0),
            }
            for s, a, b, n, r in rows
        ]

    def start_run(self, run_id: str, source: str, now: datetime | None = None) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO fetch_runs(run_id, source, started_utc) VALUES (?,?,?)",
                (run_id, source, (now or datetime.now(UTC)).astimezone(UTC).isoformat()),
            )
            self._db.commit()

    def finish_run(self, run_id: str, summary: dict[str, Any], now: datetime | None = None) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE fetch_runs SET finished_utc=?, summary=? WHERE run_id=?",
                (
                    (now or datetime.now(UTC)).astimezone(UTC).isoformat(),
                    json.dumps(summary, default=str),
                    run_id,
                ),
            )
            self._db.commit()

    def last_run(self) -> dict[str, Any] | None:
        with self._lock:
            r = self._db.execute(
                "SELECT run_id, started_utc, finished_utc, summary FROM fetch_runs ORDER BY started_utc DESC LIMIT 1"
            ).fetchone()
        if not r:
            return None
        return {
            "run_id": r[0],
            "started_at": r[1],
            "finished_at": r[2],
            "summary": json.loads(r[3]) if r[3] else None,
        }

    def last_success_utc(self) -> datetime | None:
        with self._lock:
            rows = self._db.execute(
                "SELECT finished_utc, summary FROM fetch_runs WHERE finished_utc IS NOT NULL ORDER BY started_utc DESC LIMIT 20"
            ).fetchall()
        for fin, summary in rows:
            s = json.loads(summary) if summary else {}
            if s.get("ok_symbols", 0) > 0:
                return datetime.fromisoformat(fin)
        return None
