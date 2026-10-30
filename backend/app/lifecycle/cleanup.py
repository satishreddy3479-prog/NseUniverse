"""The data clean-up view: what the server stores, what today holds, and exactly what could be removed.

Everything here is measured from the real files and databases. ``overview`` changes nothing. ``run`` removes only the
categories the caller names, only data the verified daily archive already holds (or that can be regenerated), and
only after the same checks the nightly job uses. Immutable stores (forecasts, intraday scores and feature rows,
daily bars, flows, news, strategies' history) and the archive itself are never offered for removal.
"""

from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from app.lifecycle import storage
from app.storage.observations import ObservationStore, to_ms

IST = ZoneInfo("Asia/Kolkata")

#: file -> (name, what it holds, why it is kept)
STORES: dict[str, tuple[str, str, str]] = {
    "observations.sqlite3": ("Option-chain observations", "One row per sample (time, spot) and one per contract per changed sample (price, OI, volume); feeds every chart.", "Kept forever; per-contract rows of old sessions can go once the archive holds them."),
    "index.sqlite3": ("Snapshot index", "Which snapshot files exist and their summary.", "Kept forever (small)."),
    "intraday.sqlite3": ("Intraday ML data", "Sentiment scores every minute, feature rows with labels (the training data), daily summaries.", "Immutable and kept forever: this is what the intraday model trains and is tested on."),
    "forecasts.sqlite3": ("Forecast ledger", "Every T+1 / T+5 forecast, written before the outcome and never edited.", "Immutable; the forward-test evidence."),
    "market_history.sqlite3": ("Daily prices", "Daily bars of NIFTY and the other instruments used by the prediction models.", "Append-only; kept forever."),
    "nse_flows.sqlite3": ("Institutional flows", "NSE participant open interest and FII/DII cash files.", "Kept; small."),
    "market.sqlite3": ("Breadth and futures recordings", "Minute aggregates of breadth, sectors and futures flow.", "Append-only; about 1 MB a day."),
    "news.sqlite3": ("News and events", "Collected headlines and the event calendar.", "Append-only; kept."),
    "strategies.sqlite3": ("Strategies", "Saved and closed strategies with every revision.", "Kept; deleting a strategy only hides it."),
}


def _counts(path: Path) -> dict[str, int]:
    out: dict[str, int] = {}
    try:
        c = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, timeout=5)
        try:
            for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
                out[t] = int(c.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0])  # noqa: S608 - table names come from sqlite_master
        finally:
            c.close()
    except sqlite3.Error:
        pass
    return out


def _dir_bytes(p: Path) -> tuple[int, int]:
    n = b = 0
    if p.exists():
        for f in p.rglob("*"):
            if f.is_file():
                n += 1
                b += f.stat().st_size
    return n, b


def plan_tidy(data_dir: Path, now: float) -> dict[str, int]:
    """What ``storage.tidy`` would remove (read-only)."""
    files = size = 0
    cutoff = now - storage.EXPORT_KEEP_DAYS * 86400
    exports = data_dir / "exports"
    if exports.exists():
        for f in exports.rglob("*"):
            if f.is_file() and f.stat().st_mtime < cutoff:
                files += 1
                size += f.stat().st_size
    for f in data_dir.rglob("*.tmp"):
        if f.is_file() and f.stat().st_mtime < now - 3600:
            files += 1
            size += f.stat().st_size
    return {"files": files, "bytes": size}


def overview(*, data_dir: Path, log_dir: Path | None, today: date, obs: ObservationStore, intraday: Any, eod: Any,
             raw_keep: int, norm_keep: int, obs_keep: int, underlying: str, now: float) -> dict[str, Any]:
    rep = storage.report(data_dir, log_dir, today, archived_days=eod.archived_days())
    archived = eod.archived_contracts()
    # stores
    stores = []
    for fname, (label, holds, keep) in STORES.items():
        files = list(data_dir.glob(fname + "*"))
        if not files:
            continue
        size = sum(f.stat().st_size for f in files)
        stores.append({"file": fname, "name": label, "holds": holds, "keep": keep, "bytes": size, "tables": _counts(data_dir / fname)})
    snap_n, snap_b = _dir_bytes(data_dir / "snapshots")
    arch_n, arch_b = _dir_bytes(data_dir / "archive")
    bk_n, bk_b = _dir_bytes(data_dir / "backups")
    files_part = [
        {"name": "Snapshot files", "holds": "Every raw broker response and normalized snapshot, gzip files per day.", "keep": "Raw removed after the raw days, normalized after the normalized days, once the day's archive is verified.", "files": snap_n, "bytes": snap_b},
        {"name": "Daily archive", "holds": "One verified compressed file per session: the day's samples and contract rows.", "keep": "Kept forever; this is why older raw data can go.", "files": arch_n, "bytes": arch_b},
        {"name": "Backups", "holds": "Dated copies of every database.", "keep": "7 daily and 6 monthly; older ones removed by the backup job.", "files": bk_n, "bytes": bk_b},
    ]
    # today
    start = datetime.combine(today, datetime.min.time(), IST)
    day = obs.day_summary(to_ms(start), to_ms(start + timedelta(days=1)) - 1)
    total_rows = day["contract_rows_total"]
    obs_bytes = next((s["bytes"] for s in stores if s["file"] == "observations.sqlite3"), 0)
    per_row = obs_bytes / total_rows if total_rows else 0.0
    snaps_today = storage.snapshot_days(data_dir).get(today.isoformat(), (0, 0))
    today_info = {
        "date": today.isoformat(), "samples": sum(e["samples"] for e in day["expiries"]), "expiries": day["expiries"],
        "contract_rows": day["contract_rows"], "contract_bytes_estimate": round(day["contract_rows"] * per_row),
        "snapshot_files": snaps_today[0], "snapshot_bytes": snaps_today[1],
        "intraday": intraday.day_counts(today.isoformat()),
        "note": "Today's data stays until the end-of-day job has archived and verified it. The intraday model trains on its feature rows, which are never deleted.",
    }
    # candidates (all measured, none executed)
    raw = storage.prune_snapshots(data_dir, today, raw_keep, 0, set(archived), obs.known_snapshot_ids(), dry_run=True) if raw_keep > 0 else None
    norm = storage.prune_snapshots(data_dir, today, 0, norm_keep, set(archived), obs.known_snapshot_ids(), dry_run=True) if norm_keep > 0 else None
    rows_plan = obs.plan_contract_pruning(obs_keep, archived, delete=False) if obs_keep > 0 else None
    tidy = plan_tidy(data_dir, now)
    candidates = [
        {"id": "raw_snapshots", "label": f"Raw broker responses older than {raw_keep} days", "files": raw["raw_files"] if raw else 0, "bytes": raw["raw_bytes"] if raw else 0,
         "why_safe": "The day's verified archive already holds the same samples; the observation database keeps the values.", "blocked": (raw or {}).get("kept_not_archived", 0), "enabled": raw_keep > 0},
        {"id": "normalized_snapshots", "label": f"Normalized snapshot files older than {norm_keep} days", "files": norm["normalized_files"] if norm else 0, "bytes": norm["normalized_bytes"] if norm else 0,
         "why_safe": "Same as above: archived and still in the observation database.", "blocked": (norm or {}).get("kept_not_archived", 0), "enabled": norm_keep > 0},
        {"id": "contract_rows", "label": f"Per-contract rows older than the last {obs_keep} sessions", "files": 0, "rows": rows_plan["rows"] if rows_plan else 0,
         "bytes": round((rows_plan["rows"] if rows_plan else 0) * per_row), "days": rows_plan["days"] if rows_plan else [],
         "why_safe": "Only days whose verified archive holds at least as many rows. Sample times and spot stay, so history still draws.", "blocked": len(rows_plan["blocked"]) if rows_plan else 0, "blocked_detail": rows_plan["blocked"] if rows_plan else [], "enabled": obs_keep > 0},
        {"id": "regenerable", "label": f"Exports older than {storage.EXPORT_KEEP_DAYS} days and stray temporary files", "files": tidy["files"], "bytes": tidy["bytes"],
         "why_safe": "They can be created again.", "blocked": 0, "enabled": True},
    ]
    never = [
        {"name": "Intraday feature rows, labels, scores and summaries", "why": "The training and testing data of the intraday model; immutable."},
        {"name": "Forecast ledger", "why": "Forward-test evidence; immutable."},
        {"name": "Daily archive and manifests", "why": "The verified copy that makes the removals above safe."},
        {"name": "Daily prices, flows, news, strategies", "why": "Small, append-only and not regenerable."},
        {"name": "Today's data", "why": "Not archived yet."},
    ]
    return {
        "disk": rep["disk"], "pressure": rep["pressure"], "data_bytes": rep["data_dir_bytes"], "logs_bytes": rep["logs_bytes"],
        "growth_bytes_per_day": rep["growth_bytes_per_day"], "runway_days": rep["runway_days"],
        "stores": stores, "files": files_part, "today": today_info, "candidates": candidates,
        "removable_bytes": sum(c["bytes"] for c in candidates), "never_deleted": never,
        "policy": {"raw_days": raw_keep, "normalized_days": norm_keep, "contract_row_sessions": obs_keep},
        "last_runs": {"snapshots": eod.last_prune, "contract_rows": eod.last_obs_prune, "tidy": eod.last_tidy},
    }


def run(items: list[str], *, data_dir: Path, today: date, obs: ObservationStore, eod: Any,
        raw_keep: int, norm_keep: int, obs_keep: int, now: float) -> dict[str, Any]:
    """Remove the named categories (see ``overview`` for what each holds). Unknown names are refused."""
    known = {"raw_snapshots", "normalized_snapshots", "contract_rows", "regenerable"}
    bad = [i for i in items if i not in known]
    if bad:
        raise ValueError(f"unknown clean-up item: {', '.join(bad)}")
    archived = eod.archived_contracts()
    out: dict[str, Any] = {}
    ids = obs.known_snapshot_ids()
    if "raw_snapshots" in items and raw_keep > 0:
        out["raw_snapshots"] = storage.prune_snapshots(data_dir, today, raw_keep, 0, set(archived), ids, dry_run=False)
    if "normalized_snapshots" in items and norm_keep > 0:
        out["normalized_snapshots"] = storage.prune_snapshots(data_dir, today, 0, norm_keep, set(archived), ids, dry_run=False)
    if "contract_rows" in items and obs_keep > 0:
        out["contract_rows"] = obs.plan_contract_pruning(obs_keep, archived, delete=True)
    if "regenerable" in items:
        out["regenerable"] = storage.tidy(data_dir, now)
    return out
