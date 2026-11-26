"""One read-only connection per thread, so reads of a SQLite file run beside the writer and beside each other.

The stores used one shared connection behind a Python lock for everything: a long read (a scan of a whole table, a strike series) made every other read and every write wait, including the
per-tick token lookups of the live feed (26 Nov 2026: stalls with the loop thread waiting on that lock). With the database in WAL mode a reader never blocks the writer and sees the
last committed state each time it starts a statement, so reading needs no lock at all. Writes stay on the one locked connection, as before.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


class Readers:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._local = threading.local()
        self._all: list[sqlite3.Connection] = []
        self._guard = threading.Lock()
        self._closed = False

    def _open(self) -> sqlite3.Connection:
        # read-only, usable from the thread that opened it (and closed from any other at shutdown)
        c = sqlite3.connect(f"file:{self._path.as_posix()}?mode=ro", uri=True, timeout=5, check_same_thread=False)
        c.execute("PRAGMA busy_timeout=5000")
        with self._guard:
            if self._closed:
                c.close()
                raise sqlite3.ProgrammingError("the store is closed")
            self._all.append(c)
        return c

    @contextmanager
    def __call__(self) -> Iterator[sqlite3.Connection]:
        conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._local.conn = self._open()
        yield conn

    def close(self) -> None:
        with self._guard:
            self._closed = True
            conns, self._all = self._all, []
        for c in conns:
            try:
                c.close()
            except sqlite3.Error:
                pass
        self._local = threading.local()
