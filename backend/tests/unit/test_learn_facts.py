"""The Learn page's 'How it works' guides (frontend/src/lib/learnGuides.ts) quote constants and worked examples. This test keeps them honest:

* every figure in learnFacts.json equals the engine constant it names;
* every worked example is recomputed with the engine's own functions, and the number printed in the guide is checked to be present in the guide text.

The examples are round numbers chosen for hand arithmetic; the expected values below are written out by hand (see each comment), not copied from the code's output.
"""

from __future__ import annotations

import itertools
import json
import math
from pathlib import Path
from typing import Any

import pytest

from app.intelligence import fusion as fu
from app.intelligence import outlook, pullback, turn
from app.intelligence import straddle as st
from app.intelligence import straddle_env as se
from app.intelligence import trend_engine as te
from app.intraday.volatility import CALL, DEFAULT_RATE, price

LIB = Path(__file__).resolve().parents[3] / "frontend" / "src" / "lib"
FACTS = json.loads((LIB / "learnFacts.json").read_text(encoding="utf-8"))
GUIDE = (LIB / "learnGuides.ts").read_text(encoding="utf-8")


def _ev() -> dict[str, Any]:
    """An evidence dict with nothing available: components are still listed, with their weights."""
    return {k: None for k in ("eff", "iv_atm_30", "iv_atm_15", "dce30", "dpe30", "rv_gap", "ratio", "skew_change", "skew25", "ce25", "accel", "eff30", "orderflow", "positioning", "heavy15", "vwap_pct", "spot",
                              "prem_rolling")} | {"reg30": [], "config": [], "gex": {}, "gex_session": {}, "opt": {}, "vwap_side": None, "rv_thin": None, "rv_n": None}


# ------------------------------------------------------------------------------------------------ constants
def test_market_intelligence_constants_match_the_engine() -> None:
    mi = FACTS["mi"]
    assert mi["weights"] == fu.DEFAULT_WEIGHTS
    assert sum(mi["weights"].values()) == 100
    assert [[lo, name] for lo, name in fu.CLASSES] == mi["classes"]
    assert (mi["min_coverage"], mi["min_engines"]) == (fu.MIN_COVERAGE, fu.MIN_ENGINES)
    assert (mi["stale_live_s"], mi["stale_stored_s"]) == (fu.STALE_LIVE_S, fu.STALE_STORED_S)
    assert (mi["lean_min_score"], mi["lean_min_quality"]) == (outlook.LEAN_MIN_SCORE, outlook.LEAN_MIN_QUALITY)
    t = mi["turn"]
    assert t == {"smooth": turn.SMOOTH, "lookback": turn.LOOKBACK, "flow_drop": turn.FLOW_DROP, "score_drop": turn.SCORE_DROP, "breadth_drop": turn.BREADTH_DROP, "breadth_min": turn.BREADTH_MIN,
                 "persist_window": turn.PERSIST_WINDOW, "persist_min": turn.PERSIST_MIN}
    p = mi["pullback"]
    assert p == {"pull_atr": pullback.PULL_ATR, "strong_atr": pullback.STRONG_ATR, "run_atr": pullback.RUN_ATR, "run_lookback": pullback.RUN_LOOKBACK, "pull_window": pullback.PULL_WINDOW,
                 "persist_window": pullback.PERSIST_WINDOW, "persist_min": pullback.PERSIST_MIN, "neutral_cap": pullback.NEUTRAL_CAP}


def test_trend_constants_match_the_engine() -> None:
    t = FACTS["trend"]
    assert {k: list(v) for k, v in te.SCALES.items()} == t["scales"]
    assert (t["mixed"], t["weak"], t["trend"], t["margin"]) == (te.MIXED, te.WEAK, te.TREND, te.MARGIN)
    assert (t["tf"], t["window"], t["adx_n"], t["min_dwell"], t["min_window"]) == (te.TF, te.WINDOW, te.ADX_N, te.MIN_DWELL, te.MIN_WINDOW)
    assert (t["fade_bars"], t["fade_atr"], t["or_minutes"], t["atr_n"]) == (te.FADE_BARS, te.FADE_ATR, te.OR_MINUTES, te.ATR_N)


def test_straddle_constants_and_component_weights_match_the_engine() -> None:
    s = FACTS["straddle"]
    assert s["rate"] == DEFAULT_RATE
    assert (s["lot_size"], s["restrike_points"]) == (st.LOT_SIZE, st.RESTRIKE_POINTS)
    assert (s["efficient_pct"], s["meaningful_pct"], s["expansion_pct"]) == (st.EFFICIENT_PCT, st.MEANINGFUL_PCT, st.EXPANSION_PCT)
    assert (s["min_expected_pts"], s["full_confidence_pts"]) == (st.MIN_EXPECTED_PTS, st.FULL_CONFIDENCE_PTS)
    assert s["min_coverage"] == se.MIN_COVERAGE
    assert [[lo, n] for lo, n in se.SELLER_CLASSES] == s["seller_classes"]
    assert [[lo, n] for lo, n in se.BUYER_CLASSES] == s["buyer_classes"]
    assert (s["convexity_ratio"], s["prem_scale_pct"], s["prem_stop_pct"], s["prem_stop_hard_pct"]) == (se.CONVEXITY_RATIO, se.PREM_SCALE_PCT, se.PREM_STOP_PCT, se.PREM_STOP_HARD_PCT)
    assert {c["id"]: c["weight"] for c in se.seller_components(_ev())} == s["seller_weights"]
    assert {c["id"]: c["weight"] for c in se.buyer_components(_ev(), {"value": None, "label": "unavailable"})} == s["buyer_weights"]
    assert sum(s["seller_weights"].values()) == 102 and sum(s["buyer_weights"].values()) == 108  # the totals the guide prints


# ------------------------------------------------------------------------------------------------ worked examples
def _eng(key: str, score: float | None, fraction: float = 1.0) -> dict[str, Any]:
    return {"key": key, "score": score, "fraction": fraction, "status": "AVAILABLE", "freshness": {"fresh": True}}


def test_guide_example_squash_and_group_score() -> None:
    assert fu.squash(0.03, 0.05) == pytest.approx(53.7, abs=0.05)  # 100 x tanh(0.6) = 53.70
    assert fu.squash(0.06, 0.05) == pytest.approx(83.4, abs=0.05)  # tanh(1.2) = 0.8337
    terms = [fu.Term("a", 40, "", family="options_oi"), fu.Term("b", 20, "", family="options_oi"), fu.Term("c", 60, "", family="futures_oi", weight=0.5)]
    # families: options OI mean 30 at weight 1, futures 60 at weight 0.5 -> (30 + 30) / 1.5 = 40
    assert fu.engine("positioning", terms, [], {})["score"] == 40.0
    for needle in ("53.7", "83.4", "+40.0"):
        assert needle in GUIDE


def test_guide_example_fusion_a_b_and_confidence() -> None:
    w = fu.DEFAULT_WEIGHTS
    a = fu.fuse([_eng("positioning", 40), _eng("orderflow", 20), _eng("volatility", -10), _eng("structure", 50), _eng("participation", 30), _eng("trend", 10)], w)
    # 25x40 + 17x20 + 8x(-10) + 17x50 + 17x30 + 16x10 = 1000 + 340 - 80 + 850 + 510 + 160 = 2780 -> 27.8
    assert a["score"] == 27.8 and a["class"] == "Mild Bullish" and a["coverage"] == 1.0
    b = fu.fuse([_eng("positioning", 40), _eng("orderflow", None), _eng("volatility", None), _eng("structure", 50), _eng("participation", 30, 0.5), _eng("trend", 10)], w)
    # weights 25 + 17 + 8.5 + 16 = 66.5; (1000 + 850 + 255 + 160) / 66.5 = 34.06
    assert b["coverage"] == 0.665 and b["score"] == 34.1 and b["class"] == "Mild Bullish"
    c = fu.fuse([_eng("positioning", 60), _eng("orderflow", -40), _eng("volatility", 0), _eng("structure", 30), _eng("participation", -30), _eng("trend", 0)], w)
    # (1500 - 680 + 510 - 510) / 100 = 8.2; conflict = 34 / 100 = 0.34, agreement 0.32
    assert c["score"] == 8.2 and c["agreement"] == 0.32 and c["confidence"] == 32.0 and c["confidence_parts"]["conflict_cap_applied"] is True
    for needle in ("+27.8", "0.665", "+34.1", "+8.2", "0.32"):
        assert needle in GUIDE


def test_guide_example_shapley_split_of_one_call() -> None:
    k = 25000.0
    a, b = (25000.0, 0.01, 0.14), (25040.0, 0.0095, 0.145)

    def px(use_b: tuple[bool, bool, bool]) -> float:
        f, t, v = (b[i] if use_b[i] else a[i] for i in range(3))
        return price(CALL, f, k, t, v, DEFAULT_RATE)

    phi = [0.0, 0.0, 0.0]  # forward, time, vol (the order of px's arguments)
    for order in itertools.permutations(range(3)):
        cur = [False, False, False]
        for i in order:
            before = px((cur[0], cur[1], cur[2]))
            cur[i] = True
            phi[i] += (px((cur[0], cur[1], cur[2])) - before) / 6
    change = px((True, True, True)) - px((False, False, False))
    assert px((False, False, False)) == pytest.approx(139.53, abs=0.005) and px((True, True, True)) == pytest.approx(161.86, abs=0.005)
    assert [round(x, 2) for x in phi] == [21.00, -3.58, 4.91]  # forward +21.00, time -3.58, vol +4.91
    assert sum(phi) == pytest.approx(change, abs=1e-9)  # the three parts add up exactly
    for needle in ("139.53", "161.86", "+22.33", "-3.58", "+21.00", "+4.91"):
        assert needle in GUIDE


def test_guide_example_forward_from_parity() -> None:
    assert 25000 + math.exp(0.07 * 0.01) * (300 - 280) == pytest.approx(25020.01, abs=0.005)
    assert "25,020.01" in GUIDE


def test_guide_example_decay_efficiency() -> None:
    e = st.efficiency({"theta": -12.0, "vega": 1.0, "delta": 2.0, "gamma": 0.5, "vanna": 0.0, "volga": 0.0, "residual": 0.0, "actual": -8.5})
    # 8.5 / 12 = 70.8 %; shortfall 3.5 points = 3.5 x 65 = Rs 227.5 -> 228
    assert e["efficiency_pct"] == 70.8 and e["status"] == "slower" and e["shortfall"] == 3.5 and e["shortfall_rupees"] == 228
    for needle in ("70.8%", "Rs 228"):
        assert needle in GUIDE


def test_guide_example_seller_score_and_premium_path() -> None:
    comps = [se.comp(i, i, w, v, "x", "s") for i, w, v in (("decay", 8, 0.4), ("prem_rolling", 14, -0.2), ("iv_trend", 12, 0.5), ("rv_gap", 12, 0.5), ("movement", 10, 0.2), ("flow", 8, 0.3))]
    comps += [se.comp(i, i, w, None, "no data", "s") for i, w in (("iv_sides", 6), ("gamma", 8), ("gex_stable", 5), ("skew", 5), ("positioning", 6), ("heavy", 8))]
    r = se.score(comps)
    # available weight 64 of 102 (0.627); 3.2 - 2.8 + 6 + 6 + 2 + 2.4 = 16.8; 50 + 50 x 16.8 / 64 = 63.125
    assert r["coverage"] == 0.63 and r["score"] == 63.1
    assert se._band(r["score"], se.SELLER_CLASSES) == "Favourable"
    assert se._prem_value({"pct": {"open": 9.0, "60": 4.0}}) == pytest.approx((0.6 * 9 + 0.4 * 4) / 12)  # 7.0 / 12
    assert se.damped_score(58.0, [64.0, 61.0]) == 61.0  # the median of 58, 64, 61
    for needle in ("63.1", "0.627"):
        assert needle in GUIDE


def test_guide_example_trend_score_margin_and_dwell() -> None:
    score, parts = te.trend_score({"er": 0.36, "adx": 20.0, "r2": 0.62, "chop": 55.0})
    # 0.70, 0.25, 0.70, (55 - 61.8) / (38.2 - 61.8) = 0.288 -> mean 0.4845
    assert parts["er"] == pytest.approx(0.70) and parts["adx"] == pytest.approx(0.25) and parts["r2"] == pytest.approx(0.70) and parts["chop"] == pytest.approx(0.288, abs=5e-4)
    assert score == pytest.approx(0.4845, abs=5e-4) and te._class_of(score or 0) == 2
    assert [te.step_class(2, 0.43), te.step_class(2, 0.39), te.step_class(1, 0.48), te.step_class(1, 0.50)] == [2, 1, 1, 2]
    raw = ["Mixed", "Mixed", "Weak uptrend", "Mixed", "Weak uptrend", "Weak uptrend", "Weak uptrend", "Weak uptrend"]
    assert te.apply_dwell(raw) == ["Mixed"] * 6 + ["Weak uptrend"] * 2
    assert te.strength(0.65) == pytest.approx(0.5) and fu.squash(1.0, 2.0) == pytest.approx(46.2, abs=0.05)  # tanh(0.5) = 0.4621
    for needle in ("0.485", "0.288", "+46.2"):
        assert needle in GUIDE
