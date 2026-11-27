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
import time as time_module
from collections.abc import Callable
from datetime import UTC, date, datetime, time, timedelta, timezone
from typing import Any

from app.domain.session import SESSION_OPEN, session_close, spot_end
from app.storage.strategies import StrategyStore

logger = logging.getLogger(__name__)

RUNNING_KIND = "running"
RUNNING_KEY = "active"
IST = timezone(timedelta(hours=5, minutes=30))
_IST_ZONE = IST
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
    return bool(price >= lvl if up else price <= lvl)


def _stamp(at: datetime) -> str:
    return at.astimezone(IST).strftime("%d %b, %H:%M:%S")  # with the date: "16 Nov, 10:34:38"


def _name(leg: Leg) -> str:
    """How a leg is named in the log: "25800 CE", or "NIFTY future"."""
    return "NIFTY future" if leg.get("type") == "FUT" else f"{leg.get('strike')} {leg.get('type')}"


def _money(v: float) -> str:
    return f"{'−' if v < 0 else '+'}₹{round(abs(v)):,}"


def _stop_ref(leg: Leg) -> float | None:
    """The stop as the user set it (before any trailing). A stop the app moved to cost on a leg that had none is not one the user set: nothing."""
    base = leg.get("stopBase")
    if base is not None:
        return float(base)
    return None if leg.get("stopTrailed") else leg.get("stop")


def exit_leg(leg: Leg, price: float, reason: str, lot_size: int, at: datetime, mult: float = 1, label: str | None = None) -> Leg:
    prem = leg.get("premium")
    if prem is None or is_exited(leg):
        return leg
    pnl = _sign(leg) * (price - prem) * leg["lots"] * mult * lot_size
    stop_name = "Stop at cost" if leg.get("costMoved") else "Trailing stop" if leg.get("stopTrailed") else "Stop"
    what = label or {"stop": stop_name, "target": "Target"}.get(reason, "Manual exit")
    text = (
        f"{what}: {leg['action']} {_name(leg)} closed at {price:.2f} "
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
        premium=price, premiumSource="market", exitPrice=None, exitReason=None, exitedAt=None, reentryLevel=None, enteredAt=at.isoformat(),
        stop=lvl(leg.get("stopPct"), False), target=lvl(leg.get("targetPct"), True), stopBase=None, stopTrailed=False, costMoved=False,
        stopSetAt=None if leg.get("stopPct") is None else at.isoformat(), targetSetAt=None if leg.get("targetPct") is None else at.isoformat(),
        reentry=max(0, (leg.get("reentry") or 0) - 1), cycles=(leg.get("cycles") or 0) + 1,
        log=[*(leg.get("log") or []),
             {"at": at.isoformat(), "text": f"{_stamp(at)} Re-entry: {leg['action']} {_name(leg)} at {price:.2f} [server]"}][-20:],
    )  # fmt: skip
    return out


def _trail_logged(old: Leg, new: Leg, px: float, at: datetime) -> Leg:
    """A trailed leg with the move written in its log and the time the stop moved."""
    if new is old:
        return old
    text = f"{_stamp(at)} Trailing stop: {old['action']} {_name(old)} stop {old['stop']:.2f} → {new['stop']:.2f} (price {px:.2f}) [server]"
    return {**new, "stopSetAt": at.isoformat(), "log": [*(new.get("log") or []), {"at": at.isoformat(), "text": text}][-20:]}


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
    return float(lock_profit + extra)


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


# ---- managed straddle: when NIFTY is ``points`` away from the held strike, close the pair and open the new at-the-money pair
RESTRIKE_MAX_POINTS = 2000.0
RESTRIKE_SPOT_KEY = "nse_cm|Nifty 50"  # the NIFTY 50 index in the live feed; the server reads the spot from here, never from a page
LADDER_TTL_S = 300.0
Ladder = list[dict[str, Any]]


def restrike_problem(cfg: Any) -> bool:
    """True when the re-strike setting cannot work (it is then ignored, never half-applied): no distance, or one outside 0 to 2,000 points."""
    if not isinstance(cfg, dict):
        return True
    points = cfg.get("points")
    return not isinstance(points, (int, float)) or isinstance(points, bool) or not 0 < points <= RESTRIKE_MAX_POINTS


def clean_restrike(raw: Any) -> dict[str, Any] | None:
    """What the server keeps of a page's re-strike setting: the distance and nothing else (the strikes and their feed keys are the server's own)."""
    if not isinstance(raw, dict) or restrike_problem(raw):
        return None
    return {"points": float(raw["points"])}


def ladder_from_snapshot(snap: Any) -> Ladder:
    """The strikes of a stored option chain that have both a call and a put in the live feed, with the feed keys ("nse_fo|<token>") of the two. Ascending."""
    out: Ladder = []
    for row in getattr(snap, "rows", None) or []:
        ce, pe = row.call, row.put
        if row.strike is None or ce is None or pe is None:
            continue
        if not (ce.exchange_segment and ce.instrument_token and pe.exchange_segment and pe.instrument_token):
            continue
        out.append({"strike": float(row.strike), "ce": f"{ce.exchange_segment}|{ce.instrument_token}", "pe": f"{pe.exchange_segment}|{pe.instrument_token}"})
    return sorted(out, key=lambda r: r["strike"])


def roll_leg_to(leg: Leg, strike: float, key: str, old_price: float, new_price: float, lot_size: int, at: datetime, mult: float = 1) -> Leg:
    """Close a leg at its live price (its profit or loss is booked in ``realised``) and open the same leg at another strike at its live price. The stop and
    target keep their percentage distance from the new entry. Mirrors ``rollLeg`` in ``frontend/src/lib/strategy.ts``."""
    prem = leg["premium"]
    pnl = _sign(leg) * (old_price - prem) * leg["lots"] * mult * lot_size
    buy = leg.get("action") == "BUY"

    def pct(level: float | None) -> float | None:
        return None if level is None else abs(level / prem - 1)

    def lvl(p: float | None, profit_side: bool) -> float | None:
        return None if p is None else _tick(new_price * (1 + p if profit_side == buy else 1 - p))

    stop_typed = _stop_ref(leg)
    text = (
        f"{_stamp(at)} Re-strike: {leg['action']} {leg.get('strike'):g} {leg.get('type')} closed at {old_price:.2f} (entry {prem:.2f}), {_money(pnl)} booked; "
        f"{leg['action']} {strike:g} {leg.get('type')} opened at {new_price:.2f} [server]"
    )
    out = dict(leg)
    out.update(
        strike=strike, key=key, premium=new_price, premiumSource="market", realised=(leg.get("realised") or 0) + pnl, cycles=(leg.get("cycles") or 0) + 1,
        stop=lvl(pct(stop_typed), False), target=lvl(pct(leg.get("target")), True), stopBase=None, stopTrailed=False, costMoved=False,
        exitPrice=None, exitReason=None, exitedAt=None, reentryLevel=None, enteredAt=at.isoformat(),
        stopSetAt=None if stop_typed is None else at.isoformat(), targetSetAt=None if leg.get("target") is None else at.isoformat(),
        log=[*(leg.get("log") or []), {"at": at.isoformat(), "text": text}][-20:],
    )  # fmt: skip
    return out


def apply_restrike(
    legs: list[Leg], cfg: dict[str, Any] | None, price_of: Callable[[Leg], float | None], ladder_of: Callable[[str], Ladder], lot_size: int, at: datetime,
    mult: float = 1,
) -> tuple[list[Leg], list[str]]:
    """The managed straddle (paper only). While every ticked option leg is open and they all sit on one strike, and NIFTY is ``points`` or more
    away from that strike, every leg is closed at its live price (profit or loss booked) and opened again on the strike nearest to NIFTY at its
    live price. Everything comes from the server: the distance from the stored setting, the spot from the live index, the strikes and their feed
    keys from the stored chain of the legs' expiry (``ladder_of``). All or nothing: with no live price for NIFTY or for one of the contracts
    nothing moves. Only while the index is being collected (09:15 to the end of continuous cash trading: after it the index shows indicative auction
    values). A leg that is closed (a stop or a target) or a position that is not one strike (the page was edited) is left alone: the rule needs the pair intact."""
    if restrike_problem(cfg):
        return legs, []
    assert cfg is not None
    local = at.astimezone(_IST_ZONE)
    end = spot_end(local.date())
    if local.time() < SESSION_OPEN or (end is not None and local.time() >= end):
        return legs, []
    live = [lg for lg in legs if lg.get("enabled") is not False and lg.get("type") in ("CE", "PE")]
    if not live or any(is_exited(lg) or lg.get("premium") is None for lg in live):
        return legs, []
    held = {(lg.get("expiry"), lg.get("strike")) for lg in live}
    if len(held) != 1:
        return legs, []
    strike = float(live[0]["strike"])
    spot = price_of({"key": RESTRIKE_SPOT_KEY})
    if spot is None or not spot > 0 or abs(spot - strike) < float(cfg["points"]):
        return legs, []
    ladder = ladder_of(str(live[0].get("expiry")))
    if not ladder:
        return legs, []
    rung = min(ladder, key=lambda r: (abs(float(r["strike"]) - spot), float(r["strike"])))
    new_strike = float(rung["strike"])
    if new_strike == strike:
        return legs, []
    moves: dict[int, tuple[str, float, float]] = {}
    for i, lg in enumerate(legs):
        if lg not in live:
            continue
        new_key = rung["ce"] if lg["type"] == "CE" else rung["pe"]
        old_px, new_px = price_of(lg), price_of({"key": new_key})
        if old_px is None or new_px is None or not old_px > 0 or not new_px > 0:
            return legs, []
        moves[i] = (str(new_key), float(old_px), float(new_px))
    out: list[Leg] = []
    events: list[str] = []
    for i, lg in enumerate(legs):
        if i not in moves:
            out.append(lg)
            continue
        new_key, old_px, new_px = moves[i]
        n = roll_leg_to(lg, new_strike, new_key, old_px, new_px, lot_size, at, mult)
        events.append(n["log"][-1]["text"])
        out.append(n)
    return out, events


# ---- holding period: intraday (close every open leg at a set time of day) or overnight (hold to expiry, close at that time on expiry day)
DEFAULT_HOLD: dict[str, Any] = {"mode": "overnight", "closeAt": "15:20"}


def _hhmm(text: Any) -> time | None:
    try:
        h, m = str(text).split(":")
        return time(int(h), int(m)) if len(h) == 2 and len(m) == 2 else None
    except ValueError:
        return None


def hold_problem(hold: dict[str, Any] | None) -> str | None:
    """Why a holding rule cannot be used, or None. The close time has to lie inside the session (09:15 to the close: 15:40, 15:45 from 7 Dec 2026)."""
    h = hold or DEFAULT_HOLD
    if h.get("mode") not in ("intraday", "overnight", "manual"):
        return "Choose intraday, overnight or manual."
    t = _hhmm(h.get("closeAt", "15:20"))
    if t is None or not time(9, 15) < t <= session_close():
        return f"The close time has to be a time inside the session (09:15-{session_close():%H:%M}), for example 15:20."
    return None


def _at_ist(day: date, t: time) -> datetime:
    return datetime.combine(day, t, tzinfo=IST)


def hold_moment(hold: dict[str, Any] | None, held_from: datetime, expiry: str | None) -> datetime | None:
    """When the holding rule closes a leg. Intraday: the first close time after the strategy was armed (weekends skipped, so a strategy
    armed on a Friday evening closes on Monday). Overnight: the close time on the leg's expiry day, unless it was armed after that."""
    h = hold or DEFAULT_HOLD
    if hold_problem(h) or h.get("mode") == "manual":
        return None
    t = _hhmm(h.get("closeAt", "15:20")) or time(15, 20)
    if h["mode"] == "overnight":
        if not expiry:
            return None
        m = _at_ist(date.fromisoformat(expiry), t)
        return m if m > held_from else None
    day = held_from.astimezone(IST).date()
    m = _at_ist(day, t)
    while m <= held_from or m.weekday() >= 5:
        day += timedelta(days=1)
        m = _at_ist(day, t)
    return m


def apply_hold(
    legs: list[Leg], hold: dict[str, Any] | None, held_from: datetime | None, price_of: Callable[[Leg], float | None],
    lot_size: int, at: datetime, mult: float = 1,
) -> tuple[list[Leg], list[str]]:
    """Close the open legs whose holding time has come, at their live price (reason ``strategy``: nothing re-enters). Mirrors
    ``applyHold`` in ``frontend/src/lib/strategy.ts``. A leg without a live price stays open and is tried again on the next check."""
    if held_from is None:
        return legs, []
    h = hold or DEFAULT_HOLD
    label = f"Auto close ({'intraday' if h.get('mode') == 'intraday' else 'expiry day'} {h.get('closeAt', '15:20')})"
    out: list[Leg] = []
    events: list[str] = []
    for lg in legs:
        m = hold_moment(h, held_from, lg.get("expiry"))
        if lg.get("enabled") is False or m is None or at < m:
            out.append(lg)
        elif is_exited(lg):
            out.append({**lg, "reentry": 0} if (lg.get("reentry") or 0) else lg)  # a stopped leg waiting to re-enter is not entered after the close
        else:
            px = price_of(lg)
            if px is None or not px > 0 or lg.get("premium") is None:
                out.append(lg)
                continue
            n = {**exit_leg(lg, px, "strategy", lot_size, at, mult, label), "reentry": 0}
            events.append(n["log"][-1]["text"])
            out.append(n)
    return out, events


def move_stops_to_cost(
    legs: list[Leg], stopped: list[Leg], price_of: Callable[[Leg], float | None], at: datetime
) -> tuple[list[Leg], list[str]]:
    """"Move SL to cost". When a leg is stopped out, the stop of every OTHER open leg on the same side (buy or sell) moves to that leg's
    own entry premium. Only a leg that is in profit at that moment is moved (a stop at the entry of a leg already in loss would exit it at
    once); a leg without a live price, or not in profit, is left as it is and the event says so. The stop only ever tightens. The moved stop
    is a trailed one (it may sit at the entry) and the stop the user typed is remembered. Mirrors ``moveStopsToCost`` in
    frontend/src/lib/strategy.ts; paper only."""
    events: list[str] = []
    if not stopped:
        return legs, events
    sides = {x.get("action") for x in stopped}
    first = stopped[0]
    out: list[Leg] = []
    for lg in legs:
        prem = lg.get("premium")
        if lg.get("enabled") is False or is_exited(lg) or prem is None or lg.get("action") not in sides:
            out.append(lg)
            continue
        buy = lg.get("action") == "BUY"
        who = f"{lg['action']} {_name(lg)}"
        px = price_of(lg)
        if px is None or not px > 0:
            events.append(f"{_stamp(at)} Stop to cost skipped for {who}: no live price [server]")
            out.append(lg)
            continue
        if not (px > prem if buy else px < prem):
            events.append(f"{_stamp(at)} Stop to cost skipped for {who}: it is not in profit (price {px:.2f} against entry {prem:.2f}) [server]")
            out.append(lg)
            continue
        stop = lg.get("stop")
        if stop is not None and (stop >= prem if buy else stop <= prem):
            out.append(lg)  # already at the entry or tighter: never loosened
            continue
        text = (
            f"{_stamp(at)} Stop moved to cost: {who} stop {'none' if stop is None else f'{stop:.2f}'} → {prem:.2f} "
            f"because {first['action']} {_name(first)} was stopped out [server]"
        )
        events.append(text)
        base = lg.get("stopBase")
        moved = {
            **lg, "stopBase": base if base is not None else stop, "stop": prem, "stopTrailed": True, "costMoved": True, "stopSetAt": at.isoformat(),
            "log": [*(lg.get("log") or []), {"at": at.isoformat(), "text": text}][-20:],
        }
        # a leg that had no stop could not trail before; now that it has one the trail is applied in the same pass, so a repeat pass changes nothing
        trailed = _trail_logged(moved, trail_leg(moved, px), px, at)
        if trailed is not moved:
            events.append(f"{_stamp(at)} Trailing stop {who}: stop {moved['stop']:.2f} → {trailed['stop']:.2f} (price {px:.2f}) [server]")
        out.append(trailed)
    return out, events


def apply_automation(
    legs: list[Leg], price_of: Callable[[Leg], float | None], lot_size: int, at: datetime, mult: float = 1,
    move_to_cost: bool = False,
) -> tuple[list[Leg], list[str]]:
    """One pass of every rule against live prices. Legs without a live price are left alone."""
    events: list[str] = []
    out: list[Leg] = []
    stopped_now: list[Leg] = []  # legs this pass closed by their stop
    for leg in legs:
        px = price_of(leg) if leg.get("enabled") is not False else None
        if px is None or not px > 0:
            out.append(leg)
            continue
        if not is_exited(leg):
            if leg.get("premium") is None:
                out.append(leg)
                continue
            trailed = _trail_logged(leg, trail_leg(leg, px), px, at)
            if trailed is not leg:
                events.append(
                    f"{_stamp(at)} Trailing stop {leg['action']} {_name(leg)}: "
                    f"stop {leg['stop']:.2f} → {trailed['stop']:.2f} (price {px:.2f}) [server]"
                )
                leg = trailed
            kind = "stop" if hit_of(leg, "stop", px) else "target" if hit_of(leg, "target", px) else None
            if kind is None:
                out.append(leg)
                continue
            n = exit_leg(leg, px, kind, lot_size, at, mult)
            events.append(n["log"][-1]["text"])
            if kind == "stop":
                stopped_now.append(n)
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
    if move_to_cost and stopped_now:
        out, extra = move_stops_to_cost(out, stopped_now, price_of, at)
        events.extend(extra)
    return out, events


def leg_identity(lg: Leg) -> tuple[Any, ...]:
    """Which contract and side a leg is, independent of the id a browser gave it (two devices open the same strategy under
    different leg ids, which is how an old copy slipped past an id-only check on 9 Nov 2026)."""
    return (lg.get("expiry"), lg.get("strike"), lg.get("type"), lg.get("action"))


def keep_exits(cur: dict[str, Any], doc: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """What the server already did cannot be undone by an old copy. For each leg the browser sends back (matched to the
    server's leg by id, else by contract, side and entry price):
    - a leg the server closed stays closed unless the incoming leg was really entered again (a re-entry sets a new entry price
      and counts a cycle) or the editor asked for a fresh start (a new ``rearmAt``, checked by the caller);
    - a leg with fewer cycles than the server's is an old copy (cycles only ever rise): the server's leg is kept;
    - a trailed stop the old copy still has at its pre-trail level goes back to the trailed level (a trailing stop only tightens).
    Returns the document and a name for every leg that was kept as the server had it."""
    cur_legs: list[Leg] = list(cur.get("legs") or [])
    if not cur_legs:
        return doc, []
    by_id = {lg.get("id"): lg for lg in cur_legs}
    kept: list[str] = []
    legs: list[Leg] = []
    for lg in doc.get("legs") or []:
        old = by_id.get(lg.get("id"))
        if old is None:  # another device's ids: the same contract, side and entry price is the same leg
            old = next((c for c in cur_legs if leg_identity(c) == leg_identity(lg) and c.get("premium") == lg.get("premium")), None)
        if old is None:
            legs.append(lg)
            continue
        name = f"{old.get('action')} {_name(old)}"
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


def leg_signature(lg: Leg) -> tuple[Any, ...] | None:
    """One entered leg of one strategy: contract, side, entry price and the moment of entry. None when the entry time is not recorded (it cannot be told from another entry)."""
    if not lg.get("enteredAt"):
        return None
    return (lg.get("expiry"), lg.get("strike"), lg.get("type"), lg.get("action"), lg.get("premium"), lg.get("enteredAt"))


class RunningConflict(Exception):
    def __init__(self, current: dict[str, Any] | None) -> None:
        super().__init__("the server's copy changed")
        self.current = current


def _parse(text: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00")) if text else None
    except ValueError:
        return None


class StrategyAutomation:
    """Holds the running document and checks it every second against the live prices."""

    def __init__(
        self,
        store: StrategyStore,
        price_of_key: Callable[[str], float | None],
        is_live: Callable[[], bool],
        interval_s: float = 1.0,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        trading_day: Callable[[date], bool | None] | None = None,
        ladder_of: Callable[[str], Ladder] | None = None,
    ) -> None:
        self.trading_day = trading_day
        self._ladder_source = ladder_of
        self._ladders: dict[str, tuple[float, Ladder]] = {}
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
            # Refused only when the LEGS changed on the server since the browser's revision (a stop, target, hold or re-entry it executed). A change of the rule state alone (a
            # trailing profit floor moves the revision every few seconds) is not a conflict: it used to refuse the page's Exit all, which then took the server's open legs back.
            if cur is not None and (base_rev is None or int(cur.get("legsRev", cur_rev)) > base_rev):
                raise RunningConflict(cur)
            self._refuse_closed_legs(cur, doc)
            # the state of the strategy rules (profit floor, which rule fired) belongs to the server; a browser edit only
            # replaces it when it asks for a re-arm (a new ``rearmAt``)
            keep = (cur or {}).get("rstate") if doc.get("rearmAt") == (cur or {}).get("rearmAt") else None
            events = list((cur or {}).get("serverEvents", []))
            if cur is not None and doc.get("rearmAt") == cur.get("rearmAt"):
                doc, kept = keep_exits(cur, doc)
                if kept:
                    at = self._now()
                    events = [*events, *({"at": at.isoformat(), "text": f"{_stamp(at)} Ignored an old copy of {t}: the server had already moved on (a re-entry changes the entry price; a reset needs the Reset button)"} for t in kept)][-50:]
            doc = {**doc, "restrike": clean_restrike(doc.get("restrike"))}  # the distance only: the strikes and keys are the server's own
            # when the holding rule started counting: the browser's value, else the one kept while the rule is unchanged, else now
            same_hold = cur is not None and doc.get("hold") == cur.get("hold") and doc.get("rearmAt") == cur.get("rearmAt")
            hold_from = doc.get("holdFrom") or ((cur or {}).get("holdFrom") if same_hold else None) or self._now().isoformat()
            legs_rev = cur_rev + 1 if cur is None or doc.get("legs") != cur.get("legs") else int(cur.get("legsRev", cur_rev))
            doc = {**doc, "rev": cur_rev + 1, "legsRev": legs_rev, "serverEvents": events, "rstate": keep, "holdFrom": hold_from}
            self.store.put(RUNNING_KIND, RUNNING_KEY, doc)
            return doc

    def _refuse_closed_legs(self, cur: dict[str, Any] | None, doc: dict[str, Any]) -> None:
        """A strategy that was closed cannot come back as the running one. A browser that kept its own copy of a strategy (a phone, a tab left open) writes it back whenever the server's
        running strategy is empty: 20 and 23 Nov 2026 an old straddle with open legs came back after its own close, was valued on old prices, and was shown in the builder again. A leg that
        is still open in the incoming document but is the same entered leg (contract, side, entry price, entry time) as a leg of a Closed strategy is that old copy: refused, and the browser
        takes the server's state (a re-entry or a new trade has a new entry time and passes). The server's own current legs are exempt: they are the running strategy itself."""
        mine = {sig for lg in (cur or {}).get("legs") or [] if (sig := leg_signature(lg)) is not None}
        incoming = [(lg, leg_signature(lg)) for lg in doc.get("legs") or [] if not is_exited(lg)]
        incoming = [(lg, sig) for lg, sig in incoming if sig is not None and sig not in mine]
        if not incoming:
            return
        closed = {sig for item in self.store.list("closed") for lg in item.get("legs") or [] if (sig := leg_signature(lg)) is not None}
        if any(sig in closed for _lg, sig in incoming):
            raise RunningConflict(cur)

    def market_open(self, at: datetime) -> bool:
        """Stops, targets and the hold rule act only inside a real session: a trading day (exchange calendar; weekday when it
        has no entry) between the open and the close. Outside it the stored last prices are not a market: the broker replays the
        previous close on every restart, and acting on it books a fake exit (22 Nov 2026, a Sunday).
        Without a calendar wired in (tests) there is no guard."""
        if self.trading_day is None:
            return True
        t = at.astimezone(IST)
        known = self.trading_day(t.date())
        if known is False or (known is None and t.weekday() >= 5):
            return False
        return SESSION_OPEN <= t.time() <= session_close()

    def _ladder(self, expiry: str) -> Ladder:
        """The strikes and feed keys of an expiry's stored chain, kept for five minutes (a re-strike is rare; reading the chain file is not free)."""
        if self._ladder_source is None:
            return []
        now = time_module.monotonic()
        hit = self._ladders.get(expiry)
        if hit is not None and now - hit[0] < LADDER_TTL_S:
            return hit[1]
        try:
            ladder = self._ladder_source(expiry)
        except Exception as exc:  # noqa: BLE001 - a chain that cannot be read means no re-strike this second, not a failed check
            logger.warning("restrike_ladder_failed", extra={"fields": {"expiry": expiry, "error": type(exc).__name__}})
            return hit[1] if hit is not None else []
        if ladder:
            self._ladders[expiry] = (now, ladder)
        return ladder

    # ---- one evaluation
    def check_once(self) -> list[str]:
        at = self._now()
        self.last_check_at = at
        self.checks += 1
        with self._lock:
            doc = self.get()
            if not doc or not doc.get("auto") or not doc.get("legs") or not self.is_live() or not self.market_open(at):
                return []
            lot = doc.get("lotSize")
            exp = doc.get("expiry")
            if not lot or (exp and exp < at.astimezone(IST).date().isoformat()):
                return []
            price = lambda lg: self.price_of_key(lg["key"]) if lg.get("key") else None  # noqa: E731
            mult = float(doc.get("mult") or 1)
            legs, events = apply_automation(doc["legs"], price, int(lot), at, mult, bool(doc.get("moveToCost")))
            rstate = doc.get("rstate") or {}
            legs, new_state, rule_events = apply_strategy_rules(legs, doc.get("rules") or {}, rstate, price, int(lot), at, mult)
            events = [*events, *rule_events]
            legs, restrike_events = apply_restrike(legs, doc.get("restrike"), price, self._ladder, int(lot), at, mult)
            events = [*events, *restrike_events]
            legs, hold_events = apply_hold(legs, doc.get("hold"), _parse(doc.get("holdFrom")), price, int(lot), at, mult)
            events = [*events, *hold_events]
            if not events and new_state == rstate:
                return []
            ev = [*(doc.get("serverEvents") or []), *({"at": at.isoformat(), "text": t} for t in events)][-50:]
            self.store.put(
                RUNNING_KIND, RUNNING_KEY,
                {
                    **doc, "legs": legs, "rstate": new_state, "rev": int(doc.get("rev", 0)) + 1, "serverEvents": ev,
                    "legsRev": int(doc.get("rev", 0)) + 1 if legs != doc["legs"] else int(doc.get("legsRev", doc.get("rev", 0))),
                },
            )
            self._write_back_saved(doc.get("loaded"), legs, doc.get("expiry"), at)
            logger.info("strategy_automation", extra={"fields": {"events": events}})
            return events

    def pnl_now(self) -> dict[str, Any]:
        """The running strategy's P&L now, from the server's own live prices (so it needs no open page): booked (earlier exits and cycles) plus the open legs
        marked at their live price, before costs, in rupees. ``total`` is None while an open leg has no live price: nothing is guessed. ``running`` is true
        when at least one ticked leg is open and has an entry price. ``live`` is false outside the session, when the prices are the last stored ones."""
        at = self._now()
        doc = self.get()
        out: dict[str, Any] = {"at": at.isoformat(), "running": False, "live": False, "name": None, "booked": None, "open": None, "total": None, "missing": []}
        if not doc or not doc.get("legs"):
            return out
        exp = doc.get("expiry")
        if exp and exp < at.astimezone(IST).date().isoformat():
            return out  # the strategy's last expiry has passed: not running (the server checks skip it too)
        lot = doc.get("lotSize")
        mult = float(doc.get("mult") or 1)
        legs = [lg for lg in doc["legs"] if lg.get("enabled", True) is not False]
        open_legs = [lg for lg in legs if not is_exited(lg) and lg.get("premium") is not None]
        out["name"] = doc.get("loaded") or doc.get("name") or None
        out["running"] = bool(lot and open_legs)
        out["live"] = bool(self.is_live() and self.market_open(at))
        if not lot or not legs:
            return out
        booked = sum(float(lg.get("realised") or 0) for lg in legs)
        live_part = 0.0
        missing: list[str] = []
        for lg in open_legs:
            px = self.price_of_key(lg["key"]) if lg.get("key") else None
            if px is None:
                missing.append(_name(lg))
                continue
            live_part += _sign(lg) * (px - float(lg["premium"])) * float(lg.get("lots") or 0) * mult * int(lot)
        out["booked"] = booked
        out["missing"] = missing
        if not missing:
            out["open"] = live_part
            out["total"] = booked + live_part
        return out

    def _write_back_saved(self, name: Any, legs: list[Leg], expiry: Any, at: datetime) -> None:
        """A stop the server executes is also written to the saved strategy the page has open, as the page does for its own exits:
        a saved copy left with the leg still open would bring the leg back the next time it is opened on any device."""
        if not isinstance(name, str) or not name:
            return
        try:
            saved = self.store.get("saved", name)
            if saved is not None:
                self.store.put("saved", name, {**saved, "legs": legs, "expiry": expiry or saved.get("expiry"), "updatedAt": at.isoformat()})
        except Exception:  # the running document is the authority; a failed copy must not stop the next check
            logger.warning("strategy_saved_write_back_failed")

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
