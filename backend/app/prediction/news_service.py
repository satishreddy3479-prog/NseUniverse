"""Collects GDELT daily tone/volume for a few market themes, slowly (GDELT asks for >= 5 s between requests).

Sources not used yet, on purpose: Economic Times RSS (its terms could not be read, so permitted use is
unverified) and official company announcements (NSE's announcement API refuses automated access).
Only headline-level aggregates are stored; no article text.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import threading
import time
import urllib.parse
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

from app.logging_setup import log_event
from app.prediction.news_store import NewsStore
from app.prediction.pit import IST
from app.prediction.sources.nse import Fetched, fetch

logger = logging.getLogger(__name__)
API = "https://api.gdeltproject.org/api/v2/doc/doc"
THEMES: dict[str, tuple[str, str]] = {
    "india_markets": ("Indian markets", '(Nifty OR Sensex OR "Dalal Street" OR "Indian stocks")'),
    "us_fed": ("US Federal Reserve", '("Federal Reserve" OR FOMC OR "Jerome Powell")'),
    "geopolitics": ("Iran and Middle East", '(Iran OR "Strait of Hormuz" OR "Middle East")'),
    "oil": ("Crude oil", '("crude oil" OR "Brent crude" OR OPEC)'),
    "us_politics": ("US elections", '("midterm elections" OR "US election")'),
}
PAUSE_S = 6.0
EVERY = timedelta(hours=12)
Getter = Callable[[str], Fetched]


def _url(query: str, mode: str) -> str:
    return f"{API}?{urllib.parse.urlencode({'query': query, 'mode': mode, 'timespan': '14d', 'format': 'json'})}"


def parse_timeline(body: bytes) -> dict[date, float]:
    doc = json.loads(body)
    out: dict[date, float] = {}
    for series in doc.get("timeline", []):
        for p in series.get("data", []):
            d = datetime.strptime(str(p["date"])[:8], "%Y%m%d").date()
            out[d] = float(p["value"])
    return out


class NewsService:
    def __init__(self, store: NewsStore, *, getter: Getter = fetch, enabled: bool = True, pause_s: float = PAUSE_S, clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self.store, self._get, self.enabled, self._pause, self._clock = store, getter, enabled, pause_s, clock
        self._thread: threading.Thread | None = None
        self._task: asyncio.Task[None] | None = None
        self.last_attempt: datetime | None = None
        self.notes: list[str] = []

    def run(self) -> dict[str, Any]:
        self.last_attempt = self._clock()
        self.notes = []
        saved = 0
        for key, (_, query) in THEMES.items():
            tone: dict[date, float] = {}
            vol: dict[date, float] = {}
            for mode, target in (("timelinetone", tone), ("timelinevol", vol)):
                res = self._get(_url(query, mode))
                time.sleep(self._pause)
                if res.status != 200 or not res.body:
                    self.notes.append(f"{key} {mode}: {res.error or res.status}")
                    continue
                try:
                    target.update(parse_timeline(res.body))
                except (ValueError, KeyError, TypeError) as e:
                    self.notes.append(f"{key} {mode}: unreadable response ({type(e).__name__})")
            days = sorted(set(tone) | set(vol))
            saved += self.store.save(key, [(d, tone.get(d), vol.get(d)) for d in days], now=self._clock())
        log_event(logger, logging.INFO, "news_run", saved=saved, problems=len(self.notes))
        return {"saved": saved, "problems": self.notes}

    def trigger(self) -> bool:
        if self._thread is not None and self._thread.is_alive():
            return False
        self._thread = threading.Thread(target=self.run, daemon=True, name="news")
        self._thread.start()
        return True

    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def due(self, now: datetime | None = None) -> bool:
        return self.last_attempt is None or (now or self._clock()) - self.last_attempt >= EVERY

    async def _loop(self) -> None:
        await asyncio.sleep(60)
        while True:
            try:
                if self.enabled and not self.running() and self.due():
                    self.trigger()
            except Exception:  # noqa: BLE001 - the loop must survive
                logger.exception("news loop error")
            await asyncio.sleep(600)

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled, "running": self.running(), "problems": self.notes, "coverage": self.store.coverage(),
            "themes": {k: v[0] for k, v in THEMES.items()},
            "latest": self.store.latest(7),
            "source": "GDELT DOC 2.0 API (daily average tone and share of coverage); headline aggregates only",
            "not_used": "Economic Times RSS (terms unverified) and NSE announcements (automated access refused)",
            "model_use": "Not used by the models: only recent weeks of history exist, too few to validate",
            "today_ist": str(self._clock().astimezone(IST).date()),
        }  # fmt: skip


_ = Fetched  # re-exported type
