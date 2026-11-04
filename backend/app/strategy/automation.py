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
    if prem is not None and (lvl <= prem if up else lvl >= prem):
        return False
    return price >= lvl if up else price <= lvl


def _stamp(at: datetime) -> str:
    return at.astimezone(IST).strftime("%H:%M:%S")


def _money(v: float) -> str:
    return f"{'−' if v < 0 else '+'}₹{round(abs(v)):,}"


def exit_leg(leg: Leg, price: float, reason: str, lot_size: int, at: datetime, mult: float = 1) -> Leg:
    prem = leg.get("premium")
    if prem is None or is_exited(leg):
        return leg
    pnl = _sign(leg) * (price - prem) * leg["lots"] * mult * lot_size
    what = {"stop": "Stop", "target": "Target"}.get(reason, "Manual exit")
    text = (
        f"{what}: {leg['action']} {leg['strike']} {leg['type']} closed at {price:.2f} "
        f"(entry {prem:.2f}), {_money(pnl)}"
    )
    out = dict(leg)
    out.update(
        exitPrice=price, exitReason=reason, exitedAt=at.isoformat(), realised=(leg.get("realised") or 0) + pnl,
        reentryLevel=prem if reason == "stop" else None,
        stopPct=abs(leg["stop"] / prem - 1) if leg.get("stop") is not None else leg.get("stopPct"),
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
        stop=lvl(leg.get("stopPct"), False), target=lvl(leg.get("targetPct"), True),
        reentry=max(0, (leg.get("reentry") or 0) - 1), cycles=(leg.get("cycles") or 0) + 1,
        log=[*(leg.get("log") or []),
             {"at": at.isoformat(), "text": f"{_stamp(at)} Re-entry: {leg['action']} {leg['strike']} {leg['type']} at {price:.2f} [server]"}][-20:],
    )  # fmt: skip
    return out


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
            doc = {**doc, "rev": cur_rev + 1, "serverEvents": (cur or {}).get("serverEvents", [])}
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
            legs, events = apply_automation(
                doc["legs"], lambda lg: self.price_of_key(lg["key"]) if lg.get("key") else None, int(lot), at,
                float(doc.get("mult") or 1),
            )  # fmt: skip
            if not events:
                return []
            ev = [*(doc.get("serverEvents") or []), *({"at": at.isoformat(), "text": t} for t in events)][-50:]
            self.store.put(RUNNING_KIND, RUNNING_KEY, {**doc, "legs": legs, "rev": int(doc.get("rev", 0)) + 1, "serverEvents": ev})
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
