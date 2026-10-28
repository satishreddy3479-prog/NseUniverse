from __future__ import annotations

import time
from collections.abc import Iterator
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.domain.models import (
    Completeness,
    DataSource,
    ExpiryKind,
    OptionChainRow,
    OptionChainSnapshot,
    OptionQuote,
)
from app.services.universe import tokens_from_snapshots
from app.storage.store import SnapshotStore
from tests.conftest import make_app

LOCAL = ("127.0.0.1", 50000)


def quote(token: str | None, side: str, moneyness: str = "OTM") -> OptionQuote:
    return OptionQuote(
        exchange_segment="nse_fo" if token else None,
        instrument_token=token,
        trading_symbol=f"S{token}",
        option_type=side,
        ltp=1.0,
        open=None,
        high=None,
        low=None,
        prev_close=None,
        close=None,
        volume=1,
        oi=1,
        oi_previous=1,
        oi_change=0,
        oi_change_pct=None,
        moneyness=moneyness,
    )


def snap(
    expiry: date,
    tokens: list[tuple[float, str, str, str]],
    completeness: Completeness = Completeness.COMPLETE,
    sid: str = "s",
    at: datetime | None = None,
    ltp: float | None = 24000.0,
) -> OptionChainSnapshot:
    rows = [
        OptionChainRow(strike=k, call=quote(c, "CE", m), put=quote(p, "PE", m))
        for k, c, p, m in tokens
    ]
    return OptionChainSnapshot(
        snapshot_id=sid,
        session_id="x",
        underlying="NIFTY",
        expiry=expiry,
        expiry_kinds=[ExpiryKind.WEEKLY],
        source=DataSource.SNAPSHOT,
        retrieved_at=at or datetime(2026, 10, 28, 10, tzinfo=UTC),
        lot_size=65,
        multiplier=1,
        underlying_ltp=ltp,
        requested_strike_count=3,
        completeness=completeness,
        rows=rows,
        ce_count=len(rows),
        pe_count=len(rows),
    )


def test_universe_dedupes_tokens_and_picks_atm_for_the_test_subscription() -> None:
    a = snap(
        date(2026, 11, 3),
        [(23950, "1", "2", "OTM"), (24000, "3", "4", "ATM"), (24050, "5", "6", "OTM")],
    )
    b = snap(date(2026, 11, 24), [(24000, "3", "4", "ATM"), (24050, "7", "8", "OTM")])
    u = tokens_from_snapshots([a, b], "NIFTY")
    keys = [t.key for t in u.tokens]
    assert keys[0] == "nse_cm|Nifty 50" and len(keys) == len(set(keys)) == 1 + 6 + 2
    assert [t.key for t in u.test_tokens] == ["nse_cm|Nifty 50", "nse_fo|3", "nse_fo|4"]
    assert u.expiries == ["2026-11-03", "2026-11-24"]


def test_universe_falls_back_to_nearest_to_spot_then_skips_tokenless_contracts() -> None:
    s = snap(
        date(2026, 11, 3),
        [(23900, "1", "2", "OTM"), (24020, "3", "4", "OTM"), (24100, None, "6", "OTM")],
        ltp=24010.0,
    )  # type: ignore[arg-type]
    u = tokens_from_snapshots([s], "NIFTY")
    assert [t.key for t in u.test_tokens][1:] == ["nse_fo|3", "nse_fo|4"]
    assert "nse_fo|None" not in [t.key for t in u.tokens]
    assert any(t.key == "nse_fo|6" for t in u.tokens)


def test_store_latest_prefers_a_usable_snapshot_over_a_newer_empty_one(tmp_path: Path) -> None:
    st = SnapshotStore(tmp_path)
    good = snap(
        date(2026, 11, 3),
        [(24000, "1", "2", "ATM")],
        sid="good",
        at=datetime(2026, 10, 28, 10, 0, tzinfo=UTC),
    )
    empty = snap(
        date(2026, 11, 3),
        [],
        completeness=Completeness.EMPTY,
        sid="empty",
        at=datetime(2026, 10, 28, 11, 0, tzinfo=UTC),
    )
    st.save(good, {})
    st.save(empty, {})
    latest = st.latest("NIFTY", "2026-11-03")
    assert latest is not None and latest.snapshot_id == "good"
    only_empty = st.latest("NIFTY", "2026-11-03", prefer_non_empty=False)
    assert only_empty is not None and only_empty.snapshot_id == "empty"
    st.save(snap(date(2026, 11, 24), [], completeness=Completeness.EMPTY, sid="e2"), {})
    fallback = st.latest("NIFTY", "2026-11-24")
    assert fallback is not None and fallback.completeness is Completeness.EMPTY


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    app = make_app(tmp_path, stream_broadcast_interval_ms=50, stream_test_timeout_seconds=5.0)
    with TestClient(app, client=LOCAL) as c:
        yield c


def wait_for(client: TestClient, cond: Any, timeout: float = 8.0) -> dict[str, Any]:
    end = time.time() + timeout
    last: dict[str, Any] = {}
    while time.time() < end:
        last = client.get("/api/stream/status").json()
        if cond(last):
            return last
        time.sleep(0.1)
    raise AssertionError(f"timeout; last status: {last}")


def test_stream_builds_on_the_real_snapshot_and_starts_idempotently(client: TestClient) -> None:
    r1 = client.post("/api/stream/start")
    r2 = client.post("/api/stream/start")
    assert r1.status_code == 200 and r2.status_code == 200
    s = wait_for(client, lambda s: s["state"] == "streaming")
    # snapshot first: both captured chains were fetched, then their instruments were subscribed
    assert s["expiries"] == ["2026-11-03", "2026-11-23"]
    assert s["subscribed_tokens"] == 1 + 162 + 162  # index + (81 CE + 81 PE) per expiry
    assert s["data_source"] == "live" and s["test_subscription_result"] == "received"
    assert s["market"]["state"] == "closed"  # what the exchange feed reported at capture time
    assert s["instruments_with_data"] >= 1 and s["message_count"] > 0
    snaps = client.get("/api/snapshots").json()
    assert {x["expiry"] for x in snaps} == {"2026-11-03", "2026-11-23"}
    stopped = client.post("/api/stream/stop").json()
    assert stopped["state"] == "stopped" and stopped["market"]["state"] == "unknown"
    assert client.get("/api/status").json()["stream"]["implemented"] is True


def test_websocket_sends_hello_then_batched_ticks_and_status(client: TestClient) -> None:
    with client.websocket_connect(
        "/ws/market-data", headers={"origin": "http://localhost:5173"}
    ) as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["status"]["state"] == "stopped"
        client.post("/api/stream/start")
        seen: set[str] = set()
        ticks: list[dict[str, Any]] = []
        deadline = time.time() + 10
        while time.time() < deadline and not ({"ticks", "status", "market"} <= seen):
            msg = ws.receive_json()
            seen.add(msg["type"])
            if msg["type"] == "ticks":
                ticks.extend(msg["ticks"])
        assert {"ticks", "status", "market"} <= seen
        assert ticks and all(t["source"] == "live" for t in ticks)
        assert {"key", "ltp", "received_at", "seq"} <= set(ticks[0])
    client.post("/api/stream/stop")


def test_websocket_rejects_foreign_origin_and_remote_clients(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    with TestClient(app, client=LOCAL) as c:
        with pytest.raises(WebSocketDisconnect) as ei:
            with c.websocket_connect("/ws/market-data", headers={"origin": "http://evil.example"}):
                pass
        assert ei.value.code == 1008
    with TestClient(app, client=("203.0.113.9", 4000)) as c:
        with pytest.raises(WebSocketDisconnect) as ei:
            with c.websocket_connect("/ws/market-data"):
                pass
        assert ei.value.code == 1008


def test_websocket_client_limit(tmp_path: Path) -> None:
    app = make_app(tmp_path, ws_max_clients=1)
    with TestClient(app, client=LOCAL) as c:
        with c.websocket_connect("/ws/market-data") as first:
            assert first.receive_json()["type"] == "hello"
            with pytest.raises(WebSocketDisconnect) as ei:
                with c.websocket_connect("/ws/market-data"):
                    pass
            assert ei.value.code == 1013


def test_stream_control_is_local_only(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    with TestClient(app, client=("203.0.113.9", 4000)) as c:
        assert c.post("/api/stream/start").status_code == 403
        assert c.post("/api/stream/stop").status_code == 403
        assert c.get("/api/stream/status").status_code == 200
