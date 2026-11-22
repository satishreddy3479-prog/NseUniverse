# ruff: noqa: E501
"""Since-open gamma statistics and the sudden-move reading, against hand calculations."""

from __future__ import annotations

import pytest

from app.intraday import gamma_map as gm


def pt(i: int, spot: float, near: float | None = 0.0, ab: float | None = 100.0, flip: float | None = None, net: float | None = 0.0) -> dict[str, object]:
    return {"at": f"2026-11-20T10:{i:02d}:00+05:30", "spot": spot, "near_net": near, "abs": ab, "flip": flip, "net": net}


def test_average_gamma_by_hand() -> None:
    pts = [pt(0, 24000, -10, 100), pt(1, 24000, 5, 200), pt(2, 24000, -20, 300)]
    a = gm.average_gamma(pts)
    assert a["abs"]["mean"] == pytest.approx(200.0) and a["abs"]["now"] == 300.0 and a["abs"]["now_vs_mean"] == pytest.approx(1.5)
    assert a["abs"]["min"] == 100.0 and a["abs"]["max"] == 300.0 and a["abs"]["peak_at"] == pts[2]["at"]
    assert a["near_net"]["mean"] == pytest.approx(-25.0 / 3) and a["negative_share"] == pytest.approx(2 / 3)  # two of three snapshots were short gamma near spot
    assert gm.average_gamma([pt(0, 24000, None, None)])["abs"] is None  # missing stays missing


def test_missing_values_are_skipped_not_zeroed_in_the_mean() -> None:
    a = gm.average_gamma([pt(0, 24000, ab=100.0), pt(1, 24000, ab=None), pt(2, 24000, ab=300.0)])
    assert a["abs"]["mean"] == pytest.approx(200.0) and a["abs"]["samples"] == 2  # (100 + 300) / 2, not / 3


SPOTS = [24000, 24010, 24020, 24030, 24040, 24100, 24110]  # steps 10, 10, 10, 10, 60, 10


def test_a_sudden_step_is_found_with_its_direction_and_the_gamma_before_it() -> None:
    pts = [pt(i, s, near=-5.0 if i == 4 else 5.0) for i, s in enumerate(SPOTS)]
    sm = gm.sudden_moves(pts)
    # typical step is the median of |pct| = about 0.0416 %; 3 x that is 0.125 %, below the 0.15 % floor, so the floor is the threshold (60 points on 24040 is 0.2496 %)
    assert sm["typical_step_pct"] == pytest.approx(0.0416, abs=0.0005) and sm["threshold_pct"] == pytest.approx(0.15)
    assert [(e["move"], e["direction"], e["short_gamma_before"]) for e in sm["events"]] == [(60.0, "up", True)] and sm["latest_is_sudden"] is False
    assert gm.sudden_moves(pts[:5])["events"] == [] and gm.sudden_moves(pts[:5])["latest_is_sudden"] is None  # five points are too few to know what is typical


def test_each_component_by_hand() -> None:
    near = [10.0] * 7 + [-10.0]
    pts = [pt(i, 24000 + i, near[i], 100.0 if i < 7 else 125.0, flip=24180.0 if i == 7 else None) for i in range(8)]
    pts[-1]["spot"] = 24000.0
    b = gm.blast(pts, 15.75)
    c = {x["key"]: x["value"] for x in b["components"]}
    assert c["regime"] == pytest.approx(1.0)  # near-the-money net at its most negative of the session: short gamma
    assert c["flip"] == pytest.approx(0.6)  # 180 points = 0.75 % from the flip: (1.5 - 0.75) / (1.5 - 0.25)
    assert c["build"] == pytest.approx(0.4242, abs=1e-3)  # 125 / 103.125 = 1.2121: (1.2121 - 1) / 0.5
    assert c["time"] == pytest.approx(0.5)  # (30 - 15.75) / 28.5
    flipped = [dict(p) for p in pts]
    flipped[-1]["near_net"] = 10.0
    assert {x["key"]: x["value"] for x in gm.blast(flipped, 15.75)["components"]}["regime"] == pytest.approx(0.0)  # long gamma at its most positive


def test_the_speed_component_compares_the_last_15_minutes_with_the_sessions_typical_15_minutes() -> None:
    spots = [24000, 24005, 24010, 24015, 24020, 24025, 24030, 24035, 24110, 24185]  # 15-minute moves 15 x 5, then 85, 155: median 15
    fast = gm.blast([pt(i, s) for i, s in enumerate(spots)], None)
    sp = next(x for x in fast["components"] if x["key"] == "speed")
    assert sp["value"] == pytest.approx(1.0) and "155 points" in sp["detail"]  # 155 / 15 = 10.3 times: past the 3 x cap
    slow = gm.blast([pt(i, 24000 + 5 * i) for i in range(10)], None)
    assert next(x for x in slow["components"] if x["key"] == "speed")["value"] == pytest.approx(0.0)  # a move equal to the typical one scores nothing


def test_the_score_is_the_weighted_mean_of_the_components_that_exist() -> None:
    near = [10.0] * 7 + [-10.0]
    pts = [pt(i, 24000.0, near[i], 100.0 if i < 7 else 125.0, flip=24180.0 if i == 7 else None) for i in range(8)]
    b = gm.blast(pts, 15.75)  # speed: spot never moved, typical move is 0 -> unavailable, left out
    assert next(x for x in b["components"] if x["key"] == "speed")["value"] is None
    # regime 1.0 x 25 + flip 0.6 x 20 + build 0.42424 x 15 + time 0.5 x 15 = 25 + 12 + 6.3636 + 7.5 = 50.8636 over weights 75
    assert b["score"] == pytest.approx(50.8636 / 75 * 100, abs=0.05) and b["coverage_pct"] == 75 and b["level"] == "elevated"
    assert gm.blast([pt(0, 24000)], 5.0)["status"] == "unavailable"


def test_the_strike_profile_keeps_the_strikes_nearest_spot_and_missing_sides() -> None:
    rows = [{"strike": 24000.0 + 50 * i, "ce": 1.0, "pe": None if i == 3 else -1.0, "net": None if i == 3 else 0.0, "abs": None if i == 3 else 2.0} for i in range(-20, 21)]
    out = gm.strike_profile(rows, 24000.0, each=15)
    assert len(out) == 31 and out[15]["strike"] == 24000.0 and out[0]["strike"] == 24000.0 - 750
    assert next(r for r in out if r["strike"] == 24150.0)["pe"] is None  # missing is not zero
