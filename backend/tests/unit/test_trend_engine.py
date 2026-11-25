"""The server's port of the Trend & Regime page: same rules, same numbers on the same real bars (Monday 23 Nov 2026), plus hand-calculated pieces."""

import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.intelligence import fusion as fz
from app.intelligence import trend_engine as te

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "index_bars_2026-11-23.json"


@pytest.fixture(scope="module")
def real() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_bars_of_an_earlier_session_are_no_evidence_for_today(real: dict) -> None:
    a = te.assess(real["bars"])
    today = fz.trend_group({"trend": {**a, "is_today": True}}, {})
    earlier = fz.trend_group({"trend": {**a, "is_today": False, "day": "2026-11-23"}}, {})
    assert today["score"] is not None and today["status"] != "UNAVAILABLE"
    assert earlier["score"] is None and earlier["status"] == "UNAVAILABLE"
    assert "not today's session" in earlier["terms"][0]["detail"] and "2026-11-23" in earlier["terms"][0]["detail"]


def test_real_session_gives_the_page_s_numbers(real: dict) -> None:
    a = te.assess(real["bars"])
    assert a["available"] and a["bars_1m"] == 360 and a["bars_5m"] == 72
    # what the Trend & Regime page showed at the last bar of 23 Nov: Trending down, score 88, 4 of 4 readings agree
    assert a["label"] == "Trending down" and a["direction"] == -1
    assert a["agreement"] == {"agree": 4, "of": 4}
    assert round(a["score"] * 100) == 88
    m = a["metrics"]
    assert round(m["er"], 2) == 0.32 and round(m["adx"], 1) == 47.9 and round(m["r2"], 2) == 0.89 and round(m["chop"], 1) == 38.7
    assert round(m["plus_di"], 1) == 8.6 and round(m["minus_di"], 1) == 33.6 and round(m["slope"], 2) == -9.16
    # session structure page: distance -163.1 points = -6.44 ATRs from the session mean; the opening range 25,670.0 to 25,990.2, 305 points below it
    assert round(a["price"] - a["session_mean"], 1) == -163.1 and a["from_mean_atr"] == pytest.approx(-6.44, abs=0.005)
    orr = a["opening_range"]
    assert (round(orr["low"], 1), round(orr["high"], 1), orr["state"], orr["beyond_points"]) == (25670.0, 25990.2, "below", -305.0)


def test_real_session_label_counts_equal_the_page_s_time_in_each_regime(real: dict) -> None:
    counts = Counter(p["label"] for p in te.assess(real["bars"])["series"])
    assert counts == {"Trending down": 33, "Mixed": 18, "Weak downtrend": 10, "Warming up": 8, "Range-bound": 3}


def test_the_reading_is_causal_a_later_bar_never_changes_an_earlier_one(real: dict) -> None:
    full = te.assess(real["bars"])["series"]
    cut = te.assess(real["bars"][:200])["series"]  # the session as it stood at 12:35
    assert [p["score"] for p in cut[:-1]] == [p["score"] for p in full[: len(cut) - 1]]


def test_five_minute_bars_start_at_the_open_and_keep_open_high_low_close() -> None:
    def b(h: int, m: int, o: float, hi: float, lo: float, c: float) -> dict:
        return {"t": datetime(2026, 11, 23, h, m, tzinfo=UTC), "o": o, "h": hi, "l": lo, "c": c}

    # 09:15 IST = 03:45 UTC; minutes 0-4 are one bar, minute 5 starts the next
    mins = [b(3, 45 + i, 100 + i, 101 + i, 99 + i, 100.5 + i) for i in range(5)] + [b(3, 50, 200, 201, 199, 200.5)]
    out = te.aggregate(mins)
    assert len(out) == 2
    assert (out[0]["o"], out[0]["h"], out[0]["l"], out[0]["c"]) == (100, 105, 99, 104.5)
    assert out[1]["o"] == 200


def test_scores_are_ramps_between_the_no_trend_and_full_trend_levels() -> None:
    # ER 0.30 is halfway between 0.15 and 0.45; ADX 35 is full; R2 0.2 is none; chop 50 is (50-61.8)/(38.2-61.8) = 0.5
    s, parts = te.trend_score({"er": 0.30, "adx": 35.0, "r2": 0.2, "chop": 50.0})
    assert parts == pytest.approx({"er": 0.5, "adx": 1.0, "r2": 0.0, "chop": 0.5})
    assert s == pytest.approx(0.5)
    assert te.trend_score({"er": 0.3, "adx": None, "r2": 0.5, "chop": None})[0] is None  # fewer than three readings
    assert te.trend_score({"er": 0.3, "adx": None, "r2": 0.5, "chop": 50.0})[0] is not None  # three are enough


def test_class_boundaries_have_a_margin_and_no_float_error() -> None:
    assert te.step_class(None, 0.65) == 3 and te.step_class(None, 0.6499) == 2
    assert te.step_class(2, 0.65 + 0.05) == 3  # exactly on the margin moves up (0.65 + 0.05 is 0.7000000000000001 in floating point)
    assert te.step_class(2, 0.69) == 2  # not enough past the bound
    assert te.step_class(3, 0.62) == 3 and te.step_class(3, 0.59) == 2  # down only when the margin under its own bound
    assert te.step_class(1, 0.25) == 1 and te.step_class(1, 0.26) == 1 and te.step_class(1, 0.249) == 0 and te.step_class(1, 0.2) == 0  # Mixed (floor 0.30) goes down below 0.25


def test_label_direction_comes_from_the_slope_and_di_lines_can_contradict_it() -> None:
    up = {"slope": 2.0, "plus_di": 30.0, "minus_di": 10.0}
    assert te.label_for(3, up) == "Trending up" and te.label_for(2, up) == "Weak uptrend"
    assert te.label_for(3, {"slope": -2.0, "plus_di": 10.0, "minus_di": 30.0}) == "Trending down"
    assert te.label_for(3, {"slope": 2.0, "plus_di": 10.0, "minus_di": 30.0}) == "Mixed"  # price rising but sellers lead: no call
    assert te.label_for(3, {"slope": 2.0, "plus_di": None, "minus_di": None}) == "Trending up"  # DI not available yet: the slope alone
    assert te.label_for(0, up) == "Range-bound" and te.label_for(1, up) == "Mixed"
    assert te.label_for(3, {"slope": 0.0}) == "Mixed"


def test_a_label_needs_three_bars_in_a_row_to_change() -> None:
    raw = ["A", "A", "B", "A", "B", "B", "B", "B", "A"]
    assert te.apply_dwell(raw, 3) == ["A", "A", "A", "A", "A", "A", "B", "B", "B"]


def test_strength_is_the_score_above_the_mixed_floor() -> None:
    assert te.strength(0.30) == 0.0 and te.strength(0.1) == 0.0 and te.strength(None) is None
    assert te.strength(0.65) == pytest.approx(0.5) and te.strength(1.0) == 1.0


def test_no_bars_is_unavailable_not_neutral() -> None:
    a = te.assess([])
    assert a["available"] is False and "no one-minute index bars" in a["reason"]
    assert te.assess([{"at": "garbage", "o": 1, "h": 1, "l": 1, "c": 1}])["available"] is False  # a bar that cannot be parsed is skipped, never repaired


OK = {"trend": {"ok": True, "age_s": 5.0}}


def test_the_group_scores_the_real_bearish_session_from_its_three_terms_with_the_price_overlap_discounted(real: dict) -> None:
    e = fz.trend_group({"trend": te.assess(real["bars"])}, OK)
    regime, mean, orr = e["terms"]
    # regime: -1 x 100 x (0.8832 - 0.30) / 0.70 = -83.3; mean: 100 tanh(-6.44 / 2) = -99.7; opening range: 100 tanh(-12.04 / 2) = -100
    assert regime["score"] == pytest.approx(-83.3, abs=0.1) and mean["score"] == pytest.approx(-99.7, abs=0.1) and orr["score"] == pytest.approx(-100.0, abs=0.1)
    # price terms share one family at weight 0.5 (index price is also read by group D): (-83.3 x 1 + (-99.7 - 100) / 2 x 0.5) / 1.5
    assert e["score"] == pytest.approx((-83.3 + (-99.85) * 0.5) / 1.5, abs=0.15)
    assert e["status"] == "AVAILABLE" and e["key"] == "trend" and e["name"] == "F. Trend and regime" and e["freshness"]["fresh"] is True
    assert mean["weight"] == 0.5 and orr["weight"] == 0.5 and mean["shares"] == ["index price (group D)"]


def test_no_bars_makes_the_group_unavailable_never_neutral() -> None:
    e = fz.trend_group({"trend": te.assess([])}, OK)
    assert e["score"] is None and e["status"] == "UNAVAILABLE" and all(t["score"] is None for t in e["terms"])
    assert fz.trend_group({}, {"trend": {"ok": False, "age_s": None}})["score"] is None  # the input never arrived


def test_a_range_bound_or_mixed_label_is_a_real_neutral_reading_not_a_missing_one() -> None:
    flat = {"available": True, "label": "Range-bound", "score": 0.2, "direction": 0, "strength": 0.0, "agreement": {"agree": 4, "of": 4}, "metrics": {"slope": 0.1},
            "session_mean": 24000.0, "price": 24001.0, "from_mean_atr": 0.1, "opening_range": {"complete": True, "state": "inside", "low": 23990.0, "high": 24010.0, "beyond_points": 0.0, "beyond_atr": 0.0}}
    e = fz.trend_group({"trend": flat}, OK)
    assert e["terms"][0]["score"] == 0.0 and "no direction is called" in e["terms"][0]["detail"]
    assert abs(e["score"]) < 5 and e["status"] == "AVAILABLE"
    warming = {**flat, "label": "Warming up", "score": None, "strength": None}
    assert fz.trend_group({"trend": warming}, OK)["terms"][0]["score"] is None  # the first half hour: no regime yet, said so


def test_the_group_is_part_of_the_fused_verdict_with_its_weight() -> None:
    assert fz.DEFAULT_WEIGHTS["trend"] > 0 and fz.ENGINE_NAMES["trend"] == "F. Trend and regime" and fz.ENGINE_LINKS["trend"] == "/trend/market-regime"
    others = [{"key": k, "name": fz.ENGINE_NAMES[k], "score": 20.0, "class": "x", "tilt": "x", "terms": [], "supporting": [], "conflicting": [], "unavailable": [],
               "freshness": {"fresh": True, "age_s": 1.0, "inputs": [], "failed": []}} for k in ("positioning", "orderflow", "structure")]
    withtrend = fz.fuse([*others, {**others[0], "key": "trend", "name": fz.ENGINE_NAMES["trend"], "score": -80.0}], fz.DEFAULT_WEIGHTS)
    without = fz.fuse(others, fz.DEFAULT_WEIGHTS)
    assert withtrend["score"] < without["score"]  # a strongly bearish trend reading pulls the verdict down by its weight
