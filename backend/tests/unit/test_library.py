"""The data library: bundles, their verification, the automatic step, the pruning gate, temporary restores, the coverage check and the API (docs/data-library-plan.md)."""

from __future__ import annotations

import gzip
import hashlib
import json
import zipfile
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.library import bundles as bl
from app.library.service import LibraryError, LibraryService
from app.lifecycle import storage
from app.lifecycle.archive import archive_path
from tests.conftest import make_app

TODAY = date(2026, 12, 20)
NOW = datetime(2026, 12, 20, 14, 0, tzinfo=UTC)  # 19:30 IST: after the close


class FakeObs:
    def __init__(self, counts: dict[str, int]) -> None:
        self.counts = counts

    def session_sample_counts(self, underlying: str) -> dict[str, int]:
        return dict(self.counts)


def day(n_ago: int) -> date:
    return TODAY - timedelta(days=n_ago)


def make_day(data: Path, d: date, files: int = 3) -> None:
    folder = data / "snapshots" / d.isoformat()
    folder.mkdir(parents=True, exist_ok=True)
    for i in range(files):
        raw = i % 2 == 0
        (folder / f"{d:%Y%m%dT100000Z}_{i}{'.raw' if raw else ''}.json.gz").write_bytes(gzip.compress(f"{d}-{i}".encode() * 50))
    a = archive_path(data, d)
    a.parent.mkdir(parents=True, exist_ok=True)
    a.write_bytes(gzip.compress(b'{"t":"header"}\n'))
    m = data / "manifests"
    m.mkdir(exist_ok=True)
    (m / f"session={d.isoformat()}.json").write_text(json.dumps({"day": d.isoformat(), "archive": {"path": a.relative_to(data).as_posix()}}))


@pytest.fixture()
def data(tmp_path: Path) -> Path:
    return tmp_path / "data"


def service(data: Path, days_ago: list[int], **kw: Any) -> LibraryService:
    data.mkdir(parents=True, exist_ok=True)
    for n in days_ago:
        make_day(data, day(n))
    counts = {day(n).isoformat(): 380 for n in days_ago}
    return LibraryService(data, FakeObs(counts), "NIFTY", clock=lambda: NOW, min_free_bytes=0, **kw)


# ------------------------------------------------------------------ bundles
def test_a_bundle_lists_every_file_with_its_checksum_and_verifies(data: Path, tmp_path: Path) -> None:
    for n in (40, 39):
        make_day(data, day(n))
    info = bl.build_bundle(data, tmp_path / "out", [day(40), day(39)], now=NOW)
    assert info.name == f"nse-universe-bundle-{day(40)}_to_{day(39)}.zip" and info.days == [day(40).isoformat(), day(39).isoformat()]
    assert info.sha256 == hashlib.sha256(info.path.read_bytes()).hexdigest() and info.bytes == info.path.stat().st_size
    doc = bl.verify_bundle(info.path)
    assert doc["files"] == len(doc["members"]) == 10  # per day: 3 snapshot files, the archive and the manifest
    with zipfile.ZipFile(info.path) as zf:
        assert zf.namelist()[-1] == "MANIFEST.json"  # the manifest is last
        member = doc["members"][0]
        assert hashlib.sha256(zf.read(member["path"])).hexdigest() == member["sha256"] and len(zf.read(member["path"])) == member["bytes"]


def test_a_changed_file_inside_a_bundle_is_detected(data: Path, tmp_path: Path) -> None:
    make_day(data, day(40))
    info = bl.build_bundle(data, tmp_path / "out", [day(40)], now=NOW)
    damaged = tmp_path / "damaged.zip"
    with zipfile.ZipFile(info.path) as src, zipfile.ZipFile(damaged, "w") as dst:
        for z in src.infolist():
            body = src.read(z.filename)
            dst.writestr(z.filename, body[:-1] + b"X" if z.filename.endswith(".raw.json.gz") else body)
    with pytest.raises(bl.BundleError, match="does not match its checksum"):
        bl.verify_bundle(damaged)
    with pytest.raises(bl.BundleError):
        bl.restore_bundle(damaged, tmp_path / "r", max_bytes=10**9)
    assert not (tmp_path / "r").exists() or not any((tmp_path / "r").rglob("*.gz"))  # nothing was unpacked


def test_nothing_to_bundle_is_an_error_and_leaves_no_temporary_file(data: Path, tmp_path: Path) -> None:
    data.mkdir()
    with pytest.raises(bl.BundleError, match="no files"):
        bl.build_bundle(data, tmp_path / "out", [day(40)], now=NOW)
    assert not list((tmp_path / "out").glob(".tmp-*")) if (tmp_path / "out").exists() else True


def forged(path: Path, member: str) -> None:
    body = b"evil"
    manifest = {"schema": 1, "kind": "nse-universe-bundle", "bytes": 4, "days": ["2026-01-01"], "files": 1, "members": [{"path": member, "bytes": 4, "sha256": hashlib.sha256(body).hexdigest(), "day": "2026-01-01"}]}
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(member, body)
        zf.writestr("MANIFEST.json", json.dumps(manifest))


@pytest.mark.parametrize("member", ["../evil.txt", "/etc/evil", "snapshots/../../evil", "other/file.gz", "C:/evil", "snapshots\\x"])
def test_a_restore_refuses_paths_that_could_leave_the_target_or_are_not_ours(member: str, tmp_path: Path) -> None:
    z = tmp_path / "b.zip"
    forged(z, member)
    with pytest.raises(bl.BundleError, match="unsafe path"):
        bl.restore_bundle(z, tmp_path / "dest", max_bytes=10**9)
    assert not (tmp_path / "evil.txt").exists() and not (tmp_path / "dest" / "evil.txt").exists()


def test_a_restore_never_overwrites_and_respects_the_size_limit(data: Path, tmp_path: Path) -> None:
    make_day(data, day(40))
    info = bl.build_bundle(data, tmp_path / "out", [day(40)], now=NOW)
    dest = tmp_path / "dest"
    target = dest / info.manifest["members"][0]["path"]
    target.parent.mkdir(parents=True)
    target.write_bytes(b"already here")
    bl.restore_bundle(info.path, dest, max_bytes=10**9)
    assert target.read_bytes() == b"already here"  # left alone
    assert (dest / "manifests" / f"session={day(40)}.json").exists()
    with pytest.raises(bl.BundleError, match="limited to"):
        bl.restore_bundle(info.path, tmp_path / "d2", max_bytes=10)


def test_something_that_is_not_a_bundle_is_refused(tmp_path: Path) -> None:
    p = tmp_path / "x.zip"
    p.write_bytes(b"not a zip")
    with pytest.raises(bl.BundleError):
        bl.read_manifest(p)
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr("hello.txt", "hi")
    with pytest.raises(bl.BundleError):
        bl.read_manifest(p)


# ------------------------------------------------------------------ the automatic step and the pruning gate
def test_every_30_days_of_files_become_one_bundle_by_themselves_and_not_twice(data: Path) -> None:
    svc = service(data, list(range(0, 41)))  # snapshot days from 40 days ago to today
    blk = svc.next_block(TODAY)
    assert blk is not None and blk["start"] == day(40).isoformat() and blk["end"] == day(11).isoformat() and blk["ready"] is True and blk["days"] == 30
    out = svc.auto_run()
    assert out["state"] == "ok" and out["built"]["days"] == 30
    assert svc.bundled_days() == {day(n).isoformat() for n in range(11, 41)}  # the block: 30 days from the oldest
    nxt = svc.next_block(TODAY)
    assert nxt is not None and nxt["start"] == day(10).isoformat() and nxt["ready"] is False and nxt["days"] == 11  # the next block has started
    again = svc.auto_run()
    assert "built" not in again and len(svc.store.bundles()) == 1


def test_a_block_that_is_not_over_waits(data: Path) -> None:
    svc = service(data, list(range(0, 21)))  # the oldest day is 20 days old: the block runs 9 more days
    blk = svc.next_block(TODAY)
    assert blk is not None and blk["ready"] is False and blk["ready_on"] == (day(20) + timedelta(days=30)).isoformat() and blk["days_left"] == 10
    assert "built" not in svc.auto_run() and svc.store.bundles() == []


def test_the_block_length_is_a_setting(data: Path) -> None:
    svc = service(data, list(range(0, 15)), block_days=10)
    assert svc.auto_run()["built"]["days"] == 10
    assert svc.next_block(TODAY)["start"] == day(4).isoformat()  # type: ignore[index]


def test_with_nothing_on_the_server_there_is_no_block(data: Path) -> None:
    svc = service(data, [])
    assert svc.next_block(TODAY) is None and svc.auto_run()["state"] == "ok"


def test_pruning_waits_for_the_bundle_except_at_the_hard_stop_or_low_disk(data: Path) -> None:
    for n in (45, 44, 70):
        make_day(data, day(n))
    archived = {day(n).isoformat() for n in (45, 44, 70)}
    ids = {p.name.split(".")[0] for p in (data / "snapshots").rglob("*.gz")}
    r = storage.prune_snapshots(data, TODAY, 30, 30, archived, ids, dry_run=True, bundled_days={day(45).isoformat()}, hard_stop_days=60, free_bytes=50 * 10**9, min_free_bytes=6 * 10**9)
    assert r["raw_files"] + r["normalized_files"] == 3 + 3  # day 45 (bundled) and day 70 (older than the hard stop) go, 3 files each; day 44 waits
    assert r["kept_not_bundled"] == 3 and r["forced"] == 3
    low = storage.prune_snapshots(data, TODAY, 30, 30, archived, ids, dry_run=True, bundled_days=set(), hard_stop_days=60, free_bytes=2 * 10**9, min_free_bytes=6 * 10**9)
    assert low["kept_not_bundled"] == 0 and low["forced"] == 9  # the disk must not fill: everything old enough goes
    plain = storage.prune_snapshots(data, TODAY, 30, 30, archived, ids, dry_run=True)
    assert plain["kept_not_bundled"] == 0 and plain["forced"] == 0  # without the library the rule is as before


# ------------------------------------------------------------------ download, confirm, remove
def test_after_a_confirmed_download_the_server_deletes_the_bundle_and_the_snapshot_files_but_keeps_the_archive(data: Path) -> None:
    svc = service(data, list(range(25, 40)))
    b = svc.build(day(39), day(25))
    path, rec = svc.bundle_file(b["id"])
    with pytest.raises(LibraryError) as e:
        svc.delete_bundle(b["id"])
    assert e.value.code == "not_downloaded"  # it may be the only copy
    with pytest.raises(LibraryError) as e2:
        svc.confirm(b["id"], "0" * 64)
    assert e2.value.code == "checksum_mismatch"
    assert any((data / "snapshots").rglob("*.gz")) and path.exists()  # nothing was deleted by a refused confirmation
    done = svc.confirm(b["id"], hashlib.sha256(path.read_bytes()).hexdigest().upper())
    assert done["downloaded"] and done["on_server"] is False and done["released_files"] == 15 * 3
    assert not path.exists() and svc.store.bundles() == []  # the bundle is gone from the server
    assert not any((data / "snapshots").rglob("*.gz")) and not any(p.is_dir() for p in (data / "snapshots").iterdir())  # the snapshot files and their empty day folders are gone
    assert all((archive_path(data, day(n))).exists() and (data / "manifests" / f"session={day(n)}.json").exists() for n in range(25, 40))  # the archive and manifests stay forever
    assert svc.exported_days() == {day(n).isoformat() for n in range(25, 40)}  # and the days are known to have been exported
    assert svc.next_block(TODAY) is None  # the process starts over with the next days


def test_a_file_that_does_not_match_the_bundle_or_has_no_archive_is_not_deleted(data: Path) -> None:
    svc = service(data, list(range(25, 40)))
    b = svc.build(day(39), day(25))
    folder = data / "snapshots" / day(30).isoformat()
    changed = sorted(folder.iterdir())[0]
    changed.write_bytes(changed.read_bytes() + b"x")  # a file that is not what the bundle holds
    (data / "manifests" / f"session={day(31)}.json").unlink()  # a day without its verified archive
    path, _ = svc.bundle_file(b["id"])
    svc.confirm(b["id"], hashlib.sha256(path.read_bytes()).hexdigest())
    assert changed.exists()
    assert len(list((data / "snapshots" / day(31).isoformat()).iterdir())) == 3


def test_an_unconfirmed_bundle_is_never_removed_however_long_it_waits(data: Path) -> None:
    svc = service(data, list(range(25, 40)))
    b = svc.build(day(39), day(25))
    svc.now = lambda: NOW + timedelta(days=400)  # type: ignore[method-assign]
    svc.auto_run()
    assert svc.bundle_file(b["id"])[0].exists() and any((data / "snapshots").rglob("*.gz"))  # the bundle and the files are still there


def test_a_full_disk_removes_the_snapshot_files_of_a_bundle_that_is_on_the_server_but_keeps_the_bundle(data: Path) -> None:
    svc = service(data, list(range(25, 40)))
    b = svc.build(day(39), day(25))
    svc.min_free = 10**15  # the disk is under its floor
    done = svc.protect_disk()
    assert done["files"] == 15 * 3 and not any((data / "snapshots").rglob("*.gz"))
    assert svc.bundle_file(b["id"])[0].exists() and svc.describe_bundle(b["id"])["downloaded"] is False  # nothing is lost: the bundle holds the files and stays until it is downloaded
    assert svc.protect_disk()["files"] == 0  # nothing more to free


def test_the_owner_is_told_in_the_heads_up_until_the_bundle_is_downloaded(data: Path) -> None:
    svc = service(data, list(range(25, 40)))
    assert svc.notices() == []
    b = svc.build(day(39), day(25))
    n = svc.notices()
    assert len(n) == 1 and n[0]["source"] == "library" and n[0]["link"] == "/data" and n[0]["level"] == "warn" and n[0]["title"] == "Data bundle ready: download it"
    assert f"{day(39)} to {day(25)}, 15 days" in n[0]["text"] and "deletes it" in n[0]["text"]
    svc.now = lambda: NOW + timedelta(days=8)  # type: ignore[method-assign]
    assert svc.notices()[0]["key"] != n[0]["key"]  # a closed notice comes back the next week
    path, _ = svc.bundle_file(b["id"])
    svc.min_free = svc.free_bytes() + 1  # the disk is under its floor plus margin
    assert svc.notices()[0]["level"] == "bad" and "disk is getting full" in svc.notices()[0]["text"]
    svc.min_free = 0
    svc.confirm(b["id"], hashlib.sha256(path.read_bytes()).hexdigest())
    assert svc.notices() == []  # downloaded: nothing more to say


def test_a_missing_bundle_file_stops_counting_as_a_safe_copy(data: Path) -> None:
    svc = service(data, list(range(25, 40)))
    b = svc.build(day(39), day(25))
    assert svc.bundled_days()
    svc.bundle_file(b["id"])[0].unlink()
    assert svc.bundled_days() == set()  # the gate no longer treats those days as safe


def test_the_database_can_be_lost_without_losing_a_bundle(data: Path) -> None:
    svc = service(data, list(range(25, 40)))
    svc.build(day(39), day(25))
    svc.store.close()
    (data / "library.sqlite3").unlink()
    fresh = LibraryService(data, FakeObs({}), "NIFTY", clock=lambda: NOW, min_free_bytes=0)
    assert fresh.store.bundles() == [] and fresh.rescan() == 1 and len(fresh.bundled_days()) == 15


def test_a_build_needs_free_space_and_a_sensible_range(data: Path) -> None:
    svc = service(data, list(range(25, 40)))
    svc.min_free = 10**15
    with pytest.raises(LibraryError) as e:
        svc.build(day(39), day(25))
    assert e.value.code == "low_disk"
    svc.min_free = 0
    with pytest.raises(LibraryError) as e2:
        svc.build(day(25), day(39))
    assert e2.value.code == "bad_range"
    with pytest.raises(LibraryError) as e3:
        svc.build(day(100), day(90))
    assert e3.value.code == "nothing_to_bundle"


# ------------------------------------------------------------------ temporary restore and the coverage check
def test_a_restore_unpacks_into_a_scratch_folder_that_expires_by_itself(data: Path) -> None:
    svc = service(data, list(range(25, 40)))
    b = svc.build(day(39), day(25))
    for d in svc.bundled_days():  # the loose files are gone, as after pruning
        for f in (data / "snapshots" / d).iterdir():
            f.unlink()
    r = svc.restore_from_server(b["id"])
    folder = Path(r["dir"])
    assert folder.parent == svc.restore_dir and (folder / "snapshots" / day(30).isoformat()).is_dir() and svc.fallback_roots() == [folder]
    assert r["days"] == b["days"] and r["bytes"] > 0
    assert len(list((folder / "snapshots").rglob("*.gz"))) == 15 * 3 and svc.cleanup_restores() == 0
    kept = svc.keep_restore(r["id"], days=7)
    assert kept["expires_utc"] > r["expires_utc"]
    svc.now = lambda: NOW + timedelta(days=8)  # type: ignore[method-assign]
    assert svc.cleanup_restores() == 1 and not folder.exists() and svc.fallback_roots() == [] and svc.store.restores() == []


def test_a_restore_can_be_removed_early_and_a_big_bundle_is_refused(data: Path) -> None:
    svc = service(data, list(range(25, 40)))
    b = svc.build(day(39), day(25))
    r = svc.restore_from_server(b["id"])
    svc.remove_restore(r["id"])
    assert not Path(r["dir"]).exists()
    svc.restore_max = 100
    with pytest.raises(LibraryError) as e:
        svc.restore_from_server(b["id"])
    assert e.value.code == "too_big" and not any(svc.restore_dir.glob("r-*"))


def test_a_restore_of_something_that_is_not_a_bundle_is_refused(data: Path, tmp_path: Path) -> None:
    svc = service(data, [30])
    p = tmp_path / "nope.zip"
    p.write_bytes(b"nothing")
    with pytest.raises(LibraryError) as e:
        svc.restore(p, "nope.zip")
    assert e.value.code == "bad_bundle"


def test_the_coverage_check_names_the_days_that_are_not_there(data: Path) -> None:
    svc = service(data, [10, 9, 8])
    svc.obs.counts[day(9).isoformat()] = 120  # a partial day
    c = svc.coverage([day(n).isoformat() for n in (10, 9, 8, 7)])
    assert c["ok"] is False and c["observations_missing"] == [day(9).isoformat(), day(7).isoformat()] and c["observations_ok"] == 2
    assert "2 of 4 sessions" in c["message"] and c["snapshot_files_missing"] == [day(7).isoformat()]
    assert svc.coverage([day(10).isoformat()])["ok"] is True


def test_the_inventory_says_where_each_day_is(data: Path) -> None:
    svc = service(data, list(range(25, 40)))
    b = svc.build(day(39), day(25))
    for f in (data / "snapshots" / day(39).isoformat()).iterdir():
        f.unlink()
    rows = {r["day"]: r for r in svc.inventory()}
    assert rows[day(39).isoformat()]["state"] == "in a bundle" and rows[day(39).isoformat()]["bundle"]["id"] == b["id"]
    assert rows[day(30).isoformat()]["state"] == "on the server" and rows[day(30).isoformat()]["snapshot_files"] == 3 and rows[day(30).isoformat()]["archive"] is True
    assert rows[day(30).isoformat()]["exported"] is False
    path, _ = svc.bundle_file(b["id"])
    svc.confirm(b["id"], hashlib.sha256(path.read_bytes()).hexdigest())
    after = {r["day"]: r for r in svc.inventory()}
    assert after[day(30).isoformat()]["exported"] is True and after[day(30).isoformat()]["state"] == "downloaded, removed from the server"
    s = svc.status()
    assert s["unconfirmed_bundles"] == 0 and s["policy"]["block_days"] == 30 and s["bundles"] == [] and s["next_block"] is None


# ------------------------------------------------------------------ the API
@pytest.fixture()
def api(tmp_path: Path) -> Any:
    app = make_app(tmp_path)
    with TestClient(app, client=("127.0.0.1", 50000)) as c:  # control actions are accepted from the local machine only
        data = app.state.settings.data_dir
        for n in range(25, 40):
            make_day(data, day(n))
        lib: LibraryService = app.state.library
        lib._clock = lambda: NOW  # noqa: SLF001
        lib.obs = FakeObs({day(n).isoformat(): 380 for n in range(25, 40)})
        lib.min_free = 0
        yield c, app


def test_the_api_builds_downloads_confirms_restores_and_removes(api: Any) -> None:
    c, app = api
    s = c.get("/api/library/status").json()
    assert s["bundles"] == [] and len(s["sessions"]) == 15 and s["policy"]["block_days"] == 30
    r = c.post("/api/library/bundles", json={"start": day(39).isoformat(), "end": day(25).isoformat()})
    assert r.status_code == 200, r.text
    b = r.json()
    dl = c.get(f"/api/library/bundles/{b['id']}/download")
    assert dl.status_code == 200 and dl.headers["content-type"] == "application/zip" and dl.headers["x-bundle-sha256"] == b["sha256"]
    assert "attachment" in dl.headers["content-disposition"] and b["name"] in dl.headers["content-disposition"]
    assert hashlib.sha256(dl.content).hexdigest() == b["sha256"]  # the browser can verify what it received
    bad = c.post(f"/api/library/bundles/{b['id']}/confirm", json={"sha256": "0" * 64})
    assert bad.status_code == 409 and bad.json()["detail"]["code"] == "checksum_mismatch"
    assert c.delete(f"/api/library/bundles/{b['id']}").status_code == 409  # not downloaded yet
    rs = c.post("/api/library/restore", json={"bundle_id": b["id"]})
    assert rs.status_code == 200 and rs.json()["days"] == b["days"]
    assert c.post(f"/api/library/restore/{rs.json()['id']}/keep").status_code == 200
    assert c.delete(f"/api/library/restore/{rs.json()['id']}").status_code == 200
    assert c.delete(f"/api/library/restore/{rs.json()['id']}").status_code == 404
    heads = c.get("/api/headsup/trades").json()["alerts"]
    assert [a["title"] for a in heads if a["source"] == "library"] == ["Data bundle ready: download it"]  # the owner is told in the heads-up strip
    done = c.post(f"/api/library/bundles/{b['id']}/confirm", json={"sha256": b["sha256"]}).json()
    assert done["downloaded"] is True and done["released_files"] == 15 * 3 and done["on_server"] is False  # the server has deleted the bundle and the snapshot files
    assert c.get(f"/api/library/bundles/{b['id']}/download").status_code == 404
    assert c.get("/api/library/status").json()["bundles"] == []
    assert [a for a in c.get("/api/headsup/trades").json()["alerts"] if a["source"] == "library"] == []  # nothing more to say


def test_the_api_restores_from_an_uploaded_zip_streamed_to_disk(api: Any) -> None:
    c, app = api
    b = c.post("/api/library/bundles", json={"start": day(39).isoformat(), "end": day(25).isoformat()}).json()
    blob = c.get(f"/api/library/bundles/{b['id']}/download").content
    up = c.put("/api/library/restore/upload?name=../../my%20bundle.zip", content=blob, headers={"content-type": "application/octet-stream"})
    assert up.status_code == 200, up.text
    assert up.json()["bundle_name"] == "my bundle.zip" and up.json()["days"] == b["days"]  # a path in the name is dropped
    assert not list((app.state.library.restore_dir / "inbox").glob("*.zip"))  # the uploaded file is not kept
    junk = c.put("/api/library/restore/upload?name=junk.zip", content=b"not a bundle")
    assert junk.status_code == 422 and junk.json()["detail"]["code"] == "bad_bundle"
    app.state.library.restore_max = 1000
    big = c.put("/api/library/restore/upload?name=big.zip", content=blob)
    assert big.status_code == 413 or big.json()["detail"]["code"] == "too_big"


def test_the_api_coverage_and_errors(api: Any) -> None:
    c, app = api
    ok = c.get(f"/api/library/coverage?start={day(39)}&end={day(25)}").json()
    assert ok["days"] == 15 and ok["ok"] is True
    assert c.get(f"/api/library/coverage?start={day(25)}&end={day(39)}").status_code == 422
    assert c.post("/api/library/bundles", json={"start": day(5).isoformat(), "end": day(1).isoformat()}).status_code == 404
    assert c.post("/api/library/bundles/999/confirm", json={"sha256": "0" * 64}).status_code == 404
    app.state.library.enabled = False
    assert c.get("/api/library/status").status_code == 404


def test_control_actions_are_refused_from_a_remote_client(api: Any) -> None:
    c, app = api
    remote = TestClient(app, client=("203.0.113.9", 5000))
    r = remote.post("/api/library/bundles", json={"start": day(39).isoformat(), "end": day(25).isoformat()})
    assert r.status_code == 403
    assert remote.get("/api/library/status").status_code == 200  # reading is open to the signed-in site


def test_a_backtest_result_carries_the_data_coverage(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    c, app = api
    sessions = [day(n).isoformat() for n in (30, 29)]
    monkeypatch.setattr(app.state.intraday, "backtest", lambda *a, **k: {"status": "ok", "sessions": sessions, "tests": []})
    res = c.get("/api/intraday/backtest?expiry=2026-12-24&sessions=5").json()
    assert res["data_coverage"]["ok"] is True and res["data_coverage"]["days"] == 2
    app.state.library.obs.counts.pop(sessions[0])
    res2 = c.get("/api/intraday/backtest?expiry=2026-12-24&sessions=5").json()
    assert res2["data_coverage"]["observations_missing"] == [sessions[0]] and "partial days" in res2["data_coverage"]["message"]


# ------------------------------------------------------------------ the snapshot reader and the clean-up page use the library
def test_a_snapshot_file_missing_from_the_server_is_read_from_an_active_restore(api: Any) -> None:
    from tests.unit.test_risk_api import chain

    c, app = api
    store = app.state.store
    snap = chain("2026-11-23", datetime(2026, 11, 20, 10, 0, tzinfo=UTC), sid="snap-restored")
    store.save(snap, {})
    ref = store.list(underlying=snap.underlying, limit=5)
    assert ref, "the snapshot was saved"
    path = next((app.state.settings.data_dir / "snapshots").rglob("snap-restored.json.gz"))
    rel = path.relative_to(app.state.settings.data_dir)
    scratch = app.state.library.restore_dir / "r-test"
    (scratch / rel.parent).mkdir(parents=True)
    path.replace(scratch / rel)  # the file is gone from the data directory, as after pruning
    assert store.load("snap-restored") is None  # no restore is active: reported as removed
    app.state.library.store.add_restore("b.zip", str(scratch), [rel.parts[1]], 1, NOW.isoformat(), (NOW + timedelta(hours=1)).isoformat())
    loaded = store.load("snap-restored")
    assert loaded is not None and loaded.snapshot_id == "snap-restored"  # read from the temporary restore


def test_the_manual_clean_up_waits_for_the_bundle_like_the_nightly_run(api: Any) -> None:
    from app.lifecycle import cleanup

    c, app = api
    eod = app.state.eod
    assert cleanup._bundled(eod) == set()  # noqa: SLF001 - the library is in use and nothing has been downloaded yet
    b = app.state.library.build(day(39), day(25))
    assert cleanup._bundled(eod) == set()  # noqa: SLF001 - a bundle on the server is not a copy off the server
    path, _ = app.state.library.bundle_file(b["id"])
    app.state.library.confirm(b["id"], b["sha256"])
    assert cleanup._bundled(eod) == {day(n).isoformat() for n in range(25, 40)}  # noqa: SLF001 - after a confirmed download
    eod.library = None
    assert cleanup._bundled(eod) is None  # noqa: SLF001 - without the library only the archive is waited for


# ------------------------------------------------------------------ a day that moved into a bundle comes back when something asks for it
def test_a_day_inside_a_bundle_is_restored_when_asked_for_and_only_within_the_limits(data: Path) -> None:
    svc = service(data, list(range(25, 40)))
    assert svc.ensure_day(day(30).isoformat()) is None  # no bundle holds it yet
    svc.build(day(39), day(25))
    first = svc.ensure_day(day(30).isoformat())
    assert first is not None and (first / "snapshots" / day(30).isoformat()).is_dir()
    assert svc.ensure_day(day(31).isoformat()) == first  # the same restore serves every day of that bundle
    assert len(svc.store.restores()) == 1
    assert svc.ensure_day(day(5).isoformat()) is None  # a day no bundle holds
    svc.remove_restore(svc.store.restores()[0]["id"])
    svc.restore_max = 100  # a bundle bigger than the allowance for restores is not unpacked on the quiet
    assert svc.ensure_day(day(30).isoformat()) is None and svc.store.restores() == []


def test_the_snapshot_reader_restores_a_bundled_day_by_itself(api: Any) -> None:
    from tests.unit.test_risk_api import chain

    c, app = api
    store, lib = app.state.store, app.state.library
    snap = chain("2026-11-23", datetime(2026, 11, 20, 10, 0, tzinfo=UTC), sid="snap-ondemand")
    store.save(snap, {})
    data_dir = app.state.settings.data_dir
    path = next((data_dir / "snapshots").rglob("snap-ondemand.json.gz"))
    folder_day = path.parent.name
    lib.build(date.fromisoformat(folder_day), date.fromisoformat(folder_day))
    for f in path.parent.iterdir():  # as after the pruning: the loose files are gone, the bundle holds them
        f.unlink()
    assert not path.exists() and lib.store.restores() == []
    loaded = store.load("snap-ondemand")
    assert loaded is not None and loaded.snapshot_id == "snap-ondemand"  # restored from its bundle, then read
    assert len(lib.store.restores()) == 1 and not path.exists()  # the loose file did not come back: only the scratch copy exists
    assert store.load("snap-ondemand") is not None and len(lib.store.restores()) == 1  # the second read reuses the restore


# ------------------------------------------------------------------ the end-of-day run
def test_the_end_of_day_run_bundles_a_finished_block_once_a_day_and_leaves_the_pruning_to_the_library(api: Any) -> None:
    c, app = api
    eod, lib = app.state.eod, app.state.library
    eod.enabled = True
    eod._clock = lambda: NOW  # noqa: SLF001
    assert eod.library is lib and eod.library_due(NOW) is True
    assert eod.library_due(NOW.replace(hour=5)) is False  # before 15:55 IST nothing runs
    res = eod.run(NOW)
    assert res["library"]["built"]["days"] == 15 and len(lib.store.bundles()) == 1
    assert res["prune"] == {"handled_by": "the data library: snapshot files are deleted after the bundle that holds them has been downloaded"}
    assert any((app.state.settings.data_dir / "snapshots").rglob("*.gz"))  # the snapshot files are still there: they wait for the download
    assert eod.library_due(NOW) is False  # once a day
    assert "library" not in eod.run(NOW)


def test_a_bundle_confirmed_before_the_rule_existed_is_released_by_the_next_automatic_step(data: Path) -> None:
    svc = service(data, list(range(25, 40)))
    b = svc.build(day(39), day(25))
    path, _ = svc.bundle_file(b["id"])
    svc.store.confirm_bundle(b["id"], NOW.isoformat())  # downloaded and confirmed, but nothing was deleted (an earlier version)
    assert path.exists() and any((data / "snapshots").rglob("*.gz"))
    out = svc.auto_run()
    assert out["released"] == 1 and not path.exists() and not any((data / "snapshots").rglob("*.gz"))
    assert svc.exported_days() and svc.store.bundles() == []
