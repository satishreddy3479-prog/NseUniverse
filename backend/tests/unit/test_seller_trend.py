"""The seller environment reads the Trend & Regime and Session Structure (TWAP / VWAP) readings of the index. Hand-calculated, and checked against the page's figures on the real bars of 23 Nov 2026."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.intelligence import fusion as fz
from app.intelligence import straddle_env as env
from app.intelligence import trend_engine as te

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "index_bars_2026-11-23.json"


def test_the_session_structure_of_a_small_set_of_closes_by_hand() -> None:
    closes = [100.0, 102.0, 101.0, 99.0, 100.0, 103.0]
    # running means: 100, 101, 101, 100.5, 100.4, 100.8333; sides (close vs mean): 0, +1, 0 (101 = 101), -1, -1, +1
    s = te.session_structure(closes)
    assert s is not None
    assert s["n"] == 6 and s["pct_above"] == pytest.approx(33.3, abs=0.05)  # 2 of 6 above
    assert s["crossings"] == 2  # +1 -> -1 and -1 -> +1 (the equal-to-mean bars are skipped)
    assert s["longest_run"] == 2 and s["run_side"] == -1  # the two bars below
    assert s["distance"] == pytest.approx(103 - 605 / 6, abs=0.005)  # 2.17
    assert te.session_structure([100.0]) is None


def test_the_structure_of_the_real_trend_day_matches_the_page() -> None:
    """23 Nov 2026 (NIFTY fell about 565 points): the Session Structure tab showed the close 163.1 points below its session mean, never above it."""
    real = json.loads(FIXTURE.read_text(encoding="utf-8"))
    a = te.assess(real["bars"])
    st = a["structure"]
    assert st["n"] == 72 and st["pct_above"] == 0.0 and st["crossings"] == 0 and st["longest_run"] == 71 and st["run_side"] == -1
    assert st["distance"] == pytest.approx(-163.14, abs=0.01)
    group = fz.trend_group({"trend": {**a, "is_today": True}}, {})
    exposed = group["structure"]
    assert exposed["crossings"] == 0 and exposed["atr"] == pytest.approx(25.32) and exposed["distance_atr"] == pytest.approx(-163.14 / 25.32, abs=0.01)  # -6.44 ATR
    assert fz.trend_group({"trend": {**a, "is_today": False, "day": "2026-11-23"}}, {})["structure"] is None  # an earlier session is no evidence for today


def test_the_regime_component_by_class() -> None:
    def comp(label: str | None, score: float | None = 0.5) -> dict:
        ev = {**env.evidence({}, {}), "trend_label": label, "trend_score": score}
        return next(c for c in env.seller_components(ev) if c["id"] == "trend_regime")

    assert comp("Range-bound", 0.20)["value"] == 0.6 and comp("Range-bound", 0.20)["weight"] == env.TREND_REGIME_WEIGHT == 10
    assert comp("Mixed", 0.35)["value"] == 0.1
    assert comp("Weak uptrend", 0.5)["value"] == -0.4 and comp("Weak downtrend", 0.5)["value"] == -0.4  # direction does not matter to a straddle seller
    assert comp("Trending down", 0.88)["value"] == -1.0 and comp("Trending up", 0.88)["value"] == -1.0
    assert comp("Trending up (fading)", 0.7)["value"] == -0.5  # price has walked back: half the fear
    assert comp("Range-bound (fading)", 0.2)["value"] == 0.6  # a fading flag only eases a trend label
    for none in ("Warming up", None):
        c = comp(none)
        assert c["value"] is None and c["status"] == "UNAVAILABLE"  # missing stays missing, never neutral


def test_the_structure_component_by_hand() -> None:
    def comp(struct: dict | None, vwap: float | None) -> dict:
        ev = {**env.evidence({}, {}), "struct": struct, "vwap_pct": vwap}
        return next(c for c in env.seller_components(ev) if c["id"] == "session_structure")

    # a range day: 6 crossings in 13 bars (rate 6/12 = 0.5 -> (0.5 - 0.12) / 0.12 = 3.2, capped at +1), 0.3 ATR from the mean (0.6 - 0.3/1.5 = 0.4), future 0.1% from VWAP (+0.3)
    rng = comp({"n": 13, "crossings": 6, "distance_atr": 0.3}, 0.1)
    assert rng["value"] == pytest.approx((1.0 + 0.4 + 0.3) / 3, abs=0.001) and rng["weight"] == env.SESSION_STRUCTURE_WEIGHT == 6
    # the real trend day of 23 Nov: no crossings (-1), -6.44 ATR (0.6 - 4.29 = -3.7, floored at -1), VWAP 0.4% away (-0.5)
    trend = comp({"n": 72, "crossings": 0, "distance_atr": -6.44}, 0.4)
    assert trend["value"] == pytest.approx((-1.0 - 1.0 - 0.5) / 3, abs=0.001)
    assert comp({"n": 72, "crossings": 0, "distance_atr": -6.44}, None)["value"] == pytest.approx(-1.0)  # no VWAP: the other two readings only
    assert comp({"n": 5, "crossings": 2, "distance_atr": 0.1}, 0.1)["value"] is None  # under half an hour of bars: nothing is said
    assert comp(None, 0.1)["value"] is None


def test_two_components_move_the_score_by_hand() -> None:
    rng_t = {"id": "trend_regime", "name": "t", "weight": 10, "value": 0.6, "text": "", "source": "", "proxy": False}
    rng_s = {"id": "session_structure", "name": "s", "weight": 6, "value": 0.5667, "text": "", "source": "", "proxy": False}
    # 50 + 50 x (10 x 0.6 + 6 x 0.5667) / 16 = 50 + 50 x 9.4002 / 16 = 79.4
    assert env.score([rng_t, rng_s])["score"] == pytest.approx(79.4, abs=0.05)
    trend_t = {**rng_t, "value": -1.0}
    trend_s = {**rng_s, "value": -0.8333}
    # 50 + 50 x (-10 - 5.0) / 16 = 3.1
    assert env.score([trend_t, trend_s])["score"] == pytest.approx(3.1, abs=0.05)


def test_the_evidence_reads_the_trend_engine_of_market_intelligence() -> None:
    mi = {"engines": [{"key": "orderflow", "score": 10}, {"key": "trend", "score": -80, "regime": {"label": "Trending down", "score": 0.88, "direction": -1},
                                                           "structure": {"n": 72, "crossings": 0, "distance_atr": -6.44}}]}
    ev = env.evidence({}, mi)
    assert ev["trend_label"] == "Trending down" and ev["trend_score"] == 0.88 and ev["struct"]["crossings"] == 0
    none = env.evidence({}, {"engines": [{"key": "trend", "score": None, "regime": None, "structure": None}]})
    assert none["trend_label"] is None and none["struct"] is None  # a trend engine with nothing to say gives nothing, not a neutral value
    assert env.evidence({}, {})["trend_label"] is None


def test_a_trending_session_lowers_the_seller_score_and_a_range_raises_it(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(env, "TREND_REGIME_WEIGHT", 10)
    monkeypatch.setattr(env, "SESSION_STRUCTURE_WEIGHT", 6)
    # enough other evidence (decay 8, IV trend 12, realised vs implied 12, movement 10, gamma 8, skew 5, flow 8 = 63 of 118) that coverage (53 %) is not the reason for a missing score
    base = {**env.evidence({}, {}), "rv_gap": 3.0, "ratio": 0.8, "iv_atm_30": -0.2, "orderflow": 0.0, "skew_change": 0.0, "config": ["suppressed movement"],
            "eff": {"efficiency_pct": 120.0, "status": "efficient", "reason": "x", "confidence": 1.0}}
    calm = {**base, "trend_label": "Range-bound", "trend_score": 0.2, "struct": {"n": 40, "crossings": 9, "distance_atr": 0.2}, "vwap_pct": 0.05}
    run = {**base, "trend_label": "Trending down", "trend_score": 0.88, "struct": {"n": 40, "crossings": 0, "distance_atr": -5.0}, "vwap_pct": 0.5}
    none = {**base, "trend_label": None, "struct": None}
    d = {"value": None, "label": "unavailable", "parts": []}
    s_calm, s_run, s_none = (env.seller(e, d)["score"] for e in (calm, run, none))
    assert s_calm > s_none > s_run
    assert any(c["id"] == "trend_regime" and c["contribution"] < 0 for c in env.seller(run, d)["components"])  # the page's "Why these scores" shows the points it took off


def test_a_weight_of_zero_keeps_the_reading_on_the_page_and_out_of_the_score(monkeypatch: pytest.MonkeyPatch) -> None:
    base = {**env.evidence({}, {}), "rv_gap": 3.0, "ratio": 0.8, "iv_atm_30": -0.2, "orderflow": 0.0, "skew_change": 0.0, "config": ["suppressed movement"],
            "eff": {"efficiency_pct": 120.0, "status": "efficient", "reason": "x", "confidence": 1.0}}
    run = {**base, "trend_label": "Trending down", "trend_score": 0.88, "struct": {"n": 40, "crossings": 0, "distance_atr": -5.0}, "vwap_pct": 0.5}
    d = {"value": None, "label": "unavailable", "parts": []}
    monkeypatch.setattr(env, "TREND_REGIME_WEIGHT", 0)
    monkeypatch.setattr(env, "SESSION_STRUCTURE_WEIGHT", 0)
    without = env.seller({**base, "trend_label": None, "struct": None}, d)
    zero = env.seller(run, d)
    shown = {c["id"]: c for c in zero["components"]}
    assert shown["trend_regime"]["value"] == -1.0 and shown["trend_regime"]["weight"] == 0 and shown["trend_regime"]["contribution"] == 0.0  # listed, with its value, scoring nothing
    assert zero["score"] == without["score"] and zero["coverage"] == without["coverage"]
