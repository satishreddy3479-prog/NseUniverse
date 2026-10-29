"""Verified, compressed daily archive of the option-chain observations.

One file per IST day: ``archive/observations/year=YYYY/month=MM/date=YYYY-MM-DD.jsonl.gz``. Each line is
a JSON object: a header, then every ``sample`` followed by its ``c`` (contract) rows exactly as stored
(prices in paise, missing = null). The archive is a verified copy: the database stays the primary
store and nothing is removed from it. Files are written to a temporary name, fsynced and renamed, then
read back and compared with the database before they count as archived.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from app.storage.observations import ObservationStore, to_ms

IST = ZoneInfo("Asia/Kolkata")
SCHEMA = 1


@dataclass(frozen=True)
class ArchiveResult:
    path: str  # relative to the data directory
    sha256: str
    bytes: int
    samples: int
    contracts: int
    verified: bool
    problem: str | None = None

    def public(self) -> dict[str, object]:
        return asdict(self)


def day_window(day: date) -> tuple[int, int]:
    """[start, end) of an IST calendar day in epoch milliseconds."""
    a = datetime.combine(day, time(0, 0), IST)
    return to_ms(a), to_ms(a + timedelta(days=1))


def archive_path(data_dir: Path, day: date) -> Path:
    return data_dir / "archive" / "observations" / f"year={day:%Y}" / f"month={day:%m}" / f"date={day.isoformat()}.jsonl.gz"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_counts(path: Path) -> tuple[int, int]:
    """(samples, contracts) found in an archive. Raises on a damaged file."""
    n_s = n_c = 0
    with gzip.open(path, "rt", encoding="utf-8") as f:
        first = json.loads(f.readline())
        if first.get("t") != "header" or first.get("schema") != SCHEMA:
            raise ValueError("unknown archive header")
        for line in f:
            t = json.loads(line)["t"]
            if t == "sample":
                n_s += 1
            elif t == "c":
                n_c += 1
            else:
                raise ValueError(f"unknown record type {t!r}")
    return n_s, n_c


def verify_archive(path: Path, expect_sha: str, expect_samples: int, expect_contracts: int) -> str | None:
    """None when the archive is intact and equals what the database holds, else the problem."""
    if not path.exists():
        return "archive file is missing"
    try:
        if _sha256(path) != expect_sha:
            return "checksum differs from the manifest"
        got = read_counts(path)
    except (OSError, ValueError, EOFError, json.JSONDecodeError, gzip.BadGzipFile) as e:
        return f"archive cannot be read: {type(e).__name__}"
    if got != (expect_samples, expect_contracts):
        return f"archive holds {got[0]} samples / {got[1]} contract rows, expected {expect_samples} / {expect_contracts}"
    return None


def archive_day(obs: ObservationStore, underlying: str, day: date, data_dir: Path, now: datetime | None = None) -> ArchiveResult:
    """Write (or re-verify) the archive of one IST day. Never overwrites an existing archive."""
    start, end = day_window(day)
    want_s, want_c = obs.window_counts(underlying, start, end)
    final = archive_path(data_dir, day)
    rel = final.relative_to(data_dir).as_posix()
    if final.exists():
        sha = _sha256(final)
        try:
            n_s, n_c = read_counts(final)
        except (OSError, ValueError, EOFError, json.JSONDecodeError, gzip.BadGzipFile) as e:
            return ArchiveResult(rel, sha, final.stat().st_size, 0, 0, False, f"existing archive unreadable: {type(e).__name__}")
        # the database may have grown since (late samples); a smaller archive is reported, not replaced
        ok = (n_s, n_c) == (want_s, want_c)
        return ArchiveResult(rel, sha, final.stat().st_size, n_s, n_c, ok, None if ok else f"existing archive has {n_s}/{n_c} rows, database has {want_s}/{want_c}")
    if want_s == 0:
        return ArchiveResult(rel, "", 0, 0, 0, False, "no samples on this day")
    final.parent.mkdir(parents=True, exist_ok=True)
    tmp = final.with_name(final.name + ".tmp")
    n_s = n_c = 0
    with tmp.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0) as gz:
        head = {"t": "header", "schema": SCHEMA, "day": day.isoformat(), "underlying": underlying, "tz": "Asia/Kolkata", "created_utc": (now or datetime.now(UTC)).isoformat(), "units": "prices in paise; OI and volume in units; null = missing"}
        gz.write((json.dumps(head, separators=(",", ":")) + "\n").encode())
        for rec in obs.export_rows(underlying, start, end):
            n_s += rec["t"] == "sample"
            n_c += rec["t"] == "c"
            gz.write((json.dumps(rec, separators=(",", ":")) + "\n").encode())
        gz.close()
        raw.flush()
        os.fsync(raw.fileno())
    sha = _sha256(tmp)
    problem = verify_archive(tmp, sha, n_s, n_c)
    if problem is None and (n_s, n_c) != obs.window_counts(underlying, start, end):
        # samples arrived while writing (a late sample after midnight): keep what was written, flag it
        problem = "database changed while the archive was being written"
    if problem is not None:
        tmp.unlink(missing_ok=True)
        return ArchiveResult(rel, sha, 0, n_s, n_c, False, problem)
    os.replace(tmp, final)
    return ArchiveResult(rel, sha, final.stat().st_size, n_s, n_c, True)
