"""Nightly, verified backups of every SQLite database, with a bounded retention.

``backups/daily/YYYYMMDD/<db>.sqlite3.gz`` + ``MANIFEST.json`` (checksums, integrity result). Each copy
is taken with SQLite's online backup (safe while the app runs), checked with ``quick_check`` and
compressed. Old backup folders are removed only when the newest backup verified, and only these are
touched: the newest ``keep_daily`` days, plus the first backup of each of the newest ``keep_monthly``
months, are kept. Files elsewhere in ``backups/`` (for example one-off safety copies) are never touched.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import shutil
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any


@dataclass
class BackupResult:
    day: str
    folder: str
    ok: bool
    files: dict[str, dict[str, Any]] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    skipped_existing: bool = False


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def _backup_one(src: Path, dest_gz: Path) -> dict[str, Any]:
    tmp = dest_gz.with_suffix("")  # ...sqlite3 (uncompressed, temporary)
    tmp.unlink(missing_ok=True)
    s = sqlite3.connect(f"file:{src.as_posix()}?mode=ro", uri=True)
    d = sqlite3.connect(tmp)
    try:
        s.backup(d)
        d.commit()
        check = d.execute("PRAGMA quick_check").fetchone()[0]
    finally:
        d.close()
        s.close()
    if check != "ok":
        tmp.unlink(missing_ok=True)
        raise sqlite3.DatabaseError(f"quick_check failed: {check}")
    with tmp.open("rb") as f_in, gzip.GzipFile(dest_gz, "wb", compresslevel=6, mtime=0) as f_out:
        shutil.copyfileobj(f_in, f_out)
    raw = tmp.stat().st_size
    tmp.unlink()
    return {"sha256": _sha(dest_gz), "bytes": dest_gz.stat().st_size, "raw_bytes": raw, "quick_check": "ok"}


def verify_folder(folder: Path) -> list[str]:
    """Problems found in an existing backup folder (empty list = intact)."""
    mf = folder / "MANIFEST.json"
    if not mf.exists():
        return ["manifest missing"]
    try:
        data = json.loads(mf.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return ["manifest unreadable"]
    out = []
    for name, info in data.get("files", {}).items():
        p = folder / name
        if not p.exists():
            out.append(f"{name} missing")
        elif _sha(p) != info.get("sha256"):
            out.append(f"{name} checksum differs")
    return out


def retention(folders: list[Path], keep_daily: int, keep_monthly: int) -> list[Path]:
    """Folders to remove: older than the newest ``keep_daily`` and not the first of a kept month."""
    days = sorted(folders, key=lambda p: p.name)
    keep = set(days[-keep_daily:]) if keep_daily > 0 else set()
    firsts: dict[str, Path] = {}
    for p in days:
        firsts.setdefault(p.name[:6], p)
    for m in sorted(firsts)[-keep_monthly:] if keep_monthly > 0 else []:
        keep.add(firsts[m])
    return [p for p in days if p not in keep]


def backup_databases(data_dir: Path, day: date, *, keep_daily: int = 7, keep_monthly: int = 6, now: datetime | None = None) -> BackupResult:
    root = data_dir / "backups" / "daily"
    folder = root / f"{day:%Y%m%d}"
    res = BackupResult(day.isoformat(), folder.relative_to(data_dir).as_posix(), ok=False)
    if folder.exists() and not verify_folder(folder):
        res.ok, res.skipped_existing = True, True
        return res
    tmp = root / f".{folder.name}.partial"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    for db in sorted(data_dir.glob("*.sqlite3")):
        try:
            res.files[db.name + ".gz"] = _backup_one(db, tmp / (db.name + ".gz"))
        except (sqlite3.Error, OSError) as e:
            res.problems.append(f"{db.name}: {type(e).__name__}")
    if res.problems or not res.files:
        shutil.rmtree(tmp, ignore_errors=True)
        res.problems = res.problems or ["no databases found"]
        return res
    (tmp / "MANIFEST.json").write_text(json.dumps({"day": day.isoformat(), "created_utc": (now or datetime.now(UTC)).isoformat(), "files": res.files}, indent=1), "utf-8")
    if folder.exists():  # a damaged earlier attempt of the same day: keep it aside, never overwrite
        folder.rename(root / f"{folder.name}.damaged-{int((now or datetime.now(UTC)).timestamp())}")
    tmp.rename(folder)
    bad = verify_folder(folder)
    if bad:
        res.problems = bad
        return res
    res.ok = True
    # tidy only after the newest backup verified
    for old in retention([p for p in root.iterdir() if p.is_dir() and p.name.isdigit() and len(p.name) == 8], keep_daily, keep_monthly):
        shutil.rmtree(old, ignore_errors=True)
        res.removed.append(old.name)
    return res
