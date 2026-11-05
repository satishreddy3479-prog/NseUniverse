"""Bounded, read-only storage scan and the path rules of the explorer.

* ``scan_area`` walks one approved root with ``os.scandir``: symlinks are counted as the link itself and never followed,
  hard-linked files are counted once, and the walk stops (``complete = False``) when ``timeout_s`` is reached.
* Each area's total is the sum of its own files, split by the first path component, so a total never adds a nested
  directory twice. Areas are separate roots (project, data, logs); callers must not nest them.
* ``resolve_inside`` is the only way the explorer turns a request into a path: it refuses absolute paths, ``..``, NUL
  bytes and any component that is a symlink, then checks the real path is still under the root.
"""

from __future__ import annotations

import fnmatch
import heapq
import os
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

METHOD = "scandir-v1: logical bytes = st_size, allocated = st_blocks*512, symlinks not followed, hard links counted once"

#: first path component or file name pattern -> (class, protected)
PROTECTED_PATTERNS = ("*.sqlite3", "*.sqlite3-wal", "*.sqlite3-shm", ".env", "*.env", "*.pem", "*.key", "id_*")
PROTECTED_DIRS = {"snapshots", "archive", "backups", "manifests", "venv", "releases", "repo", "state", "home"}
REGENERABLE_DIRS = {"exports", "cache", "__pycache__"}


def classify(rel_path: str) -> tuple[str, bool]:
    """(class, protected) of a file by where it sits. Protection is the default; only known regenerable places are not."""
    parts = Path(rel_path).parts
    name = parts[-1] if parts else rel_path
    if any(fnmatch.fnmatch(name, p) for p in PROTECTED_PATTERNS):
        return "database or secret", True
    if parts and parts[0] in REGENERABLE_DIRS:
        return "regenerable", False
    if name.endswith(".tmp"):
        return "temporary", False
    if name == "prediction_report.json":
        return "cache", False
    if name.endswith((".log", ".gz")) and ("log" in parts[0:1] or name.endswith(".log") or ".log." in name):
        return "log", False
    if parts and parts[0] in PROTECTED_DIRS:
        return "kept data", True
    return "other", True


@dataclass
class Area:
    id: str
    root: Path
    label: str


@dataclass
class ScanResult:
    area: str
    complete: bool = True
    files: int = 0
    dirs: int = 0
    bytes: int = 0
    alloc: int = 0
    seconds: float = 0.0
    errors: list[str] = field(default_factory=list)
    by_top: dict[str, list[int]] = field(default_factory=dict)  # name -> [bytes, alloc, files]
    biggest: list[tuple[int, str, float]] = field(default_factory=list)  # (size, rel_path, mtime)


def scan_area(area: Area, *, timeout_s: float, top_n: int, excluded_dirs: list[str], excluded_patterns: list[str], split: tuple[str, ...] = (), skip: frozenset[str] = frozenset()) -> ScanResult:
    res = ScanResult(area.id)
    t0 = time.monotonic()
    root = area.root
    if not root.is_dir():
        res.complete = False
        res.errors.append(f"{root} is not a directory")
        return res
    heap: list[tuple[int, str, float]] = []
    seen_links: set[tuple[int, int]] = set()
    stack: list[tuple[Path, str, str]] = [(root, "", "")]  # (directory, first component, second component when split)
    n = 0
    while stack:
        cur, top, second = stack.pop()
        try:
            it = os.scandir(cur)
        except OSError as err:
            res.errors.append(f"{cur.name}: {err.strerror or err}")
            continue
        with it:
            for e in it:
                n += 1
                if n % 2000 == 0:
                    time.sleep(0.002)  # yield: this scan runs on a small shared server
                    if time.monotonic() - t0 > timeout_s:
                        res.complete = False
                        stack.clear()
                        break
                try:
                    st = e.stat(follow_symlinks=False)
                    is_dir = e.is_dir(follow_symlinks=False)
                except OSError as ex:
                    res.errors.append(f"{e.name}: {ex.strerror or ex}")
                    continue
                if (is_dir and e.name in excluded_dirs) or (not is_dir and any(fnmatch.fnmatch(e.name, p) for p in excluded_patterns)):
                    continue  # excluded by configuration: left out of every total, and the snapshot says so
                name_top = top or e.name
                if is_dir and os.path.normcase(os.path.abspath(e.path)) in skip:
                    continue  # another approved area that lives inside this one: counted there, not twice
                if is_dir:
                    res.dirs += 1
                    stack.append((Path(e.path), name_top, e.name if (top in split and not second) else second))
                    continue
                if st.st_nlink > 1:  # a hard link: count the data once
                    inode = (st.st_dev, st.st_ino)
                    if inode in seen_links:
                        continue
                    seen_links.add(inode)
                size = st.st_size
                blocks = getattr(st, "st_blocks", None)
                alloc = blocks * 512 if blocks is not None else size
                res.files += 1
                res.bytes += size
                res.alloc += alloc
                for label in (name_top if top else "(files in root)", f"{top}/{second}" if second else None):
                    if label is None:
                        continue
                    row = res.by_top.setdefault(label, [0, 0, 0])
                    row[0] += size
                    row[1] += alloc
                    row[2] += 1
                if top_n:
                    rel = os.path.relpath(e.path, root).replace("\\", "/")
                    item = (size, rel, st.st_mtime)
                    if len(heap) < top_n:
                        heapq.heappush(heap, item)
                    elif size > heap[0][0]:
                        heapq.heapreplace(heap, item)
    res.biggest = sorted(heap, reverse=True)
    res.seconds = round(time.monotonic() - t0, 3)
    return res


def inventory_rows(area_id: str, res: ScanResult) -> list[dict[str, Any]]:
    out = []
    for size, rel, mtime in res.biggest:
        cls, prot = classify(rel)
        out.append({"area": area_id, "rel_path": rel, "size": size, "mtime_utc": datetime.fromtimestamp(mtime, UTC).isoformat(timespec="seconds"), "cls": cls, "protected": prot})
    return out


class PathError(ValueError):
    pass


def resolve_inside(root: Path, rel: str) -> Path:
    """The real path of ``rel`` under ``root``, or ``PathError``. No absolute paths, no ``..``, no symlink components."""
    if "\x00" in rel or rel.startswith(("/", "\\")) or (len(rel) > 1 and rel[1] == ":"):
        raise PathError("path must be relative to the area")
    parts = [p for p in rel.replace("\\", "/").split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise PathError("'..' is not allowed")
    base = root.resolve()
    cur = base
    for p in parts:
        cur = cur / p
        if cur.is_symlink():
            raise PathError("symbolic links are not followed")
    real = cur.resolve()
    if real != base and base not in real.parents:
        raise PathError("path escapes the area")
    return real


def list_dir(root: Path, rel: str, *, max_entries: int = 500, size_budget_s: float = 2.0) -> dict[str, Any]:
    """Immediate children of a directory with sizes. Subdirectory sizes come from a bounded walk and are flagged
    ``partial`` when the budget ran out."""
    real = resolve_inside(root, rel)
    if not real.is_dir():
        raise PathError("not a directory")
    entries: list[dict[str, Any]] = []
    deadline = time.monotonic() + size_budget_s
    with os.scandir(real) as it:
        children = sorted(it, key=lambda e: e.name.lower())
    for e in children[:max_entries]:
        try:
            st = e.stat(follow_symlinks=False)
        except OSError:
            continue
        sub = (Path(rel) / e.name).as_posix().lstrip("./")
        cls, prot = classify(sub)
        row: dict[str, Any] = {
            "name": e.name, "path": sub, "kind": "link" if e.is_symlink() else "dir" if e.is_dir(follow_symlinks=False) else "file",
            "mtime_utc": datetime.fromtimestamp(st.st_mtime, UTC).isoformat(timespec="seconds"), "class": cls, "protected": prot,
            "size": None if e.is_dir(follow_symlinks=False) else st.st_size, "files": None, "partial": False,
        }
        if row["kind"] == "dir":
            left = max(0.05, deadline - time.monotonic())
            r = scan_area(Area("x", Path(e.path), e.name), timeout_s=left, top_n=0, excluded_dirs=[], excluded_patterns=[])
            row["size"], row["files"], row["partial"] = r.bytes, r.files, not r.complete
        entries.append(row)
    return {"path": Path(rel).as_posix().lstrip("./") if rel else "", "entries": entries, "truncated": len(children) > max_entries}
