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
    hit_of,
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
    assert auto.put(doc(), 2)["rev"] == 3
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
