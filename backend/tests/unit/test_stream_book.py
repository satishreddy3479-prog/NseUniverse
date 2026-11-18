"""A repeated tick is not broadcast again, but it proves the feed is alive: its receive time moves."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.stream.book import LiveBook
from app.stream.models import LiveTick

T0 = datetime(2026, 11, 18, 9, 45, 0, tzinfo=UTC)  # 15:15 IST, when the index value stopped changing


def tick(ltp: float, at: datetime) -> LiveTick:
    return LiveTick(key="nse_cm|Nifty 50", kind="index", exchange_segment="nse_cm", instrument_token="Nifty 50", ltp=ltp, received_at=at)


def test_a_repeat_is_not_returned_for_broadcast_but_refreshes_the_stored_receive_time() -> None:
    book = LiveBook()
    first = book.update(tick(25220.45, T0))
    assert first is not None and book.get("nse_cm|Nifty 50") is not None
    assert book.update(tick(25220.45, T0 + timedelta(seconds=1))) is None  # a repeat: nothing to broadcast
    assert book.update(tick(25220.45, T0 + timedelta(seconds=30))) is None
    stored = book.get("nse_cm|Nifty 50")
    assert stored is not None and stored.received_at == T0 + timedelta(seconds=30)  # the tick is 0 seconds old, not 30
    assert stored.seq == first.seq and book.tick_count == 1  # still one change
    assert len(book.drain_pending()) == 1  # and only the change goes to the browsers
    changed = book.update(tick(25221.0, T0 + timedelta(seconds=31)))
    assert changed is not None and changed.seq == first.seq + 1


def test_an_older_repeat_never_moves_the_receive_time_back() -> None:
    book = LiveBook()
    book.update(tick(1.0, T0 + timedelta(seconds=10)))
    assert book.update(tick(1.0, T0)) is None
    stored = book.get("nse_cm|Nifty 50")
    assert stored is not None and stored.received_at == T0 + timedelta(seconds=10)
