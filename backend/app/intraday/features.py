"""Intraday features from real stored observations (pure functions, no I/O).

Inputs are the ~60-second option-chain samples the sampler stores in market hours (each carries the
NIFTY 50 spot at fetch time and every contract's LTP / OI / previous-day OI / volume) plus the daily
bars in market_history. Nothing here invents a candle: price features use the sampled spot points as
they are, and every feature that needs more points than exist returns ``None`` with a reason.

Conventions
* Times are aware datetimes; the session clock is Asia/Kolkata 09:15-15:30.
* "Sampled high/low" are the extremes of the sampled points, not exchange highs/lows (ticks between
  samples are not seen).
* NIFTY 50 is an index and has no traded volume, so a VWAP cannot be computed for it. VWAP is
  reported unavailable rather than approximated.
* Missing values stay ``None`` and are counted; they are never treated as 0.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from statistics import pstdev
from typing import Any, Literal
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
OPEN, CLOSE = time(9, 15), time(15, 30)
SESSION_MINUTES = 375
OPENING_RANGE_MIN = 15
#: a return over h minutes needs an anchor sample no older than h + this many minutes
ANCHOR_SLACK_MIN = 3
RETURN_HORIZONS = (5, 15, 30, 60)

Phase = Literal[
    "closed", "pre_market", "pre_open", "opening", "morning", "midday", "afternoon", "closing",
    "post_market",
]  # fmt: skip
PHASES: list[tuple[time, time, Phase]] = [
    (time(0, 0), time(9, 0), "pre_market"),
    (time(9, 0), time(9, 15), "pre_open"),
    (time(9, 15), time(9, 45), "opening"),
    (time(9, 45), time(11, 30), "morning"),
    (time(11, 30), time(13, 30), "midday"),
    (time(13, 30), time(15, 0), "afternoon"),
    (time(15, 0), time(15, 30), "closing"),
]


def session_phase(now: datetime, is_trading_day: bool | None) -> Phase:
    """Phase of the NSE cash session. ``is_trading_day`` comes from the exchange holiday calendar
    (None = calendar has no answer for that date; the weekday rule is then used and flagged upstream)."""
    t = now.astimezone(IST)
    trading = is_trading_day if is_trading_day is not None else t.weekday() < 5
    if not trading:
        return "closed"
    for lo, hi, ph in PHASES:
        if lo <= t.time() < hi:
            return ph
    return "post_market"


def minutes_elapsed(now: datetime) -> float:
    """Minutes of the regular session elapsed at ``now`` (0 before the open, 375 after the close)."""
    t = now.astimezone(IST)
    start = datetime.combine(t.date(), OPEN, IST)
    return max(0.0, min(SESSION_MINUTES, (t - start).total_seconds() / 60))


@dataclass(frozen=True)
class Point:
    at: datetime
    spot: float


def in_session(points: Sequence[Point], day: date) -> list[Point]:
    """Points of one IST date inside 09:15-15:30, sorted, one per timestamp (first kept)."""
    out: dict[datetime, Point] = {}
    for p in points:
        t = p.at.astimezone(IST)
        if t.date() == day and OPEN <= t.time() <= CLOSE and p.at not in out:
            out[p.at] = p
    return [out[k] for k in sorted(out)]


def as_of(points: Sequence[Point], at: datetime, slack_min: float) -> Point | None:
    """Last point at or before ``at`` that is no older than ``slack_min`` minutes before it."""
    best = None
    for p in points:
        if p.at <= at:
            best = p
        else:
            break
    if best is None or (at - best.at) > timedelta(minutes=slack_min):
        return None
    return best


def resample(points: Sequence[Point], minutes: int) -> list[Point]:
    """Last sample of every ``minutes``-minute bucket of the session (09:15 anchored).

    One-minute paths zigzag even in a clear trend, which makes their efficiency ratio low; thinning
    to 5-minute points measures persistence instead of tick noise.
    """
    out: dict[int, Point] = {}
    for p in points:
        t = p.at.astimezone(IST)
        out[(t.hour * 60 + t.minute - (OPEN.hour * 60 + OPEN.minute)) // minutes] = p
    return [out[k] for k in sorted(out)]


def efficiency_ratio(points: Sequence[Point]) -> float | None:
    """|net move| / sum of |point-to-point moves| in [0, 1]: 1 = straight line, ~0 = back and forth."""
    if len(points) < 3:
        return None
    path = sum(abs(b.spot - a.spot) for a, b in zip(points, points[1:], strict=False))
    if path <= 0:
        return None  # no movement at all: neither trending nor choppy
    return abs(points[-1].spot - points[0].spot) / path


def realized_vol_pct(points: Sequence[Point]) -> float | None:
    """sqrt(sum of squared log returns between consecutive samples), in percent, over the points."""
    if len(points) < 3:
        return None
    s = sum(math.log(b.spot / a.spot) ** 2 for a, b in zip(points, points[1:], strict=False))
    return math.sqrt(s) * 100


@dataclass(frozen=True)
class DailyBar:
    session: date
    open: float
    high: float
    low: float
    close: float


@dataclass
class DailyContext:
    """Previous-session levels and typical move sizes from the stored daily NIFTY 50 bars."""

    prev_session: date | None = None
    prev_high: float | None = None
    prev_low: float | None = None
    prev_close: float | None = None
    #: standard deviation of close-to-close % returns over the last 60 sessions
    daily_sd_pct: float | None = None
    #: mean (high - low) / close in % over the last 14 sessions
    avg_range_pct: float | None = None
    sessions_used: int = 0


def daily_context(bars: Sequence[DailyBar], today: date) -> DailyContext:
    past = [b for b in bars if b.session < today]
    if not past:
        return DailyContext()
    last = past[-1]
    ctx = DailyContext(last.session, last.high, last.low, last.close)
    rets = [(b.close / a.close - 1) * 100 for a, b in zip(past[-61:], past[-60:], strict=False)]
    if len(rets) >= 20:
        ctx.daily_sd_pct = pstdev(rets)
    rng = [(b.high - b.low) / b.close * 100 for b in past[-14:] if b.close > 0]
    if len(rng) >= 5:
        ctx.avg_range_pct = sum(rng) / len(rng)
    ctx.sessions_used = len(rets)
    return ctx


@dataclass
class PriceFeatures:
    samples: int = 0
    last: float | None = None
    last_at: datetime | None = None
    prev_close: float | None = None
    prev_close_source: str | None = None
    change: float | None = None
    change_pct: float | None = None
    first: float | None = None
    first_at: datetime | None = None
    sampled_high: float | None = None
    sampled_low: float | None = None
    or_high: float | None = None
    or_low: float | None = None
    or_samples: int = 0
    gap_pct: float | None = None
    returns_pct: dict[int, float | None] = field(default_factory=dict)
    er_30: float | None = None
    er_session: float | None = None
    #: efficiency ratio of the 5-minute thinned path (persistence of direction, less tick noise)
    er_5m: float | None = None
    #: last / first sample - 1, in percent, and the minutes between them
    net_pct: float | None = None
    net_minutes: float | None = None
    rv_pct: float | None = None
    #: realized vol so far / (typical daily sd scaled to the elapsed time); 1 = normal
    rv_ratio: float | None = None
    range_pct: float | None = None
    range_ratio: float | None = None
    position_in_range: float | None = None
    max_gap_min: float | None = None
    vwap: None = None
    vwap_reason: str = (
        "NIFTY 50 is an index with no traded volume, so a VWAP is not defined for it."
    )

    def public(self) -> dict[str, Any]:
        d = dict(self.__dict__)
        for k in ("last_at", "first_at"):
            d[k] = d[k].isoformat() if d[k] else None
        d["returns_pct"] = {f"{k}m": v for k, v in self.returns_pct.items()}
        return d


def price_features(
    points: Sequence[Point], now: datetime, ctx: DailyContext, feed_prev_close: float | None
) -> PriceFeatures:
    """Features of today's sampled spot path (``points`` already filtered to today's session)."""
    f = PriceFeatures(samples=len(points))
    # the broker's previous close is what the exchange reports; the daily bar is the cross-check
    if feed_prev_close is not None:
        f.prev_close, f.prev_close_source = feed_prev_close, "Kotak feed (previous close)"
    elif ctx.prev_close is not None:
        f.prev_close, f.prev_close_source = ctx.prev_close, f"daily bar {ctx.prev_session}"
    if not points:
        return f
    last, first = points[-1], points[0]
    f.last, f.last_at, f.first, f.first_at = last.spot, last.at, first.spot, first.at
    if f.prev_close:
        f.change = last.spot - f.prev_close
        f.change_pct = f.change / f.prev_close * 100
        f.gap_pct = (first.spot / f.prev_close - 1) * 100
    f.sampled_high = max(p.spot for p in points)
    f.sampled_low = min(p.spot for p in points)
    open_dt = datetime.combine(first.at.astimezone(IST).date(), OPEN, IST)
    orange = [p for p in points if p.at < open_dt + timedelta(minutes=OPENING_RANGE_MIN)]
    f.or_samples = len(orange)
    if len(orange) >= 3:
        f.or_high, f.or_low = max(p.spot for p in orange), min(p.spot for p in orange)
    for h in RETURN_HORIZONS:
        a = as_of(points, last.at - timedelta(minutes=h), ANCHOR_SLACK_MIN)
        f.returns_pct[h] = None if a is None else (last.spot / a.spot - 1) * 100
    f.er_30 = efficiency_ratio([p for p in points if p.at >= last.at - timedelta(minutes=30)])
    f.er_session = efficiency_ratio(points)
    f.er_5m = efficiency_ratio(resample(points, 5))
    f.net_pct = (last.spot / first.spot - 1) * 100 if first.spot else None
    f.net_minutes = (last.at - first.at).total_seconds() / 60
    f.rv_pct = realized_vol_pct(points)
    elapsed = minutes_elapsed(last.at)
    if f.rv_pct is not None and ctx.daily_sd_pct and elapsed >= 15:
        f.rv_ratio = f.rv_pct / (ctx.daily_sd_pct * math.sqrt(elapsed / SESSION_MINUTES))
    if f.prev_close:
        f.range_pct = (f.sampled_high - f.sampled_low) / f.prev_close * 100
        if ctx.avg_range_pct:
            f.range_ratio = f.range_pct / ctx.avg_range_pct
    span = f.sampled_high - f.sampled_low
    f.position_in_range = (last.spot - f.sampled_low) / span if span > 0 else None
    gaps = [(b.at - a.at).total_seconds() / 60 for a, b in zip(points, points[1:], strict=False)]
    f.max_gap_min = max(gaps) if gaps else None
    _ = now
    return f


# ---------------------------------------------------------------------------- options positioning

CALL, PUT = 0, 1


@dataclass(frozen=True)
class Quote:
    ltp: float | None
    oi: int | None
    oi_prev: int | None
    volume: int | None


Chain = dict[tuple[float, int], Quote]


def nearest_strike(strikes: Sequence[float], spot: float) -> float:
    return min(strikes, key=lambda k: (abs(k - spot), k))


def strike_universe(chain: Chain, spot: float | None, each_side: int) -> list[float]:
    """ATM +/- ``each_side`` listed strikes (same rule as /api/oi/change and the dashboard)."""
    ks = sorted({k for k, _ in chain})
    if spot is None or not ks:
        return ks
    i = ks.index(nearest_strike(ks, spot))
    return ks[max(0, i - each_side) : i + each_side + 1]


def _total(vals: list[int | float | None]) -> tuple[float | None, int]:
    have = [v for v in vals if v is not None]
    return (float(sum(have)) if have else None), len(vals) - len(have)


@dataclass
class OptionsFeatures:
    strikes: int = 0
    atm_strike: float | None = None
    ce_oi: float | None = None
    pe_oi: float | None = None
    ce_oi_chg: float | None = None
    pe_oi_chg: float | None = None
    ce_vol: float | None = None
    pe_vol: float | None = None
    pcr_oi: float | None = None
    pcr_vol: float | None = None
    pcr_oi_first: float | None = None
    pcr_oi_change: float | None = None
    straddle: float | None = None
    straddle_first: float | None = None
    straddle_change_pct: float | None = None
    max_ce_oi_strike: float | None = None
    max_pe_oi_strike: float | None = None
    missing: dict[str, int] = field(default_factory=dict)

    def public(self) -> dict[str, Any]:
        return dict(self.__dict__)


def _ratio(a: float | None, b: float | None) -> float | None:
    return None if a is None or b is None or b <= 0 else a / b


def _straddle(chain: Chain, spot: float | None) -> tuple[float | None, float | None]:
    ks = sorted({k for k, _ in chain})
    if spot is None or not ks:
        return None, None
    atm = nearest_strike(ks, spot)
    c, p = chain.get((atm, CALL)), chain.get((atm, PUT))
    if c is None or p is None or c.ltp is None or p.ltp is None:
        return atm, None
    return atm, c.ltp + p.ltp


def options_features(
    chain: Chain,
    spot: float | None,
    first: Chain | None,
    first_spot: float | None,
    each_side: int = 10,
) -> OptionsFeatures:
    """Totals, PCRs and ATM straddle over ATM +/- ``each_side`` strikes.

    OI change = OI now minus the contract's previous-day OI, summed only over contracts that have
    both (missing pairs are counted). PCR = put total / call total. The straddle uses the strike
    nearest to spot at each moment, so its change mixes volatility, time decay and a possible ATM
    shift; it is reported as an observation, not as implied volatility.
    """
    f = OptionsFeatures()
    ks = strike_universe(chain, spot, each_side)
    f.strikes = len(ks)
    if not ks:
        return f
    side = {s: [chain.get((k, s)) for k in ks] for s in (CALL, PUT)}

    def col(s: int, attr: str) -> tuple[float | None, int]:
        return _total([getattr(q, attr) if q else None for q in side[s]])

    (f.ce_oi, m1), (f.pe_oi, m2) = col(CALL, "oi"), col(PUT, "oi")
    (f.ce_vol, m3), (f.pe_vol, m4) = col(CALL, "volume"), col(PUT, "volume")

    def chg(s: int) -> tuple[float | None, int]:
        return _total(
            [
                q.oi - q.oi_prev if q and q.oi is not None and q.oi_prev is not None else None
                for q in side[s]
            ]
        )

    (f.ce_oi_chg, m5), (f.pe_oi_chg, m6) = chg(CALL), chg(PUT)
    f.missing = {"oi": m1 + m2, "volume": m3 + m4, "oi_change": m5 + m6}
    f.pcr_oi, f.pcr_vol = _ratio(f.pe_oi, f.ce_oi), _ratio(f.pe_vol, f.ce_vol)
    f.atm_strike, f.straddle = _straddle(chain, spot)
    oi_ce = [(k, q.oi) for k, q in zip(ks, side[CALL], strict=True) if q and q.oi is not None]
    oi_pe = [(k, q.oi) for k, q in zip(ks, side[PUT], strict=True) if q and q.oi is not None]
    f.max_ce_oi_strike = max(oi_ce, key=lambda x: x[1])[0] if oi_ce else None
    f.max_pe_oi_strike = max(oi_pe, key=lambda x: x[1])[0] if oi_pe else None
    if first is not None:
        fk = strike_universe(first, first_spot, each_side)
        ce0, _ = _total([first[(k, CALL)].oi if (k, CALL) in first else None for k in fk])
        pe0, _ = _total([first[(k, PUT)].oi if (k, PUT) in first else None for k in fk])
        f.pcr_oi_first = _ratio(pe0, ce0)
        if f.pcr_oi is not None and f.pcr_oi_first is not None:
            f.pcr_oi_change = f.pcr_oi - f.pcr_oi_first
        _, f.straddle_first = _straddle(first, first_spot)
        if f.straddle is not None and f.straddle_first:
            f.straddle_change_pct = (f.straddle / f.straddle_first - 1) * 100
    return f
