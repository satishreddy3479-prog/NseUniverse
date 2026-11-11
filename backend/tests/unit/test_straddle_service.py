"""The straddle decay service reads stored samples and never writes; a missing day or expiry is said plainly."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from app.intelligence.straddle_service import StraddleDecay
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
        return [FakeSample(i, s.at, s.spot, i) for i, s in enumerate(self.snaps)]

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
