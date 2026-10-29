"""Barrier labels, metrics, baselines, chronological validation and the probability gate.

Paths and rows are SYNTHETIC with hand-calculated answers (formula checks), not market data. The evaluation runs on
real stored sessions through /api/intraday/research once they exist; with fewer than the required sessions it must say so.
"""

from __future__ import annotations

import math
import random
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.intraday import evaluate as ev
from app.intraday import labels as lb
from app.intraday.features import Point
from tests.conftest import make_app

IST = ZoneInfo("Asia/Kolkata")
T0 = datetime(2026, 10, 29, 9, 30, tzinfo=IST)


def path(spots: list[float], minutes: list[float] | None = None) -> list[Point]:
    mins = minutes if minutes is not None else list(range(len(spots)))
    return [Point(T0 + timedelta(minutes=m), s) for m, s in zip(mins, spots, strict=True)]


# --------------------------------------------------------------------------------------- barrier labels
def test_barrier_width_is_a_volatility_multiple_known_at_the_prediction_time() -> None:
    # 0.5 x 1 % daily sd x sqrt(15/375) = 0.5 x 0.01 x 0.2 -> 0.1 % of 24000 = 24 points
    assert lb.barrier_pts(24000, 1.0, 15) == pytest.approx(24.0)
    assert lb.barrier_pts(24000, 1.0, 60) == pytest.approx(0.5 * 0.01 * math.sqrt(60 / 375) * 24000)


def test_up_down_none_outcomes_with_time_and_excursions() -> None:
    up = path([24000, 24005, 24010, 24026, 24030] + [24030] * 12)
    r = lb.label_at(up, 0, 15, 1.0)
    assert (r["outcome"], r["minutes_to_touch"], r["mfe_pts"], r["mae_pts"]) == ("up", 3.0, 26.0, 0.0)
    dn = path([24000, 23995, 23990, 23975] + [23975] * 13)
    assert lb.label_at(dn, 0, 15, 1.0)["outcome"] == "down"
    flat = path([24000, 24010, 23990, 24005] + [24000] * 13)  # stays inside +/-24 for the whole horizon
    r = lb.label_at(flat, 0, 15, 1.0)
    assert r["outcome"] == "none" and r["mfe_pts"] == 10.0 and r["mae_pts"] == -10.0
    assert lb.label_at(path([24000, 24030] + [24030] * 14), 0, 15, 1.0)["outcome"] == "up"  # first sample after t may already touch


def test_ambiguous_and_missing_are_never_resolved_in_favour_of_a_side() -> None:
    gap = path([24000, 24001, 24002, 24030] + [24030] * 5, [0, 1, 2, 9, 10, 11, 12, 13, 15])  # 7-minute gap before the touch
    r = lb.label_at(gap, 0, 15, 1.0)
    assert r["outcome"] == "ambiguous" and "gap" in r["reason"]
    short = path([24000, 24001, 24002] + [24003] * 7)  # ends at minute 9 of a 15-minute horizon
    assert lb.label_at(short, 0, 15, 1.0)["outcome"] == "missing"
    assert lb.label_at(path([24000]), 0, 15, 1.0)["outcome"] == "missing"  # nothing after t
    assert lb.label_at(path([24000] * 17), 0, 15, None)["outcome"] == "missing"  # no volatility scale: no barrier


def test_a_label_reads_only_the_future_of_its_sample() -> None:
    base = path([24000, 24005, 24010, 24026] + [24030] * 13)
    changed_past = path([23000, 25000] + [24000, 24005, 24010, 24026] + [24030] * 13)
    a = lb.label_at(base, 0, 15, 1.0)
    b = lb.label_at(changed_past, 2, 15, 1.0)  # same sample, different history before it
    assert a == b
    beyond = path([24000, 24005, 24010, 24026] + [24030] * 12 + [20000])  # a sample after the horizon ends does not matter
    assert lb.label_at(beyond, 0, 15, 1.0)["outcome"] == "up"
    labelled = lb.label_session(base, 1.0, horizons=(5, 15))
    assert set(labelled) == {p.at.isoformat() for p in base} and set(next(iter(labelled.values()))) == {5, 15}


# --------------------------------------------------------------------------------------- metrics
def test_log_loss_brier_and_confusion_by_hand() -> None:
    probs, outs = [[0.5, 0.3, 0.2]], ["up"]
    assert ev.log_loss(probs, outs) == pytest.approx(-math.log(0.5))
    assert ev.brier(probs, outs) == pytest.approx(0.25 + 0.09 + 0.04)  # (0.5-1)^2 + 0.3^2 + 0.2^2
    p2 = [[0.6, 0.3, 0.1], [0.2, 0.7, 0.1], [0.3, 0.3, 0.4], [0.8, 0.1, 0.1]]
    o2 = ["up", "down", "none", "down"]
    s = ev.accuracy_stats(p2, o2)
    assert s["accuracy"] == 0.75 and s["confusion"]["down"] == {"up": 1, "down": 1, "none": 0}
    assert s["recall"] == {"up": 1.0, "down": 0.5, "none": 1.0} and s["balanced_accuracy"] == pytest.approx((1 + 0.5 + 1) / 3)
    assert s["precision"]["up"] == 0.5  # two predicted up, one right


def test_calibration_of_a_perfectly_calibrated_and_an_overconfident_forecast() -> None:
    # ten forecasts of 0.8 for "up": eight come true -> the 0.8-0.9 bin observes 0.8; the other two classes get 0.1 each, observed 0
    probs = [[0.8, 0.1, 0.1]] * 10
    outs = ["up"] * 8 + ["down"] + ["none"]
    c = ev.calibration(probs, outs)
    bin_up = next(b for b in c["bins"] if b["bin"] == "0.8-0.9")
    assert bin_up["observed"] == 0.8 and bin_up["n"] == 10
    over = ev.calibration([[0.9, 0.05, 0.05]] * 10, ["up"] * 5 + ["down"] * 5)
    assert over["ece"] > c["ece"]


# --------------------------------------------------------------------------------------- walk-forward
def synth(sessions: int, signal: bool, seed: int = 1) -> list[dict]:
    rng = random.Random(seed)
    rows = []
    for s in range(sessions):
        for _ in range(120):
            x = rng.gauss(0, 1)
            o = ("up" if x > 0.5 else "down" if x < -0.5 else "none") if signal else rng.choice(ev.CLASSES)
            rows.append({"session": f"2026-10-{10 + s:02d}", "features": {"ret_15m": x, "ret_5m": rng.gauss(0, 1)}, "outcome": o})
    return rows


def test_too_few_sessions_gives_no_result_instead_of_a_number() -> None:
    r = ev.walk_forward(synth(3, True), 3)
    assert r["status"] == "insufficient" and "models" not in r and "needs more than 3" in r["reason"]


def test_a_session_is_only_predicted_by_models_fitted_on_earlier_sessions(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[tuple[set[str], str]] = []
    real = ev.majority

    def spy(train: list[dict]):  # records which sessions the baseline was fitted on
        seen.append(({r["session"] for r in train}, ""))
        return real(train)

    monkeypatch.setattr(ev, "majority", spy)
    rows = synth(6, True)
    ev.walk_forward(rows, 3)
    ordered = sorted({r["session"] for r in rows})
    assert [s[0] for s in seen] == [set(ordered[:3]), set(ordered[:4]), set(ordered[:5])]  # expanding window, never the test day or later


def test_a_real_signal_beats_the_baselines_and_noise_does_not_pass_the_gate() -> None:
    sig = ev.walk_forward(synth(8, True), 3)
    m = sig["models"]
    assert m["logistic"]["log_loss"] < m["majority"]["log_loss"] and m["logistic"]["log_loss"] < m["momentum"]["log_loss"] + 0.4
    assert m["majority"]["log_loss"] == pytest.approx(math.log(3), abs=0.05)  # a three-way coin
    assert sig["gate"]["status"] == "experimental" and sig["gate"]["show_probabilities"] is False  # 8 sessions: never validated
    assert any("only 8 labelled sessions" in x for x in sig["gate"]["reasons"]) and sig["gate"]["label"].startswith("EXPERIMENTAL MODEL")
    noise = ev.walk_forward(synth(8, False), 3)
    assert noise["gate"]["show_probabilities"] is False
    assert noise["models"]["logistic"]["log_loss"] >= noise["models"]["majority"]["log_loss"] - 0.05  # no edge to find


def test_the_gate_validates_only_with_enough_sessions_a_clear_edge_and_calibration() -> None:
    base = {"sessions": 25, "models": {"logistic": {"calibration": {"ece": 0.03}}, "majority": {}}, "per_session_log_loss": [{"logistic": 0.5, "majority": 1.0}] * 5}
    assert ev.gate(base)["status"] == "validated" and ev.gate(base)["show_probabilities"] is True
    assert ev.gate(base | {"sessions": 12})["status"] == "experimental"
    assert ev.gate(base | {"sessions": 3})["status"] == "insufficient"
    worse = base | {"per_session_log_loss": [{"logistic": 1.2, "majority": 1.0}] * 5}
    assert ev.gate(worse)["show_probabilities"] is False and any("beat every baseline" in x for x in ev.gate(worse)["reasons"])
    miscal = base | {"models": {"logistic": {"calibration": {"ece": 0.2}}, "majority": {}}}
    assert ev.gate(miscal)["show_probabilities"] is False


def test_missing_features_are_imputed_from_training_only_and_flagged() -> None:
    rows = [{"session": "s", "features": {"ret_15m": None if i % 4 == 0 else float(i % 5 - 2)}, "outcome": ev.CLASSES[i % 3]} for i in range(60)]
    pred = ev.logistic(rows, ("ret_15m",), iters=20)
    p = pred({"ret_15m": None})
    assert len(p) == 3 and sum(p) == pytest.approx(1.0) and all(x > 0 for x in p)  # normalised, non-negative


# --------------------------------------------------------------------------------------- api
def test_research_endpoint_reports_insufficient_data_and_validates_input(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path)) as c:
        r = c.get("/api/intraday/research", params={"horizon": 15})
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "insufficient" and body["sessions"] == 0 and body["horizon_minutes"] == 15
        assert c.get("/api/intraday/research", params={"horizon": 7}).status_code == 422
        assert c.get("/api/intraday/research", params={"k": 5}).status_code == 422
