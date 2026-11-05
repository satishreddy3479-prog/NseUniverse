"""SQLite paper book (data/swing_paper.sqlite3): the forward record of the swing paper trader.

Tier 1 data (tiny, irreplaceable): scan runs, the point-in-time Chartink list, every order the scanner
queued, what happened to it, every closed paper trade and the daily equity. These tables are
append-only (triggers abort UPDATE and DELETE), so a stored forecast or fill is never rewritten.
Only ``positions`` (live stop state) and ``meta`` change. One writer: the daily job; a whole session
is committed in one transaction, so a crash can never leave half a day behind.
"""

from __future__ import annotations

import gzip
import json
import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.swing.engine import Book, Config, Decision, Order, Position, Trade

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scan_runs (
  session TEXT PRIMARY KEY, session_no INTEGER NOT NULL, ran_at TEXT NOT NULL, rule_version TEXT NOT NULL,
  universe_size INTEGER NOT NULL, fetched_ok INTEGER NOT NULL, sectors_defaulted INTEGER NOT NULL,
  nifty_close REAL, nifty_sma50 REAL, nifty_ok INTEGER, sectors TEXT NOT NULL,
  candidates INTEGER NOT NULL, blocked_by_gate INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS universe_log (
  session TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, count INTEGER NOT NULL, symbols_gz BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, symbol TEXT NOT NULL, sector TEXT NOT NULL,
  archetype TEXT NOT NULL, score REAL NOT NULL, pillars TEXT NOT NULL, close REAL NOT NULL, dist_pct REAL NOT NULL,
  pivot REAL NOT NULL, trigger_price REAL NOT NULL, max_open REAL NOT NULL, initial_sl REAL NOT NULL,
  risk_pct REAL NOT NULL, atr14 REAL NOT NULL, min_volume REAL NOT NULL, rank INTEGER NOT NULL,
  UNIQUE (session, symbol));
CREATE TABLE IF NOT EXISTS decisions (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id), session TEXT NOT NULL, outcome TEXT NOT NULL,
  reason TEXT NOT NULL, fill REAL, shares INTEGER, decided_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS positions (
  symbol TEXT PRIMARY KEY, sector TEXT NOT NULL, archetype TEXT NOT NULL, score REAL NOT NULL, pivot REAL NOT NULL,
  entry_session TEXT NOT NULL, entry_no INTEGER NOT NULL, fill REAL NOT NULL, shares INTEGER NOT NULL,
  initial_sl REAL NOT NULL, tsl REAL NOT NULL, hh REAL NOT NULL, last_close REAL NOT NULL, order_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, sector TEXT NOT NULL, archetype TEXT NOT NULL,
  score REAL NOT NULL, entry_session TEXT NOT NULL, entry REAL NOT NULL, pivot REAL NOT NULL,
  initial_sl REAL NOT NULL, shares INTEGER NOT NULL, exit_session TEXT NOT NULL, exit REAL NOT NULL,
  reason TEXT NOT NULL, gross_pnl REAL NOT NULL, costs REAL NOT NULL, pnl REAL NOT NULL, r_mult REAL,
  hold_sessions INTEGER NOT NULL, exit_no INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS live_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
  symbol TEXT NOT NULL, price REAL, volume INTEGER, detail TEXT NOT NULL, UNIQUE (session, kind, symbol));
CREATE TABLE IF NOT EXISTS equity (
  session TEXT PRIMARY KEY, session_no INTEGER NOT NULL, equity REAL NOT NULL, cash REAL NOT NULL,
  invested REAL NOT NULL, open_positions INTEGER NOT NULL, nifty_close REAL);
"""
APPEND_ONLY = ("scan_runs", "universe_log", "orders", "decisions", "trades", "equity", "live_events")


def _triggers() -> str:
    return "".join(
        f"CREATE TRIGGER IF NOT EXISTS {t}_no_{op.lower()} BEFORE {op} ON {t} "
        f"BEGIN SELECT RAISE(ABORT, '{t} is append-only'); END;"
        for t in APPEND_ONLY for op in ("UPDATE", "DELETE")
    )


class PaperStore:
    def __init__(self, data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "swing_paper.sqlite3"
        with closing(self._conn()) as c:
            c.executescript(SCHEMA + _triggers())

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA foreign_keys=ON")
        return c

    # ---- state for the job
    def meta(self) -> dict[str, str]:
        with closing(self._conn()) as c:
            return {r["key"]: r["value"] for r in c.execute("SELECT key, value FROM meta")}

    def load_state(self, cfg: Config) -> tuple[Book, str | None, int, list[Order]]:
        """Book, last session processed, its ordinal, and the orders queued at that close (undecided)."""
        with closing(self._conn()) as c:
            eq = c.execute("SELECT * FROM equity ORDER BY session_no DESC LIMIT 1").fetchone()
            book = Book(eq["cash"], eq["equity"]) if eq else Book(cfg.capital, cfg.capital)
            for r in c.execute("SELECT * FROM positions"):
                book.positions[r["symbol"]] = Position(
                    r["symbol"], r["sector"], r["archetype"], r["score"], r["pivot"], r["entry_session"], r["entry_no"],
                    r["fill"], r["shares"], r["initial_sl"], r["tsl"], r["hh"], r["last_close"], r["order_id"])
            for r in c.execute("SELECT symbol, MAX(exit_no) AS n FROM trades GROUP BY symbol"):
                book.last_exit_no[r["symbol"]] = r["n"]
            last = eq["session"] if eq else None
            pending = []
            if last:
                rows = c.execute(
                    "SELECT o.* FROM orders o LEFT JOIN decisions d ON d.order_id = o.id "
                    "WHERE o.session = ? AND d.order_id IS NULL ORDER BY o.rank", (last,))
                pending = [_order(r) for r in rows]
            return book, last, (eq["session_no"] if eq else 0), pending

    def commit_session(self, *, session: str, no: int, ran_at: datetime, rule_version: str, scan: dict[str, Any],
                       universe: list[str] | None, orders: list[Order], decisions: list[Decision],
                       trades: list[Trade], book: Book, invested: float, nifty_close: float | None) -> None:
        now = ran_at.astimezone(UTC).isoformat(timespec="seconds")
        with closing(self._conn()) as c, c:  # one transaction for the whole session
            if c.execute("SELECT 1 FROM equity WHERE session = ?", (session,)).fetchone():
                raise ValueError(f"session {session} is already recorded")
            for d in decisions:
                c.execute("INSERT INTO decisions VALUES (?,?,?,?,?,?,?)",
                          (d.order.id, session, d.outcome, d.reason, d.fill, d.shares, now))
            for t in trades:
                c.execute(
                    "INSERT INTO trades (symbol,sector,archetype,score,entry_session,entry,pivot,initial_sl,shares,"
                    "exit_session,exit,reason,gross_pnl,costs,pnl,r_mult,hold_sessions,exit_no) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (t.symbol, t.sector, t.archetype, t.score, t.entry_session, t.entry, t.pivot, t.initial_sl, t.shares,
                     t.exit_session, t.exit, t.reason, t.gross_pnl, t.costs, t.pnl, t.r_mult, t.hold_sessions, t.exit_no))
            c.execute("DELETE FROM positions")
            for p in book.positions.values():
                c.execute("INSERT INTO positions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (p.symbol, p.sector, p.archetype, p.score, p.pivot, p.entry_session, p.entry_no, p.fill, p.shares,
                           p.initial_sl, p.tsl, p.hh, p.last_close, p.order_id))
            for o in orders:
                c.execute(
                    "INSERT INTO orders (session,symbol,sector,archetype,score,pillars,close,dist_pct,pivot,trigger_price,"
                    "max_open,initial_sl,risk_pct,atr14,min_volume,rank) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (session, o.symbol, o.sector, o.archetype, o.score, json.dumps(o.pillars), o.close, o.dist_pct, o.pivot,
                     o.trigger, o.max_open, o.initial_sl, o.risk_pct, o.atr14, o.min_volume, o.rank))
            if universe is not None:
                c.execute("INSERT OR IGNORE INTO universe_log VALUES (?,?,?,?)",
                          (session, now, len(universe), gzip.compress(json.dumps(sorted(universe)).encode())))
            c.execute(
                "INSERT INTO scan_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (session, no, now, rule_version, scan["universe_size"], scan["fetched_ok"], scan["sectors_defaulted"],
                 scan.get("nifty_close"), scan.get("nifty_sma50"), None if scan.get("nifty_ok") is None else int(scan["nifty_ok"]),
                 json.dumps(scan["sectors"]), len(orders), scan["blocked"], scan.get("note", "")))
            c.execute("INSERT INTO equity VALUES (?,?,?,?,?,?,?)",
                      (session, no, book.equity, book.cash, invested, len(book.positions), nifty_close))
            c.execute("INSERT INTO meta VALUES ('started', ?) ON CONFLICT(key) DO NOTHING", (session,))
            c.execute("INSERT INTO meta VALUES ('capital', ?) ON CONFLICT(key) DO NOTHING", (str(scan["capital"]),))

    def set_meta(self, key: str, value: str) -> None:
        with closing(self._conn()) as c, c:
            c.execute("INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))

    # ---- live (shadow) events: what the live checks say, once per day per kind and stock
    def record_live_event(self, session: str, at: datetime, kind: str, symbol: str, price: float | None,
                          volume: int | None, detail: dict[str, Any]) -> bool:
        """True when this is the first time today that `kind` was seen for `symbol` (then it is stored)."""
        with closing(self._conn()) as c, c:
            cur = c.execute(
                "INSERT OR IGNORE INTO live_events (session, at, kind, symbol, price, volume, detail) VALUES (?,?,?,?,?,?,?)",
                (session, at.astimezone(UTC).isoformat(timespec="seconds"), kind, symbol, price, volume, json.dumps(detail)))
            return cur.rowcount == 1

    def live_events(self, session: str) -> list[dict[str, Any]]:
        with closing(self._conn()) as c:
            rows = c.execute("SELECT at, kind, symbol, price, volume, detail FROM live_events WHERE session = ? "
                             "ORDER BY id", (session,))
            return [dict(r) | {"detail": json.loads(r["detail"])} for r in rows]

    # ---- read side for the API
    def snapshot(self, trades_limit: int = 100, decisions_limit: int = 40) -> dict[str, Any]:
        with closing(self._conn()) as c:
            meta = {r["key"]: r["value"] for r in c.execute("SELECT key, value FROM meta")}
            equity = [dict(r) for r in c.execute("SELECT * FROM equity ORDER BY session_no")]
            last_scan = c.execute("SELECT * FROM scan_runs ORDER BY session_no DESC LIMIT 1").fetchone()
            pending = []
            if last_scan:
                pending = [_order_dict(r) for r in c.execute(
                    "SELECT o.* FROM orders o LEFT JOIN decisions d ON d.order_id = o.id "
                    "WHERE o.session = ? AND d.order_id IS NULL ORDER BY o.rank", (last_scan["session"],))]
            decisions = [dict(r) | {"pillars": json.loads(r["pillars"])} for r in c.execute(
                "SELECT d.session AS decided_on, d.outcome, d.reason, d.fill, d.shares, o.symbol, o.sector, o.score, o.pillars, "
                "o.session AS signal_session, o.trigger_price, o.max_open, o.initial_sl, o.rank "
                "FROM decisions d JOIN orders o ON o.id = d.order_id ORDER BY d.session DESC, o.rank LIMIT ?", (decisions_limit,))]
            trades = [dict(r) for r in c.execute("SELECT * FROM trades ORDER BY id DESC LIMIT ?", (trades_limit,))]
            agg = c.execute(
                "SELECT COUNT(*) AS n, COALESCE(SUM(pnl),0) AS pnl, COALESCE(SUM(costs),0) AS costs, "
                "COALESCE(SUM(pnl > 0),0) AS wins FROM trades").fetchone()
            positions = [dict(r) for r in c.execute("SELECT * FROM positions ORDER BY entry_no, symbol")]
            runs = [dict(r) for r in c.execute(
                "SELECT session, ran_at, universe_size, fetched_ok, candidates, blocked_by_gate, note "
                "FROM scan_runs ORDER BY session_no DESC LIMIT 10")]
            # When the paper job recorded each session, and the first moment the live feed saw a rule met (shadow log)
            booked = {r["session"]: r["ran_at"] for r in c.execute("SELECT session, ran_at FROM scan_runs")}
            seen = {(r["session"], r["symbol"], r["kind"]): r["at"] for r in c.execute(
                "SELECT session, symbol, kind, MIN(at) AS at FROM live_events GROUP BY session, symbol, kind")}
        scan = None
        if last_scan:
            scan = {k: last_scan[k] for k in last_scan.keys() if k != "sectors"}
            scan["sectors"] = json.loads(last_scan["sectors"])
            scan["nifty_ok"] = None if last_scan["nifty_ok"] is None else bool(last_scan["nifty_ok"])
        # The paper book is settled from daily bars after the close, so it knows the day of a fill, not the minute:
        # ``*_booked_at`` is when the job recorded that day; ``*_seen_at`` is when the live feed saw the rule met (only
        # for days the live layer was running), never a guess.
        for o in pending:
            o["scanned_at"] = booked.get(o["session"])
        for d in decisions:
            d["decided_booked_at"] = booked.get(d["decided_on"])
            d["scanned_at"] = booked.get(d["signal_session"])
            d["seen_at"] = seen.get((d["decided_on"], d["symbol"], "entry_trigger")) if d["outcome"] == "filled" else None
        for p in positions:
            p["entered_booked_at"] = booked.get(p["entry_session"])
            p["entry_seen_at"] = seen.get((p["entry_session"], p["symbol"], "entry_trigger"))
        for x in trades:
            x["entered_booked_at"] = booked.get(x["entry_session"])
            x["exited_booked_at"] = booked.get(x["exit_session"])
            x["entry_seen_at"] = seen.get((x["entry_session"], x["symbol"], "entry_trigger"))
            x["exit_seen_at"] = seen.get((x["exit_session"], x["symbol"], "stop_hit")) if str(x["reason"]).startswith("STOP") else None
        return {"meta": meta, "equity": equity, "scan": scan, "orders": pending, "decisions": decisions, "trades": trades,
                "trade_totals": dict(agg), "positions": positions, "recent_runs": runs}


def _order(r: sqlite3.Row) -> Order:
    return Order(r["session"], r["symbol"], r["sector"], r["archetype"], r["score"], tuple(json.loads(r["pillars"])),
                 r["close"], r["dist_pct"], r["pivot"], r["trigger_price"], r["max_open"], r["initial_sl"], r["risk_pct"],
                 r["atr14"], r["min_volume"], r["rank"], r["id"])


def _order_dict(r: sqlite3.Row) -> dict[str, Any]:
    d = dict(r)
    d["pillars"] = json.loads(d["pillars"])
    d["trigger"] = d.pop("trigger_price")
    return d
