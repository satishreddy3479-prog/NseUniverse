import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.services.swing_report import SCHEMA, SwingReportError, load_report
from tests.conftest import make_app

LOCAL = ("127.0.0.1", 50000)


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with TestClient(make_app(tmp_path), client=LOCAL) as c:
        yield c


def _write(tmp_path: Path, body: str) -> None:
    p = tmp_path / "data" / "swing" / "report.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")


def test_report_missing_is_a_clear_404(client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("app.services.swing_report.BUNDLED_REPORT", tmp_path / "no-bundled-copy.json")
    r = client.get("/api/swing/report")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "swing_report_missing"
    assert "swing-refresh" in r.json()["detail"]["message"]


def test_report_is_served_as_written(client: TestClient, tmp_path: Path) -> None:
    body = {"schema": SCHEMA, "meta": {"data_through": "2026-11-04"}, "trades": [], "caveats": []}
    _write(tmp_path, json.dumps(body))
    r = client.get("/api/swing/report")
    assert r.status_code == 200 and r.json() == body


def test_unreadable_and_wrong_schema_are_503_not_500(client: TestClient, tmp_path: Path) -> None:
    _write(tmp_path, "{not json")
    assert client.get("/api/swing/report").json()["detail"]["code"] == "swing_report_unreadable"
    _write(tmp_path, json.dumps({"schema": SCHEMA + 1}))
    r = client.get("/api/swing/report")
    assert r.status_code == 503 and r.json()["detail"]["code"] == "swing_report_schema"


def test_load_report_error_carries_status(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.services.swing_report.BUNDLED_REPORT", tmp_path / "no-bundled-copy.json")
    with pytest.raises(SwingReportError) as e:
        load_report(tmp_path)
    assert e.value.status == 404


def test_live_view_is_served_even_with_nothing_watched(client: TestClient) -> None:
    r = client.get("/api/swing/live")
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "shadow" and body["watching"] == [] and body["events"] == []
    assert body["enabled"] is False and body["market"] in ("open", "closed")
    assert body["note"] == "no broker instrument file available"  # the replay broker has no instrument file


def test_the_report_bundled_with_the_release_is_served_when_the_data_folder_has_none(tmp_path: Path) -> None:
    report = load_report(tmp_path)  # no data/swing/report.json here: the copy shipped with the release
    assert report["schema"] == SCHEMA and report["kpis"] and report["equity"]
    _write(tmp_path, json.dumps({"schema": SCHEMA, "meta": {"data_through": "x"}, "marker": "data folder wins"}))
    assert load_report(tmp_path / "data")["marker"] == "data folder wins"


def test_live_fills_endpoint_serves_an_empty_ledger_with_its_state(client: TestClient) -> None:
    r = client.get("/api/swing/live-fills")
    assert r.status_code == 200
    d = r.json()
    assert d["fills"] == [] and d["open"] == 0 and d["closed"] == 0 and d["capital"] == d["equity"] == d["cash"]
    assert set(d["reconciliation"]) == {"pending", "confirmed", "rejected"} and d["official_book"] == "separate and unchanged"
    assert d["enabled"] is False  # the test app runs without the live watcher
    assert client.get("/api/swing/live").json()["live_fills_enabled"] is False
