from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from app.domain.session import market_time

IST = ZoneInfo("Asia/Kolkata")


def _ist(y: int, m: int, d: int, hh: int, mm: int) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=IST)


def test_inside_the_session_the_time_is_unchanged() -> None:
    t = _ist(2026, 10, 29, 11, 0)
    assert market_time(t) == t
    assert market_time(_ist(2026, 10, 29, 15, 40)) == _ist(2026, 10, 29, 15, 40)


def test_after_the_close_and_overnight_it_is_the_last_close() -> None:
    assert market_time(_ist(2026, 10, 29, 21, 0)) == _ist(2026, 10, 29, 15, 40)
    # the real case: fetched 02:37 IST on Friday 30 Oct (21:07 UTC on the 29th) holds Thursday's 15:40 prices
    assert market_time(datetime(2026, 10, 29, 21, 7, 37, tzinfo=UTC)) == _ist(2026, 10, 29, 15, 40)
    assert market_time(_ist(2026, 10, 29, 15, 41)) == _ist(2026, 10, 29, 15, 40)


def test_weekend_and_pre_open_use_the_previous_trading_day() -> None:
    assert market_time(_ist(2026, 10, 31, 12, 0)) == _ist(2026, 10, 30, 15, 40)  # Saturday
    assert market_time(_ist(2026, 11, 2, 8, 0)) == _ist(2026, 10, 30, 15, 40)  # Monday before the open


def test_an_exchange_holiday_is_skipped_when_the_calendar_knows_it() -> None:
    holiday = date(2026, 10, 29)
    cal = lambda d: False if d == holiday else None  # noqa: E731
    assert market_time(_ist(2026, 10, 30, 8, 0), cal) == _ist(2026, 10, 28, 15, 40)
    assert market_time(_ist(2026, 10, 29, 12, 0), cal) == _ist(2026, 10, 28, 15, 40)  # inside the hours of a holiday: not a session
