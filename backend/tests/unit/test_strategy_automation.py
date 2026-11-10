"""Server-side paper stop/target/re-entry: the same rules as the browser's applyAutomation, hand-calculated."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.storage.strategies import StrategyStore
from app.strategy.automation import (
    RUNNING_KEY,
    RUNNING_KIND,
    RunningConflict,
    StrategyAutomation,
    apply_automation,
    apply_strategy_rules,
    hit_of,
    lock_floor,
    trail_leg,
)

AT = datetime(2026, 11, 5, 4, 0, tzinfo=UTC)


def sold(**kw: object) -> dict[str, object]:
    return {"id": "a", "key": "nse_fo|1", "strike": 23300, "type": "CE", "action": "SELL", "lots": 1,
            "premium": 100.0, "stop": 130.0, "target": 50.0, "enabled": True, **kw}  # fmt: skip


def test_hit_rules_by_side_and_wrong_side_levels_never_fire() -> None:
    assert hit_of(sold(), "stop", 130) and not hit_of(sold(), "stop", 129.95)  # a seller is stopped when the premium rises
    assert hit_of(sold(), "target", 50) and not hit_of(sold(), "target", 50.05)
    assert hit_of({"action": "BUY", "premium": 100, "target": 150}, "target", 150)
    assert not hit_of(sold(stop=100.0), "stop", 100)  # a 0 % stop sits on the entry: a slip, not a trigger
    assert not hit_of(sold(stop=1.0), "stop", 100)  # "1" on the way to 130
    assert not hit_of({"action": "SELL"}, "stop", 999)


def test_stop_closes_at_the_live_price_with_hand_calculated_pnl_and_reentry_then_enters_again() -> None:
    leg = sold(reentry=1)
    legs, ev = apply_automation([leg], lambda _l: 125.0, 65, AT)
    assert ev == [] and legs[0].get("exitPrice") is None  # below the stop of 130
    legs, ev = apply_automation(legs, lambda _l: 133.0, 65, AT)
    assert legs[0]["exitPrice"] == 133.0 and legs[0]["exitReason"] == "stop"
    assert legs[0]["realised"] == pytest.approx(-(133 - 100) * 65)  # −2,145
    assert legs[0]["reentryLevel"] == 100.0 and "[server]" in ev[0]
    legs, ev = apply_automation(legs, lambda _l: 110.0, 65, AT)
    assert legs[0]["exitPrice"] == 133.0  # still above its entry: stays out
    legs, ev = apply_automation(legs, lambda _l: 98.0, 65, AT)
    assert legs[0]["exitPrice"] is None and legs[0]["premium"] == 98.0 and legs[0]["reentry"] == 0
    assert legs[0]["stop"] == 127.4  # 98 x 1.3, same distance as before
    assert legs[0]["target"] == 49.0  # 98 x 0.5


def test_a_leg_without_a_price_or_disabled_is_left_alone() -> None:
    legs, ev = apply_automation([sold(), sold(enabled=False)], lambda _l: None, 65, AT)
    assert ev == [] and legs[0].get("exitPrice") is None
    legs, ev = apply_automation([sold(enabled=False)], lambda _l: 500.0, 65, AT)
    assert ev == []


def make(tmp_path: Path, price: float | None, live: bool = True) -> tuple[StrategyAutomation, StrategyStore]:
    store = StrategyStore(tmp_path)
    auto = StrategyAutomation(store, lambda k: price if k == "nse_fo|1" else None, lambda: live, now=lambda: AT)
    return auto, store


def doc(**kw: object) -> dict[str, object]:
    return {"auto": True, "lotSize": 65, "mult": 1, "expiry": "2026-11-09", "legs": [sold()], **kw}


def test_service_exits_without_any_browser_and_a_stale_browser_write_is_refused(tmp_path: Path) -> None:
    auto, store = make(tmp_path, 131.0)
    put = auto.put(doc(), None)
    assert put["rev"] == 1
    assert auto.check_once() and auto.get()["legs"][0]["exitPrice"] == 131.0  # type: ignore[index]
    now = auto.get()
    assert now["rev"] == 2 and now["serverEvents"]  # type: ignore[index]
    with pytest.raises(RunningConflict) as e:  # the browser still has rev 1 and wants to write its old legs back
        auto.put(doc(), 1)
    assert e.value.current["legs"][0]["exitPrice"] == 131.0
    again = auto.put(doc(), 2)  # a copy that never saw the exit but carries the current revision (the bug of 6 Nov 2026)
    assert again["rev"] == 3
    assert again["legs"][0]["exitPrice"] == 131.0, "an old copy must not re-open a leg the server closed"
    assert "Ignored an old copy of SELL 23300 CE (closed at 131.0)" in again["serverEvents"][-1]["text"]
    assert store.history(RUNNING_KIND, RUNNING_KEY) == []  # the running copy does not fill the revision history
    store.close()


@pytest.mark.parametrize(
    ("price", "live", "extra"),
    [(131.0, False, {}), (131.0, True, {"auto": False}), (131.0, True, {"expiry": "2026-11-03"}), (None, True, {})],
)
def test_service_does_nothing_when_not_live_off_expired_or_without_a_price(tmp_path: Path, price: float | None, live: bool, extra: dict[str, object]) -> None:
    auto, store = make(tmp_path, price, live)
    auto.put(doc(**extra), None)
    assert auto.check_once() == []
    assert auto.get()["legs"][0].get("exitPrice") is None  # type: ignore[index]
    store.close()


def test_percentage_trail_moves_the_stop_by_hand_calculated_steps_and_only_tightens() -> None:
    leg = sold(trailEvery=10.0, trailBy=5.0)  # sold at 100, stop 130: every 10 % of 100 the premium falls, the stop falls 5 % of 100
    assert trail_leg(leg, 95.0) is leg  # 5 % in favour: no full step yet
    assert trail_leg(leg, 90.0)["stop"] == 125.0  # 10 %: one step
    two = trail_leg(leg, 80.0)
    assert two["stop"] == 120.0 and two["stopBase"] == 130.0 and two["stopTrailed"]  # 20 %: two steps
    assert trail_leg(two, 90.0) is two  # the price came back: the stop stays where it was
    far = trail_leg(trail_leg(two, 30.0), 30.0)
    assert far["stop"] == 95.0  # 70 %: seven steps, 130 - 35: the stop now locks profit (below the entry of 100)
    assert hit_of(far, "stop", 95.0) and not hit_of(far, "stop", 94.95)  # and a trailed stop may sit on the profit side
    assert not hit_of(sold(stop=95.0), "stop", 95.0)  # a typed one still may not
    buy = {"action": "BUY", "premium": 100.0, "stop": 70.0, "trailEvery": 10.0, "trailBy": 5.0}
    assert trail_leg(buy, 120.0)["stop"] == 80.0  # 20 % up: two steps of 5 up from 70
    assert trail_leg({**leg, "trailBy": None}, 50.0) == {**leg, "trailBy": None}  # incomplete setting: nothing happens
    assert trail_leg({**leg, "stop": None}, 50.0)["stop"] is None  # no stop to trail


def test_trailed_stop_closes_the_leg_and_re_entry_keeps_the_original_distance() -> None:
    legs, ev = apply_automation([sold(trailEvery=10.0, trailBy=5.0, target=None, reentry=1)], lambda _l: 80.0, 65, AT)
    assert legs[0]["stop"] == 120.0 and "Trailing stop" in ev[0] and legs[0].get("exitPrice") is None
    legs, ev = apply_automation(legs, lambda _l: 120.5, 65, AT)
    assert legs[0]["exitPrice"] == 120.5 and "Trailing stop:" in ev[0]
    assert legs[0]["realised"] == pytest.approx(-(120.5 - 100) * 65)
    assert legs[0]["stopPct"] == pytest.approx(0.3)  # the stop as the user set it, not the trailed one
    legs, _ = apply_automation(legs, lambda _l: 99.0, 65, AT)
    assert legs[0]["premium"] == 99.0 and legs[0]["stop"] == pytest.approx(128.7) and not legs[0]["stopTrailed"]


RULES = {"sl": None, "target": None, "lockAt": None, "lockProfit": None, "trailEvery": None, "trailBy": None}


def test_lock_floor_is_hand_calculated() -> None:
    r = {**RULES, "lockAt": 1000, "lockProfit": 500, "trailEvery": 300, "trailBy": 200}
    assert lock_floor(r, 999) is None
    assert lock_floor(r, 1000) == 500
    assert lock_floor(r, 1299) == 500
    assert lock_floor(r, 1300) == 700
    assert lock_floor(r, 1625) == 900  # two full steps of 300 above 1,000
    assert lock_floor({**r, "trailEvery": None, "trailBy": None}, 5000) == 500  # lock only
    assert lock_floor({**r, "lockProfit": 1000}, 5000) is None  # locking at the trigger would exit at once: ignored
    assert lock_floor({**r, "trailBy": 400}, 5000) is None  # a floor rising faster than the profit: ignored
    assert lock_floor({**r, "trailBy": None}, 5000) is None  # half a trail setting: ignored


def test_strategy_stop_loss_and_target_close_every_open_leg_and_nothing_re_enters() -> None:
    two = [sold(stop=None, target=None, reentry=2), sold(id="b", key="nse_fo|2", strike=23100, type="PE", premium=80.0, stop=None, target=None, reentry=2)]
    px = {"a": 100.0, "b": 80.0}
    price = lambda lg: px[lg["id"]]  # noqa: E731
    rules = {**RULES, "sl": 2000, "target": 3000}
    legs, st, ev = apply_strategy_rules(two, rules, {}, price, 65, AT)
    assert ev == [] and st == {}  # P&L 0
    px.update(a=115.0, b=95.0)  # -(15 + 15) x 65 = -1,950: just inside the stop
    assert apply_strategy_rules(legs, rules, {}, price, 65, AT)[2] == []
    px.update(a=116.0)  # -(16 + 15) x 65 = -2,015: through the -2,000 stop
    legs, st, ev = apply_strategy_rules(legs, rules, {}, price, 65, AT)
    assert st["done"] == "sl" and len(ev) == 2 and "Strategy stop loss" in ev[0]
    assert [lg["exitReason"] for lg in legs] == ["strategy", "strategy"] and all(lg["reentry"] == 0 for lg in legs)
    assert sum(lg["realised"] for lg in legs) == pytest.approx(-2015)
    assert apply_strategy_rules(legs, rules, st, price, 65, AT)[2] == []  # done: never fires twice
    px.update(a=50.0, b=40.0)
    _, st, ev = apply_strategy_rules(two, rules, {}, price, 65, AT, 2)  # multiplier 2: (50 + 40) x 65 x 2 = 11,700 >= 3,000
    assert st["done"] == "target" and "Strategy target" in ev[0]


def test_lock_and_trail_floor_only_rises_and_exits_when_the_pnl_falls_back_to_it() -> None:
    leg = [sold(stop=None, target=None)]
    px = [100.0]
    price = lambda _l: px[0]  # noqa: E731
    rules = {**RULES, "lockAt": 1000, "lockProfit": 500, "trailEvery": 300, "trailBy": 200}
    state: dict[str, object] = {}
    px[0] = 85.0  # (100 - 85) x 65 = 975: not locked yet
    leg, state, ev = apply_strategy_rules(leg, rules, state, price, 65, AT)
    assert state.get("floor") is None and ev == []
    px[0] = 80.0  # 1,300: floor 500 + 200 = 700
    leg, state, ev = apply_strategy_rules(leg, rules, state, price, 65, AT)
    assert state["floor"] == 700 and ev == []
    px[0] = 75.0  # 1,625: floor 900
    leg, state, ev = apply_strategy_rules(leg, rules, state, price, 65, AT)
    assert state["floor"] == 900
    px[0] = 78.0  # 1,430: back below the 1,625 peak, floor stays 900, no exit yet
    leg, state, ev = apply_strategy_rules(leg, rules, state, price, 65, AT)
    assert state["floor"] == 900 and ev == [] and leg[0].get("exitPrice") is None
    px[0] = 86.0  # (100 - 86) x 65 = 910: still above the floor
    leg, state, ev = apply_strategy_rules(leg, rules, state, price, 65, AT)
    assert ev == []
    px[0] = 86.5  # 877.5: through the floor of 900
    leg, state, ev = apply_strategy_rules(leg, rules, state, price, 65, AT)
    assert state["done"] == "lock" and leg[0]["exitPrice"] == 86.5 and "Locked profit" in ev[0]
    assert leg[0]["realised"] == pytest.approx(877.5)


def test_rules_wait_for_every_open_leg_to_have_a_price() -> None:
    two = [sold(stop=None, target=None), sold(id="b", key="nse_fo|2", premium=80.0, stop=None, target=None)]
    price = lambda lg: 500.0 if lg["id"] == "a" else None  # noqa: E731
    legs, st, ev = apply_strategy_rules(two, {**RULES, "sl": 10}, {}, price, 65, AT)
    assert legs is two and st == {} and ev == []


def test_service_applies_the_rules_and_keeps_the_floor_unless_a_re_arm_is_asked(tmp_path: Path) -> None:
    auto, store = make(tmp_path, 80.0)
    rules = {**RULES, "lockAt": 1000, "lockProfit": 500}
    auto.put(doc(legs=[sold(stop=None, target=None)], rules=rules), None)
    assert auto.check_once() == [] and auto.get()["rstate"]["floor"] == 500  # type: ignore[index]  # 1,300 in profit: the floor is saved
    rev = auto.get()["rev"]  # type: ignore[index]
    again = auto.put(doc(legs=[sold(stop=None, target=None)], rules=rules), rev)  # a browser edit does not wipe the server's floor
    assert again["rstate"]["floor"] == 500
    rearmed = auto.put(doc(legs=[sold(stop=None, target=None)], rules=rules, rearmAt="x"), again["rev"])
    assert rearmed["rstate"] is None
    store.close()


def test_a_closed_leg_can_only_be_reopened_by_a_real_re_entry_or_a_fresh_start(tmp_path: Path) -> None:
    auto, store = make(tmp_path, 131.0)
    auto.put(doc(), None)
    auto.check_once()  # the stop closes the leg at 131.00
    closed = auto.get()["legs"][0]  # type: ignore[index]
    rev = auto.get()["rev"]  # type: ignore[index]
    # 1. the same leg open again with the same entry price and cycle count is an old copy: refused
    kept = auto.put(doc(), rev)
    assert kept["legs"][0]["exitPrice"] == 131.0 and kept["legs"][0]["realised"] == closed["realised"]
    # 2. a real re-entry (the page's "Enter again": new entry price, one more cycle) is accepted
    reopened = {**sold(premium=118.5, stop=154.05, cycles=1), "id": "a"}
    out = auto.put(doc(legs=[reopened]), kept["rev"])
    assert out["legs"][0].get("exitPrice") is None and out["legs"][0]["premium"] == 118.5
    # 3. after another stop, the same contract and entry price under a new leg id is an old copy from another device, unless the
    #    page asked for a fresh start (it does when a saved strategy or a template is opened or a new strategy begins)
    store.put(RUNNING_KIND, RUNNING_KEY, {**auto.get(), "legs": [{**sold(), "exitPrice": 131.0, "exitReason": "stop"}]})  # type: ignore[dict-item]
    kept_again = auto.put(doc(legs=[sold(id="b")]), auto.get()["rev"])  # type: ignore[index]
    assert [lg["id"] for lg in kept_again["legs"]] == ["a"] and kept_again["legs"][0]["exitPrice"] == 131.0
    fresh = auto.put(doc(legs=[sold(id="b")], rearmAt="2026-11-06T09:00:00Z"), auto.get()["rev"])  # type: ignore[index]
    assert [lg["id"] for lg in fresh["legs"]] == ["b"] and fresh["legs"][0].get("exitPrice") is None
    # 4. an explicit fresh start (the Reset button sends a new rearmAt) may put the same leg back as it was
    store.put(RUNNING_KIND, RUNNING_KEY, {**auto.get(), "legs": [{**sold(), "exitPrice": 131.0, "exitReason": "stop"}]})  # type: ignore[dict-item]
    reset = auto.put(doc(rearmAt="2026-11-06T10:00:00Z"), auto.get()["rev"])  # type: ignore[index]  # a newer rearmAt than the current one
    assert reset["legs"][0].get("exitPrice") is None
    store.close()


def test_an_old_copy_cannot_loosen_a_trailed_stop_or_undo_a_re_entry(tmp_path: Path) -> None:
    auto, store = make(tmp_path, 131.0)
    trailed = sold(stop=112.0, stopBase=130.0, stopTrailed=True, cycles=0)
    store.put(RUNNING_KIND, RUNNING_KEY, {**doc(legs=[trailed]), "rev": 5})  # type: ignore[dict-item]
    # an old copy still has the stop at its pre-trail level 130.0: it goes back to the trailed 112.0
    out = auto.put(doc(legs=[sold(stop=130.0)]), 5)
    assert out["legs"][0]["stop"] == 112.0 and out["legs"][0]["stopTrailed"] is True and out["legs"][0]["stopBase"] == 130.0
    # a stop the user typed to a different level on a trailed leg is their edit and is kept
    mine = auto.put(doc(legs=[sold(stop=140.0)]), out["rev"])
    assert mine["legs"][0]["stop"] == 140.0
    # a leg that has been entered again twice cannot be taken back to one cycle by an old copy
    store.put(RUNNING_KIND, RUNNING_KEY, {**doc(legs=[sold(cycles=2, premium=118.5, reentry=0)]), "rev": 9})  # type: ignore[dict-item]
    back = auto.put(doc(legs=[sold(cycles=1, premium=118.5, reentry=1)]), 9)
    assert back["legs"][0]["cycles"] == 2 and back["legs"][0]["reentry"] == 0
    store.close()


def test_an_old_copy_from_another_device_with_different_leg_ids_cannot_re_open_a_closed_leg(tmp_path: Path) -> None:
    # 9 Nov 2026: the phone and the desktop held the same short straddle under different leg ids, so an id-only guard let
    # the phone's copy (leg still open) re-open the leg the server had stopped
    auto, store = make(tmp_path, 131.0)
    auto.put(doc(), None)
    auto.check_once()  # stop closes the leg (id "a") at 131.00
    rev = auto.get()["rev"]  # type: ignore[index]
    other_device = doc(legs=[sold(id="ch-0")])  # same contract, side and entry price under another id
    out = auto.put(other_device, rev)
    assert out["legs"][0]["exitPrice"] == 131.0 and out["legs"][0]["id"] == "a"
    assert "Ignored an old copy of SELL 23300 CE" in out["serverEvents"][-1]["text"]
    # a different entry price under another id is a different leg (a strategy started again): accepted
    fresh = auto.put(doc(legs=[sold(id="ch-1", premium=118.5, stop=154.05)]), out["rev"])
    assert fresh["legs"][0].get("exitPrice") is None and fresh["legs"][0]["premium"] == 118.5
    store.close()


def test_a_stop_the_server_executes_is_written_back_to_the_saved_strategy(tmp_path: Path) -> None:
    auto, store = make(tmp_path, 131.0)
    store.put("saved", "Expiry straddle", {"name": "Expiry straddle", "savedAt": "2026-11-09T04:08:00Z", "expiry": "2026-11-09", "legs": [sold()]})
    auto.put(doc(loaded="Expiry straddle"), None)
    assert auto.check_once()
    saved = store.get("saved", "Expiry straddle")
    assert saved is not None and saved["legs"][0]["exitPrice"] == 131.0 and saved["updatedAt"]
    store.close()
