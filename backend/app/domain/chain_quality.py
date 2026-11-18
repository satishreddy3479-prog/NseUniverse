"""Is the part of a chain snapshot that the pages total up complete?

The OI and volume boards, Smart OI, the OI series and the heatmap add up the contracts around
the ATM strike. A capture in which the broker returned one of those contracts without its open
interest (18 Nov 2026, 10:27: call OI 65.3 M against 73.5 M a minute before and after) shows up
as a dip in every total and as a gap in the per-candle bars. The sample is stored as it came
(nothing is filled in), but the sampler asks the broker again a moment later and keeps the more
complete answer.
"""

from __future__ import annotations

from app.domain.models import OptionChainSnapshot, OptionQuote

EACH_SIDE = 10  # strikes either side of the ATM strike that the pages total up


def _holes(q: OptionQuote | None) -> bool:
    return q is None or q.oi is None or q.volume is None or q.ltp is None


def core_holes(snap: OptionChainSnapshot, each: int = EACH_SIDE) -> int:
    """Contracts within ``each`` strikes of the index with no OI, volume or last price."""
    spot = snap.underlying_ltp
    if spot is None or not snap.rows:
        return 0 if not snap.rows else len(snap.rows) * 2
    rows = sorted(snap.rows, key=lambda r: r.strike)
    atm = min(range(len(rows)), key=lambda i: abs(rows[i].strike - spot))
    near = rows[max(0, atm - each) : atm + each + 1]
    return sum(int(_holes(r.call)) + int(_holes(r.put)) for r in near)
