"""One-off, idempotent import of already-stored snapshots into the observation store.

Only real stored captures are read; nothing is created. Run at start-up; repeats do nothing.
"""

from __future__ import annotations

import logging

from app.logging_setup import log_event
from app.storage.observations import ObservationStore, fingerprint
from app.storage.store import SnapshotStore, StorageError

logger = logging.getLogger(__name__)


def backfill_observations(store: SnapshotStore, obs: ObservationStore, underlying: str) -> int:
    known = obs.known_snapshot_ids()
    todo = [
        s
        for s in store.list(underlying=underlying, limit=1_000_000)
        if s.snapshot_id not in known and s.completeness.value != "empty"
    ]
    todo.sort(key=lambda s: s.retrieved_at)  # list() is newest first
    last: dict[str, str] = {}
    added = 0
    for s in todo:
        try:
            snap = store.load(s.snapshot_id)
        except StorageError:
            continue
        if snap is None:
            continue
        fp = fingerprint(snap)
        key = snap.expiry.isoformat()
        if last.get(key) == fp:
            # identical to the previous stored capture of this expiry: record the time only
            obs.record_snapshot(snap, unchanged=True, source="backfill")
        else:
            obs.record_snapshot(snap, unchanged=False, source="backfill")
        last[key] = fp
        added += 1
    if added:
        log_event(logger, logging.INFO, "observations_backfilled", samples=added)
    return added
