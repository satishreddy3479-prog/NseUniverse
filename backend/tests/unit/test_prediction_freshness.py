"""US trading days, used by the daily-history service so a US holiday is not mistaken for a late data feed."""

from __future__ import annotations

from datetime import date

from app.prediction.usmarket import is_us_session, last_us_session_on_or_before


def test_us_holidays_are_not_trading_days() -> None:
    assert not is_us_session(date(2026, 11, 26)) and not is_us_session(date(2026, 4, 3))  # Thanksgiving, Good Friday
    assert is_us_session(date(2026, 11, 25)) and not is_us_session(date(2026, 11, 28))
    assert last_us_session_on_or_before(date(2026, 11, 26)) == date(2026, 11, 25)
    assert last_us_session_on_or_before(date(2026, 11, 29)) == date(2026, 11, 27)  # Sunday: the Friday after Thanksgiving was open
    assert last_us_session_on_or_before(date(2026, 11, 27)) == date(2026, 11, 27)
