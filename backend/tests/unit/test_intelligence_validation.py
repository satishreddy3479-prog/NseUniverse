"""Walk-forward validation of stored sentiment snapshots: chronology, no look-ahead, missing outcomes, changing layouts, sample-size honesty."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.intelligence import validation as vd

DAY0 = datetime(2026, 11, 2, 4, 0, tzinfo=UTC)  # 09:30 IST


def row(day: int, minute: int, spot: float, score: float | None, *, arch: int | None = vd.ARCH, engines: dict[str, float | None] | None = None, conf: float = 70.0, cov: float = 0.9) -> dict[str, Any]:
    t = DAY0 + timedelta(days=day, minutes=minute)
    return {"session": t.date().isoformat(), "at": t.isoformat(), "spot": spot, "score": score, "confidence": conf, "coverage": cov, "engines": engines or {},
            "metrics": {} if arch is None else {"arch": arch}}


def session(day: int, scores: list[float | None], start: float = 24000.0, step: float = 5.0) -> list[dict[str, Any]]:
    """One row a minute, spot rising by ``step`` a minute."""
    return [row(day, m, start + step * m, s) for m, s in enumerate(scores)]


def test_forward_return_reads_only_a_later_row_near_the_horizon() -> None:
    rows = session(0, [30.0] * 100)
    out = vd.outcomes(rows, "15m")
    assert out[0]["forward_pct"] == pytest.approx((24000 + 5 * 15) / 24000 * 100 - 100, abs=1e-4)  # 24075 / 24000 - 1 = 0.3125 %
    assert out[90]["forward_pct"] is None and "no stored row" in out[90]["reason"]  # nothing 15 minutes after minute 90: left unlabelled, not interpolated
    assert [o["at"] for o in out] == sorted(o["at"] for o in out)


def test_a_recording_gap_leaves_the_outcome_missing_instead_of_inventing_one() -> None:
    rows = [r for r in session(0, [30.0] * 100) if not 10 <= (datetime.fromisoformat(r["at"]) - DAY0).total_seconds() / 60 < 45]
    out = vd.outcomes(rows, "15m")
    assert out[0]["forward_pct"] is None  # minute 0: its target (minute 15) falls in the gap; the next row is minute 45, far outside the tolerance


def test_end_of_session_and_next_session_outcomes_are_taken_from_the_right_rows() -> None:
    d0, d1 = session(0, [30.0] * 60), session(1, [30.0] * 60, start=24500.0)
    eos = vd.outcomes(d0 + d1, "end_of_session")
    assert eos[0]["forward_pct"] == pytest.approx((24000 + 5 * 59) / 24000 * 100 - 100, abs=1e-4) and eos[55]["forward_pct"] is None  # under 10 minutes left
    nxt = vd.outcomes(d0 + d1, "next_session")
    assert nxt[0]["forward_pct"] == pytest.approx((24500 + 5 * 59) / 24000 * 100 - 100, abs=1e-4)  # day 1 last spot against the day 0 snapshot
    assert nxt[-1]["forward_pct"] is None and nxt[-1]["reason"] == "no later session recorded"
    far = vd.outcomes(d0 + session(20, [30.0] * 60), "next_session")
    assert far[0]["forward_pct"] is None and "more than 5 days" in far[0]["reason"]


def test_hit_rate_counts_neutral_and_flat_separately_and_needs_a_sample() -> None:
    rows = session(0, [40.0] * 100)  # bullish all day while spot rises: every labelled call is a hit
    full = vd.evaluate(rows, "15m")
    assert full["decided"] == 85 and full["hit_rate"] == 1.0 and full["hit_rate_ci95"][0] > 0.9  # minutes 0..84 have a row 15 minutes later
    few = vd.evaluate(session(0, [40.0] * 40), "15m")  # 25 labelled calls: under the 30 needed
    assert few["decided"] == 25 and few["hit_rate"] is None and few["verdict"].startswith("insufficient sample")
    neutral = vd.evaluate(session(0, [5.0] * 100), "15m")
    assert neutral["calls"] == 0 and neutral["hit_rate"] is None
    flat = vd.evaluate([row(0, m, 24000.0, 40.0) for m in range(100)], "15m")
    assert flat["flat_outcomes"] == flat["calls"] and flat["decided"] == 0  # spot never moved: no direction to match


def test_a_wrong_sign_is_counted_as_a_miss() -> None:
    falling = [row(0, m, 24000.0 - 5 * m, 40.0) for m in range(100)]  # bullish score, falling spot
    r = vd.evaluate(falling, "15m")
    assert r["hit_rate"] == 0.0 and r["hits"] == 0


def test_rows_of_another_group_layout_are_excluded_not_mixed() -> None:
    old = [row(0, m, 24000.0 + 5 * m, 40.0, arch=None) for m in range(100)]
    new = session(1, [40.0] * 100)
    r = vd.evaluate(old + new, "15m")
    assert r["other_architecture_excluded"] == 100 and r["snapshots"] == 100


def test_rescore_renormalises_over_the_groups_a_row_has() -> None:
    w = {"positioning": 30.0, "orderflow": 20.0, "volatility": 10.0, "structure": 20.0, "participation": 20.0}
    full = {"positioning": 40.0, "orderflow": 20.0, "volatility": -10.0, "structure": 30.0, "participation": 31.0}
    assert vd.rescore({"engines": full}, w) == pytest.approx((40 * 30 + 20 * 20 - 10 * 10 + 30 * 20 + 31 * 20) / 100)
    partial = {"positioning": 40.0, "orderflow": None}  # a missing group is left out, never scored zero
    assert vd.rescore({"engines": partial}, w) == 40.0
    assert vd.rescore({"engines": {}}, w) is None
    assert vd.rescore({"engines": full}, {**w, "positioning": 0.0}) == pytest.approx((20 * 20 - 10 * 10 + 30 * 20 + 31 * 20) / 70)


def test_alternative_weights_can_be_tested_on_stored_history() -> None:
    rows = [row(0, m, 24000.0 + 5 * m, -40.0, engines={"positioning": -40.0, "orderflow": 80.0}) for m in range(100)]  # stored score bearish, orderflow bullish
    stored = vd.evaluate(rows, "15m")
    flipped = vd.evaluate(rows, "15m", scorer=lambda r: vd.rescore(r, {"positioning": 10.0, "orderflow": 90.0}))
    assert stored["hit_rate"] == 0.0 and flipped["hit_rate"] == 1.0


def test_walk_forward_scores_each_session_with_only_earlier_ones_and_never_the_first_sessions() -> None:
    rows: list[dict[str, Any]] = []
    for d in range(6):
        rows += session(d, [40.0] * 100, start=24000.0 + 100 * d)
    wf = vd.walk_forward(rows, "15m", min_train_sessions=3)
    assert wf["enough_history"] is True and [f["test_session"] for f in wf["folds"]] == sorted(f["test_session"] for f in wf["folds"])
    assert len(wf["folds"]) == 3 and wf["folds"][0]["train_sessions"] == wf["sessions"][:3] and wf["folds"][0]["test_session"] == wf["sessions"][3]
    assert all(f["test_session"] not in f["train_sessions"] for f in wf["folds"])
    assert wf["pooled_out_of_sample"]["hit_rate"] == 1.0 and wf["pooled_out_of_sample"]["decided"] == 3 * 85
    assert "out-of-sample" in wf["note"]
    short = vd.walk_forward(rows[:100], "15m")
    assert short["folds"] == [] and short["enough_history"] is False


def test_a_fitted_scorer_only_sees_earlier_sessions() -> None:
    rows: list[dict[str, Any]] = []
    for d in range(5):
        rows += session(d, [40.0] * 100, start=24000.0 + 100 * d)
    seen: list[list[str]] = []

    def fit(train: Any) -> Any:
        seen.append(sorted({r["session"] for r in train}))
        return lambda r: r["score"]

    wf = vd.walk_forward(rows, "15m", min_train_sessions=2, fit=fit)
    assert [s[-1] for s in seen] == [f["train_sessions"][-1] for f in wf["folds"]]
    assert all(max(s) < f["test_session"] for s, f in zip(seen, wf["folds"], strict=True))
    assert wf["pooled_out_of_sample"] is None  # pooled figures are given only for the unfitted provisional score


def test_low_coverage_snapshots_can_be_left_out() -> None:
    rows = [row(0, m, 24000.0 + 5 * m, 40.0, cov=0.4 if m < 50 else 0.9) for m in range(100)]
    r = vd.evaluate(rows, "15m", min_coverage=0.55)
    assert r["below_min_coverage"] == 50


def test_wilson_and_pearson_on_known_values() -> None:
    ci = vd.wilson(50, 100)
    assert ci is not None and ci[0] == pytest.approx(0.4038, abs=1e-3) and ci[1] == pytest.approx(0.5962, abs=1e-3)
    assert vd.wilson(0, 0) is None
    assert vd.pearson([1, 2, 3, 4], [2, 4, 6, 8]) == 1.0 and vd.pearson([1, 2, 3], [3, 2, 1]) == -1.0 and vd.pearson([1, 1, 1], [1, 2, 3]) is None


def test_report_covers_every_horizon_and_states_its_rules() -> None:
    rep = vd.report(session(0, [40.0] * 100) + session(1, [40.0] * 100), weights={"positioning": 1.0})
    assert set(rep["by_horizon"]) == set(vd.HORIZONS) == {"15m", "30m", "60m", "end_of_session", "next_session"}
    assert any("look-ahead" in r for r in rep["rules"]) and any("not a claim of predictive accuracy" in r for r in rep["rules"])
    with pytest.raises(ValueError, match="unknown horizon"):
        vd.outcomes([], "1d")
