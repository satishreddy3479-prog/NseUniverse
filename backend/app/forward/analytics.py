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

from app.forward.engine import FAMILIES, LABELS, TWIN, VARIANTS

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


def _variant_stats(trades: list[dict[str, Any]], v: str) -> dict[str, Any]:
    rows = [t["variants"][v] for t in trades if v in t["variants"]]
    return _stats([r["net"] for r in rows], [r["worst"] for r in rows if r["worst"] is not None], sum(1 for r in rows if r.get("stopped_at")))


def variant_table(trades: list[dict[str, Any]], family: str = "plain") -> list[dict[str, Any]]:
    """The exit rules of one test (plain stops, or stops with SL moved to cost). A cost rule also carries the result of the plain stop with the same percentage on the same trades."""
    out = []
    for v in FAMILIES.get(family, FAMILIES["plain"]):
        row: dict[str, Any] = {"variant": v, "label": LABELS[v], **_variant_stats(trades, v)}
        if v in TWIN:
            row["twin"] = {"variant": TWIN[v], "label": LABELS[TWIN[v]], **_variant_stats(trades, TWIN[v])}
        out.append(row)
    return out


def portfolio(trades: list[dict[str, Any]], rule: str) -> list[dict[str, Any]]:
    """The positions of one exit rule as a portfolio of closed trades, oldest first: what was sold, how it exited and what it made. A position the rule has no result for is left out."""
    out = []
    for t in sorted(trades, key=lambda t: (t["trigger_at"], t["id"])):
        r = t["variants"].get(rule)
        if r is None:
            continue
        out.append({
            "id": t["id"], "session": t["session"], "cohort": t["cohort"], "structure": t["structure"], "n": t["n"], "expiry": t["expiry"], "trigger_at": t["trigger_at"],
            "settled_at": t.get("settled_at"), "spot0": t["spot0"], "ce_strike": t["ce_strike"], "pe_strike": t["pe_strike"], "ce0": t["ce0"], "pe0": t["pe0"],
            "ce_exit": r["ce_exit"], "pe_exit": r["pe_exit"], "gross": r["gross"], "cost": r["cost"], "net": r["net"], "worst": r["worst"], "reason": r["reason"],
            "stopped_at": r.get("stopped_at"), "ce_at": r.get("ce_at"), "pe_at": r.get("pe_at"), "regime": t.get("regime"), "seller": t.get("seller"), "buyer": t.get("buyer"), "net_move": (t.get("eod") or {}).get("net_move_pts"),
        })  # fmt: skip
    return out


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


def breakdown(trades: list[dict[str, Any]], dim: str, rule: str) -> dict[str, Any]:
    """How one exit rule did inside each bucket of one dimension (regime, time of entry, days to expiry, ...)."""
    title, key = DIMENSIONS.get(dim, DIMENSIONS["regime"])
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for t in trades:
        if rule in t["variants"]:
            groups[key(t)].append(t)
    rows = []
    for name in sorted(groups):
        rs = [t["variants"][rule] for t in groups[name]]
        nets = [r["net"] for r in rs]
        rows.append({"bucket": name, **_stats(nets, [r["worst"] for r in rs if r["worst"] is not None], sum(1 for r in rs if r.get("stopped_at")))})
    return {"dimension": dim, "title": title, "options": {k: v[0] for k, v in DIMENSIONS.items()}, "rows": rows, "min_trades": MIN_TRADES}
