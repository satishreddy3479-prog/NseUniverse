"""Entry Lab: what would a short-straddle entry rule have made on the days we recorded? (pure functions, no I/O)

A rule (entry time, exit time, optional stop, target and re-strike distance) is replayed minute by minute on each recorded session and booked from the stored last traded prices.
The lab is a measuring bench, not a forecaster: it shows median, mean, worst day and win rate with the number of days behind them, a resampled 95% range, what happens when any one
day is left out, and it says plainly when there are too few days to call anything a finding. It reuses no live state: the same days and the same rule always give the same numbers.

Booking, per position (a short ATM straddle, the call and the put of the strike nearest spot at the moment it is opened):
  profit = premium at entry - premium at exit, in index points (x lot size for rupees); the premium is the call's plus the put's last traded price;
  costs are an assumption: ``cost`` points for the entry and the final exit together and ``roll_cost`` for every re-strike (0.5 point per leg per trade, 2.0 per round trip), no bid/ask;
  a stop or target is checked against the CURRENT position's entry premium (a re-strike resets it), and after a stop or a target the day is flat (no re-entry);
  a minute in which the held strike has no price repeats the last known premium (never zero).
"""

from __future__ import annotations

import random
import statistics
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, time
from typing import Any
from zoneinfo import ZoneInfo

from app.intraday.volatility import CALL, PUT

IST = ZoneInfo("Asia/Kolkata")
MIN_DAYS = 20  # fewer days than this: the numbers describe those days, they are not a finding
MIN_HOLD_SAMPLES = 5
BOOTSTRAP = 2000
LOT = 65


@dataclass(frozen=True)
class Rule:
    """One way of entering and managing a short ATM straddle. Times are IST."""

    entry: time = time(9, 45)
    exit: time = time(15, 15)
    stop_pct: float | None = None  # exit when the premium is this many percent above the current position's entry premium
    target_pct: float | None = None  # exit when the premium is this many percent below it
    roll_pts: float | None = None  # re-strike to the nearest strike when spot is this many points from the held strike
    cost: float = 2.0  # points for the entry and the final exit together
    roll_cost: float = 2.0  # points per re-strike (close the old pair, open the new)

    def label(self) -> str:
        parts = [f"entry {self.entry:%H:%M}", f"exit {self.exit:%H:%M}"]
        if self.stop_pct is not None:
            parts.append(f"stop +{self.stop_pct:g}%")
        if self.target_pct is not None:
            parts.append(f"target -{self.target_pct:g}%")
        if self.roll_pts is not None:
            parts.append(f"re-strike {self.roll_pts:g} pts")
        return ", ".join(parts)


@dataclass(frozen=True)
class Day:
    """One recorded session: for each stored minute the index level and the last traded prices ``{(strike, side): price}``."""

    day: str  # IST date
    dte: int  # calendar days to the expiry of the chain that was recorded
    times: Sequence[datetime]
    spots: Sequence[float]
    prices: Sequence[Mapping[tuple[float, int], float]]


def premium(prices: Mapping[tuple[float, int], float], strike: float) -> float | None:
    c, p = prices.get((strike, CALL)), prices.get((strike, PUT))
    return None if c is None or p is None else c + p


def nearest_strike(prices: Mapping[tuple[float, int], float], spot: float) -> float | None:
    """The strike nearest ``spot`` that has both a call and a put price (the lower one on a tie)."""
    strikes = sorted({k for k, _ in prices if premium(prices, k) is not None})
    return min(strikes, key=lambda k: (abs(k - spot), k)) if strikes else None


def simulate(rule: Rule, day: Day) -> dict[str, Any]:
    """Replay ``rule`` on ``day``. ``skipped`` carries the reason when there is nothing to book (no entry minute, too short a hold, no price)."""
    n = len(day.times)
    hm = [(t.astimezone(IST).hour, t.astimezone(IST).minute) for t in day.times]
    i0 = next((i for i in range(n) if hm[i] >= (rule.entry.hour, rule.entry.minute)), None)
    ie = max((i for i in range(n) if hm[i] <= (rule.exit.hour, rule.exit.minute)), default=None)
    base: dict[str, Any] = {"day": day.day, "dte": day.dte}
    if i0 is None or ie is None or ie < i0 + MIN_HOLD_SAMPLES:
        return base | {"skipped": "no entry minute or too short a hold"}
    k = nearest_strike(day.prices[i0], day.spots[i0])
    entry = None if k is None else premium(day.prices[i0], k)
    if k is None or entry is None:
        return base | {"skipped": "no price for the strike at the entry minute"}
    first_premium, strike0 = entry, k
    realised, last, restrikes = 0.0, entry, 0
    running_min = running_max = 0.0
    reason, exit_at = "time", day.times[i0]
    for i in range(i0 + 1, ie + 1):
        cur = premium(day.prices[i], k)
        cur = last if cur is None else cur
        last = cur
        if rule.roll_pts is not None and abs(day.spots[i] - k) >= rule.roll_pts:
            nk = nearest_strike(day.prices[i], day.spots[i])
            new = None if nk is None else premium(day.prices[i], nk)
            if nk is not None and new is not None and nk != k:
                realised += entry - cur - rule.roll_cost
                k, entry, last, restrikes = nk, new, new, restrikes + 1
                cur = new
        open_pnl = realised + entry - cur
        running_min, running_max = min(running_min, open_pnl), max(running_max, open_pnl)
        exit_at = day.times[i]
        if rule.stop_pct is not None and cur >= entry * (1 + rule.stop_pct / 100):
            reason = "stop"
            break
        if rule.target_pct is not None and cur <= entry * (1 - rule.target_pct / 100):
            reason = "target"
            break
    gross = realised + entry - last
    net = gross - rule.cost
    return base | {"skipped": None, "strike": strike0, "entry_premium": round(first_premium, 2), "entry_spot": round(day.spots[i0], 2), "gross": round(gross, 2), "net": round(net, 2),
                   "max_adverse": round(-running_min, 2), "max_favourable": round(running_max, 2), "restrikes": restrikes, "exit_reason": reason, "exit_at": exit_at.astimezone(IST).strftime("%H:%M"),
                   "spot_move": round(day.spots[min(ie, n - 1)] - day.spots[i0], 2)}  # fmt: skip


def _interval(values: Sequence[float], stat: Callable[[Sequence[float]], float], seed: int) -> list[float] | None:
    """A 95% range of ``stat`` from resampling the DAYS with replacement (deterministic). None below five days."""
    if len(values) < 5:
        return None
    rng = random.Random(seed)  # noqa: S311 - resampling days, not security
    draws = sorted(stat([values[rng.randrange(len(values))] for _ in values]) for _ in range(BOOTSTRAP))
    return [round(draws[int(0.025 * BOOTSTRAP)], 2), round(draws[int(0.975 * BOOTSTRAP) - 1], 2)]


def summarise(rule: Rule, results: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Statistics of one rule over the days it traded. Net of the assumed costs unless a name says gross."""
    used = [r for r in results if not r.get("skipped")]
    nets = [float(r["net"]) for r in used]
    out: dict[str, Any] = {"rule": rule.label(), "days": len(used), "skipped": len(results) - len(used), "sufficient": len(used) >= MIN_DAYS, "min_days": MIN_DAYS}
    if not used:
        return out | {"message": "No day could be replayed with this rule."}
    wins = sum(1 for x in nets if x > 0)
    out |= {"mean": round(statistics.mean(nets), 2), "median": round(statistics.median(nets), 2), "win_pct": round(wins / len(nets) * 100, 1), "worst": round(min(nets), 2), "best": round(max(nets), 2),
            "stdev": round(statistics.pstdev(nets), 2) if len(nets) > 1 else None, "mean_gross": round(statistics.mean(float(r["gross"]) for r in used), 2),
            "mean_max_adverse": round(statistics.mean(float(r["max_adverse"]) for r in used), 2), "mean_restrikes": round(statistics.mean(int(r["restrikes"]) for r in used), 2),
            "mean_entry_premium": round(statistics.mean(float(r["entry_premium"]) for r in used), 2), "total": round(sum(nets), 2), "rupees_per_lot_total": round(sum(nets) * LOT)}  # fmt: skip
    out["mean_range95"] = _interval(nets, statistics.mean, 11)
    out["median_range95"] = _interval(nets, statistics.median, 12)
    if len(nets) >= 3:  # leave one day out: how much any single day carries
        means = [statistics.mean(nets[:i] + nets[i + 1 :]) for i in range(len(nets))]
        lo, hi = min(means), max(means)
        drop = used[means.index(hi)]["day"]  # the mean is highest when this day (the worst) is left out
        out["leave_one_out"] = {"mean_min": round(lo, 2), "mean_max": round(hi, 2), "most_influential_day": drop, "swing": round(hi - lo, 2)}
    out["by_dte"] = {
        "expiry day": _bucket([r for r in used if int(r["dte"]) == 0]),
        "1-2 days": _bucket([r for r in used if 1 <= int(r["dte"]) <= 2]),
        "3+ days": _bucket([r for r in used if int(r["dte"]) >= 3]),
    }
    out["message"] = (f"{len(used)} days replayed: a description of those days, not evidence of an edge (at least {MIN_DAYS} days are needed before a number here is called a finding)."
                      if len(used) < MIN_DAYS else f"{len(used)} days replayed. Still in-sample and before bid/ask: check the range and the leave-one-out line before trusting the mean.")  # fmt: skip
    return out


def _bucket(rs: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    nets = [float(r["net"]) for r in rs]
    if not nets:
        return {"days": 0}
    return {"days": len(nets), "mean": round(statistics.mean(nets), 2), "median": round(statistics.median(nets), 2), "win_pct": round(sum(1 for x in nets if x > 0) / len(nets) * 100, 1), "worst": round(min(nets), 2)}


def run(rule: Rule, days: Sequence[Day]) -> dict[str, Any]:
    results = [simulate(rule, d) for d in days]
    return {"summary": summarise(rule, results), "days": results}


# ------------------------------------------------------------------ comparisons across rules
ENTRY_TIMES = [time(9, 20), time(9, 30), time(9, 45), time(10, 0), time(10, 30), time(11, 0), time(11, 30), time(12, 0), time(12, 30), time(13, 0), time(13, 30), time(14, 0), time(14, 30)]
ROLLS: list[float | None] = [None, 50.0, 75.0, 100.0, 150.0]
STOPS: list[float | None] = [None, 20.0, 30.0, 50.0]


def sweep(base: Rule, field: str, values: Sequence[Any], days: Sequence[Day]) -> list[dict[str, Any]]:
    """The same rule with one parameter changed; every row is a full summary, so a lucky peak cannot hide the neighbours that did worse."""
    rows = []
    for v in values:
        r = replace(base, **{field: v})
        s = summarise(r, [simulate(r, d) for d in days])
        s["value"] = v.strftime("%H:%M") if isinstance(v, time) else v
        rows.append(s)
    return rows


def presets(base: Rule, days: Sequence[Day]) -> dict[str, Any]:
    """The three standard sweeps around ``base``, with the number of variants tried: more variants make a lucky one more likely."""
    entry = sweep(base, "entry", ENTRY_TIMES, days)
    roll = sweep(base, "roll_pts", ROLLS, days)
    stop = sweep(base, "stop_pct", STOPS, days)
    return {"entry_time": entry, "re_strike": roll, "stop": stop, "variants_tried": len(entry) + len(roll) + len(stop),
            "note": "Every variant is judged on the same days. The more variants are tried, the more likely one looks good by luck: prefer a range of neighbouring values that all work to a single best one."}  # fmt: skip
