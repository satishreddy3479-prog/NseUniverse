"""A small pool of read-only connections, so reads of a SQLite file run beside the writer and beside each other.

The stores used one shared connection behind a Python lock for everything: a long read (a scan of a whole table, a strike series) made every other read and every write wait, including the
per-tick token lookups of the live feed (26 Nov 2026: stalls with the loop thread waiting on that lock). With the database in WAL mode a reader never blocks the writer and sees the
last committed state each time it starts a statement, so reading needs no lock at all. Writes stay on the one locked connection, as before.

Pool, not one connection per thread (27 Nov 2026): the first version opened a connection for every thread that read and kept it forever; threads that came and went (background jobs)
left their connections behind, and in a day the server ran out of open files (1,024: about 480 of them were these connections) and every database call failed. A read now borrows a free
connection (or opens one) and gives it back; at most ``MAX_IDLE`` stay open, so the count follows the number of reads running at once, not the number of threads that ever read.

Closing: a connection must never be closed while another thread is inside a statement on it (SQLite then crashes the whole process). ``close`` therefore refuses new reads, waits for
the reads in progress to finish, and only then closes every connection.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

CLOSE_WAIT_S = 10.0
MAX_IDLE = 4


class Readers:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._free: list[sqlite3.Connection] = []
        self._cond = threading.Condition()
        self._active = 0
        self._closed = False

    def _open(self) -> sqlite3.Connection:
        # read-only; a connection is used by one thread at a time (borrowed in __call__), so passing it between threads over time is safe
        c = sqlite3.connect(f"file:{self._path.as_posix()}?mode=ro", uri=True, timeout=5, check_same_thread=False)
        c.execute("PRAGMA busy_timeout=5000")
        return c

    @contextmanager
    def __call__(self) -> Iterator[sqlite3.Connection]:
        with self._cond:
            if self._closed:
                raise sqlite3.ProgrammingError("the store is closed")
            self._active += 1
            conn = self._free.pop() if self._free else None
        try:
            if conn is None:
                conn = self._open()
            yield conn
        finally:
            surplus: sqlite3.Connection | None = None
            with self._cond:
                self._active -= 1
                if conn is not None and not self._closed and len(self._free) < MAX_IDLE:
                    self._free.append(conn)
                else:
                    surplus = conn
                self._cond.notify_all()
            if surplus is not None:
                try:
                    surplus.close()
                except sqlite3.Error:
                    pass

    def idle_count(self) -> int:
        """Connections waiting in the pool (the ones in use are not counted)."""
        with self._cond:
            return len(self._free)

    def close(self) -> None:
        """Refuse new reads, wait for the reads in progress (at most ``CLOSE_WAIT_S``), then close the idle connections."""
        with self._cond:
            self._closed = True
            self._cond.wait_for(lambda: self._active == 0, timeout=CLOSE_WAIT_S)
            conns, self._free = self._free, []
        for c in conns:
            try:
                c.close()
            except sqlite3.Error:
                pass
