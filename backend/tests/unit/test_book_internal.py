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
