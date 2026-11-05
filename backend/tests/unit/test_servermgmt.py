"""Server Management Centre: scans, path safety, snapshots, growth, forecasts, retention, alerts, logs, API guards.

Everything runs on temporary directories and controlled rows; nothing touches the real data directory.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.servermgmt import config as cfg
from app.servermgmt import ops
from app.servermgmt import scan as sc
from app.servermgmt.service import ServerMgmt
from app.servermgmt.store import MgmtStore
from tests.conftest import make_app

LOOP = ("127.0.0.1", 50000)
HDR = {"X-NSE-Action": "server-mgmt"}


def write(p: Path, n: int) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * n)


def tree(root: Path) -> None:
    write(root / "a" / "f1.bin", 100)
    write(root / "a" / "b" / "f2.bin", 50)
    write(root / "c" / "f3.bin", 10)
    write(root / "top.txt", 5)


def scan(root: Path, **kw: Any) -> sc.ScanResult:
    args: dict[str, Any] = {"timeout_s": 30, "top_n": 10, "excluded_dirs": [], "excluded_patterns": []}
    return sc.scan_area(sc.Area("t", root, "t"), **{**args, **kw})


# ------------------------------------------------------------------ scan
def test_scan_totals_are_exact_and_nothing_is_counted_twice(tmp_path: Path) -> None:
    tree(tmp_path / "r")
    r = scan(tmp_path / "r")
    assert (r.bytes, r.files, r.dirs, r.complete) == (165, 4, 3, True)
    assert {k: v[0] for k, v in r.by_top.items()} == {"a": 150, "c": 10, "(files in root)": 5}
    assert sum(v[0] for v in r.by_top.values()) == r.bytes  # the parts add up to the total: no nested directory twice
    assert [b[1] for b in r.biggest][:2] == ["a/f1.bin", "a/b/f2.bin"]
    assert r.alloc >= 0


def test_scan_does_not_follow_symlinks_and_counts_hard_links_once(tmp_path: Path) -> None:
    root, outside = tmp_path / "r", tmp_path / "outside"
    tree(root)
    write(outside / "big.bin", 100_000)
    try:
        os.symlink(outside, root / "link")
        os.link(root / "a" / "f1.bin", root / "a" / "f1-hard.bin")
    except (OSError, NotImplementedError):
        pytest.skip("this host cannot create symlinks or hard links")
    r = scan(root)
    assert r.bytes < 1000  # the 100 kB file behind the link is not part of the area
    assert r.bytes == 165 + (os.lstat(root / "link").st_size)  # only the link itself; the hard link added nothing


def test_scan_stops_at_its_time_limit_and_says_partial(tmp_path: Path) -> None:
    for i in range(2100):
        write(tmp_path / "r" / f"f{i}", 1)
    r = scan(tmp_path / "r", timeout_s=-1)
    assert r.complete is False and r.files < 2100


def test_scan_of_a_missing_area_is_not_complete(tmp_path: Path) -> None:
    r = scan(tmp_path / "nope")
    assert r.complete is False and r.errors and r.bytes == 0


def test_scan_honours_exclusions_and_skips_nested_areas(tmp_path: Path) -> None:
    tree(tmp_path / "r")
    write(tmp_path / "r" / "cache" / "x.bin", 1000)
    write(tmp_path / "r" / "keep.pyc", 7)
    r = scan(tmp_path / "r", excluded_dirs=["cache"], excluded_patterns=["*.pyc"])
    assert r.bytes == 165
    nested = os.path.normcase(os.path.abspath(tmp_path / "r" / "a"))
    assert scan(tmp_path / "r", skip=frozenset({nested}), excluded_dirs=["cache"], excluded_patterns=["*.pyc"]).bytes == 15  # c (10) + top (5): the nested area is counted in its own scan


def test_classification_protects_by_default() -> None:
    assert sc.classify("observations.sqlite3") == ("database or secret", True)
    assert sc.classify("exports/old.csv") == ("regenerable", False)
    assert sc.classify("snapshots/x.json")[1] is True
    assert sc.classify("something/unknown.dat")[1] is True


# ------------------------------------------------------------------ path safety
def test_resolve_inside_refuses_traversal_absolute_and_symlinks(tmp_path: Path) -> None:
    root = tmp_path / "r"
    tree(root)
    assert sc.resolve_inside(root, "a/b").is_dir()
    for bad in ("../x", "a/../../x", "/etc", "C:/Windows", "a\x00b", "\\evil"):
        with pytest.raises(sc.PathError):
            sc.resolve_inside(root, bad)
    try:
        os.symlink(tmp_path, root / "esc")
    except (OSError, NotImplementedError):
        pytest.skip("no symlinks on this host")
    with pytest.raises(sc.PathError):
        sc.resolve_inside(root, "esc")
    with pytest.raises(sc.PathError):
        sc.resolve_inside(root, "esc/anything")


def test_list_dir_gives_sizes_and_flags(tmp_path: Path) -> None:
    root = tmp_path / "r"
    tree(root)
    write(root / "x.sqlite3", 9)
    d = sc.list_dir(root, "")
    rows = {e["name"]: e for e in d["entries"]}
    assert rows["a"]["size"] == 150 and rows["a"]["files"] == 2 and rows["a"]["kind"] == "dir"
    assert rows["x.sqlite3"]["protected"] is True and rows["x.sqlite3"]["size"] == 9
    with pytest.raises(sc.PathError):
        sc.list_dir(root, "top.txt")


# ------------------------------------------------------------------ service
class Clock:
    def __init__(self, t: datetime) -> None:
        self.t = t

    def __call__(self) -> datetime:
        return self.t


def make(tmp_path: Path, start: str = "2026-11-01T06:00:00+00:00") -> tuple[ServerMgmt, Clock, Path]:
    root = tmp_path / "proj"
    tree(root)
    clock = Clock(datetime.fromisoformat(start))
    sm = ServerMgmt(MgmtStore(tmp_path / "db"), [sc.Area("project", root, "Project")], disk_path=tmp_path, clock=clock)
    return sm, clock, root


def day(clock: Clock, n: int) -> None:
    clock.t = datetime(2026, 11, 1, 6, 0, tzinfo=UTC) + timedelta(days=n)


def test_daily_snapshot_is_one_per_ist_date_and_retry_is_a_no_op(tmp_path: Path) -> None:
    sm, _, _ = make(tmp_path)
    a = sm.snapshot("daily")
    assert a["status"] == "complete" and a["nse_bytes"] == 165 and a["snapshot_date"] == "2026-11-01" and "id" in a
    b = sm.snapshot("daily")
    assert "skipped" in b and "already exists" in b["skipped"]
    assert len(sm.store.q("SELECT id FROM storage_snapshots WHERE kind='daily'")) == 1
    m = sm.snapshot("manual")  # an on-demand scan is a separate, additional row
    assert "id" in m and len(sm.store.q("SELECT id FROM storage_snapshots")) == 2
    assert sm.history()[0]["id"] == a["id"]  # the table keeps the daily one for that date


def test_ist_date_is_used_for_the_snapshot_key(tmp_path: Path) -> None:
    sm, clock, _ = make(tmp_path, "2026-11-01T20:00:00+00:00")  # 01:30 IST on 2 Nov
    assert sm.snapshot("daily")["snapshot_date"] == "2026-11-02"
    del clock


def test_a_second_scan_is_refused_while_one_runs(tmp_path: Path) -> None:
    sm, _, _ = make(tmp_path)
    assert sm._scan_lock.acquire(blocking=False)  # noqa: SLF001
    try:
        r = sm.snapshot("manual")
        assert "already running" in r["skipped"]
    finally:
        sm._scan_lock.release()  # noqa: SLF001
    assert "id" in sm.snapshot("manual")


def test_failed_scan_is_recorded_as_failed_not_zero(tmp_path: Path) -> None:
    sm, clock, root = make(tmp_path)
    sm.snapshot("daily")
    day(clock, 1)
    sm.areas[0].root = tmp_path / "gone"
    r = sm.snapshot("daily")
    assert r["status"] == "failed" and r["nse_bytes"] is None and r["files"] is None
    rows = {h["snapshot_date"]: h for h in sm.history()}
    assert rows["2026-11-02"]["d_nse_bytes"] is None  # no number, not a drop to zero
    del root


def test_growth_is_only_between_complete_consecutive_days(tmp_path: Path) -> None:
    sm, clock, root = make(tmp_path)
    sm.snapshot("daily")  # 1 Nov: 165
    write(root / "a" / "grow.bin", 20)
    day(clock, 1)
    sm.snapshot("daily")  # 2 Nov: 185
    (root / "a" / "grow.bin").unlink()
    day(clock, 3)  # 4 Nov: 3 Nov is missing
    sm.snapshot("daily")
    h = {r["snapshot_date"]: r for r in sm.history()}
    assert h["2026-11-01"]["d_nse_bytes"] is None  # nothing before it
    assert h["2026-11-02"]["d_nse_bytes"] == 20 and h["2026-11-02"]["d_files"] == 1
    assert h["2026-11-04"]["d_nse_bytes"] is None  # previous day missing: unavailable, not a two-day difference
    assert sm.missing_dates(sm.history()) == ["2026-11-03"]
    # a decrease is shown as a decrease
    day(clock, 4)
    sm.snapshot("daily")
    assert {r["snapshot_date"]: r for r in sm.history()}["2026-11-05"]["d_nse_bytes"] == 0


def test_partial_snapshots_are_not_compared(tmp_path: Path) -> None:
    sm, clock, _ = make(tmp_path)
    sm.snapshot("daily")
    day(clock, 1)
    sm.store.x("UPDATE storage_snapshots SET status='partial'")  # pretend the first one was cut short
    sm.snapshot("daily")
    h = sm.history()
    assert h[1]["d_nse_bytes"] is None and h[1]["comparable"] is False


def test_compare_two_dates_lists_growth_and_flags_incomparable(tmp_path: Path) -> None:
    sm, clock, root = make(tmp_path)
    a = sm.snapshot("daily")
    write(root / "c" / "new.bin", 500)
    day(clock, 1)
    b = sm.snapshot("daily")
    out = sm.compare(a["id"], b["id"])
    rows = {r["name"]: r for r in out["rows"]}
    assert rows["project"]["change"] == 500 and rows["project/c"]["change"] == 500 and rows["project/c"]["change_pct"] == 5000.0
    assert out["growing"][0]["name"] == "project/c" and out["comparable"] is True
    assert out["files"][0]["path"] == "c/new.bin" and out["files"][0]["before"] is None
    with pytest.raises(KeyError):
        sm.compare(a["id"], 999)


def add_row(sm: ServerMgmt, date: str, used: int, status: str = "complete", total: int = 1000) -> None:
    sm.store.add_snapshot(
        {"snapshot_date": date, "kind": "daily", "ts_utc": f"{date}T12:00:00+00:00", "status": status, "method": sc.METHOD, "error": None, "fs_total": total, "fs_used": used, "fs_avail": total - used,
         "nse_bytes": used, "nse_alloc": used, "files": 1, "dirs": 1, "duration_s": 0.1, "own_db_bytes": 1}, [], [],
    )


def test_forecast_is_withheld_without_enough_valid_data(tmp_path: Path) -> None:
    sm, _, _ = make(tmp_path)
    assert sm.forecast()["available"] is False  # nothing yet
    for i, used in enumerate([100, 110, 120]):
        add_row(sm, f"2026-10-{10 + i}", used)
    f = sm.forecast()
    assert f["available"] is False and "needs 5" in f["reason"]


def test_forecast_uses_observed_growth_and_withholds_when_not_growing_or_erratic(tmp_path: Path) -> None:
    sm, _, _ = make(tmp_path)
    for i in range(8):
        add_row(sm, f"2026-10-{10 + i:02d}", 100 + 10 * i)  # +10 a day, last used 170 of 1000
    f = sm.forecast()
    assert f["available"] is True and f["avg_7d"] == 10
    assert f["days_to_threshold"] == pytest.approx((900 - 170) / 10)  # 90% of 1000 is 900
    assert f["projection"]["7"] == 240
    sm.store.x("DELETE FROM storage_snapshots")
    for i in range(8):
        add_row(sm, f"2026-10-{10 + i:02d}", 500 - 10 * i)
    g = sm.forecast()
    assert g["available"] is False and "zero or negative" in g["reason"]
    sm.store.x("DELETE FROM storage_snapshots")
    for i, used in enumerate([100, 100, 100, 100, 100, 100, 100, 900]):
        add_row(sm, f"2026-10-{10 + i:02d}", used)
    assert sm.forecast()["available"] is False  # one huge jump among flat days is not a trend


def test_series_leaves_missing_days_out(tmp_path: Path) -> None:
    sm, clock, _ = make(tmp_path)
    sm.snapshot("daily")
    day(clock, 3)
    sm.snapshot("daily")
    pts = sm.series("project", 30)
    assert [p["date"] for p in pts] == ["2026-11-01", "2026-11-04"]  # 2 and 3 Nov are absent, not zero


def test_csv_has_a_header_and_blank_for_unavailable(tmp_path: Path) -> None:
    sm, _, _ = make(tmp_path)
    sm.snapshot("daily")
    text = sm.csv(sm.history())
    lines = text.strip().splitlines()
    assert lines[0].startswith("snapshot_date,kind,status") and lines[1].startswith("2026-11-01,daily,complete")
    assert ",," in lines[1]  # d_fs_used of the first day is blank


# ------------------------------------------------------------------ retention, config
def test_retention_preview_changes_nothing_and_delete_removes_only_old_rows(tmp_path: Path) -> None:
    sm, clock, _ = make(tmp_path)
    old = (clock.t - timedelta(days=400)).isoformat(timespec="seconds")
    sm.store.add_sample({"ts_utc": old, "status": "ok"})
    sm.store.add_sample({"ts_utc": clock.t.isoformat(timespec="seconds"), "status": "ok"})
    # prune() works from the real clock, so make the "recent" row recent in real time too
    sm.store.add_sample({"ts_utc": datetime.now(UTC).isoformat(timespec="seconds"), "status": "ok"})
    assert sm.store.prune(preview=True)["metric_samples"] >= 1
    assert sm.store.one("SELECT COUNT(*) n FROM metric_samples")["n"] == 3  # type: ignore[index]
    sm.store.prune()
    left = [r["ts_utc"] for r in sm.store.q("SELECT ts_utc FROM metric_samples")]
    assert old not in left and len(left) >= 1


def test_config_is_validated_and_persisted(tmp_path: Path) -> None:
    st = MgmtStore(tmp_path)
    assert st.config()["disk_warn_pct"] == 80
    assert st.set_config({"disk_warn_pct": 70})["disk_warn_pct"] == 70
    assert MgmtStore(tmp_path).config()["disk_warn_pct"] == 70  # survives a restart
    for bad in ({"disk_warn_pct": 5}, {"nope": 1}, {"disk_warn_pct": True}, {"disk_warn_pct": 95}, {"manageable_services": ["sshd"]}, {"excluded_dirs": ["a/b"]}, {"sample_interval_s": "60"}):
        with pytest.raises(cfg.ConfigError):
            st.set_config(bad)
    assert st.config()["disk_warn_pct"] == 70  # a rejected change leaves everything as it was


# ------------------------------------------------------------------ alerts
def test_alerts_dedupe_escalate_and_resolve(tmp_path: Path) -> None:
    sm, _, _ = make(tmp_path)
    sm.store.add_sample({"ts_utc": sm.clock().isoformat(timespec="seconds"), "status": "ok", "disk_total": 1000, "disk_used": 850, "disk_avail": 150, "mem_total": 1000, "mem_avail": 500})
    sm.evaluate_alerts()
    sm.evaluate_alerts()
    disk = [a for a in sm.store.q("SELECT * FROM alerts WHERE key='disk'")]
    assert len(disk) == 1 and disk[0]["level"] == "critical" and disk[0]["count"] == 2  # free space is under the 2 GB floor
    sm.store.add_sample({"ts_utc": sm.clock().isoformat(timespec="seconds"), "status": "ok", "disk_total": 10**12, "disk_used": 10**11, "disk_avail": 9 * 10**11, "mem_total": 1000, "mem_avail": 900})
    sm.evaluate_alerts()
    assert sm.store.one("SELECT resolved_utc FROM alerts WHERE key='disk'")["resolved_utc"] is not None  # type: ignore[index]


def test_failed_collection_and_missing_sample_raise_alerts(tmp_path: Path) -> None:
    sm, _, _ = make(tmp_path)
    sm.evaluate_alerts()
    assert sm.store.one("SELECT 1 x FROM alerts WHERE key='collector' AND resolved_utc IS NULL") is not None  # no sample at all
    sm.store.add_sample({"ts_utc": (sm.clock() - timedelta(hours=2)).isoformat(timespec="seconds"), "status": "ok"})
    sm.evaluate_alerts()
    assert sm.store.one("SELECT 1 x FROM alerts WHERE key='stale' AND resolved_utc IS NULL") is not None


def test_missing_daily_snapshot_alert_after_its_time(tmp_path: Path) -> None:
    sm, clock, _ = make(tmp_path, "2026-11-01T16:00:00+00:00")  # 21:30 IST, snapshot time 18:45 plus an hour has passed
    sm.evaluate_alerts()
    assert sm.store.one("SELECT 1 x FROM alerts WHERE key='missing_daily' AND resolved_utc IS NULL") is not None
    sm.snapshot("daily")
    sm.evaluate_alerts()
    assert sm.store.one("SELECT 1 x FROM alerts WHERE key='missing_daily' AND resolved_utc IS NULL") is None
    del clock


def test_sample_never_raises_and_unavailable_stays_none(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.servermgmt.metrics.PROC", tmp_path / "no-proc")
    sm, _, _ = make(tmp_path)
    row = sm.sample()
    assert row["status"] == "partial" and row["load1"] is None and row["mem_total"] is None  # None, never 0
    assert row["disk_total"] is not None  # the filesystem part still works
    monkeypatch.setattr("app.servermgmt.metrics.collect", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    assert sm.sample()["status"] == "failed"


def test_metrics_parse_a_fake_proc(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "proc"
    (p / "net").mkdir(parents=True)
    (p / "stat").write_text("cpu  100 0 100 800 0 0 0 0 0 0\n")
    (p / "meminfo").write_text("MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 100 kB\nSwapFree: 60 kB\n")
    (p / "loadavg").write_text("0.50 0.40 0.30 1/100 5\n")
    monkeypatch.setattr("app.servermgmt.metrics.PROC", p)
    from app.servermgmt import metrics as mx

    cpu = mx.Cpu()
    assert cpu.percent() is None  # first read has nothing to compare with
    (p / "stat").write_text("cpu  200 0 200 900 0 0 0 0 0 0\n")  # +200 busy over +300 total
    assert cpu.percent() == pytest.approx(66.67, abs=0.01)
    assert mx.meminfo() == {"total": 1024000, "available": 409600, "free": -1, "buffers": -1, "cached": -1, "swap_total": 102400, "swap_used": 40960}
    assert mx.loadavg() == (0.5, 0.4, 0.3)


# ------------------------------------------------------------------ logs
def test_redaction_removes_secrets_and_tokens() -> None:
    red = ops.make_redactor(["s3cr3t-value"])
    assert "abc123" not in red('login password=abc123 ok') and "[redacted]" in red("password: abc123")
    assert "abcdefghijklmnop" not in red("Authorization: Bearer abcdefghijklmnop")
    assert "s3cr3t-value" not in red("value is s3cr3t-value here")
    assert "0123456789abcdef0123456789abcdef01234567" not in red("key 0123456789abcdef0123456789abcdef01234567")
    assert red("a normal line about NIFTY 24500") == "a normal line about NIFTY 24500"


def test_log_reader_filters_redacts_and_refuses_unknown_names(tmp_path: Path) -> None:
    lines = [json.dumps({"ts": f"2026-11-01T10:0{i}:00+00:00", "level": lvl, "logger": "x", "msg": m}) for i, (lvl, m) in enumerate([("INFO", "started"), ("WARNING", "slow password=hunter2"), ("ERROR", "failed thing"), ("INFO", "plain line")])]
    (tmp_path / "app.log").write_text("\n".join(lines) + "\nnot json at all\n")
    red = ops.make_redactor([])
    assert [s["name"] for s in ops.log_sources(tmp_path)] == ["app.log"]
    out = ops.read_log(tmp_path, "app.log", red, level="WARNING")
    assert [r["level"] for r in out["rows"]] == ["ERROR", "WARNING"]  # newest first
    assert "hunter2" not in json.dumps(out)
    assert [r["msg"] for r in ops.read_log(tmp_path, "app.log", red, q="PLAIN")["rows"]] == ["plain line"]
    assert ops.read_log(tmp_path, "app.log", red, limit=1)["rows"][0]["raw"] == "not json at all"
    for bad in ("../app.log", "app.log/../x", "other.log", "/etc/passwd"):
        with pytest.raises(KeyError):
            ops.read_log(tmp_path, bad, red)


def test_service_status_only_for_approved_names() -> None:
    with pytest.raises(KeyError):
        ops.service_status("sshd")
    with pytest.raises(KeyError):
        ops.service_status("nse-universe; rm -rf /")
    assert ops.service_status("nse-universe")["name"] == "nse-universe"  # unavailable on a dev host, but answered, not raised


def test_restart_needs_the_helper_and_an_approved_service(tmp_path: Path) -> None:
    with pytest.raises(KeyError):
        ops.queue_restart(tmp_path, "sshd", ["nse-universe"], "me")
    with pytest.raises(RuntimeError, match="helper"):
        ops.queue_restart(tmp_path, "nse-universe", ["nse-universe"], "me")
    (tmp_path / "helper-ready").write_text("x")
    req = ops.queue_restart(tmp_path, "nse-universe", ["nse-universe"], "me")
    assert json.loads((tmp_path / "restart-request.json").read_text())["id"] == req["id"]


def test_releases_reads_the_active_link_and_sizes(tmp_path: Path) -> None:
    (tmp_path / "releases" / "r1").mkdir(parents=True)
    (tmp_path / "releases" / "r2").mkdir()
    try:
        os.symlink(tmp_path / "releases" / "r2", tmp_path / "current")
    except (OSError, NotImplementedError):
        pytest.skip("no symlinks on this host")
    out = ops.releases(tmp_path, {"releases/r2": 5})
    assert out["active"] == "r2" and {r["id"]: r["active"] for r in out["releases"]} == {"r1": False, "r2": True}
    assert next(r for r in out["releases"] if r["id"] == "r2")["bytes"] == 5


# ------------------------------------------------------------------ API
@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    root = tmp_path / "nseroot"
    tree(root)
    monkeypatch.setenv("NSE_ROOT", str(root))
    with TestClient(make_app(tmp_path / "app"), client=LOOP) as c:
        yield c


def test_reads_work_and_are_not_cached(client: TestClient) -> None:
    r = client.get("/api/server/overview")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    body = r.json()
    assert body["timezone"] == "Asia/Kolkata" and {a["id"] for a in body["areas"]} == {"project", "data", "logs"}
    assert client.get("/api/server/storage/history").json()["note"] == "No storage snapshot has been recorded yet."
    assert client.get("/api/server/storage/forecast").json()["available"] is False


def test_changes_need_loopback_origin_and_the_action_header(client: TestClient, tmp_path: Path) -> None:
    body = {"values": {"disk_warn_pct": 75}}
    assert client.put("/api/server/config", json=body).status_code == 403  # header missing
    assert client.put("/api/server/config", json=body, headers={**HDR, "Origin": "http://evil.example"}).status_code == 403
    assert client.put("/api/server/config", json=body, headers=HDR).status_code == 200
    assert client.get("/api/server/config").json()["values"]["disk_warn_pct"] == 75
    assert client.put("/api/server/config", json={"values": {"disk_warn_pct": 1}}, headers=HDR).status_code == 422
    with TestClient(make_app(tmp_path / "other"), client=("10.1.2.3", 5000)) as remote:
        assert remote.put("/api/server/config", json=body, headers=HDR).status_code == 403  # not a loopback client
        assert remote.post("/api/server/maintenance/run", json={"op": "scan_storage"}, headers=HDR).status_code == 403


def test_maintenance_needs_confirmation_previews_and_audits(client: TestClient) -> None:
    run = lambda **b: client.post("/api/server/maintenance/run", json=b, headers=HDR)  # noqa: E731
    assert run(op="rm -rf /").status_code == 400
    assert run(op="retention_cleanup").status_code == 409  # destructive: confirmation required
    prev = run(op="retention_cleanup", dry_run=True)
    assert prev.status_code == 200 and prev.json()["mode"] == "preview"
    assert run(op="retention_cleanup", confirm=True).json()["status"] == "ok"
    scan_r = run(op="scan_storage").json()
    assert scan_r["status"] == "ok" and scan_r["result"]["status"] in ("complete", "partial")
    assert run(op="scan_storage").json()["status"] in ("ok", "refused")
    restart = run(op="restart_service", confirm=True, service="nse-universe")
    assert restart.status_code == 409  # the helper is not installed on a test host
    audit = client.get("/api/server/audit").json()
    ops_seen = [(a["op"], a["status"]) for a in audit["rows"]]
    assert ("retention_cleanup", "refused") in ops_seen and ("restart_service", "refused") in ops_seen and ("scan_storage", "ok") in ops_seen
    hist = client.get("/api/server/storage/history").json()
    assert hist["total"] >= 1 and hist["rows"][0]["status"] in ("complete", "partial")
    assert "Historical data collection began on" in hist["note"]
    assert client.get("/api/server/storage/history.csv").text.startswith("snapshot_date,")
    sid = hist["rows"][0]["id"]
    assert client.get(f"/api/server/storage/snapshot/{sid}").json()["snapshot"]["id"] == sid
    assert client.get("/api/server/storage/compare", params={"a": sid, "b": 99999}).status_code == 404


def test_explorer_and_logs_refuse_bad_requests(client: TestClient) -> None:
    assert client.get("/api/server/explorer").json()["areas"][0]["id"] == "project"
    ok = client.get("/api/server/explorer", params={"area": "project", "path": "a"}).json()
    assert {e["name"] for e in ok["entries"]} == {"b", "f1.bin"}
    for bad in ("..", "../..", "a/../..", "/etc"):
        assert client.get("/api/server/explorer", params={"area": "project", "path": bad}).status_code == 400
    assert client.get("/api/server/explorer", params={"area": "etc"}).status_code == 404
    assert client.get("/api/server/logs", params={"source": "../../etc/passwd"}).status_code == 404
    assert client.get("/api/server/processes", params={"sort": "evil"}).status_code == 422


def test_diagnostic_bundle_is_a_zip_without_secrets(client: TestClient) -> None:
    import io
    import zipfile

    r = client.get("/api/server/diagnostics/bundle")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert {"overview.json", "config.json", "storage-history.csv", "alerts.json", "audit.json"} <= set(names)
    assert client.get("/api/server/audit").json()["rows"][0]["op"] == "diagnostic_bundle"


def test_windows_junctions_are_treated_like_symlinks(tmp_path: Path) -> None:
    import subprocess
    import sys

    if sys.platform != "win32":
        pytest.skip("junctions exist only on Windows")
    root, outside = tmp_path / "r", tmp_path / "outside"
    tree(root)
    write(outside / "big.bin", 100_000)
    made = subprocess.run(["cmd", "/c", "mklink", "/J", str(root / "j"), str(outside)], capture_output=True, check=False)  # noqa: S603, S607
    if made.returncode != 0:
        pytest.skip("cannot create a junction here")
    assert scan(root).bytes < 1000  # the 100 kB file behind the junction is not counted
    with pytest.raises(sc.PathError):
        sc.resolve_inside(root, "j")
    with pytest.raises(sc.PathError):
        sc.resolve_inside(root, "j/big.bin")


def test_existing_data_cleanup_is_audited_and_followed_by_a_snapshot(client: TestClient) -> None:
    import time

    r = client.post("/api/storage/cleanup", json={"items": ["regenerable"], "confirm": True})
    assert r.status_code == 200, r.text
    audit = client.get("/api/server/audit").json()["rows"]
    assert audit[0]["op"] == "data_cleanup" and audit[0]["target"] == "regenerable"
    deadline = time.time() + 15
    kinds: list[str] = []
    while time.time() < deadline and "post_cleanup" not in kinds:
        time.sleep(0.3)
        sm = client.app.state.servermgmt
        kinds = [x["kind"] for x in sm.store.q("SELECT kind FROM storage_snapshots")]
    assert "post_cleanup" in kinds
