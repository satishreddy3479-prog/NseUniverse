"""Logs, service status, releases and the narrow restart helper hand-off.

Nothing here runs a command taken from a request. ``systemctl`` is called with fixed arguments and only for names in
``config.STATUS_ONLY_SERVICES``; a restart is never executed by the web process: it writes a small request file that a
separate root-owned helper (deploy/mgmt-helper.sh) validates against its own fixed list.
"""

from __future__ import annotations

import json
import os
import re
import subprocess  # noqa: S404 - fixed argument lists only, see ``service_status``
import urllib.request
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.servermgmt import config as cfg

READ_TAIL = 2_000_000  # bytes read from the end of a log per request
LEVELS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}

_REDACT = [
    re.compile(r"(?i)((?:pass(?:word|wd)?|secret|token|api[_-]?key|authorization|mpin|totp|consumer[_-]?(?:key|secret)|cookie)[\"']?\s*[:=]\s*[\"']?)[^\s,\"'}&]+"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"\b[A-Fa-f0-9]{40,}\b"),
    re.compile(r"\b[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
]


def make_redactor(secrets: list[str]) -> Callable[[str], str]:
    exact = [s for s in secrets if s and len(s) >= 4]

    def redact(text: str) -> str:
        for s in exact:
            text = text.replace(s, "[redacted]")
        text = _REDACT[1].sub(r"\1[redacted]", text)  # a bearer token first, so "Authorization: Bearer x" hides x
        text = _REDACT[0].sub(r"\1[redacted]", text)
        for rx in _REDACT[2:]:
            text = rx.sub("[redacted]", text)
        return text

    return redact


# ---------------------------------------------------------------------------- logs
def log_sources(log_dir: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not log_dir.is_dir():
        return out
    for p in sorted(log_dir.iterdir()):
        if p.is_file() and not p.is_symlink() and re.fullmatch(r"[\w.-]+\.log(\.\d+)?", p.name):
            st = p.stat()
            out.append({"name": p.name, "bytes": st.st_size, "mtime_utc": datetime.fromtimestamp(st.st_mtime, UTC).isoformat(timespec="seconds"), "rotated": not p.name.endswith(".log")})
    return out


def read_log(log_dir: Path, name: str, redact: Callable[[str], str], *, q: str = "", level: str = "", since: str = "", until: str = "", limit: int = 200, before: int | None = None) -> dict[str, Any]:
    """The newest matching lines first. Only a name from ``log_sources`` is accepted; ``q`` is a plain substring."""
    if name not in {s["name"] for s in log_sources(log_dir)}:
        raise KeyError("unknown log source")
    p = log_dir / name
    size = p.stat().st_size
    end = size if before is None else max(0, min(before, size))
    start = max(0, end - READ_TAIL)
    with p.open("rb") as f:
        f.seek(start)
        raw = f.read(end - start)
    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()
    if start > 0 and lines:
        lines = lines[1:]  # the first line is cut off by the window
    minimum = LEVELS.get(level.upper(), 0)
    ql = q.lower()
    out: list[dict[str, Any]] = []
    for line in reversed(lines):
        if not line.strip():
            continue
        row: dict[str, Any] = {"raw": None, "ts": None, "level": None, "logger": None, "msg": None}
        try:
            j = json.loads(line)
            if isinstance(j, dict):
                row.update(ts=j.get("ts"), level=str(j.get("level") or "").upper() or None, logger=j.get("logger"), msg=j.get("msg"))
                extra = {k: v for k, v in j.items() if k not in ("ts", "level", "logger", "msg")}
                row["raw"] = line if not extra else f"{j.get('msg')} {json.dumps(extra, default=str)}"
        except ValueError:
            row["raw"] = line
        if row["raw"] is None:
            row["raw"] = line
        if minimum and LEVELS.get(row["level"] or "", 0) < minimum:
            continue
        if since and row["ts"] and str(row["ts"]) < since:
            continue
        if until and row["ts"] and str(row["ts"]) > until:
            continue
        shown = redact(str(row["raw"]))[:1500]
        if ql and ql not in shown.lower():
            continue
        row["raw"] = shown
        row["msg"] = redact(str(row["msg"]))[:600] if row["msg"] is not None else None
        out.append(row)
        if len(out) >= limit:
            break
    return {"source": name, "rows": out, "file_bytes": size, "window_start": start, "next_before": start if start > 0 else None, "truncated_window": start > 0}


# ---------------------------------------------------------------------------- services
def service_status(name: str) -> dict[str, Any]:
    if name not in cfg.STATUS_ONLY_SERVICES:
        raise KeyError("service not in the approved list")
    try:
        r = subprocess.run(  # noqa: S603 - fixed argv, name checked against an allowlist above
            ["systemctl", "show", name, "--no-pager", "-p", "ActiveState,SubState,MainPID,ActiveEnterTimestamp,NRestarts,MemoryCurrent,Result"],  # noqa: S607
            capture_output=True, text=True, timeout=5, check=False,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return {"name": name, "available": False, "reason": f"systemctl unavailable: {type(e).__name__}"}
    if r.returncode != 0:
        return {"name": name, "available": False, "reason": (r.stderr or "systemctl failed").strip()[:200]}
    kv = dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)
    mem = kv.get("MemoryCurrent", "")
    return {
        "name": name, "available": True, "active": kv.get("ActiveState"), "sub": kv.get("SubState"), "pid": int(kv["MainPID"]) if kv.get("MainPID", "0") not in ("", "0") else None,
        "since": kv.get("ActiveEnterTimestamp") or None, "restarts": int(kv["NRestarts"]) if kv.get("NRestarts", "").isdigit() else None,
        "memory_bytes": int(mem) if mem.isdigit() else None, "result": kv.get("Result"),
    }


def health_check(port: int) -> dict[str, Any]:
    """The application's own health endpoint on loopback; the time taken is part of the answer."""
    url = f"http://127.0.0.1:{port}/api/health"
    t0 = datetime.now(UTC)
    try:
        with urllib.request.urlopen(url, timeout=4) as resp:  # noqa: S310 - fixed loopback URL
            ok = resp.status == 200
            body = json.loads(resp.read(20000).decode("utf-8", errors="replace"))
        return {"ok": ok, "status": "ok" if ok else "unhealthy", "ms": round((datetime.now(UTC) - t0).total_seconds() * 1000), "detail": body if isinstance(body, dict) else None, "checked_utc": t0.isoformat(timespec="seconds")}
    except Exception as e:
        return {"ok": False, "status": "unreachable", "ms": None, "detail": None, "error": type(e).__name__, "checked_utc": t0.isoformat(timespec="seconds")}


# ---------------------------------------------------------------------------- restart hand-off
HELPER_READY_MAX_AGE_S = 3 * 24 * 3600


def helper_state(mgmt_dir: Path) -> dict[str, Any]:
    ready = mgmt_dir / "helper-ready"
    if not ready.exists():
        return {"installed": False, "reason": "the privileged helper has not run on this server (see the one-time setup in docs/server-management.md)"}
    age = datetime.now(UTC).timestamp() - ready.stat().st_mtime
    return {"installed": True, "last_run_age_s": round(age), "stale": age > HELPER_READY_MAX_AGE_S}


def queue_restart(mgmt_dir: Path, service: str, allowed: list[str], actor: str) -> dict[str, Any]:
    if service not in allowed or service not in cfg.SERVICE_ALL:
        raise KeyError("service not approved for restart")
    st = helper_state(mgmt_dir)
    if not st["installed"]:
        raise RuntimeError(st["reason"])
    mgmt_dir.mkdir(parents=True, exist_ok=True)
    rid = uuid.uuid4().hex[:12]
    req = {"id": rid, "service": service, "actor": actor[:60], "ts": datetime.now(UTC).isoformat(timespec="seconds")}
    tmp = mgmt_dir / "restart-request.json.tmp"
    tmp.write_text(json.dumps(req), encoding="utf-8")
    os.replace(tmp, mgmt_dir / "restart-request.json")  # the helper's path unit watches this exact file
    return req


def restart_result(mgmt_dir: Path) -> dict[str, Any] | None:
    p = mgmt_dir / "restart-result.json"
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


# ---------------------------------------------------------------------------- releases
def releases(project_root: Path, sizes: dict[str, int]) -> dict[str, Any]:
    rel_dir = project_root / "releases"
    cur = project_root / "current"
    active = None
    try:
        if cur.is_symlink():
            active = Path(os.readlink(cur)).name
    except OSError:
        active = None
    items = []
    if rel_dir.is_dir():
        for p in sorted(rel_dir.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
            if p.is_dir() and not p.is_symlink():
                items.append({"id": p.name, "created_utc": datetime.fromtimestamp(p.stat().st_mtime, UTC).isoformat(timespec="seconds"), "active": p.name == active, "bytes": sizes.get(f"releases/{p.name}")})
    return {"available": rel_dir.is_dir(), "active": active, "releases": items, "rollback": "not offered from the website: switching the release link needs a privileged step and a restart; follow the manual procedure in docs/server-management.md"}
