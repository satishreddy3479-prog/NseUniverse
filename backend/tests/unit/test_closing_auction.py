"""The closing auction session is read from the cash segment's own status messages.

19 Nov 2026: nse_cm code 8 at 15:15:00 IST, 10 at 15:20, closed at 15:30; F&O sent none.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.stream.feed import classify_market_status
from app.stream.manager import StreamManager


def manager_with(segments: dict[str, tuple[int, datetime]]) -> StreamManager:
    m = object.__new__(StreamManager)  # only the segment map is read
    m.market_segments = {
        seg: classify_market_status(code, f"code {code}", seg, at)
        for seg, (code, at) in segments.items()
    }
    return m


T1515 = datetime(2026, 11, 19, 9, 45, 0, tzinfo=UTC)
T1520 = datetime(2026, 11, 19, 9, 50, 0, tzinfo=UTC)


def test_the_cash_segment_codes_give_the_auction_phase_and_f_and_o_does_not() -> None:
    a = manager_with({"nse_cm": (8, T1515), "nse_fo": (12, T1515)})._closing_auction()
    # the F&O segment's own code 12 is not the cash segment's
    assert a is not None and a.phase == "transition" and a.code == 8 and a.since == T1515
    b = manager_with({"nse_cm": (10, T1520)})._closing_auction()
    assert b is not None and b.phase == "order_entry"
    c = manager_with({"nse_cm": (11, T1520)})._closing_auction()
    assert c is not None and c.phase == "orders_restricted"
    d = manager_with({"nse_cm": (12, T1520)})._closing_auction()
    assert d is not None and d.phase == "ended"


def test_no_auction_outside_it_and_without_a_cash_message() -> None:
    assert manager_with({"nse_cm": (1, T1515)})._closing_auction() is None  # market open
    assert manager_with({"nse_cm": (2, T1520)})._closing_auction() is None  # closed at 15:30
    assert manager_with({"nse_fo": (12, T1515)})._closing_auction() is None  # another segment
    assert manager_with({})._closing_auction() is None
