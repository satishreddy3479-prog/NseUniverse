"""Metrics of the forward test, from settled positions: per exit variant, equity curves, and breakdowns by market regime and other conditions.

Pure functions over the rows ``ForwardStore.settled`` returns (each position has ``variants``: variant -> result). Every cell carries its number of trades; the page
decides what is too few to read (below ``MIN_TRADES``), and nothing here calls a result validated.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from app.forward.engine import LABELS, VARIANTS

IST = ZoneInfo("Asia/Kolkata")
MIN_TRADES = 20  # below this a cell is shown but marked too few to read
VARIANT_IDS = [v for v, _, _ in VARIANTS]


def _stats(nets: list[float], worst: list[float], stopped: int) -> dict[str, Any]:
    n = len(nets)
    if n == 0:
        return {"n": 0}
    wins = [x for x in nets if x > 0]
    losses = [x for x in nets if x < 0]
    peak = dd = cum = 0.0
    for x in nets:
        cum += x
        peak = max(peak, cum)
        dd = min(dd, cum - peak)
    return {
        "n": n, "wins": len(wins), "win_rate": round(len(wins) / n * 100, 1), "total": round(sum(nets), 2), "avg": round(sum(nets) / n, 2), "best": round(max(nets), 2), "worst": round(min(nets), 2),
        "max_drawdown": round(dd, 2), "profit_factor": None if not losses else round(sum(wins) / -sum(losses), 2), "avg_intraday_worst": round(sum(worst) / len(worst), 2) if worst else None,
        "stop_rate": round(stopped / n * 100, 1),
    }  # fmt: skip


def filtered(trades: list[dict[str, Any]], structure: str = "all", cohort: str = "all") -> list[dict[str, Any]]:
    return [t for t in trades if (structure == "all" or t["structure"] == structure) and (cohort == "all" or t["cohort"] == cohort)]


def variant_table(trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for v in VARIANT_IDS:
        rows = [t["variants"][v] for t in trades if v in t["variants"]]
        nets = [r["net"] for r in rows]
        stats = _stats(nets, [r["worst"] for r in rows if r["worst"] is not None], sum(1 for r in rows if r.get("stopped_at")))
        out.append({"variant": v, "label": LABELS[v], **stats})
    return out


def equity(trades: list[dict[str, Any]]) -> dict[str, Any]:
    """Cumulative net P&L after each position, in the order they were opened, per variant (the x axis is the position number with its time)."""
    ordered = sorted(trades, key=lambda t: (t["trigger_at"], t["id"]))
    curves: dict[str, list[float]] = {}
    for v in VARIANT_IDS:
        cum, pts = 0.0, []
        for t in ordered:
            r = t["variants"].get(v)
            if r is not None:
                cum += r["net"]
            pts.append(round(cum, 2))
        curves[v] = pts
    return {"times": [t["trigger_at"] for t in ordered], "curves": curves}


def _time_bucket(t: dict[str, Any]) -> str:
    m = datetime.fromisoformat(t["trigger_at"]).astimezone(IST)
    h = m.hour * 60 + m.minute
    for lo, hi, name in ((570, 630, "09:30-10:30"), (630, 690, "10:30-11:30"), (690, 750, "11:30-12:30"), (750, 810, "12:30-13:30"), (810, 871, "13:30-14:30")):
        if lo <= h < hi:
            return name
    return "other"


def _band(v: float | None, edges: list[float], labels: list[str]) -> str:
    if v is None:
        return "not recorded"
    for e, name in zip(edges, labels, strict=False):
        if v < e:
            return name
    return labels[-1]


DIMENSIONS: dict[str, tuple[str, Callable[[dict[str, Any]], str]]] = {
    "regime": ("Regime at entry", lambda t: t.get("regime") or "not recorded"),
    "time": ("Time of entry (IST)", _time_bucket),
    "dte": ("Days to expiry", lambda t: _band(t["context"].get("dte"), [1, 2, 4, 8], ["expiry day", "1 day", "2-3 days", "4-7 days", "8+ days"])),
    "weekday": ("Weekday", lambda t: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][t["context"].get("weekday", 0)] if t["context"].get("weekday") is not None else "not recorded"),
    "seller": ("Seller score at entry", lambda t: _band(t.get("seller"), [65, 70, 75], ["60-65", "65-70", "70-75", "75+"])),
    "flow": ("Futures order flow", lambda t: _band(t["context"].get("orderflow"), [-30, 30], ["bearish (below -30)", "neutral", "bullish (above +30)"])),
    "ivrv": ("Implied minus realised vol (15 min)", lambda t: _band(t["context"].get("rv_gap_15"), [4, 8], ["under 4 pts", "4-8 pts", "over 8 pts"])),
    "direction": ("Directional ratio, last 30 min", lambda t: _band(t["context"].get("path_eff_30"), [0.2, 0.4], ["choppy (under 0.2)", "mixed (0.2-0.4)", "directional (over 0.4)"])),
    "day_type": ("Kind of day after entry", lambda t: "not settled" if not t.get("eod") else ("trend day" if t["eod"].get("trend_day") else "range day")),
}


def breakdown(trades: list[dict[str, Any]], dim: str) -> dict[str, Any]:
    """Average net P&L and win rate of every variant inside each bucket of one dimension."""
    title, key = DIMENSIONS.get(dim, DIMENSIONS["regime"])
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for t in trades:
        groups[key(t)].append(t)
    rows = []
    for name in sorted(groups):
        ts = groups[name]
        cells = {}
        for v in VARIANT_IDS:
            nets = [t["variants"][v]["net"] for t in ts if v in t["variants"]]
            cells[v] = {"n": len(nets), "avg": round(sum(nets) / len(nets), 2) if nets else None, "win_rate": round(sum(1 for x in nets if x > 0) / len(nets) * 100, 1) if nets else None, "total": round(sum(nets), 2)}
        rows.append({"bucket": name, "n": len(ts), "cells": cells})
    return {"dimension": dim, "title": title, "options": {k: v[0] for k, v in DIMENSIONS.items()}, "rows": rows, "min_trades": MIN_TRADES}


def trade_row(t: dict[str, Any]) -> dict[str, Any]:
    nets = {v: r["net"] for v, r in t["variants"].items()}
    best = max(nets.items(), key=lambda kv: kv[1], default=None)
    worst = min(nets.items(), key=lambda kv: kv[1], default=None)
    return {
        "id": t["id"], "session": t["session"], "cohort": t["cohort"], "expiry": t["expiry"], "structure": t["structure"], "n": t["n"], "trigger_at": t["trigger_at"], "spot0": t["spot0"],
        "ce_strike": t["ce_strike"], "pe_strike": t["pe_strike"], "ce0": t["ce0"], "pe0": t["pe0"], "seller": t["seller"], "buyer": t["buyer"], "regime": t["regime"], "eod": t.get("eod"),
        "nets": nets, "best": None if best is None else {"variant": best[0], "net": best[1]}, "worst": None if worst is None else {"variant": worst[0], "net": worst[1]},
    }  # fmt: skip
