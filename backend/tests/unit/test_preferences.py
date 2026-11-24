"""Display preferences kept on the server so every browser and PC shows the same app."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.storage.preferences import MAX_KEYS, PreferenceError, PreferenceStore
from tests.conftest import make_app


def test_put_get_overwrite_and_unchanged_write_keeps_its_time(tmp_path: Path) -> None:
    st = PreferenceStore(tmp_path)
    a = st.put("nse.layout.v1.vega", '{"tf":15}')
    assert st.all()["nse.layout.v1.vega"] == {"value": '{"tf":15}', "updatedAt": a["updatedAt"]}
    same = st.put("nse.layout.v1.vega", '{"tf":15}')
    assert same["updatedAt"] == a["updatedAt"]  # nothing changed: other devices see no change
    b = st.put("nse.layout.v1.vega", '{"tf":5}')
    assert b["updatedAt"] > a["updatedAt"] and st.all()["nse.layout.v1.vega"]["value"] == '{"tf":5}'


def test_a_removal_is_a_dated_tombstone_not_a_delete(tmp_path: Path) -> None:
    st = PreferenceStore(tmp_path)
    put = st.put("nse.timeframe.v1", "5")
    gone = st.delete("nse.timeframe.v1")
    assert gone["value"] is None and gone["updatedAt"] > put["updatedAt"]
    assert st.all()["nse.timeframe.v1"]["value"] is None  # the other devices read the removal
    assert st.delete("never.stored")["value"] is None and "never.stored" not in st.all()
    with sqlite3.connect(st.path) as db, pytest.raises(sqlite3.DatabaseError):
        db.execute("DELETE FROM prefs")  # the table refuses deletes
    # the writes are kept in a history
    assert sqlite3.connect(st.path).execute("SELECT COUNT(*) FROM pref_history WHERE key='nse.timeframe.v1'").fetchone()[0] == 2


def test_keys_and_sizes_are_checked(tmp_path: Path) -> None:
    st = PreferenceStore(tmp_path)
    for bad in ("", "a b", "../x", "x" * 121, "/etc/passwd"):
        with pytest.raises(PreferenceError):
            st.put(bad, "1")
    with pytest.raises(PreferenceError):
        st.put("big", "x" * 70_000)
    for i in range(MAX_KEYS):
        st.put(f"k{i}", "1")
    with pytest.raises(PreferenceError):
        st.put("one-too-many", "1")
    st.put("k0", "2")  # an existing key can still change


def test_the_api_round_trips_and_a_second_client_sees_it(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path), client=("127.0.0.1", 50000)) as c:
        assert c.get("/api/prefs").json() == {"prefs": {}}
        r = c.put("/api/prefs/nse.layout.v1.gamma", json={"value": '{"x":1}'})
        assert r.status_code == 200 and r.json()["value"] == '{"x":1}'
        assert c.get("/api/prefs").json()["prefs"]["nse.layout.v1.gamma"]["value"] == '{"x":1}'
        assert c.delete("/api/prefs/nse.layout.v1.gamma").json()["value"] is None
        assert c.get("/api/prefs").json()["prefs"]["nse.layout.v1.gamma"]["value"] is None
        assert c.put("/api/prefs/bad key", json={"value": "1"}).status_code in (404, 422)
        assert c.put("/api/prefs/ok", json={"value": 5}).status_code == 422
    # a restart (a new app on the same folder) still has it
    with TestClient(make_app(tmp_path), client=("127.0.0.1", 50000)) as c2:
        assert "nse.layout.v1.gamma" in c2.get("/api/prefs").json()["prefs"]
