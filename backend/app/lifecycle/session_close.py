"""Follow the exchange for the close of the regular session.

Since 3 Aug 2026 NIFTY futures and options trade until 15:40 (Closing Auction Session alignment). When NSE removes
that, the close returns to 15:30. Nothing here guesses the date: the broker relays the exchange's own market-status
messages, and the first "closed" message of the F&O segment after 15:20 IST is the close the exchange actually used
that day. The close in force follows what the exchange showed on the last two sessions in a row, so one odd day
(a feed delay) changes nothing, and the clock and every chart switch together without a code change.
``MARKET_CLOSE=15:30`` (or 15:40) fixes it by hand and ``auto`` (default) follows the feed.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.domain.session import (
    DEFAULT_CLOSE,
    KNOWN_CLOSES,
    session_close,
    session_source,
    set_session_close,
)
from app.logging_setup import log_event
from app.storage.observations import ObservationStore

IST = ZoneInfo("Asia/Kolkata")
logger = logging.getLogger(__name__)
WINDOW = (time(15, 20), time(16, 0))  # a "closed" message outside this window is the morning, a holiday or the evening
SNAP_MINUTES = 3  # a message within 3 minutes of a known close counts as that close (feed latency)
LOOKBACK_DAYS = 21


def _minutes(t: time) -> float:
    return t.hour * 60 + t.minute + t.second / 60


def snap(at: time) -> time | None:
    """The known close this message time belongs to, or None when it is near neither."""
    for k in KNOWN_CLOSES:
        if abs(_minutes(at) - _minutes(k)) <= SNAP_MINUTES:
            return k
    return None


def observed_closes(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Per IST day, the first F&O "closed" message inside the closing window. Oldest day first."""
    first: dict[str, datetime] = {}
    for e in events:  # oldest first
        d = str(e["detail"])
        if not d.startswith("nse_fo: closed"):
            continue
        t = e["at"].astimezone(IST)
        if t.weekday() >= 5 or not WINDOW[0] <= t.time() <= WINDOW[1]:
            continue
        first.setdefault(t.date().isoformat(), t)
    out = []
    for day, t in sorted(first.items()):
        s = snap(t.time())
        out.append({"day": day, "closed_at": t.strftime("%H:%M:%S"), "close": s.strftime("%H:%M") if s else None})
    return out


def decide(observed: list[dict[str, Any]], configured: str, current: time = DEFAULT_CLOSE) -> dict[str, Any]:
    """The close to use, why, and whether the exchange is showing something different from what is in force."""
    if configured != "auto":
        try:
            h, m = configured.split(":")
            fixed = time(int(h), int(m))
        except ValueError:
            fixed = None
        if fixed is not None:
            return {"close": fixed, "source": f"set by hand (MARKET_CLOSE={configured})", "pending": None}
    usable = [o for o in observed if o["close"]]
    last2 = usable[-2:]
    latest = usable[-1]["close"] if usable else None
    if len(last2) == 2 and last2[0]["close"] == last2[1]["close"]:
        h, m = last2[1]["close"].split(":")
        c = time(int(h), int(m))
        return {"close": c, "source": f"the exchange feed closed at {last2[1]['close']} on {last2[0]['day']} and {last2[1]['day']}", "pending": None}
    pending = None
    if latest is not None and latest != current.strftime("%H:%M"):
        pending = {"close": latest, "day": usable[-1]["day"],
                   "note": f"the exchange closed at {latest} on {usable[-1]['day']}; the close changes after a second session with the same time"}
    return {"close": current, "source": session_source() if current != DEFAULT_CLOSE else f"default {DEFAULT_CLOSE:%H:%M} (Closing Auction Session alignment); no two matching sessions seen yet",
            "pending": pending}


class SessionCloseTracker:
    """Re-reads the feed's market-status history and applies the close. Runs at start and every 30 minutes."""

    def __init__(self, obs: ObservationStore, configured: str = "auto", interval_s: float = 1800.0) -> None:
        self.obs, self.configured, self.interval_s = obs, configured, interval_s
        self.info: dict[str, Any] = {}
        self._task: asyncio.Task[None] | None = None
        self.refresh()

    def refresh(self) -> dict[str, Any]:
        try:
            since = datetime.now(UTC) - timedelta(days=LOOKBACK_DAYS)
            observed = observed_closes(self.obs.events_of("market_status", since))
            d = decide(observed, self.configured, session_close())
            before = session_close()
            set_session_close(d["close"], d["source"])
            if d["close"] != before:
                log_event(logger, logging.WARNING, "session_close_changed", old=f"{before:%H:%M}", new=f"{d['close']:%H:%M}", why=d["source"])
            self.info = {"observed": observed[-10:], "pending": d["pending"], "configured": self.configured}
        except Exception as e:  # noqa: BLE001 - the close in force stays as it was
            logger.warning("session_close_refresh_failed: %s", e)
        return self.info

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self.interval_s)
            await asyncio.to_thread(self.refresh)

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
