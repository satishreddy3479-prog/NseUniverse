"""Market-intelligence fusion, regime, divergences, scenarios, service caching, timeline and alerts, on hand-calculated numbers."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.intelligence import fusion as fz
from app.intelligence import rolling
from app.intelligence.service import MarketIntelligence, parse_weights, rank_percentile
from app.intelligence.store import IntelligenceStore

NOW = datetime(2026, 11, 9, 4, 30, tzinfo=UTC)  # 10:00 IST


def eng(key: str, score: float | None, fresh: bool = True) -> dict[str, Any]:
    return {"key": key, "name": fz.ENGINE_NAMES[key], "score": score, "class": fz.classify(score), "tilt": fz.tilt(score), "terms": [], "supporting": [], "conflicting": [], "unavailable": [],
            "freshness": {"fresh": fresh if score is not None else None, "age_s": 5.0, "inputs": [], "failed": []}}


# ---------------------------------------------------------------- fusion
def test_overall_score_is_the_weighted_average_of_the_groups_that_have_a_score() -> None:
    es = [eng("positioning", 40), eng("orderflow", 20), eng("volatility", -10), eng("structure", None), eng("participation", 31)]
    f = fz.fuse(es, fz.DEFAULT_WEIGHTS)
    # (40x30 + 20x20 - 10x10 + 31x20) / (30 + 20 + 10 + 20) = 2120 / 80 = 26.5 : the missing group is left out, not scored zero
    assert f["score"] == 26.5 and f["class"] == "Mild Bullish"
    assert f["coverage"] == pytest.approx(0.8)
    assert f["engine_counts"] == {"available": 4, "partial": 0, "unavailable": 1}
    # nobody opposes anybody (volatility at -10 is inside +-15 and neutral): full agreement
    assert f["agreement"] == 1.0 and f["freshness"] == 1.0
    assert f["confidence"] == pytest.approx(100.0)  # coverage 0.8 is the full-coverage level: factor 1
    assert [e["contribution"] for e in es if e["key"] == "positioning"] == [pytest.approx(40 * 30 / 80, abs=0.01)]
    assert es[3]["contribution"] is None
    assert f["weights_note"] == "Provisional weights – not yet statistically calibrated."


def test_too_little_data_says_so_instead_of_a_neutral_score() -> None:
    two = fz.fuse([eng("positioning", 50), eng("orderflow", 40)], dict(fz.DEFAULT_WEIGHTS))
    assert two["score"] is None and two["class"].startswith("INSUFFICIENT DATA") and two["confidence"] is None
    lowcov = fz.fuse([eng("volatility", 30), eng("structure", 30), eng("participation", 30), eng("positioning", None), eng("orderflow", None)], fz.DEFAULT_WEIGHTS)
    assert lowcov["score"] is None  # three groups but only 50 % of the weight: coverage below the minimum
    assert "coverage 50%" in lowcov["reason"]


def test_classes_and_thresholds() -> None:
    for s, c in ((80, "Strong Bullish"), (70, "Strong Bullish"), (50, "Bullish"), (35, "Bullish"), (20, "Mild Bullish"), (0, "Neutral"), (-14, "Neutral"), (-15, "Mild Bearish"), (-35, "Bearish"), (-70, "Strong Bearish")):
        assert fz.classify(s) == c, s
    assert fz.classify(None) == "Unavailable"


def test_weights_are_configurable_and_invalid_entries_are_ignored() -> None:
    w = parse_weights('{"positioning": 40, "orderflow": -5, "volatility": "x", "bogus": 3, "futures": 99}')
    assert w["positioning"] == 40 and w["orderflow"] == fz.DEFAULT_WEIGHTS["orderflow"] and w["volatility"] == fz.DEFAULT_WEIGHTS["volatility"]
    assert "bogus" not in w and "futures" not in w  # the retired six-engine keys are ignored
    assert parse_weights("not json") == fz.DEFAULT_WEIGHTS and parse_weights("") == fz.DEFAULT_WEIGHTS
    assert set(fz.DEFAULT_WEIGHTS) == {"positioning", "orderflow", "volatility", "structure", "participation"} and sum(fz.DEFAULT_WEIGHTS.values()) == 100
    es = [eng("positioning", 40), eng("orderflow", 20), eng("structure", 30)]
    heavy = fz.fuse(es, {**fz.DEFAULT_WEIGHTS, "positioning": 100})
    assert heavy["score"] == pytest.approx((40 * 100 + 20 * 20 + 30 * 20) / (100 + 20 + 20), abs=0.1)


def test_stale_groups_lower_the_confidence_but_not_the_score() -> None:
    fresh = fz.fuse([eng("positioning", 40), eng("orderflow", 40), eng("structure", 40)], fz.DEFAULT_WEIGHTS)
    stale = fz.fuse([eng("positioning", 40, False), eng("orderflow", 40), eng("structure", 40)], fz.DEFAULT_WEIGHTS)
    assert fresh["score"] == stale["score"] == 40.0
    assert stale["freshness"] == pytest.approx(40 / 70, abs=1e-3) and stale["confidence"] < fresh["confidence"]


def test_partial_groups_count_for_only_the_share_of_their_evidence_that_is_present() -> None:
    half = eng("positioning", 50)
    half["fraction"] = 0.5
    es = [half, eng("orderflow", 50), eng("structure", 50), eng("participation", 50)]
    f = fz.fuse(es, fz.DEFAULT_WEIGHTS)
    assert half["effective_weight"] == 15.0  # 30 x 0.5
    assert f["coverage"] == pytest.approx((15 + 20 + 20 + 20) / 90, abs=1e-3)  # of the 90 weight of the four groups passed in


def test_confidence_does_not_come_from_the_size_of_the_score() -> None:
    mild = fz.fuse([eng("positioning", 20), eng("orderflow", 20), eng("structure", 20), eng("participation", 20), eng("volatility", 20)], fz.DEFAULT_WEIGHTS)
    strong = fz.fuse([eng("positioning", 95), eng("orderflow", 95), eng("structure", 95), eng("participation", 95), eng("volatility", 95)], fz.DEFAULT_WEIGHTS)
    assert mild["score"] == 20.0 and strong["score"] == 95.0
    assert mild["confidence"] == strong["confidence"] == 100.0 and mild["agreement"] == strong["agreement"] == 1.0  # same coverage, agreement, freshness: same confidence
    # the reverse: a weak score from groups that all agree is not low confidence, and a strong one that is a tug of war is
    war = fz.fuse([eng("positioning", 100), eng("structure", 100), eng("participation", 100), eng("orderflow", -100), eng("volatility", -100)], fz.DEFAULT_WEIGHTS)
    assert war["score"] == 40.0  # (3000 + 2000 + 2000 - 2000 - 1000) / 100: a Bullish score
    assert war["agreement"] == pytest.approx(0.4)  # 70 % bullish weight, 30 % bearish: 1 - 2 x 0.3
    assert war["confidence"] == pytest.approx(40.0) and war["confidence_parts"]["conflict_cap_applied"] is True
    assert war["confidence"] < 60  # never "High"
    even = fz.fuse([eng("positioning", 90), eng("structure", 90), eng("orderflow", -90), eng("participation", -90), eng("volatility", 0)], fz.DEFAULT_WEIGHTS)
    assert even["score"] == 9.0 and even["agreement"] == pytest.approx(0.2) and even["confidence"] == pytest.approx(20.0)


def test_buildup_is_the_four_way_price_and_oi_rule() -> None:
    assert fz.buildup(1, 1) == "long buildup" and fz.buildup(-1, 1) == "short buildup"
    assert fz.buildup(1, -1) == "short covering" and fz.buildup(-1, -1) == "long unwinding"
    assert fz.buildup(None, 1) == "missing" and fz.buildup(0, 5) == "unchanged"


# ---------------------------------------------------------------- engines
def fut_series(p0: float, p1: float, oi0: float, oi1: float) -> dict[str, Any]:
    t0, t1 = NOW - timedelta(minutes=16), NOW
    return {"times": [t0.isoformat(), t1.isoformat()], "future": [p0, p1], "oi": [oi0, oi1], "latest": {"future": p1, "basis": 12.0, "basis_pct": 0.05}}


ST_OK: dict[str, Any] = {k: {"ok": True, "age_s": 3.0} for k in ("futures", "market", "intraday", "skew", "momentum", "positioning", "gex", "vix", "flow")}


def gex_points(nets: list[float], spots: list[float], flip: float | None = 24000.0) -> dict[str, Any]:
    pts = [{"at": (NOW - timedelta(minutes=5 * (len(nets) - 1 - i))).isoformat(), "spot": s, "net": n, "abs": abs(n) * 2, "ce": 10, "pe": -5, "flip": flip, "call_wall": 24200, "put_wall": 23800, "peak": 24000, "near_net": 1} for i, (n, s) in enumerate(zip(nets, spots, strict=True))]
    return {"points": pts, "session": "2026-11-09", "universe": "dynamic"}


def test_positioning_group_holds_options_oi_smart_oi_futures_oi_and_gex_each_input_once() -> None:
    inp = {"futures": fut_series(24000, 24048, 1_000_000, 1_050_000),  # +0.2 % on rising OI: long buildup (60)
           "intraday": {"options": {"pcr_oi": 1.1, "pcr_oi_change": 0.1, "ce_oi": 100.0, "pe_oi": 110.0, "ce_oi_chg": 5.0, "pe_oi_chg": 12.0}},
           "gex": gex_points([50, 50, 50, 50], [24090, 24090, 24090, 24090])}
    e = fz.positioning_engine(inp, ST_OK)
    t = {x["name"]: x for x in e["terms"]}
    oi = 100 * math.tanh((12 - 5) / 210 / 0.05)  # puts minus calls over total OI, scale 0.05
    assert t["OI added: puts minus calls"]["score"] == pytest.approx(oi, abs=0.1)
    assert not any("PCR" in n.split(":")[0] for n in t)  # the PCR change is the same OI: shown inside the OI term's detail, not scored twice
    assert t["Smart OI: strike demand labels (15 min)"]["score"] is None  # no positioning comparison: left out, not scored neutral
    assert e["buildup"] == "long buildup" and t["Futures price and open interest (15 min)"]["score"] == 60.0
    dist = (24090 - 24000) / 24090 * 100
    flip = 100 * math.tanh(dist / 1.0)
    walls = (110 - 290) / (110 + 290) * 60
    assert t["Spot versus the gamma flip (modelled)"]["score"] == pytest.approx(flip, abs=0.1) and t["Room to the GEX walls (modelled)"]["score"] == pytest.approx(walls, abs=0.1)
    # families: options OI weight 1, futures OI 0.5 (shares price with group D), GEX 0.5 (two terms of 0.5, shares price)
    gex_family = (flip + walls) / 2
    assert e["score"] == pytest.approx((oi * 1.0 + 60 * 0.5 + gex_family * 0.5) / 2.0, abs=0.2)
    assert all(x["weight"] < 1 and x["shares"] == ["price"] for n, x in t.items() if n.startswith(("Futures price", "Spot versus", "Room to")))
    assert e["status"] == "PARTIAL" and e["terms_available"] == 4 and e["terms_total"] == 5


def test_two_terms_built_from_the_same_data_are_averaged_not_added() -> None:
    """The same value in a second term of one family must not move the group score: that is what double counting would do."""
    flow = {"market": {"flow": {"futures": {"cvd_pct": 25.0, "classified_share": 0.9, "stale": False, "depth_imbalance": 0.0}}}}
    one = fz.orderflow_engine(flow, ST_OK)
    two = fz.orderflow_engine({**flow, "rolling": {"windows": {"15": {"status": "ok", "cvd_pct": 25.0}}}}, ST_OK)
    assert two["terms_available"] == one["terms_available"] + 1
    assert two["score"] == one["score"]  # session and rolling CVD are one family
    opposite = fz.orderflow_engine({**flow, "rolling": {"windows": {"15": {"status": "ok", "cvd_pct": -25.0}}}}, ST_OK)
    assert opposite["score"] == pytest.approx((0.0 + 0.0) / 2, abs=0.1)  # session +76.2 and rolling -76.2 average to zero; the depth family is 0


def test_orderflow_group_labels_every_cvd_as_a_proxy_and_scores_it_by_tanh() -> None:
    inp = {"market": {"flow": {"futures": {"cvd_pct": 25.0, "classified_share": 0.9, "stale": False, "depth_imbalance": 0.0}}}}
    e = fz.orderflow_engine(inp, ST_OK)
    t = {x["name"]: x for x in e["terms"]}
    assert t["Futures CVD (Proxy), session"]["score"] == pytest.approx(100 * math.tanh(1.0), abs=0.1) and t["Futures CVD (Proxy), session"]["proxy"] is True
    assert t["Order-book depth imbalance (Proxy)"]["score"] == 0.0
    assert all(x["proxy"] and "(Proxy)" in x["name"] for x in e["terms"])
    assert "estimate" in t["Futures CVD (Proxy), session"]["detail"] and "not observed" in t["Futures CVD (Proxy), session"]["detail"]
    assert e["score"] == pytest.approx((76.159 + 0) / 2, abs=0.2)  # two families: futures CVD, depth


def test_a_stale_or_thin_cvd_is_left_out_not_used() -> None:
    for flow in ({"cvd_pct": 40.0, "stale": True}, {"cvd_pct": 40.0, "classified_share": 0.2, "stale": False}):
        e = fz.orderflow_engine({"market": {"flow": {"futures": flow}}}, ST_OK)
        assert next(t for t in e["terms"] if t["name"].startswith("Futures CVD"))["score"] is None


def test_heavyweight_cvd_is_normalised_per_stock_and_weighted_never_a_sum_of_raw_values() -> None:
    def stock(sym: str, w: float, cvd_pct: float, raw: float) -> dict[str, Any]:
        return {"symbol": sym, "weight": w, "change_pct": 0.3, "flow": {"cvd": raw, "cvd_pct": cvd_pct, "classified_share": 0.9, "stale": False, "age_seconds": 3.0}}

    for scale in (1, 1000):  # a stock trading a thousand times the volume has a thousand times the raw CVD: the result must not change
        inp = {"market": {"flow": {"heavy5": {"stocks": [stock("A", 10, 25, 1e5 * scale), stock("B", 5, -25, -1e5), stock("C", 5, 25, 1e5)]}}, "nifty50": {"stocks": [{"symbol": "A", "contribution": 0.03}, {"symbol": "B", "contribution": -0.01}]}, "index_change_pct": 0.2}}
        e = fz.orderflow_engine(inp, ST_OK)
        assert e["metrics"]["weighted_cvd_score"] == pytest.approx(100 * (10 * math.tanh(1) - 5 * math.tanh(1) + 5 * math.tanh(1)) / 20, abs=0.1)
    assert e["metrics"]["positive_cvd"] == 2 and e["metrics"]["negative_cvd"] == 1
    assert next(t for t in e["terms"] if t["name"] == "Heavyweight CVD (Proxy), session")["proxy"] is True
    p = fz.participation_engine(inp, ST_OK)  # participation reads prices only: no CVD
    assert p["metrics"]["aggregate_points_pct"] == pytest.approx(0.02)
    t = {x["name"]: x for x in p["terms"]}
    assert t["Index points from the heavyweights"]["score"] == pytest.approx(100 * math.tanh(0.02 / 0.15), abs=0.1)
    assert t["Heavyweights advancing versus declining (by weight)"]["score"] == 100.0  # all three stocks +0.3 %: all 20 of the weight advancing
    assert not any("CVD" in x["name"] for x in p["terms"])


def test_heavyweight_aggregate_is_unavailable_with_fewer_than_three_valid_stocks() -> None:
    two = [{"symbol": s_, "weight": 10, "change_pct": 0.1, "flow": {"cvd_pct": 30.0, "classified_share": 0.9, "stale": False, "age_seconds": 3.0}} for s_ in ("A", "B")]
    e = fz.orderflow_engine({"market": {"flow": {"heavy5": {"stocks": two}}}}, ST_OK)
    assert e["metrics"]["weighted_cvd_score"] is None  # a two-stock figure is never offered as the five-stock aggregate
    term = next(t for t in e["terms"] if t["name"] == "Heavyweight CVD (Proxy), session")
    assert term["available"] is False and "unavailable" in term["detail"]


def test_heavyweight_divergence_when_the_index_rises_against_selling() -> None:
    heavy = {"available": True, "aggregate": {"15": {"score": -60.0, "valid": 5}, "session": {"score": -50.0, "valid": 5}, "momentum": -5.0}, "participation": {"class": "Heavyweight divergence", "positive": 0, "negative": 4, "valid": 5, "weight_share_positive": 0.0, "weight_share_negative": 0.8},
             "stocks": [{"symbol": "A", "valid": True}], "signals": []}
    e = fz.orderflow_engine({"heavy": heavy}, ST_OK)
    assert e["metrics"]["divergence"] == "index and heavyweight flow disagree"
    part = next(t for t in e["terms"] if t["name"] == "Heavyweight CVD participation (Proxy)")
    assert part["score"] == pytest.approx(-80.0)


def test_gex_state_reads_the_flip_distance_and_the_price_relationship() -> None:
    # spot 24100 vs flip 24000: +0.415 % above; over 15 minutes spot +0.5 % and net GEX 100 -> 40 (-60 %): potentially amplifying
    st = fz.gex_state({"gex": gex_points([100, 80, 60, 40], [23980, 24020, 24060, 24100])})
    assert st["flip_distance_pct"] == pytest.approx((24100 - 24000) / 24100 * 100, abs=1e-6) and st["regime"] == "positive"
    assert st["relationship"] == "amplifying" and st["net_change_15m"] == -60 and st["net_change_pct"] == pytest.approx(-60.0)
    near = fz.gex_state({"gex": gex_points([10, 10, 10, 10], [24000, 24001, 24002, 24003])})
    assert near["regime"] == "near flip"  # within 0.2 % of the flip
    assert fz.gex_state({"gex": {"points": []}}) == {"available": False}
    terms, state = fz._gex_terms({"gex": {"points": []}})
    assert state == {"available": False} and all(t.score is None for t in terms)


def test_gex_methodology_is_documented_as_modelled_exposure() -> None:
    m = fz.GEX_METHOD
    for needle in ("gamma", "open interest in UNITS", "no lot-size", "spot^2", "call exposure counts +", "put exposure -", "ASSUMED, not observed", "ONE expiry", "bisection", "not observed dealer positioning"):
        assert needle in m, needle


def test_volatility_group_does_not_read_rising_iv_in_an_advance_as_directional() -> None:
    def table(ce: float, pe: float, spot: float, d25: float) -> dict[str, Any]:
        return {"momentum": {"table": {"periods": {"15": {"atm": {"ce_change": ce, "pe_change": pe}, "spot_change_pct": spot, "d25": {"momentum": d25}}}}}, "skew": {"cards": {}}}

    up = fz.volatility_engine(table(0.5, 0.5, 0.3, 0.0), ST_OK)
    assert next(t for t in up["terms"] if t["name"].startswith("ATM IV change"))["score"] == 0.0  # IV +0.5 with spot +0.3 %: not directional
    fall = fz.volatility_engine(table(0.5, 0.5, -0.3, 0.4), ST_OK)
    assert next(t for t in fall["terms"] if t["name"].startswith("ATM IV change"))["score"] == pytest.approx(-100 * math.tanh(0.5 / 0.5) * 0.6, abs=0.1)
    assert next(t for t in fall["terms"] if t["name"].startswith("Call versus put"))["score"] == pytest.approx(100 * math.tanh(1.0), abs=0.1)
    assert fz.volatility_engine({"momentum": None}, ST_OK)["score"] is None  # IV rank and percentile alone never create a score


def test_india_vix_is_context_only_and_never_moves_the_volatility_score() -> None:
    base = {"momentum": {"table": {"periods": {"15": {"atm": {"ce_change": 0.5, "pe_change": 0.5}, "spot_change_pct": -0.3, "d25": {"momentum": 0.4}}}}}, "skew": {"cards": {}}}
    plain = fz.volatility_engine(base, ST_OK)
    with_vix = fz.volatility_engine({**base, "vix": {"iv": [10.0, 40.0], "dates": ["2026-11-06", "2026-11-09"], "hv": [10.0, 11.0]}}, ST_OK)
    assert plain["score"] == with_vix["score"] and not any("VIX" in t["name"] or "rank" in t["name"].lower() for t in with_vix["terms"])
    assert "India VIX (last daily close)" in with_vix["context_not_scored"][0]


def test_structure_group_never_reuses_the_command_centre_score() -> None:
    """The aggregate command-centre score is built from price, VWAP, breadth, PCR and OI: using it as evidence double counted all of them."""
    def inp(score: float) -> dict[str, Any]:
        return {"intraday": {"price": {"last": 24100.0, "position_in_range": 0.7}, "vwap": {"distance_atr": 1.0, "distance_pct": 0.2, "side": "above"}, "daily": {"prev_high": 24200, "prev_low": 24000}, "assessment": {"score": score, "label": "x"}}}

    bull, bear = fz.structure_engine(inp(1.0), ST_OK), fz.structure_engine(inp(-1.0), ST_OK)
    assert bull["score"] == bear["score"] and not any("command" in t["name"].lower() for t in bull["terms"])
    t = {x["name"]: x for x in bull["terms"]}
    assert t["Position against the previous day's range"]["score"] == pytest.approx((0.5 - 0.5) * 120 + 0.0, abs=0.1)  # 24100 is the middle of 24000 to 24200
    assert {x["family"] for x in bull["terms"]} == {"price", "levels"}  # VWAP and day range are one family of price evidence
    # price family = mean(tanh(1) x 100, (0.7 - 0.5) x 120) ; levels family = 0 ; equal family weights
    assert bull["score"] == pytest.approx(((76.159 + 24.0) / 2 + 0.0) / 2, abs=0.2)


def test_breadth_belongs_to_participation_only_and_is_one_family() -> None:
    inp = {"market": {"nifty50": {"breadth": {"ad_balance": 0.4, "advancing": 35, "declining": 10, "covered": 50}}, "participation": {"above_vwap": {"pct_above": 70}, "opening_range": {"pct_above_high": 30, "pct_below_low": 10}}}}
    e = fz.participation_engine(inp, ST_OK)
    breadth = [t for t in e["terms"] if t["family"] == "breadth"]
    assert len(breadth) == 3 and [t["score"] for t in breadth] == [40.0, 40.0, 20.0]
    assert e["score"] == pytest.approx((40 + 40 + 20) / 3, abs=0.1)  # one family; the heavyweight family has no data and is left out
    assert not any(t["name"] in ("Advance/decline balance", "Stocks above their day VWAP") for t in fz.structure_engine({"intraday": {}}, ST_OK)["terms"])


def test_every_overlap_is_documented_and_every_shared_input_carries_an_adjustment() -> None:
    inp = {"futures": fut_series(24000, 24048, 1_000_000, 1_050_000), "intraday": {"options": {}}, "market": {}, "gex": gex_points([50] * 4, [24090] * 4)}
    es = fz.build_engines(inp, ST_OK)
    audit = fz.overlap_audit(es)
    assert any("command-centre score" in f["input"].lower() for f in audit["findings"]) and any("India VIX" in f["input"] for f in audit["findings"])
    assert all(t["weight"] < 1 for t in audit["terms"] if t["shares"])
    assert {t["group"] for t in audit["terms"]} == set(fz.DEFAULT_WEIGHTS)
    names = [t["term"] for t in audit["terms"]]
    assert len(names) == len(set(names))  # no term is listed in two groups


# ---------------------------------------------------------------- regime, divergences, scenarios
def fused(score: float | None, agree: float = 0.8, conf: float = 70) -> dict[str, Any]:
    return {"score": score, "agreement": agree, "confidence": conf, "class": fz.classify(score), "coverage": 0.9, "reason": None if score is not None else "no data"}


def test_regime_uses_several_indicators_and_names_what_it_used() -> None:
    cvd = lambda v: {"terms": [{"name": "Futures CVD (Proxy), session", "available": True, "score": v}]}  # noqa: E731
    by = {"positioning": {"buildup": "short covering", "price_change_15m_pct": 0.3, "terms": []}, "orderflow": cvd(40.0), "volatility": {"atm_iv_change_15m": -0.4, "terms": []}}
    assert fz.regime(fused(40), by, {}, {"regime": "positive"})["name"] == "Short squeeze"
    by2 = {"positioning": {"buildup": "long unwinding", "price_change_15m_pct": -0.3, "terms": []}, "orderflow": cvd(-40.0), "volatility": {"terms": []}}
    assert fz.regime(fused(-40), by2, {}, {"regime": "positive"})["name"] == "Long liquidation"
    plain = {"positioning": {"buildup": "long buildup", "price_change_15m_pct": 0.3, "terms": []}, "volatility": {"atm_iv_change_15m": 0.1, "terms": []}}
    assert fz.regime(fused(75, 0.8), plain, {}, {})["name"] == "Strong bullish trend"
    assert fz.regime(fused(50, 0.6), plain, {}, {})["name"] == "Bullish trend"
    assert fz.regime(fused(-20, 0.6), plain, {}, {})["name"] == "Weak bearish"
    assert fz.regime(fused(50, 0.3), plain, {}, {})["name"] == "Uncertain / Conflicting signals"  # strong score but the groups disagree
    assert fz.regime(fused(5), plain, {}, {"regime": "positive"})["name"] == "Sideways / Range"
    assert fz.regime(fused(5), {"volatility": {"atm_iv_change_15m": -0.5, "terms": []}, "positioning": {}}, {}, {"regime": "positive"})["name"] == "Compression"
    assert fz.regime(fused(None), plain, {}, {})["name"] == "Uncertain / Conflicting signals"


def test_divergences_are_descriptions_with_invalidation_and_the_unavailable_checks_are_listed() -> None:
    by = {"positioning": {"score": 40, "buildup": "short covering", "price_change_15m_pct": 0.3, "terms": []},
          "orderflow": {"score": -30, "terms": [{"name": "Futures CVD (Proxy), session", "available": True, "score": -40.0, "detail": "session CVD -20.0% of classified volume"}], "metrics": {}},
          "volatility": {"spot_change_15m_pct": 0.3, "atm_iv_change_15m": 0.0, "terms": [{"name": "Call versus put IV momentum (25Δ, 15 min)", "available": True, "score": -60.0}]}}
    out, missing = fz.divergences({"intraday": {}}, by, {"available": False})
    ids = {d["id"] for d in out}
    assert {"price_cvd", "price_oi", "price_skew", "fut_opt"} <= ids
    assert all(d["invalidation"] and d["explanation"] and d["severity"] in ("low", "medium", "high") for d in out)
    assert next(d for d in out if d["id"] == "price_cvd")["direction"] == "bearish"  # price up on net selling pressure
    assert len(missing) == 1 and "OI migration" in missing[0]


def test_scenarios_are_heuristic_scores_summing_to_100_with_levels_and_horizon_moves() -> None:
    inp = {"intraday": {"options": {"max_ce_oi_strike": 24300, "max_pe_oi_strike": 23700}, "vwap": {"vwap": 24050}, "volatility": {"atm_iv": 15.0}, "daily": {"prev_high": 24400, "prev_low": 23600}, "market": {"phase": "live"}}, "market": {"elapsed_minutes": 60}}
    gx = {"available": True, "call_wall": 24200, "put_wall": 23800, "regime": "positive"}
    s = fz.scenarios(fused(40, 0.8, 70), [eng("positioning", 40)], gx, inp, 24100.0)
    assert s["bullish"]["score"] + s["bearish"]["score"] + s["sideways"]["score"] in (99, 100, 101)  # rounding
    assert "not probabilities" in s["label"]
    assert s["bullish"]["resistance"] == 24200 and s["bearish"]["support"] == 23800 and s["sideways"]["range"] == [23800, 24200]
    assert s["bullish"]["score"] > s["bearish"]["score"]
    h = {x["horizon"]: x for x in s["horizons"]}
    assert h["Next 15 minutes"]["one_sd_points"] == pytest.approx(24100 * 0.15 * math.sqrt(15 / (252 * 375)), abs=0.1)  # 45.5 points
    assert h["End of session"]["minutes"] == 315 and set(h) >= {"Next 30 minutes", "Next 60 minutes", "Next trading session"}
    assert fz.scenarios(fused(None), [], gx, inp, 24100.0)["available"] is False


def test_interpretation_is_generated_from_the_readings() -> None:
    es = [eng("positioning", 50), eng("orderflow", 30)]
    es[0]["supporting"] = ["Futures price and open interest (15 min): long buildup"]
    text = fz.interpretation(fused(40), es, {"name": "Bullish trend"}, [{"name": "Futures versus options"}], {"available": True, "flip": 24000.0, "flip_distance_pct": 0.4}, {"intraday": {"vwap": {"vwap": 24050}}})
    assert "bullish" in text and "long buildup" in text and "0.40% above the modelled gamma flip at 24000" in text and "not observed dealer positioning" in text and "futures versus options" in text and "VWAP near 24050" in text
    assert "INSUFFICIENT" in fz.interpretation({"score": None, "class": "INSUFFICIENT DATA – SENTIMENT UNRELIABLE", "reason": "x"}, [], {}, [], {}, {})


# ---------------------------------------------------------------- rolling CVD
def flow_samples(n: int, *, b_step: float = 600.0, s_step: float = 400.0, restart_at: int | None = None, skip: range | None = None) -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    k = 0
    for i in range(n):
        if restart_at is not None and i == restart_at:
            k = 0  # the backend restarted: cumulative counters begin again
        k += 1
        if skip is not None and i in skip:
            continue
        t = NOW - timedelta(minutes=n - 1 - i)
        out.append((t.isoformat(), {"v": 1000.0 * k, "b": b_step * k, "s": s_step * k, "cvd": (b_step - s_step) * k}))
    return out


def test_rolling_cvd_is_the_difference_of_stored_cumulative_flow() -> None:
    r = rolling.futures(flow_samples(40))
    for n in ("5", "15", "30"):
        w = r["windows"][n]
        # per minute: buy 600, sell 400, CVD +200 of 1000 classified = +20 %
        assert w["status"] == "ok" and w["cvd"] == 200.0 * int(n) and w["cvd_pct"] == 20.0 and w["classified"] == 1000.0 * int(n)
    assert r["ok_windows"] == 3 and r["estimated"] is True
    a = r["acceleration"]  # steady buying: two equal consecutive windows, identical rates, no acceleration
    assert a["status"] == "ok" and a["current_cvd"] == a["previous_cvd"] == 1000.0 and a["current_rate"] == a["previous_rate"] == 200.0 and a["rate_change"] == 0.0 and a["acceleration"] == 0.0


def test_cvd_acceleration_compares_two_consecutive_equal_five_minute_windows() -> None:
    samples = flow_samples(40)
    # buying strengthens over the last 5 minutes only: +100 CVD per minute on top of the steady +200 for minutes 35..39
    boosted = []
    for i, (t, p) in enumerate(samples):
        extra = 100.0 * max(0, i - 34)
        boosted.append((t, {**p, "cvd": p["cvd"] + extra, "b": p["b"] + extra, "v": p["v"] + extra}))
    a = rolling.acceleration(boosted, 5)
    assert a["status"] == "ok"
    assert a["current_cvd"] == 1500.0 and a["previous_cvd"] == 1000.0  # current 5 min = 5 x 200 + 5 x 100; the 5 minutes before it unchanged
    assert a["current_rate"] == 300.0 and a["previous_rate"] == 200.0 and a["rate_change"] == 100.0
    assert a["acceleration"] == pytest.approx(100.0 / 5)  # change in rate per minute over the 5-minute spacing
    assert a["window_minutes"] == [5.0, 5.0]
    # the 15 and 30 minute windows are separate context: they do not enter the acceleration
    r = rolling.futures(boosted)
    assert r["windows"]["15"]["cvd"] != a["current_cvd"] * 3 and "momentum_per_min" not in r


def test_cvd_acceleration_needs_three_stored_points_and_continuous_flow() -> None:
    assert rolling.acceleration(flow_samples(8), 5)["status"].startswith("unavailable: fewer than 10 minutes")
    assert rolling.acceleration([], 5)["status"].startswith("unavailable: no flow samples")
    assert rolling.acceleration(flow_samples(40, restart_at=33), 5)["status"].startswith("unavailable: the backend restarted")
    gap = rolling.acceleration(flow_samples(40, skip=range(24, 33)), 5)
    assert gap["status"].startswith("unavailable: no stored sample within") and gap["acceleration"] is None


def test_rolling_cvd_is_unavailable_with_a_reason_never_estimated() -> None:
    few = rolling.futures(flow_samples(10))
    assert few["windows"]["5"]["status"] == "ok" and few["windows"]["15"]["status"].startswith("unavailable: fewer than 15 minutes") and few["windows"]["15"]["cvd"] is None
    assert few["ok_windows"] == 1
    assert rolling.futures([])["windows"]["5"]["status"] == "unavailable: no flow samples stored today"
    restarted = rolling.futures(flow_samples(40, restart_at=30))
    assert restarted["windows"]["15"]["status"].startswith("unavailable: the backend restarted") and restarted["windows"]["5"]["status"] == "ok"
    gap = rolling.futures(flow_samples(40, skip=range(14, 28)))  # no samples around 15 and 30 minutes back
    assert gap["windows"]["15"]["status"].startswith("unavailable: no stored sample within") and gap["windows"]["15"]["cvd"] is None
    unclassified = [(t, {"v": 1.0, "b": None, "s": None, "cvd": None}) for t, _ in flow_samples(40)]
    assert rolling.futures(unclassified)["windows"]["5"]["status"].startswith("unavailable: the flow tracker had no classified volume")


def test_rolling_heavyweight_cvd_is_per_stock_and_flags_restarts() -> None:
    def rows(k: int) -> dict[str, Any]:
        return {"rows": [["A", 200.0 * k, 600.0 * k, 400.0 * k, 1000.0 * k, 0.0], ["B", -100.0 * k, 400.0 * k, 600.0 * k, 1000.0 * k, 0.0]]}

    samples = [((NOW - timedelta(minutes=29 - i)).isoformat(), rows(i + 1)) for i in range(30)]
    h = rolling.heavy(samples, 15)
    assert h["A"] == {"cvd_pct": 20.0, "status": "ok"} and h["B"] == {"cvd_pct": -10.0, "status": "ok"} and h["_status"]["status"] == "ok"
    assert rolling.heavy(samples[:5], 15)["_status"]["status"].startswith("unavailable")


# ---------------------------------------------------------------- service
class Rig:
    def __init__(self, tmp: Path, fail: set[str] | None = None) -> None:
        self.calls: dict[str, int] = {}
        self.fail = fail or set()
        self.clock = NOW
        self.store = IntelligenceStore(tmp)

        def p(name: str, data: Any) -> Any:
            def fn(*_: Any) -> Any:
                self.calls[name] = self.calls.get(name, 0) + 1
                if name in self.fail:
                    raise RuntimeError("module down")
                return data() if callable(data) else data

            return fn

        flow = {"futures": {"cvd_pct": 25.0, "classified_share": 0.9, "stale": False, "age_seconds": 2.0, "depth_imbalance": 0.1}, "heavy5": {"stocks": []}}
        self.providers = {
            "market": p("market", {"flow": flow, "nifty50": {"breadth": {"ad_balance": 0.4, "advancing": 35, "declining": 10, "covered": 50}, "stocks": []}, "participation": {"above_vwap": {"pct_above": 70}}, "index_change_pct": 0.3, "elapsed_minutes": 45}),
            "intraday": p("intraday", {"market": {"age_seconds": 20, "mode": "live", "phase": "live"}, "price": {"last": 24100.0, "change_pct": 0.3, "position_in_range": 0.8, "er_30": 0.4}, "options": {"pcr_oi": 1.1, "pcr_oi_change": 0.1, "ce_oi": 100.0, "pe_oi": 110.0, "ce_oi_chg": 5.0, "pe_oi_chg": 12.0, "atm_strike": 24100, "max_ce_oi_strike": 24300, "max_pe_oi_strike": 23900},
                                      "vwap": {"vwap": 24050, "side": "above", "distance_pct": 0.2, "distance_atr": 1.0, "slope_pts_per_15m": 4.0}, "assessment": {"score": 0.3, "label": "Moderately bullish", "volatility": "Normal"}, "volatility": {"atm_iv": 15.0, "rows": []}, "daily": {}}),
            "futures": p("futures", lambda: fut_series(24000, 24048, 1_000_000, 1_050_000) | {"times": [(self.clock - timedelta(minutes=16)).isoformat(), self.clock.isoformat()]}),
            "skew": p("skew", {"age_seconds": 30, "cards": {"skew_25d": 2.0}, "term": [], "term_structure": {}}),
            "momentum": p("momentum", {"age_seconds": 30, "table": {"periods": {"15": {"atm": {"ce_change": 0.1, "pe_change": 0.1}, "spot_change_pct": 0.3, "d25": {"momentum": 0.2}}}}}),
            "positioning": p("positioning", {"age_seconds": 30, "demand": [], "rows": []}),
            "gex": p("gex", lambda: gex_points([100, 90, 80, 70], [24020, 24050, 24080, 24100])), "vix": p("vix", {"iv": [14.0, 15.0], "dates": ["2026-11-06", "2026-11-09"], "hv": [10.0, 11.0], "rv": [9.0, 10.0]}),
            "flow": p("flow", lambda: {"fut": flow_samples(40), "heavy5": []}), "ml": p("ml", {"status": {"labelled_sessions": 3, "stage_name": "Collecting labelled data", "status": "collecting"}, "last_evaluation": None}), "heavymeta": p("heavymeta", {"weights": {"as_of": "2026-09-30", "source": "NSE index tracker", "age_days": 40, "stale": False}, "stocks": []}),
        }
        self.svc = MarketIntelligence(providers=self.providers, store=self.store, default_expiry=lambda: "2026-11-10", clock=lambda: self.clock)


def test_summary_fuses_the_groups_and_reports_each_input_status(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    s = r.svc.summary()
    assert s["sentiment"]["score"] is not None and s["sentiment"]["class"] in ("Bullish", "Mild Bullish", "Strong Bullish")
    assert {e["key"] for e in s["engines"]} == set(fz.DEFAULT_WEIGHTS) and set(s["status"]) == set(r.providers) and all(v["ok"] for v in s["status"].values())
    vix = s["pulse"]["india_vix"]
    assert vix["label"] == "India VIX – Last Daily Close" and vix["as_of"] == "2026-11-09" and vix["value"] == 15.0 and vix["intraday_signal"] is False and "not a live quote" in vix["note"]
    assert s["pulse"]["spot"] == 24100.0 and s["pulse"]["futures"] == 24048
    c = s["sentiment"]["engine_counts"]
    assert c["partial"] >= 1 and c["unavailable"] == 0 and sum(c.values()) == 5  # Smart OI and heavyweight terms are missing: PARTIAL, not UNAVAILABLE
    assert s["sentiment"]["coverage"] < 1.0  # a partial group counts for the share of its evidence that exists, not as a neutral score
    assert s["panels"]["volatility"]["hv"] == 11.0 and s["scenarios"]["available"] is True and "not probabilities" in s["scenarios"]["label"]
    assert s["panels"]["volatility"]["india_vix_label"] == "India VIX – Last Daily Close" and s["panels"]["volatility"]["india_vix_as_of"] == "2026-11-09"
    assert s["config"]["note"] == "Provisional weights – not yet statistically calibrated." and s["sentiment"]["weights_note"] == s["config"]["note"]
    assert "ASSUMED, not observed" in s["panels"]["gex"]["methodology"] and "Modelled" in s["panels"]["gex"]["label"]
    assert {"findings", "terms"} <= set(s["overlap_audit"])
    sent = s["sentiment"]
    assert {"score", "confidence", "coverage", "agreement", "freshness", "engine_counts"} <= set(sent)  # kept as separate quantities


def test_rolling_windows_and_per_source_timestamps_reach_the_summary(tmp_path: Path) -> None:
    s = Rig(tmp_path).svc.summary()
    roll = s["panels"]["futures"]["rolling"]["windows"]
    assert [roll[k]["cvd_pct"] for k in ("5", "15", "30")] == [20.0, 20.0, 20.0]
    caps = {c["id"]: c for c in s["capabilities"]}
    assert caps["rolling_cvd"]["status"] == "AVAILABLE" and caps["rollover"]["status"] == "UNAVAILABLE" and caps["stock_futures"]["status"] == "UNAVAILABLE" and caps["option_aggressor"]["status"] == "UNAVAILABLE"
    assert caps["vega"]["status"] == "PARTIAL" or caps["vega"]["status"] == "UNAVAILABLE"
    assert caps["smart_oi"]["status"] in ("PARTIAL", "UNAVAILABLE")  # the rig has no comparison snapshot
    assert s["status"]["flow"]["as_of"] == flow_samples(40)[-1][0] and s["status"]["vix"]["as_of"] == "2026-11-09" and s["status"]["gex"]["as_of"]
    by = {e["key"]: e for e in s["engines"]}
    assert by["orderflow"]["freshness"]["as_of"]["flow"] == s["status"]["flow"]["as_of"]


def test_one_failing_module_makes_only_its_evidence_unavailable(tmp_path: Path) -> None:
    r = Rig(tmp_path, fail={"gex", "skew"})
    s = r.svc.summary()
    assert s["status"]["gex"]["ok"] is False and "module down" in s["status"]["gex"]["error"]
    by = {e["key"]: e for e in s["engines"]}
    gex_terms = [t for t in by["positioning"]["terms"] if "gamma" in t["name"] or "GEX" in t["name"]]
    assert gex_terms and all(t["available"] is False for t in gex_terms) and by["positioning"]["status"] == "PARTIAL"
    assert by["positioning"]["score"] is not None and s["sentiment"]["score"] is not None  # the rest still reports


def test_a_websocket_interruption_turns_the_live_groups_stale_without_blocking_the_dashboard(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    flow_old = {"futures": {"cvd_pct": 25.0, "classified_share": 0.9, "stale": True, "age_seconds": 600.0, "depth_imbalance": 0.1}, "heavy5": {"stocks": []}}
    r.providers["market"] = lambda *_: {"flow": flow_old, "nifty50": {"breadth": {"ad_balance": 0.4, "advancing": 35, "declining": 10, "covered": 50}, "stocks": []}, "participation": {"above_vwap": {"pct_above": 70}, "opening_range": {"pct_above_high": 30, "pct_below_low": 10}}, "index_change_pct": 0.3, "elapsed_minutes": 45}
    r.svc.providers = r.providers
    s = r.svc.summary()
    by = {e["key"]: e for e in s["engines"]}
    assert by["orderflow"]["freshness"]["fresh"] is False  # the feed's own age (600 s) is past the live limit
    cvd = next(t for t in by["orderflow"]["terms"] if t["name"] == "Futures CVD (Proxy), session")
    assert cvd["available"] is False  # a stale CVD is left out, not used
    assert s["sentiment"]["freshness"] < 1.0 and s["sentiment"]["score"] is not None  # confidence is lowered; the page still renders


def test_inputs_are_cached_and_the_summary_is_reused_for_five_seconds(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    r.svc.summary()
    first = dict(r.calls)
    r.svc.summary()
    assert r.calls == first  # nothing asked again inside the cache windows
    assert max(first.values()) == 1


def test_timeline_records_one_row_per_minute_and_never_back_fills(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    assert r.svc.record(NOW) is True
    assert r.svc.record(NOW + timedelta(seconds=20)) is False  # same minute: the stored row is never rewritten
    tl = r.svc.timeline("2026-11-09")
    assert tl["recorded"] == 1 and tl["points"][0]["score"] is not None and set(tl["points"][0]["engines"]) == set(fz.DEFAULT_WEIGHTS) and "not reconstructed" in tl["note"]
    off = Rig(tmp_path / "off")
    off.providers["intraday"] = lambda *_: {"market": {"mode": "closed", "age_seconds": 0}, "price": {}}
    off.svc.providers = off.providers
    assert off.svc.record(NOW) is False  # nothing is recorded outside the live session


def test_alerts_are_raised_from_changes_and_deduplicated_inside_the_cooldown(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    r.svc.record(NOW)
    # the second minute: VWAP lost, and the regime moves with it
    r.providers["intraday"] = lambda *_: {"market": {"age_seconds": 20, "mode": "live", "phase": "live"}, "price": {"last": 24000.0, "change_pct": -0.1, "position_in_range": 0.2, "er_30": 0.4}, "options": {"pcr_oi": 1.1, "atm_strike": 24000},
                                          "vwap": {"vwap": 24050, "side": "below", "distance_pct": -0.2, "distance_atr": -1.0, "slope_pts_per_15m": -4.0}, "assessment": {"score": -0.3, "volatility": "Normal"}, "volatility": {"atm_iv": 15.0, "rows": []}}
    r.svc.providers = r.providers
    r.svc._cache.clear()
    r.svc._summary_cache = None
    r.clock = NOW + timedelta(minutes=1)
    assert r.svc.record(r.clock) is True
    kinds = [a["kind"] for a in r.store.alerts("2026-11-09")]
    assert "VWAP breakdown" in kinds
    # two minutes later the same loss cannot be raised again while the cooldown runs: a fresh VWAP side change would be needed anyway, and a manual duplicate is refused
    n = len(r.store.alerts("2026-11-09"))
    r.svc._alerts(r.svc.summary(), {"score": 20, "regime": "x", "metrics": {"vwap_side": "above"}, "engines": {}, "divs": []}, {"score": 20, "regime": "x", "spot": 24000, "metrics": {"vwap_side": "below"}, "engines": {}, "divs": []}, r.clock + timedelta(minutes=2))
    assert len(r.store.alerts("2026-11-09")) == n  # inside the 10-minute cooldown
    r.svc._alerts(r.svc.summary(), {"score": 20, "regime": "x", "metrics": {"vwap_side": "above"}, "engines": {}, "divs": []}, {"score": 20, "regime": "x", "spot": 24000, "metrics": {"vwap_side": "below"}, "engines": {}, "divs": []}, r.clock + timedelta(minutes=12))
    assert len(r.store.alerts("2026-11-09")) == n + 1  # after the cooldown it can be raised again
    a = next(a for a in r.store.alerts("2026-11-09") if a["kind"] == "VWAP breakdown")
    assert a["severity"] and a["direction"] == "bearish" and a["confirmation"] and a["invalidation"]


def test_divergence_status_follows_how_long_it_has_persisted() -> None:
    d = {"id": "price_cvd", "reading": "r", "direction": "bearish", "severity": "medium"}
    row = lambda i, with_d: {"at": f"t{i}", "divs": [d] if with_d else [], "regime": "x"}  # noqa: E731
    assert MarketIntelligence._div_status("price_cvd", [])[0] == "early warning"
    assert MarketIntelligence._div_status("price_cvd", [row(i, True) for i in range(1)])[0] == "early warning"
    assert MarketIntelligence._div_status("price_cvd", [row(i, True) for i in range(4)])[0] == "developing"
    assert MarketIntelligence._div_status("price_cvd", [row(i, True) for i in range(10)])[0] == "confirmed"
    assert MarketIntelligence._div_status("price_cvd", [row(0, True), row(1, False), row(2, True)])[0] == "early warning"  # a gap breaks the run


def test_iv_rank_and_percentile_follow_the_documented_rule() -> None:
    vals: list[float | None] = [10.0, 12.0, 14.0, 16.0, 18.0, 20.0, 15.0]
    r = rank_percentile(vals, 7)  # window of 7: low 10, high 20, now 15: rank 50; below 15: 10, 12, 14 -> 3 of 7
    assert r["ivr"] == 50.0 and r["ivp"] == pytest.approx(3 / 7 * 100, abs=0.1)
    assert rank_percentile(vals, 8)["ivr"] is None  # fewer days than the window: no figure
    assert rank_percentile([None, None, 15.0, None, None, None, None], 7)["ivr"] is None  # under 80 % of the window has a value


# ---------------------------------------------------------------- API
def test_the_api_serves_a_partial_dashboard_when_the_underlying_modules_have_no_data(tmp_path: Path) -> None:
    from tests.unit.test_intraday import make_app
    from tests.unit.test_swing_api import LOCAL

    with TestClient(make_app(tmp_path), client=LOCAL) as c:
        r = c.get("/api/intelligence/summary")
        assert r.status_code == 200
        d = r.json()
        assert d["sentiment"]["class"].startswith("INSUFFICIENT DATA") and d["sentiment"]["score"] is None
        assert {"status", "engines", "pulse", "regime", "interpretation", "divergences", "scenarios", "panels", "alerts", "config", "capabilities", "overlap_audit"} <= set(d)
        assert len(d["engines"]) == 5 and d["config"]["weights"]["positioning"] == 30.0
        t = c.get("/api/intelligence/timeline")
        assert t.status_code == 200 and t.json()["recorded"] == 0
