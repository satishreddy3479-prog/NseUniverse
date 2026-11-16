"""Every leg event carries its date and time: entry, stop and target set, the trailing stop's moves, the move to cost, re-entry and exit (server side; the browser's twin is in leg-times.test.tsx)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.strategy.automation import _stamp, apply_automation, exit_leg, reenter_leg

ENTERED = "2026-11-16T04:55:50.870000+00:00"
STOP_AT = datetime(2026, 11, 16, 5, 4, 38, 876000, tzinfo=UTC)  # 10:34:38 IST: when the put of the user's short 25300 straddle was stopped
LOT = 65


def leg(**kw: Any) -> dict[str, Any]:
    base = {"id": "p", "key": "k", "expiry": "2026-11-17", "strike": 25300, "type": "PE", "action": "SELL", "lots": 1, "premium": 106.2, "premiumSource": "market", "stop": 148.7, "target": 60.0, "enteredAt": ENTERED}
    return base | kw


def test_the_stamp_has_the_date() -> None:
    assert _stamp(STOP_AT) == "16 Nov, 10:34:38"


def test_a_stop_is_logged_with_date_and_time_and_the_exit_time_is_kept() -> None:
    out = exit_leg(leg(), 149.25, "stop", LOT, STOP_AT)
    assert out["exitedAt"] == STOP_AT.isoformat()
    assert out["log"][-1] == {"at": STOP_AT.isoformat(), "text": "16 Nov, 10:34:38 Stop: SELL 25300 PE closed at 149.25 (entry 106.20), −₹2,798 [server]"}


def test_the_trailing_stop_logs_every_move_and_its_time() -> None:
    at = datetime(2026, 11, 16, 6, 0, tzinfo=UTC)
    # sold at 100, stop 140; every 10% of the entry in favour moves the stop 5%: at 80 the gain is 20% (2 steps), the stop goes 140 -> 130
    lg = leg(premium=100.0, stop=140.0, target=None, trailEvery=10, trailBy=5, type="CE")
    legs, events = apply_automation([lg], lambda _l: 80.0, LOT, at)
    out = legs[0]
    assert out["stop"] == 130.0 and out["stopSetAt"] == at.isoformat()
    assert out["log"][-1] == {"at": at.isoformat(), "text": "16 Nov, 11:30:00 Trailing stop: SELL 25300 CE stop 140.00 → 130.00 (price 80.00) [server]"}
    assert len(events) == 1  # the event count the parity check compares is unchanged
    legs2, events2 = apply_automation(legs, lambda _l: 80.0, LOT, at)
    assert legs2 == legs and events2 == []  # a second pass over the same price adds nothing


def test_the_move_to_cost_and_a_re_entry_set_their_times() -> None:
    at = datetime(2026, 11, 16, 6, 30, tzinfo=UTC)
    put = leg(stop=148.7)
    call = leg(id="c", key="k2", type="CE", premium=94.7, stop=132.6, target=None)
    legs, _events = apply_automation([put, call], lambda lg: 149.25 if lg["type"] == "PE" else 80.0, LOT, at, move_to_cost=True)
    moved = next(x for x in legs if x["type"] == "CE")
    assert moved["stop"] == 94.7 and moved["stopSetAt"] == at.isoformat() and moved["log"][-1]["text"].startswith("16 Nov, 12:00:00 Stop moved to cost")
    stopped = exit_leg(leg(stopPct=0.4, targetPct=0.43, reentry=1), 149.25, "stop", LOT, STOP_AT)
    again = reenter_leg(stopped, 106.2, at)
    assert again["enteredAt"] == at.isoformat() and again["stopSetAt"] == at.isoformat() and again["targetSetAt"] == at.isoformat()
