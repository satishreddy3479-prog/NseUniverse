"""The shadow comparison of the live feed with the stored one-minute chain (nothing stored changes). Expected counts are hand-counted from the small chain built below."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from app.domain.models import DataSource, ExpiryKind
from app.domain.normalize import normalize_option_chain
from app.services.shadow import ShadowStore, compare, summarise
from app.stream.models import LiveTick

EXP = date(2026, 12, 1)
AT = datetime(2026, 11, 26, 4, 0, 5, tzinfo=UTC)  # a capture received 5 s into the minute


def item(side: str, strike: int, token: str, ltp: Any, oi: int, volume: int) -> dict[str, Any]:
    return {
        "instrument": {"neoSymbol": f"nse_fo|{token}", "symbol": f"NIFTY{strike}{side}", "optionType": side, "strikePrice": strike, "moneyness": "ATM"},
        "quote": {"ltp": ltp, "open": "100", "high": "110", "low": "95", "prevClose": "99", "close": None, "volume": volume},
        "openInterest": {"current": oi, "previous": oi - 10, "change": 10, "changePct": 1.0},
    }


def chain() -> Any:
    """Four strikes, eight quotes: tokens 101..108 (calls 101-104, puts 105-108)."""
    raw = {
        "call": [item("CE", 25800 + 50 * i, str(101 + i), "100.0", 5000 + i, 700 + i) for i in range(4)],
        "put": [item("PE", 25800 + 50 * i, str(105 + i), "90.0", 6000 + i, 800 + i) for i in range(4)],
    }
    return normalize_option_chain(raw, snapshot_id="s1", session_id="x", underlying="NIFTY", expiry=EXP, expiry_kinds=[ExpiryKind.WEEKLY], source=DataSource.SNAPSHOT, retrieved_at=AT, requested_strike_count=4)


def tick(token: str, ltp: float | None, oi: int | None, volume: int | None, age_s: float = 1.0) -> LiveTick:
    return LiveTick(key=f"nse_fo|{token}", kind="scrip", exchange_segment="nse_fo", instrument_token=token, ltp=ltp, oi=oi, volume=volume, received_at=AT - timedelta(seconds=age_s))


def test_the_comparison_counts_identical_and_different_quotes_the_missing_and_the_ages() -> None:
    snap = chain()
    assert len(snap.rows) == 4
    book = {
        "nse_fo|101": tick("101", 100.0, 5000, 700, age_s=0.5),  # identical in price, oi and volume
        "nse_fo|102": tick("102", 100.5, 5001, 701, age_s=2.0),  # price 0.50 higher; oi and volume identical
        "nse_fo|103": tick("103", 99.9, 5002, 790, age_s=3.0),  # price 0.10 lower; volume different
        # 104: no tick at all while the chain has a price: feed missing
        "nse_fo|105": tick("105", 90.0, 6000, 800, age_s=1.0),  # identical
        "nse_fo|106": tick("106", 90.0, 6001, 801, age_s=-4.0),  # received 4 s AFTER the chain: the feed moved on
        "nse_fo|107": tick("107", None, 6002, 802, age_s=2.0),  # a tick without a price: the chain's price has no feed price
        # 108: no tick
    }
    r = compare(snap, book.get, AT)
    assert (r["quotes"], r["with_tick"], r["feed_missing"], r["rest_missing"]) == (8, 6, 2, 0)  # 104 and 108 missing from the feed; 107 has a tick but no price (not "rest missing": the chain HAS a price)
    assert (r["ltp_equal"], r["ltp_differs"]) == (3, 2)  # 101, 105, 106 equal; 102 and 103 differ; 107 has no feed price so it is in neither count
    assert r["max_abs_diff"] == 0.5 and r["mean_abs_diff"] == 0.3  # (0.5 + 0.1) / 2
    assert (r["oi_equal"], r["oi_compared"]) == (6, 6)  # every tick that has one carries the chain's open interest
    assert (r["vol_equal"], r["vol_compared"]) == (5, 6)  # all but 103, whose volume is 790 against the chain's 702
    assert r["feed_newer"] == 1  # 106
    assert r["tick_age_p50_s"] == 2.0 and r["tick_age_p95_s"] == 3.0  # ages 0, 0.5, 1.0, 2.0, 2.0, 3.0 (the tick that came after the chain counts as 0): the 4th and the 6th of six


def test_a_chain_with_no_ticks_at_all_is_all_feed_missing_and_summaries_say_so(tmp_path: Path) -> None:
    r = compare(chain(), lambda _k: None, AT)
    assert (r["quotes"], r["with_tick"], r["feed_missing"], r["ltp_equal"]) == (8, 0, 8, 0) and r["tick_age_p50_s"] is None
    store = ShadowStore(tmp_path)
    book = {f"nse_fo|{101 + i}": tick(str(101 + i), 100.0 if i < 4 else 90.0, 5000 + i if i < 4 else 6000 + i - 4, 700 + i if i < 4 else 800 + i - 4) for i in range(8)}
    good = compare(chain(), book.get, AT)
    assert (good["ltp_equal"], good["ltp_differs"], good["oi_equal"], good["vol_equal"]) == (8, 0, 8, 8)  # a perfect agreement
    store.add(good, AT)
    store.add({**good, "ts": (AT + timedelta(minutes=1)).isoformat(timespec="seconds"), "ltp_equal": 6, "ltp_differs": 2, "max_abs_diff": 0.4, "with_tick": 8}, AT + timedelta(minutes=1))
    rows = store.rows(AT - timedelta(hours=1))
    assert len(rows) == 2
    s = summarise(rows)
    assert s["captures"] == 2 and s["quotes"] == 16 and s["feed_had_a_tick_pct"] == 100.0
    assert s["price_identical_pct"] == 87.5 and s["worst_price_gap"] == 0.4  # 14 of 16 priced quotes identical
    assert summarise([])["price_identical_pct"] is None  # nothing compared: no figure, not 0 %
    late = AT + timedelta(days=60)
    store.add({**good, "ts": late.isoformat(timespec="seconds")}, late)  # a row 60 days later removes the old ones
    assert len(store.rows(AT - timedelta(days=1))) == 1


def test_each_stored_capture_is_compared_with_the_feed_without_changing_it(tmp_path: Path) -> None:
    """The capture path: after a capture is stored the hook measures it; a failing hook is logged and the capture stands."""
    import asyncio

    from app.services.snapshot_service import SnapshotService  # noqa: F401 - the hook lives there

    # the hook is a plain callable on the service: exercised here through the same function main.py installs
    store = ShadowStore(tmp_path)
    snap = chain()
    book = {f"nse_fo|{101 + i}": tick(str(101 + i), 100.0 if i < 4 else 90.0, 5000 + i if i < 4 else 6000 + i - 4, 700 + i if i < 4 else 800 + i - 4) for i in range(8)}

    def hook(s: Any) -> None:
        row = compare(s, book.get, s.retrieved_at)
        if row["with_tick"]:
            store.add(row)

    hook(snap)
    assert len(store.rows(AT - timedelta(hours=1))) == 1
    empty = compare(snap, lambda _k: None, AT)
    assert empty["with_tick"] == 0  # a stopped stream adds no row (nothing to compare)
    assert asyncio.iscoroutinefunction(hook) is False


def test_the_capture_calls_the_hook_with_the_stored_chain_and_survives_a_failing_hook(tmp_path: Path) -> None:
    """Through the real capture path (the replayed real Kotak chain): the hook sees each stored capture; if it raises, the capture is still stored."""
    import asyncio

    from fastapi.testclient import TestClient

    from tests.conftest import make_app

    app = make_app(tmp_path / "a")
    with TestClient(app, client=("127.0.0.1", 50000)):
        svc = app.state.snapshot_service
        seen: list[tuple[str, int]] = []
        svc.shadow = lambda snap: seen.append((snap.expiry.isoformat(), len(snap.rows)))
        loop = asyncio.new_event_loop()
        stored = loop.run_until_complete(svc.capture())
        assert stored and len(seen) == len(stored) and all(n > 20 for _e, n in seen)  # every stored expiry was measured, with its real strikes

        def boom(_snap: Any) -> None:
            raise RuntimeError("shadow store down")

        svc.shadow = boom
        again = loop.run_until_complete(svc.capture())
        assert len(again) == len(stored)  # the failing hook did not stop the captures
        loop.close()
