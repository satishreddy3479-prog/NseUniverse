"""The per-minute record of how the server is doing (CPU, memory, loop delay, message rates)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.stream.runtime_metrics import MetricsStore, RuntimeMetrics, rss_mb

T0 = datetime(2026, 11, 26, 4, 0, tzinfo=UTC)


class Lw:
    stalls = 0

    def __init__(self) -> None:
        self.lag = {"lag_ms_p99_60s": 12.5, "lag_ms_max_60s": 40.0}

    def stats(self) -> dict[str, Any]:
        return self.lag


def stream() -> Any:
    return SimpleNamespace(message_count=0, market_message_count=0, duplicate_count=0, hub=[1, 2], _feed=SimpleNamespace(dropped_by_kind={}), status=lambda: SimpleNamespace(data_age_seconds=1.5))


def test_rows_hold_rates_for_the_minute_not_running_totals(tmp_path: Path) -> None:
    lw, st, now = Lw(), stream(), {"t": T0}
    m = RuntimeMetrics(MetricsStore(tmp_path), lw, st, clock=lambda: now["t"])
    first = m.record()
    assert first["stalls"] is None and first["msgs_options"] is None  # no earlier reading: no rate, not a made-up zero
    assert first["clients"] == 2 and first["data_age_s"] == 1.5  # levels, not rates, are there from the start
    st.message_count, st.market_message_count, st.duplicate_count = 570, 12_000, 40
    st._feed.dropped_by_kind = {"cas_change": 300, "other": 5}
    lw.stalls = 3
    now["t"] = T0 + timedelta(minutes=1)
    second = m.record()
    assert (second["msgs_options"], second["msgs_market"], second["duplicates"], second["dropped"], second["stalls"]) == (570, 12_000, 40, 305, 3)
    assert second["lag_p99_ms"] == 12.5 and second["lag_max_ms"] == 40.0 and second["clients"] == 2 and second["data_age_s"] == 1.5
    st.message_count, st.market_message_count, st.duplicate_count, lw.stalls = 1_000, 20_000, 55, 3
    now["t"] = T0 + timedelta(minutes=2)
    third = m.record()
    assert (third["msgs_options"], third["msgs_market"], third["duplicates"], third["stalls"]) == (430, 8_000, 15, 0)
    st.message_count = 5  # a new feed session after a reconnect starts its counters again: a rate is never negative
    now["t"] = T0 + timedelta(minutes=3)
    assert m.record()["msgs_options"] == 0


def test_the_view_summarises_a_window_and_old_rows_are_dropped(tmp_path: Path) -> None:
    store = MetricsStore(tmp_path)
    now = {"t": T0}
    m = RuntimeMetrics(store, Lw(), stream(), clock=lambda: now["t"])
    for i, cpu in enumerate([10.0, 20.0, 90.0, 30.0]):
        store.add({"ts": (T0 + timedelta(minutes=i)).isoformat(timespec="minutes"), "cpu_pct": cpu, "rss_mb": 300.0 + i, "threads": 20, "load1": 0.5, "lag_p99_ms": 50.0 * (i + 1), "lag_max_ms": 100.0,
                   "stalls": 1 if i == 2 else 0, "msgs_options": 100, "msgs_market": 1000, "duplicates": 5, "dropped": 0, "clients": 1, "data_age_s": 1.0}, T0 + timedelta(minutes=i))
    now["t"] = T0 + timedelta(minutes=4)
    v = m.view(60)
    s = v["summary"]
    assert v["minutes"] == 4 and s["cpu_pct_avg"] == 37.5 and s["cpu_pct_max"] == 90.0 and s["rss_mb_max"] == 303.0
    assert s["stalls"] == 1 and s["msgs_options"] == 400 and s["msgs_market"] == 4000 and s["lag_p99_ms_worst"] == 200.0
    assert m.view(2)["minutes"] == 2  # only the window asked for
    far = T0 + timedelta(days=60)
    store.add({**v["rows"][0], "ts": far.isoformat(timespec="minutes")}, far)  # writing a row 60 days later removes the rows older than 45 days
    assert [r["ts"] for r in store.series(T0 - timedelta(days=1))] == [far.isoformat(timespec="minutes")]


def test_cpu_is_a_share_of_one_core_over_the_interval(tmp_path: Path) -> None:
    import time

    m = RuntimeMetrics(MetricsStore(tmp_path), None, None)
    end = time.perf_counter() + 1.2
    while time.perf_counter() < end:  # busy for 1.2 s on this core
        pass
    row = m.collect()
    assert row["cpu_pct"] is not None and 60.0 <= row["cpu_pct"] <= 110.0
    assert row["lag_p99_ms"] is None and row["clients"] is None and row["msgs_options"] is None  # no loop watch, no stream, no earlier reading: missing stays missing
    mem = rss_mb()
    assert mem is None or mem > 10  # Linux reports the process size; elsewhere it is simply not available


@pytest.mark.asyncio
async def test_the_recorder_survives_a_failing_write(tmp_path: Path) -> None:
    m = RuntimeMetrics(MetricsStore(tmp_path), None, None)
    m.store.add = lambda *a, **k: (_ for _ in ()).throw(OSError("disk full"))  # type: ignore[method-assign]
    with pytest.raises(OSError):
        m.record()  # the loop catches this, logs it and keeps going (it never reaches the application)


def test_the_api_serves_the_record_and_says_so_when_it_is_off(tmp_path: Path) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import routes

    app = FastAPI()
    app.include_router(routes.router)
    c = TestClient(app)
    assert c.get("/api/runtime/metrics").status_code == 503
    now = datetime.now(UTC)
    m = RuntimeMetrics(MetricsStore(tmp_path), Lw(), stream(), clock=lambda: now)
    m.record()
    app.state.runtime_metrics = m
    body = c.get("/api/runtime/metrics?minutes=30").json()
    assert body["minutes"] == 1 and body["rows"][0]["clients"] == 2 and "summary" in body
    assert c.get("/api/runtime/metrics?minutes=0").status_code == 422  # bounded input
