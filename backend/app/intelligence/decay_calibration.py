"""Is the decay probability honest? The engine's prediction at many entry minutes of the recorded sessions against what the straddle then did (pure functions, no I/O).

For each recorded day and each entry time the engine is run on the stored chain of that minute (the same chain the live engine reads), exactly as if it were live, and the straddle it prices (strike
nearest the forward, premium = last traded call + put) is followed to the exit time on the stored prices. Reported, per volatility scale:
  * reliability: entries grouped by the predicted chance that the sale pays, with the share that did pay (a calibrated engine shows the same number in both columns);
  * the Brier score against the score of always saying "the base rate" (lower is better; beating the base rate is the minimum an engine owes);
  * how often the actual result fell below the predicted 5th, 50th and 95th percentile (should be 5%, 50%, 95%);
  * the mean predicted result against the mean actual result.
The entries of one day are NOT independent (the same trend decides all of them), so the effective sample is closer to the number of days than to the number of entries; the report says so and refuses
to call anything proven below ``MIN_DAYS`` days. The volatility scales are variants tried: the number is reported next to the result.
"""

from __future__ import annotations

import statistics
from collections.abc import Mapping, Sequence
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.domain.session import default_close
from app.intelligence import decay_probability as dp
from app.intelligence import straddle as sd
from app.intelligence.entry_lab import Day
from app.intraday.volatility import CALL, DEFAULT_RATE, PUT

IST = ZoneInfo("Asia/Kolkata")
MIN_DAYS = 20
BANDS = ((0.0, 0.45), (0.45, 0.55), (0.55, 0.65), (0.65, 0.75), (0.75, 1.01))
LOOKBACK = 5  # minutes back to find a price for the exit when the exact minute has none
DEFAULT_ENTRIES = tuple(time(h, m) for h in range(9, 14) for m in (0, 30) if (h, m) >= (9, 30))
DEFAULT_SCALES = (0.7, 0.8, 0.9, 1.0, 1.1)


def _hm(t: datetime) -> tuple[int, int]:
    x = t.astimezone(IST)
    return x.hour, x.minute


def _prices_at(day: Day, i: int, k: float) -> float | None:
    ce, pe = day.prices[i].get((k, CALL)), day.prices[i].get((k, PUT))
    return None if ce is None or pe is None else float(ce) + float(pe)


def outcome_rows(day: Day, entries: Sequence[time], exit_: time, scale: float, cost: float = 2.0, rate: float = DEFAULT_RATE) -> list[dict[str, Any]]:
    """The engine's prediction at each entry time of ``day`` and the actual net result of the straddle it priced."""
    d0 = date.fromisoformat(day.day)
    expiry = d0 + timedelta(days=day.dte)
    expiry_close = datetime.combine(expiry, default_close(expiry), IST)
    exit_at = datetime.combine(d0, exit_, IST)
    n = len(day.times)
    ie_all = max((i for i in range(n) if _hm(day.times[i]) <= (exit_.hour, exit_.minute)), default=None)
    rows: list[dict[str, Any]] = []
    for t in entries:
        i = next((j for j in range(n) if _hm(day.times[j]) >= (t.hour, t.minute)), None)
        if i is None or ie_all is None or ie_all <= i + 5:
            continue
        point, _ = sd.build_point(sd.Snap(day.times[i], day.spots[i], dict(day.prices[i])), expiry, rate)
        if point is None:
            continue
        out = dp.for_point(point, expiry_close, exit_at, cost=cost, vol_scale=scale)
        if not out.get("available"):
            continue
        k = float(out["strike"])
        exit_prem = next((p for j in range(ie_all, max(i, ie_all - LOOKBACK) - 1, -1) if (p := _prices_at(day, j, k)) is not None), None)
        if exit_prem is None:
            continue
        actual = float(out["premium"]) - exit_prem - cost
        q = out["quantiles"]
        rows.append({"day": day.day, "entry": f"{t:%H:%M}", "p_profit": out["p_profit"], "mean": out["mean"], "p5": q["p5"], "p50": q["p50"], "p95": q["p95"], "actual": round(actual, 2),
                     "win": actual > 0, "implied_vol_pct": out["implied_vol_pct"]})  # fmt: skip
    return rows


def summarise(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Reliability, Brier score, quantile coverage and mean error of a set of predictions with outcomes."""
    n = len(rows)
    if n == 0:
        return {"entries": 0, "days": 0}
    wins = [1.0 if r["win"] else 0.0 for r in rows]
    preds = [float(r["p_profit"]) for r in rows]
    base = sum(wins) / n
    brier = sum((p - w) ** 2 for p, w in zip(preds, wins, strict=True)) / n
    out: dict[str, Any] = {
        "entries": n, "days": len({r["day"] for r in rows}), "base_rate": round(base, 3), "brier": round(brier, 4), "brier_base_rate": round(base * (1 - base), 4),
        "beats_base_rate": brier < base * (1 - base), "mean_predicted_pnl": round(statistics.mean(float(r["mean"]) for r in rows), 2),
        "mean_actual_pnl": round(statistics.mean(float(r["actual"]) for r in rows), 2), "median_actual_pnl": round(statistics.median(float(r["actual"]) for r in rows), 2),
        "mean_predicted_win": round(sum(preds) / n, 3),
        "below_predicted": {"p5": round(sum(1 for r in rows if r["actual"] < r["p5"]) / n, 3), "p50": round(sum(1 for r in rows if r["actual"] < r["p50"]) / n, 3),
                            "p95": round(sum(1 for r in rows if r["actual"] < r["p95"]) / n, 3)},
    }  # fmt: skip
    bands = []
    for lo, hi in BANDS:
        sel = [r for r in rows if lo <= float(r["p_profit"]) < hi]
        bands.append({"from": lo, "to": min(hi, 1.0), "entries": len(sel), "days": len({r["day"] for r in sel}),
                      "predicted": None if not sel else round(statistics.mean(float(r["p_profit"]) for r in sel), 3),
                      "actual": None if not sel else round(sum(1 for r in sel if r["win"]) / len(sel), 3)})  # fmt: skip
    out["reliability"] = bands
    return out


def calibrate(days: Sequence[Day], entries: Sequence[time] = DEFAULT_ENTRIES, exit_: time = time(15, 15), scales: Sequence[float] = DEFAULT_SCALES, cost: float = 2.0) -> dict[str, Any]:
    """The calibration of the engine on every recorded day, once per volatility scale."""
    per: dict[str, Any] = {}
    for sc in scales:
        rows = [r for d in days for r in outcome_rows(d, entries, exit_, sc, cost)]
        per[f"{sc:g}"] = summarise(rows)
    used = per.get("1") or next(iter(per.values()), {"days": 0})
    ndays = int(used.get("days", 0))
    return {
        "scales": per, "variants_tried": len(per), "days": ndays, "entry_times": [f"{t:%H:%M}" for t in entries], "exit": f"{exit_:%H:%M}", "sufficient": ndays >= MIN_DAYS, "min_days": MIN_DAYS,
        "note": (f"{ndays} days: a description, not a verdict (at least {MIN_DAYS} days are needed). " if ndays < MIN_DAYS else "") + "The entries of one day share its trend, so the evidence is nearer the number of days "
        "than the number of entries. Volatility scale 1 is the market's own volatility; a scale that fits better only says the market's volatility was too high or too low on these days.",
    }  # fmt: skip
