"""Portfolio analytics of the live paper book (the 1-minute candle book), from its own closed fills and its own recorded equity.

Pure functions: no I/O, no clock. A figure that cannot be computed from what is stored is None (never zero), and the equity-based figures say
from when the equity was recorded: the live book started recording its equity on the day this was added, nothing is back-filled.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any


def trade_r(row: Mapping[str, Any]) -> float | None:
    """R multiple of a closed fill: gross P&L over the money risked at entry (shares x (fill - initial stop)). None if the risk is not positive."""
    risk = (row["fill"] - row["initial_sl"]) * row["shares"]
    gross = row.get("gross_pnl")
    if risk <= 0 or gross is None:
        return None
    return float(gross) / float(risk)


def hold_minutes(row: Mapping[str, Any]) -> float | None:
    """Minutes from the fill to the exit (wall clock, so an overnight hold counts the night)."""
    a, b = row.get("filled_at"), row.get("exit_at")
    if not a or not b:
        return None
    return (datetime.fromisoformat(str(b)) - datetime.fromisoformat(str(a))).total_seconds() / 60.0


def max_drawdown_pct(values: Sequence[float]) -> float | None:
    """Largest fall from a previous peak, as a percentage of that peak (a positive number). None with fewer than two values."""
    if len(values) < 2:
        return None
    peak, worst = values[0], 0.0
    for v in values:
        peak = max(peak, v)
        if peak > 0:
            worst = max(worst, (peak - v) / peak * 100.0)
    return worst


def book_analytics(closed: Sequence[Mapping[str, Any]], capital: float, equity_now: float, series: Sequence[tuple[str, float]]) -> dict[str, Any]:
    pnls = [float(c["pnl"]) for c in closed if c.get("pnl") is not None]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    rs = [r for r in (trade_r(c) for c in closed) if r is not None]
    holds = [h for h in (hold_minutes(c) for c in closed) if h is not None]
    by_pnl = sorted((c for c in closed if c.get("pnl") is not None), key=lambda c: c["pnl"])
    n = len(pnls)
    eq = [v for _, v in series]
    return {
        "trades": n, "wins": len(wins), "losses": len(losses),
        "win_rate_pct": None if n == 0 else len(wins) / n * 100.0,
        "net_pnl": sum(pnls) if n else None,
        "gross_pnl": sum(float(c["gross_pnl"]) for c in closed if c.get("gross_pnl") is not None) if n else None,
        "costs": sum(float(c["costs"]) for c in closed if c.get("costs") is not None) if n else None,
        "avg_win": sum(wins) / len(wins) if wins else None,
        "avg_loss": sum(losses) / len(losses) if losses else None,
        "profit_factor": sum(wins) / abs(sum(losses)) if losses else None,  # None with no losing trade: it would be infinite, not a number to show
        "expectancy": sum(pnls) / n if n else None,
        "avg_r": sum(rs) / len(rs) if rs else None,
        "avg_hold_minutes": sum(holds) / len(holds) if holds else None,
        "best": None if not by_pnl else {"symbol": by_pnl[-1]["symbol"], "pnl": by_pnl[-1]["pnl"]},
        "worst": None if not by_pnl else {"symbol": by_pnl[0]["symbol"], "pnl": by_pnl[0]["pnl"]},
        "return_pct": (equity_now - capital) / capital * 100.0 if capital else None,
        "max_drawdown_pct": max_drawdown_pct(eq),
        "equity_points": len(series), "equity_from": series[0][0] if series else None,
    }
