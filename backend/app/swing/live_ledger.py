"""The live paper ledger: provisional intraday paper fills of the swing book, kept apart from the official record.

The official paper book (``store.PaperStore``) is written once a day by the evening run and is the permanent record. This ledger is a
second, separate SQLite file (``swing_live_fills.sqlite3``): when the entry rule reads "triggered" on a fresh live price it records a
fill here, at the price the evening run would use (``max(day open, trigger)``), sized by the same ``position_size`` from this
ledger's own equity. After the evening run settles the session, ``reconcile`` compares every live fill with the official decision:

* ``confirmed``: the official book also filled it (the price and share differences are kept);
* ``rejected``: the official book skipped it (volume short, never through the trigger, ...); the live position is closed at its last
  live price and marked void with the official reason, never hidden;
* a confirmed fill the official book closed the same day (day-1 rules or a stop) is closed here at the official exit.

Nothing here writes to the official book, reads a broker, or places an order. Equity = cash + open fills at their last live price.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterable, Sequence
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.swing.engine import Config, Decision, Position, Trade

SCHEMA = """
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, order_id INTEGER NOT NULL, order_session TEXT NOT NULL,
  symbol TEXT NOT NULL, rank INTEGER NOT NULL, filled_at TEXT NOT NULL, price REAL NOT NULL, shares INTEGER NOT NULL,
  pivot REAL NOT NULL, initial_sl REAL NOT NULL, trigger_price REAL NOT NULL, equity_at_entry REAL NOT NULL, evidence TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', last_price REAL, last_at TEXT,
  exit_price REAL, exit_at TEXT, exit_reason TEXT, gross_pnl REAL, costs REAL, pnl REAL,
  recon TEXT NOT NULL DEFAULT 'pending', recon_reason TEXT, recon_at TEXT, official_fill REAL, official_shares INTEGER,
  UNIQUE (session, symbol)
);
CREATE INDEX IF NOT EXISTS ix_fills_status ON fills(status);
"""


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="seconds")


class LiveLedger:
    def __init__(self, path: Path, cfg: Config) -> None:
        self.path, self.cfg = Path(path), cfg
        self._lock = threading.Lock()
        with closing(self._conn()) as c, c:
            c.executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        return c

    # ------------------------------------------------------------------ reads
    def rows(self, where: str = "", args: Sequence[Any] = (), limit: int = 500) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            return [dict(r) for r in c.execute(f"SELECT * FROM fills {where} ORDER BY id DESC LIMIT ?", (*args, limit))]  # noqa: S608

    def open_fills(self) -> list[dict[str, Any]]:
        return list(reversed(self.rows("WHERE status='open'")))

    def has_fill(self, session: str, symbol: str) -> bool:
        return bool(self.rows("WHERE session=? AND symbol=?", (session, symbol), 1))

    def exited_since(self, symbol: str, since_session: str) -> bool:
        """Was this stock closed in the ledger on or after ``since_session`` (the cooldown window)?"""
        return bool(self.rows("WHERE symbol=? AND status='closed' AND substr(exit_at,1,10) >= ?", (symbol, since_session), 1))

    def cash(self) -> float:
        """Capital less what open fills cost, plus what closed ones returned (costs included), from the stored fills only."""
        c_ = self.cfg.cost_per_side
        cash = self.cfg.capital
        for r in self.rows(limit=100000):
            cash -= r["shares"] * r["price"] * (1 + c_)
            if r["status"] == "closed" and r["exit_price"] is not None:
                cash += r["shares"] * r["exit_price"] * (1 - c_)
        return cash

    def equity(self) -> float:
        return float(self.cash() + sum(r["shares"] * (r["last_price"] or r["price"]) for r in self.open_fills()))

    # ------------------------------------------------------------------ live writes
    def record_fill(self, *, session: str, now: datetime, order: Any, price: float, shares: int, equity: float, evidence: str) -> int | None:
        """One fill per order per day (unique key). Returns its id, or None if that stock already has one today."""
        with self._lock, closing(self._conn()) as c, c:
            cur = c.execute(
                "INSERT OR IGNORE INTO fills (session, order_id, order_session, symbol, rank, filled_at, price, shares, pivot, initial_sl,"
                " trigger_price, equity_at_entry, evidence, last_price, last_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (session, order.id, order.session, order.symbol, order.rank, _iso(now), price, shares, order.pivot, order.initial_sl,
                 order.trigger, equity, evidence, price, _iso(now)),
            )
            return int(cur.lastrowid) if cur.rowcount and cur.lastrowid is not None else None

    def mark(self, fill_id: int, price: float, now: datetime) -> None:
        with self._lock, closing(self._conn()) as c, c:
            c.execute("UPDATE fills SET last_price=?, last_at=? WHERE id=? AND status='open'", (price, _iso(now), fill_id))

    def close(self, fill_id: int, *, price: float, now: datetime, reason: str) -> None:
        c_ = self.cfg.cost_per_side
        with self._lock, closing(self._conn()) as c, c:
            r = c.execute("SELECT shares, price FROM fills WHERE id=? AND status='open'", (fill_id,)).fetchone()
            if r is None:
                return
            gross = r["shares"] * (price - r["price"])
            costs = r["shares"] * (price * c_ + r["price"] * c_)
            c.execute("UPDATE fills SET status='closed', exit_price=?, exit_at=?, exit_reason=?, gross_pnl=?, costs=?, pnl=? WHERE id=?",
                      (price, _iso(now), reason, gross, costs, gross - costs, fill_id))

    # ------------------------------------------------------------------ reconciliation after the evening run
    def reconcile(self, session: str, decisions: Iterable[Decision], trades: Iterable[Trade], now: datetime | None = None) -> dict[str, int]:
        """Compare this ledger's pending fills of ``session`` with the official decisions of that session. See the module docstring."""
        now = now or datetime.now(UTC)
        by_order = {d.order.id: d for d in decisions}
        closed_same_day = {t.symbol: t for t in trades if t.entry_session == session and t.exit_session == session}
        out = {"confirmed": 0, "rejected": 0, "closed": 0}
        for r in self.rows("WHERE session=? AND recon='pending'", (session,)):
            d = by_order.get(r["order_id"])
            if d is None:
                continue  # the official book has not decided this order yet: stays pending
            if d.outcome == "filled":
                reason = f"official fill {d.fill:.2f} x {d.shares}"
                self._set_recon(r["id"], "confirmed", reason, now, d.fill, d.shares)
                out["confirmed"] += 1
                t = closed_same_day.get(r["symbol"])
                if t is not None and r["status"] == "open":
                    self.close(r["id"], price=t.exit, now=now, reason=f"official {t.reason}")
                    out["closed"] += 1
            else:
                self._set_recon(r["id"], "rejected", f"official book skipped it: {d.reason}", now, None, None)
                out["rejected"] += 1
                if r["status"] == "open":
                    self.close(r["id"], price=r["last_price"] or r["price"], now=now, reason=f"void: official book skipped it ({d.reason})")
                    out["closed"] += 1
        return out

    def settled(self, session: str, decisions: Sequence[Decision], trades: Sequence[Trade]) -> dict[str, int]:
        """What the evening run calls after it commits ``session``: reconcile today's pending fills, then follow official closes."""
        out = self.reconcile(session, decisions, trades)
        out["followed"] = self.close_with_official(session, trades)
        return out

    def close_with_official(self, session: str, trades: Iterable[Trade], now: datetime | None = None) -> int:
        """Close confirmed open fills whose stock the official book closed in ``session`` (a stop or day-1 rule on a later day)."""
        now = now or datetime.now(UTC)
        n = 0
        exits = {t.symbol: t for t in trades if t.exit_session == session}
        for r in self.open_fills():
            t = exits.get(r["symbol"])
            if t is not None and r["recon"] == "confirmed" and t.entry_session == r["session"]:
                self.close(r["id"], price=t.exit, now=now, reason=f"official {t.reason}")
                n += 1
        return n

    def _set_recon(self, fill_id: int, recon: str, reason: str, now: datetime, fill: float | None, shares: int | None) -> None:
        with self._lock, closing(self._conn()) as c, c:
            c.execute("UPDATE fills SET recon=?, recon_reason=?, recon_at=?, official_fill=?, official_shares=? WHERE id=?",
                      (recon, reason, _iso(now), fill, shares, fill_id))

    # ------------------------------------------------------------------ for the page
    def snapshot(self) -> dict[str, Any]:
        fills = list(reversed(self.rows(limit=200)))
        closed = [r for r in fills if r["status"] == "closed"]
        total = sum(r["pnl"] or 0.0 for r in closed)
        recon = {k: sum(1 for r in fills if r["recon"] == k) for k in ("pending", "confirmed", "rejected")}
        for r in fills:
            off, gap = r["official_fill"], None
            gap = None if off is None else r["price"] - off
            r["price_gap"] = gap
            r["unrealised"] = None if r["status"] != "open" else r["shares"] * ((r["last_price"] or r["price"]) - r["price"])
        return {
            "capital": self.cfg.capital, "cash": self.cash(), "equity": self.equity(), "open": sum(1 for r in fills if r["status"] == "open"),
            "closed": len(closed), "realised_pnl": total, "reconciliation": recon, "fills": fills,
        }


def position_of(r: dict[str, Any], stop: float, high: float | None = None) -> Position:
    """An engine ``Position`` for a ledger fill, so the live stop check is the same ``check_position`` the official book uses."""
    return Position(r["symbol"], "", "", 0.0, r["pivot"], r["session"], 0, r["price"], r["shares"], r["initial_sl"], stop, high or r["price"], r["last_price"] or r["price"], r["order_id"])
