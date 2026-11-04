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


def test_report_missing_is_a_clear_404(client: TestClient) -> None:
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


def test_load_report_error_carries_status(tmp_path: Path) -> None:
    with pytest.raises(SwingReportError) as e:
        load_report(tmp_path)
    assert e.value.status == 404
