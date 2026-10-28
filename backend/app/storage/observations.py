"""Compact, persistent market observations (separate from the snapshot files).

One ``samples`` row per chain fetch (what was observed, when we received it, from where) and one
``contracts`` row per option contract whose values changed. A fetch that equals the previous one is
stored as an ``unchanged`` sample with no contract rows: the time is still covered (the chain WAS
fetched and WAS identical), so replay can tell "no change" from "no data".

Rules: missing values are NULL, never 0; prices are integer paise; times are epoch milliseconds UTC;
nothing is deleted here (retention is a user-approved task). Single writer (the backend process).
"""

from __future__ import annotations

import hashlib
import sqlite3
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.domain.models import OptionChainSnapshot, OptionQuote

_SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
  sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  underlying TEXT NOT NULL,
  expiry TEXT NOT NULL,
  received_ms INTEGER NOT NULL,
  provider_ms INTEGER,
  spot_p INTEGER,
  prev_close_p INTEGER,
  lot_size INTEGER,
  unchanged INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  fp TEXT
);
CREATE INDEX IF NOT EXISTS ix_samples_lookup ON samples(underlying, expiry, received_ms);
CREATE TABLE IF NOT EXISTS contracts (
  sample_id INTEGER NOT NULL,
  strike REAL NOT NULL,
  side INTEGER NOT NULL,
  ltp_p INTEGER,
  oi INTEGER,
  oi_prev INTEGER,
  volume INTEGER,
  PRIMARY KEY (sample_id, strike, side)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts_ms);
"""

CALL, PUT = 0, 1


def fingerprint(snap: OptionChainSnapshot) -> str:
    """Hash of what the market said (spot, prices, OI, volume), ignoring ids and times."""
    return hashlib.sha256(
        snap.model_dump_json(include={"underlying_ltp", "rows"}).encode()
    ).hexdigest()


def to_ms(dt: datetime) -> int:
    return int(dt.astimezone(UTC).timestamp() * 1000)


def from_ms(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


def _paise(v: float | None) -> int | None:
    return None if v is None else round(v * 100)


def _int(v: float | None) -> int | None:
    return None if v is None else round(v)


@dataclass(frozen=True)
class Contract:
    ltp: float | None
    oi: int | None
    oi_prev: int | None
    volume: int | None


@dataclass(frozen=True)
class Sample:
    sample_id: int
    expiry: str
    received_at: datetime
    spot: float | None
    prev_close: float | None
    unchanged: bool
    source: str
    fp: str | None
    #: sample holding this sample's contract values (itself, or the last changed one before)
    values_from: int


class ObservationStore:
    def __init__(self, data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "observations.sqlite3"
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.execute("PRAGMA busy_timeout=5000")
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ------------------------------------------------------------------ writing
    def record_snapshot(
        self, snap: OptionChainSnapshot, *, unchanged: bool, source: str = "rest_chain"
    ) -> int | None:
        """Store one chain observation. Idempotent per snapshot_id. Returns the sample id."""
        with self._lock:
            sid = snap.snapshot_id  # also for 'unchanged' fetches: makes re-imports idempotent
            row = self._db.execute(
                "SELECT sample_id FROM samples WHERE snapshot_id=?", (sid,)
            ).fetchone()
            if row:
                return int(row[0])
            cur = self._db.execute(
                "INSERT INTO samples(snapshot_id, session_id, underlying, expiry, received_ms,"
                " provider_ms, spot_p, prev_close_p, lot_size, unchanged, source, fp)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    sid,
                    snap.session_id,
                    snap.underlying,
                    snap.expiry.isoformat(),
                    to_ms(snap.retrieved_at),
                    to_ms(snap.exchange_timestamp) if snap.exchange_timestamp else None,
                    _paise(snap.underlying_ltp),
                    _paise(snap.underlying_prev_close),
                    _int(snap.lot_size),
                    1 if unchanged else 0,
                    source,
                    fingerprint(snap),
                ),
            )
            sample_id = int(cur.lastrowid or 0)
            if not unchanged:
                self._db.executemany(
                    "INSERT INTO contracts VALUES (?,?,?,?,?,?,?)",
                    list(self._contract_rows(sample_id, snap)),
                )
            self._db.commit()
            return sample_id

    @staticmethod
    def _contract_rows(sample_id: int, snap: OptionChainSnapshot) -> Iterable[tuple[Any, ...]]:
        for r in snap.rows:
            for side, q in ((CALL, r.call), (PUT, r.put)):
                if q is None:
                    continue
                yield (
                    sample_id, r.strike, side, _paise(q.ltp), _int(q.oi), _int(q.oi_previous),
                    _int(q.volume),
                )  # fmt: skip

    def record_event(self, kind: str, detail: str, session_id: str | None = None) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO events(ts_ms, session_id, kind, detail) VALUES (?,?,?,?)",
                (to_ms(datetime.now(UTC)), session_id, kind, detail[:300]),
            )
            self._db.commit()

    # ------------------------------------------------------------------ reading
    def samples(
        self,
        underlying: str,
        expiry: str,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        limit: int = 5000,
    ) -> list[Sample]:
        """Samples oldest first. Each carries ``values_from`` (where its contract values live)."""
        q = (
            "SELECT sample_id, received_ms, spot_p, prev_close_p, unchanged, source, fp"
            " FROM samples"
            " WHERE underlying=? AND expiry=?"
        )
        args: list[Any] = [underlying, expiry]
        if since:
            q += " AND received_ms>=?"
            args.append(to_ms(since))
        if until:
            q += " AND received_ms<=?"
            args.append(to_ms(until))
        q += " ORDER BY received_ms DESC, sample_id DESC LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self._db.execute(q, args).fetchall()
            first_ms = rows[-1][1] if rows else None
            carry: int | None = None
            if first_ms is not None and rows[-1][4]:
                # the oldest sample in range is 'unchanged': find the sample that holds its values
                prev = self._db.execute(
                    "SELECT sample_id FROM samples WHERE underlying=? AND expiry=? AND unchanged=0"
                    " AND (received_ms<? OR (received_ms=? AND sample_id<?))"
                    " ORDER BY received_ms DESC, sample_id DESC LIMIT 1",
                    (underlying, expiry, first_ms, first_ms, rows[-1][0]),
                ).fetchone()
                carry = int(prev[0]) if prev else None
        out: list[Sample] = []
        for sid, ms, spot_p, prev_p, unch, src, fp in reversed(rows):
            if not unch:
                carry = int(sid)
            if carry is None:
                continue  # an 'unchanged' sample with no earlier values cannot be resolved
            out.append(
                Sample(
                    int(sid),
                    expiry,
                    from_ms(ms),
                    None if spot_p is None else spot_p / 100,
                    None if prev_p is None else prev_p / 100,
                    bool(unch),
                    src,
                    fp,
                    carry,
                )
            )
        return out

    def contracts(self, sample_id: int) -> dict[tuple[float, int], Contract]:
        with self._lock:
            rows = self._db.execute(
                "SELECT strike, side, ltp_p, oi, oi_prev, volume FROM contracts WHERE sample_id=?",
                (sample_id,),
            ).fetchall()
        return {
            (float(s), int(side)): Contract(None if p is None else p / 100, oi, oi_prev, vol)
            for s, side, p, oi, oi_prev, vol in rows
        }

    def events(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._db.execute(
                "SELECT ts_ms, session_id, kind, detail FROM events ORDER BY event_id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {"at": from_ms(ts).isoformat(), "session_id": s, "kind": k, "detail": d}
            for ts, s, k, d in rows
        ]

    def known_snapshot_ids(self) -> set[str]:
        with self._lock:
            return {
                r[0]
                for r in self._db.execute(
                    "SELECT snapshot_id FROM samples WHERE snapshot_id IS NOT NULL"
                )
            }

    def stats(self) -> dict[str, Any]:
        with self._lock:
            n_s, n_c, first, last = self._db.execute(
                "SELECT (SELECT COUNT(*) FROM samples), (SELECT COUNT(*) FROM contracts),"
                " (SELECT MIN(received_ms) FROM samples), (SELECT MAX(received_ms) FROM samples)"
            ).fetchone()
            n_e = self._db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        wal = Path(str(self.path) + "-wal")
        return {
            "samples": n_s,
            "contract_rows": n_c,
            "events": n_e,
            "first_at": None if first is None else from_ms(first).isoformat(),
            "last_at": None if last is None else from_ms(last).isoformat(),
            "db_bytes": self.path.stat().st_size if self.path.exists() else 0,
            "wal_bytes": wal.stat().st_size if wal.exists() else 0,
        }


def quote_values(q: OptionQuote | None) -> Contract | None:
    if q is None:
        return None
    return Contract(q.ltp, _int(q.oi), _int(q.oi_previous), _int(q.volume))
