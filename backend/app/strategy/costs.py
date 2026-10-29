"""Execution cost model for option trades (rupees). Rates are assumptions the caller can edit; defaults are only a start."""

from __future__ import annotations

from pydantic import BaseModel


class CostModel(BaseModel):
    brokerage_per_order: float = 20.0  # INR per executed leg
    stt_sell_pct: float = 0.1  # % of premium, sell side
    exchange_pct: float = 0.03503  # % of premium turnover
    sebi_pct: float = 0.0001  # % of turnover
    stamp_buy_pct: float = 0.003  # % of premium, buy side
    gst_pct: float = 18.0  # % on brokerage + exchange + SEBI
    slippage_per_unit: float = 0.0  # INR per unit, against the trader on every execution


def execution_cost(action: str, price: float, units: int, c: CostModel) -> float:
    """Cost of one execution of one leg at ``price`` (same formula as frontend/src/lib/strategy.ts)."""
    turnover = price * units
    exch = turnover * c.exchange_pct / 100
    sebi = turnover * c.sebi_pct / 100
    stt = turnover * c.stt_sell_pct / 100 if action == "SELL" else 0.0
    stamp = turnover * c.stamp_buy_pct / 100 if action == "BUY" else 0.0
    gst = (c.brokerage_per_order + exch + sebi) * c.gst_pct / 100
    return c.brokerage_per_order + exch + sebi + stt + stamp + gst + c.slippage_per_unit * units
