"""Price-structure turn flag, the verdict cap and the trend fade guard on the real stored sessions of 11-25 Nov 2026 (fixtures/intelligence_sessions_2026-11.json:
per-minute spot and group scores copied from the server's timeline) and on hand-built series with hand-calculated values."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from app.intelligence import fusion as fz
from app.intelligence import outlook
from app.intelligence import pullback as pb
from app.intelligence import trend_engine as te
from app.intelligence import validation as val

SESSIONS: dict[str, list[dict[str, Any]]] = json.loads((Path(__file__).parent.parent / "fixtures" / "intelligence_sessions_2026-11.json").read_text(encoding="utf-8"))
IST = timezone(timedelta(hours=5, minutes=30))


def _hhmm(at: str) -> str:
    return datetime.fromisoformat(at).astimezone(IST).strftime("%H:%M")


def _synthetic(spots: list[float | None], start: str = "2026-11-25T03:45:00+00:00") -> list[dict[str, Any]]:
    t0 = datetime.fromisoformat(start)
    return [{"at": (t0 + timedelta(minutes=i)).isoformat(), "spot": s} for i, s in enumerate(spots)]


def _bars(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return te.parse_bars([{"at": r["at"], "o": r["spot"], "h": r["spot"], "l": r["spot"], "c": r["spot"]} for r in rows])


# ------------------------------------------------------------------------------------------------ the ATR and the flag, by hand
def test_atr_hand_calculation() -> None:
    # 5-minute bars of the minute spots: bar k holds minutes 5k..5k+4, spots rise 1 a minute inside a bar, odd bars start 3 higher.
    spots = [100.0 + (k % 2) * 3 + j for k in range(10) for j in range(5)]  # bar k: low 100+3(k%2), high low+4, close = high
    rows = _synthetic(spots)
    # complete bars are 0..8 (bar 9 is still forming); true range of bar k >= 1 = max(h-l, |h-prev close|, |l-prev close|):
    # even k: l=100, h=104, prev close 107 -> max(4, 3, 7) = 7 ; odd k: l=103, h=107, prev close 104 -> max(4, 3, 1) = 4
    trs = [7.0 if k % 2 == 0 else 4.0 for k in range(1, 9)]
    assert pb.atr_at(rows) == pytest.approx(sum(trs) / len(trs))
    assert pb.atr_at(rows[:20]) is None  # fewer than MIN_BARS complete bars: no figure


def test_no_flag_while_young_or_flat() -> None:
    assert pb.assess_at(_synthetic([100.0] * 20))["available"] is False
    flat = pb.assess_at(_synthetic([100.0 + (i % 3) for i in range(120)]))
    assert flat["signal"] is None  # wiggles of 2 points never reach 1.5 ATR after a 2 ATR run


def test_missing_spot_minutes_are_skipped_and_counted() -> None:
    spots: list[float | None] = [100.0 + i * 0.5 for i in range(60)]
    spots[10] = spots[11] = None
    out = pb.assess_at(_synthetic(spots))
    assert out["skipped"] == 2  # counted, not filled with a number


def test_mild_then_strong_pullback_levels_by_hand() -> None:
    # a run from 100 up to 160 in 60 minutes (+1/min), then down 1.2 per minute
    up = [100.0 + i for i in range(61)]
    down = [160.0 - 1.2 * k for k in range(1, 31)]
    rows = _synthetic(up + down)
    fl = pb.flags(rows)
    first = next(i for i, f in enumerate(fl) if f)
    f = fl[first]
    assert f is not None and f["id"] == "pullback_from_high" and f["severity"] == "mild"
    atr = pb.atr_at(rows, first)
    assert atr is not None and f["drop_points"] >= pb.PULL_ATR * atr
    assert 160.0 - rows[first]["spot"] == pytest.approx(f["drop_points"], abs=0.1)
    assert first > 60  # nothing on the way up: the run itself flags nothing
    strong = [x for x in fl if x and x["severity"] == "strong"]
    assert strong and strong[0]["drop_atr"] >= pb.STRONG_ATR


# ------------------------------------------------------------------------------------------------ the cap
def test_cap_rules() -> None:
    strong_down = {"id": "pullback_from_high", "direction": "bearish", "severity": "strong", "drop_points": 80.0, "drop_atr": 3.9}
    score, why = pb.cap(54.6, strong_down)
    assert score == 14.0 and why is not None and why["raw_score"] == 54.6 and "80 points" in why["reason"]
    assert pb.cap(10.0, strong_down) == (10.0, None)  # already neutral
    assert pb.cap(-40.0, strong_down) == (-40.0, None)  # same side as the flag: never touched
    assert pb.cap(54.6, {**strong_down, "severity": "mild"}) == (54.6, None)  # a mild flag only warns
    assert pb.cap(54.6, None) == (54.6, None) and pb.cap(None, strong_down) == (None, None)
    bounce = {"id": "bounce_from_low", "direction": "bullish", "severity": "strong", "drop_points": 60.0, "drop_atr": 3.0}
    assert pb.cap(-55.0, bounce)[0] == -14.0 and pb.cap(30.0, bounce) == (30.0, None)


# ------------------------------------------------------------------------------------------------ real sessions
def test_reversal_day_25_nov() -> None:
    rows = SESSIONS["2026-11-25"]
    spots = [r["spot"] for r in rows]
    high_i = spots.index(max(spots))
    assert _hhmm(rows[high_i]["at"]) == "11:46" and max(spots) == 25948.35
    fl = pb.flags(rows)
    after = [(i, f) for i, f in enumerate(fl) if f and f["id"] == "pullback_from_high" and i > high_i]
    assert after, "the fall from 11:46 must be flagged"
    i0, f0 = after[0]
    # independent check of the flagged minute: the drop under the high is what is reported
    assert f0["drop_points"] == pytest.approx(25948.35 - spots[i0], abs=0.1) and f0["drop_atr"] >= pb.PULL_ATR
    assert _hhmm(rows[i0]["at"]) < "12:08"  # earlier than the engine turn watch's score slide (12:08)
    strong = next(i for i, f in enumerate(fl) if f and f["id"] == "pullback_from_high" and f["severity"] == "strong" and i > high_i)
    assert _hhmm(rows[strong]["at"]) <= "12:16"
    # the bounce off the 13:17 low is flagged too
    low_i = spots.index(min(spots))
    assert _hhmm(rows[low_i]["at"]) == "13:17"
    assert any(f and f["id"] == "bounce_from_low" for f in fl[low_i:])
    # the verdict: the 12:16 Bullish call (+37) is capped to Neutral, the 11:46 peak (+55) is not (no flag yet)
    path = {_hhmm(p["at"]): p for p in outlook.path(rows, fz.DEFAULT_WEIGHTS)}
    assert path["11:46"]["score"] > 50 and "cap" not in path["11:46"]
    assert path["12:16"]["score"] == 14.0 and path["12:16"]["raw_score"] > 30 and "ATR" in path["12:16"]["cap"]


def test_scorecard_uses_capped_calls() -> None:
    card = outlook.scorecard(SESSIONS["2026-11-25"], fz.DEFAULT_WEIGHTS)
    by = {_hhmm(r["at"]): r for r in card["rows"]}
    assert by["12:16"]["class"] == "Neutral" and by["12:16"]["result"] == "no call"  # was a Bullish miss (-0.48 % over the next 30 minutes)
    assert by["11:46"]["result"] == "miss"  # before the flag: unchanged


def test_bearish_trend_day_is_never_capped_on_the_down_side() -> None:
    rows = SESSIONS["2026-11-23"]
    fl = pb.flags(rows)
    assert not any(f and f["id"] == "pullback_from_high" for f in fl)  # the high is the open: no pullback-from-high is ever reported
    capped = 0
    for r, f in zip(rows, fl, strict=True):
        raw = val.rescore(r, fz.DEFAULT_WEIGHTS)
        score, why = pb.cap(raw, f)
        if why is not None:
            capped += 1
            assert f is not None and f["direction"] == "bullish"  # only a bounce can cap, and only a Bearish verdict
            assert raw is not None and raw <= -pb.NEUTRAL_CAP and score == -(pb.NEUTRAL_CAP - 1)
    assert capped == 18  # pinned from the stored run (11:16 to 14:33), see the calibration test below for the cost/benefit


@pytest.mark.parametrize("day", ["2026-11-11", "2026-11-13", "2026-11-18"])
def test_choppy_days_never_move_a_neutral_reading_or_raise_a_call(day: str) -> None:
    rows = SESSIONS[day]
    fl = pb.flags(rows)
    caps = 0
    for r, f in zip(rows, fl, strict=True):
        raw = val.rescore(r, fz.DEFAULT_WEIGHTS)
        score, why = pb.cap(raw, f)
        caps += why is not None
        if raw is not None and abs(raw) < pb.NEUTRAL_CAP:
            assert score == raw and why is None  # a Neutral reading is never moved
        if score is not None and raw is not None:
            assert abs(score) <= abs(raw)  # a cap never raises the strength of a call
    assert caps <= 40  # a minority of the session (pinned from the stored run: 7 / 36 / 17), not a target


def test_capping_does_not_lower_the_stored_hit_rate() -> None:
    """The calibration the cap rests on: 30-minute calls of the ten stored sessions, before and after the cap (overlapping minutes: a description, not an out-of-sample test)."""
    hits = {"before": 0, "after": 0}
    n = {"before": 0, "after": 0}
    for rows in SESSIONS.values():
        fl = pb.flags(rows)
        for i in range(len(rows) - 30):
            raw = val.rescore(rows[i], fz.DEFAULT_WEIGHTS)
            fwd = rows[i + 30]["spot"] - rows[i]["spot"]
            if raw is None or abs(fwd) < rows[i]["spot"] * 0.0002:
                continue
            capped, _ = pb.cap(raw, fl[i])
            for key, sc in (("before", raw), ("after", capped)):
                if sc is not None and abs(sc) >= val.NEUTRAL_BAND:
                    hits[key] += (fwd > 0) == (sc > 0)
                    n[key] += 1
    assert n["before"] == 2193 and round(hits["before"] / n["before"], 3) == 0.593
    assert n["after"] == 2075 and round(hits["after"] / n["after"], 3) == 0.607
    assert hits["before"] - hits["after"] == 42 and n["before"] - n["after"] == 118  # the capped calls were right 42 times in 118 (36 %)


# ------------------------------------------------------------------------------------------------ the trend regime fade guard
def test_fading_label_on_the_reversal_day() -> None:
    series = te.regime_series(_bars(SESSIONS["2026-11-25"]))
    fades = [r for r in series if r["fading"]]
    assert fades and all(r["label"].endswith("(fading)") and r["agreement"] is None for r in fades)
    assert te.direction_of("Trending down (fading)") == 0 and te.direction_of("Weak uptrend (fading)") == 0  # it no longer pushes the verdict


def test_fading_is_a_pure_function_of_past_bars() -> None:
    bars = te.aggregate(_bars(_synthetic([100.0 + i for i in range(80)] + [180.0 - 1.5 * k for k in range(1, 41)])))
    n = len(bars)
    assert te.fading(bars, n - 1, "Trending up") is True  # last three closes 2 ATR under the 12-bar high
    assert te.fading(bars, n - 1, "Trending down") is False and te.fading(bars, n - 1, "Range-bound") is False
    assert te.fading(bars, 10, "Trending up") is False  # still rising at bar 10: no look-ahead


@pytest.mark.parametrize("day", ["2026-11-11", "2026-11-13", "2026-11-18", "2026-11-23"])
def test_only_trend_labels_can_fade(day: str) -> None:
    for r in te.regime_series(_bars(SESSIONS[day])):
        base = r["label"].removesuffix(" (fading)")
        assert (not r["fading"]) or base in te.UP_LABELS + te.DOWN_LABELS
