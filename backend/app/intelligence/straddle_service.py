"""Reads stored option-chain samples and serves the straddle decay analysis (separate from the sentiment fusion; nothing is written)."""

from __future__ import annotations

import threading
import time as _time
from collections.abc import Callable
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.intelligence import fusion as fz
from app.intelligence import straddle
from app.storage.observations import to_ms

IST = ZoneInfo("Asia/Kolkata")
MAX_POINTS = 240
CACHE_S = 20.0


class StraddleDecay:
    def __init__(self, *, observations: Any, underlying: str, gex: Callable[[str], Any] | None, rate: float, enabled: bool = True,
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:  # fmt: skip
        self.obs, self.underlying, self._gex, self.rate, self.enabled, self._clock = observations, underlying, gex, rate, enabled, clock
        self._cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ stored sessions
    def _expiries(self, day: date) -> list[str]:
        lo, hi = datetime.combine(day, time(9, 0), IST), datetime.combine(day, time(16, 0), IST)
        return [e for e, _ in self.obs.day_counts(self.underlying, to_ms(lo), to_ms(hi))]

    def latest(self) -> tuple[date, str] | None:
        """Newest day (within nine) with samples and its nearest expiry, as the dashboard's default."""
        today = self._clock().astimezone(IST).date()
        for back in range(9):
            day = today - timedelta(days=back)
            ex = self._expiries(day)
            if ex:
                return day, ex[0]
        return None

    def _read(self, expiry: str, day: date, max_points: int | None = MAX_POINTS) -> tuple[list[straddle.Snap], list[tuple[datetime, float | None]]]:
        lo, hi = datetime.combine(day, time(9, 15), IST), datetime.combine(day, time(15, 40), IST)
        samples = [s for s in self.obs.samples(self.underlying, expiry, since=lo, until=hi) if s.spot is not None]
        spots = [(s.received_at, s.spot) for s in samples]
        stride = 1 if not max_points else max(1, -(-len(samples) // max_points))
        use = samples[::stride]
        if samples and use[-1].sample_id != samples[-1].sample_id:
            use.append(samples[-1])
        cache: dict[int, Any] = {}
        snaps: list[straddle.Snap] = []
        for s in use:
            if s.values_from not in cache:
                cache[s.values_from] = self.obs.contracts(s.values_from)
            c = cache[s.values_from]
            snaps.append(straddle.Snap(s.received_at, s.spot, {k: (q.ltp if q.ltp is not None and q.ltp > 0 else None) for k, q in c.items()}, {k: q.oi for k, q in c.items()}))
        return snaps, spots

    # ------------------------------------------------------------------ views
    def summary(self, expiry: str | None = None, session: str | None = None) -> dict[str, Any]:
        pick = self.latest()
        day = date.fromisoformat(session) if session else (pick[0] if pick else None)
        if day is None:
            return {"status": "unavailable", "message": "No option-chain samples are stored yet.", "interpretation": []}
        if expiry is None:
            ex = self._expiries(day)
            expiry = ex[0] if ex else None
        if expiry is None:
            return {"status": "unavailable", "message": f"No samples are stored for {day.isoformat()}.", "interpretation": [], "session": day.isoformat()}
        key = (expiry, day.isoformat())
        with self._lock:
            hit = self._cache.get(key)
            if hit is not None and _time.monotonic() - hit[0] < CACHE_S:
                return hit[1]
            now = self._clock()
            snaps, spots = self._read(expiry, day)
            gex = None
            live = day == now.astimezone(IST).date()
            if self._gex is not None and live:
                try:
                    gex = fz.gex_state({"gex": self._gex(expiry)})
                except Exception:  # noqa: BLE001 - structure is optional context
                    gex = None
            out = straddle.analyse(snaps, spots, date.fromisoformat(expiry), rate=self.rate, now=now, gex=gex, live=live)
            out |= {"session": day.isoformat(), "expiry": expiry, "generated_at": now.isoformat(timespec="seconds")}
            self._cache[key] = (_time.monotonic(), out)
            return out

    def validation(self, sessions: int = 20, minutes: int = 30) -> dict[str, Any]:
        """Window-by-window comparison over stored sessions, oldest first (read-only)."""
        now = self._clock().astimezone(IST)
        out: list[dict[str, Any]] = []
        for back in range(120):
            if len(out) >= sessions:
                break
            day = now.date() - timedelta(days=back)
            ex = self._expiries(day)
            if not ex or (back == 0 and now.time() < time(15, 40)):
                continue  # today's session is still running: not yet a chronological history
            snaps, _ = self._read(ex[0], day, None)
            out.append({"session": day.isoformat(), "expiry": ex[0], "windows": straddle.window_pairs(snaps, date.fromisoformat(ex[0]), minutes, self.rate)})
        out.reverse()
        return {"generated_at": self._clock().isoformat(timespec="seconds"), "window_minutes": minutes, **straddle.validate(out)}
