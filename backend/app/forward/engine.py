"""The rules of the forward test: which exits are tried on every simulated short option position, and what each one does with a price.

Everything here is paper arithmetic on stored last-traded prices (no orders, no broker). A position sells one call and one put (an at-the-money straddle or a
50-points-wide strangle). Every exit variant starts from the same entry, so a difference between variants comes from the exit rule alone.

Prices are the last traded price of the stored one-minute sample; a stop is checked against each stored sample, so a touch between two samples is not seen, and a
fill is the price of the sample that showed the touch (no bid/ask, no slippage model). A missing price is skipped, never replaced by zero.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# id, kind, stop (fraction above the entry price)
VARIANTS: list[tuple[str, str, float]] = [
    ("hold", "none", 0.0),
    ("leg30", "leg", 0.30),
    ("leg40", "leg", 0.40),
    ("leg50", "leg", 0.50),
    ("leg60", "leg", 0.60),
    ("leg70", "leg", 0.70),
    ("leg80", "leg", 0.80),
    ("leg30_cost", "legcost", 0.30),
    ("leg40_cost", "legcost", 0.40),
    ("leg50_cost", "legcost", 0.50),
    ("leg60_cost", "legcost", 0.60),
    ("leg70_cost", "legcost", 0.70),
    ("leg80_cost", "legcost", 0.80),
    ("comb15", "comb", 0.15),
    ("comb25", "comb", 0.25),
    ("comb40", "comb", 0.40),
]
LABELS = {
    "hold": "No stop (hold to 15:20)",
    "leg30": "Leg stop 30%", "leg40": "Leg stop 40%", "leg50": "Leg stop 50%", "leg60": "Leg stop 60%", "leg70": "Leg stop 70%", "leg80": "Leg stop 80%",
    "leg30_cost": "Stop 30% + SL to cost", "leg40_cost": "Stop 40% + SL to cost", "leg50_cost": "Stop 50% + SL to cost", "leg60_cost": "Stop 60% + SL to cost",
    "leg70_cost": "Stop 70% + SL to cost", "leg80_cost": "Stop 80% + SL to cost",
    "comb15": "Combined stop +15%", "comb25": "Combined stop +25%", "comb40": "Combined stop +40%",
}  # fmt: skip
KIND = {v: (k, x) for v, k, x in VARIANTS}
# The two tests the pages show: plain stop losses, and the same stops with "Move SL to cost" (when one leg's stop fires, the other leg's stop moves to its entry price).
FAMILIES: dict[str, list[str]] = {
    "plain": ["hold", "leg30", "leg40", "leg50", "leg60", "leg70", "leg80", "comb15", "comb25", "comb40"],
    "cost": ["leg30_cost", "leg40_cost", "leg50_cost", "leg60_cost", "leg70_cost", "leg80_cost"],
}
TWIN = {f"leg{p}_cost": f"leg{p}" for p in (30, 40, 50, 60, 70, 80)}  # the plain stop with the same percentage
COST_RULE_VERSION = "2"  # the move-to-cost rule below; a stored result of an older version is recomputed from the stored prices


@dataclass(frozen=True)
class CostCfg:
    """Estimated charges of an options trade (Indian exchange rates; an estimate, not a contract note)."""

    brokerage_per_order: float = 20.0
    stt_sell_pct: float = 0.10  # on the premium of an option sold
    exchange_pct: float = 0.0356  # on turnover, both sides
    sebi_pct: float = 0.0001
    stamp_buy_pct: float = 0.003
    gst_pct: float = 18.0  # on brokerage + exchange + SEBI


def costs(ce0: float, pe0: float, ce_exit: float, pe_exit: float, lot: int, cfg: CostCfg = CostCfg()) -> float:  # noqa: B008 - a frozen default
    """Charges of selling the two legs and buying them back (4 orders): brokerage, STT on the sold premium, exchange, SEBI, stamp and GST."""
    sell = (ce0 + pe0) * lot
    buy = (ce_exit + pe_exit) * lot
    brokerage = cfg.brokerage_per_order * 4
    exchange = (sell + buy) * cfg.exchange_pct / 100
    sebi = (sell + buy) * cfg.sebi_pct / 100
    stt = sell * cfg.stt_sell_pct / 100
    stamp = buy * cfg.stamp_buy_pct / 100
    gst = (brokerage + exchange + sebi) * cfg.gst_pct / 100
    return round(brokerage + exchange + sebi + stt + stamp + gst, 2)


def new_state() -> dict[str, Any]:
    return {"ce_open": True, "pe_open": True, "ce_x": None, "pe_x": None, "ce_why": None, "pe_why": None, "stopped_at": None, "worst": 0.0, "last_ce": None, "last_pe": None, "n": 0, "ce_cost": False, "pe_cost": False}


def is_done(state: dict[str, Any]) -> bool:
    return not state["ce_open"] and not state["pe_open"]


def step(variant: str, ce0: float, pe0: float, state: dict[str, Any], ce: float | None, pe: float | None, at: str | None = None) -> dict[str, Any]:
    """Apply one stored sample (the last traded price of the call and the put) to one variant. Returns the new state; a finished variant is returned unchanged."""
    if is_done(state) or (ce is None and pe is None):
        return state
    kind, x = KIND[variant]
    s = dict(state)
    ce = s["last_ce"] if ce is None else ce
    pe = s["last_pe"] if pe is None else pe
    s["last_ce"], s["last_pe"], s["n"] = ce, pe, s["n"] + 1
    first_stop_before = s["stopped_at"] is not None
    if kind in ("leg", "legcost"):
        if s["ce_open"] and ce is not None and ce >= ce0 * (1 + x):
            s.update(ce_open=False, ce_x=ce, ce_why="stop")
        if s["pe_open"] and pe is not None and pe >= pe0 * (1 + x):
            s.update(pe_open=False, pe_x=pe, pe_why="stop")
        if kind == "legcost" and first_stop_before:  # the other leg's stop is now its own entry price (if it was moved): it closes when the price comes back to the entry
            if s["ce_open"] and s.get("ce_cost") and ce is not None and ce >= ce0:
                s.update(ce_open=False, ce_x=ce, ce_why="stop at cost")
            if s["pe_open"] and s.get("pe_cost") and pe is not None and pe >= pe0:
                s.update(pe_open=False, pe_x=pe, pe_why="stop at cost")
        if s["stopped_at"] is None and (not s["ce_open"] or not s["pe_open"]):
            s["stopped_at"] = at
            if kind == "legcost":  # "Move SL to cost", as the Strategy builder does it: only a leg that is in profit now (below its entry price, as it was sold) gets its stop moved
                if s["ce_open"] and ce is not None and ce < ce0:
                    s["ce_cost"] = True
                if s["pe_open"] and pe is not None and pe < pe0:
                    s["pe_cost"] = True
    elif kind == "comb" and ce is not None and pe is not None and ce + pe >= (ce0 + pe0) * (1 + x):
        s.update(ce_open=False, pe_open=False, ce_x=ce, pe_x=pe, ce_why="combined stop", pe_why="combined stop", stopped_at=at)
    if at is not None:  # when each leg closed (the time of the sample that showed it)
        if not s["ce_open"] and s.get("ce_at") is None:
            s["ce_at"] = at
        if not s["pe_open"] and s.get("pe_at") is None:
            s["pe_at"] = at
    c = s["ce_x"] if s["ce_x"] is not None else ce
    p = s["pe_x"] if s["pe_x"] is not None else pe
    if c is not None and p is not None:
        s["worst"] = min(s["worst"], (ce0 - c) + (pe0 - p))  # in points: the deepest the position was under water
    return s


def settle(variant: str, ce0: float, pe0: float, state: dict[str, Any], lot: int, cfg: CostCfg = CostCfg()) -> dict[str, Any] | None:  # noqa: B008
    """The result of a variant at the close: open legs are bought back at their last price. None when no price was ever seen."""
    ce_x = state["ce_x"] if state["ce_x"] is not None else state["last_ce"]
    pe_x = state["pe_x"] if state["pe_x"] is not None else state["last_pe"]
    if ce_x is None or pe_x is None:
        return None
    gross = ((ce0 - ce_x) + (pe0 - pe_x)) * lot
    cost = costs(ce0, pe0, ce_x, pe_x, lot, cfg)
    why = [w for w in (state["ce_why"], state["pe_why"]) if w]
    return {
        "ce_exit": ce_x, "pe_exit": pe_x, "gross": round(gross, 2), "cost": cost, "net": round(gross - cost, 2), "worst": round(state["worst"] * lot, 2),
        "reason": ", ".join(sorted(set(why))) if why else "close 15:20", "stopped_at": state["stopped_at"], "ce_at": state.get("ce_at"), "pe_at": state.get("pe_at"),
    }  # fmt: skip
