"""Early-turn watch (app/intelligence/turn.py) on the real stored timelines of 11 and 12 Nov 2026 and on hand-built series."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from app.intelligence import turn

FIX = json.loads((Path(__file__).parent.parent / "fixtures" / "intelligence_timeline_turn.json").read_text(encoding="utf-8"))


def _ist(at: str) -> str:
    return (datetime.fromisoformat(at) + timedelta(hours=5, minutes=30)).strftime("%H:%M")


def _row(i: int, **eng: float | None) -> dict[str, Any]:
    e = {k: 0.0 for k in turn.ENGINES}
    e.update(eng)
    return {"at": f"2026-11-12T04:{i:02d}:00+00:00" if i < 60 else f"2026-11-12T05:{i - 60:02d}:00+00:00", "spot": 25000.0, "score": 0.0, "engines": e}


def test_smoothed_change_hand_calculation() -> None:
    # 26 minutes: 0 for the first 6, then rising by 1 per minute; now = mean of last 5 (21..25 -> 23), then = mean of minutes 1..5 (0) => 23
    s: list[float | None] = [0.0] * 6 + [float(k) for k in range(1, 21)]
    now, chg = turn.smoothed_change(s)
    assert now == sum(s[-5:]) / 5
    assert chg == now - sum(s[-25:-20]) / 5
    assert turn.smoothed_change(s[:10]) == (None, None)  # too short: no figure rather than a guess


def test_unavailable_with_few_rows_says_why() -> None:
    out = turn.assess_at([_row(i) for i in range(10)])
    assert out["available"] is False and "stored minutes" in out["reason"]


def test_missing_readings_are_skipped_not_zero() -> None:
    rows = [_row(i, structure=None, participation=None) for i in range(40)]
    out = turn.assess_at(rows)
    assert out["available"] and out["signals"] == []  # no flow reading: no flow signal


def test_one_minute_spike_does_not_fire() -> None:
    rows = [_row(i) for i in range(40)]
    rows[-1] = _row(39, structure=-90.0, participation=-90.0)
    assert turn.assess_at(rows)["signals"] == []  # smoothing and persistence keep one odd minute quiet


def test_sustained_flow_decline_fires_bearish_and_marks_early_when_price_flat() -> None:
    rows = [_row(i, structure=40.0, participation=30.0, positioning=40.0) for i in range(60)]
    for k in range(60, 72):
        rows.append(_row(k, structure=10.0, participation=0.0, positioning=40.0))
    out = turn.assess_at(rows)
    ids = {s["id"]: s for s in out["signals"]}
    assert "flow_turn_down" in ids and out["lean"] == "bearish"
    assert ids["flow_turn_down"]["early"] is True  # spot did not move
    assert any("still" in e and "bullish" not in e for e in ids["flow_turn_down"]["evidence"])  # states that OI levels still read +40


def test_12_nov_fall_is_flagged_before_most_of_it_happened() -> None:
    rows = FIX["2026-11-12"]
    # the morning had an earlier episode (10:19-10:32) that price did not follow; the second one starts as the real fall begins
    first = next(r for r in turn.replay(rows) if _ist(r["at"]) >= "10:55" and any(s["id"] == "flow_turn_down" for s in r["signals"]))
    assert "11:00" <= _ist(first["at"]) <= "11:15"
    assert first["spot"] > 25300  # NIFTY still within 60 points of the 10:45 high; the low was 25,217
    # nothing leaning bullish while the fall was under way
    for r in turn.replay(rows):
        if "11:00" <= _ist(r["at"]) <= "12:20":
            assert r["lean"] != "bullish"


def test_replay_keeps_false_alarms_visible() -> None:
    """11 Nov had a flow-down signal at 10:09 that price then reversed: the replay shows it (an honest in-sample count, not hidden)."""
    rows = FIX["2026-11-11"]
    fired = [r for r in turn.replay(rows) if any(s["id"] == "flow_turn_down" for s in r["signals"])]
    assert any(_ist(r["at"]).startswith("10:") for r in fired)
    assert len({_ist(r["at"])[:2] for r in fired}) <= 5  # a handful of episodes in a day, not a constant stream
