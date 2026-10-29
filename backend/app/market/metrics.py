"""Breadth, contribution, relative volume, move quality and sector metrics (pure functions, no I/O).

Definitions are fixed in docs/market-breadth-plan.md. Every function treats a missing price or volume
as missing: such a stock is *not covered* (never "flat", never zero) and the coverage is reported next to
every result so a partial universe cannot pass for a full one.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

FLAT_BAND_PCT = 0.05  # |change| <= 0.05 % counts as flat
MAX_TICK_AGE_S = 300.0  # a tick older than 5 minutes during the session is stale, hence not covered
AT_EXTREME_TOL = 1e-4  # "at session high/low": within 0.01 % of it
SESSION_MINUTES = 375


@dataclass(frozen=True)
class Stock:
    symbol: str
    sector: str | None = None
    #: percent of the index (free-float market-cap weight); None = not loaded
    weight: float | None = None


@dataclass(frozen=True)
class StockTick:
    symbol: str
    ltp: float | None
    prev_close: float | None
    volume: int | None = None
    high: float | None = None
    low: float | None = None
    at: datetime | None = None


def change_pct(t: StockTick | None) -> float | None:
    """Change since the previous close in percent; None unless both prices are valid."""
    if t is None or t.ltp is None or t.prev_close is None or t.ltp <= 0 or t.prev_close <= 0:
        return None
    return (t.ltp / t.prev_close - 1) * 100


def direction(chg: float) -> str:
    return "adv" if chg > FLAT_BAND_PCT else "dec" if chg < -FLAT_BAND_PCT else "flat"


def _fresh(t: StockTick | None, now: datetime | None, max_age_s: float) -> bool:
    if t is None:
        return False
    if now is None or t.at is None:
        return True
    return (now - t.at).total_seconds() <= max_age_s


def usable(
    universe: Sequence[Stock],
    ticks: Mapping[str, StockTick],
    now: datetime | None = None,
    max_age_s: float = MAX_TICK_AGE_S,
) -> dict[str, float]:
    """symbol -> change % for every stock with a valid, fresh tick."""
    out: dict[str, float] = {}
    for s in universe:
        t = ticks.get(s.symbol)
        if not _fresh(t, now, max_age_s):
            continue
        c = change_pct(t)
        if c is not None:
            out[s.symbol] = c
    return out


@dataclass
class Breadth:
    total: int
    covered: int
    advancing: int = 0
    declining: int = 0
    flat: int = 0
    ad_ratio: float | None = None
    #: (adv - dec) / (adv + dec), -1..+1; None when nothing moved
    ad_balance: float | None = None
    pct_advancing: float | None = None
    equal_weight_return: float | None = None
    at_high: int = 0
    at_low: int = 0
    pct_at_high: float | None = None
    pct_at_low: float | None = None
    gainers: list[tuple[str, float]] = field(default_factory=list)
    losers: list[tuple[str, float]] = field(default_factory=list)

    @property
    def coverage(self) -> float:
        return self.covered / self.total if self.total else 0.0

    def public(self) -> dict[str, Any]:
        return {**self.__dict__, "coverage": self.coverage}


def breadth(
    universe: Sequence[Stock],
    ticks: Mapping[str, StockTick],
    now: datetime | None = None,
    max_age_s: float = MAX_TICK_AGE_S,
) -> Breadth:
    chg = usable(universe, ticks, now, max_age_s)
    b = Breadth(total=len(universe), covered=len(chg))
    if not chg:
        return b
    for sym, c in chg.items():
        d = direction(c)
        if d == "adv":
            b.advancing += 1
        elif d == "dec":
            b.declining += 1
        else:
            b.flat += 1
        t = ticks[sym]
        if t.high and t.ltp is not None and t.ltp >= t.high * (1 - AT_EXTREME_TOL):
            b.at_high += 1
        if t.low and t.ltp is not None and t.ltp <= t.low * (1 + AT_EXTREME_TOL):
            b.at_low += 1
    b.ad_ratio = None if b.declining == 0 else b.advancing / b.declining
    moved = b.advancing + b.declining
    b.ad_balance = None if moved == 0 else (b.advancing - b.declining) / moved
    b.pct_advancing = b.advancing / b.covered * 100
    b.equal_weight_return = sum(chg.values()) / b.covered
    b.pct_at_high, b.pct_at_low = b.at_high / b.covered * 100, b.at_low / b.covered * 100
    ranked = sorted(chg.items(), key=lambda kv: kv[1])
    b.losers = [(s, round(c, 3)) for s, c in ranked[:5] if c < 0]
    b.gainers = [(s, round(c, 3)) for s, c in reversed(ranked[-5:]) if c > 0]
    return b


@dataclass
class Contribution:
    weight_covered: float  # percent of the index whose stocks have a valid price
    weight_loaded: float  # percent of the index for which weights are loaded
    cap_weight_return: float | None  # sum(w * chg) / sum(w) over covered stocks with weights
    net_points_pct: (
        float | None
    )  # sum(w/100 * chg): contribution to the index return, in percentage points
    top: list[tuple[str, float]] = field(
        default_factory=list
    )  # symbol, contribution in percentage points
    top5_share: float | None = None
    top10_share: float | None = None
    stocks_for_half: int | None = None

    def public(self) -> dict[str, Any]:
        return dict(self.__dict__)


def contributions(
    universe: Sequence[Stock],
    ticks: Mapping[str, StockTick],
    now: datetime | None = None,
    max_age_s: float = MAX_TICK_AGE_S,
) -> Contribution | None:
    """Who carried the index. None when no weights are loaded (nothing is guessed)."""
    weighted = [s for s in universe if s.weight is not None and s.weight > 0]
    if not weighted:
        return None
    chg = usable(weighted, ticks, now, max_age_s)
    w_loaded = sum(s.weight for s in weighted if s.weight is not None)
    cov = [s for s in weighted if s.symbol in chg]
    w_cov = sum(s.weight for s in cov if s.weight is not None)
    c = Contribution(
        weight_covered=w_cov, weight_loaded=w_loaded, cap_weight_return=None, net_points_pct=None
    )
    if not cov or w_cov <= 0:
        return c
    pts = {s.symbol: (s.weight or 0.0) / 100 * chg[s.symbol] for s in cov}
    net = sum(pts.values())
    c.net_points_pct = net
    c.cap_weight_return = sum((s.weight or 0.0) * chg[s.symbol] for s in cov) / w_cov
    c.top = [(k, round(v, 4)) for k, v in sorted(pts.items(), key=lambda kv: -abs(kv[1]))[:10]]
    if net != 0:
        same = (
            sorted((v for v in pts.values() if v * net > 0), reverse=True)
            if net > 0
            else sorted(v for v in pts.values() if v * net > 0)
        )
        # same-direction contributions, largest first (for a falling index, the most negative first)
        c.top5_share = sum(same[:5]) / net
        c.top10_share = sum(same[:10]) / net
        run, k = 0.0, 0
        for v in same:
            run += v
            k += 1
            if run / net >= 0.5:
                c.stocks_for_half = k
                break
    return c


@dataclass
class Volume:
    covered: int
    weighted_rv: (
        float | None
    )  # weight-weighted relative volume (sum w*rv / sum w); equal weights if none are loaded
    reference: str  # "profile" (typical intraday profile) or "linear" (share of the session elapsed; front-loaded volume biases it high)
    up_volume_share: float | None  # volume of advancing stocks / (advancing + declining)
    low_volume_names: list[str] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return dict(self.__dict__)


def relative_volume(
    universe: Sequence[Stock],
    ticks: Mapping[str, StockTick],
    avg_daily_volume: Mapping[str, float],
    elapsed_minutes: float,
    profile_fraction: float | None = None,
    now: datetime | None = None,
    max_age_s: float = MAX_TICK_AGE_S,
) -> Volume | None:
    """Volume done so far against what is normal by this time (20-day average x the elapsed share).

    The elapsed share is the intraday profile when one exists, otherwise the share of session time
    (``reference='linear'``). Real volume is front-loaded, so the linear reference over-states
    relative volume early on: it can show "thin" reliably but cannot confirm "strong".
    """
    if elapsed_minutes < 15:
        return None
    frac = (
        profile_fraction
        if profile_fraction is not None
        else min(1.0, elapsed_minutes / SESSION_MINUTES)
    )
    ref = "profile" if profile_fraction is not None else "linear"
    chg = usable(universe, ticks, now, max_age_s)
    num = den = 0.0
    n = 0
    low: list[str] = []
    up_v = dn_v = 0.0
    for s in universe:
        t = ticks.get(s.symbol)
        avg = avg_daily_volume.get(s.symbol)
        if t is None or t.volume is None or not avg or avg <= 0 or s.symbol not in chg:
            continue
        rv = t.volume / (avg * frac)
        w = s.weight if s.weight else 1.0
        num += w * rv
        den += w
        n += 1
        if rv < 0.7:
            low.append(s.symbol)
        d = direction(chg[s.symbol])
        if d == "adv":
            up_v += t.volume
        elif d == "dec":
            dn_v += t.volume
    if n == 0 or den == 0:
        return None
    share = up_v / (up_v + dn_v) if (up_v + dn_v) > 0 else None
    return Volume(n, num / den, ref, share, sorted(low)[:10])


def move_quality(
    index_change: float | None, b: Breadth | None, c: Contribution | None, v: Volume | None
) -> dict[str, Any]:
    """Provisional reading of whether the index move is real. Thresholds are NOT validated."""
    reasons: list[str] = []
    if index_change is None or b is None or b.covered < 0.7 * b.total:
        return {
            "state": "unknown",
            "reasons": ["too few stocks have a valid price to judge breadth"],
            "provisional": True,
        }
    if abs(index_change) < 0.15:
        return {
            "state": "no_move",
            "reasons": [f"the index is only {index_change:+.2f}% from the previous close"],
            "provisional": True,
        }
    sign = 1 if index_change > 0 else -1
    agree = (b.advancing if sign > 0 else b.declining) / b.covered * 100
    narrow = False
    if c is not None and c.top5_share is not None and c.top5_share > 0.6 and agree < 50:
        narrow = True
        reasons.append(
            f"the top 5 stocks explain {c.top5_share * 100:.0f}% of the move and only {agree:.0f}% of stocks agree"
        )
    thin = v is not None and v.weighted_rv is not None and v.weighted_rv < 0.7
    if thin and v is not None:
        reasons.append(
            f"volume is {v.weighted_rv:.2f}x normal for this time ({v.reference} reference)"
        )
    gap = None
    if c is not None and c.cap_weight_return is not None and b.equal_weight_return is not None:
        gap = abs(c.cap_weight_return - b.equal_weight_return)
    broad = agree >= 65 and (b.equal_weight_return or 0) * sign > 0 and (gap is None or gap <= 0.15)
    vol_ok = (
        v is not None
        and v.reference == "profile"
        and v.weighted_rv is not None
        and v.weighted_rv >= 1.0
    )
    if narrow:
        state = "narrow"
    elif thin:
        state = "thin"
    elif broad:
        state = "broad_confirmed" if vol_ok else "broad"
        reasons.append(f"{agree:.0f}% of covered stocks move with the index")
        reasons.append(
            "volume confirms it"
            if vol_ok
            else "volume could not confirm it (no intraday profile yet)"
            if v is not None
            else "no volume data"
        )
    else:
        state = "mixed"
        reasons.append(
            f"{agree:.0f}% of covered stocks move with the index; no clear broad or narrow pattern"
        )
    return {"state": state, "reasons": reasons, "provisional": True}


# --------------------------------------------------------------------------------- sectors


@dataclass
class SectorRow:
    sector: str
    stocks: int
    covered: int
    advancing: int
    declining: int
    equal_weight_return: float | None
    cap_weight_return: float | None = None
    contribution_pts: float | None = None
    index_return: float | None = None  # the sector's own index, when streamed
    relative_strength: float | None = None
    rank: int | None = None
    weighted_rv: float | None = None

    def public(self) -> dict[str, Any]:
        return dict(self.__dict__)


def sector_table(
    universe: Sequence[Stock],
    ticks: Mapping[str, StockTick],
    benchmark_change: float | None,
    sector_index_change: Mapping[str, float] | None = None,
    avg_daily_volume: Mapping[str, float] | None = None,
    elapsed_minutes: float = 0.0,
    now: datetime | None = None,
    min_covered: int = 2,
) -> list[SectorRow]:
    """One row per sector, ranked by relative strength (return minus the benchmark's)."""
    groups: dict[str, list[Stock]] = {}
    for s in universe:
        groups.setdefault(s.sector or "Unclassified", []).append(s)
    rows: list[SectorRow] = []
    for name, members in groups.items():
        chg = usable(members, ticks, now)
        adv = sum(1 for c in chg.values() if direction(c) == "adv")
        dec = sum(1 for c in chg.values() if direction(c) == "dec")
        row = SectorRow(name, len(members), len(chg), adv, dec, None)
        if len(chg) >= min_covered:
            row.equal_weight_return = sum(chg.values()) / len(chg)
            ws = [(m.weight, chg[m.symbol]) for m in members if m.symbol in chg and m.weight]
            if ws:
                tw = sum(w for w, _ in ws)
                row.cap_weight_return = sum(w * c for w, c in ws) / tw
                row.contribution_pts = sum(w / 100 * c for w, c in ws)
            if avg_daily_volume is not None and elapsed_minutes >= 15:
                v = relative_volume(members, ticks, avg_daily_volume, elapsed_minutes, None, now)
                row.weighted_rv = None if v is None else v.weighted_rv
        if sector_index_change and name in sector_index_change:
            row.index_return = sector_index_change[name]
        best = (
            row.index_return
            if row.index_return is not None
            else row.cap_weight_return
            if row.cap_weight_return is not None
            else row.equal_weight_return
        )
        if best is not None and benchmark_change is not None:
            row.relative_strength = best - benchmark_change
        rows.append(row)
    rows.sort(key=lambda r: (r.relative_strength is None, -(r.relative_strength or 0.0)))
    rank = 0
    for r in rows:
        if r.relative_strength is not None:
            rank += 1
            r.rank = rank
    return rows


def rotation(
    previous: Mapping[str, int], current: Sequence[SectorRow], min_move: int = 2
) -> list[dict[str, Any]]:
    """Sectors whose rank moved by at least ``min_move`` places since ``previous`` (sector -> rank)."""
    out = []
    for r in current:
        p = previous.get(r.sector)
        if r.rank is None or p is None:
            continue
        if abs(p - r.rank) >= min_move:
            out.append(
                {
                    "sector": r.sector,
                    "from_rank": p,
                    "to_rank": r.rank,
                    "direction": "up" if r.rank < p else "down",
                }
            )
    return sorted(out, key=lambda x: -abs(x["from_rank"] - x["to_rank"]))


def finite(v: float | None) -> float | None:
    return v if v is not None and math.isfinite(v) else None
