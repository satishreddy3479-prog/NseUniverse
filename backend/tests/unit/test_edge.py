"""The Edge monitor: calls and outcomes, the statistics (hand-calculated), the nightly job on the real stored sessions of 11-25 Nov 2026, and the report endpoint."""

from __future__ import annotations

import json
import random
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import routes
from app.edge import calls as ec
from app.edge import stats
from app.edge.service import EdgeService
from app.edge.store import VERSION, EdgeStore

IST = timezone(timedelta(hours=5, minutes=30))
FIX = Path(__file__).parent.parent / "fixtures"
SESSIONS: dict[str, list[dict[str, Any]]] = json.loads((FIX / "intelligence_sessions_2026-11.json").read_text(encoding="utf-8"))


def _rows(spots: list[float], start_min: int = 9 * 60 + 15, day: str = "2026-11-25", **extra: Any) -> list[dict[str, Any]]:
    """One row a minute from ``start_min`` IST."""
    out = []
    for i, s in enumerate(spots):
        m = start_min + i
        t = datetime.fromisoformat(f"{day}T00:00:00+05:30") + timedelta(minutes=m)
        out.append({"at": t.astimezone(UTC).isoformat(), "spot": s, **extra})
    return out


# ------------------------------------------------------------------------------------------------ calls and outcomes, by hand
def test_forward_pct_and_results_by_hand() -> None:
    spots = [100.0 + i * 0.1 for i in range(120)]  # +0.1 point a minute from 100
    pts = ec.series(_rows(spots))
    k = next(i for i, p in enumerate(pts) if p[0] == 9 * 60 + 30)  # 09:30: spot 101.5
    assert pts[k][1] == pytest.approx(101.5)
    # 30 minutes later (10:00) the spot is 104.5: (104.5 / 101.5 - 1) * 100 = 2.9557 %
    assert ec.forward_pct(pts, k, 30) == pytest.approx((104.5 / 101.5 - 1) * 100)
    assert ec._result("direction", 1, 2.9, 30) == "hit" and ec._result("direction", -1, 2.9, 30) == "miss"
    assert ec._result("direction", 1, 0.01, 30) == "flat"  # under 0.02 %: neither
    assert ec._result("calm", 0, 0.05, 30) == "hit" and ec._result("calm", 0, 0.30, 30) == "miss"
    assert ec._result("calm", 0, 0.12, 60) == "hit"  # the calm limit grows with the square root of time: 0.1 * sqrt(2) = 0.141


def test_an_unrecorded_outcome_minute_is_left_out_not_guessed() -> None:
    rows = _rows([100.0 + i * 0.1 for i in range(40)])
    pts = ec.series(rows)
    k = next(i for i, p in enumerate(pts) if p[0] == 9 * 60 + 30)
    assert ec.forward_pct(pts, k, 30) is None  # the session ends at 09:54: no 10:00 point
    gap = _rows([100.0] * 20) + _rows([101.0] * 20, start_min=9 * 60 + 15 + 40)  # a 20-minute hole in the record
    gp = ec.series(gap)
    assert ec.forward_pct(gp, 5, 15) is None  # the first point after the hole is 25 minutes later: beyond the 4-minute tolerance


def test_momentum_follows_the_last_30_minutes() -> None:
    spots = [100.0 + i * 0.05 for i in range(60)] + [103.0 - (i * 0.05) for i in range(60)]  # up for an hour, then down
    out = ec.momentum_calls("2026-11-25", _rows(spots))
    by_at = {c["at"]: c["side"] for c in out if c["horizon"] == 15}
    assert out and set(by_at.values()) == {1, -1}
    assert all(c["side"] in (1, -1) for c in out)
    first = min(by_at)
    assert by_at[first] == 1  # the first call is made while price has been rising


def test_opening_range_break_is_one_call_in_the_direction_of_the_first_break() -> None:
    spots = [100.0, 100.4, 100.2, 100.1, 100.3, 100.2, 100.4, 100.1, 100.2, 100.3, 100.2, 100.1, 100.2, 100.3, 100.2] + [100.2] * 10 + [100.9] * 70  # box 100.0-100.4, breaks up at ~09:40
    out = ec.orb_calls("2026-11-25", _rows(spots))
    assert {c["horizon"] for c in out} == {15, 30, 60} and all(c["side"] == 1 for c in out)
    assert len({c["at"] for c in out}) == 1  # one call a session
    down = ec.orb_calls("2026-11-25", _rows([100.0, 100.4, 100.2, 100.1, 100.3, 100.2, 100.4, 100.1, 100.2, 100.3, 100.2, 100.1, 100.2, 100.3, 100.2] + [99.5] * 70))
    assert down and all(c["side"] == -1 for c in down)
    assert ec.orb_calls("2026-11-25", _rows([100.0, 100.1, 100.2])) == []  # too few points in the box: no call


def test_windows_count_ups_downs_and_flats_by_hour() -> None:
    spots = [100.0 + i * 0.1 for i in range(120)]  # always rising: every window is up
    w = {(x["horizon"], x["hour"]): x for x in ec.windows(ec.series(_rows(spots)))}
    assert w[(30, 9)]["down"] == 0 and w[(30, 9)]["up"] == w[(30, 9)]["n"] > 0
    flat = {(x["horizon"], x["hour"]): x for x in ec.windows(ec.series(_rows([100.0] * 120)))}
    assert flat[(30, 9)]["up"] == 0 and flat[(30, 9)]["down"] == 0 and flat[(30, 9)]["calm"] == flat[(30, 9)]["n"]  # flat windows are calm, not up or down


# ------------------------------------------------------------------------------------------------ the statistics, by hand
def _call(session: str, side: int, result: str, indicator: str = "rules", horizon: int = 30, at: str = "2026-11-25T04:30:00+00:00") -> dict[str, Any]:
    return {"session": session, "indicator": indicator, "horizon": horizon, "at": at, "side": side, "result": result}


def test_edge_over_drift_and_timing_edge_by_hand() -> None:
    # session A: 3 windows up, 1 down (up share .75); session B: 1 up, 3 down (.25); pooled up share = 4 / 8 = .5
    wins = [{"session": "A", "horizon": 30, "hour": 10, "n": 4, "up": 3, "down": 1, "calm": 2}, {"session": "B", "horizon": 30, "hour": 10, "n": 4, "up": 1, "down": 3, "calm": 2}]
    calls = [_call("A", 1, "hit"), _call("A", 1, "miss"), _call("B", -1, "hit")]
    s = stats.summarise_one("rules", 30, calls, wins)
    assert s["calls"] == 3 and s["hits"] == 2 and s["hit_rate"] == pytest.approx(0.6667, abs=1e-4)
    # drift baseline per call = .5, .5, .5 -> edge = 2/3 - 1/2 = .1667
    assert s["baseline_drift"] == pytest.approx(0.5) and s["edge_drift"] == pytest.approx(0.1667, abs=1e-4)
    # same-day baseline: A long .75, A long .75, B short 1 - .25 = .75 -> 2/3 - .75 = -.0833
    assert s["edge_timing"] == pytest.approx(-0.0833, abs=1e-4)
    assert s["status"] == "too_early" and "1 of 20" not in s["status_text"] and "20 sessions needed" in s["status_text"]


def test_flat_calls_are_neither_hits_nor_misses() -> None:
    wins = [{"session": "A", "horizon": 30, "hour": 10, "n": 4, "up": 2, "down": 2, "calm": 2}]
    s = stats.summarise_one("rules", 30, [_call("A", 1, "flat"), _call("A", 1, "hit")], wins)
    assert s["calls"] == 1 and s["hit_rate"] == 1.0


def test_calm_calls_are_compared_with_the_same_hour() -> None:
    wins = [{"session": "A", "horizon": 30, "hour": 10, "n": 10, "up": 5, "down": 5, "calm": 8}]  # 80 % of 10 o'clock windows are calm anyway
    s = stats.summarise_one("seller", 30, [_call("A", 0, "hit", "seller"), _call("A", 0, "miss", "seller")], wins)
    assert s["hit_rate"] == 0.5 and s["baseline_drift"] == pytest.approx(0.8) and s["edge_drift"] == pytest.approx(-0.3)


def _many(n_sessions: int, p_hit: float, seed: int = 1) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Synthetic sessions: the market goes up half the time; the indicator calls long or short with hit probability p_hit."""
    rnd = random.Random(seed)  # noqa: S311
    calls, wins = [], []
    for d in range(n_sessions):
        s = f"2027-01-{d + 1:02d}" if d < 28 else f"2027-02-{d - 27:02d}"
        wins.append({"session": s, "horizon": 30, "hour": 10, "n": 20, "up": 10, "down": 10, "calm": 10})
        for k in range(8):
            side = rnd.choice((1, -1))
            calls.append(_call(s, side, "hit" if rnd.random() < p_hit else "miss", at=f"2027-01-05T04:{k:02d}:00+00:00"))
    return calls, wins


def test_labels_follow_the_evidence_not_the_first_good_run() -> None:
    calls, wins = _many(10, 0.9)
    assert stats.summarise_one("rules", 30, calls, wins)["status"] == "too_early"  # 10 sessions, however good, is early
    calls, wins = _many(30, 0.75)
    good = stats.summarise_one("rules", 30, calls, wins)
    assert good["status"] in ("edge", "timing_edge") and good["edge_drift_ci"][0] > 0
    calls, wins = _many(30, 0.5, seed=7)
    assert stats.summarise_one("rules", 30, calls, wins)["status"] == "no_edge"  # a coin
    calls, wins = _many(30, 0.2)
    assert stats.summarise_one("rules", 30, calls, wins)["status"] == "worse"


def test_a_pattern_found_in_stored_data_cannot_prove_itself_on_those_sessions() -> None:
    calls, wins = _many(30, 0.9)  # 30 sessions in 2027, all after the 25 Nov 2026 tuning date -> fresh
    for c in calls:
        c["indicator"] = "momentum"
    fresh = stats.summarise_one("momentum", 30, calls, wins)
    assert fresh["fresh"]["sessions"] == 30 and fresh["status"] in ("edge", "timing_edge")
    old = [dict(c, session=c["session"].replace("2027", "2026-0")) for c in calls]  # dated before the tuning date: only in-sample
    old_wins = [dict(w, session=w["session"].replace("2027", "2026-0")) for w in wins]
    s = stats.summarise_one("momentum", 30, [dict(c, session=f"2026-10-{i % 28 + 1:02d}") for i, c in enumerate(old)], old_wins)
    assert s["fresh"]["sessions"] == 0 and s["status"] == "too_early" and "cannot prove it" in s["status_text"]


def test_headline_is_honest_before_and_after_the_minimum() -> None:
    assert "No finished session" in stats.headline([], 0)
    early = stats.headline([{"status": "too_early"}], 5)
    assert "5 sessions" in early and "20 are needed" in early
    none = stats.headline([{"status": "no_edge"}] * 3, 30)
    assert "no indicator has shown an edge" in none


# ------------------------------------------------------------------------------------------------ the job on the real stored sessions
def _service(tmp_path: Path, now: datetime, fail: str | None = None) -> EdgeService:
    sessions = sorted(SESSIONS)

    def intel(s: str) -> list[dict[str, Any]]:
        if s == fail:
            raise RuntimeError("boom")
        return SESSIONS.get(s, [])

    return EdgeService(EdgeStore(tmp_path), sessions=lambda: sessions, intel_rows=intel, rules_rows=lambda s: [], straddle_rows=lambda s: [], clock=lambda: now)


def test_the_job_scores_finished_sessions_once_and_only_finished_ones(tmp_path: Path) -> None:
    before_close = datetime(2026, 11, 25, 15, 45, tzinfo=IST)
    svc = _service(tmp_path, before_close)
    done = svc.catch_up()
    assert "2026-11-25" not in done and len(done) == 9  # today is not final until 15:55 IST
    assert svc.pending() == []  # nothing is final yet that is not scored
    svc._clock = lambda: datetime(2026, 11, 25, 15, 56, tzinfo=IST)  # type: ignore[method-assign]
    assert svc.pending() == ["2026-11-25"]
    assert svc.catch_up() == ["2026-11-25"]
    assert svc.catch_up() == [] and svc.pending() == []  # nothing is scored twice
    rep = svc.report()
    assert rep["sessions_scored"] == 10 and rep["first_session"] == "2026-11-11" and rep["last_session"] == "2026-11-25"
    ids = [i["id"] for i in rep["indicators"]]
    assert ids == ["verdict", "rules", "momentum", "orb", "seller"]
    by = {i["id"]: i for i in rep["indicators"]}
    assert by["verdict"]["horizons"]["30"]["sessions"] == 10 and by["verdict"]["status"] == "too_early"
    assert by["verdict"]["horizons"]["30"]["fresh"]["sessions"] == 0 and "cannot prove it" in by["verdict"]["status_text"]
    assert by["rules"]["horizons"]["30"]["calls"] == 0 and by["seller"]["horizons"]["30"]["calls"] == 0  # no rules or straddle rows were supplied: no calls, nothing invented
    assert rep["job"]["pending"] == [] and rep["job"]["last_error"] is None and "20 are needed" in rep["headline"]


def test_the_verdict_calls_on_25_nov_are_the_capped_ones() -> None:
    calls = [c for c in ec.verdict_calls("2026-11-25", SESSIONS["2026-11-25"]) if c["horizon"] == 30]
    at = {c["at"][11:16]: c for c in calls}  # UTC times; the calls are made every 15 minutes from 09:30 IST: 11:45 IST is 06:15, 12:15 IST is 06:45
    assert at["06:15"]["side"] == 1 and at["06:15"]["result"] == "miss"  # the 11:45 Bullish call, before any turn flag, is still made (and missed)
    assert "06:45" not in at  # the 12:15 call is capped to Neutral by the turn flag: no call, so no miss


def test_one_bad_session_does_not_stop_the_rest(tmp_path: Path) -> None:
    svc = _service(tmp_path, datetime(2026, 11, 26, 9, 0, tzinfo=IST), fail="2026-11-16")
    done = svc.catch_up()
    assert "2026-11-16" not in done and len(done) == 9 and "2026-11-16" in svc.last_error  # type: ignore[operator]
    assert "2026-11-16" in svc.pending()  # tried again at the next check


def test_a_session_with_too_few_minutes_is_skipped_and_remembered(tmp_path: Path) -> None:
    svc = EdgeService(EdgeStore(tmp_path), sessions=lambda: ["2026-11-24"], intel_rows=lambda s: SESSIONS["2026-11-25"][:20], rules_rows=lambda s: [], straddle_rows=lambda s: [],
                      clock=lambda: datetime(2026, 11, 26, 9, 0, tzinfo=IST))
    assert svc.catch_up() == [] and svc.pending() == []  # not asked again
    assert svc.report()["sessions_scored"] == 0


def test_a_new_scoring_version_rescored_the_session(tmp_path: Path) -> None:
    svc = _service(tmp_path, datetime(2026, 11, 26, 9, 0, tzinfo=IST))
    svc.catch_up()
    import sqlite3

    c = sqlite3.connect(svc.store.path)
    c.execute("UPDATE scored SET version='edge-0' WHERE session='2026-11-23'")
    c.commit()
    c.close()
    assert svc.pending() == ["2026-11-23"] and svc.catch_up() == ["2026-11-23"]
    assert set(svc.store.scored().values()) == {VERSION}


# ------------------------------------------------------------------------------------------------ the endpoint
def test_report_endpoint_serves_the_report_and_says_when_the_job_is_off(tmp_path: Path) -> None:
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as c:
        assert c.get("/api/edge/report").status_code == 503
    app.state.edge = _service(tmp_path, datetime(2026, 11, 26, 9, 0, tzinfo=IST))
    app.state.edge.catch_up()
    with TestClient(app) as c:
        r = c.get("/api/edge/report")
        assert r.status_code == 200
        body = r.json()
        assert body["sessions_scored"] == 10 and len(body["indicators"]) == 5 and body["job"]["enabled"] is True
