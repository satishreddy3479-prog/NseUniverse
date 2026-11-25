"""The day outlook: expected-move bands, the lean, what followed in the stored sessions, today's scorecard and the grade of the record. Real stored rows of 20 and 23 Nov 2026."""

import json
import math
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.intelligence import fusion as fz
from app.intelligence import outlook as ol
from app.intelligence import validation as val

FIX = Path(__file__).resolve().parents[1] / "fixtures"
W = fz.DEFAULT_WEIGHTS


def rows_of(day: str) -> list[dict[str, Any]]:
    return json.loads((FIX / f"intelligence_rows_{day}.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def real() -> dict[str, list[dict[str, Any]]]:
    return {d: rows_of(d) for d in ("2026-11-20", "2026-11-23")}


def test_expected_move_is_spot_times_iv_times_root_of_time() -> None:
    # 25,350 x 16.9 % x sqrt(30 / (252 x 375)) = 4284.15 x 0.0178174 = 76.33 points
    assert ol.sigma_points(25350.0, 16.9, 30) == pytest.approx(76.33, abs=0.02)
    assert ol.sigma_points(25350.0, 16.9, 60) == pytest.approx(76.33 * math.sqrt(2), abs=0.03)  # twice the time, root-two the move
    assert ol.sigma_points(None, 16.9, 30) is None and ol.sigma_points(25350.0, None, 30) is None and ol.sigma_points(25350.0, 16.9, 0) is None


def test_a_lean_needs_a_score_outside_fifteen_and_evidence_quality_of_at_least_thirty_five() -> None:
    assert ol.lean(40.0, 60.0)["call"] == 1 and ol.lean(-40.0, 60.0)["call"] == -1
    assert ol.lean(14.9, 90.0)["call"] == 0 and "inside" in ol.lean(14.9, 90.0)["why"]
    low = ol.lean(-60.0, 20.0)
    assert low["call"] == 0 and "evidence quality 20" in low["why"]  # a strong score from groups that disagree is no lean
    assert ol.lean(None, None)["call"] == 0 and ol.lean(40.0, None)["call"] == 0


def test_the_share_up_has_a_wilson_range_and_needs_thirty_decided_snapshots() -> None:
    forwards = [0.05] * 24 + [-0.05] * 16  # 24 up, 16 down: 60 %, range about 44 % to 74 %
    b = ol._bucket(forwards)  # noqa: SLF001
    assert (b["n"], b["decided"], b["up"], b["down"], b["up_share"]) == (40, 40, 24, 16, 0.6)
    assert b["up_ci95"] == pytest.approx([0.4459, 0.7364], abs=0.002)
    small = ol._bucket([0.05] * 10 + [-0.05] * 5)  # noqa: SLF001
    assert small["up_share"] is None and small["up_ci95"] is None  # fewer than 30 decided: counts only, no share
    flat = ol._bucket([0.05] * 30 + [0.01, -0.01, 0.0])  # noqa: SLF001
    assert flat["flat"] == 3 and flat["decided"] == 30  # moves under 0.02 % have no direction


def test_history_by_class_agrees_with_an_independent_count_on_the_real_sessions(real: dict) -> None:
    rows = real["2026-11-20"] + real["2026-11-23"]
    h = ol.history(rows, W)
    assert h["sessions"] == 2 and h["snapshots"] == 768
    # independent: for every row with a row 30 to 33 minutes later in its own session, the forward move and the class of the re-scored verdict
    expected: dict[str, list[float]] = {}
    for day in real:
        r = real[day]
        times = [datetime.fromisoformat(x["at"]) for x in r]
        for i, x in enumerate(r):
            score = val.rescore(x, W)
            if score is None or not x["spot"]:
                continue
            for j in range(i + 1, len(r)):
                gap = (times[j] - times[i]).total_seconds() / 60
                if gap >= 30:
                    if gap - 30 <= 3 and r[j]["spot"]:
                        expected.setdefault(fz.classify(score), []).append((r[j]["spot"] / x["spot"] - 1) * 100)
                    break
    for cls, fwd in expected.items():
        got = h["by_class"][cls]["horizons"]["30"]
        assert got["n"] == len(fwd), cls
        assert got["up"] == sum(1 for f in fwd if f >= 0.02) and got["down"] == sum(1 for f in fwd if f <= -0.02), cls
        assert got["mean_pct"] == pytest.approx(sum(fwd) / len(fwd), abs=1e-3), cls
    assert set(expected) == {c for c, v in h["by_class"].items() if "30" in v["horizons"]}
    assert "overlap" in h["caution"] and "not evidence of future accuracy" in h["caution"]


def test_scorecard_marks_each_call_by_what_price_did_next_and_counts_only_decided_ones(real: dict) -> None:
    sc = ol.scorecard(real["2026-11-23"], W)
    rows = sc["rows"]
    assert 20 <= len(rows) <= 30  # one every 15 minutes of a 384-minute session
    gaps = [(datetime.fromisoformat(b["at"]) - datetime.fromisoformat(a["at"])).total_seconds() / 60 for a, b in zip(rows, rows[1:], strict=False)]
    assert all(g >= 15 for g in gaps)
    for r in rows:
        if r["result"] in ("hit", "miss"):
            assert r["call"] != 0 and r["forward_pct"] is not None and abs(r["forward_pct"]) >= val.FLAT_BAND_PCT
            assert (r["result"] == "hit") == ((r["forward_pct"] > 0) == (r["call"] > 0))
        if r["result"] == "no call":
            assert r["score"] is not None and abs(r["score"]) < 15
        if r["result"] == "pending":
            assert r["forward_pct"] is None  # the last half hour has no 30-minute outcome yet
    assert sc["hits"] + sc["misses"] == sc["decided"] and sc["hits"] == sum(1 for r in rows if r["result"] == "hit")
    assert rows[-1]["result"] in ("pending", "no call", "no verdict")


def test_phases_split_the_day_and_price_the_ones_to_come() -> None:
    now = datetime(2026, 11, 25, 5, 30, tzinfo=UTC)  # 11:00 IST
    rows = [{"at": (datetime(2026, 11, 25, 3, 46, tzinfo=UTC) + timedelta(minutes=i)).isoformat(), "spot": 25000.0 + i, "engines": {"positioning": 20.0, "orderflow": 20.0, "structure": 20.0}, "metrics": {"trend": {"label": "Trending up", "score": 0.7}}} for i in range(100)]
    ph = ol.phases(rows, W, now=now, live=True, spot=25100.0, iv_pct=16.0)
    assert [p["state"] for p in ph] == ["past", "now", "future", "future", "future"]
    assert ph[0]["rows"] == 59 and ph[0]["trend"] == "Trending up" and ph[0]["move_pct"] == pytest.approx((25058.0 / 25000.0 - 1) * 100, abs=1e-3)  # the rows 09:16 to 10:14 are the opening hour (10:15 starts the morning)
    # 11:00 in the morning phase (10:15-12:00): 60 minutes left; the afternoon is its full 75 minutes
    assert ph[1]["expected_minutes"] == 60 and ph[1]["expected_sd_points"] == pytest.approx(ol.sigma_points(25100.0, 16.0, 60), abs=0.06)
    assert ph[3]["expected_minutes"] == 75
    assert "expected_sd_points" not in ph[0]  # a finished phase is not priced
    after = ol.phases(rows, W, now=now, live=False, spot=25100.0, iv_pct=16.0)
    assert {p["state"] for p in after} == {"past"}


def test_the_grade_of_the_record_is_early_until_twenty_out_of_sample_sessions() -> None:
    folds = [{"test_session": f"2026-11-{16 + i}", "hit_rate": r, "decided": 250} for i, r in enumerate([0.26, 0.59, 0.53, 0.80, 0.70, 0.85])]
    rep = {"walk_forward": {"30m": {"folds": folds, "pooled_out_of_sample": {"hit_rate": 0.667, "hit_rate_ci95": [0.643, 0.690]}}}}
    g = ol.reliability(rep)
    assert g["grade"] == "Early" and g["sessions"] == 6 and g["sessions_above_50"] == 5 and "early evidence" in g["text"]
    many = {"walk_forward": {"30m": {"folds": [{"test_session": f"s{i}", "hit_rate": 0.62, "decided": 250} for i in range(25)], "pooled_out_of_sample": {"hit_rate": 0.62, "hit_rate_ci95": [0.59, 0.65]}}}}
    assert ol.reliability(many)["grade"] == "Established"
    coin = {"walk_forward": {"30m": {"folds": [{"test_session": f"s{i}", "hit_rate": 0.5, "decided": 250} for i in range(25)], "pooled_out_of_sample": {"hit_rate": 0.5, "hit_rate_ci95": [0.47, 0.53]}}}}
    assert ol.reliability(coin)["grade"] == "Not established"
    assert ol.reliability(None)["grade"] == "Not measured"
    assert ol.reliability({"walk_forward": {"30m": {"folds": [], "pooled_out_of_sample": None}}})["grade"] == "Not established"


def test_levels_are_listed_nearest_first_with_their_distance() -> None:
    trend = {"session_mean": 25528.19, "opening_range": {"high": 25990.2, "low": 25670.05}}
    out = ol.levels(25365.05, trend, {"flip": 25221.0, "call_wall": 26000.0, "put_wall": 25000.0}, 25.32)
    assert [x["name"] for x in out] == ["Gamma flip", "Session mean", "Opening-range low", "Put wall", "Opening-range high", "Call wall"]
    mean = next(x for x in out if x["name"] == "Session mean")
    assert mean["distance_points"] == pytest.approx(163.1, abs=0.05) and mean["side"] == "above" and mean["distance_atr"] == pytest.approx(6.44, abs=0.01)
    assert ol.levels(None, None, None, None) == []


def test_the_full_outlook_for_a_finished_real_session_is_complete_and_says_what_it_cannot_do(real: dict) -> None:
    last = real["2026-11-23"][-1]
    summary = {"sentiment": {"score": last["score"], "class": fz.classify(last["score"]), "confidence": 62.0, "coverage": 0.9, "groups_bullish": 0.4, "groups_bearish": 0.3, "reason": None},
               "pulse": {"spot": last["spot"], "atm_iv": 16.9}, "regime": {"name": "Trending"}, "gex": {"flip": 25221.0, "call_wall": 26000.0, "put_wall": 25000.0}}
    rep = {"walk_forward": {"30m": {"folds": [{"test_session": "a", "hit_rate": 0.6, "decided": 100}], "pooled_out_of_sample": {"hit_rate": 0.6, "hit_rate_ci95": [0.55, 0.65]}}}}
    out = ol.build(now=datetime.fromisoformat(last["at"]), session="2026-11-23", live=False, rows=real["2026-11-23"], history_rows=real["2026-11-20"] + real["2026-11-23"], weights=W,
                   summary=summary, trend=None, validation_report=rep)
    assert out["live"] is False and len(out["path"]) == 193 and out["path"][-1]["at"] == last["at"]  # a 384-minute session is thinned to every second minute (192 points) and keeps the last
    assert all(e["sd_points"] is None for e in out["expected"])  # after the close nothing is priced
    assert {p["state"] for p in out["phases"]} == {"past"} and out["reliability"]["grade"] == "Early"
    assert out["read"][0].startswith("Sentiment is") and any("Record of the verdict: Early" in x for x in out["read"])
    assert any("not a forecast" in x for x in out["limits"]) and any("never scored neutral" in x for x in out["limits"])
    # a live session prices the horizons
    live = ol.build(now=datetime(2026, 11, 23, 6, 30, tzinfo=UTC), session="2026-11-23", live=True, rows=real["2026-11-23"][:160], history_rows=real["2026-11-23"], weights=W, summary=summary, trend=None, validation_report=None)
    e = {x["minutes"]: x for x in live["expected"]}
    assert e[30]["sd_points"] == pytest.approx(ol.sigma_points(last["spot"], 16.9, 30), abs=0.06) and e[30]["low"] == pytest.approx(last["spot"] - e[30]["sd_points"], abs=0.06)
    assert live["expected"][-1]["label"] == "To the close" and live["expected"][-1]["minutes"] == 210  # 12:00 IST is 210 minutes before 15:30
    assert live["reliability"]["grade"] == "Not measured"


def test_a_closed_page_reads_the_last_recorded_minute_of_its_session_not_todays_empty_live_summary(real: dict) -> None:
    rows = real["2026-11-23"]
    last = rows[-1]
    empty_live = {"sentiment": {"score": None, "class": "INSUFFICIENT DATA", "confidence": None, "coverage": 0.49, "reason": "3 engines available (need 3)"}, "pulse": {"spot": None, "atm_iv": None}, "gex": {"flip": 25221.0}}
    out = ol.build(now=datetime.fromisoformat(last["at"]), session="2026-11-23", live=False, rows=rows, history_rows=rows, weights=W, summary=empty_live, trend=None, validation_report=None)
    expected = val.rescore(last, W)
    assert out["now"]["score"] == pytest.approx(expected) and out["now"]["class"] == fz.classify(expected) and out["now"]["as_of"] == last["at"]
    assert out["now"]["groups_bullish"] is None and not any("None" in x for x in out["read"])  # a figure the row does not carry is left out, never printed as 0 %
    flip = next(x for x in out["levels"] if x["name"] == "Gamma flip")
    assert flip["distance_points"] == pytest.approx(25221.0 - last["spot"], abs=0.06)  # distances are measured from the session's last recorded spot
    assert out["lag_minutes"] is None


def test_a_live_page_says_how_old_the_newest_recorded_minute_is(real: dict) -> None:
    rows = real["2026-11-23"][:160]
    at = datetime.fromisoformat(rows[-1]["at"])
    summary = {"sentiment": {"score": 20.0, "class": "Mild Bullish", "confidence": 50.0, "coverage": 0.9, "groups_bullish": 0.5, "groups_bearish": 0.1, "reason": None}, "pulse": {"spot": 25000.0, "atm_iv": 16.0}}
    out = ol.build(now=at + timedelta(minutes=7), session="2026-11-23", live=True, rows=rows, history_rows=rows, weights=W, summary=summary, trend=None, validation_report=None, clock=at + timedelta(minutes=7))
    assert out["lag_minutes"] == 7.0 and out["last_recorded_at"] == rows[-1]["at"] and out["now"]["score"] == 20.0  # live tiles keep the live summary
