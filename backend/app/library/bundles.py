"""Zip bundles of snapshot files, verified daily archives and manifests; their verification and a safe restore.

A bundle is a plain zip (stored, not re-compressed: snapshot files are gzip already) with ``MANIFEST.json`` as its last member listing every file with its size and
SHA-256. A bundle counts only after it has been written to a temporary name, fsynced, read back member by member against the manifest, and renamed. A restore verifies the
whole bundle first, accepts only the three known top folders, refuses any path that could leave the target folder, and never overwrites a file that is already there.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import IO, Any

from app.lifecycle.archive import archive_path

SCHEMA = 1
MANIFEST = "MANIFEST.json"
ALLOWED_TOP = ("snapshots", "archive", "manifests")
CHUNK = 1 << 20


class BundleError(Exception):
    """A bundle could not be built, verified or restored; the message says why."""


@dataclass(frozen=True)
class BundleInfo:
    name: str
    path: Path
    bytes: int
    sha256: str
    days: list[str]
    files: int
    manifest: dict[str, Any]


def _chunks(f: IO[bytes]) -> Iterator[bytes]:
    while chunk := f.read(CHUNK):
        yield chunk


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in _chunks(f):
            h.update(chunk)
    return h.hexdigest()


def collect_files(data_dir: Path, days: list[date], *, snapshots: bool = True, archive: bool = True, manifests: bool = True) -> list[tuple[Path, str, str]]:
    """(file, name inside the zip, day) for every wanted file that exists, oldest day first."""
    out: list[tuple[Path, str, str]] = []
    for d in sorted(days):
        iso = d.isoformat()
        if snapshots:
            folder = data_dir / "snapshots" / iso
            if folder.is_dir():
                out += [(f, f"snapshots/{iso}/{f.name}", iso) for f in sorted(folder.iterdir()) if f.is_file()]
        if archive:
            a = archive_path(data_dir, d)
            if a.is_file():
                out.append((a, a.relative_to(data_dir).as_posix(), iso))
        if manifests:
            m = data_dir / "manifests" / f"session={iso}.json"
            if m.is_file():
                out.append((m, f"manifests/{m.name}", iso))
    return out


def bundle_name(days: list[date]) -> str:
    ds = sorted(days)
    return f"nse-universe-bundle-{ds[0].isoformat()}_to_{ds[-1].isoformat()}.zip"


def _zipinfo(arc: str, src: Path) -> zipfile.ZipInfo:
    t = time.localtime(max(src.stat().st_mtime, 315532800))  # zip cannot hold a date before 1980
    zi = zipfile.ZipInfo(arc, date_time=t[:6])
    zi.compress_type = zipfile.ZIP_STORED
    return zi


def build_bundle(data_dir: Path, out_dir: Path, days: list[date], *, now: datetime | None = None, **include: bool) -> BundleInfo:
    """Write the bundle of ``days`` into ``out_dir`` and return it, verified. Raises ``BundleError`` when there is nothing to bundle or the written file does not verify."""
    files = collect_files(data_dir, days, **include)
    if not files:
        raise BundleError("no files exist for these days")
    got_days = sorted({d for _, _, d in files})
    name = bundle_name([date.fromisoformat(d) for d in got_days])
    out_dir.mkdir(parents=True, exist_ok=True)
    final, tmp = out_dir / name, out_dir / f".tmp-{name}"
    members: list[dict[str, Any]] = []
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED, allowZip64=True) as zf:
            for src, arc, day in files:
                h, size = hashlib.sha256(), 0
                with src.open("rb") as r, zf.open(_zipinfo(arc, src), "w", force_zip64=True) as w:
                    for chunk in _chunks(r):
                        h.update(chunk)
                        size += len(chunk)
                        w.write(chunk)
                members.append({"path": arc, "bytes": size, "sha256": h.hexdigest(), "day": day})
            manifest = {
                "schema": SCHEMA, "kind": "nse-universe-bundle", "created_utc": (now or datetime.now(UTC)).isoformat(), "days": got_days, "files": len(members),
                "bytes": sum(m["bytes"] for m in members), "members": members,
                "note": "snapshot files, verified daily archives and session manifests; restore only through the app, which verifies every file first",
            }  # fmt: skip
            zf.writestr(MANIFEST, json.dumps(manifest, indent=1))
        with tmp.open("r+b") as f:  # fsync needs a descriptor that can write (Windows refuses it on a read-only one)
            os.fsync(f.fileno())
        verify_bundle(tmp)
        tmp.replace(final)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return BundleInfo(name, final, final.stat().st_size, sha256_file(final), got_days, len(members), manifest)


def read_manifest(path: Path) -> dict[str, Any]:
    try:
        with zipfile.ZipFile(path) as zf:
            doc = json.loads(zf.read(MANIFEST))
    except (OSError, KeyError, zipfile.BadZipFile, json.JSONDecodeError) as e:
        raise BundleError(f"not a readable bundle ({type(e).__name__})") from e
    if not isinstance(doc, dict) or doc.get("kind") != "nse-universe-bundle" or doc.get("schema") != SCHEMA or not isinstance(doc.get("members"), list):
        raise BundleError("not an NSE Universe bundle of a known version")
    return doc


def verify_bundle(path: Path) -> dict[str, Any]:
    """Read every member back and compare size and SHA-256 with the manifest; return the manifest or raise ``BundleError``."""
    doc = read_manifest(path)
    try:
        with zipfile.ZipFile(path) as zf:
            names = set(zf.namelist())
            for m in doc["members"]:
                if m["path"] not in names:
                    raise BundleError(f"{m['path']} is listed but missing")
                h, size = hashlib.sha256(), 0
                with zf.open(m["path"]) as f:
                    for chunk in _chunks(f):
                        h.update(chunk)
                        size += len(chunk)
                if size != m["bytes"] or h.hexdigest() != m["sha256"]:
                    raise BundleError(f"{m['path']} does not match its checksum")
    except (zipfile.BadZipFile, OSError) as e:
        raise BundleError(f"damaged bundle ({type(e).__name__})") from e
    return doc


def _safe(rel: str) -> bool:
    p = Path(rel)
    return not p.is_absolute() and ".." not in p.parts and bool(p.parts) and p.parts[0] in ALLOWED_TOP and "\\" not in rel and ":" not in rel


def restore_bundle(path: Path, dest: Path, *, max_bytes: int) -> dict[str, Any]:
    """Verify ``path`` and unpack it under ``dest``; return the manifest. Nothing is unpacked if anything fails to verify or the size is over ``max_bytes``."""
    doc = read_manifest(path)
    for m in doc["members"]:  # the cheap checks first: a bundle that names a path outside our three folders is refused before anything is read
        if not _safe(m["path"]):
            raise BundleError(f"unsafe path in the bundle: {m['path']!r}")
    if int(doc.get("bytes", 0)) > max_bytes:
        raise BundleError(f"the bundle holds {doc['bytes'] / 1e6:.0f} MB; a restore is limited to {max_bytes / 1e6:.0f} MB")
    verify_bundle(path)
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path) as zf:
        for m in doc["members"]:
            target = dest / m["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                continue  # never overwrite
            tmp = target.with_name(target.name + ".tmp")
            with zf.open(m["path"]) as r, tmp.open("wb") as w:
                for chunk in _chunks(r):
                    w.write(chunk)
            tmp.replace(target)
    return doc
