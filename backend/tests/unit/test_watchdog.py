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


def run(tmp: Path, routes: dict[str, Any], now: datetime, backups_age_h: float | None = 5, notify: str | None = None) -> tuple[list[dict[str, Any]], str]:
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
        env = {**os.environ, "NSE_NOW": now.isoformat()}
        out = subprocess.run([sys.executable, str(script), api.url, str(state), str(back), notify or str(tmp / "no-notify.env")], capture_output=True, text=True, env=env, timeout=60)
        assert out.returncode == 0, out.stderr
        return json.loads((state / "alerts.json").read_text())["alerts"], out.stdout
    finally:
        api.close()


def healthy(**over: Any) -> dict[str, Any]:
    r: dict[str, Any] = {
        "/api/health": {"status": "ok"},
        "/api/status": {"auth": {"state": "authenticated"}, "stream": {"state": "streaming", "freshness": "fresh", "market": {"state": "open"}}},
        "/api/sampler/status": {"enabled": True, "in_session": True, "state": "sampling", "last_success_at": "2026-11-13T04:58:00Z", "last_attempt_at": "2026-11-13T04:58:00Z", "last_error": None},
        "/api/storage/status": {"disk": {"free_gb": 11.5}, "end_of_day": {"pending_days": []}},
    }
    r.update(over)
    return r


NOON = datetime(2026, 11, 13, 5, 0, tzinfo=UTC)  # 10:30 IST, a Friday, market open


def keys(alerts: list[dict[str, Any]]) -> set[str]:
    return {a["key"] for a in alerts}


def test_a_healthy_session_raises_nothing(tmp_path: Path) -> None:
    alerts, out = run(tmp_path, healthy(), NOON)
    assert alerts == [] and "all checks passed" in out


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


def test_a_lost_broker_login_and_a_stale_feed_in_market_hours(tmp_path: Path) -> None:
    routes = healthy(**{"/api/status": {"auth": {"state": "failed", "last_error": "bad otp"}, "stream": {"state": "streaming", "freshness": "stale", "data_age_seconds": 240, "market": {"state": "open"}}}})
    alerts, _ = run(tmp_path, routes, NOON)
    assert {"broker-login", "live-feed"} <= keys(alerts)
    assert any("bad otp" in a["text"] for a in alerts)


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
