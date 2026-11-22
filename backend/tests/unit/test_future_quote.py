"""Which NIFTY future a strategy gets and its price: current month, next month after expiry."""

from datetime import UTC, date, datetime, timedelta

from app.market.future_quote import future_contracts, month_expiry
from app.market.futures import FoQuote

NOW = datetime(2026, 11, 23, 5, 0, tzinfo=UTC)
AVAILABLE = [
    date(2026, 11, 24),
    date(2026, 12, 1),
    date(2026, 12, 8),
    date(2026, 12, 29),
    date(2027, 1, 26),
    date(2026, 11, 17),
]


def call(monthly: date | None, cur: FoQuote, nxt: FoQuote, now: datetime = NOW) -> dict:
    return future_contracts(
        monthly=monthly,
        available=AVAILABLE,
        cur_symbol="NIFTY26NOVFUT",
        cur_token="111",
        cur=cur,
        next_symbol="NIFTY26DECFUT",
        next_token="222",
        nxt=nxt,
        now=now,
    )


def test_the_monthly_expiry_of_a_month_is_its_last_listed_expiry() -> None:
    assert month_expiry(AVAILABLE, 2026, 11) == date(2026, 11, 24)
    assert month_expiry(AVAILABLE, 2026, 12) == date(2026, 12, 29)  # not the weekly 1 and 8 Dec
    assert month_expiry(AVAILABLE, 2027, 3) is None


def test_current_is_the_resolved_monthly_and_next_is_the_following_month() -> None:
    out = call(
        date(2026, 11, 24),
        FoQuote(ltp=25820.5, at=NOW - timedelta(seconds=5)),
        FoQuote(ltp=25910.0, at=NOW - timedelta(seconds=9)),
    )
    assert (
        out["current"]["symbol"],
        out["current"]["key"],
        out["current"]["expiry"],
        out["current"]["ltp"],
    ) == ("NIFTY26NOVFUT", "nse_fo|111", "2026-11-24", 25820.5)
    assert (
        out["next"]["symbol"],
        out["next"]["key"],
        out["next"]["expiry"],
        out["next"]["ltp"],
    ) == ("NIFTY26DECFUT", "nse_fo|222", "2026-12-29", 25910.0)


def test_after_the_november_expiry_the_current_contract_is_december_and_next_is_january() -> None:
    out = future_contracts(
        monthly=date(2026, 12, 29),
        available=AVAILABLE,
        cur_symbol="NIFTY26DECFUT",
        cur_token="222",
        cur=FoQuote(ltp=25900.0, at=NOW),
        next_symbol="NIFTY27JANFUT",
        next_token="333",
        nxt=FoQuote(),
        now=NOW,
    )
    assert out["current"]["expiry"] == "2026-12-29" and out["next"]["expiry"] == "2027-01-26"


def test_december_rolls_into_january_of_the_next_year() -> None:
    out = call(date(2026, 12, 29), FoQuote(), FoQuote())
    assert out["next"]["expiry"] == "2027-01-26"


def test_a_missing_or_old_price_is_missing_never_zero_or_last_known() -> None:
    old = FoQuote(ltp=25800.0, at=NOW - timedelta(seconds=600))
    out = call(date(2026, 11, 24), old, FoQuote())
    assert (
        out["current"]["ltp"] is None
        and out["current"]["fresh"] is False
        and "older" in out["current"]["note"]
    )
    assert out["next"]["ltp"] is None and out["next"]["note"] == "no price yet"
    assert call(date(2026, 11, 24), FoQuote(ltp=0.0, at=NOW), FoQuote())["current"]["ltp"] is None
