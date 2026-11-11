"""Storage of the 1-minute shadow book (data/swing_minute.sqlite3). Separate from the official paper book and from the provisional live ledger.

  bars         one row per completed 1-minute candle of a watched stock (prices as polled, about 45 bytes a row, roughly 0.2 MB a session);
  fills        the shadow book's positions: open ones change (stop, high-water mark), closed ones keep their exit; never deleted;
  events       append-only log of every state change (entry state, signal, fill, cancel, ratchet, exit);
  comparisons  after each evening settlement, what the official daily-bar book did against what this book did, per stock.
Nothing here places an order or reads a broker.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.swing.engine import Config
from app.swing.minute_rules import Candle, ShadowPos

SCHEMA = """
CREATE TABLE IF NOT EXISTS bars (
  session TEXT NOT NULL, symbol TEXT NOT NULL, start_min INTEGER NOT NULL, o REAL, h REAL, l REAL, c REAL, cum_volume INTEGER, polls INTEGER,
  day_open REAL, day_high REAL, day_low REAL, PRIMARY KEY (session, symbol, start_min));
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, symbol TEXT NOT NULL, order_session TEXT NOT NULL, rank INTEGER, score REAL,
  signal_at TEXT NOT NULL, filled_at TEXT NOT NULL, fill REAL NOT NULL, shares INTEGER NOT NULL, trigger_price REAL NOT NULL, pivot REAL NOT NULL,
  initial_sl REAL NOT NULL, atr14 REAL NOT NULL, equity_at_entry REAL NOT NULL, evidence TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', tsl REAL NOT NULL, hh_close REAL NOT NULL, d1_checked INTEGER NOT NULL DEFAULT 0, last_price REAL, last_at TEXT,
  exit_at TEXT, exit_price REAL, exit_reason TEXT, exit_basis TEXT, exit_session TEXT, gross_pnl REAL, costs REAL, pnl REAL, UNIQUE (session, symbol));
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, at TEXT NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL, price REAL, detail TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_events_session ON events(session, id);
CREATE TABLE IF NOT EXISTS comparisons (session TEXT PRIMARY KEY, at TEXT NOT NULL, data TEXT NOT NULL);
"""


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).isoformat(timespec="seconds")


class MinuteStore:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with closing(self._conn()) as c, c:
            c.executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        return c

    # ------------------------------------------------------------------ bars
    def record_bar(self, c: Candle) -> None:
        with self._lock, closing(self._conn()) as db, db:
            db.execute("INSERT OR IGNORE INTO bars VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                       (c.session, c.symbol, c.start_min, c.o, c.h, c.low, c.c, c.cum_volume, c.polls, c.day_open, c.day_high, c.day_low))

    def bar_stats(self, session: str) -> dict[str, Any]:
        with self._lock, closing(self._conn()) as db:
            rows = db.execute("SELECT symbol, COUNT(*) n, MIN(start_min) a, MAX(start_min) b FROM bars WHERE session=? GROUP BY symbol", (session,)).fetchall()
        return {r["symbol"]: {"bars": r["n"], "first_min": r["a"], "last_min": r["b"]} for r in rows}

    def bars(self, session: str, symbol: str) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as db:
            return [dict(r) for r in db.execute("SELECT * FROM bars WHERE session=? AND symbol=? ORDER BY start_min", (session, symbol))]

    # ------------------------------------------------------------------ fills
    def add_fill(self, *, session: str, symbol: str, order_session: str, rank: int, score: float, signal_at: datetime, filled_at: datetime, fill: float,
                 shares: int, trigger: float, pivot: float, initial_sl: float, atr14: float, equity: float, evidence: str) -> int | None:
        """Insert an open shadow position; None if this stock already has a shadow fill for this session."""
        with self._lock, closing(self._conn()) as db, db:
            cur = db.execute(
                "INSERT OR IGNORE INTO fills (session, symbol, order_session, rank, score, signal_at, filled_at, fill, shares, trigger_price, pivot, initial_sl, atr14,"
                " equity_at_entry, evidence, tsl, hh_close, last_price, last_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (session, symbol, order_session, rank, score, _iso(signal_at), _iso(filled_at), fill, shares, trigger, pivot, initial_sl, atr14, equity, evidence,
                 initial_sl, fill, fill, _iso(filled_at)))
            return int(cur.lastrowid) if cur.rowcount and cur.lastrowid else None

    def open_rows(self) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as db:
            return [dict(r) for r in db.execute("SELECT * FROM fills WHERE status='open' ORDER BY id")]

    def update_position(self, fill_id: int, pos: ShadowPos, price: float, now: datetime) -> None:
        with self._lock, closing(self._conn()) as db, db:
            db.execute("UPDATE fills SET tsl=?, hh_close=?, d1_checked=?, last_price=?, last_at=? WHERE id=? AND status='open'",
                       (pos.tsl, pos.hh_close, int(pos.d1_checked), price, _iso(now), fill_id))

    def mark(self, fill_id: int, price: float, now: datetime) -> None:
        with self._lock, closing(self._conn()) as db, db:
            db.execute("UPDATE fills SET last_price=?, last_at=? WHERE id=? AND status='open'", (price, _iso(now), fill_id))

    def close_fill(self, fill_id: int, *, price: float, at: datetime, session: str, reason: str, basis: str, cfg: Config) -> None:
        with self._lock, closing(self._conn()) as db, db:
            r = db.execute("SELECT fill, shares FROM fills WHERE id=? AND status='open'", (fill_id,)).fetchone()
            if r is None:
                return
            gross = r["shares"] * (price - r["fill"])
            costs = r["shares"] * (price * cfg.cost_per_side + r["fill"] * cfg.cost_per_side)
            db.execute("UPDATE fills SET status='closed', exit_at=?, exit_price=?, exit_reason=?, exit_basis=?, exit_session=?, gross_pnl=?, costs=?, pnl=?, last_price=?, last_at=?"
                       " WHERE id=?", (_iso(at), price, reason, basis, session, gross, costs, gross - costs, price, _iso(at), fill_id))

    def rows(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as db:
            return [dict(r) for r in db.execute("SELECT * FROM fills ORDER BY id DESC LIMIT ?", (limit,))]

    def fills_of(self, session: str) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as db:
            return [dict(r) for r in db.execute("SELECT * FROM fills WHERE session=? ORDER BY id", (session,))]

    def exited_since(self, symbol: str, since_session: str) -> bool:
        """True if a shadow fill in ``symbol`` was closed on or after ``since_session`` (the cooldown)."""
        with self._lock, closing(self._conn()) as db:
            r = db.execute("SELECT 1 FROM fills WHERE symbol=? AND status='closed' AND exit_session>=? LIMIT 1", (symbol, since_session)).fetchone()
        return r is not None

    def cash_equity(self, cfg: Config) -> tuple[float, float]:
        """(cash, equity): the starting capital plus closed P&L, less what open positions cost, plus them at their last price."""
        with self._lock, closing(self._conn()) as db:
            closed = db.execute("SELECT COALESCE(SUM(pnl), 0) FROM fills WHERE status='closed'").fetchone()[0]
            open_ = db.execute("SELECT fill, shares, last_price FROM fills WHERE status='open'").fetchall()
        cash = cfg.capital + closed - sum(r["shares"] * r["fill"] * (1 + cfg.cost_per_side) for r in open_)
        marked = sum(r["shares"] * (r["last_price"] or r["fill"]) for r in open_)
        return cash, cash + marked

    # ------------------------------------------------------------------ events (append-only)
    def add_event(self, session: str, at: datetime, symbol: str, kind: str, price: float | None, detail: dict[str, Any]) -> None:
        with self._lock, closing(self._conn()) as db, db:
            db.execute("INSERT INTO events (session, at, symbol, kind, price, detail) VALUES (?,?,?,?,?,?)", (session, _iso(at), symbol, kind, price, json.dumps(detail, default=str)))

    def events(self, session: str, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as db:
            rows = db.execute("SELECT * FROM events WHERE session=? ORDER BY id DESC LIMIT ?", (session, limit)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["detail"] = json.loads(d["detail"])
            out.append(d)
        return out

    def last_state(self, session: str, symbol: str) -> dict[str, Any] | None:
        """The newest entry_state event of a stock today (its detail), or None."""
        with self._lock, closing(self._conn()) as db:
            r = db.execute("SELECT detail FROM events WHERE session=? AND symbol=? AND kind='entry_state' ORDER BY id DESC LIMIT 1", (session, symbol)).fetchone()
        return None if r is None else dict(json.loads(r["detail"]))

    def state_history(self, session: str, symbol: str) -> list[str]:
        with self._lock, closing(self._conn()) as db:
            rows = db.execute("SELECT detail FROM events WHERE session=? AND symbol=? AND kind='entry_state' ORDER BY id", (session, symbol)).fetchall()
        return [str(json.loads(r["detail"]).get("state")) for r in rows]

    # ------------------------------------------------------------------ comparisons
    def save_comparison(self, session: str, at: datetime, data: dict[str, Any]) -> None:
        with self._lock, closing(self._conn()) as db, db:
            db.execute("INSERT OR REPLACE INTO comparisons VALUES (?,?,?)", (session, _iso(at), json.dumps(data, default=str)))

    def comparisons(self, limit: int = 10) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as db:
            rows = db.execute("SELECT * FROM comparisons ORDER BY session DESC LIMIT ?", (limit,)).fetchall()
        return [{"session": r["session"], "at": r["at"], **json.loads(r["data"])} for r in rows]
