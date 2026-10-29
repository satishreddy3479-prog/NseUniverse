"""Transaction costs for paper-trading the NIFTY index future (configurable assumptions, pure).

Defaults are ASSUMPTIONS to be replaced with the owner's broker contract note; they are never presented as exact:
* brokerage: flat per executed order (default 20 rupees, a common discount-broker cap)
* STT: futures sell side 0.05 % of turnover (rate in force from 1 April 2026 per the exchange/broker circulars)
* exchange transaction charge: 0.00183 % of turnover both sides (NSE futures; verify)
* SEBI fee: 0.0001 % of turnover both sides; stamp duty: 0.002 % on the buy side
* GST: 18 % of (brokerage + exchange charge + SEBI fee)
* slippage: points per side (default 0.5, or half the measured bid/ask spread when known)
Turnover = price x lot size x lots. Lot size is configuration, never a constant in the logic.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CostModel:
    lot_size: int = 65
    brokerage_per_order: float = 20.0
    stt_sell_pct: float = 0.05
    exchange_pct: float = 0.00183
    sebi_pct: float = 0.0001
    stamp_buy_pct: float = 0.002
    gst_pct: float = 18.0
    slippage_pts: float = 0.5

    def leg(self, price: float, lots: int, side: str) -> float:
        """Rupee charges of one executed order (side 'buy' or 'sell'), excluding slippage."""
        turnover = price * self.lot_size * lots
        exch = turnover * self.exchange_pct / 100
        sebi = turnover * self.sebi_pct / 100
        gst = (self.brokerage_per_order + exch + sebi) * self.gst_pct / 100
        stt = turnover * self.stt_sell_pct / 100 if side == "sell" else 0.0
        stamp = turnover * self.stamp_buy_pct / 100 if side == "buy" else 0.0
        return self.brokerage_per_order + exch + sebi + gst + stt + stamp

    def round_trip(self, entry: float, exit_: float, lots: int, direction: str, slippage_pts: float | None = None) -> dict[str, Any]:
        """Gross and net result in points and rupees for one trade; slippage is paid on both sides against the trader."""
        slip = self.slippage_pts if slippage_pts is None else slippage_pts
        buy, sell = (entry, exit_) if direction == "long" else (exit_, entry)
        charges = self.leg(buy, lots, "buy") + self.leg(sell, lots, "sell")
        gross_pts = (exit_ - entry) if direction == "long" else (entry - exit_)
        gross_rs = gross_pts * self.lot_size * lots
        slip_rs = 2 * slip * self.lot_size * lots
        net_rs = gross_rs - slip_rs - charges
        return {"gross_points": round(gross_pts, 2), "gross_rupees": round(gross_rs, 2), "charges_rupees": round(charges, 2), "slippage_rupees": round(slip_rs, 2),
                "net_rupees": round(net_rs, 2), "net_points": round(net_rs / (self.lot_size * lots), 3)}  # fmt: skip

    def cost_points(self, price: float, lots: int = 1, slippage_pts: float | None = None) -> float:
        """Round-trip cost expressed in index points at ``price`` (charges + two-sided slippage)."""
        rt = self.round_trip(price, price, lots, "long", slippage_pts)
        return round(-rt["net_points"], 3)
