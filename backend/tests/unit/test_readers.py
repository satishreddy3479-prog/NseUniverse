"""Reads of the busiest stores run beside the writer and beside each other (WAL, one read-only connection per thread)."""

from __future__ import annotations

import threading
import time
from datetime import date
from pathlib import Path

import pytest

from app.market.sources import TokenInfo
from app.market.store import MarketStore
from app.storage.observations import ObservationStore
from app.storage.readers import Readers


def tokens() -> dict[str, TokenInfo]:
    return {"RELIANCE": TokenInfo("RELIANCE", "2885", "RELIANCE-EQ"), "FUT:NIFTY": TokenInfo("FUT:NIFTY", "55001", "NIFTY26DECFUT")}


def test_a_read_does_not_wait_for_a_long_write_that_holds_the_stores_lock(tmp_path: Path) -> None:
    """26 Nov 2026: per-tick lookups waited on the shared lock behind long reads and writes. Reads now take no lock."""
    store = MarketStore(tmp_path)
    store.save_tokens(tokens(), date(2026, 11, 26))
    holding, release = threading.Event(), threading.Event()

    def writer() -> None:
        with store._lock:  # a long write in progress
            holding.set()
            release.wait(5)

    t = threading.Thread(target=writer)
    t.start()
    assert holding.wait(2)
    t0 = time.perf_counter()
    got = store.latest_tokens()  # on this thread, while the lock is held elsewhere
    waited = time.perf_counter() - t0
    release.set()
    t.join()
    assert got is not None and set(got[0]) == {"RELIANCE", "FUT:NIFTY"} and got[1] == "2026-11-26"
    assert waited < 0.5, f"the read waited {waited:.2f} s for the write lock"


def test_a_reader_sees_what_the_writer_committed_at_once_and_each_thread_has_its_own_connection(tmp_path: Path) -> None:
    store = MarketStore(tmp_path)
    assert store.latest_tokens() is None
    store.save_tokens(tokens(), date(2026, 11, 26))
    assert store.latest_tokens() is not None  # no stale snapshot kept between calls
    store.save_tokens({"TCS": TokenInfo("TCS", "11536", "TCS-EQ")}, date(2026, 11, 27))
    latest = store.latest_tokens()
    assert latest is not None and set(latest[0]) == {"TCS"} and latest[1] == "2026-11-27"
    ids: set[int] = set()

    def read() -> None:
        with store._reader() as c:
            ids.add(id(c))

    threads = [threading.Thread(target=read) for _ in range(3)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    with store._reader() as mine:
        ids.add(id(mine))
    assert len(ids) == 4  # one connection per thread


def test_the_connections_are_read_only_and_closed_with_the_store(tmp_path: Path) -> None:
    obs = ObservationStore(tmp_path)
    obs.record_event("started", "x")
    assert any(e["kind"] == "started" for e in obs.events())  # a reader sees the committed event
    with obs._reader() as c, pytest.raises(Exception, match="readonly|read-only|attempt to write"):
        c.execute("INSERT INTO events(ts_ms, session_id, kind, detail) VALUES (1, 's', 'k', 'd')")
    obs.close()
    with pytest.raises(Exception):  # noqa: B017, PT011 - any error: a closed store gives no reader
        with obs._reader() as c2:
            c2.execute("SELECT 1")


def test_readers_class_refuses_new_connections_after_close(tmp_path: Path) -> None:
    import sqlite3

    path = tmp_path / "x.sqlite3"
    c = sqlite3.connect(path)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("CREATE TABLE t (a)")
    c.execute("INSERT INTO t VALUES (1)")
    c.commit()
    readers = Readers(path)
    with readers() as r:
        assert r.execute("SELECT a FROM t").fetchone() == (1,)
    readers.close()
    with pytest.raises(sqlite3.ProgrammingError), readers():
        pass
    c.close()
