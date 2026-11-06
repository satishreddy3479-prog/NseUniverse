"""Server-side stop, target and re-entry for the strategy the builder is working on (paper only).

The rules are the same as the browser's ``applyAutomation`` in ``frontend/src/lib/strategy.ts``; a leg is a plain
dict in the shape the app stores. The builder keeps one *running* document on the server; this service checks it
against the live streamed prices every second, whether or not any browser is open, and writes back what happened.
No broker call is made anywhere in this module.
"""

from __future__ import annotations

import asyncio
import logging
import math
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

from app.storage.strategies import StrategyStore

logger = logging.getLogger(__name__)

RUNNING_KIND = "running"
RUNNING_KEY = "active"
IST = timezone(timedelta(hours=5, minutes=30))
Leg = dict[str, Any]


def _tick(v: float) -> float:
    return max(0.05, math.floor(v * 20 + 0.5) / 20)


def _sign(leg: Leg) -> int:
    return 1 if leg.get("action") == "BUY" else -1


def is_exited(leg: Leg) -> bool:
    return leg.get("exitPrice") is not None


def hit_of(leg: Leg, kind: str, price: float) -> bool:
    """Has the price reached the leg's target or stop? A level at or on the wrong side of the entry never fires."""
    lvl = leg.get(kind)
    if lvl is None:
        return False
    up = (kind == "target") == (leg.get("action") == "BUY")  # the premium has to rise to the level
    prem = leg.get("premium")
    trailed = kind == "stop" and bool(leg.get("stopTrailed"))  # a stop that has trailed may sit on the profit side
    if not trailed and prem is not None and (lvl <= prem if up else lvl >= prem):
        return False
    return price >= lvl if up else price <= lvl


def _stamp(at: datetime) -> str:
    return at.astimezone(IST).strftime("%H:%M:%S")


def _money(v: float) -> str:
    return f"{'−' if v < 0 else '+'}₹{round(abs(v)):,}"


def _stop_ref(leg: Leg) -> float | None:
    """The stop as the user set it (before any trailing)."""
    base = leg.get("stopBase")
    return base if base is not None else leg.get("stop")


def exit_leg(leg: Leg, price: float, reason: str, lot_size: int, at: datetime, mult: float = 1, label: str | None = None) -> Leg:
    prem = leg.get("premium")
    if prem is None or is_exited(leg):
        return leg
    pnl = _sign(leg) * (price - prem) * leg["lots"] * mult * lot_size
    stop_name = "Trailing stop" if leg.get("stopTrailed") else "Stop"
    what = label or {"stop": stop_name, "target": "Target"}.get(reason, "Manual exit")
    text = (
        f"{what}: {leg['action']} {leg['strike']} {leg['type']} closed at {price:.2f} "
        f"(entry {prem:.2f}), {_money(pnl)}"
    )
    out = dict(leg)
    out.update(
        exitPrice=price, exitReason=reason, exitedAt=at.isoformat(), realised=(leg.get("realised") or 0) + pnl,
        reentryLevel=prem if reason == "stop" else None,
        stopPct=abs(_stop_ref(leg) / prem - 1) if _stop_ref(leg) is not None else leg.get("stopPct"),
        targetPct=abs(leg["target"] / prem - 1) if leg.get("target") is not None else leg.get("targetPct"),
        log=[*(leg.get("log") or []), {"at": at.isoformat(), "text": f"{_stamp(at)} {text} [server]"}][-20:],
    )  # fmt: skip
    return out


def reenter_leg(leg: Leg, price: float, at: datetime) -> Leg:
    buy = leg.get("action") == "BUY"

    def lvl(pct: float | None, profit_side: bool) -> float | None:
        return None if pct is None else _tick(price * (1 + pct if profit_side == buy else 1 - pct))

    out = dict(leg)
    out.update(
        premium=price, premiumSource="market", exitPrice=None, exitReason=None, exitedAt=None, reentryLevel=None,
        stop=lvl(leg.get("stopPct"), False), target=lvl(leg.get("targetPct"), True), stopBase=None, stopTrailed=False,
        reentry=max(0, (leg.get("reentry") or 0) - 1), cycles=(leg.get("cycles") or 0) + 1,
        log=[*(leg.get("log") or []),
             {"at": at.isoformat(), "text": f"{_stamp(at)} Re-entry: {leg['action']} {leg['strike']} {leg['type']} at {price:.2f} [server]"}][-20:],
    )  # fmt: skip
    return out


def trail_leg(leg: Leg, px: float) -> Leg:
    """Percentage trailing stop: every full ``trailEvery`` % of the ENTRY premium the leg moves in your favour moves the stop
    ``trailBy`` % of the entry premium in your favour from the stop you set. The stop only tightens."""
    every, by, prem, stop = leg.get("trailEvery"), leg.get("trailBy"), leg.get("premium"), leg.get("stop")
    if not every or every <= 0 or not by or by <= 0 or by > every or prem is None or prem <= 0 or stop is None or is_exited(leg):
        return leg
    base = (leg.get("stopBase") if leg.get("stopBase") is not None else stop) if leg.get("stopTrailed") else stop
    buy = leg.get("action") == "BUY"
    gain = ((px - prem) if buy else (prem - px)) / prem
    steps = math.floor(gain * 100 / every + 1e-9)
    if steps < 1:
        return leg
    nxt = _tick(base + (1 if buy else -1) * steps * (by / 100) * prem)
    if not (nxt > stop if buy else nxt < stop):
        return leg
    return {**leg, "stopBase": base, "stopTrailed": True, "stop": nxt}


def rules_problem(rules: dict[str, Any]) -> bool:
    """True when the lock-and-trail setting cannot work (it is then ignored, never half-applied): locking at or above the
    level reached would exit at once, and a floor rising faster than the profit would too. Mirrors ``rulesProblem``."""
    at, lock = rules.get("lockAt"), rules.get("lockProfit")
    every, by = rules.get("trailEvery"), rules.get("trailBy")
    if (at is None) != (lock is None):
        return True
    if at is not None and lock is not None and not (at > 0 and 0 <= lock < at):
        return True
    if (every is None) != (by is None):
        return True
    if every is not None and by is not None and not (every > 0 and 0 < by <= every):
        return True
    return every is not None and at is None


def lock_floor(rules: dict[str, Any], pnl: float) -> float | None:
    if rules_problem(rules):
        return None
    lock_at, lock_profit = rules.get("lockAt"), rules.get("lockProfit")
    if lock_at is None or lock_profit is None or pnl < lock_at:
        return None
    every, by = rules.get("trailEvery"), rules.get("trailBy")
    extra = math.floor((pnl - lock_at) / every + 1e-9) * by if every and by else 0
    return lock_profit + extra


def has_rules(rules: dict[str, Any] | None) -> bool:
    return bool(rules) and any(v is not None for v in (rules or {}).values())


def apply_strategy_rules(
    legs: list[Leg], rules: dict[str, Any], state: dict[str, Any], price_of: Callable[[Leg], float | None],
    lot_size: int, at: datetime, mult: float = 1,
) -> tuple[list[Leg], dict[str, Any], list[str]]:
    """Strategy-level stop loss, target and lock-and-trail on the P&L (booked + open), in rupees. Mirrors
    ``applyStrategyRules`` in ``frontend/src/lib/strategy.ts``. A rule that fires closes every open leg at its live price
    (reason ``strategy``: nothing re-enters) and records ``done``. Nothing happens while an open leg has no live price."""
    if state.get("done") or not has_rules(rules):
        return legs, state, []
    live = [lg for lg in legs if lg.get("enabled") is not False]
    if not live:
        return legs, state, []
    total = 0.0
    open_legs = 0
    for lg in live:
        total += lg.get("realised") or 0
        if is_exited(lg):
            continue
        open_legs += 1
        px = price_of(lg)
        if px is None or lg.get("premium") is None:
            return legs, state, []
        total += _sign(lg) * (px - lg["premium"]) * lg["lots"] * mult * lot_size
    if open_legs == 0:
        return legs, state, []
    prev = state.get("floor")
    fl = lock_floor(rules, total)
    floor = fl if fl is not None and (prev is None or fl > prev) else prev
    sl, target = rules.get("sl"), rules.get("target")
    done = label = None
    if sl and sl > 0 and total <= -sl:
        done, label = "sl", f"Strategy stop loss (−₹{round(sl):,})"
    elif target and target > 0 and total >= target:
        done, label = "target", f"Strategy target (+₹{round(target):,})"
    elif floor is not None and total <= floor:
        done, label = "lock", f"Locked profit (floor +₹{round(floor):,})"
    if done is None:
        return (legs, state, []) if floor == prev else (legs, {**state, "floor": floor}, [])
    events: list[str] = []
    out: list[Leg] = []
    for lg in legs:
        if lg.get("enabled") is False:
            out.append(lg)
        elif is_exited(lg):
            out.append({**lg, "reentry": 0})  # a leg waiting to re-enter stays out
        else:
            px = price_of(lg)
            if px is None or not px > 0 or lg.get("premium") is None:
                out.append(lg)
                continue
            n = {**exit_leg(lg, px, "strategy", lot_size, at, mult, label), "reentry": 0}
            events.append(n["log"][-1]["text"])
            out.append(n)
    return out, {"floor": floor, "done": done, "at": at.isoformat(), "pnl": total}, events


def apply_automation(
    legs: list[Leg], price_of: Callable[[Leg], float | None], lot_size: int, at: datetime, mult: float = 1
) -> tuple[list[Leg], list[str]]:
    """One pass of every rule against live prices. Legs without a live price are left alone."""
    events: list[str] = []
    out: list[Leg] = []
    for leg in legs:
        px = price_of(leg) if leg.get("enabled") is not False else None
        if px is None or not px > 0:
            out.append(leg)
            continue
        if not is_exited(leg):
            if leg.get("premium") is None:
                out.append(leg)
                continue
            trailed = trail_leg(leg, px)
            if trailed is not leg:
                events.append(
                    f"{_stamp(at)} Trailing stop {leg['action']} {leg['strike']} {leg['type']}: "
                    f"stop {leg['stop']:.2f} → {trailed['stop']:.2f} (price {px:.2f}) [server]"
                )
                leg = trailed
            kind = "stop" if hit_of(leg, "stop", px) else "target" if hit_of(leg, "target", px) else None
            if kind is None:
                out.append(leg)
                continue
            n = exit_leg(leg, px, kind, lot_size, at, mult)
            events.append(n["log"][-1]["text"])
            out.append(n)
            continue
        if leg.get("exitReason") == "stop" and (leg.get("reentry") or 0) > 0 and leg.get("reentryLevel") is not None:
            back = px <= leg["reentryLevel"] if leg.get("action") == "SELL" else px >= leg["reentryLevel"]
            if back:
                n = reenter_leg(leg, px, at)
                events.append(n["log"][-1]["text"])
                out.append(n)
                continue
        out.append(leg)
    return out, events


def keep_exits(cur: dict[str, Any], doc: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """What the server already did cannot be undone by an old copy. For each leg the browser sends back:
    - a leg the server closed stays closed unless the incoming leg was really entered again (a re-entry sets a new entry price
      and counts a cycle) or the editor asked for a fresh start (a new ``rearmAt``, checked by the caller);
    - a leg with fewer cycles than the server's is an old copy (cycles only ever rise): the server's leg is kept;
    - a trailed stop the old copy still has at its pre-trail level goes back to the trailed level (a trailing stop only tightens).
    Returns the document and a name for every leg that was kept as the server had it."""
    mine = {lg.get("id"): lg for lg in cur.get("legs") or []}
    if not mine:
        return doc, []
    kept: list[str] = []
    legs: list[Leg] = []
    for lg in doc.get("legs") or []:
        old = mine.get(lg.get("id"))
        if old is None:
            legs.append(lg)
            continue
        name = f"{old.get('action')} {old.get('strike')} {old.get('type')}"
        reentered = (lg.get("cycles") or 0) > (old.get("cycles") or 0) or lg.get("premium") != old.get("premium")
        if is_exited(old) and not is_exited(lg) and not reentered:
            legs.append(old)
            kept.append(f"{name} (closed at {old.get('exitPrice')})")
        elif (lg.get("cycles") or 0) < (old.get("cycles") or 0):
            legs.append(old)
            kept.append(f"{name} (entered again {old.get('cycles')} time(s))")
        elif not is_exited(old) and not is_exited(lg) and old.get("stopTrailed") and not lg.get("stopTrailed") and lg.get("stop") == old.get("stopBase"):
            legs.append({**lg, "stop": old.get("stop"), "stopBase": old.get("stopBase"), "stopTrailed": True})
            kept.append(f"{name} (stop trailed to {old.get('stop')})")
        else:
            legs.append(lg)
    return ({**doc, "legs": legs} if kept else doc), kept


class RunningConflict(Exception):
    def __init__(self, current: dict[str, Any] | None) -> None:
        super().__init__("the server's copy changed")
        self.current = current


class StrategyAutomation:
    """Holds the running document and checks it every second against the live prices."""

    def __init__(
        self,
        store: StrategyStore,
        price_of_key: Callable[[str], float | None],
        is_live: Callable[[], bool],
        interval_s: float = 1.0,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.store = store
        self.price_of_key = price_of_key
        self.is_live = is_live
        self.interval_s = interval_s
        self._now = now
        self._lock = threading.Lock()
        self._task: asyncio.Task[None] | None = None
        self.last_check_at: datetime | None = None
        self.last_error: str | None = None
        self.checks = 0

    # ---- the document
    def get(self) -> dict[str, Any] | None:
        return self.store.get(RUNNING_KIND, RUNNING_KEY)

    def put(self, doc: dict[str, Any], base_rev: int | None) -> dict[str, Any]:
        """A browser's edit. Refused when the server changed the document since the browser last saw it."""
        with self._lock:
            cur = self.get()
            cur_rev = int(cur.get("rev", 0)) if cur else 0
            if cur is not None and base_rev != cur_rev:
                raise RunningConflict(cur)
            # the state of the strategy rules (profit floor, which rule fired) belongs to the server; a browser edit only
            # replaces it when it asks for a re-arm (a new ``rearmAt``)
            keep = (cur or {}).get("rstate") if doc.get("rearmAt") == (cur or {}).get("rearmAt") else None
            events = list((cur or {}).get("serverEvents", []))
            if cur is not None and doc.get("rearmAt") == cur.get("rearmAt"):
                doc, kept = keep_exits(cur, doc)
                if kept:
                    at = self._now()
                    events = [*events, *({"at": at.isoformat(), "text": f"{_stamp(at)} Ignored an old copy of {t}: the server had already moved on (a re-entry changes the entry price; a reset needs the Reset button)"} for t in kept)][-50:]
            doc = {**doc, "rev": cur_rev + 1, "serverEvents": events, "rstate": keep}
            self.store.put(RUNNING_KIND, RUNNING_KEY, doc)
            return doc

    # ---- one evaluation
    def check_once(self) -> list[str]:
        at = self._now()
        self.last_check_at = at
        self.checks += 1
        with self._lock:
            doc = self.get()
            if not doc or not doc.get("auto") or not doc.get("legs") or not self.is_live():
                return []
            lot = doc.get("lotSize")
            exp = doc.get("expiry")
            if not lot or (exp and exp < at.astimezone(IST).date().isoformat()):
                return []
            price = lambda lg: self.price_of_key(lg["key"]) if lg.get("key") else None  # noqa: E731
            mult = float(doc.get("mult") or 1)
            legs, events = apply_automation(doc["legs"], price, int(lot), at, mult)
            rstate = doc.get("rstate") or {}
            legs, new_state, rule_events = apply_strategy_rules(legs, doc.get("rules") or {}, rstate, price, int(lot), at, mult)
            events = [*events, *rule_events]
            if not events and new_state == rstate:
                return []
            ev = [*(doc.get("serverEvents") or []), *({"at": at.isoformat(), "text": t} for t in events)][-50:]
            self.store.put(
                RUNNING_KIND, RUNNING_KEY,
                {**doc, "legs": legs, "rstate": new_state, "rev": int(doc.get("rev", 0)) + 1, "serverEvents": ev},
            )
            logger.info("strategy_automation", extra={"fields": {"events": events}})
            return events

    async def _run(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self.check_once)
                self.last_error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"{type(exc).__name__}: {exc}"[:200]
                logger.warning("strategy_automation_error", extra={"fields": {"error": self.last_error}})
            await asyncio.sleep(self.interval_s)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
