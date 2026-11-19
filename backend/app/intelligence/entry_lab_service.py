"""Loads the recorded sessions for the Entry Lab and serves its results (no market data is created or changed here).

Each finished session of the nearest expiry is read once from the stored chain samples into a compact in-memory series (index level and the last traded price of the strikes within 400
points of the day's range, per stored minute: a few hundred kilobytes a day) by a background thread, one day at a time, so a small server is never held for long. The results are
computed from whatever days have loaded; the answer says how many are loaded of how many exist.
"""

from __future__ import annotations

import logging
import threading
import time as _time
from collections.abc import Callable, Mapping
from datetime import date, datetime, time
from typing import Any

from app.domain.session import session_close
from app.intelligence.entry_lab import Day, Rule, presets, run
from app.market.index_check import minute_key

logger = logging.getLogger(__name__)
MIN_SAMPLES = 250  # stored in-session minutes for a day to count as a session
STRIKE_MARGIN = 400.0  # points beyond the day's range kept on each side


MIN_BAR_READS = 10  # an index bar made from fewer reads is not used


def compact(day: date, expiry: date, snaps: list[Any], tz: Any, prev_close: float | None = None, bars: Mapping[str, Mapping[str, Any]] | None = None,
            context: Mapping[str, Any] | None = None, events: list[Mapping[str, Any]] | None = None, events_known: bool = False) -> Day | None:  # fmt: skip
    """The stored samples of one session as a ``Day``: only minutes with a level and prices, and only the strikes the index could have reached.

    The index level of a minute is the OPEN of the live index feed's one-minute bar when there is one (a capture is taken within seconds of the minute's start, so the bar's open is the
    index at the same moment as its prices): the chain's stored level was replaced by an option-implied level on the mornings of 18 and 19 Nov 2026 (10 to 66 points off), which would
    have put the wrong strike and the wrong range into the replay. Without a bar the stored level is used."""
    rows = []
    from_bars = 0
    for s in snaps:
        if s.spot is None or s.spot <= 0 or not s.prices:
            continue
        bar = (bars or {}).get(minute_key(s.at))
        level = float(s.spot)
        if bar is not None and isinstance(bar.get("o"), (int, float)) and bar["o"] > 0 and (not isinstance(bar.get("n"), int) or bar["n"] >= MIN_BAR_READS):
            level, from_bars = float(bar["o"]), from_bars + 1
        rows.append((s.at, level, s.prices))
    if len(rows) < MIN_SAMPLES - 50:
        return None
    lo, hi = min(r[1] for r in rows) - STRIKE_MARGIN, max(r[1] for r in rows) + STRIKE_MARGIN
    prices = [{key: float(v) for key, v in p.items() if v is not None and lo <= key[0] <= hi} for _, _, p in rows]
    source = "index feed bars" if from_bars >= 0.9 * len(rows) else "mixed: index bars and stored chain level" if from_bars else "stored chain level"
    return Day(day=day.isoformat(), dte=(expiry - day).days, times=[r[0] for r in rows], spots=[r[1] for r in rows], prices=prices, prev_close=prev_close, spot_source=source,
               context=context, events=events, events_known=events_known)  # fmt: skip


class EntryLabService:
    def __init__(self, days: Callable[[], list[date]], load: Callable[[date], Day | None], today: Callable[[], datetime] = lambda: datetime.now().astimezone()) -> None:
        self._days_fn, self._load_fn, self._now = days, load, today
        self._loaded: dict[str, Day] = {}
        self._failed: dict[str, str] = {}
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ which days exist
    def finished_days(self) -> list[date]:
        """Days with a recorded session that is over (today only after the close)."""
        from app.domain.session import _IST  # the IST zone the schedule uses

        now = self._now().astimezone(_IST)
        out = []
        for d in self._days_fn():
            if d < now.date() or (d == now.date() and now.time() > session_close()):
                out.append(d)
        return sorted(out)

    def status(self) -> dict[str, Any]:
        total = self.finished_days()
        with self._lock:
            loaded = len(self._loaded)
            loading = self._thread is not None and self._thread.is_alive()
            failed = dict(self._failed)
        return {"days_total": len(total), "days_loaded": loaded, "loading": loading, "failed": failed, "first": total[0].isoformat() if total else None, "last": total[-1].isoformat() if total else None}

    # ------------------------------------------------------------------ loading
    def start(self) -> bool:
        """Begin loading the days not yet in memory, one at a time, in a background thread. False when nothing is missing or a load is already running."""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return False
            missing = [d for d in self.finished_days() if d.isoformat() not in self._loaded and d.isoformat() not in self._failed]
            if not missing:
                return False
            self._thread = threading.Thread(target=self._run, args=(missing,), name="entry-lab-load", daemon=True)
            self._thread.start()
            return True

    def _run(self, missing: list[date]) -> None:
        for d in missing:
            _time.sleep(0.2)  # one day at a time, with a breath between them: the live stream shares this server
            try:
                day = self._load_fn(d)
                with self._lock:
                    if day is None:
                        self._failed[d.isoformat()] = "too few stored minutes"
                    else:
                        self._loaded[d.isoformat()] = day
            except Exception as e:  # noqa: BLE001 - one bad day must not stop the others
                logger.warning("entry_lab_day_failed: %s %s", d, e)
                with self._lock:
                    self._failed[d.isoformat()] = f"{type(e).__name__}"

    def days(self) -> list[Day]:
        with self._lock:
            return [self._loaded[k] for k in sorted(self._loaded)]

    # ------------------------------------------------------------------ answers
    def result(self, rule: Rule, with_presets: bool = False) -> dict[str, Any]:
        self.start()
        days = self.days()
        out: dict[str, Any] = {"status": self.status(), "rule": {"label": rule.label(), "entry": f"{rule.entry:%H:%M}", "exit": f"{rule.exit:%H:%M}", "stop_pct": rule.stop_pct, "target_pct": rule.target_pct,
                                                               "roll_pts": rule.roll_pts, "cost": rule.cost, "roll_cost": rule.roll_cost, "max_gap_pct": rule.max_gap_pct,
                                                               "max_range_ratio": rule.max_range_ratio, "max_eff30": rule.max_eff30, "skip_break": rule.skip_break}, **run(rule, days)}  # fmt: skip
        if with_presets:
            out["presets"] = presets(rule, days)
        out["assumptions"] = ["A short ATM straddle (call and put of the strike nearest the index when opened), booked from the stored last traded prices: no bid/ask, no slippage beyond the cost shown, no taxes.",
                              "The day's first minute at or after the entry time opens it; the last stored minute at or before the exit time closes it; a stop or target ends the day (no re-entry).",
                              "Past days, in-sample: a description, not a forecast. The recorded days are few."]  # fmt: skip
        return out


def parse_hm(text: str) -> time:
    h, m = text.split(":")
    return time(int(h), int(m))
