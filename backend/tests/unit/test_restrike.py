"""The managed straddle: close the pair and open the new at-the-money pair when NIFTY is ``points`` away. Paper only; the server owns every input; hand-calculated."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest

from app.domain.models import DataSource, ExpiryKind
from app.domain.normalize import normalize_option_chain
from app.storage.strategies import StrategyStore
from app.strategy.automation import (
    RESTRIKE_SPOT_KEY,
    RUNNING_KEY,
    RUNNING_KIND,
    StrategyAutomation,
    apply_restrike,
    clean_restrike,
    ladder_from_snapshot,
    restrike_problem,
)

AT = datetime(2026, 11, 27, 5, 0, tzinfo=UTC)  # 10:30 IST on a Friday
CFG: dict[str, Any] = {"points": 100}
LADDER = [{"strike": float(k), "ce": f"nse_fo|{k}C", "pe": f"nse_fo|{k}P"} for k in (25700, 25750, 25800, 25850, 25900, 25950)]
FIXTURES = Path(__file__).parent.parent / "fixtures"


def ladder_of(_expiry: str) -> list[dict[str, Any]]:
    return LADDER


def pair(strike: int = 25900, **kw: Any) -> list[dict[str, Any]]:
    """The opening straddle sold at 25900: CE at 150.00, PE at 160.00, one lot of 65."""
    base = {"expiry": "2026-12-01", "strike": strike, "action": "SELL", "lots": 1, "enabled": True, "premiumSource": "market"}
    return [
        {**base, "id": "c", "type": "CE", "key": f"nse_fo|{strike}C", "premium": 150.0, **kw},
        {**base, "id": "p", "type": "PE", "key": f"nse_fo|{strike}P", "premium": 160.0, **kw},
    ]


def prices(spot: float, **quotes: float):  # type: ignore[no-untyped-def]
    book = {RESTRIKE_SPOT_KEY: spot, **{f"nse_fo|{k}": v for k, v in quotes.items()}}
    return lambda lg: book.get(lg.get("key"))


FULL = {"25900C": 60.0, "25900P": 255.0, "25800C": 120.0, "25800P": 130.0}
EVERY = {f"{k}{s}": 50.0 for k in (25700, 25750, 25800, 25850, 25900, 25950) for s in "CP"}


def run(legs: list[dict[str, Any]], spot: float, quotes: dict[str, float] | None = None, cfg: Any = CFG, at: datetime = AT):  # type: ignore[no-untyped-def]
    return apply_restrike(legs, cfg, prices(spot, **(FULL if quotes is None else quotes)), ladder_of, 65, at)


def test_nothing_moves_one_point_inside_the_distance() -> None:
    legs, ev = run(pair(), 25801.0)
    assert ev == [] and legs == pair()  # 99 points away


def test_at_exactly_the_distance_the_pair_is_closed_and_opened_at_the_new_atm_with_hand_calculated_pnl() -> None:
    legs, ev = run(pair(), 25800.0)
    ce, pe = legs
    # sold CE 150.00 -> 60.00: (150 - 60) * 65 = +5,850; sold PE 160.00 -> 255.00: (160 - 255) * 65 = -6,175
    assert ce["realised"] == pytest.approx(5850.0) and pe["realised"] == pytest.approx(-6175.0)
    assert (ce["strike"], pe["strike"]) == (25800, 25800) and (ce["key"], pe["key"]) == ("nse_fo|25800C", "nse_fo|25800P")
    assert (ce["premium"], pe["premium"]) == (120.0, 130.0)  # the new entries are the live prices
    assert ce["exitPrice"] is None and ce["cycles"] == 1 and pe["cycles"] == 1
    assert len(ev) == 2 and "Re-strike" in ev[0] and "+₹5,850 booked" in ev[0] and "−₹6,175 booked" in ev[1] and "[server]" in ev[0]
    assert ce["realised"] + pe["realised"] == pytest.approx(-325.0)


@pytest.mark.parametrize("points", [100, 150, 200, 250, 37.5])
def test_the_distance_is_whatever_is_set(points: float) -> None:
    """100, 150, 200 and any other distance: nothing half a point short of it, a re-strike at it."""
    cfg = {"points": points}
    assert run(pair(), 25900.0 - points + 0.5, EVERY, cfg)[1] == []
    assert len(run(pair(), 25900.0 - points, EVERY, cfg)[1]) == 2


def test_a_distance_set_on_the_up_side_works_the_same() -> None:
    legs, ev = run(pair(25800), 25950.0, EVERY, {"points": 150})
    assert len(ev) == 2 and legs[0]["strike"] == 25950 and legs[1]["strike"] == 25950  # 150 above 25800


def test_nearest_strike_wins_and_a_tie_goes_to_the_lower_strike() -> None:
    assert run(pair(), 25795.0, EVERY)[0][0]["strike"] == 25800  # 5 away vs 45
    assert run(pair(), 25775.0, EVERY)[0][0]["strike"] == 25750  # exactly between 25750 and 25800
    assert run(pair(), 26010.0, EVERY)[0][0]["strike"] == 25950  # past the top of the ladder: its last strike


def test_a_price_missing_for_nifty_or_any_contract_moves_nothing() -> None:
    for drop in FULL:
        legs, ev = run(pair(), 25800.0, {k: v for k, v in FULL.items() if k != drop})
        assert ev == [] and legs == pair(), drop
    legs, ev = apply_restrike(pair(), CFG, lambda lg: None if lg.get("key") == RESTRIKE_SPOT_KEY else 1.0, ladder_of, 65, AT)
    assert ev == [] and legs == pair()
    assert apply_restrike(pair(), CFG, prices(25800.0, **FULL), lambda _e: [], 65, AT) == (pair(), [])  # no stored chain: nothing moves


def test_a_pair_that_is_not_intact_is_left_alone() -> None:
    stopped = pair()
    stopped[0].update(exitPrice=190.0, exitReason="stop")
    assert run(stopped, 25800.0)[1] == []  # one leg is out: the page decides, not the rule
    mixed = pair()
    mixed[1].update(strike=25850)
    assert run(mixed, 25800.0)[1] == []  # two strikes: not a straddle
    off = pair()
    off[0]["enabled"] = False
    out, ev = run(off, 25800.0)
    assert len(ev) == 1 and out[0] == off[0] and out[1]["strike"] == 25800  # an unticked leg is not part of the position and stays as it was


def test_only_while_the_index_is_collected() -> None:
    """Before 09:15 and from the end of continuous cash trading (15:15 until 4 Dec 2026) the index is silent or indicative: no re-strike on it."""
    before_open = datetime(2026, 11, 27, 3, 40, tzinfo=UTC)  # 09:10 IST
    at_open = datetime(2026, 11, 27, 3, 45, tzinfo=UTC)  # 09:15
    last_minute = datetime(2026, 11, 27, 9, 44, 59, tzinfo=UTC)  # 15:14:59
    auction = datetime(2026, 11, 27, 9, 45, tzinfo=UTC)  # 15:15
    assert run(pair(), 25800.0, at=before_open)[1] == [] and len(run(pair(), 25800.0, at=at_open)[1]) == 2
    assert len(run(pair(), 25800.0, at=last_minute)[1]) == 2 and run(pair(), 25800.0, at=auction)[1] == []
    after_dec7 = datetime(2026, 12, 8, 9, 44, tzinfo=UTC)  # 15:14 IST: from 7 Dec cash trading runs to 15:30
    assert len(run(pair(), 25800.0, at=after_dec7)[1]) == 2
    still_open_dec7 = datetime(2026, 12, 8, 9, 59, tzinfo=UTC)  # 15:29 IST
    assert len(run(pair(), 25800.0, at=still_open_dec7)[1]) == 2


def test_stop_and_target_keep_their_percentage_distance_from_the_new_entry() -> None:
    legs = pair()
    legs[0].update(stop=180.0, target=75.0)  # stop 20 % above the 150 entry, target 50 % below
    out, _ = run(legs, 25800.0)
    assert out[0]["stop"] == pytest.approx(144.0) and out[0]["target"] == pytest.approx(60.0)  # 120 * 1.2 and 120 * 0.5


def test_a_setting_that_cannot_work_is_ignored() -> None:
    for bad in (None, {}, "100", {"points": 0}, {"points": -5}, {"points": True}, {"points": None}, {"points": 5000}, {"points": "100"}):
        assert restrike_problem(bad) and run(pair(), 25800.0, cfg=bad) == (pair(), [])
    assert not restrike_problem({"points": 2000}) and not restrike_problem({"points": 0.5})


def test_the_server_keeps_the_distance_and_nothing_a_device_sends(tmp_path: Path) -> None:
    """No device can steer the rule: a page's own spot key, strikes or keys are dropped, only the distance is kept."""
    assert clean_restrike({"points": 150, "spotKey": "nse_fo|1", "ladder": [{"strike": 1, "ce": "x", "pe": "y"}]}) == {"points": 150.0}
    assert clean_restrike({"points": 0}) is None and clean_restrike(None) is None and clean_restrike([150]) is None
    auto = StrategyAutomation(StrategyStore(tmp_path), lambda _k: None, lambda: True, now=lambda: AT)
    put = auto.put({"auto": True, "lotSize": 65, "expiry": "2026-12-01", "legs": pair(), "restrike": {"points": 200, "spotKey": "evil", "ladder": [1]}}, None)
    assert put["restrike"] == {"points": 200.0}


def test_the_server_check_applies_the_rule_from_its_own_chain_and_writes_the_new_legs(tmp_path: Path) -> None:
    store = StrategyStore(tmp_path)
    book = {RESTRIKE_SPOT_KEY: 25800.0, "nse_fo|25900C": 60.0, "nse_fo|25900P": 255.0, "nse_fo|25800C": 120.0, "nse_fo|25800P": 130.0}
    asked: list[str] = []

    def chain(expiry: str) -> list[dict[str, Any]]:
        asked.append(expiry)
        return LADDER

    auto = StrategyAutomation(store, book.get, lambda: True, now=lambda: AT, ladder_of=chain)
    auto.put({"auto": True, "lotSize": 65, "expiry": "2026-12-01", "legs": pair(), "restrike": {"points": 100}}, None)
    events = auto.check_once()
    doc = store.get(RUNNING_KIND, RUNNING_KEY)
    assert doc is not None and len(events) == 2
    assert [lg["strike"] for lg in doc["legs"]] == [25800, 25800] and doc["legsRev"] == 2
    assert auto.check_once() == []  # spot is on the new strike: nothing more
    book[RESTRIKE_SPOT_KEY] = 25700.0  # another 100 points down: re-struck again, the booked profit carries on
    book.update({"nse_fo|25800C": 30.0, "nse_fo|25800P": 210.0, "nse_fo|25700C": 80.0, "nse_fo|25700P": 90.0})
    assert len(auto.check_once()) == 2
    legs = store.get(RUNNING_KIND, RUNNING_KEY)["legs"]  # type: ignore[index]
    # second booking: CE (120 - 30) * 65 = +5,850 on top of +5,850; PE (130 - 210) * 65 = -5,200 on top of -6,175
    assert legs[0]["realised"] == pytest.approx(11700.0) and legs[1]["realised"] == pytest.approx(-11375.0)
    assert legs[0]["cycles"] == 2 and legs[0]["strike"] == 25700
    assert asked == ["2026-12-01"]  # the chain was read once and kept for the next re-strike


def test_without_a_chain_source_or_with_a_failing_one_nothing_moves_and_the_check_goes_on(tmp_path: Path) -> None:
    book = {RESTRIKE_SPOT_KEY: 25800.0, **{f"nse_fo|{k}": v for k, v in FULL.items()}}

    def broken(_expiry: str) -> list[dict[str, Any]]:
        raise OSError("chain file unreadable")

    for name, source in (("none", None), ("broken", broken)):
        store = StrategyStore(tmp_path / name)
        auto = StrategyAutomation(store, book.get, lambda: True, now=lambda: AT, ladder_of=source)
        auto.put({"auto": True, "lotSize": 65, "expiry": "2026-12-01", "legs": pair(), "restrike": {"points": 100}}, None)
        assert auto.check_once() == []
        assert [lg["strike"] for lg in store.get(RUNNING_KIND, RUNNING_KEY)["legs"]] == [25900, 25900]  # type: ignore[index]


def test_the_ladder_of_a_real_captured_chain_has_each_strikes_call_and_put_feed_keys() -> None:
    """From the real Kotak payload captured for the 23 Nov 2026 expiry: the keys are the feed keys (segment|token) of that strike's call and put."""
    raw = json.loads((FIXTURES / "kotak_option_chain_NIFTY_2026-11-23.json").read_text(encoding="utf-8"))
    snap = normalize_option_chain(
        raw, snapshot_id="s", session_id="x", underlying="NIFTY", expiry=date(2026, 11, 23), expiry_kinds=[ExpiryKind.MONTHLY],
        source=DataSource.SNAPSHOT, retrieved_at=AT, requested_strike_count=40,
    )
    ladder = ladder_from_snapshot(snap)
    assert len(ladder) > 10 and [r["strike"] for r in ladder] == sorted(r["strike"] for r in ladder)
    one = ladder[len(ladder) // 2]
    row = next(r for r in snap.rows if r.strike == one["strike"])
    assert row.call is not None and row.put is not None
    assert one["ce"] == f"{row.call.exchange_segment}|{row.call.instrument_token}"
    assert one["pe"] == f"{row.put.exchange_segment}|{row.put.instrument_token}"
    assert one["ce"].startswith("nse_fo|") and one["pe"].startswith("nse_fo|") and one["ce"] != one["pe"]
    raw_symbols = {str(item["inst"]["neoSymbol"]) for side in ("call", "put") for item in (raw.get("data", raw).get(side) or [])}
    assert one["ce"] in raw_symbols and one["pe"] in raw_symbols  # straight from the captured payload
    half = snap.rows[0].model_copy(update={"put": None})
    assert ladder_from_snapshot(type("S", (), {"rows": [half]})()) == []  # a strike with only one side is not on the ladder
