from datetime import date

from app.domain.expiry import parse_expiry_dates, select_expiries


def d(s: str) -> date:
    return date.fromisoformat(s)


def test_parse_sorts_dedupes_and_reports_bad_values() -> None:
    dates, warnings = parse_expiry_dates(["2026-11-24", "2026-11-03", "2026-11-03", "bad", 5])
    assert dates == [d("2026-11-03"), d("2026-11-24")]
    assert len(warnings) == 2


def test_weekly_is_nearest_on_or_after_today_including_today() -> None:
    exp = [d("2026-10-27"), d("2026-10-28"), d("2026-11-04")]
    assert select_expiries(exp, d("2026-10-28")).weekly == d("2026-10-28")
    assert select_expiries(exp, d("2026-10-29")).weekly == d("2026-11-04")


def test_monthly_is_last_listed_expiry_in_current_month() -> None:
    exp = [d("2026-11-03"), d("2026-11-10"), d("2026-11-24"), d("2026-12-29")]
    c = select_expiries(exp, d("2026-11-01"))
    assert (c.weekly, c.monthly, c.monthly_is_next_month) == (
        d("2026-11-03"),
        d("2026-11-24"),
        False,
    )


def test_irregular_holiday_shifted_dates_are_respected() -> None:
    # Last expiry of the month moved to a Monday: we must not assume a weekday.
    exp = [d("2026-11-03"), d("2026-11-10"), d("2026-11-23")]
    assert select_expiries(exp, d("2026-11-02")).monthly == d("2026-11-23")


def test_monthly_rolls_to_next_month_when_none_left_this_month() -> None:
    exp = [d("2026-10-27"), d("2026-11-03"), d("2026-11-24"), d("2026-12-29")]
    c = select_expiries(exp, d("2026-10-28"))
    assert c.weekly == d("2026-11-03")
    assert c.monthly == d("2026-11-24") and c.monthly_is_next_month
    assert any("rolled" in w for w in c.warnings)


def test_december_rolls_to_january() -> None:
    exp = [d("2027-01-05"), d("2027-01-26")]
    c = select_expiries(exp, d("2026-12-31"))
    assert c.monthly == d("2027-01-26") and c.monthly_is_next_month


def test_weekly_equals_monthly_detected() -> None:
    exp = [d("2026-11-24"), d("2026-12-01")]
    c = select_expiries(exp, d("2026-11-20"))
    assert c.weekly == c.monthly == d("2026-11-24")
    assert c.weekly_equals_monthly


def test_no_upcoming_expiries() -> None:
    c = select_expiries([d("2026-01-01")], d("2026-10-28"))
    assert c.weekly is None and c.monthly is None and c.warnings


def test_monthly_unavailable_when_gap_beyond_next_month() -> None:
    c = select_expiries([d("2027-02-23")], d("2026-11-25"))
    assert c.weekly == d("2027-02-23") and c.monthly is None and c.warnings
