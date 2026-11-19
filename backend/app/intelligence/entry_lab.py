"""Entry Lab: what would a short-straddle entry rule have made on the days we recorded? (pure functions, no I/O)

A rule (entry time, exit time, optional stop, target and re-strike distance) is replayed minute by minute on each recorded session and booked from the stored last traded prices.
The lab is a measuring bench, not a forecaster: it shows median, mean, worst day and win rate with the number of days behind them, a resampled 95% range, what happens when any one
day is left out, and it says plainly when there are too few days to call anything a finding. It reuses no live state: the same days and the same rule always give the same numbers.

Booking, per position (a short ATM straddle, the call and the put of the strike nearest spot at the moment it is opened):
  profit = premium at entry - premium at exit, in index points (x lot size for rupees); the premium is the call's plus the put's last traded price;
  costs are an assumption: ``cost`` points for the entry and the final exit together and ``roll_cost`` for every re-strike (0.5 point per leg per trade, 2.0 per round trip), no bid/ask;
  a stop or target is checked against the CURRENT position's entry premium (a re-strike resets it), and after a stop or a target the day is flat (no re-entry);
  a minute in which the held strike has no price repeats the last known premium (never zero);
  ``gross`` is before the entry and exit cost and after the re-strike costs, ``net`` after both.

A rule may carry GATES made of range-expansion signals (``range_signals.py``): the day is not traded when the signals at the entry minute are above the limits (a gap, a big range so far, a
straight-line move, a break of the opening range). The lab then shows what the gate avoided: the result the skipped days would have had.
"""

from __future__ import annotations

import random
import statistics
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, time
from typing import Any
from zoneinfo import ZoneInfo

from app.intelligence.range_signals import compute as signals_at
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
    max_gap_pct: float | None = None  # gate: skip the day when |opening gap| is above this many percent of the previous close
    max_range_ratio: float | None = None  # gate: skip when the range so far is above this multiple of the premium
    max_eff30: float | None = None  # gate: skip when the last 30 minutes were this straight a line or straighter (0-1)
    skip_break: bool = False  # gate: skip when the index has broken out of its opening 30-minute range

    def label(self) -> str:
        parts = [f"entry {self.entry:%H:%M}", f"exit {self.exit:%H:%M}"]
        if self.stop_pct is not None:
            parts.append(f"stop +{self.stop_pct:g}%")
        if self.target_pct is not None:
            parts.append(f"target -{self.target_pct:g}%")
        if self.roll_pts is not None:
            parts.append(f"re-strike {self.roll_pts:g} pts")
        if self.max_gap_pct is not None:
            parts.append(f"skip if gap > {self.max_gap_pct:g}%")
        if self.max_range_ratio is not None:
            parts.append(f"skip if range so far > {self.max_range_ratio:g} x premium")
        if self.max_eff30 is not None:
            parts.append(f"skip if 30-min efficiency > {self.max_eff30:g}")
        if self.skip_break:
            parts.append("skip if the opening range is broken")
        return ", ".join(parts)

    def gated(self) -> bool:
        return any(x is not None for x in (self.max_gap_pct, self.max_range_ratio, self.max_eff30)) or self.skip_break

    def ungated(self) -> Rule:
        return replace(self, max_gap_pct=None, max_range_ratio=None, max_eff30=None, skip_break=False)


@dataclass(frozen=True)
class Day:
    """One recorded session: for each stored minute the index level and the last traded prices ``{(strike, side): price}``."""

    day: str  # IST date
    dte: int  # calendar days to the expiry of the chain that was recorded
    times: Sequence[datetime]
    spots: Sequence[float]
    prices: Sequence[Mapping[tuple[float, int], float]]
    prev_close: float | None = None  # the previous session's close (from the broker's own quote), for the opening gap
    spot_source: str = "stored chain level"  # where the index level of each minute came from


def premium(prices: Mapping[tuple[float, int], float], strike: float) -> float | None:
    c, p = prices.get((strike, CALL)), prices.get((strike, PUT))
    return None if c is None or p is None else c + p


def nearest_strike(prices: Mapping[tuple[float, int], float], spot: float) -> float | None:
    """The strike nearest ``spot`` that has both a call and a put price (the lower one on a tie)."""
    strikes = sorted({k for k, _ in prices if premium(prices, k) is not None})
    return min(strikes, key=lambda k: (abs(k - spot), k)) if strikes else None


def gate_failure(rule: Rule, sig: Mapping[str, Any]) -> str | None:
    """Why the signals stop the entry, or None. A signal that could not be formed never stops it (missing stays missing)."""
    g = sig.get("gap_pct")
    if rule.max_gap_pct is not None and g is not None and abs(g) > rule.max_gap_pct:
        return f"gap {g:+.2f}% is beyond {rule.max_gap_pct:g}%"
    r = sig.get("range_ratio")
    if rule.max_range_ratio is not None and r is not None and r > rule.max_range_ratio:
        return f"range so far is {r:.2f} x the premium, above {rule.max_range_ratio:g}"
    e = sig.get("eff30")
    if rule.max_eff30 is not None and e is not None and e > rule.max_eff30:
        return f"30-minute efficiency {e:.2f} is above {rule.max_eff30:g}"
    if rule.skip_break and sig.get("or_break"):
        return f"the opening range is broken {sig['or_break']}wards"
    return None


def simulate(rule: Rule, day: Day) -> dict[str, Any]:
    """Replay ``rule`` on ``day``. ``skipped`` carries the reason when there is nothing to book (no entry minute, too short a hold, no price)."""
    n = len(day.times)
    hm = [(t.astimezone(IST).hour, t.astimezone(IST).minute) for t in day.times]
    i0 = next((i for i in range(n) if hm[i] >= (rule.entry.hour, rule.entry.minute)), None)
    ie = max((i for i in range(n) if hm[i] <= (rule.exit.hour, rule.exit.minute)), default=None)
    base: dict[str, Any] = {"day": day.day, "dte": day.dte, "spot_source": day.spot_source}
    if i0 is None or ie is None or ie < i0 + MIN_HOLD_SAMPLES:
        return base | {"skipped": "no entry minute or too short a hold"}
    k = nearest_strike(day.prices[i0], day.spots[i0])
    entry = None if k is None else premium(day.prices[i0], k)
    if k is None or entry is None:
        return base | {"skipped": "no price for the strike at the entry minute"}
    first_premium, strike0 = entry, k
    sig = signals_at(day.times, day.spots, i0, first_premium, day.prev_close)
    why = gate_failure(rule, sig)
    if why is not None:
        return base | {"skipped": f"gate: {why}", "gated": True, "signals": sig}
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
                   "spot_move": round(day.spots[min(ie, n - 1)] - day.spots[i0], 2), "signals": sig}  # fmt: skip


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


def _correlation(xs: Sequence[float], ys: Sequence[float]) -> float | None:
    if len(xs) < 5 or len(set(xs)) < 2 or len(set(ys)) < 2:
        return None
    return round(statistics.correlation(xs, ys), 2)


def _ranks(vals: Sequence[float]) -> list[float]:
    order = sorted(range(len(vals)), key=lambda i: vals[i])
    ranks = [0.0] * len(vals)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and vals[order[j + 1]] == vals[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1  # ties share the mean rank
        i = j + 1
    return ranks


SIGNALS = ("gap_pct_abs", "gap_ratio", "range_ratio", "range_so_far", "eff30", "acc", "premium_pct")


def signal_study(rule: Rule, days: Sequence[Day]) -> dict[str, Any]:
    """For each range-expansion signal at the entry minute: does it separate good entry days from bad ones? The rule is replayed WITHOUT gates on every day, then each signal is compared with
    the day's net result: rank correlation, and the mean, median and worst result of the days at or below the signal's median against the days above it. With fewer than 20 days this
    is a description of those days (the page says so); a correlation near zero or a split that reverses between halves is the usual finding."""
    results = [simulate(rule.ungated(), d) for d in days]
    used = [r for r in results if not r.get("skipped")]
    rows = []
    for name in SIGNALS:
        pairs = []
        for r in used:
            sg = r["signals"]
            if name == "gap_pct_abs":
                g = sg.get("gap_pct")
                v = None if g is None else abs(g)
            else:
                v = sg.get(name)
            if v is not None:
                pairs.append((float(v), float(r["net"]), r["day"]))
        row: dict[str, Any] = {"signal": name, "days": len(pairs)}
        if len(pairs) >= 5:
            xs, ys = [p[0] for p in pairs], [p[1] for p in pairs]
            med = statistics.median(xs)
            low, high = [p[1] for p in pairs if p[0] <= med], [p[1] for p in pairs if p[0] > med]
            row |= {"median_value": round(med, 3), "pearson": _correlation(xs, ys), "spearman": _correlation(_ranks(xs), _ranks(ys)),
                    "at_or_below_median": _bucket([{"net": y} for y in low]), "above_median": _bucket([{"net": y} for y in high])}  # fmt: skip
            row["split_gap"] = None if not low or not high else round(statistics.mean(low) - statistics.mean(high), 2)
        rows.append(row)
    return {"rule": rule.ungated().label(), "days": len(used), "signals": rows, "sufficient": len(used) >= MIN_DAYS,
            "note": "Each signal is read at the entry minute and compared with that day's net result. Spearman is the rank correlation (-1 to +1): a signal that helps a short straddle shows a NEGATIVE value (a bigger signal, a worse day) and a split where the days above the median did worse. With a handful of days a correlation of 0.3 means nothing."}  # fmt: skip


def gate_sweeps(base: Rule, days: Sequence[Day]) -> dict[str, Any]:
    """The same rule with a gate at several limits. Every row says how many days the gate skipped and what those days would have made if they had been traded, next to what it traded."""
    plain = [simulate(base.ungated(), d) for d in days]
    by_day = {r["day"]: r for r in plain}
    out: dict[str, Any] = {}
    for key, field, values in (("gap", "max_gap_pct", [0.2, 0.3, 0.5, 0.75]), ("range_so_far", "max_range_ratio", [0.3, 0.4, 0.5, 0.6, 0.8]), ("efficiency", "max_eff30", [0.3, 0.5, 0.7])):
        rows = []
        for v in values:
            r = replace(base.ungated(), **{field: v})  # type: ignore[arg-type]
            res = [simulate(r, d) for d in days]
            s = summarise(r, res)
            avoided = [float(by_day[x["day"]]["net"]) for x in res if x.get("gated") and not by_day[x["day"]].get("skipped")]
            s["value"] = v
            s["gated_days"] = len(avoided)
            s["avoided_mean"] = round(statistics.mean(avoided), 2) if avoided else None
            s["avoided_worst"] = round(min(avoided), 2) if avoided else None
            rows.append(s)
        out[key] = rows
    brk = replace(base.ungated(), skip_break=True)
    res = [simulate(brk, d) for d in days]
    s = summarise(brk, res)
    avoided = [float(by_day[x["day"]]["net"]) for x in res if x.get("gated") and not by_day[x["day"]].get("skipped")]
    s["value"] = "skip if broken"
    s["gated_days"], s["avoided_mean"], s["avoided_worst"] = len(avoided), (round(statistics.mean(avoided), 2) if avoided else None), (round(min(avoided), 2) if avoided else None)
    out["opening_range_break"] = [s]
    out["variants_tried"] = sum(len(v) for v in out.values())
    return out


def presets(base: Rule, days: Sequence[Day]) -> dict[str, Any]:
    """The three standard sweeps around ``base``, with the number of variants tried: more variants make a lucky one more likely."""
    entry = sweep(base, "entry", ENTRY_TIMES, days)
    roll = sweep(base, "roll_pts", ROLLS, days)
    stop = sweep(base, "stop_pct", STOPS, days)
    gates = gate_sweeps(base, days)
    return {"entry_time": entry, "re_strike": roll, "stop": stop, "signal_study": signal_study(base, days), "gates": gates,
            "variants_tried": len(entry) + len(roll) + len(stop) + gates["variants_tried"],
            "note": "Every variant is judged on the same days. The more variants are tried, the more likely one looks good by luck: prefer a range of neighbouring values that all work to a single best one."}  # fmt: skip
