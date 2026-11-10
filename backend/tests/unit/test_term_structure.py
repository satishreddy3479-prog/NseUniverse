# ruff: noqa: E501
"""Term structure: slope per 30 days, shape, expiry-day exclusion, missing IVs."""

from __future__ import annotations

import pytest

from app.intraday.volatility import iv_term_structure as term_structure


def row(expiry: str, days: float, iv: float | None) -> dict[str, object]:
    return {"expiry": expiry, "days": days, "atm_iv": iv}


def test_slope_is_far_minus_near_over_the_day_gap_times_30() -> None:
    out = term_structure([row("a", 5, 14.0), row("b", 12, 15.4), row("c", 40, 17.0)])
    # (17.0 - 14.0) / (40 - 5) * 30 = 2.5714
    assert out["slope_per_30d"] == pytest.approx(2.571, abs=1e-3) and out["shape"] == "contango"
    assert out["near"]["expiry"] == "a" and out["far"]["expiry"] == "c"
    # neighbour pairs: (15.4 - 14) / 7 * 30 = 6.0 and (17 - 15.4) / 28 * 30 = 1.7143
    assert [p["slope"] for p in out["pairs"]] == [pytest.approx(6.0, abs=1e-3), pytest.approx(1.714, abs=1e-3)]


def test_backwardation_and_flat() -> None:
    assert term_structure([row("a", 5, 18.0), row("b", 35, 15.0)])["shape"] == "backwardation"  # -3 / 30 * 30 = -3
    assert term_structure([row("a", 5, 15.0), row("b", 35, 15.2)])["shape"] == "flat"  # +0.2


def test_expiry_day_is_left_out_of_the_slope_but_reported() -> None:
    out = term_structure([row("today", 0.2, 30.0), row("b", 7, 14.0), row("c", 37, 15.5)])
    assert out["near"]["expiry"] == "b" and out["slope_per_30d"] == pytest.approx(1.5, abs=1e-3)
    assert out["left_out"][0]["expiry"] == "today"


def test_missing_iv_is_not_zero_and_one_expiry_gives_no_slope() -> None:
    out = term_structure([row("a", 5, None), row("b", 35, 15.0)])
    assert out["slope_per_30d"] is None and out["shape"] is None
    assert {"expiry": "a", "reason": "no solved ATM IV"} in out["left_out"]
