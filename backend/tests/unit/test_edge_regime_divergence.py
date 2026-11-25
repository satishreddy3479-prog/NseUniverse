"""The trend-regime and flow-divergence indicators in the Edge monitor: calls built by hand on small series, then on the real stored sessions of 12-25 Nov 2026."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.edge import calls as ec
from app.edge.service import EdgeService
from app.edge.store import EdgeStore

IST = timezone(timedelta(hours=5, minutes=30))
OI: dict[str, list[dict[str, Any]]] = json.loads((Path(__file__).parent.parent / "fixtures" / "intelligence_sessions_oi_2026-11.json").read_text(encoding="utf-8"))


def _rows(spots: list[float], gaps: list[float | None] | None = None, day: str = "2026-11-25") -> list[dict[str, Any]]:
    out = []
    for i, s in enumerate(spots):
        t = datetime.fromisoformat(f"{day}T00:00:00+05:30") + timedelta(minutes=9 * 60 + 15 + i)
        r: dict[str, Any] = {"at": t.astimezone(UTC).isoformat(), "spot": s}
        if gaps is not None and gaps[i] is not None:
            r["pe_oi_chg"], r["ce_oi_chg"] = gaps[i], 0.0  # put minus call = the gap
        out.append(r)
    return out


def _line(points: list[tuple[int, float]], n: int) -> list[float]:
    """Straight lines between (minute, value) points, one value a minute."""
    out = []
    for t in range(n):
        for (t0, v0), (t1, v1) in zip(points, points[1:], strict=False):
            if t0 <= t <= t1:
                out.append(v0 + (v1 - v0) * (t - t0) / (t1 - t0))
                break
        else:
            out.append(points[-1][1])
    return out


def _hhmm(at: str) -> str:
    return datetime.fromisoformat(at).astimezone(IST).strftime("%H:%M")


# ------------------------------------------------------------------------------------------------ the flow divergence, by hand
def test_regular_bearish_divergence_is_called_when_the_swing_is_confirmed() -> None:
    # price: peaks of 100.0 at minute 45 (10:00) and 100.3 at minute 75 (10:30); cumulative Smart OI (put minus call): 1000 at the first peak, 400 at the second.
    spots = _line([(0, 99.0), (45, 100.0), (60, 99.5), (75, 100.3), (120, 99.0)], 130)
    gaps = _line([(0, 0.0), (45, 1000.0), (60, 700.0), (75, 400.0), (120, 200.0)], 130)
    out = [c for c in ec.divergence_calls("2026-11-25", _rows(spots, gaps)) if c["horizon"] == 15]
    # higher high (+0.3 %) with lower flow (-600 of a range of 1000 up to then): a regular bearish divergence. The right-hand swing is in the 3-minute candle that starts at 10:30
    # (slot 25) and is confirmed 3 candles later; the call is made when that candle is complete: 09:15 + (25 + 3 + 1) x 3 min = 10:42.
    assert [(_hhmm(c["at"]), c["side"]) for c in out] == [("10:42", -1)]
    assert out[0]["result"] == "hit"  # price at 10:57 is under the 10:42 level on the way down (100.3 -> 99.0 from minute 75)


def test_no_divergence_when_price_and_flow_agree_or_the_flow_move_is_small() -> None:
    spots = _line([(0, 99.0), (45, 100.0), (60, 99.5), (75, 100.3), (120, 99.0)], 130)
    agree = _line([(0, 0.0), (45, 400.0), (60, 700.0), (75, 1000.0), (120, 200.0)], 130)  # flow also higher at the second high
    assert ec.divergence_calls("2026-11-25", _rows(spots, agree)) == []
    small = _line([(0, 0.0), (45, 1000.0), (60, 990.0), (75, 950.0), (120, 200.0)], 130)  # lower, but by 50: under 10 % of the range
    assert ec.divergence_calls("2026-11-25", _rows(spots, small)) == []


def test_regular_bullish_divergence_at_a_lower_low() -> None:
    spots = _line([(0, 101.0), (45, 100.0), (60, 100.5), (75, 99.7), (120, 101.0)], 130)  # lower low at minute 75
    gaps = _line([(0, 0.0), (45, 300.0), (60, 200.0), (75, 900.0), (120, 800.0)], 130)  # flow higher at the lower low
    out = [c for c in ec.divergence_calls("2026-11-25", _rows(spots, gaps)) if c["horizon"] == 15]
    assert [c["side"] for c in out] == [1] and _hhmm(out[0]["at"]) == "10:42"


def test_without_stored_open_interest_totals_there_is_no_divergence_call() -> None:
    spots = _line([(0, 99.0), (45, 100.0), (60, 99.5), (75, 100.3), (120, 99.0)], 130)
    assert ec.divergence_calls("2026-11-25", _rows(spots)) == []  # the stored totals started on 12 Nov: nothing is made up for a session without them
    assert ec.divergence_calls("2026-11-11", OI["2026-11-11"]) == []


def test_the_oi_totals_can_come_flat_or_inside_metrics() -> None:
    assert ec._oi_gap({"pe_oi_chg": 500.0, "ce_oi_chg": 200.0}) == 300.0
    assert ec._oi_gap({"metrics": {"pe_oi_chg": 500.0, "ce_oi_chg": 800.0}}) == -300.0
    assert ec._oi_gap({"metrics": {"pe_oi_chg": 500.0}}) is None


# ------------------------------------------------------------------------------------------------ the trend regime, by hand
def test_a_steady_rise_calls_up_after_the_label_turns_to_a_trend_and_never_before() -> None:
    rows = _rows([100.0 + 0.1 * i for i in range(150)])
    out = [c for c in ec.regime_calls("2026-11-25", rows) if c["horizon"] == 30]
    assert out and all(c["side"] == 1 for c in out)
    assert min(_hhmm(c["at"]) for c in out) >= "10:00"  # the first 30 minutes are warming up: no label, no call
    assert all(c["result"] == "hit" for c in out)  # it kept rising


def test_a_flat_session_makes_no_regime_call() -> None:
    rows = _rows([100.0 + (0.05 if i % 2 else 0.0) for i in range(150)])
    assert ec.regime_calls("2026-11-25", rows) == []


def test_a_steady_fall_calls_down() -> None:
    out = ec.regime_calls("2026-11-25", _rows([100.0 - 0.1 * i for i in range(150)]))
    assert out and all(c["side"] == -1 for c in out)


# ------------------------------------------------------------------------------------------------ on the real sessions
def test_real_sessions_with_stored_totals_give_divergence_calls_and_all_sessions_give_regime_calls() -> None:
    div = {d: [c for c in ec.divergence_calls(d, rows) if c["horizon"] == 30] for d, rows in OI.items()}
    assert div["2026-11-11"] == [] and div["2026-11-12"] == []  # no stored totals (11 Nov) or only 14 minutes of them (12 Nov)
    assert [(c["side"], c["result"]) for c in div["2026-11-23"]] == [(-1, "hit"), (-1, "hit")]  # the fall: two bearish divergences, both followed by lower prices
    assert sum(len(v) for v in div.values()) == 11  # pinned from the stored run: 1 + 3 + 1 + 3 + 2 + 1 on 13, 16, 18, 20, 23 and 25 Nov
    reg = {d: [c for c in ec.regime_calls(d, rows) if c["horizon"] == 30] for d, rows in OI.items()}
    assert all(len(v) > 0 for v in reg.values())
    day = reg["2026-11-23"]  # the day price fell 565 points: the labels were mostly Trending down
    assert sum(c["side"] == -1 for c in day) > sum(c["side"] == 1 for c in day)


def test_the_job_scores_the_two_indicators_and_a_new_version_rescored_old_sessions(tmp_path: Path) -> None:
    svc = EdgeService(EdgeStore(tmp_path), sessions=lambda: sorted(OI), intel_rows=lambda s: OI[s], rules_rows=lambda s: [], straddle_rows=lambda s: [],
                      clock=lambda: datetime(2026, 11, 26, 9, 0, tzinfo=IST))
    assert len(svc.catch_up()) == 10
    rep = svc.report()
    by = {i["id"]: i for i in rep["indicators"]}
    assert list(by) == ["verdict", "rules", "momentum", "orb", "regime", "divergence", "seller"]
    assert by["regime"]["horizons"]["30"]["sessions"] == 10 and by["regime"]["horizons"]["30"]["calls"] > 50
    d = by["divergence"]["horizons"]["30"]
    assert d["sessions"] == 6 and d["calls"] == 11  # six sessions had stored totals (13 Nov to 25 Nov)
    assert by["regime"]["status"] == "too_early" and by["divergence"]["status"] == "too_early"
    assert "fresh" not in by["regime"]["horizons"]["30"]  # not mined from the stored sessions: no fresh-session rule, the sessions count as they are
    import sqlite3

    c = sqlite3.connect(svc.store.path)
    c.execute("UPDATE scored SET version='edge-1'")  # sessions scored before the two indicators existed
    c.commit()
    c.close()
    assert len(svc.pending()) == 10 and len(svc.catch_up()) == 10
