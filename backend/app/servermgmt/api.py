"""HTTP API of the Server Management Centre (``/api/server/...``).

Reads are open to the logged-in site like every other page. Anything that changes state needs ``require_local_control``
(loopback client, allowed Origin) AND the custom ``X-NSE-Action`` header, which a page on another site cannot add without
a CORS pre-flight (the CSRF defence). Responses carry ``Cache-Control: no-store``.
"""

from __future__ import annotations

import asyncio
import io
import json
import zipfile
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from app.api.security import require_local_control
from app.servermgmt import config as cfg
from app.servermgmt import metrics as mx
from app.servermgmt import ops
from app.servermgmt import scan as sc
from app.servermgmt.service import ServerMgmt

ACTION_HEADER = "x-nse-action"


async def no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


def require_action_header(request: Request) -> None:
    if request.headers.get(ACTION_HEADER) != "server-mgmt":
        raise HTTPException(403, {"code": "forbidden", "message": "missing action header"})


router = APIRouter(prefix="/api/server", dependencies=[Depends(no_store)])
guard = [Depends(require_local_control), Depends(require_action_header)]


def _sm(request: Request) -> ServerMgmt:
    sm = getattr(request.app.state, "servermgmt", None)
    if sm is None:
        raise HTTPException(503, {"code": "unavailable", "message": "the server-management module is not running"})
    return sm  # type: ignore[no-any-return]


def _actor(request: Request) -> str:
    return request.headers.get("x-forwarded-user") or "operator"


def _redactor(request: Request):  # type: ignore[no-untyped-def]
    return ops.make_redactor(list(request.app.state.settings.secret_values()))


def _mgmt_dir(request: Request):  # type: ignore[no-untyped-def]
    return request.app.state.settings.data_dir / "mgmt"


@router.get("/overview")
async def overview(request: Request) -> dict[str, Any]:
    sm = _sm(request)
    o = await asyncio.to_thread(sm.overview)
    o["health"] = await asyncio.to_thread(ops.health_check, request.app.state.settings.app_port) if getattr(request.app.state.settings, "app_port", None) else None
    o["thresholds"] = {k: v for k, v in sm.store.config().items() if k.endswith("_pct") or k.endswith("_gb")}
    return o


@router.get("/metrics")
async def metrics_history(request: Request, hours: Annotated[int, Query(ge=1, le=24 * 365)] = 24, max_points: Annotated[int, Query(ge=20, le=1500)] = 600) -> dict[str, Any]:
    sm = _sm(request)
    since = (sm.clock() - timedelta(hours=hours)).isoformat(timespec="seconds")
    rows = await asyncio.to_thread(sm.store.q, "SELECT * FROM metric_samples WHERE ts_utc >= ? ORDER BY ts_utc", (since,))
    stride = max(1, -(-len(rows) // max_points))
    return {"hours": hours, "samples": len(rows), "stride": stride, "rows": rows[::stride], "note": "cpu_pct is the change since the previous sample; the first sample after a restart has none. Network and disk counters are cumulative since boot."}


@router.get("/processes")
async def processes(sort: Annotated[str, Query(pattern="^(rss|cpu|name|pid)$")] = "rss", limit: Annotated[int, Query(ge=1, le=300)] = 50, q: Annotated[str, Query(max_length=60)] = "") -> dict[str, Any]:
    rows = await asyncio.to_thread(mx.processes, 1000)
    if rows is None:
        return {"available": False, "reason": "process information is not readable on this host", "rows": []}
    if q:
        rows = [r for r in rows if q.lower() in r["name"].lower()]
    key = {"rss": lambda r: -r["rss"], "cpu": lambda r: -(r["cpu_pct_lifetime"] or 0), "name": lambda r: r["name"].lower(), "pid": lambda r: r["pid"]}[sort]
    mem = mx.meminfo()
    return {"available": True, "rows": sorted(rows, key=key)[:limit], "total": len(rows), "note": "CPU % is the process's average since it started; command lines and environments are not read.", "mem_total": mem["total"] if mem else None}


# ------------------------------------------------------------------ storage
@router.get("/storage/history")
async def storage_history(
    request: Request, date_from: str = "", date_to: str = "", q: Annotated[str, Query(max_length=40)] = "", sort: Annotated[str, Query(pattern="^(asc|desc)$")] = "desc",
    page: Annotated[int, Query(ge=1)] = 1, size: Annotated[int, Query(ge=5, le=1000)] = 30,
) -> dict[str, Any]:
    sm = _sm(request)
    rows = await asyncio.to_thread(sm.history)
    first = rows[0]["snapshot_date"] if rows else None
    missing = sm.missing_dates(rows)
    if date_from:
        rows = [r for r in rows if r["snapshot_date"] >= date_from]
    if date_to:
        rows = [r for r in rows if r["snapshot_date"] <= date_to]
    if q:
        rows = [r for r in rows if q.lower() in f"{r['snapshot_date']} {r['status']} {r['kind']}".lower()]
    rows = sorted(rows, key=lambda r: r["snapshot_date"], reverse=sort == "desc")
    total = len(rows)
    return {
        "rows": rows[(page - 1) * size : page * size], "total": total, "page": page, "size": size, "missing_dates": missing, "first_date": first,
        "note": f"Historical data collection began on {first}. Earlier storage usage is unavailable." if first else "No storage snapshot has been recorded yet.",
    }


@router.get("/storage/history.csv")
async def storage_csv(request: Request) -> PlainTextResponse:
    sm = _sm(request)
    rows = await asyncio.to_thread(sm.history)
    return PlainTextResponse(sm.csv(rows), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="nse-storage-history.csv"', "Cache-Control": "no-store"})


@router.get("/storage/snapshot/{sid}")
async def storage_snapshot(request: Request, sid: int) -> dict[str, Any]:
    sm = _sm(request)
    s = sm.store.snapshot(sid)
    if s is None:
        raise HTTPException(404, {"code": "not_found", "message": "no such snapshot"})
    return {"snapshot": s, "dirs": sm.store.dirs(sid), "files": sm.store.files(sid)[:200]}


@router.get("/storage/compare")
async def storage_compare(request: Request, a: int, b: int) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(_sm(request).compare, a, b)
    except KeyError as e:
        raise HTTPException(404, {"code": "not_found", "message": "no such snapshot"}) from e


@router.get("/storage/series")
async def storage_series(request: Request, key: Annotated[str, Query(max_length=200)] = "project", days: Annotated[int, Query(ge=1, le=3650)] = 30) -> dict[str, Any]:
    return {"key": key, "days": days, "points": await asyncio.to_thread(_sm(request).series, key, days)}


@router.get("/storage/forecast")
async def storage_forecast(request: Request) -> dict[str, Any]:
    return await asyncio.to_thread(_sm(request).forecast)


@router.get("/explorer")
async def explorer(request: Request, area: Annotated[str, Query(max_length=30)] = "", path: Annotated[str, Query(max_length=400)] = "") -> dict[str, Any]:
    sm = _sm(request)
    areas = {a.id: a for a in sm.areas}
    if not area:
        return {"areas": [{"id": a.id, "label": a.label, "exists": a.root.is_dir()} for a in sm.areas]}
    if area not in areas:
        raise HTTPException(404, {"code": "not_found", "message": "unknown area"})
    try:
        return {"area": area, **await asyncio.to_thread(sc.list_dir, areas[area].root, path)}
    except sc.PathError as e:
        raise HTTPException(400, {"code": "bad_path", "message": str(e)}) from e
    except OSError as e:
        raise HTTPException(404, {"code": "not_found", "message": "cannot read that directory"}) from e


# ------------------------------------------------------------------ logs
@router.get("/logs/sources")
async def log_sources(request: Request) -> dict[str, Any]:
    return {"sources": ops.log_sources(request.app.state.settings.log_dir)}


@router.get("/logs")
async def logs(
    request: Request, source: Annotated[str, Query(max_length=80)], q: Annotated[str, Query(max_length=100)] = "", level: Annotated[str, Query(pattern="^(|DEBUG|INFO|WARNING|ERROR|CRITICAL)$")] = "",
    since: Annotated[str, Query(max_length=40)] = "", until: Annotated[str, Query(max_length=40)] = "", limit: Annotated[int, Query(ge=1, le=500)] = 200, before: int | None = None,
) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(ops.read_log, request.app.state.settings.log_dir, source, _redactor(request), q=q, level=level, since=since, until=until, limit=limit, before=before)
    except KeyError as e:
        raise HTTPException(404, {"code": "not_found", "message": "unknown log source"}) from e


# ------------------------------------------------------------------ services, jobs, releases, cache
@router.get("/services")
async def services(request: Request) -> dict[str, Any]:
    sm = _sm(request)
    c = sm.store.config()
    rows = [await asyncio.to_thread(ops.service_status, n) for n in cfg.STATUS_ONLY_SERVICES]
    for r in rows:
        r["manageable"] = r["name"] in c["manageable_services"] and r["name"] in cfg.SERVICE_ALL
    return {"services": rows, "helper": ops.helper_state(_mgmt_dir(request)), "last_restart": ops.restart_result(_mgmt_dir(request)), "health": await asyncio.to_thread(ops.health_check, request.app.state.settings.app_port)}


@router.get("/jobs")
async def jobs(request: Request) -> dict[str, Any]:
    sm = _sm(request)
    hist = getattr(request.app.state, "history", None)
    return {"collector_runs": sm.store.q("SELECT * FROM runs ORDER BY id DESC LIMIT 50"), "daily_prices": hist.status() if hist is not None else None,
            "schedule": {"metrics_every_s": sm.store.config()["sample_interval_s"], "daily_snapshot_ist": f"{int(sm.store.config()['daily_snapshot_hour']):02d}:{int(sm.store.config()['daily_snapshot_minute']):02d}"}}


@router.get("/releases")
async def releases(request: Request) -> dict[str, Any]:
    sm = _sm(request)
    project = next((a for a in sm.areas if a.id == "project"), None)
    if project is None:
        return {"available": False, "releases": [], "active": None}
    snap = sm.store.one("SELECT id FROM storage_snapshots WHERE status != 'failed' ORDER BY ts_utc DESC LIMIT 1")
    sizes = {d["name"]: d["bytes"] for d in sm.store.dirs(snap["id"]) if d["area"] == "project"} if snap else {}
    out = await asyncio.to_thread(ops.releases, project.root, sizes)
    out["health"] = await asyncio.to_thread(ops.health_check, request.app.state.settings.app_port)
    return out


@router.get("/cache")
async def cache(request: Request) -> dict[str, Any]:
    from app.lifecycle import storage as lstore

    sm = _sm(request)
    data = request.app.state.settings.data_dir
    items = []
    for name, (patterns, klass, rule) in lstore.CATEGORIES.items():
        if klass in ("cache", "regenerable"):
            n, total = lstore._size(data, patterns)  # noqa: SLF001
            items.append({"name": name, "class": klass, "files": n, "bytes": total, "rule": rule, "cleanable": True, "where": "data directory"})
    snap = sm.store.one("SELECT id FROM storage_snapshots WHERE status != 'failed' ORDER BY ts_utc DESC LIMIT 1")
    parts = {d["name"]: d for d in sm.store.dirs(snap["id"]) if d["area"] == "project"} if snap else {}
    if "cache" in parts:
        items.append({"name": "project cache directory", "class": "unknown use", "files": parts["cache"]["files"], "bytes": parts["cache"]["bytes"], "rule": "measured only: what the application keeps there has not been verified, so it is never offered for deletion", "cleanable": False, "where": "project root", "from_snapshot": snap["id"] if snap else None})
    return {"items": items, "note": "Cleanup runs from Maintenance, preview first; only items marked cleanable can be removed and only by the existing Data clean-up rules.", "series": {"project/cache": sm.series("project/cache", 90)}}


# ------------------------------------------------------------------ alerts, audit, config
@router.get("/alerts")
async def alerts(request: Request, include_resolved: bool = False, limit: Annotated[int, Query(ge=1, le=500)] = 100) -> dict[str, Any]:
    sm = _sm(request)
    where = "" if include_resolved else "WHERE resolved_utc IS NULL "
    return {"alerts": sm.store.q(f"SELECT * FROM alerts {where}ORDER BY last_utc DESC LIMIT ?", (limit,))}  # noqa: S608 - fixed text


@router.get("/audit")
async def audit(request: Request, limit: Annotated[int, Query(ge=1, le=500)] = 100, offset: Annotated[int, Query(ge=0)] = 0) -> dict[str, Any]:
    sm = _sm(request)
    total = sm.store.one("SELECT COUNT(*) n FROM operations") or {"n": 0}
    return {"rows": sm.store.q("SELECT * FROM operations ORDER BY id DESC LIMIT ? OFFSET ?", (limit, offset)), "total": total["n"]}


@router.get("/config")
async def get_config(request: Request) -> dict[str, Any]:
    sm = _sm(request)
    return {"values": sm.store.config(), "schema": {k: {"default": v[0], "min": v[1], "max": v[2], "description": v[3]} for k, v in cfg.SCHEMA.items()}, "lists": {k: {"default": v[0], "max_items": v[1]} for k, v in cfg.LISTS.items()}}


class ConfigBody(BaseModel):
    values: dict[str, Any]


@router.put("/config", dependencies=guard)
async def put_config(body: ConfigBody, request: Request) -> dict[str, Any]:
    sm = _sm(request)
    try:
        new = await asyncio.to_thread(sm.store.set_config, body.values)
    except cfg.ConfigError as e:
        sm.store.audit(_actor(request), "config", ",".join(sorted(body.values))[:200], "execute", "rejected", str(e))
        raise HTTPException(422, {"code": "bad_config", "message": str(e)}) from e
    sm.store.audit(_actor(request), "config", ",".join(sorted(body.values))[:200], "execute", "ok", json.dumps(body.values, default=str)[:600])
    return {"values": new}


# ------------------------------------------------------------------ maintenance
OPS: dict[str, dict[str, Any]] = {
    "scan_storage": {"title": "Scan storage now", "target": "project, data and log areas", "effect": "Reads file sizes and records a snapshot. Deletes nothing.", "risk": "low", "confirm": False, "preview": False},
    "refresh_metrics": {"title": "Refresh system metrics", "target": "/proc and the filesystem", "effect": "Records one sample now.", "risk": "low", "confirm": False, "preview": False},
    "health_check": {"title": "Run application health check", "target": "this application's /api/health on loopback", "effect": "Reads the health endpoint.", "risk": "low", "confirm": False, "preview": False},
    "retention_cleanup": {"title": "Monitoring retention cleanup", "target": "this module's own history tables only", "effect": "Deletes metric samples, file inventories, snapshots, runs and resolved alerts older than the retention settings. Never touches trading data.", "risk": "medium", "confirm": True, "preview": True},
    "restart_service": {"title": "Restart nse-universe", "target": "the nse-universe service, through the privileged helper", "effect": "Restarts the application: the website and the data feed are unavailable for a short time.", "risk": "high", "confirm": True, "preview": False},
}


@router.get("/maintenance")
async def maintenance(request: Request) -> dict[str, Any]:
    sm = _sm(request)
    return {"operations": [{"id": k, **v} for k, v in OPS.items()], "retention_preview": await asyncio.to_thread(sm.store.prune, True), "helper": ops.helper_state(_mgmt_dir(request)), "last_restart": ops.restart_result(_mgmt_dir(request))}


class RunBody(BaseModel):
    op: str
    dry_run: bool = False
    confirm: bool = False
    service: str | None = None


@router.post("/maintenance/run", dependencies=guard)
async def maintenance_run(body: RunBody, request: Request) -> dict[str, Any]:
    sm = _sm(request)
    actor = _actor(request)
    spec = OPS.get(body.op)
    if spec is None:
        raise HTTPException(400, {"code": "unknown_operation", "message": "operation not in the approved list"})
    mode = "preview" if body.dry_run else "execute"
    if spec["confirm"] and not body.dry_run and not body.confirm:
        sm.store.audit(actor, body.op, spec["target"], mode, "refused", "confirmation missing")
        raise HTTPException(409, {"code": "confirmation_required", "message": "this operation needs explicit confirmation"})
    try:
        if body.op == "scan_storage":
            r = await asyncio.to_thread(sm.snapshot, "manual")
            status = "ok" if "skipped" not in r else "refused"
            verification = f"snapshot {r['id']} {r['status']}" if "id" in r else r.get("skipped")
            res: dict[str, Any] = {"result": r}
        elif body.op == "refresh_metrics":
            r = await asyncio.to_thread(sm.sample)
            status, verification, res = "ok", f"sample {r['id']} {r['status']}", {"result": r}
        elif body.op == "health_check":
            r = await asyncio.to_thread(ops.health_check, request.app.state.settings.app_port)
            status, verification, res = ("ok" if r["ok"] else "failed"), f"{r['status']} in {r['ms']} ms", {"result": r}
        elif body.op == "retention_cleanup":
            r = await asyncio.to_thread(sm.store.prune, body.dry_run)
            status, verification, res = "ok", ("preview: " if body.dry_run else "deleted: ") + json.dumps(r), {"result": r, "dry_run": body.dry_run}
        else:  # restart_service
            if body.dry_run:
                status, verification, res = "ok", "no change made", {"result": {"would_restart": body.service or "nse-universe"}}
            else:
                req = ops.queue_restart(_mgmt_dir(request), body.service or "nse-universe", sm.store.config()["manageable_services"], actor)
                status, verification = "queued", "waiting for the helper; check Services for the result"
                res = {"result": req}
    except (KeyError, RuntimeError) as e:
        sm.store.audit(actor, body.op, spec["target"], mode, "refused", str(e))
        raise HTTPException(409, {"code": "refused", "message": str(e)}) from e
    oid = sm.store.audit(actor, body.op, spec["target"], mode, status, spec["effect"], verification)
    return {"id": oid, "op": body.op, "mode": mode, "status": status, "verification": verification, "at": datetime.now(UTC).isoformat(timespec="seconds"), **res}


@router.get("/diagnostics/bundle")
async def diagnostics_bundle(request: Request) -> Response:
    sm = _sm(request)
    redact = _redactor(request)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("overview.json", redact(json.dumps(await asyncio.to_thread(sm.overview), default=str, indent=1)))
        z.writestr("config.json", json.dumps(sm.store.config(), indent=1))
        z.writestr("storage-history.csv", sm.csv(sm.history()))
        z.writestr("alerts.json", json.dumps(sm.store.q("SELECT * FROM alerts ORDER BY id DESC LIMIT 200"), indent=1))
        z.writestr("audit.json", json.dumps(sm.store.q("SELECT * FROM operations ORDER BY id DESC LIMIT 200"), indent=1))
        ls = request.app.state.settings.log_dir
        for s in ops.log_sources(ls)[:3]:
            part = ops.read_log(ls, s["name"], redact, level="WARNING", limit=300)
            z.writestr(f"log-{s['name']}-warnings.json", json.dumps(part["rows"], indent=1))
    sm.store.audit(_actor(request), "diagnostic_bundle", "overview, config, history, alerts, audit, warning logs", "execute", "ok", f"{buf.tell()} bytes", "secrets redacted")
    return Response(buf.getvalue(), media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="nse-diagnostics.zip"', "Cache-Control": "no-store"})
