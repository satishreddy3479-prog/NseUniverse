"""The global markets service: polls Yahoo for quotes, the public RSS feeds for news and the calendar sources, stores what it gets, and builds the views the API serves.

Nothing here is invented: a failed poll is recorded and shown (the data stays as it was, flagged stale by its age), and a symbol with no bar has no quote.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time as _time
from collections.abc import Callable
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from app.globalmkts import calendar_feed, news
from app.globalmkts.quotes import Bar, Downloader, bars_from_frame, build_quote, yahoo_download
from app.globalmkts.store import GlobalStore, ms
from app.globalmkts.symbols import BY_KEY, GROUPS, SYMBOLS, GSymbol
from app.prediction.events import REFERENCE

logger = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")
QUOTE_FAST_S, QUOTE_SLOW_S, QUOTE_RETRY_S = 60.0, 300.0, 120.0
NEWS_S, NEWS_FAST_S, CAL_S, CAL_RETRY_S = 600.0, 120.0, 6 * 3600.0, 1800.0  # news: every 2 minutes in Indian market hours, every 10 otherwise
FULL_REFRESH_S = 6 * 3600.0
BQ_S = 900.0
NSE_WINDOW = (time(9, 0), time(15, 45))  # IST: polled every minute then, every five minutes otherwise
SPARK_POINTS = 48
Fetch = Callable[[str], bytes]
CondFetch = Callable[[str, news.Validators | None], tuple[bytes | None, news.Validators]]


def _spark(points: list[tuple[int, float]]) -> list[float]:
    if len(points) <= SPARK_POINTS:
        return [p for _, p in points]
    step = len(points) / SPARK_POINTS
    out = [points[int(i * step)][1] for i in range(SPARK_POINTS - 1)]
    out.append(points[-1][1])
    return out


class GlobalService:
    def __init__(
        self,
        store: GlobalStore,
        *,
        enabled: bool = True,
        downloader: Downloader = yahoo_download,
        fetch: Fetch = news.http_get,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        symbols: list[GSymbol] | None = None,
        official_path: Path = REFERENCE,
    ) -> None:
        self.store, self.enabled, self._download, self._fetch, self._clock = store, enabled, downloader, fetch, clock
        self.symbols = symbols if symbols is not None else list(SYMBOLS)
        self.official_path = official_path
        self._cond: CondFetch = news.http_get_cond if fetch is news.http_get else (lambda url, _v: (fetch(url), {}))  # a fake fetch (tests) has no validators
        self._validators: dict[str, news.Validators] = {}
        self._task: asyncio.Task[None] | None = None
        self._local_mtime: float | None = None
        self._full_at: float | None = None  # monotonic time of the last five-day download

    # ------------------------------------------------------------------ polls (blocking: run them in a thread)
    def poll_quotes(self) -> dict[str, Any]:
        t0 = _time.perf_counter()
        now = self._clock()
        # five days of bars on the first poll and every six hours (they reach the session before the latest one even over a weekend), today's only otherwise
        full = self._full_at is None or _time.monotonic() - self._full_at > FULL_REFRESH_S
        try:
            frame = self._download([s.yahoo for s in self.symbols], "5d" if full else "1d")
            if full:
                self._full_at = _time.monotonic()
        except Exception as e:  # noqa: BLE001 - a failed download is recorded, the old quotes stay (flagged stale by their age)
            failure = {"error": f"{type(e).__name__}: {str(e)[:160]}"}
            self.store.add_run("quotes", now, False, failure)
            return {"ok": False, **failure}
        ok, missing, new_bars = 0, [], 0
        for spec in self.symbols:
            fresh = bars_from_frame(frame, spec.yahoo)
            older = [Bar(datetime.fromtimestamp(t / 1000, UTC), p) for t, p in self.store.bars_before(spec.key, ms(fresh[0].ts))] if fresh else []
            q = build_quote(spec, fresh, now, older)
            if q is None:
                missing.append(spec.key)
                continue
            new_bars += self.store.save_quote(q, now)
            ok += 1
        detail: dict[str, Any] = {"symbols": ok, "missing": missing, "new_bars": new_bars, "ms": round((_time.perf_counter() - t0) * 1000)}
        self.store.add_run("quotes", now, ok > 0, detail)
        return {"ok": ok > 0, **detail}

    def poll_news(self) -> dict[str, Any]:
        now = self._clock()
        results: dict[str, Any] = {}
        added = 0
        for feed in news.FEEDS:
            label = f"{feed.source} · {feed.section}"
            try:
                data, valid = self._cond(feed.url, self._validators.get(feed.url))
                if data is None:
                    results[label] = {"unchanged": True}
                    continue
                items, skipped = news.parse_rss(data, feed)
                self._validators[feed.url] = valid
                added += self.store.add_news(items, now)
                results[label] = {"items": len(items), "skipped": skipped}
            except Exception as e:  # noqa: BLE001 - one feed failing must not stop the others
                results[label] = {"error": f"{type(e).__name__}: {str(e)[:120]}"}
        ok = any("error" not in r for r in results.values())
        self.store.add_run("news", now, ok, {"added": added, "feeds": results})
        return {"ok": ok, "added": added, "feeds": results}

    def poll_calendar(self, include_feed: bool = True) -> dict[str, Any]:
        now = self._clock()
        out: dict[str, Any] = {}
        try:
            out["official"] = self.store.upsert_events(calendar_feed.official_events(self.official_path), now)
            self.store.add_run("calendar_official", now, True, out["official"])
        except Exception as e:  # noqa: BLE001
            out["official"] = {"error": f"{type(e).__name__}: {str(e)[:120]}"}
            self.store.add_run("calendar_official", now, False, out["official"])
        if include_feed:
            out["biquote"] = self.poll_biquote()
            res: dict[str, Any] = {"new": 0, "changed": 0, "same": 0}
            errors: list[str] = []
            for url in calendar_feed.FF_URLS:
                try:
                    r = self.store.upsert_events(calendar_feed.parse_ff(self._fetch(url)), now)
                    for k in ("new", "changed", "same"):
                        res[k] += r[k]
                except Exception as e:  # noqa: BLE001 - the feed rate-limits or is down: recorded, the stored events stay
                    errors.append(f"{url.rsplit('/', 1)[-1]}: {type(e).__name__} {str(e)[:80]}")
            ok = len(errors) < len(calendar_feed.FF_URLS)
            out["feed"] = res | ({"errors": errors} if errors else {})
            self.store.add_run("calendar_feed", now, ok, out["feed"])
        return out

    def poll_biquote(self) -> dict[str, Any]:
        """India and US events with forecasts and actuals from the biquote calendar: one small request, repeated every 15 minutes because actuals appear through the day."""
        now = self._clock()
        try:
            res: dict[str, Any] = dict(self.store.upsert_events(calendar_feed.parse_biquote(self._fetch(calendar_feed.bq_url(now))), now))
            self.store.add_run("calendar_biquote", now, True, res)
        except Exception as e:  # noqa: BLE001 - recorded; the stored events stay
            res = {"error": f"{type(e).__name__}: {str(e)[:120]}"}
            self.store.add_run("calendar_biquote", now, False, res)
        return res

    def poll_local_calendar(self, force: bool = False) -> dict[str, Any] | None:
        """Merge ``economic_calendar.json`` from the data directory into the calendar when it is there and has changed since it was last read; None when there is no file."""
        path = self.store.path.parent / calendar_feed.LOCAL_NAME
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return None
        if not force and mtime == self._local_mtime:
            return None
        now = self._clock()
        self._local_mtime = mtime
        try:
            res: dict[str, Any] = dict(self.store.upsert_events(calendar_feed.parse_local(path.read_bytes()), now))
            self.store.add_run("calendar_local", now, True, res)
        except Exception as e:  # noqa: BLE001 - a bad file is reported and the other sources carry on
            res = {"error": f"{type(e).__name__}: {str(e)[:120]}"}
            self.store.add_run("calendar_local", now, False, res)
        return res

    # ------------------------------------------------------------------ views
    def overview(self) -> dict[str, Any]:
        now = self._clock()
        latest = self.store.latest_all()
        groups = []
        for gkey, title in GROUPS:
            items = []
            for s in (x for x in self.symbols if x.group == gkey):
                r = latest.get(s.key)
                item: dict[str, Any] = {"key": s.key, "name": s.name, "unit": s.unit, "decimals": s.decimals, "kind": s.kind, "core": s.core, "yield": s.yield_pct}
                if r is None:
                    items.append(item | {"price": None, "status": "no data"})
                    continue
                age = max(0.0, (now - datetime.fromtimestamp(r["as_of"] / 1000, UTC)).total_seconds())
                items.append(item | {
                    "price": r["price"], "change": r["change"], "change_pct": r["change_pct"], "bp": None if not s.yield_pct or r["change"] is None else r["change"] * 100,
                    "prev_close": r["prev_close"], "status": r["status"], "as_of": datetime.fromtimestamp(r["as_of"] / 1000, UTC).isoformat(), "age_s": round(age),
                    "session": r["session"], "spark": _spark(self.store.series(s.key, 0, 400)),
                })  # fmt: skip
            groups.append({"key": gkey, "title": title, "items": items})
        last_ok = self.store.last_run("quotes", True)
        last = self.store.last_run("quotes")
        polled = None if last_ok is None else datetime.fromtimestamp(last_ok["at_ms"] / 1000, UTC)
        return {
            "generated_at": now.isoformat(), "groups": groups,
            "meta": {
                "source": "Yahoo Finance through the unofficial yfinance package: delayed, for personal use; every quote shows its own age",
                "last_poll_ok": None if polled is None else polled.isoformat(), "last_poll_age_s": None if polled is None else round((now - polled).total_seconds()),
                "last_error": None if last is None or last["ok"] else last["detail"].get("error"),
                "stale": polled is None or (now - polled).total_seconds() > 15 * 60,
            },
        }  # fmt: skip

    def series(self, key: str, hours: float = 24.0) -> dict[str, Any]:
        spec = BY_KEY.get(key)
        if spec is None:
            return {"key": key, "error": "unknown symbol", "points": []}
        pts = self.store.series(key, 0, 1500)
        if hours and pts:
            cut = pts[-1][0] - int(hours * 3600 * 1000)
            pts = [p for p in pts if p[0] >= cut]
        return {"key": key, "name": spec.name, "unit": spec.unit, "decimals": spec.decimals, "times": [datetime.fromtimestamp(t / 1000, UTC).isoformat() for t, _ in pts], "prices": [p for _, p in pts]}

    def calendar_view(self) -> dict[str, Any]:
        now = self._clock()
        today = now.astimezone(IST).date()
        week_end = today + timedelta(days=6 - today.weekday())  # Sunday
        next_end = week_end + timedelta(days=7)
        month_end = (today.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        horizon = max(next_end, month_end)

        def at(d: Any) -> int:
            return ms(datetime(d.year, d.month, d.day, tzinfo=IST))

        every = self.store.events_between(at(today), at(horizon + timedelta(days=1)))
        rank = {calendar_feed.LOCAL_LABEL: 0, calendar_feed.BQ_LABEL: 1}  # a release in a higher source (the export, then biquote with exact times and readings) replaces the same one in the others
        level = {"low": 0, "medium": 1, "high": 2}

        def beaten(r: dict[str, Any]) -> bool:
            mine = rank.get(r["source"], 2)
            return any(rank.get(o["source"], 2) < mine and calendar_feed.same_event(r, o) for o in every)

        def top(r: dict[str, Any]) -> dict[str, Any]:
            """The winning row keeps the highest importance any source gave the release (MQL5 rates the RBI decision medium, the official list high)."""
            best = max([r["impact"], *(o["impact"] for o in every if o is not r and calendar_feed.same_event(r, o))], key=lambda i: level.get(i, 0))
            return r | {"impact": best}

        rows = [x for x in (top(r) for r in every if not beaten(r)) if x["impact"] == "high" or (x["impact"] == "medium" and x["country"] == "India")]  # three-star events, plus India's two-star ones (MQL5 rates most Indian releases medium)
        nowms = ms(now)

        def shape(r: dict[str, Any]) -> dict[str, Any]:
            when = datetime.fromtimestamp(r["ts"] / 1000, UTC)
            upcoming = r["ts"] >= nowms
            return {
                "id": r["id"], "time_ist": when.astimezone(IST).isoformat(), "all_day": bool(r["all_day"]), "country": r["country"], "name": r["name"], "impact": r["impact"],
                "actual": r["actual"], "forecast": r["forecast"], "previous": r["previous"], "source": r["source"], "note": r["note"],
                "state": "upcoming" if upcoming else ("released" if r["actual"] else "past"), "minutes_to": round((r["ts"] - nowms) / 60000) if upcoming else None,
            }  # fmt: skip

        def day(r: dict[str, Any]) -> Any:
            return datetime.fromtimestamp(r["ts"] / 1000, UTC).astimezone(IST).date()

        spec: list[tuple[str, str, Callable[[Any], bool]]] = [
            ("today", "Today", lambda d: d == today),
            ("tomorrow", "Tomorrow", lambda d: d == today + timedelta(days=1)),
            ("week", "Rest of this week", lambda d: today + timedelta(days=1) < d <= week_end),
            ("nextweek", "Next week", lambda d: week_end < d <= next_end),
            ("month", "Later this month", lambda d: next_end < d <= month_end),
        ]
        sections = [{"key": k, "title": title, "events": [shape(r) for r in rows if match(day(r))]} for k, title, match in spec]
        nxt = next((shape(r) for r in rows if r["ts"] >= nowms), None)
        sources = []
        for kind, label in (("calendar_official", calendar_feed.OFFICIAL_LABEL), ("calendar_feed", calendar_feed.FF_LABEL), ("calendar_biquote", calendar_feed.BQ_LABEL), ("calendar_local", calendar_feed.LOCAL_LABEL)):
            ok, last = self.store.last_run(kind, True), self.store.last_run(kind)
            if kind == "calendar_local" and last is None:
                continue  # no file has been dropped in: nothing to report
            sources.append({
                "name": label, "last_ok": None if ok is None else datetime.fromtimestamp(ok["at_ms"] / 1000, UTC).isoformat(),
                "last_error": None if last is None or last["ok"] else last["detail"],
            })  # fmt: skip
        return {"generated_at": now.isoformat(), "today": today.isoformat(), "sections": sections, "next": nxt, "sources": sources,
                "note": "Three-star events, plus India's two-star releases (shown with two stars). Times are in IST. Official dates come from the central banks and statistics agencies named on each event; the feed is a third-party feed."}  # fmt: skip

    def news_view(self) -> dict[str, Any]:
        now = self._clock()

        def shape(r: dict[str, Any]) -> dict[str, Any]:
            when = datetime.fromtimestamp(r["published"] / 1000, UTC)
            return {
                "id": r["id"], "title": r["title"], "link": r["link"], "summary": r["summary"], "source": r["source"], "section": r["section"], "published": when.isoformat(),
                "age_min": max(0, round((now - when).total_seconds() / 60)), "fetched": datetime.fromtimestamp(r["fetched"] / 1000, UTC).isoformat(), "topics": news.topics(r["title"], r["summary"]),
            }  # fmt: skip

        ok, last = self.store.last_run("news", True), self.store.last_run("news")
        polled = None if ok is None else datetime.fromtimestamp(ok["at_ms"] / 1000, UTC)
        return {
            "generated_at": now.isoformat(), "india": [shape(r) for r in self.store.news("India", 40)], "global": [shape(r) for r in self.store.news("Global", 40)],
            "meta": {"last_poll_ok": None if polled is None else polled.isoformat(), "stale": polled is None or (now - polled).total_seconds() > 40 * 60,
                     "last_error": None if last is None or last["ok"] else last["detail"],
                     "sources": sorted({f"{f.source}" for f in news.FEEDS}), "note": "Headlines and the short summary each publisher's feed carries, with a link to the article on its site."},
        }  # fmt: skip

    # ------------------------------------------------------------------ the loop
    def _quote_interval(self, now: datetime) -> float:
        t = now.astimezone(IST)
        return QUOTE_FAST_S if t.weekday() < 5 and NSE_WINDOW[0] <= t.time() < NSE_WINDOW[1] else QUOTE_SLOW_S

    def _news_interval(self, now: datetime) -> float:
        t = now.astimezone(IST)
        return NEWS_FAST_S if t.weekday() < 5 and NSE_WINDOW[0] <= t.time() < NSE_WINDOW[1] else NEWS_S

    async def _loop(self) -> None:
        due = {"quotes": 0.0, "news": 0.0, "calendar": 0.0, "local": 0.0, "bq": 900.0}
        while True:
            now_m = _time.monotonic()
            try:
                if now_m >= due["quotes"]:
                    r = await asyncio.to_thread(self.poll_quotes)
                    due["quotes"] = now_m + (self._quote_interval(self._clock()) if r["ok"] else QUOTE_RETRY_S)
                if now_m >= due["news"]:
                    r = await asyncio.to_thread(self.poll_news)
                    due["news"] = now_m + (self._news_interval(self._clock()) if r["ok"] else QUOTE_RETRY_S)
                if now_m >= due["calendar"]:
                    r = await asyncio.to_thread(self.poll_calendar)
                    feed_ok = "feed" in r and "errors" not in r["feed"]
                    due["calendar"] = now_m + (CAL_S if feed_ok else CAL_RETRY_S)
                if now_m >= due["bq"]:
                    r2 = await asyncio.to_thread(self.poll_biquote)
                    due["bq"] = now_m + (BQ_S if "error" not in r2 else CAL_RETRY_S)
                if now_m >= due["local"]:
                    await asyncio.to_thread(self.poll_local_calendar)
                    due["local"] = now_m + 300
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the loop must survive anything
                logger.exception("global_markets_loop_failed")
                due = {k: now_m + QUOTE_RETRY_S for k in due}
            await asyncio.sleep(15)

    def start(self) -> None:
        if self.enabled and self._task is None:
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
