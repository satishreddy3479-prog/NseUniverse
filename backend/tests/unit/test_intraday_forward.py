from datetime import UTC, datetime, timedelta

from app.intraday.forward import MIN_SESSIONS, forward_returns, score_forward


def _rows(spots: list[float], scores: list[float], start: datetime = datetime(2026, 10, 29, 4, 0, tzinfo=UTC)) -> list[dict[str, object]]:
    return [{"sample_utc": (start + timedelta(minutes=i)).isoformat(), "spot": s, "score": sc} for i, (s, sc) in enumerate(zip(spots, scores, strict=True))]


def test_forward_return_reads_only_later_samples_and_needs_coverage() -> None:
    spots = [100.0 + i for i in range(40)]  # +1 point a minute
    f = forward_returns(_rows(spots, [0.0] * 40), 15)
    assert f[0] == (115.0 / 100.0 - 1) * 100  # sample 15 minutes later
    assert f[24] == (139.0 / 124.0 - 1) * 100
    assert f[27] is not None  # the last sample is 3 minutes before the target: still inside the slack
    assert f[28] is None and f[39] is None  # the path ends too long before those horizons: missing, not zero


def test_a_gap_longer_than_the_slack_leaves_the_return_missing() -> None:
    rows = _rows([100.0, 101.0, 102.0], [0.0, 0.0, 0.0])
    rows[1]["sample_utc"] = (datetime(2026, 10, 29, 4, 0, tzinfo=UTC) + timedelta(minutes=2)).isoformat()
    rows[2]["sample_utc"] = (datetime(2026, 10, 29, 4, 0, tzinfo=UTC) + timedelta(minutes=30)).isoformat()
    assert forward_returns(rows, 15)[0] is None  # nothing stored within 3 minutes before t+15


def test_groups_hand_calculation_and_no_conclusion_before_enough_sessions() -> None:
    # 20 minutes up 1 point/min from 100: scores +0.5 for the first 5 rows (bullish), -0.5 for the next 5 (bearish), 0 after
    spots = [100.0 + i for i in range(40)]
    scores = [0.5] * 5 + [-0.5] * 5 + [0.0] * 30
    r = score_forward({"2026-10-29": _rows(spots, scores)})
    h = r["horizons"]["15"]
    assert h["bullish"]["n"] == 5 and h["bearish"]["n"] == 5
    assert h["bullish"]["share_up"] == 1.0  # the path only rises
    expected = sum((100.0 + i + 15) / (100.0 + i) - 1 for i in range(5)) / 5 * 100
    assert abs(h["bullish"]["mean_fwd_pct"] - round(expected, 4)) < 1e-4
    assert r["conclusion"] == f"no conclusion: 1 session(s) stored, {MIN_SESSIONS} needed"


def test_missing_scores_are_skipped_not_counted_as_neutral() -> None:
    spots = [100.0 + i for i in range(40)]
    r = score_forward({"d": _rows(spots, [None] * 40)})  # type: ignore[list-item]
    assert r["horizons"]["15"]["all"]["n"] == 0 and r["sessions"] == 0
