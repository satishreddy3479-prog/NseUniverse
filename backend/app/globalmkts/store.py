"""SQLite store of the global board (``global.sqlite3``): one-minute bars, the latest quote of each symbol, the economic calendar and the news.

Bars are stored once (the primary key is the symbol and the minute) and never rewritten by a later poll; nothing is deleted here (sizes: docs/storage-plan.md).
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any

from app.globalmkts.quotes import Quote

SCHEMA = """
CREATE TABLE IF NOT EXISTS bars (symbol TEXT NOT NULL, ts INTEGER NOT NULL, price REAL NOT NULL, PRIMARY KEY (symbol, ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS latest (
  symbol TEXT PRIMARY KEY, ts INTEGER NOT NULL, as_of INTEGER NOT NULL, price REAL NOT NULL, prev_close REAL, prev_ts INTEGER, change REAL, change_pct REAL,
  status TEXT NOT NULL, session TEXT NOT NULL, received_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, at_ms INTEGER NOT NULL, ok INTEGER NOT NULL, detail TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_runs ON runs(kind, id);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, ts INTEGER NOT NULL, date_ist TEXT NOT NULL, all_day INTEGER NOT NULL, country TEXT NOT NULL, name TEXT NOT NULL,
  impact TEXT NOT NULL, actual TEXT, forecast TEXT, previous TEXT, note TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS event_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, at_ms INTEGER NOT NULL, changes TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS news (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, region TEXT NOT NULL, section TEXT NOT NULL, title TEXT NOT NULL, link TEXT NOT NULL, summary TEXT NOT NULL,
  published INTEGER NOT NULL, fetched INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_news_pub ON news(region, published);
"""


def ms(t: datetime) -> int:
    return int(t.timestamp() * 1000)


class GlobalStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = Path(data_dir) / "global.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        with closing(self._conn()) as c, c:
            c.executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        return c

    # ------------------------------------------------------------------ quotes
    def save_quote(self, q: Quote, received: datetime) -> int:
        """Keep the quote as the latest of its symbol and store its bars that are not stored yet; returns the number of new bars."""
        with self._lock, closing(self._conn()) as c, c:
            row = c.execute("SELECT MAX(ts) FROM bars WHERE symbol=?", (q.key,)).fetchone()
            newest = row[0] if row and row[0] is not None else -1
            fresh = [(q.key, ms(b.ts), b.close) for b in q.bars if ms(b.ts) > newest]
            c.executemany("INSERT OR IGNORE INTO bars VALUES (?,?,?)", fresh)
            c.execute(
                "INSERT OR REPLACE INTO latest VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (q.key, ms(q.bar_ts), ms(q.as_of), q.price, q.prev_close, None if q.prev_ts is None else ms(q.prev_ts), q.change, q.change_pct, q.status, q.session, ms(received)),
            )
            return len(fresh)

    def latest_all(self) -> dict[str, dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            return {r["symbol"]: dict(r) for r in c.execute("SELECT * FROM latest")}

    def series(self, symbol: str, since_ms: int, limit: int = 3000) -> list[tuple[int, float]]:
        with self._lock, closing(self._conn()) as c:
            rows = c.execute("SELECT ts, price FROM bars WHERE symbol=? AND ts>=? ORDER BY ts DESC LIMIT ?", (symbol, since_ms, limit)).fetchall()
        return [(r[0], r[1]) for r in reversed(rows)]

    def bars_before(self, symbol: str, before_ms: int, limit: int = 2000) -> list[tuple[int, float]]:
        """Stored bars older than ``before_ms``, oldest first (the reference session of a quote built from fresh bars)."""
        with self._lock, closing(self._conn()) as c:
            rows = c.execute("SELECT ts, price FROM bars WHERE symbol=? AND ts<? ORDER BY ts DESC LIMIT ?", (symbol, before_ms, limit)).fetchall()
        return [(r[0], r[1]) for r in reversed(rows)]

    def bar_counts(self) -> dict[str, int]:
        with self._lock, closing(self._conn()) as c:
            return {r[0]: r[1] for r in c.execute("SELECT symbol, COUNT(*) FROM bars GROUP BY symbol")}

    # ------------------------------------------------------------------ runs
    def add_run(self, kind: str, at: datetime, ok: bool, detail: dict[str, Any]) -> None:
        with self._lock, closing(self._conn()) as c, c:
            c.execute("INSERT INTO runs (kind, at_ms, ok, detail) VALUES (?,?,?,?)", (kind, ms(at), 1 if ok else 0, json.dumps(detail, separators=(",", ":"))))

    def last_run(self, kind: str, ok: bool | None = None) -> dict[str, Any] | None:
        q = "SELECT * FROM runs WHERE kind=?" + ("" if ok is None else " AND ok=?") + " ORDER BY id DESC LIMIT 1"  # noqa: S608 - fixed text, values are bound
        with self._lock, closing(self._conn()) as c:
            r = c.execute(q, (kind,) if ok is None else (kind, 1 if ok else 0)).fetchone()
        if r is None:
            return None
        d = dict(r)
        d["detail"] = json.loads(d["detail"])
        return d

    # ------------------------------------------------------------------ calendar
    def upsert_events(self, events: list[dict[str, Any]], now: datetime) -> dict[str, int]:
        """Insert new events and update the ones that changed (a moved time or a new forecast or actual is recorded as a revision)."""
        new = changed = same = 0
        with self._lock, closing(self._conn()) as c, c:
            for e in events:
                old = c.execute("SELECT * FROM events WHERE id=?", (e["id"],)).fetchone()
                if old is None:
                    c.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (e["id"], e["source"], e["ts"], e["date_ist"], 1 if e.get("all_day") else 0, e["country"], e["name"], e["impact"], e.get("actual"), e.get("forecast"), e.get("previous"), e.get("note"), ms(now), ms(now)))
                    new += 1
                    continue
                diff = {k: [old[k], e.get(k)] for k in ("ts", "name", "impact", "actual", "forecast", "previous") if e.get(k) != old[k] and (e.get(k) is not None or old[k] is not None)}
                if diff:
                    c.execute("UPDATE events SET ts=?, date_ist=?, name=?, impact=?, actual=?, forecast=?, previous=?, last_seen=? WHERE id=?", (e["ts"], e["date_ist"], e["name"], e["impact"], e.get("actual"), e.get("forecast"), e.get("previous"), ms(now), e["id"]))
                    c.execute("INSERT INTO event_revisions (event_id, at_ms, changes) VALUES (?,?,?)", (e["id"], ms(now), json.dumps(diff)))
                    changed += 1
                else:
                    c.execute("UPDATE events SET last_seen=? WHERE id=?", (ms(now), e["id"]))
                    same += 1
        return {"new": new, "changed": changed, "same": same}

    def events_between(self, start_ms: int, end_ms: int) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            return [dict(r) for r in c.execute("SELECT * FROM events WHERE ts>=? AND ts<? ORDER BY ts, name", (start_ms, end_ms))]

    # ------------------------------------------------------------------ news
    def add_news(self, items: list[dict[str, Any]], now: datetime) -> int:
        added = 0
        with self._lock, closing(self._conn()) as c, c:
            for n in items:
                cur = c.execute("INSERT OR IGNORE INTO news VALUES (?,?,?,?,?,?,?,?,?)", (n["id"], n["source"], n["region"], n["section"], n["title"], n["link"], n["summary"], n["published"], ms(now)))
                added += cur.rowcount
        return added

    def news(self, region: str, limit: int = 60) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            return [dict(r) for r in c.execute("SELECT * FROM news WHERE region=? ORDER BY published DESC LIMIT ?", (region, limit))]
