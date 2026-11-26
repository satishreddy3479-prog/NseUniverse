"""A record of how the server itself is doing, one row a minute (data/runtime.sqlite3).

Until 26 Nov 2026 there was no history of CPU, memory, event-loop delay or message rates: an audit of a bad open had to work from sampled stack traces. Each minute this stores the process
CPU (percent of one core), resident memory, threads, the loop's delay and stalls in that minute, the messages the feed delivered for the options (and the index) and for the market
instruments (stocks and futures), repeated ticks, what the feed discarded, the browser clients and the age of the newest market data. A few KB a day; 45 days are kept.
Reading it needs no tools on the server: ``GET /api/runtime/metrics``.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import sqlite3
import threading
import time
from collections.abc import Callable
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)
KEEP_DAYS = 45
COLUMNS = (
    "ts", "cpu_pct", "rss_mb", "threads", "load1", "lag_p99_ms", "lag_max_ms", "stalls", "msgs_options", "msgs_market", "duplicates", "dropped", "clients", "data_age_s",
)
SCHEMA = """
CREATE TABLE IF NOT EXISTS minute (
  ts TEXT PRIMARY KEY, cpu_pct REAL, rss_mb REAL, threads INTEGER, load1 REAL, lag_p99_ms REAL, lag_max_ms REAL, stalls INTEGER,
  msgs_options INTEGER, msgs_market INTEGER, duplicates INTEGER, dropped INTEGER, clients INTEGER, data_age_s REAL);
"""


class _Loop(Protocol):
    stalls: int

    def stats(self) -> dict[str, Any]: ...


class _Stream(Protocol):
    message_count: int
    market_message_count: int
    duplicate_count: int
    hub: Any
    _feed: Any

    def status(self) -> Any: ...


def rss_mb() -> float | None:
    """Resident memory of this process in MB (Linux), or None where it cannot be read."""
    try:
        with open("/proc/self/status", encoding="ascii") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return round(int(line.split()[1]) / 1024, 1)
    except (OSError, ValueError, IndexError):
        pass
    return None


class MetricsStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = Path(data_dir) / "runtime.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with closing(self._conn()) as c, c:
            c.executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        return c

    def add(self, row: dict[str, Any], now: datetime) -> None:
        with self._lock, closing(self._conn()) as c, c:
            c.execute(f"INSERT OR REPLACE INTO minute VALUES ({','.join('?' * len(COLUMNS))})", tuple(row[k] for k in COLUMNS))  # noqa: S608 - our own column names
            c.execute("DELETE FROM minute WHERE ts < ?", ((now - timedelta(days=KEEP_DAYS)).isoformat(timespec="minutes"),))

    def series(self, since: datetime) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            return [dict(r) for r in c.execute("SELECT * FROM minute WHERE ts >= ? ORDER BY ts", (since.isoformat(timespec="minutes"),))]


class RuntimeMetrics:
    def __init__(self, store: MetricsStore, loopwatch: _Loop | None, stream: _Stream | None, clock: Callable[[], datetime] | None = None) -> None:
        self.store, self._lw, self._stream = store, loopwatch, stream
        self._clock = clock or (lambda: datetime.now(UTC))
        self._task: asyncio.Task[None] | None = None
        self._prev: dict[str, float] | None = None
        self._cpu0, self._wall0 = time.process_time(), time.monotonic()
        self.last_error: str | None = None

    def collect(self) -> dict[str, Any]:
        """One row: rates are the change since the previous call, so the first call has none (None) and the rest cover one minute each."""
        now_cpu, now_wall = time.process_time(), time.monotonic()
        cpu = None if now_wall - self._wall0 < 1 else round((now_cpu - self._cpu0) / (now_wall - self._wall0) * 100, 1)
        self._cpu0, self._wall0 = now_cpu, now_wall
        st, lw = self._stream, self._lw
        cur: dict[str, float] = {
            "stalls": float(getattr(lw, "stalls", 0)) if lw else 0.0,
            "opt": float(getattr(st, "message_count", 0)) if st else 0.0,
            "mkt": float(getattr(st, "market_message_count", 0)) if st else 0.0,
            "dup": float(getattr(st, "duplicate_count", 0)) if st else 0.0,
            "drop": float(sum((getattr(getattr(st, "_feed", None), "dropped_by_kind", None) or {}).values())) if st else 0.0,
        }
        prev = self._prev

        def d(k: str) -> int | None:
            # a counter that went backwards (a new feed session after a reconnect) is not a negative rate
            return None if prev is None else int(max(0.0, cur[k] - prev[k]))

        self._prev = cur
        lag = lw.stats() if lw else {}
        try:
            data_age = st.status().data_age_seconds if st else None
        except Exception:  # noqa: BLE001 - a metric is never worth a failure
            data_age = None
        getload = getattr(os, "getloadavg", None)  # not on Windows
        try:
            load1 = None if getload is None else round(getload()[0], 2)
        except OSError:
            load1 = None
        return {
            "ts": self._clock().astimezone(UTC).isoformat(timespec="minutes"), "cpu_pct": cpu, "rss_mb": rss_mb(), "threads": threading.active_count(), "load1": load1,
            "lag_p99_ms": lag.get("lag_ms_p99_60s"), "lag_max_ms": lag.get("lag_ms_max_60s"), "stalls": d("stalls"), "msgs_options": d("opt"), "msgs_market": d("mkt"),
            "duplicates": d("dup"), "dropped": d("drop"), "clients": len(st.hub) if st is not None and st.hub is not None else None, "data_age_s": data_age,
        }

    def record(self) -> dict[str, Any]:
        row = self.collect()
        self.store.add(row, self._clock())
        return row

    async def _loop(self) -> None:
        while True:
            now = self._clock()
            await asyncio.sleep(60.0 - (now.second + now.microsecond / 1e6) + 1.0)  # one second into every minute
            try:
                await asyncio.to_thread(self.record)
                self.last_error = None
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - the recorder must never disturb the application
                self.last_error = f"{type(e).__name__}: {e}"[:200]
                logger.warning("runtime_metrics_failed", extra={"fields": {"error": self.last_error}})

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="runtime-metrics")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    def view(self, minutes: int) -> dict[str, Any]:
        """The recent rows with a summary of the window (the figures worth reading first)."""
        rows = self.store.series(self._clock() - timedelta(minutes=minutes))

        def col(k: str) -> list[float]:
            return [r[k] for r in rows if r.get(k) is not None]

        def top(xs: list[float], p: float) -> float | None:
            return None if not xs else sorted(xs)[min(len(xs) - 1, int(len(xs) * p))]

        cpu, lag = col("cpu_pct"), col("lag_p99_ms")
        return {
            "minutes": len(rows),
            "summary": {
                "cpu_pct_avg": None if not cpu else round(sum(cpu) / len(cpu), 1), "cpu_pct_p95": top(cpu, 0.95), "cpu_pct_max": max(cpu, default=None),
                "rss_mb_max": max(col("rss_mb"), default=None), "lag_p99_ms_worst": max(lag, default=None), "lag_p99_ms_median": top(lag, 0.5),
                "stalls": int(sum(col("stalls"))), "msgs_options": int(sum(col("msgs_options"))), "msgs_market": int(sum(col("msgs_market"))), "duplicates": int(sum(col("duplicates"))),
                "dropped": int(sum(col("dropped"))), "clients_max": max(col("clients"), default=None),
            },
            "rows": rows,
        }
