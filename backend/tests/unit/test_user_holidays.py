"""Holidays entered in Settings: merged over the NSE circular list, validated hard, kept in the data folder, never able to replace the verified list."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.prediction.calendar import (
    REFERENCE,
    USER_FILE_NAME,
    CalendarCoverageError,
    TradingCalendar,
    set_user_file,
    validate_user_holidays,
)
from tests.conftest import make_app

TODAY = date(2026, 11, 13)

# 2027 entries as a person would enter them from a circular (placeholders in the test, not the real circular)
H2027 = [
    {"date": "2027-01-26", "name": "Republic Day"},  # Tuesday
    {"date": "2027-03-26", "name": "Good Friday"},  # Friday
    {"date": "2027-10-20", "name": "Dussehra"},  # Wednesday
]


def doc(**over: Any) -> dict[str, Any]:
    d: dict[str, Any] = {
        "coverage_to": "2027-12-31",
        "source": "NSE circular NSE/CMTR/00000 (test), 12 Dec 2026",
        "holidays": H2027,
        "special_sessions": [{"date": "2027-11-07", "name": "Muhurat trading"}],  # a Sunday: special sessions may be weekends
        "confirm_complete": True,
    }
    d.update(over)
    return d


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    yield
    set_user_file(None)


def test_a_complete_entry_extends_the_calendar_and_the_circular_list_stays_untouched() -> None:
    clean, errors = validate_user_holidays(doc(), TODAY)
    assert errors == [] and clean is not None
    assert [h["date"] for h in clean["holidays"]] == ["2027-01-26", "2027-03-26", "2027-10-20"]
    ref = TradingCalendar._parse(REFERENCE)
    assert ref.coverage[1] == date(2026, 12, 31)  # the verified file itself is never edited


@pytest.mark.parametrize(
    ("over", "needle"),
    [
        ({"holidays": [*H2027, {"date": "2027-01-30", "name": "Saturday"}]}, "weekend"),
        ({"holidays": [*H2027, {"date": "2026-12-25", "name": "Christmas again"}]}, "already in the NSE circular list"),
        ({"holidays": [*H2027, {"date": "2027-01-26", "name": "Twice"}]}, "twice"),
        ({"holidays": [*H2027, {"date": "2028-01-26", "name": "Past the end"}]}, "outside the covered period"),
        ({"holidays": [*H2027, {"date": "2027-02-30", "name": "Not a date"}]}, "not a date"),
        ({"holidays": [*H2027, {"date": "2027-02-10", "name": ""}]}, "name"),
        ({"source": ""}, "circular"),
        ({"confirm_complete": False}, "every holiday"),
        ({"holidays": []}, "incomplete"),
        ({"coverage_to": "2026-06-30"}, "cannot end before"),
        ({"coverage_to": "2031-12-31"}, "too far"),
        ({"coverage_to": "soon"}, "covers up to"),
    ],
)
def test_every_silent_mistake_is_refused_with_a_reason(over: dict[str, Any], needle: str) -> None:
    clean, errors = validate_user_holidays(doc(**over), TODAY)
    assert clean is None and any(needle in e for e in errors), errors


def test_adding_one_holiday_inside_the_covered_period_needs_no_new_year(tmp_path: Path) -> None:
    # NSE sometimes declares an extra holiday mid-year: coverage stays the same, so nothing else has to be confirmed
    d = doc(coverage_to="2026-12-31", holidays=[{"date": "2026-12-04", "name": "Declared holiday"}], special_sessions=[], confirm_complete=False)
    clean, errors = validate_user_holidays(d, TODAY)
    assert errors == [] and clean is not None


def test_the_api_saves_the_entry_and_every_part_of_the_app_sees_it_at_once(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    with TestClient(app, client=("127.0.0.1", 50000)) as c:
        cal = TradingCalendar.load()
        with pytest.raises(CalendarCoverageError):
            cal.is_session(date(2027, 1, 5))  # the period ended on 31 Dec 2026
        before = c.get("/api/market/holidays").json()
        assert before["effective_coverage"][1] == "2026-12-31" and before["user"]["holidays"] == []
        r = c.put("/api/market/holidays", json=doc())
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["effective_coverage"][1] == "2027-12-31"
        assert [h["date"] for h in body["user"]["holidays"]] == ["2027-01-26", "2027-03-26", "2027-10-20"]
        assert cal.is_session(date(2027, 1, 5)) and not cal.is_session(date(2027, 1, 26)) and not cal.is_session(date(2027, 3, 26))
        assert cal.is_special_session(date(2027, 11, 7))
        sess = c.get("/api/market/session").json()
        assert "2027-01-26" in sess["holidays"] and sess["holiday_coverage"][1] == "2027-12-31"  # the browser's holiday list follows
        assert (tmp_path / "data" / USER_FILE_NAME).exists()
        assert c.put("/api/market/holidays", json=doc(source="")).status_code == 422
        assert c.get("/api/market/holidays").json()["user"]["holidays"][0]["date"] == "2027-01-26"  # a refused save changes nothing


def test_the_entry_survives_a_restart(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path), client=("127.0.0.1", 50000)) as c:
        assert c.put("/api/market/holidays", json=doc()).status_code == 200
    set_user_file(None)
    assert TradingCalendar.load().coverage[1] == date(2026, 12, 31)
    with TestClient(make_app(tmp_path), client=("127.0.0.1", 50000)) as c:  # a new start-up reads the same data folder
        assert c.get("/api/market/holidays").json()["effective_coverage"][1] == "2027-12-31"
        assert not TradingCalendar.load().is_session(date(2027, 10, 20))


def test_only_the_server_itself_may_change_the_list(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    with TestClient(app, client=("203.0.113.9", 50000)) as remote:
        assert remote.put("/api/market/holidays", json=doc()).status_code == 403
        assert remote.get("/api/market/holidays").status_code == 200  # reading is open


def test_a_damaged_user_file_never_takes_the_verified_calendar_down(tmp_path: Path) -> None:
    f = tmp_path / "bad.json"
    f.write_text("{not json", encoding="utf-8")
    set_user_file(f)
    cal = TradingCalendar.load()
    assert cal.coverage[1] == date(2026, 12, 31) and cal.is_session(date(2026, 11, 13))
    f.write_text('{"coverage_to": "2027-12-31", "holidays": [{"date": "bad"}]}', encoding="utf-8")
    set_user_file(f)
    assert TradingCalendar.load().coverage[1] == date(2026, 12, 31)  # an unreadable entry is ignored as a whole
