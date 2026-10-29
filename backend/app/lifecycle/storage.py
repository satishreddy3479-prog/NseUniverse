"""Storage report, growth/runway estimate and the (dry-run) pruning plan.

Categories, what each holds and how it may be changed are documented in docs/storage-plan.md. This
module only measures and plans. It deletes exactly two kinds of regenerable files (see ``tidy``):
old files under ``exports/`` and ``*.tmp`` leftovers. Everything else, in particular snapshot files,
is only reported.
"""

from __future__ import annotations

import shutil
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

EXPORT_KEEP_DAYS = 14

#: name -> (glob relative to data dir, class, rule)
CATEGORIES: dict[str, tuple[tuple[str, ...], str, str]] = {
    "observations": (("observations.sqlite3*",), "core", "kept forever; checkpointed nightly, never pruned"),
    "snapshots": (("snapshots/**/*",), "core", "kept; pruning needs the owner's approval (planned below, never executed here)"),
    "snapshot index": (("index.sqlite3*",), "core", "kept forever"),
    "daily prices": (("market_history.sqlite3*",), "core", "kept forever (append-only)"),
    "institutional flows": (("nse_flows.sqlite3*",), "core", "rolling 7-session windows by approved policy"),
    "forecast ledger": (("forecasts.sqlite3*",), "core", "immutable; kept forever"),
    "news": (("news.sqlite3*",), "core", "kept forever (append-only)"),
    "intraday scores and summaries": (("intraday.sqlite3*",), "core", "immutable; kept forever"),
    "prediction cache": (("prediction_report.json",), "cache", "recomputed after every new bar"),
    "archive": (("archive/**/*",), "verified copy", "kept; one verified file per session"),
    "manifests": (("manifests/**/*",), "core", "kept forever"),
    "backups": (("backups/**/*",), "backup", "7 daily + 6 monthly; older removed after a verified newer backup"),
    "exports": (("exports/**/*",), "regenerable", f"removed after {EXPORT_KEEP_DAYS} days"),
}


def _size(data_dir: Path, patterns: tuple[str, ...]) -> tuple[int, int]:
    n = total = 0
    for pat in patterns:
        for f in data_dir.glob(pat):
            if f.is_file():
                n += 1
                total += f.stat().st_size
    return n, total


def pressure(free: int, total: int) -> str:
    """ok / watch / low / critical from free space, as a share of the disk and in absolute terms
    (a 15 GB server is 'low' at 2.3 GB free; the sampler itself pauses at 2 GB)."""
    share = free / total if total else 0.0
    if free < 2e9 or share < 0.08:
        return "critical"
    if share < 0.15:
        return "low"
    if share < 0.30:
        return "watch"
    return "ok"


def snapshot_days(data_dir: Path) -> dict[str, tuple[int, int]]:
    """Snapshot folder (one per IST day) -> (files, bytes)."""
    out: dict[str, tuple[int, int]] = {}
    root = data_dir / "snapshots"
    if root.exists():
        for d in sorted(p for p in root.iterdir() if p.is_dir()):
            files = [f for f in d.iterdir() if f.is_file()]
            out[d.name] = (len(files), sum(f.stat().st_size for f in files))
    return out


@dataclass
class PrunePlan:
    older_than_days: int
    eligible_days: list[str]
    files: int
    bytes: int
    blocked: list[dict[str, str]]


def plan_snapshot_pruning(data_dir: Path, today: date, older_than_days: int, archived_days: set[str]) -> PrunePlan:
    """What pruning would remove if the owner approved it: whole snapshot day folders older than the
    limit whose observations are archived and verified. Nothing is deleted by this function."""
    days = snapshot_days(data_dir)
    eligible, blocked, files, size = [], [], 0, 0
    for d, (n, b) in days.items():
        try:
            age = (today - date.fromisoformat(d)).days
        except ValueError:
            continue
        if age <= older_than_days:
            continue
        if d in archived_days:
            eligible.append(d)
            files += n
            size += b
        else:
            blocked.append({"day": d, "reason": "no verified archive for this day yet"})
    return PrunePlan(older_than_days, eligible, files, size, blocked)


def _is_raw(name: str) -> bool:
    return name.endswith(".raw.json.gz") or name.endswith(".raw.json")


def _snapshot_id(name: str) -> str:
    for suf in (".raw.json.gz", ".raw.json", ".json.gz", ".json"):
        if name.endswith(suf):
            return name[: -len(suf)]
    return name


def prune_snapshots(
    data_dir: Path, today: date, raw_keep_days: int, normalized_keep_days: int,
    archived_days: set[str], known_ids: set[str], dry_run: bool = True,
) -> dict[str, Any]:
    """Apply the owner-approved retention to snapshot files (0 = keep forever).

    A file is removed only if ALL hold: its day is older than the limit for its kind, the day has a
    verified archive and manifest, and its snapshot id is in the observation database (whose rows the
    archive holds). Today's and later days are never touched. Index rows stay, so the app reports the
    snapshot as no longer available instead of failing.
    """
    out: dict[str, Any] = {"dry_run": dry_run, "raw_files": 0, "raw_bytes": 0, "normalized_files": 0, "normalized_bytes": 0, "kept_not_archived": 0, "kept_not_in_database": 0}
    root = data_dir / "snapshots"
    if not root.exists() or (raw_keep_days <= 0 and normalized_keep_days <= 0):
        return out
    for dayDir in sorted(p for p in root.iterdir() if p.is_dir()):
        try:
            age = (today - date.fromisoformat(dayDir.name)).days
        except ValueError:
            continue
        for f in sorted(dayDir.iterdir()):
            if not f.is_file():
                continue
            raw = _is_raw(f.name)
            limit = raw_keep_days if raw else normalized_keep_days
            if limit <= 0 or age <= limit:
                continue
            if dayDir.name not in archived_days:
                out["kept_not_archived"] += 1
                continue
            if _snapshot_id(f.name) not in known_ids:
                out["kept_not_in_database"] += 1
                continue
            kind = "raw" if raw else "normalized"
            out[f"{kind}_files"] += 1
            out[f"{kind}_bytes"] += f.stat().st_size
            if not dry_run:
                f.unlink()
        if not dry_run and not any(dayDir.iterdir()):
            dayDir.rmdir()
    return out


def tidy(data_dir: Path, now: float | None = None) -> dict[str, int]:
    """Remove regenerable leftovers: old files under exports/ and stray *.tmp files. Nothing else."""
    now = now or time.time()
    removed = freed = 0
    cutoff = now - EXPORT_KEEP_DAYS * 86400
    exports = data_dir / "exports"
    if exports.exists():
        for f in sorted(exports.rglob("*"), reverse=True):
            if f.is_file() and f.stat().st_mtime < cutoff:
                freed += f.stat().st_size
                f.unlink()
                removed += 1
            elif f.is_dir() and not any(f.iterdir()):
                f.rmdir()
    for f in data_dir.rglob("*.tmp"):
        if f.is_file() and f.stat().st_mtime < now - 3600:  # an hour old: no writer is still using it
            freed += f.stat().st_size
            f.unlink()
            removed += 1
    return {"files_removed": removed, "bytes_freed": freed}


def report(data_dir: Path, log_dir: Path | None, today: date, prune_days: int = 30, archived_days: set[str] | None = None) -> dict[str, Any]:
    cats: list[dict[str, Any]] = []
    total = 0
    for name, (pats, cls, rule) in CATEGORIES.items():
        n, b = _size(data_dir, pats)
        total += b
        cats.append({"name": name, "class": cls, "files": n, "bytes": b, "rule": rule})
    days = snapshot_days(data_dir)
    recent = [b for _, (_, b) in list(days.items())[-5:] if b > 0]
    snap_per_day = sum(recent) / len(recent) if recent else 0.0
    obs_bytes = next(c["bytes"] for c in cats if c["name"] == "observations")
    obs_per_day = obs_bytes / max(1, len(days))
    growth = snap_per_day + obs_per_day
    usage = shutil.disk_usage(data_dir)
    plan = plan_snapshot_pruning(data_dir, today, prune_days, archived_days or set())
    logs = 0
    if log_dir is not None and log_dir.exists():
        logs = sum(f.stat().st_size for f in log_dir.rglob("*") if f.is_file())
    return {
        "data_dir_bytes": total, "logs_bytes": logs, "categories": cats,
        "disk": {"free_bytes": usage.free, "total_bytes": usage.total, "free_gb": round(usage.free / 1e9, 1)},
        "growth_bytes_per_day": round(growth),
        "runway_days": round(usage.free / growth) if growth > 0 else None,
        "growth_note": "snapshot files (average of the last 5 days) + observation database (all days) per day; an estimate",
        "pressure": pressure(usage.free, usage.total),
        "snapshot_pruning_plan": {
            "executed": False, "approved": False, "older_than_days": plan.older_than_days,
            "eligible_days": len(plan.eligible_days), "files": plan.files, "bytes": plan.bytes, "blocked": plan.blocked[:10],
        },
    }
