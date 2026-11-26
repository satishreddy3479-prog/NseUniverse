"""One read-only connection per thread, so reads of a SQLite file run beside the writer and beside each other.

The stores used one shared connection behind a Python lock for everything: a long read (a scan of a whole table, a strike series) made every other read and every write wait, including the
per-tick token lookups of the live feed (26 Nov 2026: stalls with the loop thread waiting on that lock). With the database in WAL mode a reader never blocks the writer and sees the
last committed state each time it starts a statement, so reading needs no lock at all. Writes stay on the one locked connection, as before.

Closing: a connection must never be closed while another thread is inside a statement on it (SQLite then crashes the whole process: seen in a test run that shut an application down while
a background thread was reading). ``close`` therefore refuses new reads, waits for the reads in progress to finish, and only then closes every connection.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

CLOSE_WAIT_S = 10.0


class Readers:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._local = threading.local()
        self._all: list[sqlite3.Connection] = []
        self._cond = threading.Condition()
        self._active = 0
        self._closed = False

    def _open(self) -> sqlite3.Connection:
        # read-only; each connection is only ever used by the thread that opened it, and only while it holds an "active" mark (see __call__)
        c = sqlite3.connect(f"file:{self._path.as_posix()}?mode=ro", uri=True, timeout=5, check_same_thread=False)
        c.execute("PRAGMA busy_timeout=5000")
        with self._cond:
            self._all.append(c)
        return c

    @contextmanager
    def __call__(self) -> Iterator[sqlite3.Connection]:
        with self._cond:
            if self._closed:
                raise sqlite3.ProgrammingError("the store is closed")
            self._active += 1
        try:
            conn: sqlite3.Connection | None = getattr(self._local, "conn", None)
            if conn is None:
                conn = self._local.conn = self._open()
            yield conn
        finally:
            with self._cond:
                self._active -= 1
                self._cond.notify_all()

    def close(self) -> None:
        """Refuse new reads, wait for the reads in progress (at most ``CLOSE_WAIT_S``), then close every connection."""
        with self._cond:
            self._closed = True
            self._cond.wait_for(lambda: self._active == 0, timeout=CLOSE_WAIT_S)
            if self._active:  # a read that never finished: leave its connection open rather than crash the process
                busy = True
            else:
                busy = False
            conns, self._all = ([], self._all) if busy else (self._all, [])
        for c in conns:
            try:
                c.close()
            except sqlite3.Error:
                pass
