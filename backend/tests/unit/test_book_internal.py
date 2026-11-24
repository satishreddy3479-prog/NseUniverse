"""Server-side contracts (the NIFTY futures) are read with get_internal, not the browser lookup."""

from datetime import UTC, datetime

from app.stream.book import LiveBook
from app.stream.models import LiveTick


def test_internal_tick_is_returned_by_key_and_not_by_the_browser_lookup() -> None:
    book = LiveBook()
    tick = LiveTick(
        key="nse_fo|111", exchange_segment="nse_fo", instrument_token="111", kind="scrip",
        ltp=25820.5, received_at=datetime.now(UTC),
    )
    book.internal_keys = {"nse_fo|111"}
    book.update_internal(tick)
    assert book.get_internal("nse_fo|111") is tick
    assert book.get("nse_fo|111") is None  # not in the browser book: why the server needs this
    assert book.get_internal("nse_fo|999") is None


def _fut(ltp: float, key: str = "nse_fo|111") -> LiveTick:
    return LiveTick(
        key=key, exchange_segment="nse_fo", instrument_token=key.split("|")[1], kind="scrip",
        ltp=ltp, received_at=datetime.now(UTC),
    )


def test_a_public_internal_contract_reaches_the_browsers_without_counting_as_option_feed() -> None:
    book = LiveBook()
    sent = book.publish_internal(_fut(25820.5))
    assert sent is not None and sent.seq == 1
    assert [t.key for t in book.drain_pending()] == ["nse_fo|111"]  # broadcast with the next flush
    assert [t.ltp for t in book.snapshot()] == [25820.5]  # and in a new client's first message
    assert len(book) == 0 and book.tick_count == 0 and book.get("nse_fo|111") is None  # never option-feed activity
    assert book.publish_internal(_fut(25820.5)) is None  # an exact repeat is not sent again
    assert book.drain_pending() == []
    changed = book.publish_internal(_fut(25821.0))
    assert changed is not None and changed.seq == 2
    book.clear()
    assert book.snapshot() == []
