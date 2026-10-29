"""End-of-day lifecycle: archive, manifest, summaries, backups, tidy and the approved pruning.

Option-chain content is the REAL captured Kotak chain (tests/fixtures) recorded as if sampled at the
given times; sizes and dates are small so every number can be checked by hand.
"""

from __future__ import annotations

import gzip
import json
import os
import sqlite3
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from app.intraday.store import IntradayStore
from app.lifecycle import storage
from app.lifecycle.archive import archive_day, archive_path, day_window, verify_archive
from app.lifecycle.backup import backup_databases, retention, verify_folder
from app.lifecycle.eod import RUN_AFTER, EodService
from app.prediction.history_store import HistoryStore
from app.storage.observations import ObservationStore
from tests.unit.test_intraday import EXP, ist, real_chain

DAY = date(2026, 10, 29)


def fill(tmp: Path, n: int = 40, day: date = DAY, start=(9, 15)) -> ObservationStore:
    obs = ObservationStore(tmp)
    t0 = ist(*start, d=day)
    for i in range(n):
        obs.record_snapshot(real_chain((t0 + timedelta(minutes=i)).astimezone(UTC), f"{day}-{i}", EXP), unchanged=i % 3 == 2)
    return obs


def service(tmp: Path, obs: ObservationStore, now: datetime, **kw) -> EodService:
    return EodService(obs, IntradayStore(tmp), HistoryStore(tmp), tmp, "NIFTY", clock=lambda: now.astimezone(UTC), **kw)


# --------------------------------------------------------------------------------- archive
class TestArchive:
    def test_roundtrip_matches_the_database_and_is_verified(self, tmp_path: Path) -> None:
        obs = fill(tmp_path)
        r = archive_day(obs, "NIFTY", DAY, tmp_path)
        s, e = day_window(DAY)
        assert r.verified and (r.samples, r.contracts) == obs.window_counts("NIFTY", s, e) and r.samples == 40
        p = archive_path(tmp_path, DAY)
        assert p.name == "date=2026-10-29.jsonl.gz" and "year=2026" in p.as_posix()
        assert verify_archive(p, r.sha256, r.samples, r.contracts) is None
        with gzip.open(p, "rt") as f:
            head = json.loads(f.readline())
            first = json.loads(f.readline())
        assert head["t"] == "header" and head["units"].startswith("prices in paise") and first["t"] == "sample" and first["spot_p"] > 0
        assert not list(p.parent.glob("*.tmp"))

    def test_unchanged_samples_have_no_contract_rows_and_are_kept_as_samples(self, tmp_path: Path) -> None:
        r = archive_day(fill(tmp_path, 6), "NIFTY", DAY, tmp_path)
        rows_of: dict[int, int] = {}
        flags: dict[int, int] = {}
        with gzip.open(archive_path(tmp_path, DAY), "rt") as f:
            for line in f:
                x = json.loads(line)
                if x["t"] == "sample":
                    flags[x["sample_id"]] = x["unchanged"]
                    rows_of.setdefault(x["sample_id"], 0)
                elif x["t"] == "c":
                    rows_of[x["s"]] += 1
        assert len(flags) == 6 and sum(flags.values()) == 2  # samples 3 and 6 were recorded as unchanged
        assert all(rows_of[i] == 0 for i, u in flags.items() if u)
        assert sum(rows_of.values()) == r.contracts > 0

    def test_a_second_run_never_overwrites(self, tmp_path: Path) -> None:
        obs = fill(tmp_path)
        a = archive_day(obs, "NIFTY", DAY, tmp_path)
        mtime = archive_path(tmp_path, DAY).stat().st_mtime_ns
        b = archive_day(obs, "NIFTY", DAY, tmp_path)
        assert b.verified and b.sha256 == a.sha256 and archive_path(tmp_path, DAY).stat().st_mtime_ns == mtime

    def test_damage_and_mismatch_are_detected(self, tmp_path: Path) -> None:
        obs = fill(tmp_path)
        r = archive_day(obs, "NIFTY", DAY, tmp_path)
        p = archive_path(tmp_path, DAY)
        assert "expected" in (verify_archive(p, r.sha256, r.samples + 1, r.contracts) or "")
        data = bytearray(p.read_bytes())
        data[len(data) // 2] ^= 0xFF
        p.write_bytes(bytes(data))
        assert "checksum" in (verify_archive(p, r.sha256, r.samples, r.contracts) or "")
        assert archive_day(obs, "NIFTY", DAY, tmp_path).verified is False  # a damaged existing file is reported, not trusted
        assert verify_archive(tmp_path / "nope.gz", "x", 0, 0) == "archive file is missing"

    def test_a_day_without_samples_is_not_archived(self, tmp_path: Path) -> None:
        r = archive_day(ObservationStore(tmp_path), "NIFTY", DAY, tmp_path)
        assert not r.verified and r.problem == "no samples on this day" and not archive_path(tmp_path, DAY).exists()

    def test_other_days_do_not_leak_in(self, tmp_path: Path) -> None:
        obs = fill(tmp_path, 5, day=DAY - timedelta(days=1))
        fill(tmp_path, 7, day=DAY)
        assert archive_day(obs, "NIFTY", DAY, tmp_path).samples == 7


# ----------------------------------------------------------------------------------- end of day
class TestEod:
    def test_nothing_runs_while_the_market_is_open(self, tmp_path: Path) -> None:
        svc = service(tmp_path, fill(tmp_path), ist(14, 0))
        assert svc.pending_days() == [] and not svc.due()
        assert service(tmp_path, ObservationStore(tmp_path), ist(15, 44)).pending_days() == []

    def test_after_the_close_a_session_is_validated_archived_summarised_and_manifested(self, tmp_path: Path) -> None:
        obs = fill(tmp_path, 320)  # 09:15..14:34: enough for a complete session
        svc = service(tmp_path, obs, ist(*(RUN_AFTER.hour, RUN_AFTER.minute)))
        assert svc.pending_days() == [DAY] and svc.due()
        out = svc.run()
        assert out["state"] == "ok"
        m = svc.manifest(DAY)
        assert m and m["status"] == "complete" and m["ml_ready_session"] is True and m["archive"]["verified"] is True
        assert m["validation"]["expiries"][EXP]["samples_in_session"] == 320
        assert verify_archive(tmp_path / m["archive"]["path"], m["archive"]["sha256"], 320, m["archive"]["contracts"]) is None
        sums = IntradayStore(tmp_path).summaries()
        assert len(sums) == 1 and sums[0]["expiry"] == EXP and sums[0]["status"] == "complete" and sums[0]["price"]["first"] > 0
        # the compact close-of-day chain is kept in the permanent summary: every listed strike, both sides
        cc = sums[0]["close_chain"]
        assert cc["columns"][:3] == ["strike", "ce_ltp", "ce_oi"] and len(cc["rows"]) == 81 and cc["spot"] > 0
        atm = min(cc["rows"], key=lambda r: abs(r[0] - cc["spot"]))
        assert atm[1] and atm[5] and atm[2] and atm[6]  # ATM call/put LTP and OI present, not zero-filled placeholders
        # idempotent: nothing pending, the second run writes nothing new
        assert svc.pending_days() == [] and len(IntradayStore(tmp_path).summaries()) == 1

    def test_a_short_session_is_partial_not_ml_ready_and_still_archived(self, tmp_path: Path) -> None:
        svc = service(tmp_path, fill(tmp_path, 40), ist(16, 0))
        svc.run()
        m = svc.manifest(DAY)
        assert m["status"] == "partial" and m["ml_ready_session"] is False and m["archive"]["verified"]
        assert svc.status()["complete_sessions"] == 0 and svc.status()["sessions_archived"] == 1

    def test_missed_days_are_caught_up_oldest_first(self, tmp_path: Path) -> None:
        obs = fill(tmp_path, 10, day=DAY - timedelta(days=2))
        fill(tmp_path, 12, day=DAY - timedelta(days=1))
        s = service(tmp_path, obs, ist(10, 0))  # next morning: both earlier days are finished
        assert s.pending_days() == [DAY - timedelta(days=2), DAY - timedelta(days=1)]
        s.run()
        assert s.pending_days() == []

    def test_a_failed_archive_writes_no_manifest_and_is_retried(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        svc = service(tmp_path, fill(tmp_path), ist(16, 0))
        import app.lifecycle.eod as eod

        real = eod.archive_day
        monkeypatch.setattr(eod, "archive_day", lambda *a, **k: type(real(*a, **k))("x", "", 0, 0, 0, False, "disk full"))
        out = svc.run()
        assert out["state"] == "error" and svc.manifest(DAY) is None
        assert not svc.due(ist(16, 5))  # backs off for 30 minutes
        assert svc.due(ist(16, 40))
        monkeypatch.undo()
        assert svc.run()["state"] == "ok" and svc.manifest(DAY) is not None

    def test_disabled_does_nothing(self, tmp_path: Path) -> None:
        assert not service(tmp_path, fill(tmp_path), ist(16, 0), enabled=False).due()

    def test_the_database_is_untouched(self, tmp_path: Path) -> None:
        obs = fill(tmp_path, 30)
        s, e = day_window(DAY)
        before = obs.window_counts("NIFTY", s, e)
        service(tmp_path, obs, ist(16, 0)).run()
        assert obs.window_counts("NIFTY", s, e) == before


# ------------------------------------------------------------------------------------ backups
def make_dbs(tmp: Path) -> None:
    for n in ("a", "b"):
        c = sqlite3.connect(tmp / f"{n}.sqlite3")
        c.execute("CREATE TABLE t(x)")
        c.executemany("INSERT INTO t VALUES (?)", [(i,) for i in range(50)])
        c.commit()
        c.close()


class TestBackup:
    def test_backup_is_verified_and_a_repeat_is_a_no_op(self, tmp_path: Path) -> None:
        make_dbs(tmp_path)
        r = backup_databases(tmp_path, DAY)
        assert r.ok and set(r.files) == {"a.sqlite3.gz", "b.sqlite3.gz"}
        folder = tmp_path / "backups" / "daily" / "20261029"
        assert verify_folder(folder) == []
        with gzip.open(folder / "a.sqlite3.gz") as f:
            (tmp_path / "restored.db").write_bytes(f.read())
        assert sqlite3.connect(tmp_path / "restored.db").execute("SELECT COUNT(*) FROM t").fetchone() == (50,)
        assert backup_databases(tmp_path, DAY).skipped_existing

    def test_corruption_is_detected(self, tmp_path: Path) -> None:
        make_dbs(tmp_path)
        backup_databases(tmp_path, DAY)
        f = tmp_path / "backups" / "daily" / "20261029" / "a.sqlite3.gz"
        f.write_bytes(f.read_bytes()[:-4] + b"zzzz")
        assert verify_folder(f.parent) == ["a.sqlite3.gz checksum differs"]

    def test_retention_keeps_newest_daily_and_the_first_of_each_recent_month(self) -> None:
        names = [f"2026{m:02d}{d:02d}" for m in (8, 9, 10) for d in (1, 2, 15, 28)]
        drop = {p.name for p in retention([Path(n) for n in names], keep_daily=3, keep_monthly=2)}
        keep = set(names) - drop
        assert {"20261015", "20261028", "20261002"} <= keep  # newest three
        assert {"20260901", "20261001"} <= keep  # first of the two newest months
        assert "20260801" in drop and "20260928" in drop

    def test_only_dated_backup_folders_are_ever_removed(self, tmp_path: Path) -> None:
        make_dbs(tmp_path)
        (tmp_path / "backups").mkdir()
        keep = tmp_path / "backups" / "nse_flows_before_prune_20261029.sqlite3"
        keep.write_bytes(b"safety copy")
        for d in range(1, 12):
            backup_databases(tmp_path, date(2026, 10, d), keep_daily=3, keep_monthly=1)
        left = sorted(p.name for p in (tmp_path / "backups" / "daily").iterdir())
        assert left == ["20261001", "20261009", "20261010", "20261011"] and keep.exists()

    def test_a_failing_database_blocks_the_backup_and_the_cleanup(self, tmp_path: Path) -> None:
        make_dbs(tmp_path)
        (tmp_path / "bad.sqlite3").write_bytes(b"this is not a database" * 50)
        r = backup_databases(tmp_path, DAY)
        assert not r.ok and any("bad.sqlite3" in p for p in r.problems) and not (tmp_path / "backups" / "daily" / "20261029").exists()


# --------------------------------------------------------------------- tidy, plan and pruning
def snap_files(tmp: Path, day: str, ids: list[str]) -> None:
    d = tmp / "snapshots" / day
    d.mkdir(parents=True, exist_ok=True)
    for i in ids:
        (d / f"{i}.json.gz").write_bytes(b"n" * 100)
        (d / f"{i}.raw.json.gz").write_bytes(b"r" * 60)


class TestStorage:
    def test_tidy_removes_only_old_exports_and_stale_tmp(self, tmp_path: Path) -> None:
        (tmp_path / "exports").mkdir()
        old, new = tmp_path / "exports" / "old.csv", tmp_path / "exports" / "new.csv"
        old.write_text("x")
        new.write_text("y")
        long_ago = time.time() - 20 * 86400
        os.utime(old, (long_ago, long_ago))
        stray = tmp_path / "x.tmp"
        stray.write_text("t")
        os.utime(stray, (time.time() - 7200, time.time() - 7200))
        db = tmp_path / "observations.sqlite3"
        db.write_text("keep")
        snap_files(tmp_path, "2026-01-01", ["s1"])
        out = storage.tidy(tmp_path)
        assert out["files_removed"] == 2 and not old.exists() and not stray.exists() and new.exists() and db.exists()
        assert len(list((tmp_path / "snapshots").rglob("*"))) == 3

    def test_pressure_levels_for_a_15_gb_server_and_a_big_pc(self) -> None:
        gb = 1_000_000_000
        assert storage.pressure(7 * gb, 15 * gb) == "ok" and storage.pressure(3 * gb, 15 * gb) == "watch"
        assert storage.pressure(int(2.2 * gb), 15 * gb) == "low" and storage.pressure(1 * gb, 15 * gb) == "critical"
        assert storage.pressure(100 * gb, 214 * gb) == "ok"

    def test_pruning_is_off_by_default_and_a_dry_run_changes_nothing(self, tmp_path: Path) -> None:
        snap_files(tmp_path, "2026-09-01", ["a"])
        none = storage.prune_snapshots(tmp_path, DAY, 0, 0, {"2026-09-01"}, {"a"}, dry_run=False)
        assert none["raw_files"] == none["normalized_files"] == 0
        dry = storage.prune_snapshots(tmp_path, DAY, 7, 30, {"2026-09-01"}, {"a"}, dry_run=True)
        assert (dry["raw_files"], dry["normalized_files"], dry["raw_bytes"], dry["normalized_bytes"]) == (1, 1, 60, 100)
        assert len(list((tmp_path / "snapshots" / "2026-09-01").iterdir())) == 2

    def test_pruning_applies_the_two_limits_and_every_safety_condition(self, tmp_path: Path) -> None:
        snap_files(tmp_path, "2026-10-10", ["old"])  # 19 days old: raw (7) goes, normalized (30) stays
        snap_files(tmp_path, "2026-09-01", ["older", "unknown"])  # 58 days: both go, except the unsafe ones
        snap_files(tmp_path, "2026-08-01", ["unarchived"])  # no verified archive: nothing may go
        snap_files(tmp_path, "2026-10-27", ["recent"])  # inside both limits
        snap_files(tmp_path, DAY.isoformat(), ["today"])
        out = storage.prune_snapshots(tmp_path, DAY, 7, 30, {"2026-10-10", "2026-09-01", "2026-10-27", DAY.isoformat()}, {"old", "older", "recent", "today", "unarchived"}, dry_run=False)
        left = {p.relative_to(tmp_path / "snapshots").as_posix() for p in (tmp_path / "snapshots").rglob("*") if p.is_file()}
        assert "2026-10-10/old.json.gz" in left and "2026-10-10/old.raw.json.gz" not in left
        assert not any(x.startswith("2026-09-01/older") for x in left)
        assert {"2026-09-01/unknown.json.gz", "2026-09-01/unknown.raw.json.gz"} <= left  # id not in the database
        assert {"2026-08-01/unarchived.json.gz", "2026-08-01/unarchived.raw.json.gz"} <= left
        assert {f"2026-10-27/recent{s}" for s in (".json.gz", ".raw.json.gz")} <= left
        assert {f"{DAY}/today{s}" for s in (".json.gz", ".raw.json.gz")} <= left
        assert (out["raw_files"], out["normalized_files"], out["kept_not_archived"], out["kept_not_in_database"]) == (2, 1, 2, 2)

    def test_report_has_every_category_a_runway_and_a_dry_run_plan(self, tmp_path: Path) -> None:
        snap_files(tmp_path, "2026-10-28", ["a", "b"])
        (tmp_path / "observations.sqlite3").write_bytes(b"x" * 1000)
        r = storage.report(tmp_path, None, DAY, prune_days=0, archived_days={"2026-10-28"})
        names = {c["name"] for c in r["categories"]}
        assert {"observations", "snapshots", "forecast ledger", "archive", "backups", "exports"} <= names
        assert r["growth_bytes_per_day"] > 0 and r["runway_days"] and r["snapshot_pruning_plan"]["executed"] is False


class TestPrunedSnapshotsAreHandled:
    def test_a_missing_snapshot_file_reads_as_not_available_not_as_an_error(self, tmp_path: Path) -> None:
        from app.domain.models import DataSource
        from app.storage.store import SnapshotStore

        store = SnapshotStore(tmp_path)
        store.start_session("s", "live")
        snap = real_chain(ist(10, 0).astimezone(UTC), "20261029T043000000000Z_NIFTY_20261103_aaaaaaaa", EXP).model_copy(update={"session_id": "s", "source": DataSource.SNAPSHOT})
        store.save(snap, {"x": 1})
        assert store.load(snap.snapshot_id) is not None
        for f in (tmp_path / "snapshots").rglob("*"):
            if f.is_file():
                f.unlink()
        assert store.load(snap.snapshot_id) is None
