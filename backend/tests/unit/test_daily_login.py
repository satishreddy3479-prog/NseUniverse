"""Morning broker sign-in schedule (no network; the broker is a stand-in that records calls)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from app.services.daily_login import IST, DailyLogin


def ist(h: int, m: int, s: int = 0, day: int = 29) -> datetime:
    return datetime(2026, 10, day, h, m, s, tzinfo=IST).astimezone(UTC)


class Broker:
    def __init__(self, results: list[str]) -> None:
        self.results, self.calls, self.after = results, 0, 0

    async def login(self) -> SimpleNamespace:
        self.calls += 1
        return SimpleNamespace(state=SimpleNamespace(value=self.results.pop(0)))

    async def after_login(self) -> None:
        self.after += 1


def make(results: list[str], now: datetime) -> tuple[DailyLogin, Broker, list[datetime]]:
    b, clock = Broker(results), [now]
    return DailyLogin(b.login, b.after_login, clock=lambda: clock[0]), b, clock


def test_due_only_between_0830_and_0910_once_per_day() -> None:
    d, _, clock = make(["authenticated"], ist(8, 29, 59))
    assert not d.due()
    clock[0] = ist(8, 30)
    assert d.due()
    clock[0] = ist(9, 10)
    assert not d.due()  # window closed
    clock[0] = ist(14, 0)
    assert not d.due()


async def test_success_logs_in_once_restarts_the_stream_and_is_done_for_the_day() -> None:
    d, b, clock = make(["authenticated"], ist(8, 30))
    assert await d.run_once() is True
    assert (b.calls, b.after) == (1, 1)
    clock[0] = ist(8, 35)
    assert not d.due() and d.status()["done_today"] is True
    clock[0] = ist(8, 30, day=30)  # next morning
    assert d.due() and d.status()["done_today"] is False


async def test_failure_is_retried_every_five_minutes_and_does_not_restart_the_stream() -> None:
    d, b, clock = make(["failed", "authenticated"], ist(8, 30))
    assert await d.run_once() is False
    assert b.after == 0 and "retry" in d.status()["last_result"]
    clock[0] = ist(8, 33)
    assert not d.due()
    clock[0] = ist(8, 30) + timedelta(minutes=5)
    assert d.due()
    assert await d.run_once() is True and b.after == 1


async def test_an_exception_never_escapes_and_disabled_never_runs() -> None:
    async def boom() -> None:
        raise RuntimeError("secret-looking text")

    d = DailyLogin(boom, clock=lambda: ist(8, 31))
    assert await d.run_once() is False
    assert d.status()["last_result"] == "error: RuntimeError"  # type only, no message
    off = DailyLogin(boom, enabled=False, clock=lambda: ist(8, 31))
    assert not off.due()
