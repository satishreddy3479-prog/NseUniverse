"""Straddle intelligence: second-order attribution, IV regimes, buyer/seller environments, alerts, recording and validation. Hand-calculated where stated."""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.intelligence import straddle as sd
from app.intelligence import straddle_env as env
from app.intelligence import straddle_validation as val
from app.intelligence import straddle_watch as watch
from app.intelligence.straddle_service import StraddleDecay, snapshot
from app.intelligence.straddle_store import StraddleStore
from app.intraday.volatility import CALL, PUT, price, years_to_expiry
from tests.unit.test_straddle_decay import EXPIRY, OPEN, STRIKES, R, chain, point, session
from tests.unit.test_straddle_service import FakeObs

IST = OPEN.tzinfo


class TestSecondOrder:
    def test_volga_positive_on_a_wing_and_totals_exact(self) -> None:
        a, b = point(24000, 0.15, OPEN), point(24000, 0.19, OPEN)
        x = sd.attribute_leg(a, b, 24300.0, CALL)  # an out-of-the-money call: volga > 0
        assert x is not None
        assert x["volga"] > 0
        assert x["vega"] + x["volga"] == pytest.approx(x["actual"], abs=1e-9)
        assert x["vega"] == pytest.approx(x["vega_raw"] * 0.04, rel=0.05)  # first-order vega x vol change (third-order terms remain)
        assert abs(x["residual"]) < 1e-6

    def test_vanna_appears_only_when_forward_and_vol_both_move(self) -> None:
        a = point(24000, 0.15, OPEN)
        only_f = sd.attribute_leg(a, point(24080, 0.15, OPEN), 24200.0, CALL)
        both = sd.attribute_leg(a, point(24080, 0.18, OPEN), 24200.0, CALL)
        assert only_f is not None and both is not None
        assert abs(only_f["vanna"]) < 1e-5 and both["vanna"] == pytest.approx(3.88, abs=0.05)  # vanna x forward move x vol move; only solver noise when the vol is flat
        assert sum(both[c] for c in sd.COMPONENTS) == pytest.approx(both["actual"], abs=1e-9)

    def test_skew_effect_is_the_differential_vega(self) -> None:
        def chain_skew(at: datetime, ce_iv: float, pe_iv: float) -> sd.Snap:
            t = years_to_expiry(EXPIRY, at)
            f = 24000 * math.exp(R * t)
            prices = {(k, s): price(s, f, k, t, ce_iv if s == CALL else pe_iv, R) for k in STRIKES for s in (CALL, PUT)}
            return sd.Snap(at, 24000.0, prices, {})

        pa, _ = sd.build_point(chain_skew(OPEN, 0.15, 0.15), EXPIRY, R)
        pb, _ = sd.build_point(chain_skew(OPEN, 0.17, 0.15), EXPIRY, R)  # only the call vol rises: 2 vol points
        assert pa is not None and pb is not None
        steps, _ = sd.attribute_steps([pa, pb], [24000.0, 24000.0])
        st = steps[1]
        assert st is not None
        # average vol change is 1 point: the call is +1 point above it, the put -1 point below it; vega is about equal on both legs
        assert st["ce"]["vega_skew"] > 0 > st["pe"]["vega_skew"]
        avg = (st["ce"]["d_sigma"] + st["pe"]["d_sigma"]) / 2  # the legs' own solved vol changes (put-call parity moves the forward a little)
        assert st["ce"]["vega_skew"] == pytest.approx(st["ce"]["vega_raw"] * (st["ce"]["d_sigma"] - avg), rel=1e-9)
        assert st["ce"]["vega_skew"] + st["pe"]["vega_skew"] == pytest.approx((st["ce"]["vega_raw"] - st["pe"]["vega_raw"]) * (st["ce"]["d_sigma"] - st["pe"]["d_sigma"]) / 2, abs=1e-9)

    def test_efficiency_reports_rupees_percent_and_causes(self) -> None:
        tot = {"theta": -10.0, "vega": 4.0, "delta": 0.5, "gamma": 1.0, "vanna": 0.0, "volga": 0.0, "residual": 0.0, "vega_skew": 1.5, "actual": -4.5}
        e = sd.efficiency(tot)
        assert e["shortfall"] == 5.5 and e["shortfall_rupees"] == 358.0 and e["shortfall_pct"] == 55.0
        assert e["causes"]["IV expansion (parallel)"] == 2.5  # 4.0 vega - 1.5 skew
        assert e["causes"]["skew change (call and put vols moving apart)"] == 1.5
        assert "IV expansion" in e["reason"]

    def test_negative_expected_theta_is_not_forced(self) -> None:
        e = sd.efficiency({"theta": 0.4, "vega": 0, "delta": 0, "gamma": 0, "vanna": 0, "volga": 0, "residual": 0, "actual": 0.1})
        assert e["status"] == "unavailable" and e["efficiency_pct"] is None and "not positive" in e["reason"]


    def test_a_tiny_expected_decay_is_not_turned_into_a_ratio(self) -> None:
        """12 Nov 2026: theta of -0.03...-0.74 points since the open gave efficiencies of +8625 % ... -1032 % from single ticks and swung the scores 30 <-> 77."""
        zero = {"vega": 0, "delta": 0, "gamma": 0, "vanna": 0, "volga": 0, "residual": 0}
        for theta, actual in ((-0.029, -2.5), (-0.313, 0.85), (-0.368, 3.8), (-0.744, 3.7)):  # real stored minutes
            e = sd.efficiency({**zero, "theta": theta, "actual": actual})
            assert e["status"] == "low_signal" and e["efficiency_pct"] is None and e["confidence"] == 0.0
            assert "Too early to judge" in e["reason"] and "3-point floor" in e["reason"]
        ok = sd.efficiency({**zero, "theta": -3.0, "actual": -3.0})  # exactly at the floor: computed, but with zero confidence
        assert ok["efficiency_pct"] == 100.0 and ok["confidence"] == 0.0
        full = sd.efficiency({**zero, "theta": -8.0, "actual": -4.0})
        assert full["efficiency_pct"] == 50.0 and full["confidence"] == 1.0
        mid = sd.efficiency({**zero, "theta": -5.5, "actual": -5.5})  # halfway between 3 and 8 points
        assert mid["confidence"] == 0.5

    def test_the_scores_weigh_a_low_confidence_efficiency_down_toward_neutral(self) -> None:
        EV = env.evidence({}, {})  # every input missing: only the efficiency under test is set
        ev_base: dict[str, Any] = {"eff": {"efficiency_pct": 250.0, "status": "efficient", "reason": "none", "confidence": 1.0, "expected_decay": 9.0}}
        full = next(c for c in env.seller_components({**EV, **ev_base}) if c["id"] == "decay")
        assert full["value"] == 1.0  # (250 - 50) / 50 = 4, clipped to +1
        half = next(c for c in env.seller_components({**EV, "eff": {**ev_base["eff"], "confidence": 0.1, "expected_decay": 3.5}}) if c["id"] == "decay")
        assert half["value"] == pytest.approx(0.4, abs=1e-9)  # 4 x 0.1
        assert "weighed at 10%" in half["text"]
        gone = next(c for c in env.seller_components({**EV, "eff": {"efficiency_pct": None, "status": "low_signal", "reason": "Too early to judge: x", "confidence": 0.0}}) if c["id"] == "decay")
        assert gone["value"] is None and gone["text"].startswith("unavailable: Too early to judge")
        buyer = next(c for c in env.buyer_components({**EV, "eff": {**ev_base["eff"], "confidence": 0.5}}, {"value": 0.0, "label": "mixed", "parts": []}) if c["id"] == "prem_exp")
        assert buyer["value"] == -1.0  # (50 - 250) / 50 = -4, x 0.5 = -2, clipped to -1
        low = next(c for c in env.buyer_components({**EV, "eff": {**ev_base["eff"], "confidence": 0.1}}, {"value": 0.0, "label": "mixed", "parts": []}) if c["id"] == "prem_exp")
        assert low["value"] == pytest.approx(-0.4)  # -4 x 0.1


class TestIvRegimes:
    def test_six_patterns_by_hand(self) -> None:
        tags = lambda c, p: sd.iv_regime(c, p)["tags"]  # noqa: E731
        assert tags(1.0, 1.5) == ["both_expanding", "put_expanding_faster"]
        assert tags(1.5, 1.0) == ["both_expanding", "call_expanding_faster"]
        assert tags(-0.5, -1.2) == ["both_contracting", "put_contracting_faster"]
        assert tags(-1.2, -0.5) == ["both_contracting", "call_contracting_faster"]
        assert tags(0.8, 0.1) == ["call_expanding_faster"]
        assert tags(0.1, 0.1) == []
        assert sd.iv_regime(None, 0.5)["tags"] == []
        assert "not who is buying or selling" in sd.iv_regime(1, 1)["text"]

    def test_moves_need_the_window_and_never_fill(self) -> None:
        t = [OPEN + timedelta(minutes=i) for i in range(70)]
        vals: list[float | None] = [float(i) for i in range(70)]
        m = sd._moves(t, vals)
        assert m == {"5": 5.0, "15": 15.0, "30": 30.0, "60": 60.0}
        short = sd._moves(t[:20], vals[:20])
        assert short["30"] is None and short["15"] == 15.0
        vals[39] = None  # the 30-minute reference sample is missing: use the last earlier one
        assert sd._moves(t, vals)["30"] == 31.0


def make(n: int = 90, spots: list[float] | None = None, ivs: list[float] | None = None) -> dict[str, Any]:
    spots = spots or [24000.0] * n
    ivs = ivs or [0.15] * n
    snaps = session(spots, ivs)
    return sd.analyse(snaps, [(s.at, s.spot) for s in snaps], EXPIRY, rate=R, now=snaps[-1].at)


class TestEngine:
    def test_flat_session_extended_fields(self) -> None:
        a = make()
        tr = a["tracker"]
        assert tr["atm_open"] == tr["atm_now"] == 24000.0 and tr["fixed"]["straddle"]["high"] >= tr["fixed"]["straddle"]["open"] > tr["fixed"]["straddle"]["low"]
        assert tr["moves"]["fixed"]["straddle"]["30"] < 0 and tr["moves"]["fixed"]["straddle"]["60"] < tr["moves"]["fixed"]["straddle"]["30"]
        assert tr["difference"]["fixed_minus_rolling_now"] == pytest.approx(0, abs=1e-6)  # spot never moved: the two series are the same contract
        assert set(a["iv"]["levels"]) == {"pe25", "ce25", "pe10", "ce10", "butterfly25", "butterfly10"}
        assert a["iv"]["regimes"]["30"]["tags"] == []
        assert a["retention"]["side"] in ("neither", "CE", "PE")
        assert a["regime"]["label"] in ("volatility compression", "no clear regime", "undetermined", "volatility expansion", "directional acceleration")
        assert a["realised_vs_implied"]["acceleration"]["ratio"] is None or a["realised_vs_implied"]["acceleration"]["ratio"] >= 0

    def test_realised_acceleration_and_directional_regime(self) -> None:
        n = 90
        spots = [24000.0 + (0.2 * i if i < 75 else 15 + 8.0 * (i - 75)) for i in range(n)]  # slow drift, then a fast one-way move in the last 15 minutes
        a = make(n, spots)
        acc = a["realised_vs_implied"]["acceleration"]
        assert acc["ratio"] is not None and acc["ratio"] > 1.3 and acc["label"] == "accelerating"
        assert a["regime"]["label"] == "directional acceleration"
        assert a["regime"]["path_efficiency_30m"] > 0.9


MI: dict[str, Any] = {"engines": [{"key": "orderflow", "score": 5}, {"key": "positioning", "score": 3}], "heavyweights": {"aggregate": {"15": {"score": 4}}},
                      "pulse": {"futures_cvd_pct": 1.0, "vwap": {"distance_pct": 0.05, "side": "above"}, "spot": 24000.0},
                      "panels": {"options": {"max_ce_oi_strike": 24300, "max_pe_oi_strike": 23700, "pcr_oi": 1.0}}}


class TestEnvironments:
    def test_flat_decaying_market_favours_sellers_and_explains_why(self) -> None:
        e = env.assess(make(), MI)
        s, b = e["seller"], e["buyer"]
        assert s["score"] >= 70 and b["score"] <= 40 and e["comparison"]["verdict"] == "favours sellers"  # 70, not 75: the premium paths (-2.1% here, hand check below) add a modest +0.18 each
        assert s["class"] in ("Highly favourable", "Favourable")
        top = e["comparison"]["top_seller"][0]
        assert top["name"] and top["text"]
        assert e["invalidation"] and any("Realised volatility" in x for x in e["invalidation"])
        assert s["short_straddle"]["score"] is not None and s["call_side_risk"]["label"] in ("Low", "Moderate", "Elevated", "High", "Insufficient evidence")
        assert "not a guarantee" in s["note"] and "not a signal" in e["weights_note"]
        assert {c["id"] for c in s["components"]} >= {"decay", "iv_trend", "rv_gap", "movement", "gamma", "skew", "positioning", "flow", "heavy"}

    def test_expanding_whipsaw_market_scores_buyers_above_the_flat_one(self) -> None:
        n = 90
        flat = env.assess(make(), MI)
        wild = env.assess(make(n, [24000.0 + (60 if i % 2 else -60) for i in range(n)], [0.15 + 0.05 * i / (n - 1) for i in range(n)]), MI)
        assert wild["buyer"]["score"] > flat["buyer"]["score"]
        assert wild["seller"]["score"] < flat["seller"]["score"] - 25
        assert any(c["id"] == "justified" and c["value"] is not None for c in wild["buyer"]["components"])

    def test_missing_inputs_are_unavailable_not_zero(self) -> None:
        e = env.assess(make(), {})  # no Market Intelligence input at all
        flow = next(c for c in e["seller"]["components"] if c["id"] == "flow")
        assert flow["value"] is None and flow["contribution"] is None and flow["status"] == "UNAVAILABLE" and flow["text"].startswith("unavailable")
        assert e["seller"]["coverage"] < 1
        r = env.score([env.comp("x", "x", 10, None, "n/a", "s"), env.comp("y", "y", 10, 1.0, "ok", "s")])
        assert r["coverage"] == 0.5 and r["score"] == 100.0
        low = env.score([env.comp("x", "x", 10, None, "n/a", "s"), env.comp("y", "y", 5, 1.0, "ok", "s"), env.comp("z", "z", 10, None, "n/a", "s")])
        assert low["score"] is None  # under half of the weight is available: no score is invented

    def test_score_arithmetic(self) -> None:
        r = env.score([env.comp("a", "a", 30, 1.0, "", "s"), env.comp("b", "b", 10, -1.0, "", "s")])
        assert r["score"] == 75.0  # 50 + 50 x (30 - 10) / 40
        assert [c["contribution"] for c in r["components"]] == [37.5, -12.5]

    def test_risk_flags_cap_the_seller_class(self) -> None:
        a = make()
        a["iv"]["moves"]["rolling_atm"]["15"] = 1.4  # sudden IV expansion
        a["realised_vs_implied"]["acceleration"]["ratio"] = 1.6  # realised vol rising
        e = env.assess(a, MI)
        assert {f["id"] for f in e["seller"]["flags"]} >= {"iv_spike", "rv_up"}
        assert e["seller"]["class"] == "Unfavourable" and e["seller"]["capped_by_flags"] == "Unfavourable"

    def test_both_low_is_uncertain_and_buyer_is_not_told_to_buy_on_iv_alone(self) -> None:
        cmp = env.compare({"score": 30.0, "components": []}, {"score": 35.0, "components": []}, {})
        assert cmp["verdict"] == "uncertain or unattractive"
        both = env.compare({"score": 70.0, "components": []}, {"score": 66.0, "components": []}, {})
        assert both["verdict"] == "conflicting"
        a = make()
        a["iv"]["moves"]["rolling_atm"]["30"] = 1.5
        a["realised_vs_implied"]["gap"]["60"] = 4.0  # implied above realised
        e = env.assess(a, MI)
        assert e["buyer"]["premium_check"]["iv_rising_but_not_justified"] is True


class TestAlerts:
    def row(self, **k: Any) -> dict[str, Any]:
        base: dict[str, Any] = {"seller": 70.0, "buyer": 30.0, "eff30": {"status": "efficient", "pct": 95}, "iv": {"atm15": 0.1, "ce15": 0.1, "pe15": 0.1, "skew25": 1.0},
                                "rv": {"accel": 1.0}, "gex": {"net": 100.0, "side": 1, "flip": 24000}, "flow": {"orderflow": 0, "heavy15": 0, "cvd": 0}}
        return base | k

    def test_quiet_market_raises_nothing(self) -> None:
        assert watch.detect([self.row()] * 20, self.row()) == []

    def test_each_alert_with_persistence(self) -> None:
        prev = [self.row(iv={"atm15": 1.2, "ce15": 0.1, "pe15": 1.3, "skew25": 1.0}, rv={"accel": 1.4})] + [self.row()] * 19
        cur = self.row(iv={"atm15": 1.3, "ce15": 0.1, "pe15": 1.4, "skew25": 1.0}, rv={"accel": 1.5}, eff30={"status": "none", "pct": 10})
        kinds = {a["kind"] for a in watch.detect(prev, cur)}
        assert {"Unexpected ATM IV expansion", "Put IV expansion", "Realised volatility accelerating", "Straddle decay slowing sharply"} <= kinds
        # a single-minute spike (previous minute quiet) is not an IV alert: persistence
        kinds2 = {a["kind"] for a in watch.detect([self.row()] * 20, self.row(iv={"atm15": 1.5, "ce15": 0.1, "pe15": 0.1, "skew25": 1.0}))}
        assert "Unexpected ATM IV expansion" not in kinds2

    def test_flip_crossing_skew_reversal_and_scores(self) -> None:
        prev = [self.row()] * 20
        cur = self.row(gex={"net": 100.0, "side": -1, "flip": 24000}, seller=58.0, buyer=45.0, seller_class="Neutral", buyer_class="Selective",
                       iv={"atm15": 0.1, "ce15": 0.1, "pe15": 0.1, "skew25": -0.5})  # skew from +1.0 to -0.5
        kinds = {a["kind"] for a in watch.detect(prev, cur)}
        assert {"Gamma flip crossing", "Skew reversal", "Seller environment deteriorating", "Buyer environment improving"} <= kinds

    def test_flow_and_heavyweight_divergence(self) -> None:
        prev = [self.row(flow={"orderflow": 5, "heavy15": 40, "cvd": -15})] * 20
        cur = self.row(flow={"orderflow": 55, "heavy15": 40, "cvd": -15})
        assert "Sudden directional futures flow" in {a["kind"] for a in watch.detect(prev, cur)}
        # heavyweight buying while futures CVD sells: divergence, but only when it is new this minute
        p2 = [self.row(), *[self.row(flow={"orderflow": 0, "heavy15": 0, "cvd": 0})] * 19]
        c2 = self.row(flow={"orderflow": 0, "heavy15": 40, "cvd": -15})
        assert "Heavyweight CVD divergence" not in {a["kind"] for a in watch.detect(p2, c2)}  # previous minute had no divergence: not persistent yet


class TestValidation:
    def ladder(self, p: float) -> dict[str, Any]:
        return {"k0": 24000.0, "step": 50.0, "ce": [p / 2] * 5, "pe": [p / 2] * 5}

    def rows(self, spots: list[float], prem: list[float], seller: float, buyer: float) -> list[dict[str, Any]]:
        t0 = datetime(2026, 11, 11, 9, 20, tzinfo=IST)
        out = []
        for i, (s, p) in enumerate(zip(spots, prem, strict=True)):
            out.append({"at": (t0 + timedelta(minutes=15 * i)).isoformat(), "spot": s, "seller": seller, "buyer": buyer,
                        "data": {"atm": {"k": 24000.0}, "ladder": self.ladder(p), "direction": {"value": 0.6}}})  # fmt: skip
        return out

    def test_premium_lookup(self) -> None:
        lad = self.ladder(100)
        assert val.premium(lad, 24000.0) == 100 and val.premium(lad, 24100.0) == 100 and val.premium(lad, 24150.0) is None and val.premium(None, 24000.0) is None
        lad["ce"][3] = None
        assert val.premium(lad, 24050.0) is None  # a missing price stays missing

    def test_seller_and_buyer_results_by_hand(self) -> None:
        rows = self.rows([24000, 24020], [100, 90], seller=70, buyer=20)
        v = val.evaluate([{"session": "2026-11-11", "expiry_day": False, "rows": rows}])
        s = v["table"]["seller"]["15"]["high (>=60)"]
        assert s["n"] == 1 and s["mean_move_pts"] == 20.0
        assert s["mean_result_pts"] == 8.0  # sold 100, bought back 90 = +10, less 4 x 0.5 cost = 8
        assert s["max_adverse_pts"] == 0.0 and s["win_rate_pct"] == 100.0
        b = v["table"]["buyer"]["15"]["low (<40)"]
        assert b["mean_result_pts"] == -12.0  # a long straddle lost 10, plus the 2 points of costs
        assert v["sufficient"] is False and "Insufficient" in v["message"] and v["cost_points_per_round_trip"] == 2.0

    def test_directional_accuracy_and_adverse_excursion(self) -> None:
        rows = self.rows([24000, 24010, 23980], [100, 112, 95], seller=70, buyer=70)  # direction +0.6 each row; 15 min later spot +10, then -30
        v = val.evaluate([{"session": "d", "rows": rows}])
        b = v["table"]["buyer"]["15"]["high (>=60)"]
        assert b["directional_n"] == 2 and b["directional_accuracy_pct"] == 50.0  # one up (right), one down (wrong)
        s = v["table"]["seller"]["15"]["high (>=60)"]
        assert s["max_adverse_pts"] == 12.0  # the short straddle was 12 points under water at the first exit

    def test_non_overlapping_picks_and_end_of_session(self) -> None:
        rows = self.rows([24000 + i for i in range(9)], [100 - i for i in range(9)], 70, 30)  # 9 rows 15 minutes apart
        assert len(val.picks(rows, 15)) == 8 and len(val.picks(rows, 30)) == 4
        assert val.picks(rows, "eos")[0] == (0, 8)


class TestRecordingEndToEnd:
    def svc(self, tmp_path: Path, clock: list[datetime]) -> StraddleDecay:
        return StraddleDecay(observations=FakeObs(90), underlying="NIFTY", gex=None, rate=R, clock=lambda: clock[0], store=StraddleStore(tmp_path), mi=lambda e: MI)

    def test_records_once_a_minute_and_serves_history(self, tmp_path: Path) -> None:
        now = [OPEN + timedelta(minutes=90)]
        s = self.svc(tmp_path, now)
        assert s.record(now[0]) is True and s.record(now[0]) is False  # one row per minute, never rewritten
        rows = s.store.rows("2026-11-11") if s.store else []
        assert len(rows) == 1 and rows[0]["seller"] is not None and rows[0]["data"]["ladder"]["k0"] == 24000.0
        out = s.summary()
        assert out["environment"]["seller"]["score"] is not None and out["history"]["times"] and out["storage"]["rows_today"] == 1
        assert {x["id"] for x in out["sources"]} >= {"chain"} and out["context"]["groups"]["orderflow"]["score"] == 5
        v = s.validation()
        assert v["environment"]["sessions"] == 1 and v["environment"]["sufficient"] is False

    def test_no_recording_outside_market_hours_or_on_stale_data(self, tmp_path: Path) -> None:
        night = [datetime(2026, 11, 11, 20, 0, tzinfo=IST)]
        assert self.svc(tmp_path, night).record(night[0]) is False
        stale = [OPEN + timedelta(minutes=200)]  # the last stored sample is 110 minutes old
        assert self.svc(tmp_path, stale).record(stale[0]) is False

    def test_snapshot_is_compact_and_complete(self, tmp_path: Path) -> None:
        now = [OPEN + timedelta(minutes=90)]
        s = self.svc(tmp_path, now)
        a = s.summary()
        snap = snapshot(a, a["environment"], chain(now[0], 24000.0, 0.15), False)
        for k in ("spot", "seller", "buyer", "regime", "atm", "fixed", "ladder", "eff30", "terms", "iv", "rv", "gex", "flow", "types", "direction"):
            assert k in snap
        assert len(str(snap)) < 3000
        assert snap["ladder"]["k0"] == 24000.0 and len(snap["ladder"]["ce"]) == 5
        assert FakeObs  # the same fake store as the service tests


class TestPremiumPath:
    """The premium-path evidence on the real 19 Nov 2026 13:43 server read. The fixed 25150 straddle was +49.95 points above its open (mostly direction: NIFTY had risen about 140 points),
    while the at-the-money straddle, roll-adjusted, was +6.45. Only the second is scored."""

    A = json.loads((Path(__file__).parent.parent / "fixtures" / "straddle" / "straddle_19nov2026_1343.json").read_text(encoding="utf-8"))

    def test_the_premium_path_is_in_percent_of_the_opening_premium(self) -> None:
        pr = env.premium_path(self.A, "rolling")
        assert pr is not None and pr["base"] == 309.35
        assert pr["pts"]["open"] == 6.45 and pr["pts"]["60"] == pytest.approx(-3.9, abs=0.01)  # 6.45 - 10.35 stored minutes ago
        assert pr["pct"]["open"] == pytest.approx(6.45 / 309.35 * 100, abs=0.01)  # +2.09 %
        fx = env.premium_path(self.A, "fixed")
        assert fx is not None and fx["pct"]["open"] == pytest.approx(49.95 / 309.35 * 100, abs=0.01)  # +16.15 %: still computable, but not used by the score
        assert env.premium_path({}, "rolling") is None

    def test_the_score_reads_the_atm_straddle_and_not_the_stale_opening_strike(self) -> None:
        ev = {**env.evidence({}, {}), "prem_rolling": env.premium_path(self.A, "rolling"), "prem_fixed": env.premium_path(self.A, "fixed"),
              "eff": {"efficiency_pct": None, "status": "low_signal", "reason": "Too early to judge: x", "confidence": 0.0}}
        by = {c["id"]: c for c in env.seller_components(ev)}
        assert by["decay"]["value"] is None and "prem_fixed" not in by  # the theta ratio is off (1.4 points of theta in the hour); the opening strike is not a component
        rolling = (0.6 * 6.45 + 0.4 * -3.9) / 309.35 * 100 / 12
        assert by["prem_rolling"]["value"] == pytest.approx(-rolling, abs=0.002)  # about -0.062: the re-centred seller is about flat
        assert "since open +2.1%" in by["prem_rolling"]["text"] and "opening 309.4" in by["prem_rolling"]["text"]
        assert "premium_up" not in {f["id"] for f in env.flags(ev)}  # +2.1 %: nowhere near the stop zone

    def test_a_rise_of_the_atm_straddle_flags_and_caps_the_class(self) -> None:
        base = env.evidence({}, {})
        rose = {"base": 300.0, "pts": {"open": 100.0}, "pct": {"open": 33.3}}
        ev = {**base, "prem_rolling": rose, "rv_gap": 6.0, "ratio": 0.6, "iv_atm_30": -0.5, "orderflow": 0.0, "skew_change": 0.0}  # enough other evidence that coverage is not the reason for a missing class
        s = env.seller(ev, {"value": None, "label": "unavailable", "parts": []})
        assert s["flags"][0]["id"] == "premium_up" and s["flags"][0]["cap"] == "Unfavourable" and s["class"] in ("Unfavourable", "High risk")
        mid = {"base": 300.0, "pts": {"open": 50.0}, "pct": {"open": 16.7}}
        assert "cap" not in env.flags({**base, "prem_rolling": mid})[0]  # +16.7 %: flag, capped at Neutral only
        b = {c["id"]: c for c in env.buyer_components(ev, {"value": 0.0, "label": "mixed", "parts": []})}
        assert b["prem_path"]["value"] == 1.0  # a buyer reads the same rise the other way round

    def test_the_class_label_is_the_median_of_three_minutes(self) -> None:
        assert env.damped_score(61.0, [59.0, 58.0]) == 59.0  # one minute over the line does not flip the label
        assert env.damped_score(61.0, [62.0, 58.0]) == 61.0
        assert env.damped_score(61.0, [62.0]) == 61.0  # fewer than two recorded minutes: raw
        assert env.damped_score(None, [60.0, 60.0]) is None


class TestStaleOpeningStrikeAndManagedStraddle:
    def test_the_opening_strike_goes_stale_at_100_points(self) -> None:
        far = sd.reference_status(25385.0, 25150.0, 309.35, 0.74)  # 19 Nov 13:57: spot 235 points above the opening strike
        assert far["distance"] == 235.0 and far["stale"] is True and far["distance_pct_of_premium"] == pytest.approx(235 / 309.35 * 100, abs=0.05) and far["net_delta"] == 0.74
        near = sd.reference_status(25190.0, 25150.0, 309.35, 0.1)
        assert near["distance"] == 40.0 and near["stale"] is False
        assert sd.reference_status(25150.0 - 100.0, 25150.0, 309.35, None)["stale"] is True  # exactly 100 points either side
        assert sd.reference_status(None, 25150.0, 309.35, None)["stale"] is False  # no spot: not claimed

    def test_the_managed_strike_moves_only_when_spot_is_100_points_away(self) -> None:
        held = sd.managed_held([24000, 24050, 24100, 24090, 24160], [24000, 24050, 24100, 24100, 24150], 24000.0)
        assert held == [24000, 24000, 24100, 24100, 24100]  # 24100 is exactly 100 away: re-struck; 24160 is only 60 from 24100: held

    def test_the_managed_book_books_each_re_strike_and_adds_to_the_open_position(self) -> None:
        t0 = OPEN
        times = [t0 + timedelta(minutes=i) for i in range(5)]
        held = [24000.0, 24000.0, 24100.0, 24100.0, 24100.0]
        straddle: list[float | None] = [300.0, 310.0, 280.0, 270.0, 260.0]
        book = sd.managed_book(times, held, straddle, lambda i, k: 330.0 if (i, k) == (2, 24000.0) else None)  # the old pair is closed at 330 when it is re-struck
        assert book["restrikes"] == 1 and book["segments"][0]["pnl"] == -30.0  # sold 300, bought back 330
        assert book["realised"] == -30.0 and book["open_pnl"] == 20.0 and book["total"] == -10.0  # new pair sold 280, now 260
        assert book["total_rupees"] == -650.0 and book["strike_now"] == 24100.0
        assert book["pnl"] == [0.0, -10.0, -30.0, -20.0, -10.0]
        assert book["segments"][0]["exit_carried"] is False

    def test_a_missing_exit_price_carries_the_last_price_and_says_so(self) -> None:
        times = [OPEN + timedelta(minutes=i) for i in range(3)]
        book = sd.managed_book(times, [24000.0, 24000.0, 24100.0], [300.0, 310.0, 280.0], lambda i, k: None)
        assert book["segments"][0]["exit"] == 310.0 and book["segments"][0]["exit_carried"] is True

    def test_a_session_that_trends_away_marks_the_opening_strike_stale_and_re_strikes(self) -> None:
        n = 60
        a = make(n, [24000.0 + 4.0 * i for i in range(n)])  # 236 points up in an hour
        ref = a["tracker"]["fixed"]["reference"]
        assert ref["stale"] is True and ref["distance"] > 100
        mg = a["tracker"]["managed"]
        assert mg["restrikes"] >= 1 and mg["total"] is not None and "pnl" not in mg  # the per-minute list lives in series.managed
        assert len(a["series"]["managed"]["pnl"]) == len(a["times"])
        assert a["tracker"]["managed"]["strike_now"] == a["series"]["managed"]["strike"][-1]


def test_the_pressure_reading_is_shown_as_context_and_does_not_move_the_side_risk() -> None:
    """The directional pressure (futures CVD proxy, VWAP, heavyweights, last 30 minutes) has no validated skill: it is context on the tile and is not averaged into the risk (D213)."""
    from app.intelligence.straddle_env import side_risk

    ev = {"dce30": 0.5, "dpe30": 0.0, "accel": 1.3, "config": [], "skew25": None, "ce25": None}
    # call IV +0.5 vol points -> 0.5, acceleration 1.3x -> (1.3-1)/0.6 = 0.5: risk 50 + 50 x 0.5 = 75, whatever the pressure says
    for value in (None, 0.9, -0.9):
        r = side_risk(ev, {"value": value, "label": "x"}, +1)
        assert r["risk"] == 75.0 and r["label"] == "High" and len(r["reasons"]) == 2
    up = side_risk(ev, {"value": 0.9, "label": "upward pressure"}, +1)["context"]
    assert up["value"] == 0.9 and "unvalidated" in up["name"] and "not part of the risk score" in up["text"]
    assert side_risk(ev, {"value": 0.9, "label": "upward pressure"}, -1)["context"]["value"] == -0.9  # against the put side
    assert side_risk(ev, {"value": None, "label": "unavailable"}, +1)["context"] is None
    only = side_risk({**ev, "dce30": None, "accel": None}, {"value": 0.9, "label": "u"}, +1)
    assert only["risk"] is None and only["context"]["value"] == 0.9  # pressure alone never makes a risk score
