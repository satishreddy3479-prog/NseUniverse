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


def test_the_index_is_requested_only_in_the_silent_minutes(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Kotak's guide: a snapshot request returns the current state on the live feed.

    Asked at 15:15-15:21 IST every 20 s (here 10 ms); never at 15:10 or 15:25, and a failing
    request is survived."""
    import asyncio
    from types import SimpleNamespace

    from app.stream import manager as mgr
    from app.stream.models import FeedToken

    monkeypatch.setattr(mgr, "INDEX_SNAPSHOT_EVERY_S", 0.01)
    calls: list[list[FeedToken]] = []

    class Feed:
        fail = False

        async def snapshot_index(self, tokens: list[FeedToken]) -> None:
            if self.fail:
                raise RuntimeError("socket gone")
            calls.append(tokens)

    index = FeedToken(exchange_segment="nse_cm", instrument_token="Nifty 50", kind="index")
    other = FeedToken(exchange_segment="nse_fo", instrument_token="1")
    universe = SimpleNamespace(test_tokens=[index, other])

    def run(at: datetime, feed: Feed) -> StreamManager:
        m = object.__new__(StreamManager)
        m._now = lambda: at  # type: ignore[method-assign]
        m.index_snapshots_asked = 0

        async def go() -> None:
            task = asyncio.create_task(m._index_snapshots(feed, universe))  # type: ignore[arg-type]
            await asyncio.sleep(0.1)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

        asyncio.run(go())
        return m

    quiet = run(datetime(2026, 11, 19, 9, 40, 0, tzinfo=UTC), Feed())  # 15:10 IST: pushing
    assert quiet.index_snapshots_asked == 0 and calls == []
    inside = run(datetime(2026, 11, 19, 9, 46, 0, tzinfo=UTC), Feed())  # 15:16 IST
    assert inside.index_snapshots_asked >= 3 and all(c == [index] for c in calls)  # index only
    after = run(datetime(2026, 11, 19, 9, 56, 0, tzinfo=UTC), Feed())  # 15:26 IST: pushing again
    assert after.index_snapshots_asked == 0
    broken = Feed()
    broken.fail = True
    survived = run(datetime(2026, 11, 19, 9, 46, 0, tzinfo=UTC), broken)  # logged, loop carries on
    assert survived.index_snapshots_asked == 0
