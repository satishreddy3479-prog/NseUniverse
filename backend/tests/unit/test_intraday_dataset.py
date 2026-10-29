"""The labelled intraday dataset: features see only the past, labels only the future.

Spot paths are small hand-built sequences (formula checks); the option chain is the REAL captured Kotak chain.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

from app.intraday.dataset import FEATURE_VERSION, HORIZONS, WARMUP_SAMPLES, build_rows, labels_for
from app.intraday.features import DailyContext, Point
from app.intraday.store import IntradayStore
from tests.unit.test_intraday import as_chain, ist, real_chain

DAY, EXPIRY = date(2026, 10, 29), date(2026, 11, 3)
CTX = DailyContext(date(2026, 10, 28), 22778.0, 22497.0, 22698.85, 0.705, 1.4, 60)
CHAIN = as_chain(real_chain(ist(9, 20), "c1"))


def pts(values: list[float], start: datetime | None = None) -> list[Point]:
    t0 = start or ist(9, 15)
    return [Point(t0 + timedelta(minutes=i), v) for i, v in enumerate(values)]


def rows_of(points: list[Point]) -> list[dict]:
    return build_rows(points, lambda i: CHAIN, 22698.85, CTX, EXPIRY, DAY)


WALK = [22700 + i * 0.5 + (3 if i % 3 else -2) for i in range(120)]  # 09:15..11:14, a noisy rise


def test_warmup_rows_are_not_emitted() -> None:
    assert rows_of(pts(WALK[: WARMUP_SAMPLES])) == []
    assert len(rows_of(pts(WALK[: WARMUP_SAMPLES + 1]))) == 1


def test_labels_are_hand_calculated_forward_returns() -> None:
    p = pts(WALK)
    r = rows_of(p)
    i = 30  # row for sample index 30 = 09:45
    row = r[i - WARMUP_SAMPLES]
    assert row["sample_utc"] == p[i].at.isoformat() and row["spot"] == p[i].spot
    for h in (5, 15, 30, 60):
        want = (p[i + h].spot / p[i].spot - 1) * 100
        assert row["labels"][f"fwd_{h}m"] == pytest.approx(want, abs=1e-6)
    assert row["labels"]["fwd_close"] is None  # the session did not run to 15:25 in this test


def test_a_label_without_a_sample_near_its_target_is_missing_not_filled() -> None:
    p = pts(WALK)
    last = labels_for(p, len(p) - 1)
    assert all(v is None for v in last.values())  # nothing after the last sample
    near_end = labels_for(p, len(p) - 10)  # 10 minutes of future: 5 and (maybe) 15?
    assert near_end["fwd_5m"] is not None and near_end["fwd_15m"] is None and near_end["fwd_60m"] is None


def test_close_label_needs_a_sample_at_or_after_1525() -> None:
    vals = [22700 + 0.1 * i for i in range(375)]
    p = pts(vals)  # 09:15 .. 15:29
    row = rows_of(p)[0]
    assert row["labels"]["fwd_close"] == pytest.approx((vals[-1] / vals[WARMUP_SAMPLES] - 1) * 100, abs=1e-6)
    short = rows_of(pts(vals[:300]))[0]  # ends 14:14
    assert short["labels"]["fwd_close"] is None


def test_features_never_change_when_the_future_changes() -> None:
    """Leakage guard: rebuild with a wildly different future; every feature of every earlier row is identical."""
    p = pts(WALK)
    base = rows_of(p)
    for cut in (40, 70, 100):
        altered = p[:cut] + [Point(q.at, q.spot * 1.05 + (-1) ** k * 40) for k, q in enumerate(p[cut:])]
        again = rows_of(altered)
        for a, b in zip(base[: cut - WARMUP_SAMPLES], again[: cut - WARMUP_SAMPLES], strict=True):
            assert a["features"] == b["features"]
            assert a["sample_utc"] == b["sample_utc"]
        # ... while the labels of the rows just before the cut DO see the new future
        assert base[cut - WARMUP_SAMPLES - 1]["labels"] != again[cut - WARMUP_SAMPLES - 1]["labels"]


def test_row_features_equal_the_features_computed_on_a_truncated_day() -> None:
    p = pts(WALK)
    full = rows_of(p)
    for i in (20, 55, 90):
        truncated = rows_of(p[: i + 1])
        assert truncated[-1]["features"] == full[i - WARMUP_SAMPLES]["features"]


def test_chain_is_only_requested_for_the_present_or_the_first_sample() -> None:
    asked: list[int] = []
    p = pts(WALK[:40])

    def chain_at(i: int):
        asked.append(i)
        return CHAIN

    build_rows(p, chain_at, 22698.85, CTX, EXPIRY, DAY)
    assert asked[0] == 0 and sorted(set(asked[1:])) == list(range(WARMUP_SAMPLES, 40))  # never an index from the future of its row
    for k, row_index in enumerate(asked[1:]):
        assert row_index == WARMUP_SAMPLES + k


def test_missing_option_data_stays_missing() -> None:
    r = build_rows(pts(WALK[:30]), lambda i: {}, None, DailyContext(), EXPIRY, DAY)[0]["features"]
    assert r["pcr_oi"] is None and r["straddle_pct_of_spot"] is None and r["oi_imbalance"] is None
    assert r["gap_pct"] is None  # no previous close -> no gap, not 0


def test_features_have_the_documented_clock_fields() -> None:
    row = rows_of(pts(WALK))[0]["features"]
    assert row["minutes_since_open"] == 15 and row["minutes_to_close"] == 360
    assert row["weekday"] == 3 and row["days_to_expiry"] == 5  # Thursday; 3 Nov is 5 days away


def test_store_is_append_only_and_idempotent(tmp_path: Path) -> None:
    import sqlite3

    st = IntradayStore(tmp_path)
    rows = rows_of(pts(WALK[:40]))
    assert st.record_features("2026-10-29", "2026-11-03", FEATURE_VERSION, rows) == len(rows)
    assert st.record_features("2026-10-29", "2026-11-03", FEATURE_VERSION, rows) == 0
    assert st.feature_sessions(FEATURE_VERSION) == {"2026-10-29": len(rows)}
    db = sqlite3.connect(st.path)
    with pytest.raises(sqlite3.DatabaseError, match="never changed"):
        db.execute("UPDATE feature_rows SET spot = 1")
    with pytest.raises(sqlite3.DatabaseError, match="never deleted"):
        db.execute("DELETE FROM feature_rows")
    db.close()
    assert set(HORIZONS) == {5, 15, 30, 60}
