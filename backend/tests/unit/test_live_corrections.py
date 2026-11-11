# ruff: noqa: E501
"""GEX validation on the real captured chain, VWAP instrument labels, observations and weights provenance."""

from __future__ import annotations

import math
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from app.intelligence import fusion as fz
from app.intraday import gex_history as gx
from app.intraday import volatility as vm
from tests.unit.test_intelligence import Rig
from tests.unit.test_intraday import EXP, as_chain, ist, real_chain

RATE = 0.06


def real() -> tuple[list[dict[str, Any]], float, float, float, Any]:
    at = ist(10, 0)
    snap = real_chain(at.astimezone(vm.IST), "corrections", EXP)
    spot = float(snap.underlying_ltp or 0)
    chain = as_chain(snap)
    ed = date.fromisoformat(EXP)
    sf = vm.surface({k: v.ltp for k, v in chain.items()}, spot, ed, at, RATE, 400)
    t = vm.years_to_expiry(ed, at)
    return gx.contracts_of(sf["rows"], chain), spot, sf["forward"] / spot, t, sf


# ---------------------------------------------------------------- GEX validation
def test_strike_gamma_equals_an_independent_black76_gamma() -> None:
    cs, spot, q, t, _ = real()
    c = next(c for c in cs if c["side"] == "CE" and abs(c["strike"] - spot) < 30 and c["iv"])
    f, v = spot * q, c["iv"] * math.sqrt(t)
    d1 = (math.log(f / c["strike"]) + 0.5 * v * v) / v
    gamma_f = math.exp(-RATE * t) * math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi) / (f * v)  # Black-76 gamma per unit of the forward
    assert gx.spot_gamma(spot, q, c["strike"], t, c["iv"], RATE) == pytest.approx(gamma_f * q * q, rel=1e-12)  # per unit of spot: the forward moves q for each unit of spot


def test_exposure_uses_open_interest_in_units_with_no_lot_multiplier_and_the_documented_scale() -> None:
    # gamma 0.001 x OI 1,000,000 units x spot^2 x 1 % / 10^7 rupees per crore, written out by hand
    assert gx.exposure(0.001, 1_000_000.0, 24000.0) == pytest.approx(0.001 * 1_000_000 * 24000 ** 2 * 0.01 / 1e7)
    assert gx.exposure(None, 5.0, 24000.0) is None and gx.exposure(0.001, None, 24000.0) is None


def test_calls_count_positive_puts_negative_and_the_flip_does_not_depend_on_that_labelling() -> None:
    cs, spot, q, t, _ = real()
    rows = gx.strike_rows(cs, spot, q, t, RATE)
    assert all(r["ce"] is None or r["ce"] >= 0 for r in rows) and all(r["pe"] is None or r["pe"] <= 0 for r in rows)
    net = gx.net_at(cs, spot, q, t, RATE)
    assert net is not None
    # reversing the convention (calls -, puts +) negates the whole profile: the regime label inverts but every zero crossing stays where it is
    base = gx.crossings(cs, spot, q, t, RATE)
    assert base and gx.gamma_flip(cs, spot, q, t, RATE) == base[0]


def test_net_uses_only_strikes_with_both_sides_while_the_flip_uses_every_contract_and_the_difference_is_reported() -> None:
    cs, spot, q, t, _ = real()
    lv = gx.levels(cs, spot, q, t, RATE)
    assert lv["used"] < lv["strikes"]  # strikes with one side missing are left out of the net total
    assert lv["flip"] != lv["fd_flip_both"] and lv["fd_flip_both"] is not None  # the strike-set choice moves the flip: reported, not hidden
    assert abs(lv["flip"] - lv["fd_flip_both"]) < 30  # on this chain by a few points


def test_a_ten_percent_disagreement_about_who_holds_the_open_interest_moves_the_flip_and_the_flip_is_labelled_unstable() -> None:
    cs, spot, q, t, _ = real()
    lv = gx.levels(cs, spot, q, t, RATE)
    assert lv["fd_flip_hi"] < lv["flip"] < lv["fd_flip_lo"]  # more put OI pulls the zero down, more call OI pushes it up
    assert lv["fd_flip_lo"] - lv["fd_flip_hi"] > 100  # about 160 points on this chain
    d = {k[3:]: v for k, v in lv.items() if k.startswith("fd_")}
    sup = gx.flip_support(spot, lv["flip"], d)
    assert sup["status"] == "unstable" and any("10 % OI disagreement" in r for r in sup["reasons"])
    assert d["crossings"] == 1.0 and d["slope"] > 0 and 0 <= d["net_share"] <= 1


def test_flip_support_verdicts_without_inventing_a_corrected_level() -> None:
    assert gx.flip_support(24000.0, None, {})["status"] == "none"
    assert gx.flip_support(24000.0, 23990.0, {"flip_both": 23992.0, "flip_lo": 24005.0, "flip_hi": 23975.0, "crossings": 1.0, "slope": 500.0})["status"] == "supported"
    far = gx.flip_support(24000.0, 23600.0, {"flip_both": 23601.0, "flip_lo": 23610.0, "flip_hi": 23590.0, "crossings": 1.0, "slope": 500.0})
    assert far["status"] == "unstable" and any("extrapolation" in r for r in far["reasons"])
    multi = gx.flip_support(24000.0, 23990.0, {"flip_both": 23990.0, "flip_lo": 23990.0, "flip_hi": 23990.0, "crossings": 3.0, "slope": 500.0})
    assert multi["status"] == "unstable" and any("3 times" in r for r in multi["reasons"])
    assert gx.flip_support(24000.0, 23990.0, {})["status"] == "unassessed"  # old snapshots without diagnostics are not penalised


def test_gex_state_reports_distance_in_points_and_percent_and_the_range() -> None:
    pts = [{"at": "2026-11-11T10:00:00+05:30", "spot": 25000.0, "net": 5.0, "abs": 20.0, "flip": 24500.0, "fd_flip_both": 24520.0, "fd_flip_lo": 24700.0, "fd_flip_hi": 24300.0, "fd_crossings": 1.0, "fd_slope": 50.0,
            "call_wall": 25200.0, "put_wall": 24800.0}]
    st = fz.gex_state({"gex": {"points": pts}})
    assert st["flip_distance_pts"] == 500.0 and st["flip_distance_pct"] == pytest.approx(2.0) and st["flip_range"] == [24300.0, 24700.0]
    assert st["flip_support"]["status"] == "unstable"
    terms, _ = fz._gex_terms({"gex": {"points": pts}})
    assert terms[0].weight == 0.125 and "UNSTABLE" in terms[0].detail and "+500 pts (+2.00%)" in terms[0].detail  # an unsupported flip counts for a quarter of its weight


# ---------------------------------------------------------------- VWAP instruments
def test_the_vwap_comparison_is_future_against_future_and_spot_vwap_is_unavailable(tmp_path: Path) -> None:
    s = Rig(tmp_path).svc.summary()
    v = s["pulse"]["vwap"]
    assert v["instrument"] == "NIFTY current-month future" and v["futures_vwap"] == 24050 and v["spot_vwap"] is None and "no traded volume" in v["spot_vwap_note"]
    by = {e["key"]: e for e in s["engines"]}
    names = [t["name"] for t in by["structure"]["terms"]]
    assert "Futures price versus futures VWAP" in names and not any(n == "Future versus its VWAP" for n in names)
    detail = next(t for t in by["structure"]["terms"] if t["name"].startswith("Futures price versus futures VWAP"))["detail"]
    assert "spot is never compared" in detail
    caps = {c["id"]: c for c in s["capabilities"]}
    assert caps["spot_vwap"]["status"] == "UNAVAILABLE"
    assert s["heavyweights"] is None or "vwap_note" in s["heavyweights"].get("nifty", {"vwap_note": ""})


# ---------------------------------------------------------------- observations
def eng(price15: float | None, oi15: float | None) -> dict[str, dict[str, Any]]:
    return {"positioning": {"price_change_15m_pct": price15, "oi_change_15m": oi15}, "orderflow": {}}


def test_each_requested_observation_is_detected_and_none_is_called_a_reversal() -> None:
    inp = {"heavy": {"aggregate": {"15": {"score": -40.0}, "momentum": 12.0}}, "rolling": {"acceleration": {"current_pct": 30.0, "previous_pct": 10.0}},
           "intraday": {"vwap": {"side": "above", "vwap": 24050, "distance_pts": 38.0, "distance_pct": 0.158}}}
    gex = {"available": True, "net": 5.0, "flip": 24400.0, "flip_distance_pct": 1.6, "flip_distance_pts": 390.0, "flip_support": {"status": "unstable"}}
    out = {o["id"]: o for o in fz.observations(inp, eng(0.3, -20000.0), gex)}
    assert set(out) == {"up_vs_heavy_cvd", "up_with_improving_cvd", "up_oi_down", "futures_vs_vwap", "positive_gex_far_flip"}
    assert "futures and heavyweights" in out["up_with_improving_cvd"]["reading"]
    assert "-20,000" in out["up_oi_down"]["reading"] and "spot is not compared" in out["futures_vs_vwap"]["reading"]
    assert "390 pts" in out["positive_gex_far_flip"]["reading"] and "unstable" in out["positive_gex_far_flip"]["reading"]
    assert all(o["reversal_signal"] is False and "not a reversal signal" in o["explanation"] for o in out.values())


def test_observations_stay_silent_when_the_conditions_are_not_met() -> None:
    inp = {"heavy": {"aggregate": {"15": {"score": 30.0}, "momentum": -3.0}}, "rolling": {"acceleration": {"status": "unavailable: x"}}, "intraday": {}}
    gex = {"available": True, "net": -4.0, "flip": 24990.0, "flip_distance_pct": 0.04}
    assert fz.observations(inp, eng(-0.4, 5000.0), gex) == []  # price falling, positive CVD, OI up, negative GEX near its flip: none of the five
    assert fz.observations({}, eng(None, None), {"available": False}) == []


def test_the_interpretation_names_evidence_quality_and_says_it_is_not_a_probability() -> None:
    es = [{"key": "positioning", "score": 40, "tilt": "bullish", "supporting": [], "conflicting": [], "name": "A"}]
    text = fz.interpretation({"score": 40.0, "class": "Bullish", "confidence": 68.0}, es, {"name": "Bullish trend"}, [], {"available": False}, {})
    assert "evidence quality 68 of 100" in text and "not a probability" in text and "confidence" not in text.lower()
    f = fz.fuse([{**e, "freshness": {"fresh": True}} for e in [{"key": k, "score": 40.0, "status": "AVAILABLE", "fraction": 1.0} for k in fz.DEFAULT_WEIGHTS]], fz.DEFAULT_WEIGHTS)
    assert f["evidence_quality"] == f["confidence"] and "not a probability" in f["note"] and f["confidence"] <= 100
