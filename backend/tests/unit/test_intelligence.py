"""Market-intelligence fusion, regime, divergences, scenarios, service caching, timeline and alerts, on hand-calculated numbers."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.intelligence import fusion as fz
from app.intelligence.service import MarketIntelligence, parse_weights, rank_percentile
from app.intelligence.store import IntelligenceStore

NOW = datetime(2026, 11, 9, 4, 30, tzinfo=UTC)  # 10:00 IST


def eng(key: str, score: float | None, fresh: bool = True) -> dict[str, Any]:
    return {"key": key, "name": fz.ENGINE_NAMES[key], "score": score, "class": fz.classify(score), "tilt": fz.tilt(score), "terms": [], "supporting": [], "conflicting": [], "unavailable": [],
            "freshness": {"fresh": fresh if score is not None else None, "age_s": 5.0, "inputs": [], "failed": []}}


# ---------------------------------------------------------------- fusion
def test_overall_score_is_the_weighted_average_of_the_engines_that_have_a_score() -> None:
    es = [eng("futures", 40), eng("options", 20), eng("gex", -10), eng("heavyweight", None), eng("volatility", 0), eng("structure", 30)]
    f = fz.fuse(es, fz.DEFAULT_WEIGHTS)
    # (40x25 + 20x20 - 10x15 + 0x10 + 30x15) / (25 + 20 + 15 + 10 + 15) = 1700 / 85 = 20.0 : the missing engine is left out, not scored zero
    assert f["score"] == 20.0 and f["class"] == "Mild Bullish"
    assert f["coverage"] == pytest.approx(0.85)
    # agreement: futures, options, structure agree (weights 60); gex (15) and volatility (10) are within +-15 and count half: (60 + 7.5 + 5) / 85
    assert f["agreement"] == pytest.approx(72.5 / 85, abs=1e-3)
    assert f["freshness"] == 1.0
    assert f["confidence"] == pytest.approx(100 * min(1, 0.85 / 0.8) * (72.5 / 85), abs=0.1)  # = 85.3
    assert [e["contribution"] for e in es if e["key"] == "futures"] == [pytest.approx(40 * 25 / 85, abs=0.01)]
    assert es[3]["contribution"] is None


def test_too_little_data_says_so_instead_of_a_neutral_score() -> None:
    two = fz.fuse([eng("futures", 50), eng("options", 40)], {k: v for k, v in fz.DEFAULT_WEIGHTS.items()})
    assert two["score"] is None and two["class"].startswith("INSUFFICIENT DATA") and two["confidence"] is None
    lowcov = fz.fuse([eng("heavyweight", 30), eng("volatility", 30), eng("structure", 30), eng("futures", None), eng("options", None), eng("gex", None)], fz.DEFAULT_WEIGHTS)
    assert lowcov["score"] is None  # three engines but only 40 % of the weight: coverage below the minimum
    assert "coverage 40%" in lowcov["reason"]


def test_classes_and_thresholds() -> None:
    for s, c in ((80, "Strong Bullish"), (70, "Strong Bullish"), (50, "Bullish"), (35, "Bullish"), (20, "Mild Bullish"), (0, "Neutral"), (-14, "Neutral"), (-15, "Mild Bearish"), (-35, "Bearish"), (-70, "Strong Bearish")):
        assert fz.classify(s) == c, s
    assert fz.classify(None) == "Unavailable"


def test_weights_are_configurable_and_invalid_entries_are_ignored() -> None:
    w = parse_weights('{"futures": 40, "gex": -5, "options": "x", "bogus": 3}')
    assert w["futures"] == 40 and w["gex"] == fz.DEFAULT_WEIGHTS["gex"] and w["options"] == fz.DEFAULT_WEIGHTS["options"] and "bogus" not in w
    assert parse_weights("not json") == fz.DEFAULT_WEIGHTS and parse_weights("") == fz.DEFAULT_WEIGHTS
    es = [eng("futures", 40), eng("options", 20), eng("gex", -10), eng("structure", 30)]
    heavy = fz.fuse(es, {**fz.DEFAULT_WEIGHTS, "futures": 100})
    assert heavy["score"] == pytest.approx((40 * 100 + 20 * 20 - 10 * 15 + 30 * 15) / (100 + 20 + 15 + 15), abs=0.1)


def test_stale_engines_lower_the_confidence_but_not_the_score() -> None:
    fresh = fz.fuse([eng("futures", 40), eng("options", 40), eng("structure", 40)], fz.DEFAULT_WEIGHTS)
    stale = fz.fuse([eng("futures", 40, False), eng("options", 40), eng("structure", 40)], fz.DEFAULT_WEIGHTS)
    assert fresh["score"] == stale["score"] == 40.0
    assert stale["freshness"] == pytest.approx(35 / 60, abs=1e-3) and stale["confidence"] < fresh["confidence"]


def test_buildup_is_the_four_way_price_and_oi_rule() -> None:
    assert fz.buildup(1, 1) == "long buildup" and fz.buildup(-1, 1) == "short buildup"
    assert fz.buildup(1, -1) == "short covering" and fz.buildup(-1, -1) == "long unwinding"
    assert fz.buildup(None, 1) == "missing" and fz.buildup(0, 5) == "unchanged"


# ---------------------------------------------------------------- engines
def fut_series(p0: float, p1: float, oi0: float, oi1: float) -> dict[str, Any]:
    t0, t1 = NOW - timedelta(minutes=16), NOW
    return {"times": [t0.isoformat(), t1.isoformat()], "future": [p0, p1], "oi": [oi0, oi1], "latest": {"future": p1, "basis": 12.0, "basis_pct": 0.05}}


ST_OK: dict[str, Any] = {k: {"ok": True, "age_s": 3.0} for k in ("futures", "market", "intraday", "skew", "momentum", "positioning", "gex", "vix")}


def test_futures_engine_combines_buildup_estimated_cvd_vwap_and_depth() -> None:
    inp = {"futures": fut_series(24000, 24048, 1_000_000, 1_050_000),  # +0.2 % on rising OI: long buildup (60)
           "market": {"flow": {"futures": {"cvd_pct": 25.0, "classified_share": 0.9, "stale": False, "depth_imbalance": 0.0}}},
           "intraday": {"vwap": {"distance_atr": 1.0, "distance_pct": 0.2, "side": "above", "slope_pts_per_15m": 3.0, "vwap": 24010}}}
    e = fz.futures_engine(inp, ST_OK)
    t = {x["name"]: x for x in e["terms"]}
    assert e["buildup"] == "long buildup" and t["Price and open interest (15 min)"]["score"] == 60.0
    assert t["Futures CVD (estimated)"]["score"] == pytest.approx(100 * math.tanh(1.0), abs=0.1) and t["Futures CVD (estimated)"]["proxy"] is True
    assert t["Price versus VWAP"]["score"] == pytest.approx(100 * math.tanh(1.0), abs=0.1)
    assert t["Order-book depth imbalance"]["score"] == 0.0
    assert e["score"] == pytest.approx((60 + 76.159 + 76.159 + 0) / 4, abs=0.2)


def test_a_stale_or_thin_cvd_is_left_out_not_used() -> None:
    base = {"futures": fut_series(24000, 24048, 1_000_000, 1_050_000), "intraday": {}}
    for flow in ({"cvd_pct": 40.0, "stale": True}, {"cvd_pct": 40.0, "classified_share": 0.2, "stale": False}):
        e = fz.futures_engine({**base, "market": {"flow": {"futures": flow}}}, ST_OK)
        assert next(t for t in e["terms"] if t["name"].startswith("Futures CVD"))["score"] is None


def test_heavyweight_cvd_is_normalised_per_stock_and_weighted_never_a_sum_of_raw_values() -> None:
    def stock(sym: str, w: float, cvd_pct: float, raw: float) -> dict[str, Any]:
        return {"symbol": sym, "weight": w, "change_pct": 0.3, "flow": {"cvd": raw, "cvd_pct": cvd_pct, "classified_share": 0.9, "stale": False}}

    for scale in (1, 1000):  # a stock trading a thousand times the volume has a thousand times the raw CVD: the result must not change
        inp = {"market": {"flow": {"heavy5": {"stocks": [stock("A", 10, 25, 1e5 * scale), stock("B", 5, -25, -1e5)]}}, "nifty50": {"stocks": [{"symbol": "A", "contribution": 0.03}, {"symbol": "B", "contribution": -0.01}]}, "index_change_pct": 0.2}}
        e = fz.heavyweight_engine(inp, ST_OK)
        assert e["metrics"]["weighted_cvd_score"] == pytest.approx(100 * (10 * math.tanh(1) - 5 * math.tanh(1)) / 15, abs=0.1)
    assert e["metrics"]["positive_cvd"] == 1 and e["metrics"]["negative_cvd"] == 1 and e["metrics"]["aggregate_points_pct"] == pytest.approx(0.02)
    t = {x["name"]: x for x in e["terms"]}
    assert t["Index points from the heavyweights"]["score"] == pytest.approx(100 * math.tanh(0.02 / 0.15), abs=0.1)


def test_heavyweight_divergence_when_the_index_rises_against_selling() -> None:
    sell = [{"symbol": "A", "weight": 10, "change_pct": 0.1, "flow": {"cvd_pct": -40.0, "classified_share": 0.9, "stale": False}}]
    e = fz.heavyweight_engine({"market": {"flow": {"heavy5": {"stocks": sell}}, "index_change_pct": 0.3}}, ST_OK)
    assert e["metrics"]["divergence"] == "index and heavyweight flow disagree"


def gex_points(nets: list[float], spots: list[float], flip: float | None = 24000.0) -> dict[str, Any]:
    pts = [{"at": (NOW - timedelta(minutes=5 * (len(nets) - 1 - i))).isoformat(), "spot": s, "net": n, "abs": abs(n) * 2, "ce": 10, "pe": -5, "flip": flip, "call_wall": 24200, "put_wall": 23800, "peak": 24000, "near_net": 1} for i, (n, s) in enumerate(zip(nets, spots, strict=True))]
    return {"points": pts, "session": "2026-11-09", "universe": "dynamic"}


def test_gex_state_reads_the_flip_distance_and_the_price_relationship() -> None:
    # spot 24100 vs flip 24000: +0.415 % above; over 15 minutes spot +0.5 % and net GEX 100 -> 40 (-60 %): potentially amplifying
    st = fz.gex_state({"gex": gex_points([100, 80, 60, 40], [23980, 24020, 24060, 24100])})
    assert st["flip_distance_pct"] == pytest.approx((24100 - 24000) / 24100 * 100, abs=1e-6) and st["regime"] == "positive"
    assert st["relationship"] == "amplifying" and st["net_change_15m"] == -60 and st["net_change_pct"] == pytest.approx(-60.0)
    near = fz.gex_state({"gex": gex_points([10, 10, 10, 10], [24000, 24001, 24002, 24003])})
    assert near["regime"] == "near flip"  # within 0.2 % of the flip
    assert fz.gex_state({"gex": {"points": []}}) == {"available": False}


def test_gex_engine_scores_the_flip_side_and_wall_room() -> None:
    e = fz.gex_engine({"gex": gex_points([50, 50, 50, 50], [24090, 24090, 24090, 24090])}, ST_OK)
    t = {x["name"]: x for x in e["terms"]}
    dist = (24090 - 24000) / 24090 * 100
    assert t["Spot versus the gamma flip"]["score"] == pytest.approx(100 * math.tanh(dist / 1.0), abs=0.1)
    up, dn = 24200 - 24090, 24090 - 23800
    assert t["Room to the walls"]["score"] == pytest.approx((up - dn) / (up + dn) * 60, abs=0.1)  # little room above, lots below: bearish asymmetry
    none = fz.gex_engine({"gex": {"points": []}}, ST_OK)
    assert none["score"] is None


def test_volatility_engine_does_not_read_rising_iv_in_an_advance_as_directional() -> None:
    def table(ce: float, pe: float, spot: float, d25: float) -> dict[str, Any]:
        return {"momentum": {"table": {"periods": {"15": {"atm": {"ce_change": ce, "pe_change": pe}, "spot_change_pct": spot, "d25": {"momentum": d25}}}}}, "skew": {"cards": {}}}

    up = fz.volatility_engine(table(0.5, 0.5, 0.3, 0.0), ST_OK)
    assert next(t for t in up["terms"] if t["name"].startswith("ATM IV change"))["score"] == 0.0  # IV +0.5 with spot +0.3 %: not directional
    fall = fz.volatility_engine(table(0.5, 0.5, -0.3, 0.4), ST_OK)
    assert next(t for t in fall["terms"] if t["name"].startswith("ATM IV change"))["score"] == pytest.approx(-100 * math.tanh(0.5 / 0.5) * 0.6, abs=0.1)
    assert next(t for t in fall["terms"] if t["name"].startswith("Call versus put"))["score"] == pytest.approx(100 * math.tanh(1.0), abs=0.1)
    assert fz.volatility_engine({"momentum": None}, ST_OK)["score"] is None  # IV rank and percentile alone never create a score


# ---------------------------------------------------------------- regime, divergences, scenarios
def fused(score: float | None, agree: float = 0.8, conf: float = 70) -> dict[str, Any]:
    return {"score": score, "agreement": agree, "confidence": conf, "class": fz.classify(score), "coverage": 0.9, "reason": None if score is not None else "no data"}


def test_regime_uses_several_indicators_and_names_what_it_used() -> None:
    by = {"futures": {"buildup": "short covering", "price_change_15m_pct": 0.3, "terms": [{"name": "Futures CVD (estimated)", "available": True, "score": 40.0}]}, "volatility": {"atm_iv_change_15m": -0.4, "terms": []}}
    assert fz.regime(fused(40), by, {}, {"regime": "positive"})["name"] == "Short squeeze"
    by2 = {"futures": {"buildup": "long unwinding", "price_change_15m_pct": -0.3, "terms": [{"name": "Futures CVD (estimated)", "available": True, "score": -40.0}]}, "volatility": {"terms": []}}
    assert fz.regime(fused(-40), by2, {}, {"regime": "positive"})["name"] == "Long liquidation"
    plain = {"futures": {"buildup": "long buildup", "price_change_15m_pct": 0.3, "terms": []}, "volatility": {"atm_iv_change_15m": 0.1, "terms": []}}
    assert fz.regime(fused(75, 0.8), plain, {}, {})["name"] == "Strong bullish trend"
    assert fz.regime(fused(50, 0.6), plain, {}, {})["name"] == "Bullish trend"
    assert fz.regime(fused(-20, 0.6), plain, {}, {})["name"] == "Weak bearish"
    assert fz.regime(fused(50, 0.3), plain, {}, {})["name"] == "Uncertain / Conflicting signals"  # strong score but the engines disagree
    assert fz.regime(fused(5), plain, {}, {"regime": "positive"})["name"] == "Sideways / Range"
    assert fz.regime(fused(5), {"volatility": {"atm_iv_change_15m": -0.5, "terms": []}, "futures": {}}, {}, {"regime": "positive"})["name"] == "Compression"
    assert fz.regime(fused(None), plain, {}, {})["name"] == "Uncertain / Conflicting signals"


def test_divergences_are_descriptions_with_invalidation_and_the_unavailable_checks_are_listed() -> None:
    by = {"futures": {"score": 40, "buildup": "short covering", "price_change_15m_pct": 0.3, "terms": [{"name": "Futures CVD (estimated)", "available": True, "score": -40.0, "detail": "session CVD -20.0% of classified volume"}]},
          "options": {"score": -30}, "volatility": {"spot_change_15m_pct": 0.3, "atm_iv_change_15m": 0.0, "terms": [{"name": "Call versus put IV momentum (25Δ, 15 min)", "available": True, "score": -60.0}]}, "heavyweight": {"metrics": {}}}
    out, missing = fz.divergences({"intraday": {}}, by, {"available": False})
    ids = {d["id"] for d in out}
    assert {"price_cvd", "price_oi", "price_skew", "fut_opt"} <= ids
    assert all(d["invalidation"] and d["explanation"] and d["severity"] in ("low", "medium", "high") for d in out)
    assert next(d for d in out if d["id"] == "price_cvd")["direction"] == "bearish"  # price up on net selling pressure
    assert len(missing) == 2 and any("OI migration" in m for m in missing)


def test_scenarios_are_heuristic_scores_summing_to_100_with_levels_and_horizon_moves() -> None:
    inp = {"intraday": {"options": {"max_ce_oi_strike": 24300, "max_pe_oi_strike": 23700}, "vwap": {"vwap": 24050}, "volatility": {"atm_iv": 15.0}, "daily": {"prev_high": 24400, "prev_low": 23600}, "market": {"phase": "live"}}, "market": {"elapsed_minutes": 60}}
    gx = {"available": True, "call_wall": 24200, "put_wall": 23800, "regime": "positive"}
    s = fz.scenarios(fused(40, 0.8, 70), [eng("futures", 40)], gx, inp, 24100.0)
    assert s["bullish"]["score"] + s["bearish"]["score"] + s["sideways"]["score"] in (99, 100, 101)  # rounding
    assert "not probabilities" in s["label"]
    assert s["bullish"]["resistance"] == 24200 and s["bearish"]["support"] == 23800 and s["sideways"]["range"] == [23800, 24200]
    assert s["bullish"]["score"] > s["bearish"]["score"]
    h = {x["horizon"]: x for x in s["horizons"]}
    assert h["Next 15 minutes"]["one_sd_points"] == pytest.approx(24100 * 0.15 * math.sqrt(15 / (252 * 375)), abs=0.1)  # 45.5 points
    assert h["End of session"]["minutes"] == 315 and set(h) >= {"Next 30 minutes", "Next 60 minutes", "Next trading session"}
    assert fz.scenarios(fused(None), [], gx, inp, 24100.0)["available"] is False


def test_interpretation_is_generated_from_the_readings() -> None:
    es = [eng("futures", 50), eng("options", 30)]
    es[0]["supporting"] = ["Price and open interest (15 min): long buildup"]
    text = fz.interpretation(fused(40), es, {"name": "Bullish trend"}, [{"name": "Futures versus options"}], {"available": True, "flip": 24000.0, "flip_distance_pct": 0.4}, {"intraday": {"vwap": {"vwap": 24050}}})
    assert "bullish" in text and "long buildup" in text and "0.40% above the gamma flip at 24000" in text and "futures versus options" in text and "VWAP near 24050" in text
    assert "INSUFFICIENT" in fz.interpretation({"score": None, "class": "INSUFFICIENT DATA – SENTIMENT UNRELIABLE", "reason": "x"}, [], {}, [], {}, {})


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
        }
        self.svc = MarketIntelligence(providers=self.providers, store=self.store, default_expiry=lambda: "2026-11-10", clock=lambda: self.clock)


def test_summary_fuses_the_engines_and_reports_each_input_status(tmp_path: Path) -> None:
    r = Rig(tmp_path)
    s = r.svc.summary()
    assert s["sentiment"]["score"] is not None and s["sentiment"]["class"] in ("Bullish", "Mild Bullish", "Strong Bullish")
    assert {e["key"] for e in s["engines"]} == set(fz.DEFAULT_WEIGHTS) and all(v["ok"] for v in s["status"].values())
    assert s["pulse"]["spot"] == 24100.0 and s["pulse"]["india_vix"]["note"] == "daily close, not a live quote" and s["pulse"]["futures"] == 24048
    assert s["sentiment"]["coverage"] < 1.0  # no heavyweight flow in this rig: its weight is left out, not scored neutral
    assert s["panels"]["volatility"]["hv"] == 11.0 and s["scenarios"]["available"] is True and "not probabilities" in s["scenarios"]["label"]
    assert any("rolling 5/15/30-minute CVD" in u for u in s["panels"]["futures"]["unavailable"])


def test_one_failing_module_makes_only_its_engine_unavailable(tmp_path: Path) -> None:
    r = Rig(tmp_path, fail={"gex", "skew"})
    s = r.svc.summary()
    assert s["status"]["gex"]["ok"] is False and "module down" in s["status"]["gex"]["error"]
    by = {e["key"]: e for e in s["engines"]}
    assert by["gex"]["score"] is None and by["gex"]["class"] == "Unavailable"
    assert by["futures"]["score"] is not None and s["sentiment"]["score"] is not None  # the rest still reports


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
        assert {"status", "engines", "pulse", "regime", "interpretation", "divergences", "scenarios", "panels", "alerts", "config"} <= set(d)
        assert len(d["engines"]) == 6 and d["config"]["weights"]["futures"] == 25.0
        t = c.get("/api/intelligence/timeline")
        assert t.status_code == 200 and t.json()["recorded"] == 0
