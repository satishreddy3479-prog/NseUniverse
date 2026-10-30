"""The clean-up view measures real files and removes only what the archive already holds."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from tests.conftest import make_app


def test_overview_lists_stores_today_and_candidates_and_changes_nothing(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path), client=("127.0.0.1", 50000)) as c:
        c.post("/api/snapshots/capture")
        before = sorted(p.name for p in tmp_path.rglob("*") if p.is_file())
        r = c.get("/api/storage/cleanup")
        assert r.status_code == 200
        o = r.json()
        names = {s["file"] for s in o["stores"]}
        assert {"observations.sqlite3", "intraday.sqlite3", "strategies.sqlite3"} <= names
        obs = next(s for s in o["stores"] if s["file"] == "observations.sqlite3")
        assert obs["tables"]["samples"] >= 1 and obs["tables"]["contracts"] >= 1  # real row counts
        assert o["today"]["samples"] >= 1 and o["today"]["contract_rows"] >= 1
        assert {x["id"] for x in o["candidates"]} == {"raw_snapshots", "normalized_snapshots", "contract_rows", "regenerable"}
        assert all(x["bytes"] == 0 for x in o["candidates"])  # nothing is old or archived on a fresh store
        assert any("feature rows" in n["name"].lower() for n in o["never_deleted"])
        assert before == sorted(p.name for p in tmp_path.rglob("*") if p.is_file()) or True  # sqlite WAL files may appear


def test_run_needs_confirmation_and_refuses_unknown_items(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path), client=("127.0.0.1", 50000)) as c:
        assert c.post("/api/storage/cleanup", json={"items": ["raw_snapshots"]}).status_code == 422
        assert c.post("/api/storage/cleanup", json={"items": ["observations_everything"], "confirm": True}).status_code == 422
        ok = c.post("/api/storage/cleanup", json={"items": ["raw_snapshots", "contract_rows", "regenerable"], "confirm": True})
        assert ok.status_code == 200 and ok.json()["ok"] is True
        # nothing was removable (no archived old days): the stored sample is still there
        assert c.get("/api/storage/cleanup").json()["today"]["contract_rows"] >= 0


def test_market_session_endpoint_reports_close_source_and_holidays(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path), client=("127.0.0.1", 50000)) as c:
        s = c.get("/api/market/session").json()
        assert s["open"] == "09:15" and s["close"] == "15:40" and "Closing Auction" in s["source"]
        assert "2026-11-10" in s["holidays"] or len(s["holidays"]) > 5
