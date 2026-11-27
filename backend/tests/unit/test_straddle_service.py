"""The straddle decay service reads stored samples and never writes; a missing day or expiry is said plainly."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from app.intelligence.straddle_service import StraddleDecay
from app.intelligence.straddle_store import StraddleStore
from tests.unit.test_straddle_decay import EXPIRY, OPEN, STRIKES, chain

IST = ZoneInfo("Asia/Kolkata")


@dataclass
class FakeContract:
    ltp: float | None
    oi: int | None


@dataclass
class FakeSample:
    sample_id: int
    received_at: datetime
    spot: float | None
    values_from: int
    unchanged: bool = False


class FakeObs:
    def __init__(self, n: int) -> None:
        self.snaps = [chain(OPEN + timedelta(minutes=i), 24000.0 + (i % 5), 0.15) for i in range(n)]
        self.writes = 0

    def day_counts(self, underlying: str, lo: int, hi: int) -> list[tuple[str, int]]:
        d0 = int(datetime(2026, 11, 11, 3, 30, tzinfo=UTC).timestamp() * 1000)
        return [(EXPIRY.isoformat(), len(self.snaps))] if lo <= d0 <= hi else []

    def samples(self, underlying: str, expiry: str, *, since: datetime | None = None, until: datetime | None = None, limit: int = 5000) -> list[FakeSample]:
        return [FakeSample(i, s.at, s.spot, i) for i, s in enumerate(self.snaps) if (since is None or s.at >= since) and (until is None or s.at <= until)]

    def contracts(self, sample_id: int) -> dict[tuple[float, int], FakeContract]:
        s = self.snaps[sample_id]
        return {k: FakeContract(p, s.oi.get(k)) for k, p in s.prices.items()}


def svc(n: int = 60, now: datetime | None = None) -> StraddleDecay:
    t = now or (OPEN + timedelta(minutes=n))
    return StraddleDecay(observations=FakeObs(n), underlying="NIFTY", gex=None, rate=0.06, clock=lambda: t)


def test_summary_reads_the_latest_stored_session() -> None:
    a = svc().summary()
    assert a["status"] == "ok" and a["session"] == "2026-11-11" and a["expiry"] == EXPIRY.isoformat()
    assert a["samples"] == 60 and len(a["times"]) == 60
    assert a["tracker"]["fixed"]["strike"] == 24000.0
    assert len(STRIKES) == 13
    assert a["quality"]["live"] is True and a["quality"]["stale"] is False


def test_a_past_session_is_labelled_not_live() -> None:
    a = svc(now=OPEN + timedelta(days=2)).summary(session="2026-11-11")
    assert a["status"] == "ok" and a["quality"]["live"] is False and a["quality"]["stale"] is False


def test_no_samples_for_a_day_is_unavailable_not_empty_data() -> None:
    a = svc().summary(session="2026-11-04")
    assert a["status"] == "unavailable" and "No samples" in a["message"]


def test_validation_skips_the_running_session_and_says_insufficient() -> None:
    v = svc(n=100, now=datetime(2026, 11, 13, 12, 0, tzinfo=IST)).validation(sessions=5)
    assert v["sufficient"] is False and "Insufficient" in v["message"]
    assert v["overall"]["windows"] == 3
    live = svc(n=100, now=datetime(2026, 11, 11, 11, 0, tzinfo=IST)).validation(sessions=5)
    assert live["overall"]["windows"] == 0  # today's session is still running


def test_expiry_date_type() -> None:
    assert isinstance(EXPIRY, date)
    other: Any = svc().summary(expiry=EXPIRY.isoformat())
    assert other["expiry"] == EXPIRY.isoformat()


def test_as_of_is_the_analysis_as_it_stood_at_that_minute() -> None:
    now = OPEN + timedelta(days=2)
    s = svc(n=60, now=now)
    full = s.summary(session="2026-11-11")
    at = s.summary(session="2026-11-11", as_of=OPEN + timedelta(minutes=29, seconds=20))  # the 30th minute of 60
    assert at["status"] == "ok" and at["samples"] == 30 and len(at["times"]) == 30  # nothing after that minute is read
    assert full["samples"] == 60
    assert at["as_of"].startswith("2026-11-11T09:45:59")  # one answer per stored minute
    assert at["quality"]["live"] is False and at["environment"] is None  # never live, no buyer/seller scores
    assert at["tracker"]["fixed"]["straddle"]["current"] != full["tracker"]["fixed"]["straddle"]["current"]  # its "now" is that minute, not the close


def test_as_of_answers_are_reused_for_the_same_minute_and_do_not_touch_the_live_state() -> None:
    s = svc(n=60, now=OPEN + timedelta(days=2))
    live = s.summary(session="2026-11-11")
    kept = dict(s._last)  # noqa: SLF001 - what record() reads for the premium ladder
    cached = dict(s._cache)  # noqa: SLF001
    a1 = s.summary(session="2026-11-11", as_of=OPEN + timedelta(minutes=20, seconds=5))
    a2 = s.summary(session="2026-11-11", as_of=OPEN + timedelta(minutes=20, seconds=40))  # the same stored minute
    assert a1 is a2
    assert s._last == kept and s._cache == cached  # noqa: SLF001 - a replay leaves the live minute's reading alone
    assert s.summary(session="2026-11-11") is live  # the live answer is still the cached one


def test_as_of_keeps_only_a_few_dozen_answers() -> None:
    from app.intelligence import straddle_service as m

    s = svc(n=60, now=OPEN + timedelta(days=2))
    for i in range(m.ASOF_KEEP + 5):
        s.summary(session="2026-11-11", as_of=OPEN + timedelta(minutes=i % 55 + 2, seconds=i // 55))
    assert len(s._asof) <= m.ASOF_KEEP  # noqa: SLF001


def test_as_of_shows_only_the_recorded_history_and_alerts_up_to_that_minute(tmp_path: Path) -> None:
    store = StraddleStore(tmp_path)
    for m in (5, 15, 25, 35, 45):  # recorded minutes, 09:21 .. 10:01 IST
        at = (OPEN + timedelta(minutes=m)).astimezone(UTC)
        store.record("2026-11-11", at, EXPIRY.isoformat(), {"spot": 24000.0, "seller": 60.0 + m, "buyer": 40.0, "regime": "no clear regime", "eff30": {"pct": 50.0}})
        store.add_alert("2026-11-11", at, {"kind": f"k{m}", "severity": "low", "direction": "neutral", "text": f"alert at {m}", "evidence": []})
    s = StraddleDecay(observations=FakeObs(60), underlying="NIFTY", gex=None, rate=0.06, clock=lambda: OPEN + timedelta(days=2), store=store)
    full = s.summary(session="2026-11-11")
    assert len(full["history"]["times"]) == 5 and len(full["alerts"]) == 5
    at = s.summary(session="2026-11-11", as_of=OPEN + timedelta(minutes=26))
    assert [x for x in at["history"]["seller"]] == [65.0, 75.0, 85.0]  # only the minutes recorded by 26 minutes in
    assert sorted(a["kind"] for a in at["alerts"]) == ["k15", "k25", "k5"]
    assert at["environment_trend"]["seller"]["now"] == 85.0


class RunningObs(FakeObs):
    """A session in which NIFTY climbs 2 points a minute from 24,000: 100 points away from the opening strike at the 50th minute."""

    def __init__(self, n: int) -> None:
        super().__init__(n)
        self.snaps = [chain(OPEN + timedelta(minutes=i), 24000.0 + 2 * i, 0.15) for i in range(n)]
        self.sample_reads = 0

    def samples(self, underlying: str, expiry: str, *, since: datetime | None = None, until: datetime | None = None, limit: int = 5000) -> list[FakeSample]:
        self.sample_reads += 1
        return super().samples(underlying, expiry, since=since, until=until, limit=limit)


def test_the_managed_history_lists_each_sessions_re_strikes_and_keeps_finished_sessions() -> None:
    obs = RunningObs(60)
    s = StraddleDecay(observations=obs, underlying="NIFTY", gex=None, rate=0.06, clock=lambda: OPEN + timedelta(days=2))
    h = s.managed_history(5)
    assert h["threshold"] == 100.0 and len(h["days"]) == 1 and h["totals"]["sessions"] == 1
    day = h["days"][0]
    book = day["book"]
    assert day["session"] == "2026-11-11" and day["expiry"] == EXPIRY.isoformat() and day["live"] is False
    assert book["restrikes"] == 1 and len(book["segments"]) == 1 and book["strike_now"] == 24100.0
    held = book["open"]
    assert held["strike"] == 24100.0 and held["from"] == (OPEN + timedelta(minutes=50)).isoformat() and held["pnl"] == pytest.approx(held["entry"] - held["last"], abs=0.011)  # each figure is rounded to 0.01
    assert book["open_pnl"] == held["pnl"]
    seg = book["segments"][0]
    assert seg["strike"] == 24000.0 and seg["from"] == OPEN.isoformat() and seg["to"] == (OPEN + timedelta(minutes=50)).isoformat()  # 24,100 is reached at the 50th minute
    assert seg["pnl"] == pytest.approx(seg["entry"] - seg["exit"], abs=0.011)  # a sold straddle: entry minus exit
    assert book["realised"] == seg["pnl"] and book["total"] == round(book["realised"] + book["open_pnl"], 2)
    assert book["total_rupees"] == round(book["total"] * book["lot_size"])
    assert h["totals"]["restrikes"] == 1 and h["totals"]["total"] == book["total"]
    assert not s._cache  # the analysis the book came from is not kept  # noqa: SLF001
    reads = obs.sample_reads
    again = s.managed_history(5)
    assert again["days"][0] == day and obs.sample_reads == reads  # a finished session is read once


def test_the_running_session_is_read_again_and_marked_live() -> None:
    obs = RunningObs(60)
    s = StraddleDecay(observations=obs, underlying="NIFTY", gex=None, rate=0.06, clock=lambda: OPEN + timedelta(minutes=59))
    first = s.managed_history(3)["days"][0]
    assert first["live"] is True and first["book"] is not None
    reads = obs.sample_reads
    s.managed_history(3)
    assert obs.sample_reads > reads  # today's book changes with every minute: not kept


def test_a_day_without_samples_is_skipped_and_the_totals_are_empty() -> None:
    s = StraddleDecay(observations=RunningObs(60), underlying="NIFTY", gex=None, rate=0.06, clock=lambda: OPEN + timedelta(days=130))  # the newest 120 days hold nothing stored
    h = s.managed_history(5)
    assert h["days"] == [] and h["totals"] == {"sessions": 0, "restrikes": 0, "total": 0.0, "total_rupees": 0.0, "winning_sessions": 0}


def test_the_api_serves_the_managed_history(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from tests.conftest import make_app

    app = make_app(tmp_path / "app")
    with TestClient(app) as c:
        app.state.straddle = StraddleDecay(observations=RunningObs(60), underlying="NIFTY", gex=None, rate=0.06, clock=lambda: OPEN + timedelta(days=2))
        body = c.get("/api/intelligence/straddle/managed-history?sessions=3").json()
        assert body["threshold"] == 100.0 and body["days"][0]["session"] == "2026-11-11"
        assert body["days"][0]["book"]["restrikes"] == 1 and body["totals"]["sessions"] == 1
        app.state.straddle = StraddleDecay(observations=RunningObs(60), underlying="NIFTY", gex=None, rate=0.06, enabled=False)
        assert c.get("/api/intelligence/straddle/managed-history").status_code == 404
