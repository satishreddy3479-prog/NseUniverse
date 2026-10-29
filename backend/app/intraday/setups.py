"""Trade-setup candidates and risk gating: decision support only (pure, read-only, no orders).

A candidate is a *rule-based description* of a situation, never a prediction: its ``probability`` is always None until the
evaluation gate (evaluate.py) validates a model. Rules (U15 = one-standard-deviation 15-minute move from the daily sd):
* OR_BREAKOUT   breakout status CONFIRMED. Entry = last price. Stop = the opening-range boundary. Target = boundary +/- 1 range width.
* OR_FAILED     breakout FAILED within the last FAILED_WINDOW minutes: fade back into the range. Stop = the failed extreme. Target = range midpoint.
* VWAP_RECLAIM / VWAP_REJECTION  a held side change against the future's day VWAP in the last EVENT_WINDOW minutes. Stop = VWAP -/+ 0.5 U15. Target = 1 U15.
* TREND_CONTINUATION  trend regime, matching swing structure and VWAP side: WATCH only (needs a pullback that holds the last swing).
* RANGE_BOUND   sideways / mean-reverting regime, range complete, no confirmed breakout: WATCH the range edges.
Status: ACTIVE (rule met, reward/risk and cost checks pass, no risk blocker), WATCH (waiting for a condition), BLOCKED (rule met but a
risk or data control stops it), REJECTED (rule met but reward/risk or net-of-cost reward is too low). With nothing ACTIVE the answer
is NO TRADE. Position size is derived from the loss limit and the stop distance, never from an assumed account size.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import time
from typing import Any

from app.intraday.costs import CostModel
from app.intraday.labels import barrier_pts

FAILED_WINDOW = 10
EVENT_WINDOW = 10


@dataclass(frozen=True)
class RiskConfig:
    max_loss_per_trade_rs: float = 2000.0
    max_daily_loss_rs: float = 5000.0
    max_trades_per_day: int = 4
    max_consecutive_losses: int = 2
    min_reward_risk: float = 1.5
    max_spread_pts: float = 2.0
    max_lots: int = 10
    cutoff: time = time(15, 0)
    block_on_high_impact_event: bool = True


@dataclass
class DayState:
    trades: int = 0
    pnl_rs: float = 0.0
    consecutive_losses: int = 0


@dataclass
class Context:
    spot: float
    minute: int  # minutes since 09:15 of the last completed minute
    clock: time
    structure: dict[str, Any]
    regime: str | None
    daily_sd_pct: float | None
    data_live: bool = True
    vwap: dict[str, Any] | None = None
    spread_pts: float | None = None
    event_risk: bool = False
    day: DayState = field(default_factory=DayState)


def blockers(ctx: Context, risk: RiskConfig) -> list[str]:
    out = []
    if not ctx.data_live:
        out.append("data is not live")
    if ctx.clock >= risk.cutoff:
        out.append(f"after the {risk.cutoff:%H:%M} trading cutoff")
    if ctx.day.trades >= risk.max_trades_per_day:
        out.append(f"daily trade limit ({risk.max_trades_per_day}) reached")
    if ctx.day.pnl_rs <= -risk.max_daily_loss_rs:
        out.append("daily loss limit reached")
    if ctx.day.consecutive_losses >= risk.max_consecutive_losses:
        out.append(f"{ctx.day.consecutive_losses} consecutive losses")
    if ctx.spread_pts is not None and ctx.spread_pts > risk.max_spread_pts:
        out.append(f"spread {ctx.spread_pts:.1f} pts is wider than the {risk.max_spread_pts:g} limit")
    if risk.block_on_high_impact_event and ctx.event_risk:
        out.append("high-impact event risk today")
    return out


def _cand(ctx: Context, risk: RiskConfig, costs: CostModel, name: str, direction: str, entry: float, stop: float, target: float, condition: str, reason: str,
          invalidation: str, horizon: int, active: bool = True) -> dict[str, Any]:  # fmt: skip
    risk_pts = abs(entry - stop)
    reward = (target - entry) if direction == "long" else (entry - target)
    rr = None if risk_pts <= 0 else round(reward / risk_pts, 2)
    cost = costs.cost_points(entry, 1, None if ctx.spread_pts is None else ctx.spread_pts / 2)
    net_reward = round(reward - cost, 2)
    lots = 0 if risk_pts <= 0 else min(risk.max_lots, math.floor(risk.max_loss_per_trade_rs / (risk_pts * costs.lot_size)))
    why: list[str] = []
    if rr is None or rr < risk.min_reward_risk:
        why.append(f"reward/risk {rr} is below {risk.min_reward_risk}")
    if net_reward <= 0:
        why.append(f"reward {reward:.1f} pts does not cover the {cost:.1f} pts of costs")
    if lots < 1:
        why.append(f"a {risk_pts:.1f}-pt stop exceeds the {risk.max_loss_per_trade_rs:g} rupee loss limit for one lot")
    block = blockers(ctx, risk)
    status = "WATCH" if not active else "REJECTED" if why else "BLOCKED" if block else "ACTIVE"
    return {"setup": name, "direction": direction, "status": status, "entry_condition": condition, "entry_ref": round(entry, 2), "stop": round(stop, 2), "target": round(target, 2),
            "risk_pts": round(risk_pts, 2), "reward_pts": round(reward, 2), "reward_risk": rr, "net_reward_after_costs_pts": net_reward, "costs_pts": cost, "lots": max(lots, 0),
            "max_loss_rs": round(risk_pts * costs.lot_size * max(lots, 0), 0), "holding_horizon_min": horizon, "probability": None,
            "probability_note": "not shown: no validated model", "liquidity": None if ctx.spread_pts is None else {"spread_pts": ctx.spread_pts},
            "data_quality": "LIVE" if ctx.data_live else "NOT LIVE", "reason": reason, "invalidation": invalidation, "rejected_because": why, "blocked_because": block if not why else []}  # fmt: skip


def detect(ctx: Context, risk: RiskConfig | None = None, costs: CostModel | None = None) -> dict[str, Any]:
    risk, costs = risk or RiskConfig(), costs or CostModel()
    out: list[dict[str, Any]] = []
    if not ctx.spot > 0:
        return {"candidates": [], "decision": "NO TRADE: INSUFFICIENT EVIDENCE", "active": 0, "global_blockers": ["no valid price"], "read_only": True, "note": "No valid price."}
    st = ctx.structure
    b = st.get("breakout")
    rng = next((r for r in st.get("ranges", []) if r.get("state") == "complete" and r.get("width")), None)
    u15 = barrier_pts(ctx.spot, ctx.daily_sd_pct, 15, 1.0) if ctx.daily_sd_pct else None
    if b and rng:
        hi, lo, w = rng["high"], rng["low"], rng["width"]
        sign = 1 if b["direction"] == "up" else -1
        boundary = hi if sign > 0 else lo
        if b["status"] == "CONFIRMED":
            entry = b["last_price"]
            out.append(_cand(ctx, risk, costs, "OR_BREAKOUT", "long" if sign > 0 else "short", entry, boundary, boundary + sign * w,
                             f"already confirmed: {b['clear']} closes clear of the buffer; enter only if price is still beyond {boundary:.2f}",
                             f"{b['or_minutes']}-minute opening range broken {b['direction']} with {b['beyond']} closes beyond; quality {b['quality']['score']}",
                             f"a close back through {boundary:.2f}", 30))  # fmt: skip
        elif b["status"] in ("UNCONFIRMED", "DEVELOPING"):
            out.append(_cand(ctx, risk, costs, "OR_BREAKOUT", "long" if sign > 0 else "short", b["last_price"], boundary, boundary + sign * w,
                             f"wait for 3 closes beyond {boundary + sign * 0.1 * w:.2f}", f"break {b['status'].lower()}: not confirmed", f"a close back through {boundary:.2f}", 30, active=False))  # fmt: skip
        elif b["status"] == "FAILED" and ctx.minute - b.get("failed_minute", -999) <= FAILED_WINDOW:
            extreme = boundary + sign * b["max_ext"] * w
            out.append(_cand(ctx, risk, costs, "OR_FAILED", "short" if sign > 0 else "long", ctx.spot, extreme, (hi + lo) / 2,
                             f"price back inside the range after the {b['direction']} break", "failed breakout: closes returned inside the opening range",
                             f"price making a new extreme beyond {extreme:.2f}", 20))  # fmt: skip
    v = ctx.vwap
    if v and u15:
        ev = [e for e in v.get("events", []) if ctx.minute - e["minute"] <= EVENT_WINDOW]
        if ev:
            e = ev[-1]
            long_ = e["event"] == "vwap_reclaim"
            px, vw = v["price"], v["vwap"]
            out.append(_cand(ctx, risk, costs, "VWAP_RECLAIM" if long_ else "VWAP_REJECTION", "long" if long_ else "short", px, vw - 0.5 * u15 if long_ else vw + 0.5 * u15,
                             px + u15 if long_ else px - u15, f"price holding {'above' if long_ else 'below'} the future's VWAP {vw:.2f}",
                             f"{e['event'].replace('_', ' ')} {ctx.minute - e['minute']} minutes ago, held {3} samples", f"price back {'below' if long_ else 'above'} VWAP", 15))  # fmt: skip
    reg = (ctx.regime or "").lower()
    label = (st.get("structure") or {}).get("label", "")
    if "trend" in reg and u15 and not out:
        up = "uptrend" in label
        down = "downtrend" in label
        if up or down:
            lvl = (st["structure"].get("last_swing_low") if up else st["structure"].get("last_swing_high"))
            if lvl is not None:
                out.append(_cand(ctx, risk, costs, "TREND_CONTINUATION", "long" if up else "short", ctx.spot, lvl, ctx.spot + (u15 if up else -u15),
                                 f"pullback that holds {lvl:.2f}", f"{reg} regime with {label}", f"a close through {lvl:.2f}", 30, active=False))  # fmt: skip
    if rng and not out and any(k in reg for k in ("sideways", "mean")):
        out.append({"setup": "RANGE_BOUND", "direction": None, "status": "WATCH", "entry_condition": f"fade the edges: long near {rng['low']:.2f}, short near {rng['high']:.2f}",
                    "levels": [rng["low"], rng["high"]], "probability": None, "probability_note": "not shown: no validated model", "reason": f"{reg} regime and no confirmed breakout",
                    "invalidation": "a confirmed close outside the range", "data_quality": "LIVE" if ctx.data_live else "NOT LIVE"})  # fmt: skip
    active = [c for c in out if c["status"] == "ACTIVE"]
    return {"candidates": out, "decision": "CANDIDATE" if active else "NO TRADE: INSUFFICIENT EVIDENCE", "active": len(active),
            "risk": {"max_loss_per_trade_rs": risk.max_loss_per_trade_rs, "max_daily_loss_rs": risk.max_daily_loss_rs, "max_trades": risk.max_trades_per_day,
                     "max_consecutive_losses": risk.max_consecutive_losses, "min_reward_risk": risk.min_reward_risk, "cutoff": f"{risk.cutoff:%H:%M}"},
            "global_blockers": blockers(ctx, risk), "read_only": True,
            "note": "Rule-based decision support. No probability is attached until a model passes the evaluation gate. No orders are placed."}  # fmt: skip
