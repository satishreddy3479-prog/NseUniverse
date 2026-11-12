"""Index VWAP estimate, stock futures and rollover (pure functions: no I/O, no clock, no broker).

The broker feed carries no traded volume for the NIFTY 50 index, so a true spot VWAP does not exist. What does exist is each constituent's own day VWAP (the
exchange's average trade price) and its previous close. The index is a weighted average of its constituents, so the same weights applied to each stock's
VWAP-to-previous-close ratio give an index-equivalent VWAP:

    index VWAP (estimate) = previous index close x sum(w_i x VWAP_i / prevclose_i) / sum(w_i)

It is an ESTIMATE: the weights are the stored index weights (official when loaded, otherwise approximate), stocks without a fresh reading are left out and the
share of weight actually used is reported. It is never mixed up with the futures VWAP.

Stock futures: the current-month and next-month contract of each NIFTY 50 stock (and the NIFTY next-month future) come from the same feed. Open interest
change is measured against the FIRST reading of the session (the feed carries no previous-day OI), the buildup label follows the usual price/OI rule and
rollover is the next-month share of the open interest by value. Missing values stay missing.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

FRESH_S = 180.0  # a quote older than this is not used
MIN_INDEX_STOCKS = 30
MIN_INDEX_WEIGHT_SHARE = 0.80


@dataclass
class FoQuote:
    """The latest streamed quote of one futures contract."""

    ltp: float | None = None
    prev_close: float | None = None
    volume: int | None = None
    oi: int | None = None
    atp: float | None = None
    at: datetime | None = None

    def fresh(self, now: datetime, within: float = FRESH_S) -> bool:
        return self.at is not None and (now - self.at).total_seconds() <= within


def _r(v: float | None, n: int = 2) -> float | None:
    return None if v is None else round(v, n)


def index_vwap(stocks: Mapping[str, tuple[float | None, float | None, float | None]], index_prev_close: float | None, spot: float | None) -> dict[str, Any]:
    """``stocks``: symbol -> (index weight %, day VWAP, previous close). Returns the estimate or the reason there is none."""
    total_w = sum(w for w, _, _ in stocks.values() if w)
    use = [(w, a, p) for w, a, p in stocks.values() if w and a and p and a > 0 and p > 0]
    note = ("Estimated from the constituents' own day VWAPs weighted by index weight; the broker feed has no volume for the index itself, so this is not a true spot VWAP. "
            "Stocks without a fresh VWAP are left out.")
    if not index_prev_close or index_prev_close <= 0:
        return {"value": None, "reason": "the index previous close is not available", "note": note}
    w_used = sum(w for w, _, _ in use)
    share = 0.0 if total_w <= 0 else w_used / total_w
    if len(use) < MIN_INDEX_STOCKS or share < MIN_INDEX_WEIGHT_SHARE:
        return {"value": None, "stocks": len(use), "weight_share": _r(share, 3),
                "reason": f"needs at least {MIN_INDEX_STOCKS} stocks and {MIN_INDEX_WEIGHT_SHARE:.0%} of the weight with a day VWAP; have {len(use)} stocks and {share:.0%}", "note": note}
    ratio = sum(w * a / p for w, a, p in use) / w_used
    value = index_prev_close * ratio
    out: dict[str, Any] = {"value": _r(value, 2), "stocks": len(use), "weight_share": _r(share, 3), "estimate": True, "note": note, "method": "previous index close x weighted mean of (stock VWAP / stock previous close)"}
    if spot is not None and spot > 0:
        d = spot - value
        out |= {"spot": _r(spot, 2), "distance_pts": _r(d, 2), "distance_pct": _r(d / value * 100, 3), "side": "above" if d > 0 else "below" if d < 0 else "at"}
    return out


def buildup(price_pct: float | None, oi_change: float | None) -> str | None:
    """The usual price/open-interest rule. A zero or missing change gives no label."""
    if price_pct is None or oi_change is None or price_pct == 0 or oi_change == 0:
        return None
    if oi_change > 0:
        return "Long buildup" if price_pct > 0 else "Short buildup"
    return "Short covering" if price_pct > 0 else "Long unwinding"


def _value(q: FoQuote | None) -> float | None:
    return None if q is None or q.oi is None or q.ltp is None else q.oi * q.ltp


def stock_futures(
    symbols: Sequence[str], cur: Mapping[str, FoQuote], nxt: Mapping[str, FoQuote], cash: Mapping[str, float | None], base_oi: Mapping[str, int | None], now: datetime,
) -> dict[str, Any]:
    """One row per stock with a fresh current-month future, plus the aggregates. ``base_oi``: each future's first open interest reading of the session."""
    rows: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    cur_val = nxt_val = 0.0
    for s in symbols:
        c = cur.get(s)
        if c is None or not c.fresh(now) or c.ltp is None:
            continue
        n = nxt.get(s)
        price_pct = None if not c.prev_close else (c.ltp / c.prev_close - 1) * 100
        b = base_oi.get(s)
        oi_chg = None if c.oi is None or b is None else c.oi - b
        oi_pct = None if oi_chg is None or not b else oi_chg / b * 100
        lab = buildup(price_pct, oi_chg)
        if lab:
            counts[lab] = counts.get(lab, 0) + 1
        cv, nv = _value(c), _value(n) if n is not None and n.fresh(now) else None
        roll = None if cv is None or nv is None or cv + nv <= 0 else nv / (cv + nv) * 100
        if cv is not None and nv is not None:
            cur_val += cv
            nxt_val += nv
        cash_px = cash.get(s)
        rows.append({
            "symbol": s, "ltp": _r(c.ltp), "price_change_pct": _r(price_pct), "oi": c.oi, "oi_change": oi_chg, "oi_change_pct": _r(oi_pct), "buildup": lab, "volume": c.volume,
            "basis_pct": _r(None if not cash_px else (c.ltp / cash_px - 1) * 100, 3),
            "next_ltp": None if n is None or not n.fresh(now) else _r(n.ltp), "next_oi": None if n is None or not n.fresh(now) else n.oi,
            "rollover_pct": _r(roll, 1), "roll_cost_pct": _r(None if n is None or not n.fresh(now) or not n.ltp else (n.ltp / c.ltp - 1) * 100, 3),
        })
    tot = cur_val + nxt_val
    return {
        "rows": rows, "covered": len(rows), "of": len(symbols), "buildup_counts": counts,
        "rollover_pct": _r(None if tot <= 0 else nxt_val / tot * 100, 1), "rollover_stocks": sum(1 for r in rows if r["rollover_pct"] is not None),
        "note": "Open interest change is against the first reading of the session (the feed has no previous-day open interest). Rollover is the next-month share of open interest by value (open interest x price).",
    }


def nifty_rollover(cur: FoQuote | None, nxt: FoQuote | None, now: datetime, base_cur: int | None = None, base_next: int | None = None) -> dict[str, Any]:
    """NIFTY current- and next-month future: next-month share of the open interest (units) and the roll cost."""
    if cur is None or nxt is None or not cur.fresh(now) or not nxt.fresh(now) or cur.oi is None or nxt.oi is None or cur.ltp is None or nxt.ltp is None:
        return {"available": False, "reason": "needs a fresh quote of both the current- and the next-month NIFTY future"}
    tot = cur.oi + nxt.oi
    out: dict[str, Any] = {"available": True, "cur_oi": cur.oi, "next_oi": nxt.oi, "rollover_pct": _r(nxt.oi / tot * 100, 1) if tot > 0 else None,
                           "cur_ltp": _r(cur.ltp), "next_ltp": _r(nxt.ltp), "roll_cost_pts": _r(nxt.ltp - cur.ltp), "roll_cost_pct": _r((nxt.ltp / cur.ltp - 1) * 100, 3)}
    if base_cur is not None and base_next is not None and base_cur + base_next > 0:
        out["rollover_pct_at_open"] = _r(base_next / (base_cur + base_next) * 100, 1)
        out["cur_oi_change"] = cur.oi - base_cur
        out["next_oi_change"] = nxt.oi - base_next
    return out
