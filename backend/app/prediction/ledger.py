"""Append-only forecast ledger (separate tables for T+1 and T+5).

A forecast is written once, before its target session opens, and can never be changed or deleted:
SQLite triggers abort any UPDATE or DELETE. The realized outcome goes in a separate append-once
table and can be attached only after the target horizon has completed. A content hash lets
anyone verify that a stored forecast was not altered. Nothing here is ever regenerated "with
hindsight": the forecast id is derived from model, reference session and cutoff, so the
same forecast cannot be written twice.
"""
# ruff: noqa: S608  (table names come from the fixed HORIZONS whitelist via _tbl(); values are bound)

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Literal

from app.prediction.pit import IST

Horizon = Literal["T1", "T5"]
HORIZONS: tuple[Horizon, ...] = ("T1", "T5")
OPEN_TIME = (9, 15)  # regular session open, IST
CLOSE_TIME = (15, 40)  # derivatives session close since 3 Aug 2026, IST


class LedgerError(Exception):
    pass


def _ist_dt(d: date, hm: tuple[int, int]) -> datetime:
    return datetime(d.year, d.month, d.day, hm[0], hm[1], tzinfo=IST)


def _canon(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)


@dataclass(frozen=True)
class Forecast:
    horizon: Horizon
    model_name: str
    model_version: str
    dataset_version: str
    feature_version: str
    cutoff: datetime  # information cutoff the features obey
    generated_at: datetime  # when the forecast was produced
    reference_session: date  # t, the last completed regular session
    reference_price: float  # NIFTY close at t
    first_target_session: date  # the session the forecast is made for (t+1)
    target_session: date  # t+1 for T1, t+5 for T5
    payload: dict[str, Any]  # probabilities, expected return, intervals, ...
    data_quality: dict[str, Any] = field(default_factory=dict)
    excluded_inputs: list[str] = field(
        default_factory=list
    )  # inputs left out because not yet published

    @property
    def forecast_id(self) -> str:
        c = self.cutoff.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
        return f"{self.horizon}-{self.model_name}-{self.model_version}-{self.reference_session}-{c}"

    def content(self) -> dict[str, Any]:
        return {
            "forecast_id": self.forecast_id,
            "horizon": self.horizon,
            "model_name": self.model_name,
            "model_version": self.model_version,
            "dataset_version": self.dataset_version,
            "feature_version": self.feature_version,
            "cutoff": self.cutoff.astimezone(UTC).isoformat(),
            "generated_at": self.generated_at.astimezone(UTC).isoformat(),
            "reference_session": str(self.reference_session),
            "reference_price": self.reference_price,
            "first_target_session": str(self.first_target_session),
            "target_session": str(self.target_session),
            "payload": self.payload,
            "data_quality": self.data_quality,
            "excluded_inputs": self.excluded_inputs,
        }

    def content_hash(self) -> str:
        return hashlib.sha256(_canon(self.content()).encode()).hexdigest()


_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS {h}_forecasts (
  forecast_id TEXT PRIMARY KEY, content TEXT NOT NULL, content_hash TEXT NOT NULL,
  reference_session TEXT NOT NULL, target_session TEXT NOT NULL, generated_utc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS {h}_outcomes (
  forecast_id TEXT PRIMARY KEY REFERENCES {h}_forecasts(forecast_id),
  attached_utc TEXT NOT NULL, realized TEXT NOT NULL, status TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS {h}_forecasts_no_update BEFORE UPDATE ON {h}_forecasts
  BEGIN SELECT RAISE(ABORT, 'forecasts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS {h}_forecasts_no_delete BEFORE DELETE ON {h}_forecasts
  BEGIN SELECT RAISE(ABORT, 'forecasts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS {h}_outcomes_no_update BEFORE UPDATE ON {h}_outcomes
  BEGIN SELECT RAISE(ABORT, 'outcomes are append-once'); END;
CREATE TRIGGER IF NOT EXISTS {h}_outcomes_no_delete BEFORE DELETE ON {h}_outcomes
  BEGIN SELECT RAISE(ABORT, 'outcomes are append-once'); END;
"""


class ForecastLedger:
    def __init__(
        self, data_dir: Path, clock: Callable[[], datetime] = lambda: datetime.now(UTC)
    ) -> None:
        data_dir.mkdir(parents=True, exist_ok=True)
        self.path = data_dir / "forecasts.sqlite3"
        self._clock = clock
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA foreign_keys=ON")
        for h in HORIZONS:
            self._db.executescript(_TABLE_SQL.format(h=h.lower()))
        self._db.commit()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    @staticmethod
    def _tbl(h: str) -> str:
        if h not in HORIZONS:
            raise LedgerError(f"unknown horizon {h!r}")
        return h.lower()

    # ------------------------------------------------------------------ write
    def record(self, f: Forecast) -> str:
        """Store a forecast. Refuses anything that could not have been a genuine prior forecast."""
        now = self._clock()
        if f.cutoff.tzinfo is None or f.generated_at.tzinfo is None:
            raise LedgerError("timestamps must be timezone-aware")
        if f.cutoff > f.generated_at:
            raise LedgerError("cutoff is after generation time")
        if f.generated_at > now:
            raise LedgerError("generation time is in the future")
        if f.generated_at >= _ist_dt(f.first_target_session, OPEN_TIME):
            raise LedgerError("a forecast must be generated before its first target session opens")
        if (
            f.reference_session >= f.first_target_session
            or f.first_target_session > f.target_session
        ):
            raise LedgerError("session order must be reference < first target <= target")
        t = self._tbl(f.horizon)
        with self._lock:
            try:
                self._db.execute(
                    f"INSERT INTO {t}_forecasts VALUES (?,?,?,?,?,?)",
                    (f.forecast_id, _canon(f.content()), f.content_hash(), str(f.reference_session),
                     str(f.target_session), f.generated_at.astimezone(UTC).isoformat()),
                )  # fmt: skip
                self._db.commit()
            except sqlite3.IntegrityError as e:
                raise LedgerError(
                    f"forecast {f.forecast_id} already exists; the ledger is append-only"
                ) from e
        return f.forecast_id

    def attach_outcome(
        self, horizon: Horizon, forecast_id: str, realized: dict[str, Any], status: str = "complete"
    ) -> None:
        """Attach the realized result. Allowed only once the target session has closed."""
        t = self._tbl(horizon)
        with self._lock:
            row = self._db.execute(
                f"SELECT target_session FROM {t}_forecasts WHERE forecast_id=?", (forecast_id,)
            ).fetchone()
            if row is None:
                raise LedgerError(f"no such forecast {forecast_id}")
            closes = _ist_dt(date.fromisoformat(row[0]), CLOSE_TIME)
            if self._clock() < closes:
                raise LedgerError(
                    "the target horizon has not completed; outcome cannot be attached yet"
                )
            try:
                self._db.execute(
                    f"INSERT INTO {t}_outcomes VALUES (?,?,?,?)",
                    (
                        forecast_id,
                        self._clock().astimezone(UTC).isoformat(),
                        _canon(realized),
                        status,
                    ),
                )
                self._db.commit()
            except sqlite3.IntegrityError as e:
                self._db.rollback()
                raise LedgerError(f"outcome for {forecast_id} already attached") from e

    # ------------------------------------------------------------------ read
    def get(self, horizon: Horizon, forecast_id: str) -> dict[str, Any] | None:
        t = self._tbl(horizon)
        with self._lock:
            row = self._db.execute(
                f"SELECT content, content_hash FROM {t}_forecasts WHERE forecast_id=?",
                (forecast_id,),
            ).fetchone()
            out = self._db.execute(
                f"SELECT attached_utc, realized, status FROM {t}_outcomes WHERE forecast_id=?",
                (forecast_id,),
            ).fetchone()
        if row is None:
            return None
        content = json.loads(row[0])
        return {
            "forecast": content,
            "intact": hashlib.sha256(row[0].encode()).hexdigest() == row[1],
            "outcome": None if out is None else {
                "attached_at": out[0], "realized": json.loads(out[1]), "status": out[2]
            },
        }  # fmt: skip

    def list(self, horizon: Horizon, limit: int = 200) -> list[dict[str, Any]]:
        t = self._tbl(horizon)
        with self._lock:
            ids = [
                r[0]
                for r in self._db.execute(
                    f"SELECT forecast_id FROM {t}_forecasts ORDER BY generated_utc DESC LIMIT ?",
                    (limit,),
                )
            ]
        return [r for i in ids if (r := self.get(horizon, i)) is not None]

    def counts(self) -> dict[str, dict[str, int]]:
        with self._lock:
            return {
                h: {
                    "forecasts": self._db.execute(
                        f"SELECT COUNT(*) FROM {h.lower()}_forecasts"
                    ).fetchone()[0],
                    "outcomes": self._db.execute(
                        f"SELECT COUNT(*) FROM {h.lower()}_outcomes"
                    ).fetchone()[0],
                }
                for h in HORIZONS
            }
