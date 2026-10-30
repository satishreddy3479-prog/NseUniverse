"""Saved and closed strategies kept on the server: exact round-trip, soft delete, history, import."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.storage.strategies import StrategyError, StrategyStore
from tests.conftest import make_app

LEGS = [{"id": "a", "action": "SELL", "type": "PE", "strike": 22950, "lots": 1, "premium": 134.65, "stop": 200.0}]


def test_round_trip_is_exact_and_identical_rewrite_adds_no_revision(tmp_path: Path) -> None:
    s = StrategyStore(tmp_path)
    doc = {"name": "short straddle", "expiry": "2026-11-03", "legs": LEGS}
    s.put("saved", "short straddle", doc)
    s.put("saved", "short straddle", doc)
    assert s.list("saved") == [doc]
    assert [h["action"] for h in s.history("saved", "short straddle")] == ["create"]


def test_update_keeps_the_old_version_in_history_and_never_hard_deletes(tmp_path: Path) -> None:
    s = StrategyStore(tmp_path)
    s.put("saved", "x", {"name": "x", "legs": LEGS})
    s.put("saved", "x", {"name": "x", "legs": LEGS + LEGS})
    assert len(s.list("saved")[0]["legs"]) == 2
    assert s.delete("saved", "x") is True and s.list("saved") == [] and s.delete("saved", "x") is False
    h = s.history("saved", "x")
    assert [r["action"] for r in h] == ["create", "update", "delete"]
    assert len(h[0]["doc"]["legs"]) == 1  # the first version is still there
    with pytest.raises(Exception, match="marked deleted"):
        s._db.execute("DELETE FROM items")
    s.put("saved", "x", {"name": "x", "legs": LEGS})  # saving the name again brings it back
    assert len(s.list("saved")) == 1 and s.history("saved", "x")[-1]["action"] == "restore"


def test_validation_and_persistence_across_restart(tmp_path: Path) -> None:
    s = StrategyStore(tmp_path)
    for kind, key in (("other", "k"), ("saved", ""), ("saved", "k" * 121)):
        with pytest.raises(StrategyError):
            s.put(kind, key, {})
    with pytest.raises(StrategyError, match="too large"):
        s.put("closed", "big", {"x": "y" * 300_000})
    s.put("closed", "c1", {"id": "c1", "pnl": 436})
    s.close()
    assert StrategyStore(tmp_path).list("closed") == [{"id": "c1", "pnl": 436}]


def test_import_adds_only_unknown_keys_and_does_not_resurrect_deleted(tmp_path: Path) -> None:
    s = StrategyStore(tmp_path)
    s.put("saved", "keep", {"v": 1})
    s.put("saved", "gone", {"v": 1})
    s.delete("saved", "gone")
    assert s.put_if_absent("saved", "keep", {"v": 2}) is False
    assert s.put_if_absent("saved", "gone", {"v": 2}) is False
    assert s.put_if_absent("saved", "new", {"v": 3}) is True
    assert sorted(d["v"] for d in s.list("saved")) == [1, 3]


def test_api_put_list_delete_import(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path)) as c:
        assert c.get("/api/strategies").json() == {"saved": [], "closed": []}
        assert c.put("/api/strategies/saved", json={"key": "straddle - range bound -30/10/2026", "doc": {"name": "my spread", "legs": LEGS}}).json() == {"ok": True}
        assert c.put("/api/strategies/closed", json={"key": "c1", "doc": {"id": "c1", "pnl": -12.5}}).status_code == 200
        got = c.get("/api/strategies").json()
        assert got["saved"][0]["legs"] == LEGS and got["closed"] == [{"id": "c1", "pnl": -12.5}]
        assert c.put("/api/strategies/bogus", json={"key": "k", "doc": {}}).status_code == 422
        assert c.delete("/api/strategies/closed", params={"key": "c1"}).json() == {"ok": True, "deleted": True}
        # a name with slashes (the app's default style) deletes through the query string too
        assert c.delete("/api/strategies/saved", params={"key": "straddle - range bound -30/10/2026"}).json()["deleted"] is True
        c.put("/api/strategies/saved", json={"key": "my spread", "doc": {"name": "my spread", "legs": LEGS}})
        assert c.get("/api/strategies").json()["closed"] == []
        r = c.post("/api/strategies/import", json={"saved": {"my spread": {"x": 1}, "old": {"y": 2}}, "closed": {}})
        assert r.json() == {"added": 1}  # 'my spread' already on the server
        assert len(c.get("/api/strategies").json()["saved"]) == 2
