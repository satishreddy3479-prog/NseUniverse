"""The history page reads each stored snapshot once into a compact digest; every observation built from a digest must equal the one built straight from the snapshot."""

from __future__ import annotations

from datetime import datetime

import pytest

from app.domain.models import OptionChainRow, OptionChainSnapshot
from app.services import history
from app.services.history import _digest, _observe_digest, observe
from tests.unit.test_observations import A, B, quote, snap


def assert_equal(x: object, y: object) -> None:
    dx, dy = x.model_dump(), y.model_dump()  # type: ignore[attr-defined]
    assert dx.keys() == dy.keys()
    for k in dx:
        assert dx[k] == dy[k], k


def test_a_digest_gives_the_observation_of_the_snapshot_for_every_strike_set_with_missing_values_kept_missing() -> None:
    ce = {100: (15.5, 5000, 50), 110: (None, 4000, 40), 120: (3.25, None, 30), 130: (1.5, 700, 20)}  # a missing price, a missing OI
    pe = {100: (2.5, 1000, 10), 110: (6.0, 2000, 20), 120: (None, 3000, 30), 130: (14.75, 900, 5)}
    s = snap("d1", B, 111.0, ce, pe)  # ATM by price: 110
    for fixed in (frozenset({110.0, 120.0}), frozenset({100.0, 110.0, 120.0, 130.0}), frozenset({999.0}), frozenset({130.0}), frozenset()):
        assert_equal(_observe_digest(_digest(s, 1), fixed), observe(s, 1, fixed))
    got = _observe_digest(_digest(s, 1), frozenset({110.0, 120.0}))
    # by hand: calls 110 (no price) and 120 (3.25); puts 110 (6.0) and 120 (no price): premium 3.25 and 6.0, one missing price on each side, OI calls 4000 (120 has none), puts 2000 + 3000
    assert got.total_ce_premium == 3.25 and got.total_pe_premium == 6.0 and got.missing_ltp == 2
    assert got.total_ce_oi == 4000 and got.total_pe_oi == 5000 and got.strikes_in_universe == 2
    assert got.total_ce_volume == 20 and got.total_pe_volume == 20  # the fixture gives every contract volume 10
    none_at_all = _observe_digest(_digest(s, 1), frozenset({999.0}))
    assert none_at_all.total_ce_premium is None and none_at_all.strikes_in_universe == 0  # nothing to sum is missing, not zero


def test_a_side_without_a_contract_is_not_counted_as_a_missing_price() -> None:
    rows = [OptionChainRow(strike=100, call=quote("CE", 5.0, 100, 90), put=None), OptionChainRow(strike=110, call=None, put=quote("PE", None, 50, 40))]
    base = snap("d2", B, 105.0, {100: (1, 1, 1)}, {100: (1, 1, 1)})
    s = OptionChainSnapshot(**{**base.model_dump(), "rows": rows, "ce_count": 1, "pe_count": 1})
    fixed = frozenset({100.0, 110.0})
    got = _observe_digest(_digest(s, 5), fixed)
    assert_equal(got, observe(s, 5, fixed))
    assert got.missing_ltp == 1 and got.total_pe_premium is None and got.total_ce_premium == 5.0  # only the put with a contract and no price is counted


def test_a_new_strike_set_does_not_read_the_stored_snapshots_again(monkeypatch: pytest.MonkeyPatch) -> None:
    """The ATM strike of the newest snapshot moves during the day; the cache must survive it (it used to be keyed by the strike set and went cold, about 2.7 s on the server)."""

    class Item:
        def __init__(self, sid: str, at: datetime) -> None:
            self.snapshot_id, self.retrieved_at = sid, at
            self.completeness = type("C", (), {"value": "complete"})()

    ce = {100: (15.0, 50, 50), 110: (8.0, 40, 40), 120: (3.0, 30, 30)}
    pe = {100: (2.0, 10, 10), 110: (6.0, 20, 20), 120: (14.0, 30, 30)}
    snaps = {"a": snap("a", A, 100.0, ce, pe), "b": snap("b", B, 120.0, ce, pe)}  # the newest is "b", ATM 120
    loads: list[str] = []

    class Store:
        def list(self, **_: object) -> list[Item]:
            return [Item("b", B), Item("a", A)]  # newest first, as the real store returns

        def load(self, sid: str) -> OptionChainSnapshot:
            loads.append(sid)
            return snaps[sid]

    history._CACHE.clear()
    first = history.build_history(Store(), "NIFTY", "2026-11-03", 1, 1000)  # type: ignore[arg-type]
    assert sorted(loads) == ["a", "b", "b"]  # "b" twice: once for the strike set, once for its own digest (the first request is cold)
    assert [o.snapshot_id for o in first.observations] == ["a", "b"]
    snaps["b"] = snap("b", B, 100.0, ce, pe)  # the newest snapshot's ATM moves to 100: a different strike set
    loads.clear()
    second = history.build_history(Store(), "NIFTY", "2026-11-03", 1, 1000)  # type: ignore[arg-type]
    assert loads == ["b"]  # only the strike set needs the newest snapshot; every digest is reused
    assert first.observations[0].strikes_in_universe == 2 and second.observations[0].strikes_in_universe == 2
    assert first.observations[0].total_ce_premium == 8.0 + 3.0 and second.observations[0].total_ce_premium == 15.0 + 8.0  # 110+120 then 100+110, by hand
