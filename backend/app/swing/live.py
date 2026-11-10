"""Live prices for the swing paper trader, from the Kotak feed the backend already has.

It watches only the stocks the paper book cares about: tonight's queued orders and the open positions
(about a dozen), subscribes them on the running feed, and every couple of seconds applies the live checks
(live_rules) to their latest values. It reads the feed's latest values (a pull, not a hook on the tick path),
so it cannot disturb the feed.

SHADOW MODE: what the rules would do right now (trigger reached, stop breached, 1.8R / 2.5R reached) is shown
and logged once per day in ``live_events``, but the paper book is NOT changed: it still follows the end-of-day
settlement. Live execution is switched on only after a session's shadow events have been compared with that
settlement, because the paper record is permanent and a wrong live fill could not be taken back.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

from app.logging_setup import log_event
from app.market.sources import TokenInfo, parse_scrip_master_any_series
from app.stream.models import FeedToken, LiveTick
from app.swing.engine import Config, Order, Position, position_size
from app.swing.live_ledger import LiveLedger, position_of
from app.swing.live_rules import (
    IST,
    EntryCheck,
    check_entry,
    check_position,
    session_state,
    volume_pace,
)
from app.swing.store import PaperStore

logger = logging.getLogger(__name__)

STALE_AFTER_S = 120.0  # a tick older than this is shown, but never acted on
ENTRY_EVENTS = ("entry_trigger", "entry_gap_skip")


def previous_session(today: date) -> date:
    """The trading day before ``today``: the verified exchange calendar, else the plain weekday rule."""
    try:
        from app.prediction.calendar import TradingCalendar

        cal = TradingCalendar.load()
        d = today - timedelta(days=1)
        for _ in range(10):
            if cal.is_session(d):
                return d
            d -= timedelta(days=1)
    except Exception:  # noqa: BLE001, S110 - no calendar for that date: the weekday rule below stands
        pass
    d = today - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d
MASTER_RETRY_S = 600.0


class SwingLive:
    def __init__(
        self, store: PaperStore, cfg: Config, *, ticks: Callable[[], dict[str, LiveTick]],
        scrip_master: Callable[[], Awaitable[list[dict[str, Any]]]] | None,
        add_tokens: Callable[[list[FeedToken]], Awaitable[int]] | None,
        feed_state: Callable[[], str] = lambda: "unknown",
        clock: Callable[[], datetime] = lambda: datetime.now(UTC), enabled: bool = True,
        poll_s: float = 2.0, refresh_s: float = 60.0, prev_session: Callable[[date], date] = previous_session,
        ledger: LiveLedger | None = None, live_fills: Callable[[], bool] = lambda: False,
    ) -> None:
        self.store, self.cfg, self._ticks, self._scrip = store, cfg, ticks, scrip_master
        self._add_tokens, self._feed_state, self._clock = add_tokens, feed_state, clock
        self.enabled, self.poll_s, self.refresh_s = enabled, poll_s, refresh_s
        self._lock = threading.Lock()
        self._prev_session = prev_session
        self._last_scan: str | None = None  # the session the queued orders were scanned at
        self._orders: list[Order] = []
        self._positions: list[Position] = []
        self._master: dict[str, TokenInfo] | None = None
        self._master_day: date | None = None
        self._master_error: str | None = None
        self._master_tried: datetime | None = None
        self._tokens: dict[str, FeedToken] = {}  # symbol -> token, for the watched stocks
        self._asked: set[str] = set()  # keys already handed to the stream
        self._task: asyncio.Task[None] | None = None
        self.ledger, self._live_fills = ledger, live_fills
        self._no = 0  # ordinal of the book's last session
        self._last_exit: dict[str, int] = {}
        self._trig: dict[str, int] = {}  # consecutive polls on which an order read "triggered"

    # ------------------------------------------------------------------ what is watched
    def load_watch(self) -> None:
        book, last, no, pending = self.store.load_state(self.cfg)
        with self._lock:
            self._orders, self._positions, self._last_scan = list(pending), list(book.positions.values()), last
            self._no, self._last_exit = no, dict(book.last_exit_no)

    def queue_state(self, now: datetime) -> dict[str, Any]:
        """Are the queued orders the ones meant for today's session? They are when the book's last scan is the trading
        day before today. If the book is behind (a missed evening run), those orders were meant for an earlier day, and
        checking them against today's prices says nothing about the paper book: the catch-up run settles them first."""
        today = now.astimezone(IST).date()
        expected = self._prev_session(today)
        scan = self._last_scan
        current = scan is not None and scan >= expected.isoformat()
        behind = 0
        if scan is not None and not current:
            d = date.fromisoformat(scan) + timedelta(days=1)
            while d <= expected:
                behind += d.weekday() < 5
                d += timedelta(days=1)
        return {"scan_session": scan, "expected_scan_session": expected.isoformat(), "current": current, "sessions_behind": behind}

    def _symbols(self) -> list[str]:
        with self._lock:
            return sorted({o.symbol for o in self._orders} | {p.symbol for p in self._positions})

    async def _ensure_master(self, now: datetime) -> None:
        today = now.astimezone(IST).date()
        if self._scrip is None or self._master_day == today:
            return
        if self._master_tried and (now - self._master_tried).total_seconds() < MASTER_RETRY_S:
            return
        self._master_tried = now
        try:
            self._master = parse_scrip_master_any_series(await self._scrip())
            self._master_day, self._master_error = today, None
        except Exception as e:  # noqa: BLE001 - the live view degrades, nothing else depends on it
            self._master_error = type(e).__name__
            log_event(logger, logging.WARNING, "swing_live_token_file_failed", error=self._master_error)

    def _resolve(self) -> None:
        master = self._master or {}
        for sym in self._symbols():
            info = master.get(sym)
            if info is not None and sym not in self._tokens:
                self._tokens[sym] = FeedToken(exchange_segment="nse_cm", instrument_token=info.token)

    def feed_tokens(self) -> list[FeedToken]:
        """Tokens to subscribe whenever the feed (re)connects."""
        watched = set(self._symbols())
        return [t for s, t in self._tokens.items() if s in watched]

    async def refresh(self) -> None:
        """Reload what is watched and make sure the feed delivers it."""
        await asyncio.to_thread(self.load_watch)
        if any(s not in self._tokens for s in self._symbols()):  # no broker call unless a token is needed
            await self._ensure_master(self._clock())
        self._resolve()
        new = [t for t in self.feed_tokens() if t.key not in self._asked]
        if new and self._add_tokens is not None:
            try:
                await self._add_tokens(new)
                self._asked |= {t.key for t in new}
            except Exception as e:  # noqa: BLE001 - retried on the next refresh
                log_event(logger, logging.WARNING, "swing_live_subscribe_failed", error=type(e).__name__)

    # ------------------------------------------------------------------ live checks
    def _fresh(self, tick: LiveTick | None, now: datetime) -> LiveTick | None:
        if tick is None or (now - tick.received_at).total_seconds() > STALE_AFTER_S:
            return None
        return tick

    def poll(self, now: datetime | None = None) -> int:
        """Apply the live checks once; record newly reached events (shadow). Returns how many were new."""
        now = now or self._clock()
        if session_state(now) != "open":
            return 0  # the feed keeps the last values after the close: never act on them
        ticks, session = self._ticks(), now.astimezone(IST).date().isoformat()
        queue_ok = bool(self.queue_state(now)["current"])
        with self._lock:
            orders, positions = list(self._orders), list(self._positions)
        new = 0

        def record(kind: str, sym: str, price: float | None, tick: LiveTick | None, detail: dict[str, Any]) -> None:
            nonlocal new
            if self.store.record_live_event(session, now, kind, sym, price, tick.volume if tick else None, detail):
                new += 1

        for o in orders if queue_ok else []:  # a stale queue was meant for an earlier session: never acted on
            token = self._tokens.get(o.symbol)
            tick = self._fresh(ticks.get(token.key) if token else None, now)
            if tick is None:
                continue
            chk = check_entry(o, tick, now)
            if chk.state == "gap_skip":
                record("entry_gap_skip", o.symbol, tick.open, tick, {"note": chk.note, "pace": chk.pace, "order_session": o.session})
            elif chk.state == "triggered" and tick.ltp is not None:
                record("entry_trigger", o.symbol, max(tick.ltp, o.trigger), tick,
                       {"note": chk.note, "pace": chk.pace, "ltp": tick.ltp, "trigger": o.trigger, "order_session": o.session})
        for p in positions:
            token = self._tokens.get(p.symbol)
            tick = self._fresh(ticks.get(token.key) if token else None, now)
            if tick is None:
                continue
            pc = check_position(p, tick, self.cfg)
            if pc.stop_hit:
                record("stop_hit", p.symbol, pc.stop_exit_price, tick, {"stop": pc.stop, "ltp": pc.ltp, "low": tick.low})
            if pc.reached_1_8r:
                record("target_1_8r", p.symbol, pc.level_1_8r, tick, {"note": "the stop moves to breakeven at the close"})
            if pc.reached_2_5r:
                record("target_2_5r", p.symbol, pc.level_2_5r, tick, {"note": "the trailing stop starts at the close"})
        if self.ledger is not None and self._live_fills():
            try:
                self.live_fill_pass(now, ticks, orders if queue_ok else [], positions)
            except Exception as e:  # noqa: BLE001 - the ledger is provisional and must never disturb the live view or the feed
                log_event(logger, logging.ERROR, "swing_live_fill_pass_failed", error=type(e).__name__)
        return new

    # ------------------------------------------------------------------ the live paper ledger (provisional, separate from the official book)
    #: an order must read "triggered" on this many consecutive polls before a live fill is made (one bad tick must not create a fill)
    CONFIRM_POLLS = 2

    def live_fill_pass(self, now: datetime, ticks: dict[str, LiveTick], orders: list[Order], positions: list[Position]) -> list[int]:
        """Make live paper fills for orders whose entry rule holds on fresh prices, and apply live stops to the ledger's open fills.
        Only while the market is open and the feed is streaming; never for a stale queue (``orders`` is empty then)."""
        led = self.ledger
        if led is None or self._feed_state() != "streaming":
            return []
        session = now.astimezone(IST).date().isoformat()
        made: list[int] = []
        official = {p.symbol: p for p in positions}
        # 1. marks and stops of what is already open
        for r in led.open_fills():
            token = self._tokens.get(r["symbol"])
            tick = self._fresh(ticks.get(token.key) if token else None, now)
            if tick is None or tick.ltp is None:
                continue
            led.mark(r["id"], tick.ltp, now)
            off = official.get(r["symbol"])
            stop = off.tsl if off is not None and off.order_id == r["order_id"] else r["initial_sl"]
            pc = check_position(position_of(r, stop, off.hh if off is not None else None), tick, self.cfg)
            if pc.stop_hit and pc.stop_exit_price is not None:
                led.close(r["id"], price=pc.stop_exit_price, now=now, reason=f"stop {stop:.2f} breached on a live price")
        # 2. entries, best score first (the evening run's order)
        cutoff = date.fromisoformat(session)
        for _ in range(self.cfg.cooldown):
            cutoff = self._prev_session(cutoff)
        for o in sorted(orders, key=lambda x: (-x.score, x.symbol)):
            token = self._tokens.get(o.symbol)
            tick = self._fresh(ticks.get(token.key) if token else None, now)
            chk = check_entry(o, tick, now) if tick is not None else None
            if chk is None or chk.state != "triggered" or tick is None or tick.ltp is None:
                self._trig.pop(o.symbol, None)
                continue
            self._trig[o.symbol] = self._trig.get(o.symbol, 0) + 1
            if self._trig[o.symbol] < self.CONFIRM_POLLS:
                continue
            open_now = led.open_fills()
            if (led.has_fill(session, o.symbol) or o.symbol in official or any(x["symbol"] == o.symbol for x in open_now)
                    or len(open_now) >= self.cfg.slots or (self._no + 1) - self._last_exit.get(o.symbol, -99) < self.cfg.cooldown
                    or led.exited_since(o.symbol, cutoff.isoformat())):
                continue
            fill = max(tick.open or 0.0, o.trigger)
            equity = led.equity()
            shares = position_size(equity, led.cash(), fill, o.initial_sl, self.cfg)
            if shares < 1:
                continue
            fid = led.record_fill(session=session, now=now, order=o, price=fill, shares=shares, equity=equity,
                                  evidence=f"{chk.note}; ltp {tick.ltp:.2f}, day open {tick.open}, volume {tick.volume}, trigger {o.trigger:.2f}")
            if fid is not None:
                made.append(fid)
        return made

    # ------------------------------------------------------------------ for the page
    def view(self) -> dict[str, Any]:
        now = self._clock()
        ticks = self._ticks()
        with self._lock:
            orders, positions = list(self._orders), list(self._positions)
        rows: list[dict[str, Any]] = []
        queue = self.queue_state(now)

        def snap(sym: str) -> tuple[LiveTick | None, dict[str, Any]]:
            token = self._tokens.get(sym)
            tick = ticks.get(token.key) if token else None
            age = None if tick is None else round((now - tick.received_at).total_seconds(), 1)
            base: dict[str, Any] = {
                "symbol": sym, "has_token": token is not None, "ltp": tick.ltp if tick else None,
                "prev_close": tick.prev_close if tick else None, "volume": tick.volume if tick else None,
                "day_open": tick.open if tick else None, "day_high": tick.high if tick else None,
                "day_low": tick.low if tick else None, "tick_age_s": age,
                "stale": tick is None or (age is not None and age > STALE_AFTER_S),
                "change_pct": (None if not tick or tick.ltp is None or not tick.prev_close
                               else (tick.ltp / tick.prev_close - 1) * 100),
            }
            return tick, base

        for o in orders:
            tick, base = snap(o.symbol)
            chk = check_entry(o, tick, now)
            state = chk.state if not base["stale"] or chk.state in ("no_data",) else "stale"
            if not queue["current"]:
                state, chk = "stale_queue", EntryCheck("stale_queue", "queued for an earlier session; the book is catching up", chk.pace)
            rows.append(base | {
                "kind": "order", "rank": o.rank, "state": state, "note": chk.note,
                "pace": volume_pace(tick.volume, o.min_volume, now) if tick else None,
                "trigger": o.trigger, "max_open": o.max_open, "stop": o.initial_sl, "min_volume": o.min_volume,
            })
        for p in positions:
            tick, base = snap(p.symbol)
            pc = check_position(p, tick, self.cfg)
            rows.append(base | {
                "kind": "position", "state": "stop_hit" if pc.stop_hit else ("stale" if base["stale"] else "holding"),
                "note": "", "fill": p.fill, "shares": p.shares, "stop": pc.stop, "r_now": pc.r_now,
                "level_1_8r": pc.level_1_8r, "level_2_5r": pc.level_2_5r,
                "reached_1_8r": pc.reached_1_8r, "reached_2_5r": pc.reached_2_5r,
                "unrealized_pnl": None if pc.ltp is None else (pc.ltp - p.fill) * p.shares,
            })
        missing = sorted(s for s in self._symbols() if s not in self._tokens)
        note = None
        if self._scrip is None:
            note = "no broker instrument file available"
        elif self._master_error:
            note = f"Kotak instrument file not loaded ({self._master_error}); it retries every 10 minutes"
        elif missing:
            note = (f"no Kotak token found for: {', '.join(missing[:6])} (not in the Kotak cash instrument file under EQ, BE, BZ, SM, ST or SZ: "
                    "the symbol may be suspended, delisted or renamed)")
        session = now.astimezone(IST).date().isoformat()
        events = self.store.live_events(session)
        if not queue["current"]:  # entry decisions made from orders meant for an earlier session are not shown as today's
            events = [e for e in events if e["kind"] not in ENTRY_EVENTS]
        if not queue["current"] and self._orders and queue["scan_session"] is not None:
            note = note or (
                f"The paper book is {queue['sessions_behind']} session(s) behind: its queued orders come from the "
                f"{queue['scan_session']} scan and were meant for an earlier session, so they are not checked against today's "
                "prices. The next evening run settles them on their own days first, then queues the orders for the next session."
            )
        return {
            "enabled": self.enabled, "live_fills_enabled": bool(self.enabled and self.ledger is not None and self._live_fills()), "mode": "shadow", "market": session_state(now), "feed_state": self._feed_state(),
            "queue": queue,
            "note": note, "watching": rows, "events": events,
            "updated_at": now.astimezone(UTC).isoformat(timespec="seconds"),
        }

    # ------------------------------------------------------------------ lifecycle
    async def _loop(self) -> None:
        last_refresh = datetime.min.replace(tzinfo=UTC)
        while True:
            try:
                now = self._clock()
                if (now - last_refresh).total_seconds() >= self.refresh_s:
                    last_refresh = now
                    await self.refresh()
                await asyncio.to_thread(self.poll)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - the loop must outlive any single failure
                log_event(logger, logging.ERROR, "swing_live_loop_error", error=type(e).__name__)
            await asyncio.sleep(self.poll_s)

    def start(self) -> None:
        if self._task is None and self.enabled:
            self._task = asyncio.create_task(self._loop(), name="swing-live")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
