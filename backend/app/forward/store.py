"""SQLite store of the forward test (``forward.sqlite3``): one row per simulated position, one per exit variant of each, the re-arming state of each cohort, and a run log.

Small by design: a trigger makes 4 positions (weekly and monthly, straddle and strangle) of 11 variants, a few dozen rows. Nothing is deleted here.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, cohort TEXT NOT NULL, expiry TEXT NOT NULL, structure TEXT NOT NULL, n INTEGER NOT NULL,
  trigger_at TEXT NOT NULL, spot0 REAL, ce_strike REAL NOT NULL, pe_strike REAL NOT NULL, ce0 REAL NOT NULL, pe0 REAL NOT NULL, lot INTEGER NOT NULL,
  seller REAL, buyer REAL, regime TEXT, context TEXT NOT NULL, track TEXT NOT NULL, eod TEXT, status TEXT NOT NULL, last_sample_ms INTEGER NOT NULL, settled_at TEXT,
  UNIQUE (session, cohort, structure, n));
CREATE TABLE IF NOT EXISTS results (
  trade_id INTEGER NOT NULL, variant TEXT NOT NULL, state TEXT NOT NULL, done INTEGER NOT NULL, ce_exit REAL, pe_exit REAL, gross REAL, cost REAL, net REAL, worst REAL,
  reason TEXT, stopped_at TEXT, PRIMARY KEY (trade_id, variant));
CREATE TABLE IF NOT EXISTS arm (
  session TEXT NOT NULL, cohort TEXT NOT NULL, count INTEGER NOT NULL, armed INTEGER NOT NULL, below_since TEXT, PRIMARY KEY (session, cohort));
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ok INTEGER NOT NULL, detail TEXT NOT NULL);
"""


class ForwardStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = Path(data_dir) / "forward.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        with closing(self._conn()) as c, c:
            c.executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        return c

    # ------------------------------------------------------------------ arming (re-crossings of the score)
    def arm_get(self, session: str, cohort: str) -> dict[str, Any]:
        with self._lock, closing(self._conn()) as c:
            r = c.execute("SELECT * FROM arm WHERE session=? AND cohort=?", (session, cohort)).fetchone()
        return {"count": 0, "armed": True, "below_since": None} if r is None else {"count": r["count"], "armed": bool(r["armed"]), "below_since": r["below_since"]}

    def arm_set(self, session: str, cohort: str, count: int, armed: bool, below_since: str | None) -> None:
        with self._lock, closing(self._conn()) as c, c:
            c.execute("INSERT OR REPLACE INTO arm VALUES (?,?,?,?,?)", (session, cohort, count, 1 if armed else 0, below_since))

    # ------------------------------------------------------------------ positions
    def add_trade(self, t: dict[str, Any], variants: dict[str, dict[str, Any]]) -> int | None:
        """Insert a position and the initial state of each variant; None when this (session, cohort, structure, n) already exists."""
        with self._lock, closing(self._conn()) as c, c:
            try:
                cur = c.execute(
                    "INSERT INTO trades (session, cohort, expiry, structure, n, trigger_at, spot0, ce_strike, pe_strike, ce0, pe0, lot, seller, buyer, regime, context, track, status, last_sample_ms)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'open',?)",
                    (t["session"], t["cohort"], t["expiry"], t["structure"], t["n"], t["trigger_at"], t["spot0"], t["ce_strike"], t["pe_strike"], t["ce0"], t["pe0"], t["lot"], t["seller"], t["buyer"], t["regime"],
                     json.dumps(t["context"], separators=(",", ":")), json.dumps(t["track"], separators=(",", ":")), t["last_sample_ms"]),
                )  # fmt: skip
            except sqlite3.IntegrityError:
                return None
            tid = int(cur.lastrowid or 0)
            for v, st in variants.items():
                c.execute("INSERT INTO results (trade_id, variant, state, done) VALUES (?,?,?,0)", (tid, v, json.dumps(st, separators=(",", ":"))))
            return tid

    def get_meta(self, key: str) -> str | None:
        with self._lock, closing(self._conn()) as c:
            r = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return None if r is None else str(r["value"])

    def set_meta(self, key: str, value: str) -> None:
        with self._lock, closing(self._conn()) as c, c:
            c.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, value))

    def all_trades(self) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            rows = c.execute("SELECT * FROM trades ORDER BY id").fetchall()
        return [self._trade(r) for r in rows]

    def put_variant(self, trade_id: int, variant: str, state: dict[str, Any], result: dict[str, Any] | None = None, done: bool = False) -> None:
        """Insert or replace one variant of a position (its running state, and its result when the position is settled)."""
        with self._lock, closing(self._conn()) as c, c:
            c.execute("DELETE FROM results WHERE trade_id=? AND variant=?", (trade_id, variant))
            if result is None:
                c.execute("INSERT INTO results (trade_id, variant, state, done) VALUES (?,?,?,?)", (trade_id, variant, json.dumps(state, separators=(",", ":")), 1 if done else 0))
            else:
                c.execute(
                    "INSERT INTO results (trade_id, variant, state, done, ce_exit, pe_exit, gross, cost, net, worst, reason, stopped_at) VALUES (?,?,?,1,?,?,?,?,?,?,?,?)",
                    (trade_id, variant, json.dumps(state, separators=(",", ":")), result["ce_exit"], result["pe_exit"], result["gross"], result["cost"], result["net"], result["worst"], result["reason"], result["stopped_at"]),
                )

    def open_trades(self) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            rows = c.execute("SELECT * FROM trades WHERE status='open' ORDER BY id").fetchall()
        return [self._trade(r) for r in rows]

    @staticmethod
    def _trade(r: sqlite3.Row) -> dict[str, Any]:
        d = dict(r)
        d["context"], d["track"], d["eod"] = json.loads(d["context"]), json.loads(d["track"]), (json.loads(d["eod"]) if d["eod"] else None)
        return d

    def variants_of(self, trade_id: int) -> dict[str, dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            rows = c.execute("SELECT * FROM results WHERE trade_id=?", (trade_id,)).fetchall()
        out = {}
        for r in rows:
            d = dict(r)
            d["state"] = json.loads(d["state"])
            out[d["variant"]] = d
        return out

    def save_progress(self, trade_id: int, last_sample_ms: int, track: dict[str, Any], states: dict[str, dict[str, Any]]) -> None:
        with self._lock, closing(self._conn()) as c, c:
            c.execute("UPDATE trades SET last_sample_ms=?, track=? WHERE id=?", (last_sample_ms, json.dumps(track, separators=(",", ":")), trade_id))
            for v, st in states.items():
                c.execute("UPDATE results SET state=? WHERE trade_id=? AND variant=?", (json.dumps(st, separators=(",", ":")), trade_id, v))

    def settle_trade(self, trade_id: int, at: datetime, eod: dict[str, Any], results: dict[str, dict[str, Any] | None]) -> None:
        with self._lock, closing(self._conn()) as c, c:
            for v, r in results.items():
                if r is None:
                    c.execute("UPDATE results SET done=1 WHERE trade_id=? AND variant=?", (trade_id, v))
                else:
                    c.execute(
                        "UPDATE results SET done=1, ce_exit=?, pe_exit=?, gross=?, cost=?, net=?, worst=?, reason=?, stopped_at=? WHERE trade_id=? AND variant=?",
                        (r["ce_exit"], r["pe_exit"], r["gross"], r["cost"], r["net"], r["worst"], r["reason"], r["stopped_at"], trade_id, v),
                    )
            c.execute("UPDATE trades SET status='settled', settled_at=?, eod=? WHERE id=?", (at.isoformat(timespec="seconds"), json.dumps(eod, separators=(",", ":")), trade_id))

    # ------------------------------------------------------------------ reading for the dashboards
    def settled(self) -> list[dict[str, Any]]:
        """Every settled position with its variants (``variants``: variant -> result row), oldest first."""
        with self._lock, closing(self._conn()) as c:
            trades = [self._trade(r) for r in c.execute("SELECT * FROM trades WHERE status='settled' ORDER BY trigger_at, id")]
            res: dict[int, dict[str, dict[str, Any]]] = {}
            for r in c.execute("SELECT trade_id, variant, ce_exit, pe_exit, gross, cost, net, worst, reason, stopped_at, state FROM results WHERE net IS NOT NULL"):
                row = dict(r)
                st = json.loads(row.pop("state"))
                row["ce_at"], row["pe_at"] = st.get("ce_at"), st.get("pe_at")  # when each leg closed (None: at the close)
                res.setdefault(r["trade_id"], {})[r["variant"]] = row
        for t in trades:
            t["variants"] = res.get(t["id"], {})
        return trades

    def arm_cohorts(self, session: str) -> dict[str, dict[str, Any]]:
        """Every cohort with an arming row today, with the expiry of its latest position (the page can say what happened even after a restart)."""
        with self._lock, closing(self._conn()) as c:
            out = {r["cohort"]: {"count": r["count"], "armed": bool(r["armed"]), "below_since": r["below_since"], "expiry": None} for r in c.execute("SELECT * FROM arm WHERE session=?", (session,))}
            for r in c.execute("SELECT cohort, expiry FROM trades WHERE session=? ORDER BY id", (session,)):
                out.setdefault(r["cohort"], {"count": 0, "armed": True, "below_since": None, "expiry": None})["expiry"] = r["expiry"]
        return out

    def session_triggers(self, session: str) -> list[dict[str, Any]]:
        """The triggers of one day: for each cohort and trigger number, when it opened (each trigger makes a straddle and a strangle)."""
        with self._lock, closing(self._conn()) as c:
            rows = c.execute("SELECT cohort, n, MIN(trigger_at) AS at, COUNT(*) AS positions FROM trades WHERE session=? GROUP BY cohort, n ORDER BY at", (session,)).fetchall()
        return [dict(r) for r in rows]

    def counts(self) -> dict[str, int]:
        with self._lock, closing(self._conn()) as c:
            return {
                "open": c.execute("SELECT COUNT(*) FROM trades WHERE status='open'").fetchone()[0],
                "settled": c.execute("SELECT COUNT(*) FROM trades WHERE status='settled'").fetchone()[0],
                "days": c.execute("SELECT COUNT(DISTINCT session) FROM trades").fetchone()[0],
            }

    def add_run(self, at: datetime, ok: bool, detail: dict[str, Any]) -> None:
        with self._lock, closing(self._conn()) as c, c:
            c.execute("INSERT INTO runs (at, ok, detail) VALUES (?,?,?)", (at.isoformat(timespec="seconds"), 1 if ok else 0, json.dumps(detail, separators=(",", ":"))))
            c.execute("DELETE FROM runs WHERE id < (SELECT MAX(id) - 500 FROM runs)")  # a log, not data: the last 500 runs

    def last_run(self) -> dict[str, Any] | None:
        with self._lock, closing(self._conn()) as c:
            r = c.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
        return None if r is None else {"at": r["at"], "ok": bool(r["ok"]), "detail": json.loads(r["detail"])}

    def size_bytes(self) -> int:
        return sum(p.stat().st_size for s in ("", "-wal") if (p := Path(str(self.path) + s)).exists())
