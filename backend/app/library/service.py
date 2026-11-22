"""The data library: every 30 days of snapshot files is zipped into one verified bundle, the owner is told in the heads-up strip, and after the download is confirmed by checksum
the server deletes the bundle and those days' snapshot files. It repeats forever. Temporary restores and the coverage check for backtests live here too.

The rule, in full:
  * Snapshot files (raw and normalized) stay as ordinary files. The oldest day that is in no bundle starts a block of ``block_days`` calendar days (30).
  * When the block is over, one bundle of its days is made by itself (after the close), verified, and announced in the heads-up strip until it is downloaded.
  * The download is confirmed by SHA-256 (the page, or ``scripts/pull-backups.ps1``). Then, and only then, the bundle's snapshot files and the bundle itself are deleted from the
    server. The archive, the manifests and the observation database stay forever: they hold everything research and backtests read.
  * Never deleted without a confirmed download: a bundle, or the snapshot files of its days. The one exception protects the server: when free space falls under the floor the
    snapshot files of a bundle that exists on the server are removed (nothing is lost, the bundle holds them) and the bundle stays until it is downloaded.
"""

from __future__ import annotations

import contextlib
import shutil
import threading
import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from app.library.bundles import (
    BundleError,
    BundleInfo,
    build_bundle,
    read_manifest,
    restore_bundle,
    sha256_file,
)
from app.library.store import LibraryStore
from app.lifecycle import storage

IST = ZoneInfo("Asia/Kolkata")
COMPLETE_SAMPLES = 300  # in-session samples of one expiry for a day to count as a complete session (same as the end-of-day run)


class LibraryError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


class LibraryService:
    def __init__(
        self, data_dir: Path, obs: Any, underlying: str, *, block_days: int = 30, restore_ttl_hours: int = 24, restore_max_bytes: int = 1 << 30,
        min_free_bytes: int = 6 * 10**9, enabled: bool = True, clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:  # fmt: skip
        self.data_dir, self.obs, self.underlying, self.enabled, self._clock = data_dir, obs, underlying, enabled, clock
        self.block_days, self.restore_ttl = max(1, block_days), timedelta(hours=restore_ttl_hours)
        self.restore_max, self.min_free = restore_max_bytes, min_free_bytes
        self.bundles_dir, self.restore_dir = data_dir / "bundles", data_dir / "restore"
        self.store = LibraryStore(data_dir / "library.sqlite3")
        self._lock = threading.Lock()  # one build or restore at a time: the server has 1 GB of memory and one disk
        self.last_auto: dict[str, Any] = {"state": "not run yet"}

    # ------------------------------------------------------------------ helpers
    def now(self) -> datetime:
        return self._clock()

    def today(self) -> date:
        return self.now().astimezone(IST).date()

    def free_bytes(self) -> int:
        return shutil.disk_usage(self.data_dir).free

    def _bundle_path(self, b: dict[str, Any]) -> Path:
        return self.bundles_dir / str(b["name"])

    def _bundle_ok(self, b: dict[str, Any]) -> bool:
        p = self._bundle_path(b)
        try:
            return p.is_file() and p.stat().st_size == b["bytes"]
        except OSError:
            return False

    def bundled_days(self) -> set[str]:
        """Days inside a bundle which exists on the server with its recorded size."""
        out: set[str] = set()
        for b in self.store.bundles():
            if self._bundle_ok(b):
                out.update(b["days"])
        return out

    def exported_days(self) -> set[str]:
        """Days inside a bundle that was downloaded and confirmed by checksum: a copy exists off the server (the bundle itself may be gone from the server by now)."""
        out: set[str] = set()
        for b in self.store.bundles(include_removed=True):
            if b["confirmed_utc"]:
                out.update(b["days"])
        return out

    # ------------------------------------------------------------------ the 30-day block
    def next_block(self, today: date | None = None) -> dict[str, Any] | None:
        """The block now filling up: it starts at the oldest snapshot day that is in no bundle and covers ``block_days`` calendar days; it is ready the day after it ends."""
        today = today or self.today()
        taken = self.bundled_days() | self.exported_days()
        loose = [d for d in sorted(storage.snapshot_days(self.data_dir)) if d not in taken]
        if not loose:
            return None
        start = date.fromisoformat(loose[0])
        end = start + timedelta(days=self.block_days - 1)
        days = [d for d in loose if d <= end.isoformat()]
        return {"start": start.isoformat(), "end": end.isoformat(), "ready_on": (end + timedelta(days=1)).isoformat(), "ready": today > end, "days": len(days), "days_left": max(0, (end - today).days + 1)}

    def _register(self, info: BundleInfo, origin: str) -> int:
        return self.store.add_bundle(info.name, info.days, self.now().isoformat(), info.bytes, info.sha256, info.files, origin)

    def rescan(self) -> int:
        """Register bundles found on disk that the database does not know (it can be lost without losing a bundle)."""
        known = {b["name"] for b in self.store.bundles(include_removed=True)}
        n = 0
        if self.bundles_dir.is_dir():
            for p in sorted(self.bundles_dir.glob("nse-universe-bundle-*.zip")):
                if p.name in known:
                    continue
                try:
                    m = read_manifest(p)
                    self.store.add_bundle(p.name, list(m["days"]), str(m.get("created_utc", self.now().isoformat())), p.stat().st_size, sha256_file(p), int(m["files"]), "found")
                    n += 1
                except (BundleError, KeyError, OSError):
                    continue
        return n

    def build(self, start: date, end: date, *, origin: str = "manual") -> dict[str, Any]:
        """Bundle every day of [start, end] that still has files on the server."""
        if end < start or (end - start).days > 400:
            raise LibraryError("bad_range", "the range must run forward and cover at most 400 days")
        loose = storage.snapshot_days(self.data_dir)
        have = [start + timedelta(days=i) for i in range((end - start).days + 1) if (start + timedelta(days=i)).isoformat() in loose]
        if not have:
            raise LibraryError("nothing_to_bundle", "no snapshot files remain on the server for these days")
        need = sum(loose[d.isoformat()][1] for d in have)
        if self.free_bytes() - int(need * 1.2) < self.min_free:
            raise LibraryError("low_disk", f"building this bundle would leave less than {self.min_free / 1e9:.0f} GB free")
        if not self._lock.acquire(blocking=False):
            raise LibraryError("busy", "another bundle or restore is running; try again in a minute")
        try:
            try:
                info = build_bundle(self.data_dir, self.bundles_dir, have, now=self.now())
            except BundleError as e:
                raise LibraryError("build_failed", str(e)) from e
            bid = self._register(info, origin)
        finally:
            self._lock.release()
        return self.describe_bundle(bid)

    def auto_run(self) -> dict[str, Any]:
        """The automatic step, called after every close: expire restores, bundle a finished block, and protect the disk. Safe to call any number of times."""
        if not self.enabled:
            return {"state": "disabled"}
        out: dict[str, Any] = {"state": "ok", "at": self.now().isoformat()}
        try:
            out["found"] = self.rescan()
            out["restores_removed"] = self.cleanup_restores()
            out["released"] = self.release_confirmed()
            blk = self.next_block()
            out["block"] = blk
            if blk and blk["ready"]:
                b = self.build(date.fromisoformat(blk["start"]), date.fromisoformat(blk["end"]), origin="auto")
                out["built"] = {"name": b["name"], "days": len(b["days"]), "bytes": b["bytes"]}
            out["emergency"] = self.protect_disk()
        except LibraryError as e:
            out["state"] = f"skipped: {e.message}"
        except Exception as e:  # noqa: BLE001 - reported, retried tomorrow, never raised into the end-of-day run
            out["state"] = f"error: {type(e).__name__}"
        self.last_auto = out
        return out

    # ------------------------------------------------------------------ the download and what follows it
    def _delete_snapshot_files(self, b: dict[str, Any]) -> tuple[int, int]:
        """Delete the snapshot files that are inside the bundle (not the archive, not the manifests): only a file whose size matches the bundle's record and whose day
        has its session manifest (the verified archive). Returns (files, bytes)."""
        files = size = 0
        try:
            manifest = read_manifest(self._bundle_path(b))
        except BundleError:
            return 0, 0
        days: set[str] = set()
        for m in manifest["members"]:
            if not str(m["path"]).startswith("snapshots/"):
                continue
            f = self.data_dir / m["path"]
            day_ok = (self.data_dir / "manifests" / f"session={m['day']}.json").is_file()
            if day_ok and f.is_file() and f.stat().st_size == m["bytes"]:
                size += m["bytes"]
                files += 1
                f.unlink()
            days.add(str(m["day"]))
        for d in days:
            folder = self.data_dir / "snapshots" / d
            with contextlib.suppress(OSError):
                if folder.is_dir() and not any(folder.iterdir()):
                    folder.rmdir()
        return files, size

    def confirm(self, bid: int, sha256: str) -> dict[str, Any]:
        """The copy was downloaded and its checksum matches: record it, delete the bundle's snapshot files from the server, then the bundle itself."""
        b = self.store.bundle(bid)
        if b is None or b["removed_utc"]:
            raise LibraryError("not_found", "no such bundle")
        if sha256.strip().lower() != b["sha256"]:
            raise LibraryError("checksum_mismatch", "the downloaded file does not match the bundle on the server: the download is damaged, download it again")
        self.store.confirm_bundle(bid, self.now().isoformat())
        files, size = self._delete_snapshot_files(b)
        self._bundle_path(b).unlink(missing_ok=True)
        self.store.mark_bundle_removed(bid, self.now().isoformat())
        return {**(self.store.bundle(bid) or b), "downloaded": True, "on_server": False, "released_files": files, "released_bytes": size}

    def release_confirmed(self) -> int:
        """A bundle that was confirmed (downloaded) but is still on the server, for example confirmed before this rule existed: delete its snapshot files and the bundle now."""
        n = 0
        for b in self.store.bundles():
            if b["confirmed_utc"]:
                self._delete_snapshot_files(b)
                self._bundle_path(b).unlink(missing_ok=True)
                self.store.mark_bundle_removed(b["id"], self.now().isoformat())
                n += 1
        return n

    def protect_disk(self) -> dict[str, Any]:
        """Under the free-space floor, free the oldest bundled days: their snapshot files go (the bundle on the server holds them, so nothing is lost) and the bundle stays until it
        is downloaded. Returns what was done."""
        done: dict[str, Any] = {"files": 0, "bytes": 0}
        if self.free_bytes() >= self.min_free:
            return done
        for b in sorted(self.store.bundles(), key=lambda x: x["start_day"]):
            if self.free_bytes() >= self.min_free + 10**9:
                break
            if b["confirmed_utc"] or not self._bundle_ok(b):
                continue
            f, s = self._delete_snapshot_files(b)
            done["files"] += f
            done["bytes"] += s
        return done

    def delete_bundle(self, bid: int) -> dict[str, Any]:
        b = self.store.bundle(bid)
        if b is None or b["removed_utc"]:
            raise LibraryError("not_found", "no such bundle")
        if not b["confirmed_utc"]:
            raise LibraryError("not_downloaded", "this bundle has not been downloaded and confirmed: it may be the only copy of these days, so it is kept")
        self._bundle_path(b).unlink(missing_ok=True)
        self.store.mark_bundle_removed(bid, self.now().isoformat())
        return {"removed": b["name"]}

    def describe_bundle(self, bid: int) -> dict[str, Any]:
        b = self.store.bundle(bid)
        if b is None:
            raise LibraryError("not_found", "no such bundle")
        return {**b, "on_server": self._bundle_ok(b), "downloaded": bool(b["confirmed_utc"])}

    def bundle_file(self, bid: int) -> tuple[Path, dict[str, Any]]:
        b = self.store.bundle(bid)
        if b is None or b["removed_utc"] or not self._bundle_ok(b):
            raise LibraryError("not_found", "this bundle is not on the server")
        return self._bundle_path(b), b

    # ------------------------------------------------------------------ the heads-up strip
    def notices(self) -> list[dict[str, Any]]:
        """Heads-up lines: every bundle waiting to be downloaded (it returns every week until it is), and a warning when the disk is getting full. No notice when all is done."""
        if not self.enabled:
            return []
        out: list[dict[str, Any]] = []
        week = f"{self.today():%G-W%V}"
        low = self.free_bytes() < self.min_free + 3 * 10**9
        for b in self.store.bundles():
            if b["confirmed_utc"] or not self._bundle_ok(b):
                continue
            mbytes = b["bytes"] / 1e6
            out.append({
                "key": f"library|ready|{b['name']}|{week}", "source": "library", "kind": "bundle_ready", "level": "bad" if low else "warn", "title": "Data bundle ready: download it",
                "text": f"{b['start_day']} to {b['end_day']}, {len(b['days'])} days, {mbytes:.0f} MB. Download it on the Data page (Data library): the server then deletes it and those days' snapshot files, and keeps the archive and the database."
                        + (" The disk is getting full." if low else ""),
                "at": b["created_utc"], "link": "/data",
            })  # fmt: skip
        return out

    # ------------------------------------------------------------------ restores
    def _inside_restore_dir(self, p: Path) -> bool:
        return self.restore_dir.resolve() in p.resolve().parents

    def restore(self, zip_path: Path, bundle_name: str) -> dict[str, Any]:
        """Verify the bundle, check the disk, unpack it into a scratch folder that expires by itself."""
        try:
            manifest = read_manifest(zip_path)
        except BundleError as e:
            raise LibraryError("bad_bundle", str(e)) from e
        size = int(manifest.get("bytes", 0))
        if size > self.restore_max:
            raise LibraryError("too_big", f"the bundle holds {size / 1e6:.0f} MB; a restore is limited to {self.restore_max / 1e6:.0f} MB")
        if self.free_bytes() - int(size * 1.2) < self.min_free:
            raise LibraryError("low_disk", f"unpacking {size / 1e6:.0f} MB would leave less than {self.min_free / 1e9:.0f} GB free")
        if not self._lock.acquire(blocking=False):
            raise LibraryError("busy", "another bundle or restore is running; try again in a minute")
        dest = self.restore_dir / f"r-{self.now():%Y%m%d%H%M%S}-{uuid.uuid4().hex[:6]}"
        try:
            try:
                restore_bundle(zip_path, dest, max_bytes=self.restore_max)
            except BundleError as e:
                shutil.rmtree(dest, ignore_errors=True)
                raise LibraryError("bad_bundle", str(e)) from e
            rid = self.store.add_restore(bundle_name, str(dest), list(manifest["days"]), size, self.now().isoformat(), (self.now() + self.restore_ttl).isoformat())
        finally:
            self._lock.release()
        return self.describe_restore(rid)

    def restore_from_server(self, bid: int) -> dict[str, Any]:
        path, b = self.bundle_file(bid)
        return self.restore(path, b["name"])

    def describe_restore(self, rid: int) -> dict[str, Any]:
        r = self.store.restore(rid)
        if r is None:
            raise LibraryError("not_found", "no such restore")
        return r

    def remove_restore(self, rid: int, reason: str = "removed by the owner") -> None:
        r = self.store.restore(rid)
        if r is None or r["removed_utc"]:
            raise LibraryError("not_found", "no such restore")
        p = Path(r["dir"])
        if self._inside_restore_dir(p):
            shutil.rmtree(p, ignore_errors=True)
        self.store.mark_restore_removed(rid, self.now().isoformat(), reason)

    def keep_restore(self, rid: int, days: int = 7) -> dict[str, Any]:
        r = self.store.restore(rid)
        if r is None or r["removed_utc"]:
            raise LibraryError("not_found", "no such restore")
        self.store.extend_restore(rid, (self.now() + timedelta(days=days)).isoformat())
        return self.describe_restore(rid)

    def cleanup_restores(self) -> int:
        n = 0
        for r in self.store.restores():
            if datetime.fromisoformat(r["expires_utc"]) <= self.now():
                with contextlib.suppress(LibraryError):
                    self.remove_restore(r["id"], "expired")
                    n += 1
        return n

    def ensure_day(self, day: str) -> Path | None:
        """The folder of a restore that holds ``day``, restoring the bundle that holds it first when none is active: a snapshot file that moved into a bundle comes back by
        itself the first time something asks for it, and goes again when the restore expires. None when no bundle on the server holds the day, the restore would pass the size
        limit for restores in all, the disk is too full, or another bundle job is running (the caller then reports the file as removed, as before)."""
        now = self.now()
        for r in self.store.restores():
            if day in r["days"] and datetime.fromisoformat(r["expires_utc"]) > now and Path(r["dir"]).is_dir():
                return Path(r["dir"])
        for b in self.store.bundles():
            if day in b["days"] and self._bundle_ok(b):
                if sum(r["bytes"] for r in self.store.restores()) + b["bytes"] > self.restore_max:
                    return None
                try:
                    return Path(self.restore(self._bundle_path(b), b["name"])["dir"])
                except LibraryError:
                    return None
        return None

    def fallback_roots(self) -> list[Path]:
        """Folders of the active restores: where a missing snapshot file is looked for before it is reported as removed."""
        now = self.now()
        out = []
        for r in self.store.restores():
            if datetime.fromisoformat(r["expires_utc"]) > now and Path(r["dir"]).is_dir():
                out.append(Path(r["dir"]))
        return out

    # ------------------------------------------------------------------ what exists, and the coverage check
    def _sessions(self) -> dict[str, int]:
        try:
            return dict(self.obs.session_sample_counts(self.underlying))
        except Exception:  # noqa: BLE001 - a listing must not fail on a damaged index
            return {}

    def inventory(self, limit: int = 400) -> list[dict[str, Any]]:
        counts, snaps = self._sessions(), storage.snapshot_days(self.data_dir)
        manifests = {p.stem.removeprefix("session=") for p in (self.data_dir / "manifests").glob("session=*.json")} if (self.data_dir / "manifests").is_dir() else set()
        bundled = {}
        for b in self.store.bundles():
            for d in b["days"]:
                bundled[d] = {"id": b["id"], "name": b["name"], "downloaded": bool(b["confirmed_utc"]), "on_server": self._bundle_ok(b)}
        exported = self.exported_days()
        restored: set[str] = set()
        for r in self.store.restores():
            restored.update(r["days"])
        rows = []
        for d in sorted(set(counts) | set(snaps) | set(bundled) | manifests | exported, reverse=True)[:limit]:
            n_files, n_bytes = snaps.get(d, (0, 0))
            state = "on the server" if n_files else "in a bundle" if d in bundled else "downloaded, removed from the server" if d in exported else "archive only" if d in manifests else "no files"
            rows.append({
                "day": d, "samples": counts.get(d), "complete": (counts.get(d) or 0) >= COMPLETE_SAMPLES, "archive": d in manifests, "snapshot_files": n_files, "snapshot_bytes": n_bytes,
                "bundle": bundled.get(d), "exported": d in exported, "restored": d in restored, "state": state,
            })  # fmt: skip
        return rows

    def coverage(self, days: list[str]) -> dict[str, Any]:
        """Is the data a backtest reads there? Observation rows (all the research data) per day, and where the snapshot files of each day are."""
        counts, snaps = self._sessions(), storage.snapshot_days(self.data_dir)
        bundled = self.bundled_days()
        restored: set[str] = set()
        for r in self.store.restores():
            restored.update(r["days"])
        missing_obs = [d for d in days if (counts.get(d) or 0) < COMPLETE_SAMPLES]
        files_missing = [d for d in days if d not in snaps and d not in restored]
        restorable = [d for d in files_missing if d in bundled]
        return {
            "days": len(days), "observations_ok": len(days) - len(missing_obs), "observations_missing": missing_obs, "snapshot_files_missing": files_missing, "restorable_from_bundle": restorable,
            "ok": not missing_obs,
            "message": ("all sessions have their observation rows" if not missing_obs else f"{len(missing_obs)} of {len(days)} sessions have fewer than {COMPLETE_SAMPLES} stored samples: "
                        "the result would rest on partial days") + ("" if not restorable else f"; snapshot files of {len(restorable)} days can be restored from a bundle"),
        }  # fmt: skip

    def status(self) -> dict[str, Any]:
        bundles = [self.describe_bundle(b["id"]) for b in self.store.bundles()]
        usage = shutil.disk_usage(self.data_dir)
        return {
            "enabled": self.enabled, "bundles": bundles, "restores": self.store.restores(), "sessions": self.inventory(),
            "policy": {"block_days": self.block_days, "restore_ttl_hours": int(self.restore_ttl.total_seconds() // 3600), "restore_max_mb": self.restore_max // 10**6, "min_free_gb": self.min_free / 1e9},
            "next_block": self.next_block(), "last_auto": self.last_auto, "disk_free_gb": round(usage.free / 1e9, 1),
            "unconfirmed_bundles": sum(1 for b in bundles if not b["downloaded"]),
            "note": "Every 30 days of snapshot files is zipped by itself and announced in the heads-up strip. Download the bundle: the server then deletes it and those days' snapshot files.",
        }  # fmt: skip
