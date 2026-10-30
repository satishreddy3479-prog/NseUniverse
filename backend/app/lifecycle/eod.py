"""End-of-day pipeline: runs after the market closes, never while it is open.

Per completed trading day (oldest first, so a day missed while the PC was off is caught up):
  1. validate the day's samples (counts per expiry, gaps, missing spot, duplicate times)
  2. archive the day's observations to a verified compressed file (the database is not touched)
  3. store a compact research summary per expiry in the append-only intraday ledger
  4. write the session manifest (checksums, counts, status), once the archive is verified
Then, once a day after 19:00 IST (after the evening price and flow downloads): checkpoint the
write-ahead logs, back up every database with verification, and tidy regenerable leftovers.
The daily T+1/T+5 models are retrained by the price-history run (after 18:30 IST) and are not
started here. Failures are reported and retried later; collection is never blocked.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import threading
from collections.abc import Callable
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any

from app.domain.session import session_close
from app.intraday.dataset import FEATURE_VERSION, build_rows
from app.intraday.enrich import Enricher
from app.intraday.features import (
    IST,
    OPEN,
    DailyBar,
    Point,
    Quote,
    daily_context,
    in_session,
    options_features,
    price_features,
)
from app.intraday.store import IntradayStore
from app.lifecycle import storage
from app.lifecycle.archive import archive_day, day_window, verify_archive
from app.lifecycle.backup import backup_databases
from app.logging_setup import log_event
from app.prediction.history_store import HistoryStore
from app.storage.observations import ObservationStore

logger = logging.getLogger(__name__)
VERSION = "eod-1"
RUN_AFTER = time(15, 50)  # the sampler stops at 15:40 (derivatives close); everything is final by 15:50
BACKUP_AFTER = time(19, 0)  # after the 18:30 price run and the 18:45 flow run
COMPLETE_SAMPLES = 300  # in-session samples of one expiry for a day to count as a complete session
RETRY_AFTER = timedelta(minutes=30)


class EodService:
    def __init__(
        self,
        obs: ObservationStore,
        intraday: IntradayStore,
        history: HistoryStore,
        data_dir: Path,
        underlying: str,
        *,
        log_dir: Path | None = None,
        enabled: bool = True,
        keep_daily_backups: int = 7,
        keep_monthly_backups: int = 6,
        backups: bool = True,
        raw_keep_days: int = 0,
        normalized_keep_days: int = 0,
        observation_keep_sessions: int = 0,
        observation_prune_dry_run: bool = True,
        market: Any = None,
        risk_free_rate: float = 0.06,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.market, self.risk_free_rate = market, risk_free_rate  # market: MarketStore (futures, breadth, breakout recordings) or None
        self.obs, self.intraday, self.history = obs, intraday, history
        self.data_dir, self.underlying, self.log_dir = data_dir, underlying, log_dir
        self.enabled, self._clock = enabled, clock
        self.keep_daily, self.keep_monthly = keep_daily_backups, keep_monthly_backups
        self.backups, self.raw_keep, self.norm_keep = backups, raw_keep_days, normalized_keep_days
        self.obs_keep, self.obs_dry_run = observation_keep_sessions, observation_prune_dry_run
        self.last_prune: dict[str, Any] | None = None
        self.last_obs_prune: dict[str, Any] | None = None
        self._pruned_on: date | None = None
        self.manifests = data_dir / "manifests"
        self._lock = threading.Lock()
        self._task: asyncio.Task[None] | None = None
        self.last_attempt: datetime | None = None
        self.last_result: dict[str, Any] = {"state": "not run yet"}
        self.last_backup: dict[str, Any] | None = None
        self.last_tidy: dict[str, int] | None = None

    # ------------------------------------------------------------------ what is due
    def manifest_path(self, day: date) -> Path:
        return self.manifests / f"session={day.isoformat()}.json"

    def manifest(self, day: date) -> dict[str, Any] | None:
        p = self.manifest_path(day)
        try:
            return json.loads(p.read_text("utf-8")) if p.exists() else None
        except (OSError, json.JSONDecodeError):
            return None

    def pending_days(self, now: datetime | None = None) -> list[date]:
        """Days with in-session samples, finished, and without a final manifest (oldest first)."""
        now = now or self._clock()
        t = now.astimezone(IST)
        out = []
        for d in sorted(self.obs.session_sample_counts(self.underlying)):
            day = date.fromisoformat(d)
            finished = day < t.date() or (day == t.date() and t.time() >= RUN_AFTER)
            if finished and self.manifest(day) is None:
                out.append(day)
        return out

    def features_missing_days(self, now: datetime | None = None) -> list[date]:
        """Finished sessions that have a manifest but no rows of the current feature version (older sessions after a version change)."""
        now = now or self._clock()
        t = now.astimezone(IST)
        have = self.intraday.feature_sessions(FEATURE_VERSION)
        out = []
        for d, n in sorted(self.obs.session_sample_counts(self.underlying).items()):
            day = date.fromisoformat(d)
            if n >= 16 and d not in have and (day < t.date() or (day == t.date() and t.time() >= RUN_AFTER)) and self.manifest(day) is not None:
                out.append(day)
        return out

    def due(self, now: datetime | None = None) -> bool:
        now = now or self._clock()
        if not self.enabled:
            return False
        if self.last_attempt and now - self.last_attempt < RETRY_AFTER and self.last_result.get("state") == "error":
            return False
        return bool(self.pending_days(now)) or bool(self.features_missing_days(now)) or self.backup_due(now) or self.prune_due(now)

    def prune_due(self, now: datetime) -> bool:
        t = now.astimezone(IST)
        return (self.raw_keep > 0 or self.norm_keep > 0 or self.obs_keep > 0) and t.time() >= RUN_AFTER and self._pruned_on != t.date()

    def backup_due(self, now: datetime) -> bool:
        t = now.astimezone(IST)
        if not self.backups:
            return False
        return t.time() >= BACKUP_AFTER and not (self.data_dir / "backups" / "daily" / f"{t:%Y%m%d}" / "MANIFEST.json").exists()

    # ------------------------------------------------------------------ one day
    def validate(self, day: date) -> dict[str, Any]:
        start, end = day_window(day)
        per: dict[str, Any] = {}
        for expiry, total in self.obs.day_counts(self.underlying, start, end):
            samples = self.obs.samples(self.underlying, expiry, since=datetime.fromtimestamp(start / 1000, UTC), until=datetime.fromtimestamp((end - 1) / 1000, UTC), limit=5000)
            pts = in_session([Point(s.received_at, s.spot) for s in samples if s.spot is not None and s.spot > 0], day)
            gaps = [(b.at - a.at).total_seconds() / 60 for a, b in zip(pts, pts[1:], strict=False)]
            times = [s.received_at for s in samples]
            per[expiry] = {
                "samples_all_day": total, "samples_in_session": len(pts),
                "missing_or_invalid_spot": sum(1 for s in samples if s.spot is None or s.spot <= 0),
                "duplicate_times": len(times) - len(set(times)),
                "max_gap_min": round(max(gaps), 1) if gaps else None,
                "first": pts[0].at.astimezone(IST).strftime("%H:%M:%S") if pts else None,
                "last": pts[-1].at.astimezone(IST).strftime("%H:%M:%S") if pts else None,
            }  # fmt: skip
        best = max((v["samples_in_session"] for v in per.values()), default=0)
        return {"expiries": per, "best_expiry_samples": best, "status": "complete" if best >= COMPLETE_SAMPLES else "partial" if best else "empty"}

    @staticmethod
    def _chain_rows(chain: dict[tuple[float, int], Quote]) -> list[list[float | int | None]]:
        rows = []
        for k in sorted({s for s, _ in chain}):
            c, p = chain.get((k, 0)), chain.get((k, 1))
            rows.append([
                k,
                c.ltp if c else None, c.oi if c else None, c.oi_prev if c else None, c.volume if c else None,
                p.ltp if p else None, p.oi if p else None, p.oi_prev if p else None, p.volume if p else None,
            ])  # fmt: skip
        return rows

    def summarise(self, day: date, status: str) -> int:
        """One immutable summary row per expiry (price path, options state, scores, regime)."""
        start, end = day_window(day)
        bars = [DailyBar(b.session, b.open, b.high, b.low, b.close) for b in self.history.bars("NIFTY50")[-120:]]
        ctx = daily_context(bars, day)
        stored = 0
        for expiry, _ in self.obs.day_counts(self.underlying, start, end):
            samples = [s for s in self.obs.samples(self.underlying, expiry, since=datetime.fromtimestamp(start / 1000, UTC), until=datetime.fromtimestamp((end - 1) / 1000, UTC), limit=5000)
                       if s.spot is not None and OPEN <= s.received_at.astimezone(IST).time() <= session_close()]  # fmt: skip
            if not samples:
                continue
            pts = [Point(s.received_at, s.spot) for s in samples if s.spot is not None]
            p = price_features(pts, pts[-1].at, ctx, samples[0].prev_close)

            def chain(s: Any) -> dict[tuple[float, int], Quote]:
                return {k: Quote(c.ltp, c.oi, c.oi_prev, c.volume) for k, c in self.obs.contracts(s.values_from).items()}

            first_c, last_c = chain(samples[0]), chain(samples[-1])
            o = options_features(last_c, samples[-1].spot, first_c, samples[0].spot)
            first_o = options_features(first_c, samples[0].spot, None, None)
            scores = self.intraday.session_rows(day.isoformat(), expiry)
            have = [r["score"] for r in scores if r["score"] is not None]
            payload = {
                "price": {k: getattr(p, k) for k in ("first", "last", "prev_close", "change_pct", "gap_pct", "sampled_high", "sampled_low", "or_high", "or_low", "range_pct", "rv_pct", "rv_ratio", "er_session")},
                "options": {"pcr_oi_first": first_o.pcr_oi, "pcr_oi_last": o.pcr_oi, "pcr_vol_last": o.pcr_vol, "straddle_first": first_o.straddle, "straddle_last": o.straddle,
                            "ce_oi_chg": o.ce_oi_chg, "pe_oi_chg": o.pe_oi_chg, "max_ce_oi_strike": o.max_ce_oi_strike, "max_pe_oi_strike": o.max_pe_oi_strike},
                "scores": {"stored": len(scores), "mean": sum(have) / len(have) if have else None, "last_label": scores[-1]["label"] if scores else None, "last_regime": scores[-1]["regime"] if scores else None},
                # the last in-session chain, every listed strike: [strike, ce_ltp, ce_oi, ce_oi_prev, ce_vol, pe_ltp, pe_oi, pe_oi_prev, pe_vol]
                "close_chain": {
                    "at": samples[-1].received_at.isoformat(), "spot": samples[-1].spot,
                    "columns": ["strike", "ce_ltp", "ce_oi", "ce_oi_prev", "ce_vol", "pe_ltp", "pe_oi", "pe_oi_prev", "pe_vol"],
                    "rows": self._chain_rows(last_c),
                },
                "definitions": "samples are the stored ~60 s option-chain fetches; high/low are of the samples, not exchange extremes",
            }  # fmt: skip
            stored += self.intraday.record_summary(day.isoformat(), expiry, VERSION, status, len(samples), payload, now=self._clock())
        return stored

    def build_dataset(self, day: date) -> dict[str, int]:
        """Labelled feature rows of the finished session, one set per expiry (append-only)."""
        start, end = day_window(day)
        bars = [DailyBar(b.session, b.open, b.high, b.low, b.close) for b in self.history.bars("NIFTY50")[-120:]]
        ctx = daily_context(bars, day)
        stored: dict[str, int] = {}
        for expiry, _ in self.obs.day_counts(self.underlying, start, end):
            samples = [s for s in self.obs.samples(self.underlying, expiry, since=datetime.fromtimestamp(start / 1000, UTC), until=datetime.fromtimestamp((end - 1) / 1000, UTC), limit=5000)
                       if s.spot is not None and s.spot > 0 and OPEN <= s.received_at.astimezone(IST).time() <= session_close()]  # fmt: skip
            if len(samples) < 16:
                continue
            pts = [Point(s.received_at, float(s.spot or 0)) for s in samples]

            def chain_at(i: int, _s: Any = samples) -> dict[tuple[float, int], Quote]:
                return {k: Quote(c.ltp, c.oi, c.oi_prev, c.volume) for k, c in self.obs.contracts(_s[i].values_from).items()}

            def prices_at(i: int, _s: Any = samples) -> dict[tuple[float, int], float | None]:
                return {k: c.ltp for k, c in self.obs.contracts(_s[i].values_from).items()}

            mk: dict[str, list[tuple[datetime, dict[str, Any]]]] = {}
            if self.market is not None:
                lo = datetime.fromtimestamp(start / 1000, UTC).isoformat()
                hi = datetime.fromtimestamp(end / 1000, UTC)
                for kind in ("fut", "nifty50", "breakout"):
                    mk[kind] = [(datetime.fromisoformat(a), pl) for a, pl in self.market.samples_since(kind, lo) if datetime.fromisoformat(a) < hi]
            extra = Enricher(pts, date.fromisoformat(expiry), prices_at, mk, self.risk_free_rate)
            rows = build_rows(pts, chain_at, samples[0].prev_close, ctx, date.fromisoformat(expiry), day, extra)
            stored[expiry] = self.intraday.record_features(day.isoformat(), expiry, FEATURE_VERSION, rows)
        return stored

    def process_day(self, day: date) -> dict[str, Any]:
        v = self.validate(day)
        arch = archive_day(self.obs, self.underlying, day, self.data_dir, now=self._clock())
        res: dict[str, Any] = {"day": day.isoformat(), "validation": v, "archive": arch.public(), "summaries_stored": 0, "manifest": False}
        if v["status"] == "empty":
            res["state"] = "skipped: no in-session samples"
            return res
        if not arch.verified:
            res["state"] = f"archive not verified: {arch.problem}"
            return res
        res["summaries_stored"] = self.summarise(day, v["status"])
        res["feature_rows_stored"] = self.build_dataset(day)
        self.manifests.mkdir(parents=True, exist_ok=True)
        doc = {"schema": 1, "version": VERSION, "day": day.isoformat(), "underlying": self.underlying, "status": v["status"], "created_utc": self._clock().isoformat(),
               "validation": v, "archive": arch.public(), "summaries": {"table": "intraday.sqlite3:daily_summaries", "version": VERSION},
               "ml_ready_session": v["status"] == "complete", "feature_version": FEATURE_VERSION, "notes": "the database remains the primary store; the archive is a verified copy"}  # fmt: skip
        tmp = self.manifest_path(day).with_suffix(".json.tmp")
        tmp.write_text(json.dumps(doc, indent=1), "utf-8")
        tmp.replace(self.manifest_path(day))
        res["manifest"], res["state"] = True, v["status"]
        return res

    # ------------------------------------------------------------------ whole run
    def run(self, now: datetime | None = None) -> dict[str, Any]:
        """Process every pending day, then (after 19:00 IST) back up and tidy. Safe to call repeatedly."""
        if not self._lock.acquire(blocking=False):
            return {"state": "already running"}
        try:
            now = now or self._clock()
            self.last_attempt = now
            out: dict[str, Any] = {"state": "ok", "days": [], "at": now.isoformat()}
            for day in self.pending_days(now):
                r = self.process_day(day)
                out["days"].append(r)
                if not r["manifest"] and not r["state"].startswith("skipped"):
                    out["state"] = "error"
            for day in self.features_missing_days(now):  # rebuild older sessions under the current feature version
                out.setdefault("feature_rebuilds", {})[day.isoformat()] = self.build_dataset(day)
            if self.backup_due(now):
                self.obs.checkpoint()
                b = backup_databases(self.data_dir, now.astimezone(IST).date(), keep_daily=self.keep_daily, keep_monthly=self.keep_monthly, now=now)
                self.last_backup = {"day": b.day, "ok": b.ok, "files": len(b.files), "removed": b.removed, "problems": b.problems}
                out["backup"] = self.last_backup
                if not b.ok:
                    out["state"] = "error"
                else:
                    self.last_tidy = storage.tidy(self.data_dir)
                    out["tidy"] = self.last_tidy
            if self.prune_due(now) and out["state"] == "ok":
                self._pruned_on = now.astimezone(IST).date()
                # approved retention: only days with a verified archive, only ids held in the database
                self.last_prune = storage.prune_snapshots(
                    self.data_dir, now.astimezone(IST).date(), self.raw_keep, self.norm_keep,
                    self.archived_days(), self.obs.known_snapshot_ids(), dry_run=False,
                )  # fmt: skip
                out["prune"] = self.last_prune
                if self.obs_keep > 0:  # per-contract rows of old sessions: archive-verified, dry run unless approved
                    self.last_obs_prune = self.obs.plan_contract_pruning(
                        self.obs_keep, self.archived_contracts(), delete=not self.obs_dry_run
                    )
                    out["observation_prune"] = self.last_obs_prune
                    log_event(logger, logging.INFO, "observation_prune", **{k: v for k, v in self.last_obs_prune.items() if k in ("dry_run", "rows", "keep_sessions")})
            self.last_result = out
            log_event(logger, logging.INFO if out["state"] == "ok" else logging.WARNING, "eod_run", state=out["state"], days=len(out["days"]))
            return out
        except Exception as e:  # noqa: BLE001 - reported, retried later, never raised into the loop
            self.last_result = {"state": "error", "error": type(e).__name__}
            log_event(logger, logging.WARNING, "eod_error", error=type(e).__name__)
            return self.last_result
        finally:
            self._lock.release()

    # ------------------------------------------------------------------ views
    def archived_days(self) -> set[str]:
        return set(self.archived_contracts())

    def archived_contracts(self) -> dict[str, int]:
        """Day -> contract rows held, for days whose archive exists and matches its manifest (re-checked)."""
        out: dict[str, int] = {}
        for m in sorted(self.manifests.glob("session=*.json")) if self.manifests.exists() else []:
            try:
                doc = json.loads(m.read_text("utf-8"))
                a = doc["archive"]
                if verify_archive(self.data_dir / a["path"], a["sha256"], a["samples"], a["contracts"]) is None:
                    out[doc["day"]] = int(a["contracts"])
            except (OSError, KeyError, json.JSONDecodeError):
                continue
        return out

    def status(self) -> dict[str, Any]:
        now = self._clock()
        manifests = sorted(self.manifests.glob("session=*.json")) if self.manifests.exists() else []
        complete = 0
        for m in manifests:
            with contextlib.suppress(OSError, json.JSONDecodeError):
                complete += json.loads(m.read_text("utf-8")).get("status") == "complete"
        return {
            "enabled": self.enabled, "runs_after_ist": RUN_AFTER.strftime("%H:%M"), "backup_after_ist": BACKUP_AFTER.strftime("%H:%M"),
            "pending_days": [d.isoformat() for d in self.pending_days(now)], "sessions_archived": len(manifests), "complete_sessions": complete,
            "last_attempt_at": self.last_attempt.isoformat() if self.last_attempt else None, "last_result": self.last_result,
            "last_backup": self.last_backup, "last_tidy": self.last_tidy, "backups_enabled": self.backups,
            "snapshot_retention": {"raw_days": self.raw_keep, "normalized_days": self.norm_keep, "last_run": self.last_prune},
            "observation_retention": {"keep_sessions": self.obs_keep, "dry_run": self.obs_dry_run, "last_run": self.last_obs_prune},
        }  # fmt: skip

    async def _loop(self) -> None:
        await asyncio.sleep(60)
        while True:
            try:
                if self.due():
                    await asyncio.to_thread(self.run)
            except Exception:  # noqa: BLE001 - the scheduler must survive
                self.last_result = {"state": "error", "error": "scheduler"}
            await asyncio.sleep(120)

    def start(self) -> None:
        if self._task is None and self.enabled:
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
