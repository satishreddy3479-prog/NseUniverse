"""Overnight context and event features (D212), checked by hand on small series.

Day under test: Thu 19 Nov 2026. The previous NIFTY close is Wed 18 Nov 15:30 IST, the pre-open read is 19 Nov 09:14 IST.
"""

from __future__ import annotations

from contextlib import closing
from datetime import date, datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.intelligence import context_signals as cs
from app.intelligence import entry_lab as el
from app.intelligence.context_ledger import ContextLedger
from tests.unit.test_entry_lab import session
from tests.unit.test_globalmkts import service

IST = ZoneInfo("Asia/Kolkata")
DAY = date(2026, 11, 19)


def at(d: str, hm: str) -> int:
    return int(datetime.fromisoformat(f"{d}T{hm}:00").replace(tzinfo=IST).timestamp() * 1000)


SERIES = {
    "GIFT": [(at("2026-11-18", "15:29"), 25000.0), (at("2026-11-19", "09:13"), 25100.0)],  # +0.4 %
    "ES": [(at("2026-11-18", "15:30"), 6000.0), (at("2026-11-19", "09:14"), 5940.0)],  # -1.0 %
    "NQ": [(at("2026-11-18", "10:00"), 21000.0), (at("2026-11-19", "09:14"), 21100.0)],  # the first price is 5.5 hours old: not used
}


def test_the_overnight_moves_by_hand_and_a_stale_price_is_left_out() -> None:
    ctx = cs.compute_context(SERIES, DAY)
    assert ctx["prev_day"] == "2026-11-18"
    assert ctx["moves"]["GIFT"] == {"close": 25000.0, "pre_open": 25100.0, "pct": 0.4}
    assert ctx["moves"]["ES"]["pct"] == -1.0
    assert "NQ" not in ctx["moves"] and "BRENT" not in ctx["moves"]  # too old / no data: missing, not zero


def test_the_previous_weekday_skips_the_weekend() -> None:
    assert cs.prev_weekday(date(2026, 11, 23)) == date(2026, 11, 20)  # Monday -> Friday


EVENTS = [
    {"ts": at("2026-11-18", "19:00"), "impact": "high", "all_day": False, "country": "US", "name": "Retail Sales"},  # overnight
    {"ts": at("2026-11-19", "13:30"), "impact": "high", "all_day": False, "country": "EU", "name": "Flash PMI"},  # in a 09:45-15:15 hold
    {"ts": at("2026-11-19", "11:00"), "impact": "medium", "all_day": False, "country": "IN", "name": "Minor"},  # not high
    {"ts": at("2026-11-19", "00:00"), "impact": "high", "all_day": True, "country": "US", "name": "Holiday"},  # no clock time
    {"ts": at("2026-11-19", "15:20"), "impact": "high", "all_day": False, "country": "US", "name": "After the exit"},
]


def test_the_features_by_hand() -> None:
    f = cs.features(DAY, cs.compute_context(SERIES, DAY), EVENTS, True, time(9, 45), time(15, 15), actual_gap_pts=60.0, prev_close=25000.0)
    assert f["gift_move_pct"] == 0.4 and f["es_move_pct"] == -1.0 and f["nq_move_pct"] is None
    assert f["gap_surprise_pts"] == pytest.approx(60.0 - 0.004 * 25000.0)  # -40: the gap GIFT did not foresee
    assert f["events_overnight"] == 1 and f["events_hold"] == 1
    assert f["events_overnight_names"] == ["US: Retail Sales"] and f["events_hold_names"] == ["EU: Flash PMI"]


def test_an_unknown_calendar_stays_unknown_not_zero() -> None:
    f = cs.features(DAY, None, None, False, time(9, 45), time(15, 15), None, None)
    assert f["events_overnight"] is None and f["events_hold"] is None and f["gift_move_pct"] is None and f["gap_surprise_pts"] is None
    assert cs.features(DAY, None, [], True, time(9, 45), time(15, 15), None, None)["events_hold"] == 0  # known and empty is a real zero


# ------------------------------------------------------------------ the ledger
def test_the_ledger_keeps_high_events_the_latest_outcome_and_the_first_context(tmp_path: Path) -> None:
    led = ContextLedger(tmp_path)
    ev = {"id": "a", "ts": at("2026-11-19", "13:30"), "date_ist": "2026-11-19", "country": "EU", "name": "Flash PMI", "impact": "high", "all_day": False, "forecast": "49.0", "actual": None}
    assert led.add_events([ev, {**ev, "id": "m", "impact": "medium"}]) == 1  # medium is not kept
    led.add_events([{**ev, "actual": "48.1", "forecast": None}])  # the outcome arrives later; the forecast stays
    rows = led.events_between(at("2026-11-19", "00:00"), at("2026-11-20", "00:00"))
    assert len(rows) == 1 and rows[0]["actual"] == "48.1" and rows[0]["forecast"] == "49.0"
    assert led.coverage() is None  # events alone say nothing about where the record begins (the calendar lists far dates)
    led.mark_covered("2026-11-17")
    led.mark_covered("2026-11-18")  # the earliest stands
    assert led.coverage() == ("2026-11-17", "2026-11-19")
    assert led.put_context("2026-11-19", {"moves": {"GIFT": {"pct": 0.4}}}) is True
    assert led.put_context("2026-11-19", {"moves": {"GIFT": {"pct": 9.9}}}) is False  # the pre-open record stands
    assert led.context("2026-11-19")["moves"]["GIFT"]["pct"] == 0.4 and led.context_days() == ["2026-11-19"]
    assert led.counts() == {"events": 1, "days": 1}
    led.close()


def test_the_service_records_the_context_from_the_stored_bars_once(tmp_path: Path) -> None:
    now = datetime(2026, 11, 19, 9, 20, tzinfo=IST)
    svc, _ = service(tmp_path, now=now)
    svc.ledger = ContextLedger(tmp_path / "ledger")
    with closing(svc.store._conn()) as c, c:
        c.executemany("INSERT OR IGNORE INTO bars VALUES (?,?,?)", [("GIFT", ts, p) for ts, p in SERIES["GIFT"]])
    out = svc.record_context()
    assert out["ok"] and "2026-11-19" in out["written"]
    assert svc.ledger.context("2026-11-19")["moves"]["GIFT"]["pct"] == 0.4
    assert svc.record_context()["written"] == []  # nothing new: the first record stands
    # before 09:14 the pre-open read does not exist yet
    early, _ = service(tmp_path / "e", now=datetime(2026, 11, 19, 8, 0, tzinfo=IST))
    early.ledger = ContextLedger(tmp_path / "e" / "ledger")
    assert "2026-11-19" not in early.record_context()["written"]
    svc.ledger.close()
    early.ledger.close()


def test_a_service_without_a_ledger_does_nothing(tmp_path: Path) -> None:
    svc, _ = service(tmp_path)
    assert svc.record_context() == {"ok": True, "skipped": "no ledger"}
    svc._ledger_add([{"impact": "high"}], datetime(2026, 11, 19, tzinfo=IST))  # must not raise


# ------------------------------------------------------------------ in the lab
def lab_day(context: dict | None, events: list | None, known: bool) -> el.Day:
    d = session("2026-11-19", [25060.0 + 0.0 * i for i in range(61)], [200.0] * 61, prev_close=25000.0)
    return el.Day(**{**d.__dict__, "context": context, "events": events, "events_known": known})


def test_the_gates_skip_on_events_and_on_a_big_gift_move_with_the_reason() -> None:
    ctx = cs.compute_context(SERIES, DAY)
    day = lab_day(ctx, EVENTS, True)
    plain = el.simulate(el.Rule(entry=time(9, 45), cost=0.0), day)
    assert not plain.get("skipped") and plain["signals"]["events_hold"] == 1 and plain["signals"]["gap_surprise_pts"] == pytest.approx(-40.0)
    held = el.simulate(el.Rule(entry=time(9, 45), skip_events_hold=True), day)
    assert held["gated"] and "Flash PMI" in held["skipped"]
    night = el.simulate(el.Rule(entry=time(9, 45), skip_events_overnight=True), day)
    assert night["gated"] and "Retail Sales" in night["skipped"]
    assert el.simulate(el.Rule(entry=time(9, 45), max_gift_pct=0.3), day)["gated"]  # |0.4| > 0.3
    assert not el.simulate(el.Rule(entry=time(9, 45), max_gift_pct=0.5), day).get("gated")


def test_a_day_without_context_or_with_an_unknown_calendar_is_never_gated() -> None:
    day = lab_day(None, None, False)
    r = el.simulate(el.Rule(entry=time(9, 45), skip_events_hold=True, skip_events_overnight=True, max_gift_pct=0.1), day)
    assert not r.get("skipped") and r["signals"].get("events_hold") is None and r["signals"].get("gift_move_pct") is None
    assert el.Rule(skip_events_hold=True).gated() and not el.Rule(skip_events_hold=True).ungated().gated()
    assert "event" in el.Rule(skip_events_hold=True).label()


def test_the_backfill_asks_week_by_week_for_high_importance_and_stores_only_those(tmp_path: Path) -> None:
    from app.intelligence.context_backfill import backfill, url
    from tests.unit.test_globalmkts import FIX

    asked: list[str] = []

    def fetch(u: str) -> bytes:
        asked.append(u)
        return (FIX / "biquote_calendar.json").read_bytes()

    led = ContextLedger(tmp_path)
    n = backfill(led, date(2026, 10, 28), date(2026, 11, 17), fetch)
    assert led.coverage() is not None and led.coverage()[0] == "2026-10-28"  # the backfill states where the record begins
    assert len(asked) == 3 and asked[0] == url(date(2026, 10, 28), date(2026, 11, 3)) and asked[2].endswith("to=2026-11-17&countries=" + asked[2].split("countries=")[1])
    assert "importance=high" in asked[0] and "IN" in asked[0] and "JP" in asked[0]
    assert n > 0 and led.counts()["events"] * 3 == n  # the same rows asked three times are stored once
    assert all(e["impact"] == "high" for e in led.events_between(0, 4_000_000_000_000))
    led.close()
