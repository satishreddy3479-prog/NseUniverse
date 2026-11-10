# ruff: noqa: E501
"""IV momentum: hand-calculated changes between snapshots, missing values, tolerance of the look-back."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.intraday import momentum as m

T0 = datetime(2026, 11, 9, 5, 0, tzinfo=UTC)


def pt(minutes: int, spot: float, ce25: float | None, pe25: float | None, atm_ce: float = 14.0, atm_pe: float = 15.0) -> dict[str, Any]:
    return {
        "at": T0 + timedelta(minutes=minutes), "spot": spot,
        "atm": {"ce": atm_ce, "pe": atm_pe}, "d25": {"ce": ce25, "pe": pe25}, "d10": {"ce": None, "pe": None},
    }


def test_momentum_is_ce_iv_change_minus_pe_iv_change() -> None:
    points = [pt(0, 24000, 13.0, 15.0), pt(5, 24030, 13.6, 15.2)]
    row = m.momentum_table(points, None, (5,))["periods"]["5"]
    # CE 13.6 - 13.0 = +0.6; PE 15.2 - 15.0 = +0.2; momentum = 0.6 - 0.2 = +0.4; spot +30 (+0.125 %)
    assert row["d25"]["ce_change"] == pytest.approx(0.6) and row["d25"]["pe_change"] == pytest.approx(0.2)
    assert row["d25"]["momentum"] == pytest.approx(0.4)
    assert row["spot_change"] == 30 and row["spot_change_pct"] == pytest.approx(0.125)


def test_missing_iv_on_either_end_leaves_the_change_missing_not_zero() -> None:
    points = [pt(0, 24000, None, 15.0), pt(5, 24030, 13.6, 15.2)]
    row = m.momentum_table(points, None, (5,))["periods"]["5"]
    assert row["d25"]["ce_change"] is None and row["d25"]["momentum"] is None
    assert row["d25"]["pe_change"] == pytest.approx(0.2)
    assert row["d10"]["momentum"] is None


def test_the_look_back_uses_the_nearest_earlier_snapshot_inside_its_tolerance() -> None:
    points = [pt(0, 24000, 13.0, 15.0), pt(14, 24010, 13.2, 15.1), pt(30, 24040, 13.9, 15.0)]
    tab = m.momentum_table(points, None, (15, 1))["periods"]
    assert tab["15"]["from"] == points[1]["at"].isoformat()  # 30 - 15 = minute 15: the minute-14 snapshot is the nearest one before it
    assert tab["1"]["from"] is None  # nothing stored within 2 minutes before minute 29
    assert tab["1"]["d25"]["momentum"] is None


def test_previous_session_close_comparison() -> None:
    prev = pt(-1000, 23900, 12.0, 14.0)
    now = pt(0, 24000, 13.0, 15.0)
    out = m.momentum_table([now], prev, (5,))["previous_close"]
    assert out["d25"]["ce_change"] == pytest.approx(1.0) and out["d25"]["pe_change"] == pytest.approx(1.0)
    assert out["d25"]["momentum"] == pytest.approx(0.0) and out["spot_change"] == 100
    assert m.momentum_table([now], None, (5,))["previous_close"] is None
