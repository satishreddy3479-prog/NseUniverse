"""Cost-aware paper trading of the rule-based setups over stored sessions (pure; nothing is ever sent to a broker).

What is simulated: only setups that can be rebuilt from the spot path alone (opening-range breakout and failed breakout); VWAP and
flow setups need the futures feed, which is recorded from the first live session onward. The index spot path stands in for the
future (the basis is ignored; a documented simplification).
Mechanics, chosen so the test cannot flatter the rules:
* the signal uses completed minutes only; the fill is the NEXT stored sample after the signal (no same-sample fill);
* stop: the first sample at or beyond the stop exits at that sample's price (gaps are suffered, not rounded to the stop);
  target: exits at the target price once a sample reaches it;
* time stop after ``hold_max`` minutes and a flat exit at the cutoff; one trade at a time; one trade per setup and direction per day;
* the risk limits of RiskConfig apply (trades per day, daily loss, consecutive losses, cutoff);
* every trade pays brokerage, STT, exchange/SEBI/stamp/GST and two-sided slippage (CostModel).
No conclusion is drawn from fewer than MIN_TRADES trades; the report then says so.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import timedelta
from typing import Any

from app.intraday import price_structure as ps
from app.intraday import setups
from app.intraday.costs import CostModel
from app.intraday.features import IST, OPEN, Point

MIN_TRADES = 30
TRADABLE = ("OR_BREAKOUT", "OR_FAILED")
HOLD_MAX_MIN = 30


def _minute(p: Point) -> int:
    t = p.at.astimezone(IST)
    return t.hour * 60 + t.minute - (OPEN.hour * 60 + OPEN.minute)


def simulate_session(points: Sequence[Point], daily_sd_pct: float | None, risk: setups.RiskConfig | None = None, costs: CostModel | None = None,
                     hold_max: int = HOLD_MAX_MIN) -> list[dict[str, Any]]:  # fmt: skip
    risk, costs = risk or setups.RiskConfig(), costs or CostModel()
    trades: list[dict[str, Any]] = []
    day = setups.DayState()
    open_t: dict[str, Any] | None = None
    used: set[tuple[str, str]] = set()
    n = len(points)

    def close(i: int, price: float, why: str) -> None:
        nonlocal open_t, day
        t = open_t
        assert t is not None
        res = costs.round_trip(t["fill"], price, t["lots"], t["direction"])
        trades.append(t | res | {"exit_price": round(price, 2), "exit_reason": why, "exit_at": points[i].at.isoformat(), "minutes_held": round((points[i].at - t["entry_at_dt"]).total_seconds() / 60, 1)})
        trades[-1].pop("entry_at_dt")
        day.trades += 1
        day.pnl_rs += res["net_rupees"]
        day.consecutive_losses = day.consecutive_losses + 1 if res["net_rupees"] < 0 else 0
        open_t = None

    for i in range(n):
        p = points[i]
        clock = p.at.astimezone(IST).time()
        if open_t is not None and i > open_t["i"]:
            t = open_t
            long_ = t["direction"] == "long"
            hit_stop = p.spot <= t["stop"] if long_ else p.spot >= t["stop"]
            hit_tgt = p.spot >= t["target"] if long_ else p.spot <= t["target"]
            if hit_stop:
                close(i, p.spot, "stop")
            elif hit_tgt:
                close(i, t["target"], "target")
            elif (p.at - t["entry_at_dt"]) >= timedelta(minutes=hold_max):
                close(i, p.spot, "time")
            elif clock >= risk.cutoff or i == n - 1:
                close(i, p.spot, "cutoff")
            continue
        if open_t is not None or i < 15 or i + 1 >= n:
            continue
        ctx = setups.Context(spot=p.spot, minute=_minute(p), clock=clock, structure=ps.analyze(points[: i + 1], p.at + timedelta(minutes=1)), regime=None, daily_sd_pct=daily_sd_pct, day=day)
        for c in setups.detect(ctx, risk, costs)["candidates"]:
            if c["status"] != "ACTIVE" or c["setup"] not in TRADABLE or (c["setup"], c["direction"]) in used:
                continue
            fill = points[i + 1].spot
            long_ = c["direction"] == "long"
            risk_pts = fill - c["stop"] if long_ else c["stop"] - fill
            reward = c["target"] - fill if long_ else fill - c["target"]
            if risk_pts <= 0 or reward <= 0 or reward / risk_pts < risk.min_reward_risk:
                continue  # the market moved away between signal and fill: the rule no longer holds at the fill price
            used.add((c["setup"], c["direction"]))
            open_t = {"i": i + 1, "setup": c["setup"], "direction": c["direction"], "signal_at": p.at.isoformat(), "entry_at": points[i + 1].at.isoformat(), "entry_at_dt": points[i + 1].at,
                      "fill": fill, "stop": c["stop"], "target": c["target"], "lots": c["lots"], "reward_risk_at_fill": round(reward / risk_pts, 2)}  # fmt: skip
            break
    if open_t is not None:  # a trade opened on the final sample has no later sample to exit on
        open_t = None
    return trades


def summarize(trades: Sequence[dict[str, Any]], sessions: int) -> dict[str, Any]:
    n = len(trades)
    out: dict[str, Any] = {"sessions": sessions, "trades": n, "min_trades_for_a_conclusion": MIN_TRADES}
    if n == 0:
        return out | {"conclusion": "no trades were triggered on the stored sessions", "net_rupees": 0.0}
    net = [t["net_rupees"] for t in trades]
    gross_win = sum(x for x in net if x > 0)
    gross_loss = -sum(x for x in net if x < 0)
    eq, peak, dd = 0.0, 0.0, 0.0
    for x in net:
        eq += x
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    by: dict[str, dict[str, Any]] = {}
    for t in trades:
        b = by.setdefault(t["setup"], {"trades": 0, "net_rupees": 0.0, "wins": 0})
        b["trades"] += 1
        b["net_rupees"] = round(b["net_rupees"] + t["net_rupees"], 2)
        b["wins"] += t["net_rupees"] > 0
    out |= {"net_rupees": round(sum(net), 2), "gross_rupees_before_costs": round(sum(t["gross_rupees"] for t in trades), 2),
            "costs_and_slippage_rupees": round(sum(t["charges_rupees"] + t["slippage_rupees"] for t in trades), 2), "win_rate": round(sum(1 for x in net if x > 0) / n, 3),
            "expectancy_rupees": round(sum(net) / n, 2), "profit_factor": None if gross_loss == 0 else round(gross_win / gross_loss, 3), "max_drawdown_rupees": round(dd, 2),
            "avg_minutes_held": round(sum(t["minutes_held"] for t in trades) / n, 1), "by_setup": by,
            "exit_reasons": {r: sum(1 for t in trades if t["exit_reason"] == r) for r in {t["exit_reason"] for t in trades}}}  # fmt: skip
    out["conclusion"] = (f"no conclusion: {n} trades is fewer than {MIN_TRADES}; the result below is noise-sized" if n < MIN_TRADES
                         else ("net of costs the rules lost money on the stored sessions" if sum(net) <= 0 else "net of costs the rules made money on the stored sessions; out-of-sample confirmation is still required"))  # fmt: skip
    return out
