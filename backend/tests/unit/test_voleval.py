# ruff: noqa: E501
"""Volatility evidence: the reported 11 Nov readings reproduced by hand, the sign convention, every requested display field, the interpretation and the config."""

from __future__ import annotations

import math
from typing import Any

import pytest

from app.intelligence import fusion as fz
from app.intelligence import voleval as ve

OK: dict[str, Any] = {k: {"ok": True, "age_s": 3.0} for k in ("futures", "market", "intraday", "skew", "momentum", "positioning", "gex", "vix", "flow")}


def bucket(ce_now: float, pe_now: float, ce_chg: float, pe_chg: float) -> dict[str, Any]:
    return {"ce_now": ce_now, "pe_now": pe_now, "ce_change": ce_chg, "pe_change": pe_chg, "momentum": round(ce_chg - pe_chg, 4)}


def row(spot: float, atm: tuple[float, float], d25: tuple[float, float], d10: tuple[float, float] | None = None, prev: bool = True) -> tuple[dict[str, Any], dict[str, Any] | None]:
    r = {"spot_change_pct": spot, "atm": bucket(15.0, 15.4, atm[0], atm[1]), "d25": bucket(14.1, 16.9, d25[0], d25[1]), "d10": bucket(13.2, 19.0, *(d10 or (0.0, 0.0)))}
    previous = {"atm": {"ce_then": 15.3, "pe_then": 15.6}, "d25": {"ce_then": 14.4, "pe_then": 16.1}, "d10": {"ce_then": 13.5, "pe_then": 18.0}} if prev else None
    return r, previous


# the reported readings: ATM IV -0.27 pts, 25-delta CE IV change minus PE IV change -0.71 pts
REPORTED = row(0.05, atm=(-0.30, -0.24), d25=(-0.20, 0.51), d10=(-0.4, 0.9))


def test_the_reported_scores_are_reproduced_by_hand() -> None:
    d = ve.analyse(*REPORTED)
    assert d["atm"]["avg_change"] == -0.27
    atm = 100 * math.tanh(0.27 / 0.5) * 0.6  # IV down, price flat: +29.6
    rr = 100 * math.tanh(-0.71 / 0.4)  # -94.4
    by = {c["key"]: c for c in d["components"]}
    assert by["atm"]["score"] == pytest.approx(atm, abs=0.1) and round(by["atm"]["score"]) == 30
    assert by["rr"]["score"] == pytest.approx(rr, abs=0.1) and round(by["rr"]["score"]) == -94
    assert d["total"] == pytest.approx((atm + rr) / 2, abs=0.1) and round(d["total"]) == -32
    assert d["verdict"] == "CONFLICTING"  # +30 against -94: the net -32 hides a disagreement


def test_each_component_contribution_is_its_score_over_the_number_of_components_and_they_sum_to_the_total() -> None:
    d = ve.analyse(*REPORTED)
    for c in d["components"]:
        assert c["contribution"] == pytest.approx(c["score"] / 2, abs=0.06)
    assert sum(c["contribution"] for c in d["components"]) == pytest.approx(d["total"], abs=0.1)
    assert "Each component contributes its score divided by 2" in d["explanation"] and "-94" in d["explanation"] and "+30" in d["explanation"]
    assert "disagree" in d["explanation"] and "CONFLICTING" in d["explanation"]


def test_ce_and_pe_changes_current_ivs_risk_reversals_and_skews_are_all_shown_separately() -> None:
    d = ve.analyse(*REPORTED)
    a, d25, d10 = d["atm"], d["d25"], d["d10"]
    assert (a["ce_change"], a["pe_change"]) == (-0.30, -0.24) and a["movement"] == "modest contraction"  # -0.27 is above the 0.2-point materiality threshold and below the 0.3-point expansion/contraction band
    assert (d25["ce_iv"], d25["pe_iv"]) == (14.1, 16.9) and (d25["ce_change"], d25["pe_change"]) == (-0.20, 0.51)
    assert d25["risk_reversal"] == pytest.approx(-2.8) and d25["skew"] == pytest.approx(2.8)  # skew = PE - CE = -RR
    assert d25["rr_previous_session"] == pytest.approx(-1.7) and d25["rr_change_since_previous_session"] == pytest.approx(-1.1)
    assert d10["risk_reversal"] == pytest.approx(-5.8) and d10["rr_previous_session"] == pytest.approx(-4.5) and d10["skew"] == pytest.approx(5.8)  # 10 and 25 delta kept apart
    assert d["sign_consistent"] is True and "skew = PE IV − CE IV = −risk reversal" in d["sign_convention"]


def test_the_sign_convention_is_one_identity_the_rr_change_equals_ce_change_minus_pe_change() -> None:
    for ce, pe in ((0.3, 0.1), (-0.2, 0.5), (-0.4, -0.1), (0.0, 0.0)):
        r, p = row(0.0, (0.0, 0.0), (ce, pe))
        d = ve.analyse(r, p)["d25"]
        assert d["rr_change"] == pytest.approx(ce - pe) and d["rr_change"] == pytest.approx(r["d25"]["momentum"])
        assert ve.rr_score(d["rr_change"], ve.DEFAULT) == pytest.approx(100 * math.tanh((ce - pe) / 0.4))
    bad = {**REPORTED[0], "d25": {**REPORTED[0]["d25"], "momentum": 0.5}}  # a table that breaks the identity is flagged, not used silently
    assert ve.analyse(bad, REPORTED[1])["sign_consistent"] is False


def test_put_iv_expansion_is_told_apart_from_call_iv_contraction() -> None:
    c = ve.DEFAULT
    both = ve.mechanism(-0.20, 0.51, c)
    assert both is not None and "put IV expansion" in both and "call IV contraction" in both
    assert ve.mechanism(0.0, 0.5, c) == "put IV expansion (+0.50) with call IV little changed (+0.00)"  # put side alone
    assert ve.mechanism(-0.5, 0.0, c) == "call IV contraction (-0.50) with put IV little changed (+0.00)"  # call side alone: same RR fall, different cause
    assert (ve.mechanism(-0.3, -0.1, c) or "").startswith("both fell, call IV contracted more")
    assert (ve.mechanism(0.5, -0.4, c) or "").startswith("call IV expansion")
    assert ve.mechanism(0.02, -0.03, c) == "neither call IV nor put IV moved materially" and ve.mechanism(None, 0.2, c) is None
    r1, p = row(0.0, (0.0, 0.0), (0.0, 0.5))
    r2, _ = row(0.0, (0.0, 0.0), (-0.5, 0.0))
    d1, d2 = ve.analyse(r1, p), ve.analyse(r2, p)
    assert "put IV expansion" in d1["d25"]["mechanism"] and "call IV contraction" in d2["d25"]["mechanism"]
    assert d1["components"][1]["score"] == d2["components"][1]["score"]  # the same risk-reversal fall from different legs: same score, different mechanism


def test_atm_movement_is_reported_apart_from_skew_movement() -> None:
    r, p = row(0.0, atm=(0.6, 0.6), d25=(0.0, 0.0))  # ATM expands, skew does not move
    d = ve.analyse(r, p)
    assert d["atm"]["movement"] == "expansion" and d["d25"]["rr_change"] == 0.0 and d["d25"]["mechanism"] == "neither call IV nor put IV moved materially"
    r2, p2 = row(0.0, atm=(0.0, 0.0), d25=(-0.4, 0.4))  # skew moves, ATM does not
    d2 = ve.analyse(r2, p2)
    assert d2["atm"]["movement"] == "little changed" and d2["d25"]["rr_change"] == pytest.approx(-0.8)


def test_iv_contraction_is_not_automatically_bullish_and_expansion_not_automatically_bearish() -> None:
    legacy, context = ve.DEFAULT, ve.VolConfig(mode="context")
    assert (ve.atm_score(-0.5, -0.4, legacy)[0] or 0) > 0 and ve.atm_score(-0.5, -0.4, context)[0] == 0.0  # price falling, IV falling: legacy bullish, context not
    assert ve.atm_score(0.5, 0.4, legacy)[0] == 0.0 and ve.atm_score(0.5, 0.4, context)[0] == 0.0  # price up, IV up: 0 in both
    assert (ve.atm_score(-0.5, 0.4, context)[0] or 0) > 0 and (ve.atm_score(0.5, -0.4, context)[0] or 0) < 0  # orderly advance bullish, fear bearish
    assert ve.atm_score(-0.5, 0.0, context)[0] == 0.0 and ve.atm_score(None, 0.4, legacy)[0] is None
    r, p = row(-0.4, atm=(-0.5, -0.5), d25=(0.0, 0.0))
    atm_reading = ve.analyse(r, p)["interpretation"][0]["reading"]
    assert atm_reading.startswith("contraction") and "bullish" not in atm_reading.lower() and "not a direction by itself" in atm_reading
    r, p = row(0.0, atm=(0.7, 0.7), d25=(0.0, 0.0))
    assert "not a direction by itself" in ve.analyse(r, p)["interpretation"][0]["reading"]


def test_the_scoring_methodology_is_configurable_and_the_defaults_are_the_original_ones() -> None:
    assert ve.DEFAULT == ve.VolConfig(mode="legacy", atm_scale=0.5, atm_factor=0.6, skew_scale=0.4)
    c = ve.parse_config('{"mode": "context", "skew_scale": 0.8, "bogus": 1, "atm_scale": -3, "flat_pts": "x"}')
    assert c.mode == "context" and c.skew_scale == 0.8 and c.atm_scale == 0.5 and c.flat_pts == 0.1  # invalid entries keep the default
    assert ve.parse_config("not json") == ve.DEFAULT and ve.parse_config("") == ve.DEFAULT and ve.parse_config('{"mode": "x"}').mode == "legacy"
    wide = ve.analyse(*REPORTED, ve.VolConfig(skew_scale=0.8))
    assert wide["components"][1]["score"] == pytest.approx(100 * math.tanh(-0.71 / 0.8), abs=0.1) and wide["scoring"]["skew_scale"] == 0.8


def test_interpretation_covers_the_six_requested_topics_with_actual_readings() -> None:
    r, p = row(0.35, atm=(-0.3, -0.3), d25=(-0.2, 0.5))
    d = ve.analyse(r, p)
    by = {i["id"]: i["reading"] for i in d["interpretation"]}
    assert set(by) == {"atm", "put_side", "call_side", "risk_reversal", "vol_price", "confirmation"}
    assert by["atm"].startswith("contraction") and "-0.30" in by["atm"]
    assert by["put_side"].startswith("strengthening") and "+0.50" in by["put_side"] and "16.90" in by["put_side"]
    assert by["call_side"].startswith("weakening") and "-0.20" in by["call_side"] and "14.10" in by["call_side"]
    assert "-2.80" in by["risk_reversal"] and "-0.70" in by["risk_reversal"] and "-1.70" in by["risk_reversal"]
    assert by["vol_price"].startswith("price up +0.35% while puts get richer relative to calls")  # a divergence
    assert by["confirmation"].startswith("mixed") or by["confirmation"].startswith("does not confirm")
    r3, p3 = row(-0.4, atm=(0.0, 0.0), d25=(-0.3, 0.4))  # price down with puts richer: bearish evidence confirms the decline
    d3 = ve.analyse(r3, p3)
    assert d3["verdict"] == "BEARISH" and {i["id"]: i["reading"] for i in d3["interpretation"]}["confirmation"] == "confirms the decline"
    r4, p4 = row(0.0, atm=(0.0, 0.0), d25=(0.0, 0.0))
    assert "no volatility evidence" in {i["id"]: i["reading"] for i in ve.analyse(r4, p4)["interpretation"]}["confirmation"]


def test_evidence_is_sorted_into_bullish_bearish_and_conflicting_and_missing_data_stays_missing() -> None:
    d = ve.analyse(*REPORTED)
    assert len(d["evidence"]["bullish"]) == 1 and len(d["evidence"]["bearish"]) == 1 and d["evidence"]["conflicting"]
    assert any("not scored" in x for x in d["not_scored"]) and any("previous session" in x for x in d["not_scored"])
    none = ve.analyse({}, None)
    assert none["verdict"] == "UNAVAILABLE" and none["total"] is None and none["components"][0]["score"] is None and none["explanation"].startswith("Volatility evidence is UNAVAILABLE")
    no_prev = ve.analyse(REPORTED[0], None)
    assert no_prev["d25"]["rr_previous_session"] is None and no_prev["d25"]["rr_change_since_previous_session"] is None


def test_the_engine_uses_the_same_scores_and_exposes_the_detail() -> None:
    r, p = REPORTED
    inp: dict[str, Any] = {"momentum": {"table": {"periods": {"15": r}, "previous_close": p}}, "skew": {"cards": {}}}
    e = fz.volatility_engine(inp, OK)
    assert e["score"] == pytest.approx(-32.4, abs=0.1) and e["detail"]["verdict"] == "CONFLICTING" and e["detail"]["components"][1]["score"] == pytest.approx(-94.4, abs=0.1)
    ctx = fz.volatility_engine({**inp, "vol_config": ve.VolConfig(mode="context")}, OK)
    assert ctx["terms"][0]["score"] == 0.0 and ctx["detail"]["scoring"]["mode"] == "context"  # price flat: the ATM move is not scored in context mode
