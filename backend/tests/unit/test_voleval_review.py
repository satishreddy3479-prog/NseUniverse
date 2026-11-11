# ruff: noqa: E501
"""Final review of the volatility score: distinct evidence, no double counting, neutral thresholds, every price/IV and leg combination, mode comparison."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.intelligence import validation as vd
from app.intelligence import voleval as ve
from tests.unit.test_voleval import row

LEGACY, CONTEXT = ve.VolConfig(mode="legacy"), ve.VolConfig(mode="context")
S1 = 100 * math.tanh(0.5 / 0.5) * 0.6  # 45.7: an ATM IV change of half a point at full scale
LEG = 100 * math.tanh(0.5 / 0.4)  # 84.8: a half-point risk-reversal change


def scores(d: dict[str, Any]) -> tuple[float | None, float | None]:
    by = {c["key"]: c["score"] for c in d["components"]}
    return by["atm"], by["rr"]


# ---------------------------------------------------------------- 1, 3: no double counting
def test_only_the_25_delta_risk_reversal_is_scored_the_10_delta_one_cannot_move_the_score() -> None:
    base_r, p = row(0.0, atm=(0.0, 0.0), d25=(-0.2, 0.3), d10=(0.0, 0.0))
    wild_r, _ = row(0.0, atm=(0.0, 0.0), d25=(-0.2, 0.3), d10=(-3.0, 4.0))  # the 10Δ smile moves enormously
    a, b = ve.analyse(base_r, p), ve.analyse(wild_r, p)
    assert a["total"] == b["total"] and a["components"] == b["components"] and a["verdict"] == b["verdict"]
    assert b["d10"]["rr_change"] == -7.0  # it is still shown
    assert [c["key"] for c in a["components"]] == ["atm", "rr"] and all(c["scored"] for c in a["components"])


def test_skew_previous_close_and_divergence_are_listed_as_zero_contribution_with_the_reason() -> None:
    r, p = row(0.4, atm=(0.0, 0.0), d25=(-0.5, 0.0))
    d = ve.analyse(r, p)
    un = {c["key"]: c for c in d["unscored_components"]}
    assert set(un) == {"d10", "skew", "rr_prev", "divergence"} and all(c["contribution"] == 0.0 and c["scored"] is False and c["score"] is None for c in un.values())
    assert "one signal twice" in un["d10"]["why"] and "same number" in un["skew"]["why"] and "interpretation only" in un["divergence"]["why"]
    assert "price up" in un["divergence"]["reading"]  # the divergence fired here, and it still adds nothing
    # the score depends only on the two scored components, whatever the divergence says
    atm, rr = scores(d)
    assert d["total"] == pytest.approx((atm + rr) / 2, abs=0.06)
    flat_r, _ = row(0.0, atm=(0.0, 0.0), d25=(-0.5, 0.0))  # no divergence at all (price flat), same legs
    assert ve.analyse(flat_r, p)["components"][1]["score"] == d["components"][1]["score"]


def test_every_component_contribution_is_visible_and_the_scored_ones_sum_to_the_final_score() -> None:
    r, p = row(-0.3, atm=(0.4, 0.4), d25=(0.0, 0.5))
    d = ve.analyse(r, p)
    assert sum(c["contribution"] for c in d["components"] + d["unscored_components"]) == pytest.approx(d["total"], abs=0.1)
    assert all("contribution" in c for c in d["components"] + d["unscored_components"])


def test_the_correlated_inputs_are_documented() -> None:
    text = " ".join(ve.analyse(*row(0.0, (0.0, 0.0), (0.0, 0.0)))["correlated_inputs"])
    for needle in ("10Δ risk reversal", "Skew and risk reversal", "parallel shift", "ATM IV change and price", "Previous-close"):
        assert needle in text


def test_the_risk_reversal_change_is_blind_to_a_parallel_shift_of_the_smile_so_it_cannot_double_count_the_atm_move() -> None:
    r, p = row(0.0, atm=(0.8, 0.8), d25=(0.8, 0.8))  # the whole smile lifts together
    d = ve.analyse(r, p)
    assert d["d25"]["rr_change"] == 0.0 and scores(d)[1] == 0.0 and scores(d)[0] != 0.0  # only the ATM term sees it


# ---------------------------------------------------------------- 5: neutral thresholds
def test_an_insignificant_change_scores_strongly_under_tanh_but_is_not_counted_as_evidence() -> None:
    r, p = row(0.0, atm=(-0.05, -0.05), d25=(-0.05, 0.05))  # ATM -0.05, RR change -0.10
    d = ve.analyse(r, p)
    atm, rr = scores(d)
    assert rr == pytest.approx(100 * math.tanh(-0.10 / 0.4), abs=0.1) and rr < -15  # a strong-looking score from a 0.1-point change
    assert [c["material"] for c in d["components"]] == [False, False]
    assert d["verdict"] == "NEUTRAL" and d["evidence"] == {"bullish": [], "bearish": [], "conflicting": []}
    assert "below the 0.2-point materiality threshold, so it is not counted as evidence" in d["explanation"]


def test_the_dead_zone_option_zeroes_small_changes_in_the_score_itself_and_is_off_by_default() -> None:
    assert ve.DEFAULT.noise_pts == 0.0 and ve.DEFAULT.atm_material == 0.2 and ve.DEFAULT.rr_move == 0.2
    r, p = row(0.0, atm=(-0.05, -0.05), d25=(-0.05, 0.05))
    on = ve.analyse(r, p, ve.VolConfig(noise_pts=0.15))
    assert scores(on) == (0.0, 0.0) and on["total"] == 0.0
    big, _ = row(0.0, atm=(-0.5, -0.5), d25=(0.0, 0.5))
    assert scores(ve.analyse(big, p, ve.VolConfig(noise_pts=0.15))) == scores(ve.analyse(big, p))  # a real move is untouched


def test_materiality_applies_at_the_threshold() -> None:
    for chg, material in ((0.19, False), (0.2, True), (-0.2, True)):
        r, p = row(0.0, atm=(0.0, 0.0), d25=(chg, 0.0))
        assert ve.analyse(r, p)["components"][1]["material"] is material
    assert ve.movement(-0.25, ve.DEFAULT) == "modest contraction" and ve.movement(0.35, ve.DEFAULT) == "expansion" and ve.movement(0.1, ve.DEFAULT) == "little changed"


# ---------------------------------------------------------------- 6: the four price / ATM IV combinations
@pytest.mark.parametrize(("spot", "iv", "legacy", "context", "why"), [
    (0.4, -0.5, +S1, +S1, "price up, IV down: orderly advance"),
    (0.4, +0.5, 0.0, 0.0, "price up, IV up: not directional in either mode"),
    (-0.4, +0.5, -S1, -S1, "price down, IV up: fear"),
    (-0.4, -0.5, +S1, 0.0, "price down, IV down: legacy calls it bullish by convention, context does not"),
])
def test_all_four_price_and_atm_iv_combinations(spot: float, iv: float, legacy: float, context: float, why: str) -> None:
    r, p = row(spot, atm=(iv, iv), d25=(0.0, 0.0))
    assert scores(ve.analyse(r, p, LEGACY))[0] == pytest.approx(legacy, abs=0.1), why
    assert scores(ve.analyse(r, p, CONTEXT))[0] == pytest.approx(context, abs=0.1), why
    assert scores(ve.analyse(r, p, LEGACY))[1] == 0.0  # the skew component is untouched by the ATM move


def test_the_interpretation_never_calls_the_atm_move_itself_bullish_or_bearish_in_any_combination() -> None:
    for spot in (0.4, -0.4):
        for iv in (0.5, -0.5):
            r, p = row(spot, atm=(iv, iv), d25=(0.0, 0.0))
            reading = ve.analyse(r, p)["interpretation"][0]["reading"]
            assert "bullish" not in reading.lower() and "bearish" not in reading.lower() and "not a direction by itself" in reading


# ---------------------------------------------------------------- 7: each leg on its own
@pytest.mark.parametrize(("ce", "pe", "sign", "mech"), [
    (0.0, +0.5, -1, "put IV expansion (+0.50) with call IV little changed"),
    (0.0, -0.5, +1, "put IV contraction (-0.50) with call IV little changed"),
    (+0.5, 0.0, +1, "call IV expansion (+0.50) with put IV little changed"),
    (-0.5, 0.0, -1, "call IV contraction (-0.50) with put IV little changed"),
])
def test_put_and_call_iv_expansion_and_contraction_independently(ce: float, pe: float, sign: int, mech: str) -> None:
    r, p = row(0.0, atm=(0.0, 0.0), d25=(ce, pe))
    d = ve.analyse(r, p)
    assert d["d25"]["rr_change"] == pytest.approx(ce - pe) and scores(d)[1] == pytest.approx(sign * LEG, abs=0.1)
    assert d["d25"]["mechanism"].startswith(mech) and scores(d)[0] == 0.0  # ATM unchanged: the leg move shows up only in the risk reversal
    assert ("bullish" if sign > 0 else "bearish") in " ".join(d["evidence"]["bullish" if sign > 0 else "bearish"]) or d["evidence"]["bullish" if sign > 0 else "bearish"]
    side = {i["id"]: i["reading"] for i in d["interpretation"]}
    assert side["put_side"].startswith("strengthening" if pe > 0 else "weakening" if pe < 0 else "little changed")
    assert side["call_side"].startswith("strengthening" if ce > 0 else "weakening" if ce < 0 else "little changed")


# ---------------------------------------------------------------- 8: legacy against context on chronological sessions
def history(sessions: int, per: int = 60, vol: bool = True) -> list[dict[str, Any]]:
    start = datetime(2026, 11, 2, 4, 0, tzinfo=UTC)
    out = []
    for d in range(sessions):
        for m in range(per):
            t = start + timedelta(days=d, minutes=m)
            up = (d + m) % 4 < 2  # price alternates between rising and falling stretches
            out.append({"session": t.date().isoformat(), "at": t.isoformat(), "spot": 24000.0 + (5 * m if up else -5 * m), "score": 0.0, "confidence": 60.0, "coverage": 0.9, "engines": {},
                        "metrics": {"arch": vd.ARCH, **({"vol": {"atm": -0.4 if up else 0.4, "spot": 0.3 if up else -0.3, "rr": 0.3 if up else -0.3}} if vol else {})}})
    return out


def test_the_two_modes_are_compared_only_when_enough_sessions_hold_the_inputs() -> None:
    few = vd.compare_vol_modes(history(5))
    assert few["status"].startswith("insufficient: 5 session(s)") and few["horizons"] == {} and few["needed_sessions"] == 20
    assert vd.compare_vol_modes(history(25, vol=False))["status"].startswith("insufficient: 0 session(s)")  # rows without the stored inputs do not count


def test_the_comparison_recomputes_both_scores_from_the_same_stored_inputs_and_describes_without_choosing() -> None:
    rows = history(25)
    out = vd.compare_vol_modes(rows)
    assert out["sessions_with_inputs"] == 25 and out["verdict"] is None and "do not switch the default" in out["status"]
    h = out["horizons"]["15m"]
    assert h["legacy"]["decided"] > 0 and h["context"]["decided"] > 0 and "hit_rate_difference" in h and "intervals_separate" in h
    # the stored-input scorer equals the live engine's arithmetic for each mode
    sample = rows[0]
    v = sample["metrics"]["vol"]
    for cfg in (LEGACY, CONTEXT):
        expected = ((ve.atm_score(v["atm"], v["spot"], cfg)[0] or 0) + (ve.rr_score(v["rr"], cfg) or 0)) / 2
        assert vd.vol_group_score(sample, cfg) == pytest.approx(expected)
    assert vd.vol_group_score({"metrics": {}}, LEGACY) is None
    assert "volatility_modes" in vd.report(rows) and ve.DEFAULT.mode == "legacy"  # the default is never changed by a comparison
