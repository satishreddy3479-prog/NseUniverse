"""The stored summary of the intraday model research: what it keeps, that it round-trips, and that it runs once a day after the close only."""

from __future__ import annotations

import random
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from app.intraday import evaluate, mldigest

IST = ZoneInfo("Asia/Kolkata")


def _rows(sessions: int, per: int = 40) -> list[dict[str, object]]:
    rnd = random.Random(4)
    out = []
    for s in range(sessions):
        for _ in range(per):
            x = rnd.gauss(0, 1)
            out.append({"session": f"2026-10-{10 + s:02d}", "features": {"ret_5m": x, "ret_15m": rnd.gauss(0, 1), "minutes_since_open": float(rnd.randint(15, 360))}, "outcome": rnd.choice(["up", "down", "none"])})
    return out


def test_the_digest_keeps_scores_the_gate_and_its_reasons_and_nothing_else() -> None:
    res = evaluate.walk_forward(_rows(8), stride=2, group_tests=True)
    d = mldigest.digest(res, 15, 0.5, datetime(2026, 11, 10, 16, 0, tzinfo=IST))
    assert d["horizon_minutes"] == 15 and d["barrier_k"] == 0.5 and d["sessions"] == 8 and d["test_sessions"] == 5
    assert {"majority", "momentum", "opening_range", "logistic"} <= set(d["models"]) and all({"log_loss", "brier", "n", "ece"} <= set(m) for m in d["models"].values())
    assert d["best_baseline_log_loss"] == min(d["models"][b]["log_loss"] for b in ("majority", "momentum", "opening_range"))
    assert d["model_log_loss_gain"] == round(d["best_baseline_log_loss"] - d["models"]["logistic"]["log_loss"], 5)
    assert d["gate"]["show_probabilities"] is False and d["gate"]["reasons"]  # eight random sessions can never pass the gate
    assert d["status"] in ("experimental", "insufficient") and "per_session_log_loss" not in d and "calibration" not in d["models"]["logistic"]


def test_too_little_data_is_reported_with_its_reason() -> None:
    res = evaluate.walk_forward(_rows(2))
    d = mldigest.digest(res, 15, 0.5, datetime(2026, 11, 10, 16, 0, tzinfo=IST))
    assert d["status"] == "insufficient" and "labelled sessions" in d["reason"] and d["models"] == {} and d["model_log_loss_gain"] is None and d["gate"]["show_probabilities"] is False


def test_the_file_round_trips_and_a_missing_or_broken_file_is_none(tmp_path: Path) -> None:
    assert mldigest.load(tmp_path) is None
    mldigest.save(tmp_path, {"computed_at": "2026-11-10T16:00:00+05:30", "status": "experimental"})
    assert mldigest.load(tmp_path) == {"computed_at": "2026-11-10T16:00:00+05:30", "status": "experimental"}
    (tmp_path / mldigest.FILE).write_text("{not json", encoding="utf-8")
    assert mldigest.load(tmp_path) is None


def test_the_evaluation_is_due_once_a_session_day_and_only_after_the_close() -> None:
    last = {"computed_at": "2026-11-09T16:00:00+05:30"}
    assert mldigest.due(None, datetime(2026, 11, 10, 16, 0, tzinfo=IST)) is True
    assert mldigest.due(last, datetime(2026, 11, 10, 16, 0, tzinfo=IST)) is True  # yesterday's result: a new day
    assert mldigest.due(last, datetime(2026, 11, 10, 11, 0, tzinfo=IST)) is False  # market hours: never
    assert mldigest.due({"computed_at": "2026-11-10T15:50:00+05:30"}, datetime(2026, 11, 10, 18, 0, tzinfo=IST)) is False  # already done today
    assert mldigest.due(last, datetime(2026, 11, 14, 18, 0, tzinfo=IST)) is False  # Saturday
    assert mldigest.due({"nonsense": 1}, datetime(2026, 11, 10, 16, 0, tzinfo=IST)) is True  # an unreadable record is recomputed
