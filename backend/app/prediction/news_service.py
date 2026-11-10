"""Collects GDELT daily tone/volume for a few market themes, slowly (GDELT asks for >= 5 s between requests).

Sources not used yet, on purpose: Economic Times RSS (its terms could not be read, so permitted use is
unverified) and official company announcements (NSE's announcement API refuses automated access).
Only headline-level aggregates are stored; no article text.

Two collections, both from GDELT's public DOC API (the source the user approved, metadata only):
* daily tone and share of coverage per theme, every 12 hours (GDELT publishes these as daily values, so they are at best yesterday's complete day);
* the newest headlines per theme (title, link, site, time seen), every hour, so the page shows what is being reported now and when it was fetched.
Both schedules read the time of the last stored fetch, so a restart of the program does not reset them.
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
HEADLINES_EVERY = timedelta(hours=1)
HEADLINES_PER_THEME = 10
Getter = Callable[[str], Fetched]


def _url(query: str, mode: str) -> str:
    return f"{API}?{urllib.parse.urlencode({'query': query, 'mode': mode, 'timespan': '14d', 'format': 'json'})}"


def _headline_url(query: str) -> str:
    q = f"{query} sourcelang:english"
    return f"{API}?{urllib.parse.urlencode({'query': q, 'mode': 'artlist', 'maxrecords': HEADLINES_PER_THEME, 'sort': 'datedesc', 'timespan': '24h', 'format': 'json'})}"


def parse_articles(body: bytes) -> list[tuple[str, str, str | None, str]]:
    """(url, title, domain, seen time as UTC ISO) for each usable article; anything without an http(s) link or a title is dropped."""
    doc = json.loads(body)
    out: list[tuple[str, str, str | None, str]] = []
    for a in doc.get("articles", []):
        url, title = str(a.get("url") or ""), " ".join(str(a.get("title") or "").split())
        if not url.startswith(("http://", "https://")) or not title:
            continue
        try:
            seen = datetime.strptime(str(a["seendate"]), "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC).isoformat()
        except (KeyError, ValueError):
            continue
        out.append((url, title[:300], a.get("domain") or None, seen))
    return out


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
        self.last_headline_attempt: datetime | None = None
        self.notes: list[str] = []
        self.headline_notes: list[str] = []

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
                if res.status == 429:  # GDELT asks for spacing between requests: wait once, then try once more
                    time.sleep(self._pause * 3)
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

    def run_headlines(self) -> dict[str, Any]:
        """The newest headlines of every theme (one request each, spaced). A theme that fails is reported and does not stop the others."""
        self.last_headline_attempt = self._clock()
        problems: list[str] = []
        saved = 0
        for key, (_, query) in THEMES.items():
            res = self._get(_headline_url(query))
            time.sleep(self._pause)
            if res.status == 429:
                time.sleep(self._pause * 3)
                res = self._get(_headline_url(query))
                time.sleep(self._pause)
            if res.status != 200 or not res.body:
                problems.append(f"{key} headlines: {res.error or res.status}")
                continue
            try:
                saved += self.store.save_headlines(key, parse_articles(res.body), now=self._clock())
            except (ValueError, KeyError, TypeError) as e:
                problems.append(f"{key} headlines: unreadable response ({type(e).__name__})")
        self.headline_notes = problems
        log_event(logger, logging.INFO, "news_headlines_run", saved=saved, problems=len(problems))
        return {"saved": saved, "problems": problems}

    def _run_all(self) -> None:
        self.run()
        self.run_headlines()

    def trigger(self) -> bool:
        if self._thread is not None and self._thread.is_alive():
            return False
        self._thread = threading.Thread(target=self._run_all, daemon=True, name="news")
        self._thread.start()
        return True

    def trigger_headlines(self) -> bool:
        if self._thread is not None and self._thread.is_alive():
            return False
        self._thread = threading.Thread(target=self.run_headlines, daemon=True, name="news-headlines")
        self._thread.start()
        return True

    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @staticmethod
    def _parse(iso: str | None) -> datetime | None:
        try:
            return None if not iso else datetime.fromisoformat(iso)
        except ValueError:
            return None

    def _last(self, memory: datetime | None, stored: str | None) -> datetime | None:
        """The later of this process's last attempt and the last fetch on disk: a restart empties the first, not the second."""
        vals = [v for v in (memory, self._parse(stored)) if v is not None]
        return max(vals) if vals else None

    def due(self, now: datetime | None = None) -> bool:
        last = self._last(self.last_attempt, self.store.coverage().get("last_fetch"))
        return last is None or (now or self._clock()) - last >= EVERY

    def headlines_due(self, now: datetime | None = None) -> bool:
        last = self._last(self.last_headline_attempt, self.store.last_headline_fetch())
        return last is None or (now or self._clock()) - last >= HEADLINES_EVERY

    async def _loop(self) -> None:
        await asyncio.sleep(60)
        while True:
            try:
                if self.enabled and not self.running():
                    if self.due():
                        self.trigger()
                    elif self.headlines_due():
                        self.trigger_headlines()
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
            "headlines": self.store.headlines(5), "headlines_fetched": self.store.last_headline_fetch(), "headline_problems": self.headline_notes,
            "headline_source": "GDELT DOC 2.0 article list (title, link, site and time seen only; English-language sources; no article text)",
            "source": "GDELT DOC 2.0 API (daily average tone and share of coverage); headline aggregates only",
            "not_used": "Economic Times RSS (terms unverified) and NSE announcements (automated access refused)",
            "model_use": "Not used by the models: only recent weeks of history exist, too few to validate",
            "today_ist": str(self._clock().astimezone(IST).date()),
        }  # fmt: skip


_ = Fetched  # re-exported type
