from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from app.domain.models import Completeness, DataSource, ExpiryKind, OptionChainSnapshot
from app.storage.store import SnapshotStore, StorageError, scrub


def snap(sid: str, at: datetime) -> OptionChainSnapshot:
    return OptionChainSnapshot(
        snapshot_id=sid,
        session_id="sess",
        underlying="NIFTY",
        expiry=date(2026, 11, 3),
        expiry_kinds=[ExpiryKind.WEEKLY],
        source=DataSource.SNAPSHOT,
        retrieved_at=at,
        lot_size=75,
        multiplier=1,
        requested_strike_count=2,
        completeness=Completeness.EMPTY,
        rows=[],
        ce_count=0,
        pe_count=0,
    )


def test_save_list_load_latest(tmp_path: Path) -> None:
    st = SnapshotStore(tmp_path)
    st.start_session("sess", "live")
    st.save(snap("a1", datetime(2026, 10, 28, 4, tzinfo=UTC)), {"call": []})
    st.save(snap("b2", datetime(2026, 10, 28, 5, tzinfo=UTC)), {"call": []})
    assert [s.snapshot_id for s in st.list()] == ["b2", "a1"]
    latest = st.latest("NIFTY", "2026-11-03")
    assert latest is not None and latest.snapshot_id == "b2"
    assert st.load("missing") is None
    assert st.list_sessions()[0]["snapshot_count"] == 2
    folder = tmp_path / "snapshots" / "2026-10-28"
    assert (folder / "a1.json.gz").exists() and (folder / "a1.raw.json.gz").exists()


def test_snapshots_are_compressed_and_old_plain_files_still_load(tmp_path: Path) -> None:
    import sqlite3

    st = SnapshotStore(tmp_path)
    st.start_session("sess", "live")
    s = snap("new1", datetime(2026, 10, 28, 4, tzinfo=UTC))
    st.save(s, {"call": ["x" * 2000]})
    folder = tmp_path / "snapshots" / "2026-10-28"
    assert (folder / "new1.raw.json.gz").stat().st_size < 500  # 2000 repeated bytes compress away
    loaded = st.load("new1")
    assert loaded is not None and loaded.snapshot_id == "new1"
    # a snapshot written by an earlier build: plain JSON, indexed with a .json file_ref
    legacy = snap("old1", datetime(2026, 10, 28, 3, tzinfo=UTC))
    (folder / "old1.json").write_text(legacy.model_dump_json(), encoding="utf-8")
    summary = legacy.summary("snapshots/2026-10-28/old1.json")
    db = sqlite3.connect(tmp_path / "index.sqlite3")
    db.execute(
        "INSERT INTO snapshots VALUES (?,?,?,?,?,?,?,?,?)",
        ("old1", "sess", "NIFTY", "2026-11-03", "snapshot", legacy.retrieved_at.isoformat(),
         "empty", summary.model_dump_json(), summary.file_ref),
    )  # fmt: skip
    db.commit()
    db.close()
    old = st.load("old1")
    assert old is not None and old.snapshot_id == "old1"


def test_never_overwrites(tmp_path: Path) -> None:
    st = SnapshotStore(tmp_path)
    at = datetime(2026, 10, 28, 4, tzinfo=UTC)
    st.save(snap("dup", at), {})
    with pytest.raises(StorageError):
        st.save(snap("dup", at), {})


def test_scrub_removes_credential_keys() -> None:
    raw = {"call": [{"token": "x", "neoSymbol": "nse_fo|1"}], "sid": "s", "Authorization": "a"}
    assert scrub(raw) == {"call": [{"neoSymbol": "nse_fo|1"}]}


def test_csv_header(tmp_path: Path) -> None:
    text = SnapshotStore.to_csv(snap("c", datetime(2026, 10, 28, tzinfo=UTC)))
    assert text.startswith("underlying,expiry,retrieved_at_utc,source,strike,ce_ltp")


def test_legacy_mock_rows_are_never_listed_or_loaded(tmp_path: Path) -> None:
    import sqlite3

    st = SnapshotStore(tmp_path)
    st.start_session("sess", "live")
    st.save(snap("real", datetime(2026, 10, 28, 4, tzinfo=UTC)), {})
    db = sqlite3.connect(tmp_path / "index.sqlite3")
    db.execute(
        "INSERT INTO sessions(session_id, started_at, data_mode) VALUES (?,?,?)",
        ("old", "2026-10-27T00:00:00+00:00", "mock"),
    )
    db.execute(
        "INSERT INTO snapshots VALUES (?,?,?,?,?,?,?,?,?)",
        (
            "legacy",
            "old",
            "NIFTY",
            "2026-11-03",
            "mock",
            "2026-10-28T09:00:00+00:00",
            "complete",
            "{not valid json}",
            "snapshots/x.json",
        ),
    )
    db.commit()
    db.close()
    assert [s.snapshot_id for s in st.list()] == ["real"]
    assert st.load("legacy") is None
    assert [s["session_id"] for s in st.list_sessions()] == ["sess"]
