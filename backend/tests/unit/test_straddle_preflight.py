"""The convexity and premium-expansion caps and the pre-flight radar (hand-built analyses; the real 19 Nov 2026 13:43 premium series for one case)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.intelligence import straddle_env as env

GAMMA = "gamma exposure (realised convexity)"
FIX = json.loads((Path(__file__).parent.parent / "fixtures" / "straddle" / "straddle_19nov2026_1343.json").read_text(encoding="utf-8"))


def eff(gamma: float | None, theta: float | None, pct: float | None = 30.0) -> dict[str, Any]:
    causes = None if gamma is None else {GAMMA: gamma}
    return {"efficiency_pct": pct, "expected_decay": theta, "causes": causes, "status": "ok"}


# ------------------------------------------------------------------ the flags
def test_convexity_blowout_needs_gamma_above_one_and_a_half_times_theta_and_caps_at_high_risk() -> None:
    base = env.evidence({}, {})
    over = env.flags({**base, "eff": eff(16.0, 10.0)})  # 16 > 1.5 x 10
    hit = next(f for f in over if f["id"] == "convexity_blowout")
    assert hit["cap"] == "High risk" and "+16.0 pts" in hit["text"] and "(10.0 pts)" in hit["text"]
    assert not [f for f in env.flags({**base, "eff": eff(15.0, 10.0)}) if f["id"] == "convexity_blowout"]  # exactly 1.5 x is not over it
    assert not [f for f in env.flags({**base, "eff": eff(16.0, 0.0)}) if f["id"] == "convexity_blowout"]  # no theta to compare with
    assert not [f for f in env.flags({**base, "eff": eff(None, None, None)}) if f["id"] == "convexity_blowout"]  # a window too short to judge has no causes
    assert not [f for f in env.flags({**base, "eff": eff(-5.0, 10.0)}) if f["id"] == "convexity_blowout"]  # gamma that helped the seller


def test_premium_expansion_is_a_negative_decay_efficiency() -> None:
    base = env.evidence({}, {})
    fl = env.flags({**base, "eff": eff(1.0, 10.0, pct=-50.0)})
    hit = next(f for f in fl if f["id"] == "premium_expansion")
    assert hit["cap"] == "Unfavourable" and "-50%" in hit["text"]
    for pct in (0.0, 20.0, None):
        assert not [f for f in env.flags({**base, "eff": eff(1.0, 10.0, pct=pct)}) if f["id"] == "premium_expansion"]


def test_the_seller_class_is_hard_capped_at_high_risk_by_a_convexity_blowout() -> None:
    base = env.evidence({}, {})
    good = {**base, "rv_gap": 6.0, "ratio": 0.6, "iv_atm_30": -0.5, "orderflow": 0.0, "skew_change": 0.0, "eff": eff(2.0, 10.0)}
    calm = env.seller(good, {"value": None, "label": "unavailable", "parts": []})
    assert calm["flags"] == [] and calm["capped_by_flags"] is None and calm["class"] in ("Neutral", "Favourable", "Highly favourable")
    blown = env.seller({**good, "eff": eff(16.0, 10.0)}, {"value": None, "label": "unavailable", "parts": []})
    assert [f["id"] for f in blown["flags"]] == ["convexity_blowout"] and blown["class"] == "High risk" and blown["capped_by_flags"] == "High risk"
    assert blown["score"] is not None  # the number stays the raw reading; the class is the capped one
    assert blown["short_straddle"]["score"] is not None and blown["short_straddle"]["score"] <= 40  # the straddle sub-score is held at 40, as for a directional flag


# ------------------------------------------------------------------ the radar
def cum(change15: float) -> list[float]:
    """40 minutes of cumulative roll-adjusted change whose last 15 minutes add ``change15``."""
    return [0.0] * 25 + [change15] * 15


def analysis(prem15: float | None = -2.0, iv15: float | None = 0.1, flip: float | None = 25400.0, spot: float = 25500.0, gamma: float | None = 3.0, theta: float | None = 8.0,
             live: bool = True, stale: bool = False) -> dict[str, Any]:  # fmt: skip
    a: dict[str, Any] = {
        "quality": {"live": live, "stale": stale, "age_minutes": 3.0}, "spot": [25490.0, spot],
        "tracker": {"atm_now": 25500.0, "rolling": {"straddle": {"open": 300.0, "current": 271.5}, "ce": {"current": 130.0}, "pe": {"current": 141.5}}},
        "iv": {"moves": {"rolling_atm": {"15": iv15}}},
        "structure": {"gex": None if flip is None else {"flip": flip}},
        "attribution": {"rolling": {"60": {"efficiency": eff(gamma, theta)}}},
    }  # fmt: skip
    if prem15 is not None:
        a["cumulative"] = {"rolling": {"actual": cum(prem15)}}
    return a


SQUEEZE = {"id": "ACTIVE_SHORT_SQUEEZE", "severity": "high", "message": "Short squeeze in progress: NIFTY +0.22% in 15 minutes while futures open interest shed 40,000 units (615 lots). Do not sell at-the-money calls or straddles."}
VWAP = {"id": "VWAP_TREND_DETACHMENT", "severity": "high", "message": "The future has stayed above its VWAP for 40 minutes."}
IB = {"id": "IB_EXPANSION_TREND", "severity": "high", "message": "The opening 30 minutes covered 140 points, 0.70 of the implied daily move (200): trend-day risk"}
FLOOR = {"id": "PUT_FLOOR_ADVANCING", "severity": "medium", "message": "Put floor advancing: 30,000 units added on puts."}


def regime(*flags: dict[str, str], label: str = "UNCLEAR", ib_ratio: float | None = None, any_known: bool = True) -> dict[str, Any]:
    return {"label": label, "flags": list(flags), "ib": {"status": "ok", "ratio": ib_ratio}, "squeeze": {"status": "ok"}, "put_floor": {"status": "ok"}, "vwap": {"status": "ok"}, "any_known": any_known}


def radar(a: dict[str, Any], lr: dict[str, Any] | None = None) -> dict[str, Any]:
    ev = env.evidence(a, {})
    return env.evaluate_preflight(a, {"seller": {"flags": env.flags(ev)}}, lr)


def test_all_four_gates_passing_in_a_mean_reverting_box_is_green_and_the_levels_are_by_hand() -> None:
    r = radar(analysis(), regime(label="DECAY_FAVOURED", ib_ratio=0.30))
    assert r["verdict"] == "ALL_CLEAR_TO_SELL" and r["badge"] == "GREEN" and r["reasons"] == [] and r["unknown"] == []
    assert r["headline"] == "ALL CLEAR — PREMIUMS DECAYING (OK TO SELL MANUALLY)"
    assert {k: v["status"] for k, v in r["gates"].items()} == {"premium_decay": "PASS", "volatility_shock": "PASS", "regime_squeeze": "PASS", "structure_flip": "PASS"}
    assert r["gates"]["premium_decay"]["label"] == "Decaying (-2.0 pts)" and r["gates"]["volatility_shock"]["label"] == "Stable (+0.10 vol)"
    assert r["gates"]["regime_squeeze"]["label"] == "Mean-reverting box (opening range 0.30x the daily move)"
    assert r["gates"]["structure_flip"]["label"] == "Spot +100 pts from flip (25400)"
    t = r["trade_setup"]
    assert t["strike"] == 25500.0 and t["combined_premium"] == 271.5 and t["ce_price"] == 130.0 and t["pe_price"] == 141.5
    assert t["stop_loss_pts"] == 320.4 and t["stop_loss_pct"] == 18.0 and t["re_strike_pts"] == 35.0  # 271.5 x 1.18 = 320.37
    assert "not a trade signal" in r["note"]


def test_spot_oscillating_around_the_vwap_with_a_falling_premium_is_all_clear() -> None:
    """No squeeze, no runaway, no wide opening range (three of the four regime readings available), a premium 4.2 points lower over 15 minutes and calm IV."""
    r = radar(analysis(prem15=-4.2, iv15=-0.2), regime(label="UNCLEAR"))
    assert r["verdict"] == "ALL_CLEAR_TO_SELL" and r["gates"]["premium_decay"]["label"] == "Decaying (-4.2 pts)" and r["gates"]["volatility_shock"]["label"] == "Cooling (-0.20 vol)"
    assert r["gates"]["regime_squeeze"]["status"] == "PASS" and "readings available" in r["gates"]["regime_squeeze"]["label"]


def test_a_short_squeeze_blocks_and_names_itself_with_gamma_convexity_in_the_headline() -> None:
    r = radar(analysis(gamma=16.0, theta=10.0), regime(SQUEEZE, label="TREND_RISK"))
    assert r["verdict"] == "BLOCKED" and r["badge"] == "RED" and r["gates"]["regime_squeeze"]["status"] == "FAIL" and r["gates"]["regime_squeeze"]["label"] == "Active squeeze / trend"
    assert r["headline"] == "DO NOT SELL — SHORT SQUEEZE & GAMMA CONVEXITY DETECTED"
    assert r["reasons"] == ["SHORT SQUEEZE", "GAMMA CONVEXITY"]
    assert "Short squeeze in progress" in r["summary"] and "Realised convexity (+16.0 pts) is overwhelming theta (10.0 pts)" in r["summary"]
    assert radar(analysis(gamma=15.0, theta=10.0), regime())["gates"]["regime_squeeze"]["status"] == "PASS"  # exactly 1.5 x theta is within the limit, and no squeeze


def test_one_vwap_or_opening_range_flag_alone_warns_and_two_trend_flags_or_a_squeeze_block() -> None:
    # 20 Nov 2026 10:30 IST: only the VWAP flag (0.23% from the future's VWAP) was on while premium decayed 9 points, IV cooled and spot was above the flip; the card was red for it (D224)
    lone = radar(analysis(), regime(VWAP, label="TREND_RISK"))
    assert lone["verdict"] == "SELECTIVE" and lone["badge"] == "YELLOW" and lone["headline"] == "SELECTIVE / CAUTION" and lone["reasons"] == []
    assert lone["gates"]["regime_squeeze"]["status"] == "WARN" and lone["gates"]["regime_squeeze"]["label"] == "Trend day risk: vwap trend runaway"
    assert "The future has stayed above its VWAP" in lone["summary"]
    wide = radar(analysis(), regime(IB, label="TREND_RISK"))
    assert wide["badge"] == "YELLOW" and "opening 30 minutes covered 140 points" in wide["summary"]
    assert radar(analysis(), regime(SQUEEZE, label="TREND_RISK"))["badge"] == "RED"  # a squeeze alone still blocks
    assert radar(analysis(), regime(VWAP, IB, label="TREND_RISK"))["badge"] == "RED"  # two trend flags together block
    assert radar(analysis(prem15=1.0), regime(VWAP, label="TREND_RISK"))["badge"] == "RED"  # a warning does not hide another failing gate (premium rising)


def test_other_trend_flags_block_too_and_a_put_floor_alone_only_warns() -> None:
    both = radar(analysis(), regime(VWAP, IB, label="TREND_RISK"))
    assert both["verdict"] == "BLOCKED" and both["headline"] == "DO NOT SELL — VWAP TREND RUNAWAY & WIDE OPENING RANGE DETECTED"
    assert both["gates"]["regime_squeeze"]["label"] == "Trend day risk: vwap trend runaway, wide opening range"
    floor = radar(analysis(), regime(FLOOR))
    assert floor["verdict"] == "SELECTIVE" and floor["badge"] == "YELLOW" and floor["gates"]["regime_squeeze"]["status"] == "WARN" and floor["reasons"] == []
    assert floor["headline"] == "SELECTIVE / CAUTION" and "Put open interest is being added" in floor["summary"]


def test_a_rising_premium_blocks_and_flat_passes() -> None:
    r = radar(analysis(prem15=1.75), regime())
    assert r["verdict"] == "BLOCKED" and r["gates"]["premium_decay"]["status"] == "FAIL" and r["gates"]["premium_decay"]["val_15m"] == 1.75
    assert r["gates"]["premium_decay"]["label"] == "Expanding (+1.8 pts)" and r["headline"] == "DO NOT SELL — PREMIUM EXPANSION DETECTED"
    assert "Premiums are expanding (+1.8 pts in 15 min)" in r["summary"]
    assert radar(analysis(prem15=0.0), regime())["gates"]["premium_decay"]["status"] == "PASS"  # flat is not rising


def test_an_iv_rise_above_a_tenth_of_a_vol_point_blocks() -> None:
    r = radar(analysis(iv15=0.5), regime())
    assert r["verdict"] == "BLOCKED" and r["reasons"] == ["IV SPIKE"] and r["gates"]["volatility_shock"]["label"] == "IV spike (+0.50 vol)"
    assert radar(analysis(iv15=0.1), regime())["gates"]["volatility_shock"]["status"] == "PASS"  # up to 0.1 vol points is calm
    assert radar(analysis(iv15=0.11), regime())["gates"]["volatility_shock"]["status"] == "FAIL"


def test_below_the_gamma_flip_is_selective_only_beyond_fifteen_points() -> None:
    near = radar(analysis(spot=25385.0), regime())  # flip 25,400: 25,385 is exactly 15 points below
    assert near["gates"]["structure_flip"]["status"] == "PASS" and near["verdict"] == "ALL_CLEAR_TO_SELL"
    below = radar(analysis(spot=25380.0), regime())
    assert below["gates"]["structure_flip"]["status"] == "WARN" and below["gates"]["structure_flip"]["label"] == "Spot -20 pts from flip (25400)"
    assert below["verdict"] == "SELECTIVE" and below["badge"] == "YELLOW" and below["reasons"] == []


def test_a_missing_input_is_unknown_never_a_pass_and_never_a_green() -> None:
    no_flip = radar(analysis(flip=None), regime())
    assert no_flip["gates"]["structure_flip"]["status"] == "UNKNOWN" and no_flip["unknown"] == ["structure_flip"]
    assert no_flip["verdict"] == "INCOMPLETE" and no_flip["badge"] == "GREY" and "no all-clear" in no_flip["summary"]
    no_regime = radar(analysis(), None)
    assert no_regime["gates"]["regime_squeeze"]["status"] == "UNKNOWN" and no_regime["verdict"] == "INCOMPLETE"
    nothing_known = radar(analysis(), regime(any_known=False))
    assert nothing_known["gates"]["regime_squeeze"]["status"] == "UNKNOWN"
    none = radar(analysis(prem15=None, iv15=None, flip=None), None)
    assert none["verdict"] == "INCOMPLETE" and set(none["unknown"]) == {"premium_decay", "volatility_shock", "regime_squeeze", "structure_flip"} and none["reasons"] == []
    mixed = radar(analysis(prem15=1.0, iv15=None), regime(SQUEEZE))  # something fails: the unknowns do not hide it
    assert mixed["verdict"] == "BLOCKED" and "volatility_shock" in mixed["unknown"]


def test_a_stored_or_stale_session_gets_no_verdict() -> None:
    stored = radar(analysis(live=False), regime())
    assert stored["verdict"] == "NO_LIVE_DATA" and stored["badge"] == "GREY" and stored["gates"] == {} and "stored session" in stored["summary"] and stored["headline"] == "NO LIVE READING"
    stale = radar(analysis(stale=True), regime())
    assert stale["verdict"] == "NO_LIVE_DATA" and "3.0 minutes old" in stale["summary"]
    assert stale["trade_setup"]["strike"] == 25500.0  # the levels are still shown for reference


def test_the_real_19_nov_premium_series_is_blocked_for_a_premium_that_rose_over_15_minutes() -> None:
    """The reduced real read of 19 Nov 2026 13:43 IST (premium series only): the roll-adjusted at-the-money premium rose 1.75 points over the last 15 minutes (4.70 to 6.45). Its futures
    open interest, option open interest, VWAP, gamma, theta, IV and gamma-flip inputs are not in this fixture, so the squeeze and convexity reasons cannot be shown from it: only the premium blocks,
    and the radar says which gates it could not read."""
    a = {**FIX, "quality": {"live": True, "stale": False, "age_minutes": 1.0}, "spot": [25385.0]}
    r = env.evaluate_preflight(a, {}, None)
    assert r["verdict"] == "BLOCKED" and r["badge"] == "RED" and r["reasons"] == ["PREMIUM EXPANSION"] and r["headline"] == "DO NOT SELL — PREMIUM EXPANSION DETECTED"
    assert r["gates"]["premium_decay"]["val_15m"] == 1.75 and set(r["unknown"]) == {"volatility_shock", "regime_squeeze", "structure_flip"}
    assert r["trade_setup"]["combined_premium"] == 268.0 and r["trade_setup"]["stop_loss_pts"] == pytest.approx(268.0 * 1.18, abs=0.05)
