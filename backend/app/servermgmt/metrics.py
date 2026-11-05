"""Live system measurements from /proc and the filesystem, with the standard library only (no new dependency).

Every value is ``None`` when it cannot be read (a non-Linux development machine, a restricted /proc): never zero.
CPU use is the change in /proc/stat between two reads, so ``Cpu`` keeps the previous read.
"""

from __future__ import annotations

import os
import platform
import shutil
import threading
import time
from pathlib import Path
from typing import Any

PROC = Path(os.environ.get("NSE_PROC_ROOT", "/proc"))  # overridable for tests
TICKS = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
PAGE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096


def _read(p: Path) -> str | None:
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


class Cpu:
    """CPU use between consecutive calls; the first call has no previous read and returns None."""

    def __init__(self) -> None:
        self._prev: tuple[int, int] | None = None
        self._lock = threading.Lock()

    @staticmethod
    def _times() -> tuple[int, int] | None:
        txt = _read(PROC / "stat")
        if not txt or not txt.startswith("cpu "):
            return None
        f = [int(x) for x in txt.splitlines()[0].split()[1:]]
        idle = f[3] + (f[4] if len(f) > 4 else 0)
        return sum(f[:8]), idle

    def percent(self) -> float | None:
        now = self._times()
        with self._lock:
            prev, self._prev = self._prev, now
        if now is None or prev is None or now[0] <= prev[0]:
            return None
        busy = (now[0] - prev[0]) - (now[1] - prev[1])
        return round(100.0 * busy / (now[0] - prev[0]), 2)


def loadavg() -> tuple[float, float, float] | None:
    txt = _read(PROC / "loadavg")
    if not txt:
        return None
    a = txt.split()
    return float(a[0]), float(a[1]), float(a[2])


def meminfo() -> dict[str, int] | None:
    txt = _read(PROC / "meminfo")
    if not txt:
        return None
    kv = {}
    for line in txt.splitlines():
        k, _, v = line.partition(":")
        parts = v.split()
        if parts:
            kv[k] = int(parts[0]) * 1024
    if "MemTotal" not in kv:
        return None
    avail = kv.get("MemAvailable")
    return {
        "total": kv["MemTotal"], "available": avail if avail is not None else -1, "free": kv.get("MemFree", -1),
        "buffers": kv.get("Buffers", -1), "cached": kv.get("Cached", -1),
        "swap_total": kv.get("SwapTotal", 0), "swap_used": kv.get("SwapTotal", 0) - kv.get("SwapFree", 0),
    }


def uptime_s() -> float | None:
    txt = _read(PROC / "uptime")
    return float(txt.split()[0]) if txt else None


def cpu_info() -> dict[str, Any]:
    txt = _read(PROC / "cpuinfo") or ""
    models = [ln.split(":", 1)[1].strip() for ln in txt.splitlines() if ln.lower().startswith("model name")]
    return {"model": models[0] if models else None, "logical_cores": os.cpu_count()}


def net_totals() -> tuple[int, int] | None:
    txt = _read(PROC / "net" / "dev")
    if not txt:
        return None
    rx = tx = 0
    for line in txt.splitlines()[2:]:
        name, _, rest = line.partition(":")
        if name.strip() == "lo":
            continue
        f = rest.split()
        if len(f) >= 9:
            rx += int(f[0])
            tx += int(f[8])
    return rx, tx


def io_totals() -> tuple[int, int] | None:
    """Bytes read and written on whole disks (partitions are skipped so nothing is counted twice)."""
    txt = _read(PROC / "diskstats")
    if not txt:
        return None
    rd = wr = 0
    for line in txt.splitlines():
        f = line.split()
        if len(f) < 10:
            continue
        name = f[2]
        if name.startswith(("loop", "ram", "dm-")) or (name[-1].isdigit() and not name.startswith("nvme")) or (name.startswith("nvme") and "p" in name[4:]):
            continue
        rd += int(f[5]) * 512
        wr += int(f[9]) * 512
    return rd, wr


def disk_usage(path: Path) -> dict[str, int] | None:
    try:
        u = shutil.disk_usage(path)
    except OSError:
        return None
    return {"total": u.total, "used": u.used, "free": u.free}


def hostname_safe() -> str:
    return platform.node() or "unknown"


def os_info() -> dict[str, str | None]:
    rel = _read(Path("/etc/os-release")) or ""
    pretty = next((ln.split("=", 1)[1].strip().strip('"') for ln in rel.splitlines() if ln.startswith("PRETTY_NAME=")), None)
    return {"os": pretty or platform.platform(), "kernel": platform.release()}


def processes(limit: int = 200) -> list[dict[str, Any]] | None:
    """Name, owner, state, CPU time, resident memory and start for each process. The command line and the environment
    are never read (they can hold credentials)."""
    if not PROC.exists():
        return None
    mem = meminfo()
    up = uptime_s()
    out: list[dict[str, Any]] = []
    for d in PROC.iterdir():
        if not d.name.isdigit():
            continue
        txt = _read(d / "stat")
        if not txt:
            continue
        try:
            rp = txt.rindex(")")
            name = txt[txt.index("(") + 1 : rp]
            f = txt[rp + 2 :].split()
            state, utime, stime, start = f[0], int(f[11]), int(f[12]), int(f[19])
            rss = int(f[21]) * PAGE
            uid = d.stat().st_uid
        except (ValueError, IndexError, OSError):
            continue
        cpu_s = (utime + stime) / TICKS
        runtime = None if up is None else max(0.0, up - start / TICKS)
        out.append({
            "pid": int(d.name), "name": name[:60], "uid": uid, "state": state, "rss": rss, "cpu_seconds": round(cpu_s, 2), "runtime_s": None if runtime is None else round(runtime),
            "cpu_pct_lifetime": None if not runtime else round(100.0 * cpu_s / runtime, 2),
            "mem_pct": None if not mem else round(100.0 * rss / mem["total"], 2),
        })
    out.sort(key=lambda p: p["rss"], reverse=True)
    return out[:limit]


def own_rss() -> int | None:
    txt = _read(PROC / "self" / "statm")
    return int(txt.split()[1]) * PAGE if txt else None


def collect(cpu: Cpu, disk_path: Path) -> dict[str, Any]:
    """One metric sample. ``status`` is ok when everything readable was read, partial when something was unavailable."""
    t0 = time.perf_counter()
    la, mem, net, io, du = loadavg(), meminfo(), net_totals(), io_totals(), disk_usage(disk_path)
    row: dict[str, Any] = {
        "cpu_pct": cpu.percent(), "load1": la[0] if la else None, "load5": la[1] if la else None, "load15": la[2] if la else None,
        "mem_total": mem["total"] if mem else None, "mem_avail": mem["available"] if mem and mem["available"] >= 0 else None,
        "swap_total": mem["swap_total"] if mem else None, "swap_used": mem["swap_used"] if mem else None,
        "disk_total": du["total"] if du else None, "disk_used": du["used"] if du else None, "disk_avail": du["free"] if du else None,
        "net_rx": net[0] if net else None, "net_tx": net[1] if net else None, "io_read": io[0] if io else None, "io_write": io[1] if io else None,
        "app_rss": own_rss(),
    }
    missing = [k for k, v in row.items() if v is None and k != "cpu_pct"]
    row["status"] = "ok" if not missing else "partial"
    row["error"] = None if not missing else "unavailable: " + ", ".join(missing)
    row["collect_ms"] = round((time.perf_counter() - t0) * 1000, 2)
    return row
