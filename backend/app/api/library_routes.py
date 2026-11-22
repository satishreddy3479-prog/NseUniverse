"""The data library API: bundles of aged data (build, download, confirm), temporary restores, and the coverage check.

Reading and downloading are open to the signed-in site like every page; building, confirming, deleting and restoring change state and use the same local-control rule as the
other operational endpoints.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import date
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.api.security import require_local_control
from app.library.service import LibraryError, LibraryService

router = APIRouter(prefix="/api/library", tags=["library"])

_STATUS = {"not_found": 404, "nothing_to_bundle": 404, "busy": 409, "low_disk": 409, "checksum_mismatch": 409, "not_downloaded": 409, "bad_range": 422, "bad_bundle": 422, "too_big": 413}


class BuildRequest(BaseModel):
    start: date
    end: date


class ConfirmRequest(BaseModel):
    sha256: str = Field(min_length=64, max_length=64)


class RestoreRequest(BaseModel):
    bundle_id: int


def _svc(request: Request) -> LibraryService:
    svc: LibraryService | None = getattr(request.app.state, "library", None)
    if svc is None or not svc.enabled:
        raise HTTPException(404, {"code": "disabled", "message": "the data library is turned off"})
    return svc


def _err(e: LibraryError) -> HTTPException:
    return HTTPException(_STATUS.get(e.code, 500), {"code": e.code, "message": e.message})


@router.get("/status")
async def status(request: Request) -> dict[str, Any]:
    svc = _svc(request)
    return await asyncio.to_thread(svc.status)


@router.post("/bundles", dependencies=[Depends(require_local_control)])
async def build_bundle(body: BuildRequest, request: Request) -> dict[str, Any]:
    svc = _svc(request)
    try:
        return await asyncio.to_thread(svc.build, body.start, body.end)
    except LibraryError as e:
        raise _err(e) from e


@router.get("/bundles/{bundle_id}/download")
async def download_bundle(bundle_id: int, request: Request) -> FileResponse:
    svc = _svc(request)
    try:
        path, b = svc.bundle_file(bundle_id)
    except LibraryError as e:
        raise _err(e) from e
    return FileResponse(path, media_type="application/zip", filename=b["name"], headers={"X-Bundle-Sha256": b["sha256"], "Cache-Control": "no-store"})


@router.post("/bundles/{bundle_id}/confirm", dependencies=[Depends(require_local_control)])
async def confirm_bundle(bundle_id: int, body: ConfirmRequest, request: Request) -> dict[str, Any]:
    svc = _svc(request)
    try:
        return svc.confirm(bundle_id, body.sha256)
    except LibraryError as e:
        raise _err(e) from e


@router.delete("/bundles/{bundle_id}", dependencies=[Depends(require_local_control)])
async def delete_bundle(bundle_id: int, request: Request) -> dict[str, Any]:
    svc = _svc(request)
    try:
        return svc.delete_bundle(bundle_id)
    except LibraryError as e:
        raise _err(e) from e


@router.post("/restore", dependencies=[Depends(require_local_control)])
async def restore_from_server(body: RestoreRequest, request: Request) -> dict[str, Any]:
    svc = _svc(request)
    try:
        return await asyncio.to_thread(svc.restore_from_server, body.bundle_id)
    except LibraryError as e:
        raise _err(e) from e


@router.put("/restore/upload", dependencies=[Depends(require_local_control)])
async def restore_from_upload(request: Request, name: str = "bundle.zip") -> dict[str, Any]:
    """The body is the zip itself, streamed to disk in pieces (never held in memory); verified and unpacked like a bundle held on the server."""
    svc = _svc(request)
    limit = svc.restore_max + (4 << 20)
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise HTTPException(413, {"code": "too_big", "message": f"a restore is limited to {svc.restore_max // 10**6} MB"})
    inbox = svc.restore_dir / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    tmp = inbox / f"{uuid.uuid4().hex}.zip"
    size = 0
    try:
        with tmp.open("wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, {"code": "too_big", "message": f"a restore is limited to {svc.restore_max // 10**6} MB"})
                f.write(chunk)
        try:
            return await asyncio.to_thread(svc.restore, tmp, Path(name).name[:120])
        except LibraryError as e:
            raise _err(e) from e
    finally:
        tmp.unlink(missing_ok=True)


@router.delete("/restore/{restore_id}", dependencies=[Depends(require_local_control)])
async def remove_restore(restore_id: int, request: Request) -> dict[str, Any]:
    svc = _svc(request)
    try:
        svc.remove_restore(restore_id)
    except LibraryError as e:
        raise _err(e) from e
    return {"removed": restore_id}


@router.post("/restore/{restore_id}/keep", dependencies=[Depends(require_local_control)])
async def keep_restore(restore_id: int, request: Request) -> dict[str, Any]:
    svc = _svc(request)
    try:
        return svc.keep_restore(restore_id)
    except LibraryError as e:
        raise _err(e) from e


@router.get("/coverage")
async def coverage(request: Request, start: date, end: date) -> dict[str, Any]:
    """Is the data of the stored sessions between two dates there? (What a backtest checks before it runs.)"""
    svc = _svc(request)
    if end < start:
        raise HTTPException(422, {"code": "bad_range", "message": "the range must run forward"})
    days = sorted(d for d in svc._sessions() if start.isoformat() <= d <= end.isoformat())  # noqa: SLF001
    return await asyncio.to_thread(svc.coverage, days)
