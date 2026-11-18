"""The global markets service: polls Yahoo for quotes, the public RSS feeds for news and the calendar sources, stores what it gets, and builds the views the API serves.

Nothing here is invented: a failed poll is recorded and shown (the data stays as it was, flagged stale by its age), and a symbol with no bar has no quote.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time as _time
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from app.globalmkts import calendar_feed, headsup, news, nseix
from app.globalmkts.quotes import (
    Bar,
    Downloader,
    Quote,
    bars_from_frame,
    build_quote,
    daily_closes,
    yahoo_daily,
    yahoo_download,
)
from app.globalmkts.store import GlobalStore, ms
from app.globalmkts.symbols import BY_KEY, GROUPS, SYMBOLS, GSymbol, chart_url, expected_open
from app.prediction.events import REFERENCE

logger = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")
QUOTE_FAST_S, QUOTE_SLOW_S, QUOTE_RETRY_S = 60.0, 300.0, 120.0
NEWS_S, NEWS_FAST_S, CAL_S, CAL_RETRY_S = 600.0, 120.0, 6 * 3600.0, 1800.0  # news: every 2 minutes in Indian market hours, every 10 otherwise
FULL_REFRESH_S = 6 * 3600.0
BQ_S = 900.0
BQ_FAST_S = 120.0  # while a released-by-now event still has no actual, the biquote calendar is read this often
EVENT_KEEP_D = 2  # calendar events stay (with their actual outcome) this many days after their date, then are deleted
AWAIT_ACTUAL_H = 6  # an event is waited for this many hours after its time
SERIES_FETCH, SERIES_MAX = 12000, 720  # bars read for a chart, and the most points sent
DAILY_S = 1800.0  # official closes of the cash indices are re-read this often
BARS_KEEP_D = 7  # one-minute price bars older than this are deleted (the change reference needs only the previous session)
TASK_TIMEOUT_S, MAX_BACKOFF_S = 300.0, 900.0
NEWS_KEEP_H = 48  # news older than this is deleted; calendar events are deleted when their day (IST) has passed
CLEAN_S = 3600.0
NSE_WINDOW = (time(9, 0), time(15, 45))  # IST: polled every minute then, every five minutes otherwise
SPARK_POINTS = 48
Fetch = Callable[[str], bytes]
CondFetch = Callable[[str, news.Validators | None], tuple[bytes | None, news.Validators]]


def _keep_reference(q: Quote, row: dict[str, Any] | None) -> Quote:
    """The change reference of a session does not change within it, so the stored one is kept when a poll cannot see the previous session (a cash index on a weekend, a restart in
    mid-session) and when the poll found a worse one: a one-day download finds the last stored bar of the previous session, and that can be a few minutes before its close when the poller
    had a gap then (17 Nov 2026: the S&P 500 reference moved from 7420.19, the 20:59 UTC bar, to 7414.21 an hour later). The reference bar nearer the close wins."""
    if row is None or row["session"] != q.session or row["prev_close"] is None:
        return q
    stored_ts = None if row["prev_ts"] is None else datetime.fromtimestamp(row["prev_ts"] / 1000, UTC)
    if q.prev_close is not None and not (stored_ts is not None and q.prev_ts is not None and stored_ts > q.prev_ts):
        return q
    ref = float(row["prev_close"])
    change = q.price - ref
    return replace(q, prev_close=ref, prev_ts=stored_ts, change=change, change_pct=change / ref * 100 if ref > 0 else None)


def _spark(points: list[tuple[int, float]]) -> list[float]:
    if len(points) <= SPARK_POINTS:
        return [p for _, p in points]
    step = len(points) / SPARK_POINTS
    out = [points[int(i * step)][1] for i in range(SPARK_POINTS - 1)]
    out.append(points[-1][1])
    return out


@dataclass(frozen=True)
class _Task:
    name: str
    kind: str  # the run-log kind that records its outcome
    fn: Callable[[], dict[str, Any]]
    next_delay: Callable[[dict[str, Any]], float]
    first_delay: float
    stale_after: float | None  # seconds without a success after which it counts as stale (None: never, e.g. an optional file)
    enabled: bool = True


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
        daily: Downloader = yahoo_daily,
    ) -> None:
        self.store, self.enabled, self._download, self._fetch, self._clock = store, enabled, downloader, fetch, clock
        self.symbols = symbols if symbols is not None else list(SYMBOLS)
        self.official_path = official_path
        self._cond: CondFetch = news.http_get_cond if fetch is news.http_get else (lambda url, _v: (fetch(url), {}))  # a fake fetch (tests) has no validators
        self._validators: dict[str, news.Validators] = {}
        self._task: asyncio.Task[None] | None = None
        self._daily_dl = daily
        self._official: dict[str, list[tuple[Any, float]]] = {}  # cash index -> (date, official close), oldest first
        self._daily_at: float | None = None
        self._local_mtime: float | None = None
        self._fails: dict[str, int] = {}
        self._last_error: dict[str, str] = {}
        self._started_at: float | None = None
        self._tasks_running: list[asyncio.Task[None]] = []
        self._full_at: float | None = None  # monotonic time of the last five-day download

    # ------------------------------------------------------------------ polls (blocking: run them in a thread)
    def poll_quotes(self) -> dict[str, Any]:
        t0 = _time.perf_counter()
        now = self._clock()
        # five days of bars on the first poll and every six hours (they reach the session before the latest one even over a weekend), today's only otherwise
        full = self._full_at is None or _time.monotonic() - self._full_at > FULL_REFRESH_S
        try:
            frame = self._download([s.yahoo for s in self.symbols if s.source == "yahoo"], "5d" if full else "1d")
            if full:
                self._full_at = _time.monotonic()
        except Exception as e:  # noqa: BLE001 - a failed download is recorded, the old quotes stay (flagged stale by their age)
            failure = {"error": f"{type(e).__name__}: {str(e)[:160]}"}
            self.store.add_run("quotes", now, False, failure)
            return {"ok": False, **failure}
        self._refresh_official()
        ok, missing, new_bars = 0, [], 0
        stored = self.store.latest_all()
        for spec in (s for s in self.symbols if s.source == "yahoo"):
            fresh = bars_from_frame(frame, spec.yahoo)
            older = [Bar(datetime.fromtimestamp(t / 1000, UTC), p) for t, p in self.store.bars_before(spec.key, ms(fresh[0].ts))] if fresh else []
            q = build_quote(spec, fresh, now, older)
            if q is None:
                missing.append(spec.key)
                continue
            q = _keep_reference(self._official_close(q, spec), stored.get(spec.key))
            new_bars += self.store.save_quote(q, now)
            ok += 1
        detail: dict[str, Any] = {"symbols": ok, "missing": missing, "new_bars": new_bars, "ms": round((_time.perf_counter() - t0) * 1000)}
        self.store.add_run("quotes", now, ok > 0, detail)
        return {"ok": ok > 0, **detail}

    def _refresh_official(self) -> None:
        """The official daily closes of the cash indices (what Yahoo's own page shows after the close), re-read every 30 minutes; a failure keeps the last ones."""
        if self._daily_at is not None and _time.monotonic() - self._daily_at < DAILY_S:
            return
        cash = [s for s in self.symbols if s.source == "yahoo" and s.kind == "cash"]
        if not cash:
            return
        try:
            frame = self._daily_dl([s.yahoo for s in cash], "10d")
            for s in cash:
                closes = daily_closes(frame, s.yahoo)
                if closes:
                    self._official[s.key] = closes
            self._daily_at = _time.monotonic()
        except Exception as e:  # noqa: BLE001 - the one-minute quotes still work without them
            logger.warning("global_daily_closes_failed", extra={"error": f"{type(e).__name__}: {str(e)[:120]}"})
            self._daily_at = _time.monotonic() - DAILY_S + 300  # try again in five minutes

    def _official_close(self, q: Quote, spec: GSymbol) -> Quote:
        """The official closes of a cash index. Once its market is closed the quote is the official closing value against the previous official close: the last one-minute bar is
        taken before the closing auction and can differ from the close by a few points. While the market trades the one-minute quote is the price, but the change is still measured
        from the previous official close (what Yahoo's page shows), not from a one-minute bar of the previous session, which can sit minutes before its close."""
        closes = self._official.get(spec.key)
        if spec.kind != "cash" or not closes:
            return q
        if q.status != "closed":
            prior = [c for d, c in closes if d.isoformat() < q.session]
            if not prior or prior[-1] <= 0:
                return q
            previous = prior[-1]
            delta = q.price - previous
            return replace(q, prev_close=previous, change=delta, change_pct=delta / previous * 100)
        today = next((i for i, (d, _) in enumerate(closes) if d.isoformat() == q.session), None)
        if today is None:
            return q
        price = closes[today][1]
        ref = closes[today - 1][1] if today > 0 else q.prev_close
        change = None if ref is None else price - ref
        return replace(q, price=price, prev_close=ref, change=change, change_pct=None if ref is None or ref <= 0 or change is None else change / ref * 100)

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
                added += self.store.add_news(items, now, ms(now - timedelta(hours=NEWS_KEEP_H)))
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
            out["official"] = self.store.upsert_events(calendar_feed.official_events(self.official_path), now, self._event_floor(now))
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
                    r = self.store.upsert_events(calendar_feed.parse_ff(self._fetch(url)), now, self._event_floor(now))
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
            res: dict[str, Any] = dict(self.store.upsert_events(calendar_feed.parse_biquote(self._fetch(calendar_feed.bq_url(now))), now, self._event_floor(now)))
            self.store.add_run("calendar_biquote", now, True, res)
        except Exception as e:  # noqa: BLE001 - recorded; the stored events stay
            res = {"error": f"{type(e).__name__}: {str(e)[:120]}"}
            self.store.add_run("calendar_biquote", now, False, res)
        return res

    @staticmethod
    def _today(now: datetime) -> str:
        return now.astimezone(IST).date().isoformat()

    @staticmethod
    def _event_floor(now: datetime) -> str:
        """The oldest event date (IST) that is kept: the last ``EVENT_KEEP_D`` days stay with their outcomes, older events are neither stored nor kept."""
        return (now.astimezone(IST).date() - timedelta(days=EVENT_KEEP_D)).isoformat()

    def awaiting_actual(self) -> bool:
        """True while a shown event that was due in the last few hours has no actual yet: the calendar is then read every two minutes instead of every fifteen."""
        now = self._clock()
        nowms = ms(now)
        return any(r["actual"] is None and not r["all_day"] for r in self._visible_rows(nowms - AWAIT_ACTUAL_H * 3600_000, nowms))

    def poll_gift(self) -> dict[str, Any]:
        """GIFT Nifty (the near-month NIFTY future at NSE IX): one small request; the quote and its bar are stored like the others."""
        now = self._clock()
        spec = BY_KEY["GIFT"]
        try:
            got = nseix.gift_quote(self._fetch(nseix.DW_URL), now, spec)
            if got is None:
                res: dict[str, Any] = {"ok": False, "error": "no traded NIFTY future in the feed"}
                self.store.add_run("gift", now, False, res)
                return res
            q, expiry = got
            new = self.store.save_quote(q, now)
            res = {"ok": True, "expiry": expiry, "new_bars": new}
            self.store.add_run("gift", now, True, res)
        except Exception as e:  # noqa: BLE001 - recorded; the stored quote stays and ages
            res = {"ok": False, "error": f"{type(e).__name__}: {str(e)[:120]}"}
            self.store.add_run("gift", now, False, res)
        return res

    def cleanup(self) -> dict[str, int]:
        """Delete calendar events older than ``EVENT_KEEP_D`` days (the last two days stay with their outcomes) and news older than the retention; the numbers go in the run log."""
        now = self._clock()
        res = self.store.prune(self._event_floor(now), ms(now - timedelta(hours=NEWS_KEEP_H)), ms(now - timedelta(days=BARS_KEEP_D)))
        self.store.add_run("cleanup", now, True, res | {"bytes": self.store.size_bytes()})
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
            res: dict[str, Any] = dict(self.store.upsert_events(calendar_feed.parse_local(path.read_bytes()), now, self._event_floor(now)))
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
                item: dict[str, Any] = {"key": s.key, "name": s.name, "unit": s.unit, "decimals": s.decimals, "kind": s.kind, "core": s.core, "yield": s.yield_pct, "chart_url": chart_url(s), "delay_min": s.delay_min}
                if s.key == "GIFT":
                    g = self.store.last_run("gift", True)
                    item["note"] = f"Near-month contract, expires {g['detail']['expiry']}. {nseix.SOURCE_LABEL}." if g else nseix.SOURCE_LABEL
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
        pts = self.store.series(key, 0, SERIES_FETCH)
        if hours and pts:
            cut = pts[-1][0] - int(hours * 3600 * 1000)
            pts = [p for p in pts if p[0] >= cut]
        if len(pts) > SERIES_MAX:  # a few days of one-minute bars: keep the last price of each equal slice of the time span, so the chart stays light and its ends are exact
            span = (pts[-1][0] - pts[0][0]) or 1
            slots: dict[int, tuple[int, float]] = {}
            for t, p in pts:
                slots[min(SERIES_MAX - 1, int((t - pts[0][0]) * SERIES_MAX / span))] = (t, p)
            pts = [slots[k] for k in sorted(slots)]
        row = self.store.latest_all().get(key)
        return {
            "key": key, "name": spec.name, "unit": spec.unit, "decimals": spec.decimals, "yield": spec.yield_pct, "status": None if row is None else row["status"],
            "prev_close": None if row is None else row["prev_close"], "source_url": chart_url(spec),
            "times": [datetime.fromtimestamp(t / 1000, UTC).isoformat() for t, _ in pts], "prices": [p for _, p in pts],
        }  # fmt: skip

    def _visible_rows(self, start_ms: int, end_ms: int) -> list[dict[str, Any]]:
        """The calendar rows the page shows between two times: three-star events plus India's two-star ones, one row per release (a release carried by several sources
        appears once, from the highest-ranked source, with the highest importance any of them gave it)."""
        every = self.store.events_between(start_ms, end_ms)
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
        return rows

    def calendar_view(self) -> dict[str, Any]:
        now = self._clock()
        today = now.astimezone(IST).date()
        week_end = today + timedelta(days=6 - today.weekday())  # Sunday
        next_end = week_end + timedelta(days=7)
        month_end = (today.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        ahead_end = today + timedelta(days=45)  # "Coming up": past the end of this month, so the next RBI or Fed decision shows early
        horizon = max(next_end, month_end, ahead_end)

        def at(d: Any) -> int:
            return ms(datetime(d.year, d.month, d.day, tzinfo=IST))

        rows = self._visible_rows(at(today - timedelta(days=EVENT_KEEP_D)), at(horizon + timedelta(days=1)))  # the last two days stay: their outcomes are the point
        nowms = ms(now)

        def shape(r: dict[str, Any]) -> dict[str, Any]:
            when = datetime.fromtimestamp(r["ts"] / 1000, UTC)
            upcoming = r["ts"] >= nowms
            return {
                "id": r["id"], "time_ist": when.astimezone(IST).isoformat(), "all_day": bool(r["all_day"]), "country": r["country"], "name": r["name"], "impact": r["impact"],
                "actual": r["actual"], "forecast": r["forecast"], "previous": r["previous"], "source": r["source"], "note": r["note"],
                "state": "upcoming" if upcoming else ("released" if r["actual"] else "past"), "minutes_to": round((r["ts"] - nowms) / 60000) if upcoming else None,
                "outcome": calendar_feed.surprise(r["name"], r["actual"], r["forecast"]),
            }  # fmt: skip

        def day(r: dict[str, Any]) -> Any:
            return datetime.fromtimestamp(r["ts"] / 1000, UTC).astimezone(IST).date()

        spec: list[tuple[str, str, Callable[[Any], bool]]] = [
            ("today", "Today", lambda d: d == today),
            ("tomorrow", "Tomorrow", lambda d: d == today + timedelta(days=1)),
            ("week", "Rest of this week", lambda d: today + timedelta(days=1) < d <= week_end),
            ("nextweek", "Next week", lambda d: week_end < d <= next_end),
            ("month", "Later this month", lambda d: next_end < d <= month_end),
            ("later", "Coming up", lambda d: max(next_end, month_end) < d <= ahead_end),
        ]
        sections = [{"key": k, "title": title, "events": [shape(r) for r in rows if match(day(r))]} for k, title, match in spec]
        # the last two days with what actually came out, newest first (an event of the last hours today with no actual yet stays in Today)
        sections.append({"key": "recent", "title": f"Past {EVENT_KEEP_D} days: outcomes", "events": [shape(r) for r in reversed(rows) if day(r) < today]})
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
                "note": "Three-star events, plus India's two-star releases (shown with two stars). Times are in IST. Official dates come from the central banks and statistics agencies named on each event; the feed is a third-party feed. Each event keeps its outcome for two days after its date and is then deleted automatically."}  # fmt: skip

    def headsup(self) -> dict[str, Any]:
        """What deserves a reminder now: upcoming catalysts in the next 3 days (see headsup.py for when each comes back) and fresh market-moving headlines."""
        now = self._clock()
        nowms = ms(now)
        reminders: list[dict[str, Any]] = []
        for r in self._visible_rows(nowms, nowms + int(headsup.LEAD_H * 3600_000) + 1):
            hours = (r["ts"] - nowms) / 3600_000
            if r["ts"] < nowms or r["all_day"] or not headsup.is_catalyst(r):
                continue
            phase = headsup.phase_of(hours)
            reminders.append({
                "key": f"{r['id']}:{phase}", "event_id": r["id"], "phase": phase, "name": r["name"], "country": r["country"], "impact": r["impact"],
                "time_ist": datetime.fromtimestamp(r["ts"] / 1000, UTC).astimezone(IST).isoformat(), "minutes_to": round((r["ts"] - nowms) / 60000),
                "previous": r["previous"], "forecast": r["forecast"],
            })  # fmt: skip
        fresh: list[dict[str, Any]] = []
        for region in ("India", "Global"):
            for r in self.store.news(region, 60):
                age_h = (nowms - r["published"]) / 3600_000
                fetched_min = (nowms - r["fetched"]) / 60_000
                tags = news.topics(r["title"], r["summary"])
                if tags and fetched_min <= headsup.NEWS_FRESH_MIN and 0 <= age_h <= headsup.NEWS_PUBLISHED_H:
                    fresh.append({"key": r["id"], "title": r["title"], "link": r["link"], "source": r["source"], "topics": tags, "age_min": max(0, round(age_h * 60)), "published": r["published"]})
        fresh.sort(key=lambda x: -x["published"])
        return {"generated_at": now.isoformat(), "reminders": reminders[: headsup.EVENTS_MAX], "news": [{k: v for k, v in n.items() if k != "published"} for n in fresh[: headsup.NEWS_MAX]]}

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

    # ------------------------------------------------------------------ the supervised tasks
    def _tasks(self) -> list[_Task]:
        """Every job the service runs on its own, with how soon it runs again and when a missing success counts as stale. Each job has its own loop: a slow or failing one
        never delays or resets the others."""
        gift_on = any(s.source == "nseix" for s in self.symbols)
        return [
            _Task("quotes", "quotes", self.poll_quotes, lambda r: self._quote_interval(self._clock()) if r.get("ok") else QUOTE_RETRY_S, 0.0, 20 * 60),
            _Task("gift", "gift", self.poll_gift, lambda r: (QUOTE_FAST_S if expected_open(BY_KEY["GIFT"], self._clock()) else QUOTE_SLOW_S) if r.get("ok") else QUOTE_RETRY_S, 3.0, 20 * 60, enabled=gift_on),
            _Task("news", "news", self.poll_news, lambda r: self._news_interval(self._clock()) if r.get("ok") else QUOTE_RETRY_S, 6.0, 40 * 60),
            _Task("calendar", "calendar_feed", self.poll_calendar, lambda r: CAL_S if "feed" in r and "errors" not in r["feed"] else CAL_RETRY_S, 9.0, 13 * 3600),
            _Task("biquote", "calendar_biquote", self.poll_biquote, lambda r: CAL_RETRY_S if "error" in r else (BQ_FAST_S if self.awaiting_actual() else BQ_S), 12.0, 45 * 60),
            _Task("local", "calendar_local", lambda: self.poll_local_calendar() or {}, lambda r: 300.0, 15.0, None),
            _Task("cleanup", "cleanup", self.cleanup, lambda r: CLEAN_S, 30.0, 3 * 3600),
        ]

    async def _run_task(self, t: _Task) -> None:
        """One job forever: wait its first delay, run it in a thread, record the outcome, wait its next delay (a failure backs off, up to 15 minutes). Never exits except on cancel."""
        await asyncio.sleep(t.first_delay)
        while True:
            delay = QUOTE_RETRY_S
            try:
                result = await asyncio.wait_for(asyncio.to_thread(t.fn), timeout=TASK_TIMEOUT_S)
                ok = "error" not in result and result.get("ok", True) is not False
                self._fails[t.name] = 0 if ok else self._fails.get(t.name, 0) + 1
                delay = t.next_delay(result)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - one job must never stop the service
                self._fails[t.name] = self._fails.get(t.name, 0) + 1
                self._last_error[t.name] = f"{type(e).__name__}: {str(e)[:120]}"
                logger.exception("global_markets_task_failed", extra={"task": t.name})
            n = self._fails.get(t.name, 0)
            if n > 0:
                delay = min(max(delay, QUOTE_RETRY_S) * 2 ** (n - 1), MAX_BACKOFF_S)
            await asyncio.sleep(delay)

    def health(self) -> dict[str, Any]:
        """Whether each job has succeeded recently: ok, stale (no success within its allowance), failing (three failures in a row) or starting. Also the database size and row counts."""
        now = self._clock()
        out: list[dict[str, Any]] = []
        if not self.enabled:  # switched off in the settings: nothing is expected to run
            return {"status": "disabled", "tasks": [], "database": {"bytes": self.store.size_bytes(), **self.store.counts()}, "retention": {}}
        for t in self._tasks():
            if not t.enabled:
                continue
            ok_run, last = self.store.last_run(t.kind, True), self.store.last_run(t.kind)
            age = None if ok_run is None else max(0.0, now.timestamp() - ok_run["at_ms"] / 1000)
            fails = self._fails.get(t.name, 0)
            if fails >= 3:
                status = "failing"
            elif t.stale_after is None:
                status = "ok"
            elif age is None:
                status = "starting" if (self._started_at is not None and now.timestamp() - self._started_at < 600) else "stale"
            else:
                status = "ok" if age <= t.stale_after else "stale"
            detail = last["detail"] if last is not None and not last["ok"] else None
            out.append({"task": t.name, "status": status, "last_ok_age_s": None if age is None else round(age), "consecutive_failures": fails, "last_error": self._last_error.get(t.name) or (detail.get("error") if isinstance(detail, dict) else None) if status != "ok" else None})
        bad = [x for x in out if x["status"] in ("stale", "failing")]
        return {"status": "degraded" if bad else "ok", "tasks": out, "database": {"bytes": self.store.size_bytes(), **self.store.counts()}, "retention": {"bars_days": BARS_KEEP_D, "news_hours": NEWS_KEEP_H, "events": "days that have passed"}}

    def start(self) -> None:
        if self.enabled and self._task is None:
            self._started_at = _time.time()
            self._tasks_running = [asyncio.create_task(self._run_task(t), name=f"global-{t.name}") for t in self._tasks() if t.enabled]
            self._task = asyncio.create_task(self._supervise())

    async def _supervise(self) -> None:
        """Restart any job loop that has died for a reason nothing else caught (they are meant to run forever)."""
        while True:
            await asyncio.sleep(60)
            for i, task in enumerate(self._tasks_running):
                if task.done() and not task.cancelled():
                    logger.error("global_markets_task_died_restarting", extra={"task": task.get_name(), "error": repr(task.exception())})
                    t = next((x for x in self._tasks() if f"global-{x.name}" == task.get_name()), None)
                    if t is not None:
                        self._tasks_running[i] = asyncio.create_task(self._run_task(t), name=task.get_name())

    async def stop(self) -> None:
        if self._task is not None:
            for t in [self._task, *self._tasks_running]:
                t.cancel()
            for t in [self._task, *self._tasks_running]:
                with contextlib.suppress(asyncio.CancelledError):
                    await t
            self._task = None
            self._tasks_running = []
