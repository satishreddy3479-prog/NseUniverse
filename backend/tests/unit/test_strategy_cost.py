"""Move SL to cost on the server: when a leg is stopped out, the stop of each other open leg on the same side moves to its own entry premium.

Hand-calculated; the browser's ``moveStopsToCost`` is held to the same numbers by frontend/src/test/strategy-cost.test.ts and by the 300-case parity fixture.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from app.strategy.automation import apply_automation

AT = datetime(2026, 11, 12, 5, 0, tzinfo=UTC)  # 10:30 IST
LOT = 65


def leg(i: str, typ: str, action: str = "SELL", prem: float = 100.0, stop: float | None = 130.0, **kw: Any) -> dict[str, Any]:
    return {"id": i, "key": i, "expiry": "2026-11-17", "strike": 25000, "type": typ, "action": action, "lots": 1, "premium": prem, "stop": stop, "enabled": True, **kw}


def run(legs: list[dict[str, Any]], prices: dict[str, float | None], cost: bool = True) -> tuple[dict[str, dict[str, Any]], list[str]]:
    out, ev = apply_automation(legs, lambda lg: prices.get(lg["id"]), LOT, AT, 1, cost)
    return {lg["id"]: lg for lg in out}, ev


def test_the_other_leg_of_a_short_straddle_moves_to_its_entry_when_one_leg_is_stopped_and_is_in_profit() -> None:
    legs, ev = run([leg("ce", "CE"), leg("pe", "PE")], {"ce": 130.0, "pe": 80.0})
    ce, pe = legs["ce"], legs["pe"]
    assert ce["exitPrice"] == 130.0 and ce["exitReason"] == "stop" and ce["realised"] == -30.0 * 65  # sold at 100, stopped at 130: -30 x 65
    assert pe["stop"] == 100.0 and pe["stopTrailed"] is True and pe["costMoved"] is True and pe["stopBase"] == 130.0  # the stop you set is remembered
    assert pe.get("exitPrice") is None  # still open
    assert any("Stop moved to cost: SELL 25000 PE stop 130.00 → 100.00 because SELL 25000 CE was stopped out" in e for e in ev)
    assert any("Stop moved to cost" in x["text"] for x in pe["log"])


def test_it_is_off_unless_the_toggle_is_on() -> None:
    legs, ev = run([leg("ce", "CE"), leg("pe", "PE")], {"ce": 130.0, "pe": 80.0}, cost=False)
    assert legs["pe"]["stop"] == 130.0 and "costMoved" not in legs["pe"] and len(ev) == 1  # only the exit itself


def test_the_moved_stop_then_exits_at_cost_with_zero_pnl_and_says_so() -> None:
    legs, _ = run([leg("ce", "CE"), leg("pe", "PE")], {"ce": 130.0, "pe": 80.0})
    again, ev = run([legs["pe"]], {"pe": 100.0})  # the put premium climbs back to its entry
    assert again["pe"]["exitPrice"] == 100.0 and again["pe"]["realised"] == 0.0
    assert any(e.split(" ", 1)[1].startswith("Stop at cost: SELL 25000 PE closed at 100.00 (entry 100.00)") for e in ev)
    below, ev2 = run([legs["pe"]], {"pe": 99.95})  # one tick short of the entry: still open
    assert below["pe"].get("exitPrice") is None and ev2 == []


def test_a_leg_that_is_not_in_profit_is_left_alone_and_the_event_says_why() -> None:
    legs, ev = run([leg("ce", "CE"), leg("pe", "PE")], {"ce": 130.0, "pe": 110.0})  # the put is at a loss too
    assert legs["pe"]["stop"] == 130.0 and "costMoved" not in legs["pe"]
    assert any("Stop to cost skipped for SELL 25000 PE: it is not in profit (price 110.00 against entry 100.00)" in e for e in ev)
    flat, ev2 = run([leg("ce", "CE"), leg("pe", "PE")], {"ce": 130.0, "pe": 100.0})  # exactly at cost is not in profit: no instant exit
    assert flat["pe"]["stop"] == 130.0 and flat["pe"].get("exitPrice") is None and any("not in profit" in e for e in ev2)


def test_a_leg_without_a_live_price_is_left_alone_and_the_event_says_so() -> None:
    legs, ev = run([leg("ce", "CE"), leg("pe", "PE")], {"ce": 130.0, "pe": None})
    assert legs["pe"]["stop"] == 130.0 and any("Stop to cost skipped for SELL 25000 PE: no live price" in e for e in ev)


def test_only_legs_on_the_same_side_move_so_a_bought_wing_keeps_its_own_stop() -> None:
    wing = leg("w", "CE", action="BUY", prem=20.0, stop=10.0)
    legs, _ = run([leg("ce", "CE"), leg("pe", "PE"), wing], {"ce": 130.0, "pe": 80.0, "w": 30.0})
    assert legs["w"]["stop"] == 10.0 and "costMoved" not in legs["w"]
    assert legs["pe"]["stop"] == 100.0
    # a stopped BUY leg moves the other BUY legs: bought at 20, stopped at 10; another bought leg at 50 (price 70, in profit) moves to 50
    legs2, _ = run([wing, leg("b2", "PE", action="BUY", prem=50.0, stop=40.0), leg("s", "CE")], {"w": 10.0, "b2": 70.0, "s": 90.0})
    assert legs2["b2"]["stop"] == 50.0 and legs2["b2"]["costMoved"] is True and legs2["s"]["stop"] == 130.0


def test_a_stop_is_only_ever_tightened() -> None:
    tight = leg("pe", "PE", stop=95.0)  # already below the entry for a seller: tighter than cost
    legs, ev = run([leg("ce", "CE"), tight], {"ce": 130.0, "pe": 80.0})
    assert legs["pe"]["stop"] == 95.0 and "costMoved" not in legs["pe"] and not any("moved to cost" in e for e in ev)
    at_cost = leg("pe", "PE", stop=100.0)
    legs2, ev2 = run([leg("ce", "CE"), at_cost], {"ce": 130.0, "pe": 80.0})
    assert legs2["pe"]["stop"] == 100.0 and "costMoved" not in legs2["pe"] and not any("moved to cost" in e for e in ev2)


def test_a_leg_without_a_stop_gets_one_at_cost_and_a_later_reentry_does_not_inherit_a_zero_distance() -> None:
    legs, _ = run([leg("ce", "CE"), leg("pe", "PE", stop=None, reentry=1)], {"ce": 130.0, "pe": 80.0})
    pe = legs["pe"]
    assert pe["stop"] == 100.0 and pe["stopBase"] is None and pe["costMoved"] is True
    out, _ = run([pe], {"pe": 100.0})
    assert out["pe"]["exitReason"] == "stop" and out["pe"]["stopPct"] is None  # no stop was ever typed: nothing to copy to the re-entry
    back, _ = run([out["pe"]], {"pe": 95.0})
    assert back["pe"].get("exitPrice") is None and back["pe"]["premium"] == 95.0 and back["pe"]["stop"] is None and back["pe"]["costMoved"] is False


def test_a_target_hit_or_two_stops_on_one_pass_move_nothing_and_raise_nothing() -> None:
    legs, ev = run([leg("ce", "CE", target=60.0), leg("pe", "PE")], {"ce": 60.0, "pe": 80.0})  # a target, not a stop
    assert legs["ce"]["exitReason"] == "target" and legs["pe"]["stop"] == 130.0 and not any("moved to cost" in e for e in ev)
    both, ev2 = run([leg("ce", "CE"), leg("pe", "PE")], {"ce": 130.0, "pe": 131.0})  # both stopped on the same pass
    assert both["ce"]["exitReason"] == "stop" and both["pe"]["exitReason"] == "stop" and not any("to cost" in e for e in ev2)


def test_unticked_legs_are_not_touched_and_a_repeat_pass_changes_nothing() -> None:
    off = leg("off", "PE", enabled=False)
    legs, _ = run([leg("ce", "CE"), leg("pe", "PE"), off], {"ce": 130.0, "pe": 80.0, "off": 80.0})
    assert legs["off"]["stop"] == 130.0 and "costMoved" not in legs["off"]
    again, ev = run([legs["ce"], legs["pe"], legs["off"]], {"ce": 130.0, "pe": 80.0, "off": 80.0})
    assert again["pe"] == legs["pe"] and ev == []  # a second look at the same prices does nothing


def test_the_trail_runs_at_once_on_a_leg_that_just_got_its_first_stop() -> None:
    # sold at 100 with a 10 % / 5 % trail but no stop: at 80 (20 % in profit) the stop goes to cost 100, then the trail lifts it by two steps of 5 points
    legs, ev = run([leg("ce", "CE"), leg("pe", "PE", stop=None, trailEvery=10, trailBy=5)], {"ce": 130.0, "pe": 80.0})
    assert legs["pe"]["stop"] == 90.0  # base 100 - 2 x 5 % x 100
    assert any("Trailing stop SELL 25000 PE: stop 100.00 → 90.00" in e for e in ev)


def test_the_service_applies_the_toggle_from_the_stored_document_without_any_browser(tmp_path: Any) -> None:
    from app.storage.strategies import StrategyStore
    from app.strategy.automation import StrategyAutomation

    prices = {"nse_fo|1": 130.0, "nse_fo|2": 80.0}
    auto = StrategyAutomation(StrategyStore(tmp_path), lambda k: prices.get(k), lambda: True, now=lambda: AT)
    ce, pe = leg("ce", "CE", key="nse_fo|1"), leg("pe", "PE", key="nse_fo|2")
    base = {"auto": True, "lotSize": 65, "mult": 1, "expiry": "2026-11-17", "legs": [ce, pe]}
    auto.put({**base, "moveToCost": True}, None)
    ev = auto.check_once()
    got = {x["id"]: x for x in auto.get()["legs"]}  # type: ignore[index]
    assert got["ce"]["exitReason"] == "stop" and got["pe"]["stop"] == 100.0 and got["pe"]["costMoved"] is True
    assert any("Stop moved to cost" in e for e in ev)
    # the same document with the toggle off leaves the other stop where it was
    auto2 = StrategyAutomation(StrategyStore(tmp_path / "b"), lambda k: prices.get(k), lambda: True, now=lambda: AT)
    auto2.put({**base, "moveToCost": False}, None)
    auto2.check_once()
    assert {x["id"]: x for x in auto2.get()["legs"]}["pe"]["stop"] == 130.0  # type: ignore[index]
