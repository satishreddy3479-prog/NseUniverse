"""The 1-minute shadow book: the live-style swing rules (``minute_rules``) applied to candles built from the live feed, beside the official daily-bar book.

SHADOW ONLY. It reads prices the backend already receives, writes to its own SQLite file, and never places an order or touches the official paper book.
Each evening, after the official settlement, it compares what the two books did, stock by stock, so the gap between the tested daily-bar rules and the
live-style rules is measured, not assumed.

How a decision happens: every ~2 s ``on_poll`` receives the latest price of each watched stock (tonight's queued orders and the shadow book's open
positions). The polls of one minute become one candle. When the first poll of the NEXT minute arrives the previous candle is complete: the rules are applied to it
and, if they say enter or exit, the fill is that first poll's price (the next candle's open). Nothing is decided on a half-built candle.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.logging_setup import log_event
from app.stream.models import LiveTick
from app.swing.engine import Config, Decision, Order, Trade, position_size
from app.swing.minute_analytics import book_analytics, trade_r
from app.swing.minute_rules import (
    CHASE_CAP,
    D1_CHECK_MIN,
    ENTRY_FROM_MIN,
    ENTRY_UNTIL_MIN,
    SESSION_MINUTES,
    SESSION_OPEN_MIN,
    Candle,
    ShadowPos,
    check_entry,
    expected_fraction,
    step,
)
from app.swing.minute_store import MinuteStore

logger = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")
RULES = [
    "Entry: a 1-minute candle that closes between 09:30 and 15:00 at or above the trigger (and not more than 1% above it), the day's open at or below the no-chase limit, "
    "and the day's volume at least the minimum volume scaled by the expected share of the day (the app's stock volume profile). Filled at the next candle's open; cancelled if that is more than 1% above the trigger.",
    "Stop: a candle that closes at or below the stop in force exits at the next candle's open.",
    "Breakeven at +1.8R and trailing from +2.5R, on the highest 1-minute close (stop = highest of itself, fill x 1.002 and highest close - 2.5 x ATR14 of the signal day); a new level applies from the next candle.",
    "Day 1: on the candle that closes at 15:20, exit if its close is below the pivot or in the bottom 35% of the day's range so far.",
    "Same slots (5), 2% risk sizing, 3-session cooldown and 0.15% cost per side as the official book. No orders are placed.",
]


@dataclass
class _Acc:
    symbol: str
    session: str
    start_min: int
    o: float
    h: float
    low: float
    c: float
    cum_volume: int | None
    day_open: float | None
    day_high: float | None
    day_low: float | None
    polls: int = 1

    def candle(self) -> Candle:
        return Candle(self.symbol, self.session, self.start_min, self.o, self.h, self.low, self.c, self.cum_volume, self.day_open, self.day_high, self.day_low, self.polls)


def _mins(t: datetime) -> int:
    i = t.astimezone(IST)
    return i.hour * 60 + i.minute


def _hhmm(t: datetime | str | None) -> str:
    if t is None:
        return "—"
    d = datetime.fromisoformat(t) if isinstance(t, str) else t
    return d.astimezone(IST).strftime("%H:%M")


class MinuteShadow:
    def __init__(
        self, store: MinuteStore, cfg: Config, *, profile: Callable[[], dict[int, float] | None] = lambda: None,
        prev_session: Callable[[date], date], enabled: bool = True,
    ) -> None:
        self.store, self.cfg, self._profile, self._prev, self.enabled = store, cfg, profile, prev_session, enabled
        self._cur: dict[str, _Acc] = {}
        self._lock = threading.RLock()
        self._last: dict[str, dict[str, Any]] = {}  # symbol -> the latest rule reading on a completed candle (for the page)
        self._orders: dict[str, Order] = {}
        self.last_poll_at: datetime | None = None
        self._last_eq_minute: datetime | None = None

    # ------------------------------------------------------------------ what is watched
    def open_symbols(self) -> set[str]:
        return {r["symbol"] for r in self.store.open_rows()} if self.enabled else set()

    # ------------------------------------------------------------------ the feed
    def on_poll(self, now: datetime, ticks: dict[str, LiveTick], orders: Sequence[Order]) -> int:
        """Fold one poll into the candles; apply the rules to every candle this poll completes. Returns how many candles were completed."""
        if not self.enabled:
            return 0
        session, start = now.astimezone(IST).date().isoformat(), _mins(now)
        with self._lock:
            self._orders = {o.symbol: o for o in orders}
            watched = set(self._orders) | self.open_symbols()
            done: list[tuple[Candle, float | None, datetime]] = []
            for sym in sorted(watched):
                t = ticks.get(sym)
                if t is None or t.ltp is None:
                    continue
                px = t.ltp
                acc = self._cur.get(sym)
                if acc is not None and (acc.start_min != start or acc.session != session):
                    done.append((acc.candle(), px, now))
                    acc = None
                if acc is None:
                    self._cur[sym] = _Acc(sym, session, start, px, px, px, px, t.volume, t.open, t.high, t.low)
                else:
                    acc.h, acc.low, acc.c, acc.polls = max(acc.h, px), min(acc.low, px), px, acc.polls + 1
                    acc.cum_volume = t.volume if t.volume is not None else acc.cum_volume
                    acc.day_open, acc.day_high, acc.day_low = t.open or acc.day_open, t.high or acc.day_high, t.low or acc.day_low
            self.last_poll_at = now
            self._handle(done, now)
            self._snapshot(now)
            return len(done)

    def on_close(self, now: datetime) -> int:
        """The market is closed: complete the candles still being built (their fills fall back to the decision close, flagged)."""
        if not self.enabled:
            return 0
        with self._lock:
            done: list[tuple[Candle, float | None, datetime]] = [(a.candle(), None, now) for a in self._cur.values()]
            self._cur.clear()
            n = len(self._handle(done, now))
            self._snapshot(now)
            return n

    def _snapshot(self, now: datetime) -> None:
        """Record the book's equity once a minute: the equity curve. Nothing before the first snapshot is invented."""
        minute = now.astimezone(UTC).replace(second=0, microsecond=0)
        if self._last_eq_minute == minute:
            return
        self._last_eq_minute = minute
        cash, equity = self.store.cash_equity(self.cfg)
        self.store.record_equity(now, now.astimezone(IST).date().isoformat(), equity, cash, len(self.store.open_rows()))

    # ------------------------------------------------------------------ rules on completed candles
    def _handle(self, done: list[tuple[Candle, float | None, datetime]], now: datetime) -> list[Any]:
        profile = self._profile()
        for c, _, _ in done:
            self.store.record_bar(c)
        rows = {r["symbol"]: r for r in self.store.open_rows()}
        # 1. open positions first: an exit frees a slot for an entry decided on the same minute
        for c, nxt, at in done:
            r = rows.get(c.symbol)
            if r is not None:
                self._position(c, r, nxt, at, now)
        # 2. entries, best score first (the evening run's order)
        for c, nxt, at in sorted(done, key=lambda x: (-(self._orders[x[0].symbol].score if x[0].symbol in self._orders else 0.0), x[0].symbol)):
            o = self._orders.get(c.symbol)
            if o is not None and c.symbol not in rows:
                self._entry(c, o, nxt, at, now, profile)
        return done

    @staticmethod
    def _read_at(session: str, minute_of_day: int | None) -> str | None:
        """When the latest reading of a stock was taken: the session date and the minute of the candle it was decided on (IST), as an ISO time."""
        if minute_of_day is None:
            return None
        return datetime.combine(date.fromisoformat(session), datetime.min.time(), tzinfo=IST).replace(hour=minute_of_day // 60, minute=minute_of_day % 60).isoformat()

    def _fill_price(self, c: Candle, nxt: float | None, at: datetime) -> tuple[float, str]:
        """The next candle's open: the first poll after the decision. A poll more than one minute late, or none (the close), is flagged."""
        if nxt is None:
            return c.c, "decision close (market closed)"
        late = _mins(at) - c.start_min > 1
        return nxt, "next open (late: the feed skipped a minute)" if late else "next open"

    def _position(self, c: Candle, row: dict[str, Any], nxt: float | None, at: datetime, now: datetime) -> None:
        pos = ShadowPos(row["symbol"], row["session"], row["fill"], row["shares"], row["initial_sl"], row["tsl"], row["hh_close"], row["atr14"], row["pivot"], bool(row["d1_checked"]))
        st = step(pos, c, self.cfg)
        if st.exit_reason:
            px, basis = self._fill_price(c, nxt, at)
            self.store.close_fill(row["id"], price=px, at=at, session=c.session, reason=st.exit_reason, basis=basis, cfg=self.cfg)
            self.store.add_event(c.session, at, c.symbol, "exit", px, {"reason": st.exit_reason, "notes": list(st.notes), "decision_close": c.c, "basis": basis, "stop_in_force": pos.tsl})
            log_event(logger, logging.INFO, "swing_minute_exit", symbol=c.symbol, reason=st.exit_reason)
            return
        self.store.update_position(row["id"], st.pos, c.c, at)
        for n in st.notes:
            self.store.add_event(c.session, at, c.symbol, "ratchet", st.pos.tsl, {"note": n})

    def _entry(self, c: Candle, o: Order, nxt: float | None, at: datetime, now: datetime, profile: dict[int, float] | None) -> None:
        chk = check_entry(o, c, profile)
        state, note = chk.state, chk.note
        reading = {"state": state, "note": note, "pace": chk.pace, "close": c.c, "at": c.decision_min}
        if chk.state == "signal":
            blocked = self._blocked(o, c)
            if blocked:
                state, note = "signal_blocked", blocked
                reading |= {"state": state, "note": note}
        self._last[c.symbol] = reading
        prev = self.store.last_state(c.session, c.symbol)
        if prev is None or prev.get("state") != state:
            self.store.add_event(c.session, at, c.symbol, "entry_state", c.c, {"state": state, "note": note, "pace": chk.pace, "candle_close": c.c})
        if state != "signal":
            return
        px, basis = self._fill_price(c, nxt, at)
        if nxt is None or "late" in basis:
            self.store.add_event(c.session, at, c.symbol, "entry_cancelled", px, {"reason": "no fresh next-candle price (feed gap or market closed)", "basis": basis})
            return
        if px > o.trigger * CHASE_CAP:
            self.store.add_event(c.session, at, c.symbol, "entry_cancelled", px, {"reason": f"next candle opened {px:.2f}, more than 1% above the trigger {o.trigger:.2f}: not chased"})
            return
        if px - o.initial_sl <= 0:
            self.store.add_event(c.session, at, c.symbol, "entry_cancelled", px, {"reason": "the stop is not below the fill price"})
            return
        cash, equity = self.store.cash_equity(self.cfg)
        shares = position_size(equity, cash, px, o.initial_sl, self.cfg)
        if shares < 1:
            self.store.add_event(c.session, at, c.symbol, "entry_cancelled", px, {"reason": "not enough cash for one share"})
            return
        fid = self.store.add_fill(session=c.session, symbol=c.symbol, order_session=o.session, rank=o.rank, score=o.score, signal_at=at, filled_at=at, fill=px, shares=shares,
                                  trigger=o.trigger, pivot=o.pivot, initial_sl=o.initial_sl, atr14=o.atr14, equity=equity,
                                  evidence=f"{note}; filled {px:.2f} at the next candle's open ({basis}); trigger {o.trigger:.2f}, stop {o.initial_sl:.2f}")
        if fid is not None:
            self.store.add_event(c.session, at, c.symbol, "entry_fill", px, {"shares": shares, "trigger": o.trigger, "stop": o.initial_sl, "decision_close": c.c, "pace": chk.pace})
            log_event(logger, logging.INFO, "swing_minute_fill", symbol=c.symbol, price=px, shares=shares)

    def _blocked(self, o: Order, c: Candle) -> str | None:
        if any(f["symbol"] == c.symbol for f in self.store.fills_of(c.session)):
            return "the shadow book already took this stock today"
        if len(self.store.open_rows()) >= self.cfg.slots:
            return f"all {self.cfg.slots} slots of the shadow book are in use"
        cutoff = date.fromisoformat(c.session)
        for _ in range(self.cfg.cooldown - 1):
            cutoff = self._prev(cutoff)
        if self.store.exited_since(c.symbol, cutoff.isoformat()):
            return f"{self.cfg.cooldown}-session cooldown after the last exit"
        return None

    # ------------------------------------------------------------------ after the evening settlement
    def settled(self, session: str, decisions: Sequence[Decision], trades: Sequence[Trade], now: datetime | None = None) -> dict[str, int]:
        """Compare what the official daily-bar book did in ``session`` with what this book did. Stored, never applied to either book."""
        now = now or datetime.now(UTC)
        fills = {f["symbol"]: f for f in self.store.fills_of(session)}
        entries: list[dict[str, Any]] = []
        for d in decisions:
            sym = d.order.symbol
            f = fills.get(sym)
            hist = self.store.state_history(session, sym)
            official = f"filled {d.fill:.2f} x {d.shares}" if d.outcome == "filled" and d.fill is not None else f"skipped: {d.reason}"
            if d.outcome != "filled" and "already holding" in (d.reason or ""):
                official += " (the official book bought it earlier; the live book is separate and decides on its own)"
            in_window = [h for h in hist if h != "outside_window"]
            if f is not None:
                shadow = f"filled {f['fill']:.2f} x {f['shares']} at {_hhmm(f['filled_at'])}"
            elif in_window:
                shadow = f"not bought: last reading inside the entry window was {in_window[-1].replace('_', ' ')}"
            elif hist:
                shadow = "not bought: no candle inside the entry window (09:30-15:00)"
            else:
                shadow = "no data (the feed delivered no candle for this order)"
            diff = None if f is None or d.fill is None or not d.fill else round((f["fill"] / d.fill - 1) * 100, 2)
            entries.append({"symbol": sym, "rank": d.order.rank, "official": official, "shadow": shadow, "official_filled": d.outcome == "filled", "shadow_filled": f is not None,
                            "same": (d.outcome == "filled") == (f is not None), "fill_diff_pct": diff, "states": hist[-4:]})
        exits: list[dict[str, Any]] = []
        closed = {(f["symbol"], f["session"]): f for f in self.store.rows(500) if f["status"] == "closed"}
        for t in trades:
            if t.exit_session != session:
                continue
            f = closed.get((t.symbol, t.entry_session))
            exits.append({"symbol": t.symbol, "official": f"{t.reason} at {t.exit:.2f}", "shadow": None if f is None else f"{f['exit_reason']} at {f['exit_price']:.2f} ({_hhmm(f['exit_at'])})",
                          "shadow_took_it": f is not None,
                          "exit_diff_pct": None if f is None or not t.exit else round((f["exit_price"] / t.exit - 1) * 100, 2)})
        summary = {"orders": len(entries), "both_filled": sum(1 for e in entries if e["official_filled"] and e["shadow_filled"]), "only_official": sum(1 for e in entries if e["official_filled"] and not e["shadow_filled"]),
                   "only_shadow": sum(1 for e in entries if e["shadow_filled"] and not e["official_filled"]), "neither": sum(1 for e in entries if not e["official_filled"] and not e["shadow_filled"]), "exits_compared": len(exits)}
        self.store.save_comparison(session, now, {"entries": entries, "exits": exits, "summary": summary})
        return summary

    # ------------------------------------------------------------------ for the page
    def view(self, now: datetime | None = None, market_open: bool = False) -> dict[str, Any]:
        now = now or datetime.now(UTC)
        session = now.astimezone(IST).date().isoformat()
        cash, equity = self.store.cash_equity(self.cfg)
        profile = self._profile()
        rows = self.store.rows(300)
        open_ = [r for r in rows if r["status"] == "open"]
        closed = [r for r in rows if r["status"] == "closed"]
        pos_out = []
        for r in open_:
            risk = r["fill"] - r["initial_sl"]
            gain_r = (r["hh_close"] - r["fill"]) / risk if risk > 0 else None
            px = r["last_price"] or r["fill"]
            lv = {"level_1_8r": r["fill"] + self.cfg.be_r * risk, "level_2_5r": r["fill"] + self.cfg.trail_r * risk, "reached_1_8r": r["hh_close"] >= r["fill"] + self.cfg.be_r * risk,
                  "reached_2_5r": r["hh_close"] >= r["fill"] + self.cfg.trail_r * risk, "to_stop_pct": (r["tsl"] / px - 1) * 100 if px else None}
            pos_out.append(r | lv | {"r_now": None if risk <= 0 else (px - r["fill"]) / risk, "stage": "trailing" if gain_r is not None and gain_r >= self.cfg.trail_r else "breakeven" if gain_r is not None and gain_r >= self.cfg.be_r else "initial stop",
                                "unrealized_pnl": (px - r["fill"]) * r["shares"], "evidence": r["evidence"]})
        closed_out = [c | {"r": trade_r(c)} for c in closed]
        series = self.store.equity_series()
        analytics = book_analytics(closed, self.cfg.capital, equity, series)
        first_fill = min((r["filled_at"] for r in rows), default=None)
        frac, basis = expected_fraction(_mins(now), profile)
        stats = self.store.bar_stats(session)
        elapsed = max(0, min(SESSION_MINUTES, _mins(now) - SESSION_OPEN_MIN)) if market_open else SESSION_MINUTES
        with self._lock:
            watching = []
            for sym, o in sorted(self._orders.items(), key=lambda kv: kv[1].rank):
                last = self._last.get(sym) or {}
                st = self.store.last_state(session, sym) or {}
                watching.append({"symbol": sym, "rank": o.rank, "score": o.score, "trigger": o.trigger, "stop": o.initial_sl, "max_open": o.max_open, "min_volume": o.min_volume,
                                 "state": last.get("state") or st.get("state") or "waiting for the first candle", "note": last.get("note") or st.get("note"), "pace": last.get("pace") if last else st.get("pace"),
                                 "last_close": last.get("close"), "read_at": self._read_at(session, last.get("at"))})
        return {
            "mode": "shadow", "enabled": self.enabled, "rules": RULES, "market_open": market_open, "session": session,
            "volume_basis": basis, "expected_share_of_day_now": round(frac, 3), "profile_ready": bool(profile),
            "book": {"cash": round(cash, 2), "equity": round(equity, 2), "capital": self.cfg.capital, "open": len(open_), "closed": len(closed), "slots": self.cfg.slots,
                     "realised_pnl": round(sum(r["pnl"] or 0 for r in closed), 2), "unrealised_pnl": round(sum(p["unrealized_pnl"] for p in pos_out), 2)},
            "positions": pos_out, "watching": watching, "recent_closed": closed[:30], "closed_trades": closed_out, "analytics": analytics,
            "equity_curve": [{"at": a, "equity": v} for a, v in series], "started": {"first_fill_at": first_fill, "equity_recorded_from": series[0][0] if series else None}, "events": self.store.events(session, 80), "comparisons": self.store.comparisons(8),
            "data": {"symbols_with_bars": len(stats), "bars_today": sum(s["bars"] for s in stats.values()), "expected_bars_per_symbol": elapsed,
                     "coverage": {k: (round(v["bars"] / elapsed * 100) if elapsed else None) for k, v in stats.items()}, "last_poll_at": None if self.last_poll_at is None else self.last_poll_at.isoformat(timespec="seconds"),
                     "note": "Candles are built from prices polled every 2 seconds; a minute without a poll has no candle (nothing is filled in)."},
            "windows": {"entry_from": "09:30", "entry_until": "15:00", "day1_check": "15:20", "entry_from_min": ENTRY_FROM_MIN, "entry_until_min": ENTRY_UNTIL_MIN, "d1_min": D1_CHECK_MIN},
            "updated_at": now.astimezone(UTC).isoformat(timespec="seconds"),
        }


def previous_session_default(d: date) -> date:
    x = d - timedelta(days=1)
    while x.weekday() >= 5:
        x -= timedelta(days=1)
    return x
