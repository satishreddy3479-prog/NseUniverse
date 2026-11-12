"""Barrier labels, metrics, baselines, chronological validation and the probability gate.

Paths and rows are SYNTHETIC with hand-calculated answers (formula checks), not market data. The evaluation runs on
real stored sessions through /api/intraday/research once they exist; with fewer than the required sessions it must say so.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.intraday import labels as lb
from app.intraday.features import Point

IST = ZoneInfo("Asia/Kolkata")
T0 = datetime(2026, 10, 29, 9, 30, tzinfo=IST)


def path(spots: list[float], minutes: list[float] | None = None) -> list[Point]:
    mins = minutes if minutes is not None else list(range(len(spots)))
    return [Point(T0 + timedelta(minutes=m), s) for m, s in zip(mins, spots, strict=True)]


# --------------------------------------------------------------------------------------- barrier labels
def test_barrier_width_is_a_volatility_multiple_known_at_the_prediction_time() -> None:
    # 0.5 x 1 % daily sd x sqrt(15/375) = 0.5 x 0.01 x 0.2 -> 0.1 % of 24000 = 24 points
    assert lb.barrier_pts(24000, 1.0, 15) == pytest.approx(24.0)
    assert lb.barrier_pts(24000, 1.0, 60) == pytest.approx(0.5 * 0.01 * math.sqrt(60 / 375) * 24000)


def test_up_down_none_outcomes_with_time_and_excursions() -> None:
    up = path([24000, 24005, 24010, 24026, 24030] + [24030] * 12)
    r = lb.label_at(up, 0, 15, 1.0)
    assert (r["outcome"], r["minutes_to_touch"], r["mfe_pts"], r["mae_pts"]) == ("up", 3.0, 26.0, 0.0)
    dn = path([24000, 23995, 23990, 23975] + [23975] * 13)
    assert lb.label_at(dn, 0, 15, 1.0)["outcome"] == "down"
    flat = path([24000, 24010, 23990, 24005] + [24000] * 13)  # stays inside +/-24 for the whole horizon
    r = lb.label_at(flat, 0, 15, 1.0)
    assert r["outcome"] == "none" and r["mfe_pts"] == 10.0 and r["mae_pts"] == -10.0
    assert lb.label_at(path([24000, 24030] + [24030] * 14), 0, 15, 1.0)["outcome"] == "up"  # first sample after t may already touch


def test_ambiguous_and_missing_are_never_resolved_in_favour_of_a_side() -> None:
    gap = path([24000, 24001, 24002, 24030] + [24030] * 5, [0, 1, 2, 9, 10, 11, 12, 13, 15])  # 7-minute gap before the touch
    r = lb.label_at(gap, 0, 15, 1.0)
    assert r["outcome"] == "ambiguous" and "gap" in r["reason"]
    short = path([24000, 24001, 24002] + [24003] * 7)  # ends at minute 9 of a 15-minute horizon
    assert lb.label_at(short, 0, 15, 1.0)["outcome"] == "missing"
    assert lb.label_at(path([24000]), 0, 15, 1.0)["outcome"] == "missing"  # nothing after t
    assert lb.label_at(path([24000] * 17), 0, 15, None)["outcome"] == "missing"  # no volatility scale: no barrier


def test_a_label_reads_only_the_future_of_its_sample() -> None:
    base = path([24000, 24005, 24010, 24026] + [24030] * 13)
    changed_past = path([23000, 25000] + [24000, 24005, 24010, 24026] + [24030] * 13)
    a = lb.label_at(base, 0, 15, 1.0)
    b = lb.label_at(changed_past, 2, 15, 1.0)  # same sample, different history before it
    assert a == b
    beyond = path([24000, 24005, 24010, 24026] + [24030] * 12 + [20000])  # a sample after the horizon ends does not matter
    assert lb.label_at(beyond, 0, 15, 1.0)["outcome"] == "up"
    labelled = lb.label_session(base, 1.0, horizons=(5, 15))
    assert set(labelled) == {p.at.isoformat() for p in base} and set(next(iter(labelled.values()))) == {5, 15}


# --------------------------------------------------------------------------------------- api
