"""The Entry Lab: replays of short-straddle entry rules on recorded sessions.

Real recorded sessions (6, 17 and 19 Nov 2026) are checked against numbers an independent study script produced from the same stored chains (fixed ATM straddle opened at 09:30 or 09:45 and held to
15:15: 19 Nov -215.2 and -106.6 points, 6 Nov -214.8 and -182.6, 17 Nov -15.7 and +19.0); stops, targets, re-strikes, carried prices and the statistics are checked on small hand-built days.
"""

from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.intelligence import entry_lab as el
from app.intelligence.entry_lab_service import EntryLabService
from tests.unit.test_globalmkts import make_app

IST = ZoneInfo("Asia/Kolkata")
FIX = json.loads((Path(__file__).parent.parent / "fixtures" / "entry_lab" / "sessions_nov2026.json").read_text(encoding="utf-8"))


def real_days() -> dict[str, el.Day]:
    out = {}
    for d in FIX["days"]:
        prices = []
        for ce, pe in zip(d["ce"], d["pe"], strict=True):
            row: dict[tuple[float, int], float] = {}
            for k, c, p in zip(d["strikes"], ce, pe, strict=True):
                if c is not None:
                    row[(k, el.CALL)] = c
                if p is not None:
                    row[(k, el.PUT)] = p
            prices.append(row)
        out[d["day"]] = el.Day(day=d["day"], dte=d["dte"], times=[datetime.fromisoformat(t) for t in d["times"]], spots=d["spots"], prices=prices)
    return out


REAL = real_days()


@pytest.mark.parametrize(
    ("day", "entry", "premium", "gross"),
    [("2026-11-19", time(9, 30), 299.1, -215.2), ("2026-11-06", time(9, 30), 345.7, -214.8), ("2026-11-17", time(9, 30), 123.2, -15.7),
     ("2026-11-19", time(9, 45), 289.2, -106.6), ("2026-11-06", time(9, 45), 339.7, -182.6), ("2026-11-17", time(9, 45), 108.7, 19.0)],
)  # fmt: skip
def test_real_sessions_reproduce_the_independent_study(day: str, entry: time, premium: float, gross: float) -> None:
    r = el.simulate(el.Rule(entry=entry, cost=0.0), REAL[day])
    assert r["skipped"] is None and r["exit_reason"] == "time" and r["restrikes"] == 0
    assert r["entry_premium"] == pytest.approx(premium, abs=0.06) and r["gross"] == pytest.approx(gross, abs=0.06) and r["net"] == r["gross"]


def test_real_sessions_cost_and_the_move_are_booked() -> None:
    r = el.simulate(el.Rule(entry=time(9, 30)), REAL["2026-11-19"])  # default 2.0 points for the entry and the exit together
    assert r["net"] == pytest.approx(r["gross"] - 2.0, abs=0.01) and r["spot_move"] == pytest.approx(431.2, abs=0.2)  # NIFTY rose 431 points: the short straddle lost
    strikes = next(d["strikes"] for d in FIX["days"] if d["day"] == "2026-11-19")
    assert r["max_adverse"] >= 215.2 and r["dte"] == 4
    assert r["strike"] == min(strikes, key=lambda k: abs(k - r["entry_spot"]))  # the strike nearest the index at the entry minute


def test_a_stop_cuts_the_real_trend_day_and_a_roll_cuts_it_too() -> None:
    day = REAL["2026-11-19"]
    free = el.simulate(el.Rule(entry=time(9, 30), cost=0.0), day)
    stop = el.simulate(el.Rule(entry=time(9, 30), cost=0.0, stop_pct=20), day)
    assert stop["exit_reason"] == "stop" and stop["gross"] > free["gross"] and stop["gross"] == pytest.approx(-0.2 * free["entry_premium"], abs=12)  # out near 20% of the premium, not -215
    roll = el.simulate(el.Rule(entry=time(9, 30), cost=0.0, roll_pts=100), day)
    assert roll["restrikes"] >= 1 and roll["gross"] > free["gross"]  # the re-strikes (2 points each) cost less than the loss they avoid


T0 = datetime(2026, 11, 19, 9, 45, tzinfo=IST)


def mk(prem: list[float | None], spots: list[float] | None = None, extra: dict[int, dict[float, float]] | None = None, dte: int = 4, day: str = "2026-11-19") -> el.Day:
    """A hand-built day, one minute apart from 09:45: strike 25000 priced prem[i] (half call, half put), optional other strikes by minute."""
    n = len(prem)
    prices: list[dict[tuple[float, int], float]] = []
    for i, p in enumerate(prem):
        row: dict[tuple[float, int], float] = {}
        if p is not None:
            row[(25000.0, el.CALL)] = p / 2
            row[(25000.0, el.PUT)] = p / 2
        for k, v in (extra or {}).get(i, {}).items():
            row[(k, el.CALL)] = v / 2
            row[(k, el.PUT)] = v / 2
        prices.append(row)
    return el.Day(day=day, dte=dte, times=[T0 + timedelta(minutes=i) for i in range(n)], spots=spots or [25000.0] * n, prices=prices)


def test_a_fixed_straddle_books_entry_minus_exit_less_the_costs() -> None:
    r = el.simulate(el.Rule(), mk([100, 102, 98, 96, 97, 95, 93, 94]))
    assert (r["entry_premium"], r["gross"], r["net"], r["exit_reason"], r["exit_at"]) == (100.0, 6.0, 4.0, "time", "09:52")
    assert r["max_adverse"] == 2.0 and r["max_favourable"] == 7.0  # the premium rose to 102 (-2), fell to 93 (+7)


def test_a_stop_ends_the_day_at_the_first_minute_the_premium_is_20_percent_above_entry() -> None:
    r = el.simulate(el.Rule(stop_pct=20), mk([100, 105, 110, 121, 130, 90, 80, 70]))
    assert r["exit_reason"] == "stop" and r["gross"] == -21.0 and r["net"] == -23.0 and r["exit_at"] == "09:48"  # 121 is the first at or above 120; the later fall to 70 is never taken


def test_a_target_ends_the_day_when_the_premium_has_fallen_30_percent() -> None:
    r = el.simulate(el.Rule(target_pct=30), mk([100, 95, 90, 80, 70, 60, 65, 70]))
    assert r["exit_reason"] == "target" and r["gross"] == 30.0 and r["exit_at"] == "09:49"


def test_a_re_strike_closes_the_old_pair_books_it_and_opens_the_nearest_strike() -> None:
    """Spot reaches 25,110 at minute 5: 110 points from 25,000, so with a 100-point rule the 125 premium is bought back (100 - 125 - 2 = -27) and 25,100 is sold at 90, closed at 80."""
    prem = [100, 100, 100, 100, 110, 125, 130, 125]
    spots = [25000.0, 25020.0, 25040.0, 25060.0, 25090.0, 25110.0, 25120.0, 25100.0]
    extra = {5: {25100.0: 90.0}, 6: {25100.0: 92.0}, 7: {25100.0: 80.0}}
    day = mk(prem, spots, extra)
    managed = el.simulate(el.Rule(roll_pts=100), day)
    assert managed["restrikes"] == 1 and managed["gross"] == -17.0 and managed["net"] == -19.0  # -27 + 90 - 80
    free = el.simulate(el.Rule(), day)
    assert free["gross"] == -25.0 and free["restrikes"] == 0  # unmanaged: 100 - 125
    assert el.simulate(el.Rule(roll_pts=100, roll_cost=5.0), day)["gross"] == -20.0  # the cost of a re-strike is a parameter: -30 + 90 - 80


def test_a_minute_without_a_price_repeats_the_last_one_never_zero() -> None:
    r = el.simulate(el.Rule(), mk([100, None, None, 98, 97, 96, 95, 94]))
    assert r["gross"] == 6.0 and r["max_adverse"] == 0.0  # the missing minutes carry 100; they are not a premium of zero


def test_days_without_a_usable_entry_or_hold_are_skipped_with_a_reason() -> None:
    assert el.simulate(el.Rule(), mk([100, 99, 98]))["skipped"] == "no entry minute or too short a hold"
    assert el.simulate(el.Rule(entry=time(15, 0)), mk([100] * 8))["skipped"] == "no entry minute or too short a hold"
    assert el.simulate(el.Rule(), mk([None] * 8))["skipped"] == "no price for the strike at the entry minute"
    assert el.nearest_strike({(25000.0, el.CALL): 1.0}, 25000.0) is None  # a strike needs both sides


def day_with(net: float, label: str, dte: int = 4) -> dict[str, object]:
    return {"day": label, "dte": dte, "skipped": None, "net": net, "gross": net + 2, "max_adverse": 5.0, "restrikes": 0, "entry_premium": 100.0}


def test_the_summary_statistics_by_hand() -> None:
    res = [day_with(10, "d1"), day_with(-20, "d2", 0), day_with(30, "d3"), day_with(5, "d4", 1), day_with(-5, "d5")]
    s = el.summarise(el.Rule(), res)
    assert (s["days"], s["mean"], s["median"], s["win_pct"], s["worst"], s["best"], s["total"]) == (5, 4.0, 5.0, 60.0, -20.0, 30.0, 20.0)
    assert s["rupees_per_lot_total"] == 1300 and s["sufficient"] is False and "not evidence of an edge" in s["message"]
    loo = s["leave_one_out"]
    assert loo["most_influential_day"] == "d2" and loo["mean_max"] == 10.0 and loo["mean_min"] == -2.5 and loo["swing"] == 12.5  # without d2 (-20): (10+30+5-5)/4 = 10; without d3 (+30): (10-20+5-5)/4 = -2.5
    assert s["by_dte"]["expiry day"]["days"] == 1 and s["by_dte"]["expiry day"]["worst"] == -20.0 and s["by_dte"]["1-2 days"]["days"] == 1 and s["by_dte"]["3+ days"]["days"] == 3
    again = el.summarise(el.Rule(), res)
    assert again["mean_range95"] == s["mean_range95"] and again["median_range95"] == s["median_range95"]  # resampling is deterministic
    lo, hi = s["mean_range95"]
    assert lo <= 4.0 <= hi and el.summarise(el.Rule(), res[:4])["mean_range95"] is None  # under five days no range is claimed


def test_twenty_days_are_enough_to_drop_the_not_evidence_warning_but_not_the_caution() -> None:
    res = [day_with(float(i % 7) - 2, f"d{i}") for i in range(20)]
    s = el.summarise(el.Rule(), res)
    assert s["sufficient"] is True and "Still in-sample" in s["message"]
    assert el.summarise(el.Rule(), [])["message"].startswith("No day could be replayed")


def test_the_standard_sweeps_count_the_variants_tried() -> None:
    days = [REAL["2026-11-06"], REAL["2026-11-17"], REAL["2026-11-19"]]
    p = el.presets(el.Rule(), days)
    assert p["variants_tried"] == 13 + 5 + 4 == len(p["entry_time"]) + len(p["re_strike"]) + len(p["stop"])
    assert [r["value"] for r in p["entry_time"]][:3] == ["09:20", "09:30", "09:45"] and [r["value"] for r in p["re_strike"]] == [None, 50.0, 75.0, 100.0, 150.0]
    at_930 = next(r for r in p["entry_time"] if r["value"] == "09:30")
    assert at_930["days"] == 3 and at_930["worst"] == pytest.approx(-217.2, abs=0.2) and at_930["median"] == pytest.approx(-216.8, abs=0.2)  # net of the 2-point cost: 19 Nov -217.2, 6 Nov -216.8, 17 Nov -17.7
    assert "luck" in p["note"]


def stub_service(days: list[el.Day], today: datetime, calls: list[date] | None = None) -> EntryLabService:
    by = {d.day: d for d in days}

    def load(d: date) -> el.Day | None:
        if calls is not None:
            calls.append(d)
        return by.get(d.isoformat())

    return EntryLabService(lambda: [date.fromisoformat(k) for k in by] + [date(2026, 11, 20)], load, today=lambda: today)


def test_the_service_loads_finished_days_in_the_background_and_reports_progress() -> None:
    calls: list[date] = []
    svc = stub_service(list(REAL.values()), datetime(2026, 11, 20, 12, 0, tzinfo=IST), calls)  # Friday 20 Nov noon: the 20th is today and still trading
    assert [d.isoformat() for d in svc.finished_days()] == ["2026-11-06", "2026-11-17", "2026-11-19"]
    assert svc.status()["days_loaded"] == 0 and svc.start() is True
    assert svc._thread is not None
    svc._thread.join(timeout=10)
    st = svc.status()
    assert (st["days_total"], st["days_loaded"], st["loading"], st["failed"]) == (3, 3, False, {}) and st["first"] == "2026-11-06" and st["last"] == "2026-11-19"
    assert svc.start() is False and len(calls) == 3  # nothing missing: no second load
    out = svc.result(el.Rule(entry=time(9, 30)), with_presets=True)
    assert out["summary"]["days"] == 3 and len(out["days"]) == 3 and out["presets"]["variants_tried"] == 22 and out["rule"]["entry"] == "09:30"
    after = stub_service(list(REAL.values()), datetime(2026, 11, 20, 16, 30, tzinfo=IST))  # after the close the 20th counts as finished (no stored data for it: a failed day)
    assert date(2026, 11, 20) in after.finished_days()


def test_a_day_that_cannot_be_loaded_is_reported_not_hidden() -> None:
    def boom(d: date) -> el.Day | None:
        if d.isoformat() == "2026-11-17":
            raise RuntimeError("db busy")
        return REAL.get(d.isoformat())

    svc = EntryLabService(lambda: [date(2026, 11, 6), date(2026, 11, 17), date(2026, 11, 18)], boom, today=lambda: datetime(2026, 11, 20, 12, 0, tzinfo=IST))
    svc.start()
    assert svc._thread is not None
    svc._thread.join(timeout=10)
    st = svc.status()
    assert st["days_loaded"] == 1 and st["failed"] == {"2026-11-17": "RuntimeError", "2026-11-18": "too few stored minutes"}  # one bad day does not stop the others


def test_the_endpoint_serves_a_rule_and_rejects_bad_input(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    app.state.entry_lab = stub_service(list(REAL.values()), datetime(2026, 11, 20, 12, 0, tzinfo=IST))
    with TestClient(app) as c:
        app.state.entry_lab = stub_service(list(REAL.values()), datetime(2026, 11, 20, 12, 0, tzinfo=IST))  # lifespan may have set its own: use the stub
        app.state.entry_lab.start()
        app.state.entry_lab._thread.join(timeout=10)
        body = c.get("/api/intelligence/entry-lab", params={"entry": "09:30", "stop": 20, "presets": "true"}).json()
        assert body["rule"]["stop_pct"] == 20 and body["rule"]["entry"] == "09:30" and body["summary"]["days"] == 3 and body["presets"]["variants_tried"] == 22
        assert body["status"]["days_loaded"] == 3 and len(body["assumptions"]) == 3
        assert c.get("/api/intelligence/entry-lab", params={"entry": "9:30"}).status_code == 422  # not HH:MM
        assert c.get("/api/intelligence/entry-lab", params={"entry": "15:00", "exit": "14:00"}).status_code == 422  # entry after exit
        assert c.get("/api/intelligence/entry-lab", params={"roll": 5}).status_code == 422  # a re-strike distance under 20 points
        assert c.get("/api/intelligence/entry-lab", params={"entry": "99:99"}).status_code in (422, 400)
