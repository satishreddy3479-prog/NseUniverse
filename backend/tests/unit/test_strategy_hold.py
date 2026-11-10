# ruff: noqa: E501
"""Intraday / overnight holding rule: when the open legs are closed automatically (paper)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

from app.strategy.automation import apply_hold, hold_moment, hold_problem

LOT = 65


def ist(d: str, h: int, m: int) -> datetime:
    return datetime.fromisoformat(f"{d}T{h:02d}:{m:02d}:00+05:30")


def leg(expiry: str = "2026-11-12", **kw: Any) -> dict[str, Any]:
    return {"id": "a", "key": "k", "expiry": expiry, "strike": 24900, "type": "CE", "action": "SELL", "lots": 1, "premium": 100.0, "reentry": 1, **kw}


def px(v: float | None) -> Callable[[dict[str, Any]], float | None]:
    return lambda _lg: v


def test_intraday_closes_every_open_leg_at_the_set_time_and_only_then() -> None:
    held = ist("2026-11-10", 10, 0)
    hold = {"mode": "intraday", "closeAt": "15:20"}
    legs, ev = apply_hold([leg()], hold, held, px(80.0), LOT, ist("2026-11-10", 15, 19), 1)
    assert not ev and legs[0].get("exitPrice") is None
    legs, ev = apply_hold([leg()], hold, held, px(80.0), LOT, ist("2026-11-10", 15, 20), 1)
    assert len(ev) == 1 and legs[0]["exitPrice"] == 80.0 and legs[0]["exitReason"] == "strategy" and legs[0]["reentry"] == 0
    assert legs[0]["realised"] == (100 - 80) * LOT  # a sold leg that fell 20 points gains 20 x 65
    again, ev2 = apply_hold(legs, hold, held, px(70.0), LOT, ist("2026-11-10", 15, 25), 1)
    assert again == legs and not ev2  # closing twice is not possible


def test_intraday_armed_after_the_close_time_waits_for_the_next_trading_day() -> None:
    hold = {"mode": "intraday", "closeAt": "15:20"}
    assert hold_moment(hold, ist("2026-11-10", 15, 30), None) == ist("2026-11-11", 15, 20)
    assert hold_moment(hold, ist("2026-11-13", 16, 0), None) == ist("2026-11-16", 15, 20)  # Friday evening -> Monday


def test_overnight_holds_until_the_expiry_day_close_time() -> None:
    held = ist("2026-11-10", 10, 0)
    hold = {"mode": "overnight", "closeAt": "15:20"}
    legs, ev = apply_hold([leg()], hold, held, px(80.0), LOT, ist("2026-11-10", 15, 25), 1)
    assert not ev, "not closed on a day before expiry"
    legs, ev = apply_hold([leg()], hold, held, px(80.0), LOT, ist("2026-11-12", 15, 20), 1)
    assert len(ev) == 1 and legs[0]["exitPrice"] == 80.0


def test_overnight_armed_after_the_expiry_close_time_is_left_to_settle() -> None:
    hold = {"mode": "overnight", "closeAt": "15:20"}
    assert hold_moment(hold, ist("2026-11-12", 15, 30), "2026-11-12") is None


def test_a_leg_without_a_live_price_stays_open_and_manual_never_closes() -> None:
    held = ist("2026-11-10", 10, 0)
    legs, ev = apply_hold([leg()], {"mode": "intraday", "closeAt": "15:20"}, held, px(None), LOT, ist("2026-11-10", 15, 30), 1)
    assert not ev and legs[0].get("exitPrice") is None
    legs, ev = apply_hold([leg()], {"mode": "manual", "closeAt": "15:20"}, held, px(80.0), LOT, ist("2026-11-12", 15, 30), 1)
    assert not ev and legs[0].get("exitPrice") is None


def test_close_time_must_be_inside_the_session() -> None:
    assert hold_problem({"mode": "intraday", "closeAt": "15:20"}) is None
    assert hold_problem({"mode": "intraday", "closeAt": "16:00"}) is not None
    assert hold_problem({"mode": "intraday", "closeAt": "9:15"}) is not None
    assert hold_problem({"mode": "weekly", "closeAt": "15:20"}) is not None
