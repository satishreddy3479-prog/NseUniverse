"""The server watchdog (deploy/watchdog.sh) run against a stub of the app's API: every alert it can raise, and that a healthy night raises none."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "deploy" / "watchdog.sh"


def python_part() -> str:
    text = SCRIPT.read_text(encoding="utf-8")
    return text.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]


class Api:
    """A stub of the endpoints the watchdog reads; ``routes`` maps a path to a JSON body, or to None for a failure."""

    def __init__(self, routes: dict[str, Any]) -> None:
        outer = routes

        class H(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                body = outer.get(self.path)
                if isinstance(body, dict) and "__fail_first__" in body:  # a restart: the first calls get a 503, then the real body
                    body["__calls__"] = body.get("__calls__", 0) + 1
                    if body["__calls__"] <= body["__fail_first__"]:
                        self.send_response(503)
                        self.end_headers()
                        return
                    body = body["body"]
                if body is None:
                    self.send_response(500)
                    self.end_headers()
                    return
                data = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a: object) -> None:
                pass

        self.server = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()


def run(tmp: Path, routes: dict[str, Any], now: datetime, backups_age_h: float | None = 5, notify: str | None = None, retries: str = "3") -> tuple[list[dict[str, Any]], str]:
    api = Api(routes)
    try:
        state, back = tmp / "state", tmp / "backups"
        state.mkdir(exist_ok=True)
        back.mkdir(exist_ok=True)
        if backups_age_h is not None:
            day = back / "2026-11-12"
            day.mkdir(exist_ok=True)
            t = (now - timedelta(hours=backups_age_h)).timestamp()
            os.utime(day, (t, t))
        script = tmp / "w.py"
        script.write_text(python_part(), encoding="utf-8")
        env = {**os.environ, "NSE_NOW": now.isoformat(), "NSE_WATCHDOG_PAUSE_S": "0", "NSE_WATCHDOG_RETRIES": retries}
        out = subprocess.run([sys.executable, str(script), api.url, str(state), str(back), notify or str(tmp / "no-notify.env")], capture_output=True, text=True, env=env, timeout=60)
        assert out.returncode == 0, out.stderr
        return json.loads((state / "alerts.json").read_text())["alerts"], out.stdout
    finally:
        api.close()


def healthy(**over: Any) -> dict[str, Any]:
    r: dict[str, Any] = {
        "/api/health": {"status": "ok"},
        "/api/status": {"auth": {"state": "authenticated"}, "stream": {"state": "streaming", "freshness": "fresh", "market": {"state": "open"}}},
        "/api/stream/health": {"process": {"open_files": 70, "open_files_limit": 1024}},
        "/api/sampler/status": {"enabled": True, "in_session": True, "state": "sampling", "last_success_at": "2026-11-13T04:58:00Z", "last_attempt_at": "2026-11-13T04:58:00Z", "last_error": None},
        "/api/storage/status": {"disk": {"free_gb": 11.5}, "end_of_day": {"pending_days": []}},
        "/api/market/session": {"holiday_coverage": ["2026-01-01", "2027-12-31"]},
        "/api/prediction/history/status": {"enabled": True, "data_gaps": [], "last_run": {"summary": {"failed_symbols": []}}},
        "/api/prediction/flows/status": {"blocked": None, "missing_expected": [], "expected_session": "2026-11-12"},
    }
    r.update(over)
    return r


NOON = datetime(2026, 11, 13, 5, 0, tzinfo=UTC)  # 10:30 IST, a Friday, market open


def keys(alerts: list[dict[str, Any]]) -> set[str]:
    return {a["key"] for a in alerts}


def test_a_healthy_session_raises_nothing(tmp_path: Path) -> None:
    alerts, out = run(tmp_path, healthy(), NOON)
    assert alerts == [] and "all checks passed" in out


def test_open_files_close_to_the_limit_are_flagged(tmp_path: Path) -> None:
    """27 Nov 2026: connections left open used up the 1,024-file limit and the site stopped answering."""
    ok = {"process": {"open_files": 70, "open_files_limit": 1024}}
    assert run(tmp_path, healthy(**{"/api/stream/health": ok}), NOON)[0] == []
    warn = {"process": {"open_files": 700, "open_files_limit": 1024}}
    assert [(a["key"], a["level"]) for a in run(tmp_path, healthy(**{"/api/stream/health": warn}), NOON)[0]] == [("open-files", "warning")]
    crit = {"process": {"open_files": 950, "open_files_limit": 1024}}
    assert [(a["key"], a["level"]) for a in run(tmp_path, healthy(**{"/api/stream/health": crit}), NOON)[0]] == [("open-files", "critical")]
    none = {"process": {"open_files": None, "open_files_limit": None}}  # no /proc: nothing to judge
    assert run(tmp_path, healthy(**{"/api/stream/health": none}), NOON)[0] == []


def test_a_quiet_night_raises_nothing(tmp_path: Path) -> None:
    night = datetime(2026, 11, 12, 23, 50, tzinfo=UTC)  # 05:20 IST: market closed, sampler idle
    routes = healthy(**{
        "/api/status": {"auth": {"state": "authenticated"}, "stream": {"state": "streaming", "freshness": "market_closed", "market": {"state": "closed"}}},
        "/api/sampler/status": {"enabled": True, "in_session": False, "state": "waiting", "last_success_at": None, "last_attempt_at": None, "last_error": None},
    })
    assert run(tmp_path, routes, night)[0] == []


def test_a_backend_that_does_not_answer_is_critical(tmp_path: Path) -> None:
    alerts, _ = run(tmp_path, {"/api/health": None}, NOON)
    assert keys(alerts) == {"backend"} and alerts[0]["level"] == "critical"


def test_a_call_refused_during_a_restart_is_tried_again_before_it_counts(tmp_path: Path) -> None:
    # 20 Nov 2026 03:11 IST: the checks fell inside a deploy and three warnings stayed on every page for up to five minutes
    routes = healthy(**{"/api/market/session": {"__fail_first__": 2, "body": {"holiday_coverage": ["2026-01-01", "2027-12-31"]}}})
    assert run(tmp_path, routes, NOON)[0] == []  # two 503s, then the answer: nothing is raised
    for name, route, expect in (
        ("again", {"__fail_first__": 9, "body": {}}, {"holiday-status"}),  # still 503 after the three tries: raised
        ("plain", None, {"holiday-status"}),  # a plain 500 is a real error, not retried
    ):
        (tmp_path / name).mkdir()
        assert keys(run(tmp_path / name, healthy(**{"/api/market/session": route}), NOON)[0]) == expect


def test_a_backend_that_refuses_connections_is_critical_after_the_tries(tmp_path: Path) -> None:
    state, back = tmp_path / "state", tmp_path / "backups"
    state.mkdir()
    back.mkdir()
    script = tmp_path / "w.py"
    script.write_text(python_part(), encoding="utf-8")
    env = {**os.environ, "NSE_NOW": NOON.isoformat(), "NSE_WATCHDOG_PAUSE_S": "0", "NSE_WATCHDOG_RETRIES": "3"}
    out = subprocess.run([sys.executable, str(script), "http://127.0.0.1:9", str(state), str(back), str(tmp_path / "no.env")], capture_output=True, text=True, env=env, timeout=60)
    assert out.returncode == 0, out.stderr
    alerts = json.loads((state / "alerts.json").read_text())["alerts"]
    assert "backend" in keys(alerts) and alerts[0]["level"] == "critical"


def test_a_lost_broker_login_and_a_stale_feed_in_market_hours(tmp_path: Path) -> None:
    routes = healthy(**{"/api/status": {"auth": {"state": "failed", "last_error": "bad otp"}, "stream": {"state": "streaming", "freshness": "stale", "data_age_seconds": 240, "market": {"state": "open"}}}})
    alerts, _ = run(tmp_path, routes, NOON)
    assert {"broker-login", "live-feed"} <= keys(alerts)
    assert any("bad otp" in a["text"] for a in alerts)


def test_the_silent_pre_open_gap_is_not_a_dead_feed(tmp_path: Path) -> None:
    quiet = healthy(**{"/api/status": {"auth": {"state": "authenticated"}, "stream": {"state": "streaming", "freshness": "stale", "data_age_seconds": 263, "market": {"state": "open"}}}})
    gap = datetime(2026, 11, 13, 3, 42, 51, tzinfo=UTC)  # 09:12:51 IST, the exact moment of the false alarm
    assert "live-feed" not in keys(run(tmp_path, quiet, gap)[0])
    after = datetime(2026, 11, 13, 3, 48, tzinfo=UTC)  # 09:18 IST: trading has begun, silence now matters
    assert "live-feed" in keys(run(tmp_path, quiet, after)[0])


def test_a_sampler_that_has_stopped_storing_is_critical_only_after_09_25(tmp_path: Path) -> None:
    stale = healthy(**{"/api/sampler/status": {"enabled": True, "in_session": True, "state": "sampling", "last_success_at": "2026-11-13T04:40:00Z", "last_attempt_at": "2026-11-13T04:59:00Z", "last_error": None}})
    assert "sampler" in keys(run(tmp_path, stale, NOON)[0])  # 20 minutes without a stored sample at 10:30 IST
    early = datetime(2026, 11, 13, 3, 47, tzinfo=UTC)  # 09:17 IST: the first sample is not yet due
    none_yet = healthy(**{"/api/sampler/status": {"enabled": True, "in_session": True, "state": "sampling", "last_success_at": None, "last_attempt_at": None, "last_error": None}})
    assert "sampler" not in keys(run(tmp_path, none_yet, early)[0])


def test_disk_levels(tmp_path: Path) -> None:
    low = run(tmp_path, healthy(**{"/api/storage/status": {"disk": {"free_gb": 2.2}, "end_of_day": {"pending_days": []}}}), NOON)[0]
    assert [a["level"] for a in low if a["key"] == "disk"] == ["warning"]
    crit = run(tmp_path, healthy(**{"/api/storage/status": {"disk": {"free_gb": 1.1}, "end_of_day": {"pending_days": []}}}), NOON)[0]
    assert [a["level"] for a in crit if a["key"] == "disk"] == ["critical"]


def test_a_missing_or_old_backup(tmp_path: Path) -> None:
    assert "backup" in keys(run(tmp_path, healthy(), NOON, backups_age_h=40)[0])
    empty = tmp_path / "e"
    empty.mkdir()
    assert [a["level"] for a in run(empty, healthy(), NOON, backups_age_h=None)[0] if a["key"] == "backup"] == ["critical"]


def test_notifications_go_out_once_when_an_alert_appears_and_once_when_it_clears(tmp_path: Path) -> None:
    hook = Api({})  # accepts GET only, so the POST fails: the alert must still be recorded and announced only once
    try:
        env = tmp_path / "notify.env"
        env.write_text(f"NOTIFY_URL={hook.url}/topic\n", encoding="utf-8")
        _, out1 = run(tmp_path, {"/api/health": None}, NOON, notify=str(env))
        assert "notif" in out1
        alerts, out2 = run(tmp_path, {"/api/health": None}, NOON, notify=str(env))
        assert keys(alerts) == {"backend"} and "notif" not in out2  # the same alert is not announced again
        _, out3 = run(tmp_path, healthy(), NOON, notify=str(env))
        assert "notif" in out3  # the all-clear is announced
    finally:
        hook.close()


@pytest.mark.skipif(os.name == "nt", reason="bash syntax check needs a POSIX shell")
def test_the_shell_wrapper_parses() -> None:
    assert subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True).returncode == 0



def coverage(end: str) -> dict[str, Any]:
    return {"/api/market/session": {"holiday_coverage": ["2026-01-01", end]}}


def test_the_holiday_list_running_out_is_flagged_early_and_then_loudly(tmp_path: Path) -> None:
    a = run(tmp_path, healthy(**coverage("2026-12-31")), NOON)[0]  # 48 days left on 13 Nov 2026
    assert [x["level"] for x in a if x["key"] == "holiday-list"] == ["warning"]
    assert "holiday" in a[0]["text"].lower() and "2026-12-31" in a[0]["text"]
    late = datetime(2026, 12, 25, 5, 0, tzinfo=UTC)
    assert [x["level"] for x in run(tmp_path, healthy(**coverage("2026-12-31")), late)[0] if x["key"] == "holiday-list"] == ["critical"]
    assert "holiday-list" not in keys(run(tmp_path, healthy(**coverage("2027-12-31")), NOON)[0])


def test_history_and_flow_problems_are_flagged_only_when_the_data_is_due(tmp_path: Path) -> None:
    evening = datetime(2026, 11, 13, 14, 30, tzinfo=UTC)  # 20:00 IST, Friday
    gap = healthy(**{"/api/prediction/history/status": {"enabled": True, "data_gaps": ["NIFTY50 2026-11-13"], "last_run": {"summary": {"failed_symbols": ["INDIAVIX"]}}}})
    got = keys(run(tmp_path, gap, evening)[0])
    assert {"history", "history-source"} <= got
    assert "history" not in keys(run(tmp_path, gap, NOON)[0])  # 10:30 IST: today's bar is not due yet
    flows = healthy(**{"/api/prediction/flows/status": {"blocked": None, "missing_expected": ["fii_dii"], "expected_session": "2026-11-13"}})
    assert "flows" not in keys(run(tmp_path, flows, evening)[0])  # NSE publishes around 18:00; waited until 21:00 IST
    late_night = datetime(2026, 11, 13, 16, 0, tzinfo=UTC)  # 21:30 IST
    assert "flows" in keys(run(tmp_path, flows, late_night)[0])
    blocked = healthy(**{"/api/prediction/flows/status": {"blocked": "HTTP 403", "missing_expected": [], "expected_session": "2026-11-13"}})
    assert "flows-blocked" in keys(run(tmp_path, blocked, NOON)[0])


def test_a_pending_reboot_is_flagged_after_a_week(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    flag = tmp_path / "reboot-required"
    flag.write_text("*** System restart required ***", encoding="utf-8")
    monkeypatch.setenv("NSE_REBOOT_FILE", str(flag))
    fresh = (NOON - timedelta(days=2)).timestamp()
    os.utime(flag, (fresh, fresh))
    assert "reboot" not in keys(run(tmp_path, healthy(), NOON)[0])
    old = (NOON - timedelta(days=9)).timestamp()
    os.utime(flag, (old, old))
    got = [a for a in run(tmp_path, healthy(), NOON)[0] if a["key"] == "reboot"]
    assert len(got) == 1 and "9 days" in got[0]["text"]


def test_the_weekly_restore_check_is_judged_by_its_result(tmp_path: Path) -> None:
    """The restore check leaves state/restore-check.json: a failed one is critical, one older than nine days is a warning, none yet is no alert."""
    base = tmp_path / "a"
    base.mkdir()
    assert "restore" not in keys(run(base, healthy(), NOON)[0])  # never run: nothing to judge yet

    def with_result(sub: str, body: dict[str, Any]) -> list[dict[str, Any]]:
        d = tmp_path / sub
        d.mkdir()
        (d / "state").mkdir()
        (d / "state" / "restore-check.json").write_text(json.dumps(body), encoding="utf-8")
        return run(d, healthy(), NOON)[0]

    good = {"at": (NOON - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ"), "day": "2026-11-11", "ok": True, "databases": 19}
    assert "restore" not in keys(with_result("ok", good))
    bad = with_result("bad", {**good, "ok": False})
    assert [a["level"] for a in bad if a["key"] == "restore"] == ["critical"]
    old = with_result("old", {**good, "at": (NOON - timedelta(days=10)).strftime("%Y-%m-%dT%H:%M:%SZ")})
    assert [a["level"] for a in old if a["key"] == "restore"] == ["warning"] and "10 days ago" in next(a["text"] for a in old if a["key"] == "restore")


def test_the_restore_check_writes_its_result_and_exits_nonzero_on_a_damaged_backup(tmp_path: Path) -> None:
    import gzip
    import shutil
    import sqlite3

    bash = shutil.which("bash")
    if bash is None or shutil.which("sqlite3") is None:
        pytest.skip("needs bash and the sqlite3 command")
    backups, state = tmp_path / "b", tmp_path / "state"
    day = backups / "2026-11-25"
    day.mkdir(parents=True)
    state.mkdir()
    db = tmp_path / "x.sqlite3"
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE t (a)")
    c.execute("INSERT INTO t VALUES (1)")
    c.commit()
    c.close()
    (day / "x.sqlite3.gz").write_bytes(gzip.compress(db.read_bytes()))
    script = Path(__file__).resolve().parents[3] / "deploy" / "restore-check.sh"
    env = {**os.environ, "NSE_BACKUP_DIR": str(backups), "NSE_STATE_DIR": str(state)}
    ok = subprocess.run([bash, str(script)], capture_output=True, text=True, env=env)
    assert ok.returncode == 0, ok.stdout + ok.stderr
    res = json.loads((state / "restore-check.json").read_text())
    assert res["ok"] is True and res["day"] == "2026-11-25" and res["databases"] == 1
    (day / "y.sqlite3.gz").write_bytes(b"not gzip at all")  # a damaged file
    bad = subprocess.run([bash, str(script)], capture_output=True, text=True, env=env)
    assert bad.returncode == 1 and json.loads((state / "restore-check.json").read_text())["ok"] is False
