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


def test_same_compares_every_field_except_the_two_that_always_differ() -> None:
    """``_same`` runs for every tick on the event loop and compares field by field (the dump of both ticks cost 12.9 us, this 4.7 us); it must keep the meaning of the dump comparison."""
    full = {"key": "nse_fo|1", "kind": "scrip", "exchange_segment": "nse_fo", "instrument_token": "1", "trading_symbol": "X", "ltp": 100.5, "open": 1.0, "high": 2.0, "low": 0.5, "prev_close": 99.0,
            "volume": 1000, "oi": 5000, "bid": 100.0, "ask": 101.0, "bid_qty": 10, "ask_qty": 12}
    a = LiveTick(**full, received_at=T0)
    assert LiveBook._same(a, LiveTick(**full, received_at=T0 + timedelta(seconds=9), seq=7))  # time and sequence do not count
    for f in LiveBook._COMPARED:
        assert f in LiveTick.model_fields
    for field, other in (("ltp", 100.55), ("oi", 5001), ("bid", None), ("bid_qty", 11), ("trading_symbol", "Y")):
        changed = LiveTick(**{**full, field: other}, received_at=T0)
        assert not LiveBook._same(a, changed), field
    assert "received_at" not in LiveBook._COMPARED and "seq" not in LiveBook._COMPARED

