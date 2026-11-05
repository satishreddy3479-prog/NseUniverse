"""Live checks for the swing paper trader: pure functions on one live tick (no I/O, no clock of their own).

They answer, for a stock the paper book cares about: has the entry trigger been reached on enough volume,
has the stop been breached, how far is the price from the stop and from the 1.8R / 2.5R levels.
They never change the book. The same rules as the end-of-day settlement, applied to live prices.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time
from zoneinfo import ZoneInfo

from app.stream.models import LiveTick
from app.swing.engine import Config, Order, Position

IST = ZoneInfo("Asia/Kolkata")
OPEN, CLOSE = time(9, 15), time(15, 30)
SESSION_MINUTES = 375  # 09:15 to 15:30
PACE_FLOOR = 0.05  # in the first minutes the elapsed share is tiny: do not divide by it
MIN_JUDGE_FRACTION = 30 / SESSION_MINUTES  # before 09:45 the opening rush makes a straight-line pace meaningless


def session_state(now: datetime) -> str:
    """'open' during the regular session on a weekday, else 'closed' (holidays are not known)."""
    t = now.astimezone(IST)
    return "open" if t.weekday() < 5 and OPEN <= t.time() < CLOSE else "closed"


def session_fraction(now: datetime) -> float:
    """Share of the regular session that has elapsed (0 before the open, 1 from the close)."""
    t = now.astimezone(IST)
    minutes = t.hour * 60 + t.minute + t.second / 60 - (9 * 60 + 15)
    return min(1.0, max(0.0, minutes / SESSION_MINUTES))


def volume_pace(volume: int | None, min_volume: float, now: datetime) -> float | None:
    """Day volume so far against the minimum volume, scaled by how much of the session has passed.

    1.0 means volume is running exactly at the pace needed to reach the full-day minimum by the close
    (a straight-line approximation: real volume is heavier near the open and the close).
    """
    if volume is None or min_volume <= 0:
        return None
    return volume / (min_volume * max(PACE_FLOOR, session_fraction(now)))


@dataclass(frozen=True)
class EntryCheck:
    state: str  # no_data | gap_skip | triggered | volume_short | volume_early | waiting
    note: str
    pace: float | None


def check_entry(order: Order, tick: LiveTick | None, now: datetime) -> EntryCheck:
    if tick is None or tick.ltp is None:
        return EntryCheck("no_data", "no live price yet", None)
    pace = volume_pace(tick.volume, order.min_volume, now)
    if tick.open is not None and tick.open > order.max_open:
        return EntryCheck(
            "gap_skip", f"opened {tick.open:.2f}, above the no-chase limit {order.max_open:.2f}", pace
        )
    if tick.ltp >= order.trigger:
        if pace is None:
            return EntryCheck("volume_short", "price is through the trigger, but no volume is reported", pace)
        if session_fraction(now) < MIN_JUDGE_FRACTION:
            return EntryCheck(
                "volume_early", "price is through the trigger; too early in the session (before 09:45) to judge volume", pace
            )
        if pace >= 1.0:
            return EntryCheck(
                "triggered", "price through the trigger and volume on pace (the full-day volume is judged at the close)", pace
            )
        return EntryCheck(
            "volume_short",
            f"price is through the trigger, but volume is only {pace:.0%} of the pace needed "
            "(the rule needs the day's volume to reach 1.25 x its 20-day average)",
            pace,
        )
    return EntryCheck("waiting", f"{(order.trigger / tick.ltp - 1) * 100:.2f}% below the trigger", pace)


@dataclass(frozen=True)
class PositionCheck:
    ltp: float | None
    r_now: float | None  # profit so far in multiples of the initial risk
    level_1_8r: float
    level_2_5r: float
    reached_1_8r: bool  # by today's high or the high since entry
    reached_2_5r: bool
    stop: float
    stop_hit: bool
    stop_exit_price: float | None  # where a stop order would fill: the stop, or the open if it gapped through


def check_position(p: Position, tick: LiveTick | None, cfg: Config) -> PositionCheck:
    risk = p.r
    l18, l25 = p.fill + cfg.be_r * risk, p.fill + cfg.trail_r * risk
    ltp = tick.ltp if tick else None
    high = max(p.hh, tick.high or 0.0) if tick else p.hh
    hit = bool(tick and ((ltp is not None and ltp <= p.tsl) or (tick.low is not None and tick.low <= p.tsl)))
    exit_px = None
    if hit and tick is not None:
        exit_px = tick.open if (tick.open is not None and tick.open <= p.tsl) else p.tsl
    return PositionCheck(
        ltp=ltp, r_now=None if ltp is None or risk <= 0 else (ltp - p.fill) / risk, level_1_8r=l18, level_2_5r=l25,
        reached_1_8r=high >= l18, reached_2_5r=high >= l25, stop=p.tsl, stop_hit=hit, stop_exit_price=exit_px,
    )
