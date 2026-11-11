"""Swing rules on completed 1-minute candles (pure functions: no I/O, no clock, no broker).

This is the LIVE-style version of the swing rules, run in shadow beside the official end-of-day paper book. Every decision is taken on the
close of a completed 1-minute candle and filled at the OPEN of the next candle (the first price after the decision), never at the close it was
decided on. Agreed rules (11 Nov 2026):

ENTRY, on a candle that closed between 09:30 and 15:00 IST, for an order queued at the previous close:
  * the day's open is at or below the order's no-chase limit (pivot x 1.025);
  * the candle CLOSE is at or above the trigger (pivot x 1.003) and no more than 1 % above it (no chasing);
  * the day's volume so far is at least the minimum volume (1.25 x the 20-day average) scaled by the share of a normal day's volume that
    should have traded by now (the stock volume profile recorded by the app; a straight line when no profile exists yet, and not judged before
    09:45 in that case);
  * a free slot, no open position or fill in the stock, and the 3-session cooldown after its last exit.
  The fill is the open of the next candle; if that is more than 1 % above the trigger the entry is cancelled (no chase).

STOP, tested on every candle close: a candle that closes at or below the stop in force exits at the next candle's open. The stop in force is the
one set by the earlier candles; a new level takes effect from the next candle.

BREAKEVEN / TRAIL, on candle closes (the highest 1-minute CLOSE is the high-water mark):
  * at +1.8R the stop moves to the fill x 1.002;
  * at +2.5R the stop is the highest of itself, the fill x 1.002 and (highest close - 2.5 x ATR14 of the signal day).
  R = fill - initial stop. The official trail's 10-day EMA leg is not used (the shadow book has no daily bars).

DAY 1, on the candle that closes at 15:20 (or the first available after it): exit if the close is below the pivot, or if the close sits in the bottom
35 % of the day's range so far (rejection wick). A close at or below the stop exits at any time of the day.

The shadow book never places an order. Prices come from the live feed polled every two seconds: a candle's open, high, low and close are the first,
highest, lowest and last polled prices of the minute, so a candle can miss a spike shorter than the poll interval.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from app.swing.engine import Config, Order

ENTRY_FROM_MIN = 9 * 60 + 30  # decision time (candle close), minutes since midnight IST
ENTRY_UNTIL_MIN = 15 * 60
D1_CHECK_MIN = 15 * 60 + 20
SESSION_OPEN_MIN = 9 * 60 + 15
SESSION_MINUTES = 375
CHASE_CAP = 1.01  # the fill may be at most this multiple of the trigger
WICK_FRACTION = 0.35
STRAIGHT_LINE_JUDGE_MIN = 9 * 60 + 45  # without a volume profile the straight-line pace is not judged before this
PACE_FLOOR = 0.05


@dataclass(frozen=True)
class Candle:
    """One completed 1-minute candle built from polled prices. ``start_min`` = minutes since midnight IST of its first second."""

    symbol: str
    session: str
    start_min: int
    o: float
    h: float
    low: float
    c: float
    cum_volume: int | None  # the day's volume at the last poll of the minute
    day_open: float | None
    day_high: float | None
    day_low: float | None
    polls: int = 1

    @property
    def decision_min(self) -> int:
        return self.start_min + 1


@dataclass(frozen=True)
class EntryCheck:
    state: str  # gap_skip | outside_window | below_trigger | above_cap | volume_early | volume_short | signal
    note: str
    pace: float | None = None


def expected_fraction(decision_min: int, profile: dict[int, float] | None) -> tuple[float, str]:
    """Share of a normal day's volume that should have traded by ``decision_min``, and where it came from ('profile' or 'straight-line')."""
    elapsed = decision_min - SESSION_OPEN_MIN
    if profile:
        t = int(min(SESSION_MINUTES, max(0, elapsed)))
        for k in range(t, max(-1, t - 6), -1):  # nearest recorded minute at or before t, as the app's profile helper does
            if profile.get(k, 0) > 0:
                return profile[k], "profile"
    return max(PACE_FLOOR, min(1.0, elapsed / SESSION_MINUTES)), "straight-line"


def volume_pace(cum_volume: int | None, min_volume: float, decision_min: int, profile: dict[int, float] | None) -> tuple[float | None, str]:
    """Day volume so far against the minimum volume scaled by the expected share of the day. 1.0 = exactly on pace."""
    if cum_volume is None or min_volume <= 0:
        return None, "none"
    frac, basis = expected_fraction(decision_min, profile)
    return cum_volume / (min_volume * frac), basis


def check_entry(order: Order, c: Candle, profile: dict[int, float] | None) -> EntryCheck:
    """The entry rule on one completed candle (see the module notes). First failing check wins, in this order."""
    if c.day_open is not None and c.day_open > order.max_open:
        return EntryCheck("gap_skip", f"opened {c.day_open:.2f}, above the no-chase limit {order.max_open:.2f}")
    if not ENTRY_FROM_MIN <= c.decision_min <= ENTRY_UNTIL_MIN:
        return EntryCheck("outside_window", "entries are taken only on candles that close between 09:30 and 15:00")
    if c.c < order.trigger:
        return EntryCheck("below_trigger", f"candle close {c.c:.2f} is {(order.trigger / c.c - 1) * 100:.2f}% below the trigger {order.trigger:.2f}")
    if c.c > order.trigger * CHASE_CAP:
        return EntryCheck("above_cap", f"candle close {c.c:.2f} is more than 1% above the trigger {order.trigger:.2f}: not chased")
    pace, basis = volume_pace(c.cum_volume, order.min_volume, c.decision_min, profile)
    if pace is None:
        return EntryCheck("volume_short", "no volume is reported", None)
    if basis == "straight-line" and c.decision_min < STRAIGHT_LINE_JUDGE_MIN:
        return EntryCheck("volume_early", "no volume profile yet and before 09:45: the straight-line pace is not judged", pace)
    if pace < 1.0:
        return EntryCheck("volume_short", f"volume is {pace:.0%} of the pace needed ({basis})", pace)
    return EntryCheck("signal", f"close {c.c:.2f} at or above the trigger {order.trigger:.2f} on volume {pace:.0%} of the pace needed ({basis})", pace)


@dataclass(frozen=True)
class ShadowPos:
    symbol: str
    entry_session: str
    fill: float
    shares: int
    initial_sl: float
    tsl: float
    hh_close: float
    atr14: float
    pivot: float
    d1_checked: bool = False

    @property
    def r(self) -> float:
        return self.fill - self.initial_sl


@dataclass(frozen=True)
class Step:
    pos: ShadowPos
    exit_reason: str | None  # STOP_CLOSE | D1_FAIL_CLOSE | D1_REJECT_WICK
    notes: tuple[str, ...] = ()


def step(pos: ShadowPos, c: Candle, cfg: Config) -> Step:
    """One completed candle applied to an open shadow position: the stop in force first, then the ratchet, then the Day-1 checks."""
    if c.c <= pos.tsl:
        return Step(pos, "STOP_CLOSE", (f"candle close {c.c:.2f} at or below the stop {pos.tsl:.2f}",))
    notes: list[str] = []
    hh = max(pos.hh_close, c.c)
    gain_r = (hh - pos.fill) / pos.r if pos.r > 0 else 0.0
    tsl = pos.tsl
    if gain_r >= cfg.trail_r:
        new = max(tsl, pos.fill * cfg.be_buf, hh - cfg.chand_mult * pos.atr14)
        if new > tsl:
            notes.append(f"trailing stop {tsl:.2f} -> {new:.2f} (highest close {hh:.2f}, {gain_r:.2f}R)")
        tsl = new
    elif gain_r >= cfg.be_r:
        new = max(tsl, pos.fill * cfg.be_buf)
        if new > tsl:
            notes.append(f"stop to breakeven {new:.2f} ({gain_r:.2f}R)")
        tsl = new
    d1 = pos.d1_checked
    if c.session == pos.entry_session and not d1 and c.decision_min >= D1_CHECK_MIN:
        d1 = True
        if c.c < pos.pivot:
            return Step(replace(pos, tsl=tsl, hh_close=hh, d1_checked=True), "D1_FAIL_CLOSE", (f"day-1 close {c.c:.2f} below the pivot {pos.pivot:.2f}",))
        if c.day_high is not None and c.day_low is not None and c.day_high > c.day_low and (c.c - c.day_low) / (c.day_high - c.day_low) < WICK_FRACTION:
            share = (c.c - c.day_low) / (c.day_high - c.day_low)
            return Step(replace(pos, tsl=tsl, hh_close=hh, d1_checked=True), "D1_REJECT_WICK", (f"day-1 close in the bottom {share:.0%} of the day's range",))
    return Step(replace(pos, tsl=tsl, hh_close=hh, d1_checked=d1), None, tuple(notes))
