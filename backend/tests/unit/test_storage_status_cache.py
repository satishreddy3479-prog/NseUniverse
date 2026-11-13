"""The storage report walks every stored file (about 7 s on the server), so /api/storage/status reuses it for two minutes.
What must never be cached is the free disk space: a disk that fills up has to show at once."""

from __future__ import annotations

import shutil
import time
from collections import namedtuple
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import routes
from app.lifecycle import storage
from tests.conftest import make_app

Usage = namedtuple("Usage", "total used free")


def test_the_file_walk_is_reused_but_the_disk_figures_are_always_fresh(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}
    real = storage.report

    def counting(*a: object, **k: object):  # type: ignore[no-untyped-def]
        calls["n"] += 1
        return real(*a, **k)

    monkeypatch.setattr(storage, "report", counting)
    free = {"v": 50_000_000_000}
    monkeypatch.setattr(shutil, "disk_usage", lambda _p: Usage(100_000_000_000, 100_000_000_000 - free["v"], free["v"]))
    routes._storage_cache.clear()  # noqa: SLF001 - a clean start
    with TestClient(make_app(tmp_path)) as c:
        first = c.get("/api/storage/status").json()
        free["v"] = 1_000_000_000  # the disk fills up between two looks
        second = c.get("/api/storage/status").json()
    assert calls["n"] == 1  # the second look did not walk the files again
    assert first["data_dir_bytes"] == second["data_dir_bytes"]
    assert first["disk"]["free_gb"] == 50.0 and second["disk"]["free_gb"] == 1.0  # ...but saw the new free space
    assert second["pressure"] == "critical" and first["pressure"] == "ok"


def test_the_cache_expires(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}
    real = storage.report
    monkeypatch.setattr(storage, "report", lambda *a, **k: (calls.__setitem__("n", calls["n"] + 1), real(*a, **k))[1])
    routes._storage_cache.clear()  # noqa: SLF001
    with TestClient(make_app(tmp_path)) as c:
        c.get("/api/storage/status")
        monkeypatch.setattr(routes, "_STORAGE_TTL_SECONDS", 0.0)
        c.get("/api/storage/status")
    assert calls["n"] == 2


def test_a_slow_read_only_answer_is_built_once_for_calls_that_overlap_and_again_after_it_expires() -> None:
    import threading
    import time

    built = {"n": 0}

    def slow() -> dict[str, int]:
        built["n"] += 1
        time.sleep(0.2)
        return {"n": built["n"]}

    routes._ttl_cache.clear()  # noqa: SLF001
    out: list[dict[str, int]] = []
    ts = [threading.Thread(target=lambda: out.append(routes._cached("k", 60.0, slow))) for _ in range(4)]  # noqa: SLF001
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert built["n"] == 1 and all(o == {"n": 1} for o in out)  # four overlapping callers, one build
    assert routes._cached("k", 0.0, slow) == {"n": 2}  # noqa: SLF001 - expired: built again


def test_cleaning_up_data_drops_the_cached_overview(tmp_path: Path) -> None:
    routes._ttl_cache["cleanup|x|2026-11-13"] = (time.monotonic(), {"old": True})  # noqa: SLF001
    with TestClient(make_app(tmp_path), client=("127.0.0.1", 50000)) as c:  # the cleanup endpoint only answers local clients
        assert c.post("/api/storage/cleanup", json={"items": ["regenerable"], "confirm": True}).status_code == 200
    assert not [k for k in routes._ttl_cache if k.startswith("cleanup|")]  # noqa: SLF001
