"""Collection, growth maths, forecasts and alerts of the Server Management Centre.

* ``sample`` records one system-metric row (cheap: a few /proc reads). A browser refresh never calls it.
* ``snapshot`` runs the bounded storage scan, one at a time (a second request while one runs is refused, not queued),
  and writes one row per IST date for the scheduled daily snapshot (a retry the same day is a no-op).
* Daily change is only computed between two complete snapshots of consecutive IST dates taken with the same method;
  otherwise it is ``None`` ("unavailable"), never zero.
* Forecasts use only complete daily snapshots and say why they are withheld when the data is too thin or erratic.
"""

from __future__ import annotations

import asyncio
import csv
import io
import logging
import statistics
import threading
import time
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from app.servermgmt import metrics as mx
from app.servermgmt import scan as sc
from app.servermgmt.store import MgmtStore, now_iso

log = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")
MB = 1_000_000


def ist_date(ts_utc: str) -> str:
    return datetime.fromisoformat(ts_utc).astimezone(IST).date().isoformat()


class ServerMgmt:
    def __init__(
        self, store: MgmtStore, areas: list[sc.Area], *, disk_path: Path, clock: Callable[[], datetime] | None = None, split: tuple[str, ...] = ("releases",)
    ) -> None:
        self.store = store
        self.areas = areas
        self.disk_path = disk_path
        self.clock = clock or (lambda: datetime.now(UTC))
        self.split = split
        self.cpu = mx.Cpu()
        self._scan_lock = threading.Lock()
        self._task: asyncio.Task[None] | None = None
        self._last_sample = 0.0
        self.running_scan: str | None = None

    def _skip(self, area: sc.Area) -> frozenset[str]:
        import os

        me = area.root.resolve()
        return frozenset(os.path.normcase(os.path.abspath(a.root.resolve())) for a in self.areas if a is not area and me in a.root.resolve().parents)

    # ------------------------------------------------------------------ metrics
    def sample(self) -> dict[str, Any]:
        try:
            row = mx.collect(self.cpu, self.disk_path)
        except Exception as e:  # a collector failure is recorded, never raised into the app
            log.warning("metrics collection failed: %s", type(e).__name__)
            row = {"status": "failed", "error": f"{type(e).__name__}: {str(e)[:200]}"}
        row["ts_utc"] = self.clock().isoformat(timespec="seconds")
        row["id"] = self.store.add_sample(row)
        self.evaluate_alerts()
        return row

    # ------------------------------------------------------------------ storage snapshots
    def snapshot(self, kind: str = "daily") -> dict[str, Any]:
        """Scan every approved area and store the result. Returns the stored row, or ``{"skipped": reason}``."""
        if kind not in ("daily", "manual", "post_cleanup", "post_deploy"):
            raise ValueError("unknown snapshot kind")
        now = self.clock()
        date_key = now.astimezone(IST).date().isoformat()
        if kind == "daily" and self.store.one("SELECT id FROM storage_snapshots WHERE snapshot_date=? AND kind='daily'", (date_key,)):
            return {"skipped": f"the daily snapshot for {date_key} already exists"}
        if not self._scan_lock.acquire(blocking=False):
            return {"skipped": f"a storage scan is already running ({self.running_scan})"}
        self.running_scan = kind
        rid = self.store.run_start(f"snapshot:{kind}")
        c = self.store.config()
        t0 = time.monotonic()
        try:
            dirs: list[dict[str, Any]] = []
            files: list[dict[str, Any]] = []
            complete, errors, nfiles, ndirs, nse_bytes, nse_alloc = True, [], 0, 0, 0, 0
            budget = float(c["scan_timeout_s"])
            scanned = 0
            for area in self.areas:
                left = max(5.0, budget - (time.monotonic() - t0))
                r = sc.scan_area(area, timeout_s=left, top_n=int(c["inventory_max_files"]), excluded_dirs=c["excluded_dirs"], excluded_patterns=c["excluded_patterns"], split=self.split, skip=self._skip(area))
                if not area.root.is_dir():
                    errors.append(f"{area.id}: {area.root} not found")
                    continue
                scanned += 1
                complete = complete and r.complete and not r.errors
                errors += [f"{area.id}: {e}" for e in r.errors[:5]]
                if not r.complete:
                    errors.append(f"{area.id}: stopped at the time limit")
                nfiles += r.files
                ndirs += r.dirs
                nse_bytes += r.bytes
                nse_alloc += r.alloc
                dirs.append({"area": area.id, "name": "", "bytes": r.bytes, "alloc": r.alloc, "files": r.files})
                dirs += [{"area": area.id, "name": k, "bytes": v[0], "alloc": v[1], "files": v[2]} for k, v in r.by_top.items()]
                files += sc.inventory_rows(area.id, r)
            du = mx.disk_usage(self.disk_path)
            status: str
            err: str | None
            if scanned == 0:
                status, err = "failed", "no approved area could be scanned: " + "; ".join(errors)[:400]
            else:
                status, err = ("complete" if complete else "partial"), ("; ".join(errors)[:600] or None)
            snap = {
                "snapshot_date": date_key, "kind": kind, "ts_utc": now.isoformat(timespec="seconds"), "status": status, "method": sc.METHOD, "error": err,
                "fs_total": du["total"] if du else None, "fs_used": du["used"] if du else None, "fs_avail": du["free"] if du else None,
                "nse_bytes": nse_bytes if scanned else None, "nse_alloc": nse_alloc if scanned else None, "files": nfiles if scanned else None,
                "dirs": ndirs if scanned else None, "duration_s": round(time.monotonic() - t0, 2), "own_db_bytes": self.store.size_bytes(),
            }
            sid = self.store.add_snapshot(snap, dirs if scanned else [], files if scanned else [])
            self.store.run_end(rid, status, err)
            if sid is None:
                return {"skipped": f"the daily snapshot for {date_key} already exists"}
            if kind == "daily":
                self.store.prune()
            self.evaluate_alerts()
            return {**snap, "id": sid}
        except Exception as e:
            self.store.run_end(rid, "failed", f"{type(e).__name__}: {str(e)[:300]}")
            log.exception("storage snapshot failed")
            return {"skipped": f"failed: {type(e).__name__}"}
        finally:
            self.running_scan = None
            self._scan_lock.release()

    # ------------------------------------------------------------------ history and growth
    @staticmethod
    def _comparable(a: dict[str, Any], b: dict[str, Any]) -> bool:
        return bool(a["status"] == "complete" and b["status"] == "complete" and a["method"] == b["method"])

    def history(self) -> list[dict[str, Any]]:
        """Daily rows, oldest first, each with its change against the previous calendar day (None when not comparable)."""
        rows = self.store.daily()
        by_date = {r["snapshot_date"]: r for r in rows}
        out = []
        for r in rows:
            prev = by_date.get((date.fromisoformat(r["snapshot_date"]) - timedelta(days=1)).isoformat())
            ok = prev is not None and self._comparable(prev, r)
            d = {**r, "prev_date": prev["snapshot_date"] if prev else None}
            for k in ("fs_used", "nse_bytes", "files"):
                d[f"d_{k}"] = (r[k] - prev[k]) if ok and prev is not None and r[k] is not None and prev[k] is not None else None
            d["comparable"] = ok
            d["parts"] = self._parts(r["id"])
            out.append(d)
        return out

    def _parts(self, sid: int) -> dict[str, int]:
        """Bytes of the named parts of one snapshot: area totals plus the first-level folders the table needs."""
        out: dict[str, int] = {}
        for d in self.store.dirs(sid):
            out[d["area"] if d["name"] == "" else f"{d['area']}/{d['name']}"] = d["bytes"]
        return out

    def missing_dates(self, rows: list[dict[str, Any]]) -> list[str]:
        if len(rows) < 2:
            return []
        have = {r["snapshot_date"] for r in rows}
        d0, d1 = date.fromisoformat(rows[0]["snapshot_date"]), date.fromisoformat(rows[-1]["snapshot_date"])
        return [(d0 + timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1) if (d0 + timedelta(days=i)).isoformat() not in have]

    def compare(self, a_id: int, b_id: int) -> dict[str, Any]:
        a, b = self.store.snapshot(a_id), self.store.snapshot(b_id)
        if a is None or b is None:
            raise KeyError("snapshot not found")
        da, db = self._parts(a_id), self._parts(b_id)
        rows: list[dict[str, Any]] = []
        for k in sorted(set(da) | set(db)):
            x, y = da.get(k), db.get(k)
            ch = None if x is None or y is None else y - x
            rows.append({"name": k, "before": x, "after": y, "change": ch, "change_pct": None if ch is None or not x else round(100.0 * ch / x, 2)})
        ok = self._comparable(a, b)
        known = [r for r in rows if r["change"] is not None and "/" in r["name"]]
        return {
            "a": a, "b": b, "comparable": ok, "rows": rows,
            "note": None if ok else "One of the snapshots is partial or failed, or they used different methods: differences may not be exact.",
            "growing": sorted((r for r in known if r["change"] > 0), key=lambda r: -r["change"])[:5],
            "shrinking": sorted((r for r in known if r["change"] < 0), key=lambda r: r["change"])[:5],
            "files": self._file_changes(a_id, b_id),
        }

    def _file_changes(self, a_id: int, b_id: int) -> list[dict[str, Any]]:
        fa = {(f["area"], f["rel_path"]): f for f in self.store.files(a_id)}
        fb = {(f["area"], f["rel_path"]): f for f in self.store.files(b_id)}
        out = []
        for key in set(fa) | set(fb):
            x, y = fa.get(key), fb.get(key)
            if x and y and x["size"] == y["size"]:
                continue
            ref = y or x
            assert ref is not None
            out.append({
                "area": key[0], "path": key[1], "before": x["size"] if x else None, "after": y["size"] if y else None,
                "change": (y["size"] - x["size"]) if x and y else None, "cls": ref["cls"], "protected": bool(ref["protected"]),
                "note": "not among the largest files at the earlier snapshot" if y and not x else "no longer among the largest files" if x and not y else None,
            })
        out.sort(key=lambda r: -abs(r["change"] if r["change"] is not None else (r["after"] or r["before"] or 0)))
        return out[:100]

    def forecast(self) -> dict[str, Any]:
        c = self.store.config()
        rows = [r for r in self.history() if r["comparable"] and r["d_fs_used"] is not None]
        last = next((r for r in reversed(self.store.daily()) if r["status"] == "complete" and r["fs_total"]), None)
        base = {"threshold_pct": c["forecast_threshold_pct"], "method": "average of the daily net change in filesystem use between consecutive complete daily snapshots", "observations": len(rows)}
        if last is None:
            return {**base, "available": False, "reason": "no complete daily snapshot yet"}
        if len(rows) < c["forecast_min_days"]:
            return {**base, "available": False, "reason": f"needs {int(c['forecast_min_days'])} comparable daily observations, has {len(rows)}"}
        ch = [r["d_fs_used"] for r in rows]

        def avg(n: int) -> float | None:
            tail = ch[-n:]
            return statistics.fmean(tail) if len(tail) >= min(n, int(c["forecast_min_days"])) else None

        g7, g30 = avg(7), avg(30)
        g = g7
        out = {**base, "avg_7d": g7, "avg_30d": g30, "since": rows[0]["snapshot_date"], "as_of": last["snapshot_date"], "fs_used": last["fs_used"], "fs_total": last["fs_total"]}
        if g is None or g <= 0:
            return {**out, "available": False, "reason": "recent net growth is zero or negative: no countdown can be calculated"}
        sd = statistics.pstdev(ch[-7:]) if len(ch) >= 2 else 0.0
        if sd > 3 * g:
            return {**out, "available": False, "reason": "daily changes are too erratic for a reliable forecast (spread more than 3x the average)", "volatile": True}
        limit = c["forecast_threshold_pct"] / 100.0 * last["fs_total"]
        days = max(0.0, (limit - last["fs_used"]) / g)
        return {**out, "available": True, "days_to_threshold": round(days, 1), "projection": {str(d): last["fs_used"] + g * d for d in (7, 30, 90)}, "reason": None}

    def series(self, key: str, days: int) -> list[dict[str, Any]]:
        """A directory's (or area's) bytes per daily snapshot; dates without a measurement are absent, not zero."""
        cut = (self.clock().astimezone(IST).date() - timedelta(days=days)).isoformat()
        pts = []
        for r in self.store.daily():
            if r["snapshot_date"] < cut or r["status"] == "failed":
                continue
            parts = self._parts(r["id"])
            if key in parts:
                pts.append({"date": r["snapshot_date"], "bytes": parts[key], "status": r["status"]})
        return pts

    @staticmethod
    def csv(rows: list[dict[str, Any]]) -> str:
        cols = ["snapshot_date", "kind", "status", "fs_total", "fs_used", "fs_avail", "nse_bytes", "nse_alloc", "files", "dirs", "d_fs_used", "d_nse_bytes", "duration_s", "method", "error"]
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(cols)
        for r in rows:
            w.writerow([("" if r.get(c) is None else str(r.get(c)).replace("\n", " ")) for c in cols])
        return buf.getvalue()

    # ------------------------------------------------------------------ alerts
    def evaluate_alerts(self) -> None:
        c = self.store.config()
        raised: set[str] = set()

        def alert(key: str, level: str, title: str, detail: str) -> None:
            raised.add(key)
            self.store.raise_alert(key, level, title, detail)

        s = self.store.one("SELECT * FROM metric_samples ORDER BY id DESC LIMIT 1")
        if s is None or s["status"] == "failed":
            alert("collector", "critical", "Metrics collection failed", (s or {}).get("error") or "no metric sample has been recorded")
        else:
            age = (self.clock() - datetime.fromisoformat(s["ts_utc"])).total_seconds()
            if age > 3 * c["sample_interval_s"]:
                alert("stale", "warning", "Metrics are stale", f"newest sample is {int(age // 60)} minutes old")
            if s["disk_total"]:
                pct = 100.0 * s["disk_used"] / s["disk_total"]
                free_gb = s["disk_avail"] / 1e9
                if pct >= c["disk_crit_pct"] or free_gb < c["disk_free_crit_gb"]:
                    alert("disk", "critical", "Disk almost full", f"{pct:.1f}% used, {free_gb:.1f} GB free")
                elif pct >= c["disk_warn_pct"]:
                    alert("disk", "warning", "Disk filling", f"{pct:.1f}% used, {free_gb:.1f} GB free")
            if s["mem_total"] and s["mem_avail"] is not None:
                used = 100.0 * (s["mem_total"] - s["mem_avail"]) / s["mem_total"]
                if used >= c["ram_crit_pct"]:
                    alert("ram", "critical", "Memory pressure", f"{used:.1f}% of RAM in use (available memory is low)")
                elif used >= c["ram_warn_pct"]:
                    alert("ram", "warning", "High memory use", f"{used:.1f}% of RAM in use")
            recent = [r["cpu_pct"] for r in self.store.q("SELECT cpu_pct FROM metric_samples WHERE cpu_pct IS NOT NULL ORDER BY id DESC LIMIT 5")]
            if len(recent) == 5 and statistics.fmean(recent) >= c["cpu_warn_pct"]:
                alert("cpu", "warning", "Sustained high CPU", f"average {statistics.fmean(recent):.0f}% over the last 5 samples")
        hist = self.history()
        if hist:
            last = hist[-1]
            if last["d_fs_used"] is not None and last["d_fs_used"] > c["growth_warn_mb_day"] * MB:
                alert("growth", "warning", "Rapid storage growth", f"{last['d_fs_used'] / MB:.0f} MB net on {last['snapshot_date']} (limit {c['growth_warn_mb_day']:.0f} MB)")
        now = self.clock().astimezone(IST)
        due = now.replace(hour=int(c["daily_snapshot_hour"]), minute=int(c["daily_snapshot_minute"]), second=0, microsecond=0) + timedelta(hours=1)
        if now >= due and not self.store.one("SELECT id FROM storage_snapshots WHERE snapshot_date=? AND kind='daily' AND status != 'failed'", (now.date().isoformat(),)):
            alert("missing_daily", "warning", "Daily storage snapshot missing", f"no daily snapshot for {now.date().isoformat()} an hour after its scheduled time")
        failed = self.store.q("SELECT kind, detail FROM runs WHERE status='failed' AND started_utc > ? ORDER BY id DESC LIMIT 3", ((self.clock() - timedelta(hours=26)).isoformat(timespec="seconds"),))
        if failed:
            alert("job_failed", "warning", "A scheduled job failed", "; ".join(f"{f['kind']}: {f['detail']}" for f in failed)[:400])
        self.store.resolve_alerts(raised, "")

    # ------------------------------------------------------------------ overview
    def overview(self) -> dict[str, Any]:
        c = self.store.config()
        s = self.store.one("SELECT * FROM metric_samples ORDER BY id DESC LIMIT 1")
        hist = self.history()
        snap = self.store.one("SELECT * FROM storage_snapshots ORDER BY ts_utc DESC LIMIT 1")
        age = None if s is None else (self.clock() - datetime.fromisoformat(s["ts_utc"])).total_seconds()
        first = self.store.one("SELECT MIN(snapshot_date) d FROM storage_snapshots")
        return {
            "now_utc": self.clock().isoformat(timespec="seconds"), "timezone": "Asia/Kolkata", "host": {"hostname": mx.hostname_safe(), **mx.os_info(), **mx.cpu_info(), "uptime_s": mx.uptime_s()},
            "sample": s, "sample_age_s": age, "stale": age is None or age > 3 * c["sample_interval_s"], "latest_snapshot": snap, "latest_parts": self._parts(snap["id"]) if snap else {},
            "growth": hist[-1] if hist else None, "history_started": first["d"] if first else None, "scan_running": self.running_scan,
            "alerts": self.store.q("SELECT * FROM alerts WHERE resolved_utc IS NULL ORDER BY (level='critical') DESC, last_utc DESC"),
            "own_db_bytes": self.store.size_bytes(), "areas": [{"id": a.id, "label": a.label, "root": str(a.root), "exists": a.root.is_dir()} for a in self.areas],
        }

    # ------------------------------------------------------------------ scheduler
    def due_tick(self) -> None:
        """One scheduler pass (also called by tests): a sample when its interval has passed, the daily snapshot after its time."""
        c = self.store.config()
        if time.monotonic() - self._last_sample >= c["sample_interval_s"]:
            self._last_sample = time.monotonic()
            self.sample()
        now = self.clock().astimezone(IST)
        at = now.replace(hour=int(c["daily_snapshot_hour"]), minute=int(c["daily_snapshot_minute"]), second=0, microsecond=0)
        if now >= at:
            self.snapshot("daily")

    async def _loop(self) -> None:
        await asyncio.sleep(15)
        while True:
            try:
                await asyncio.to_thread(self.due_tick)
            except Exception:
                log.exception("server-management scheduler pass failed")
            await asyncio.sleep(30)

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop(), name="server-mgmt")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                log.debug("server-management scheduler stopped")
            self._task = None


__all__ = ["ServerMgmt", "ist_date", "now_iso"]
