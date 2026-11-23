"""The NIFTY index is collected only while continuous cash trading runs (23 Nov 2026: the closing auction's indicative values, 24,847 against a traded 25,366, were charted as the index).

Option, OI and volume collection is not touched: it runs to the F&O close. Levels are scripted (formula and rule checks), not market data.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

from app.domain.models import (
    Completeness,
    DataSource,
    ExpiryKind,
    OptionChainRow,
    OptionChainSnapshot,
    OptionQuote,
)
from app.domain.session import spot_end
from app.market.service import MarketService
from app.market.store import MarketStore
from app.services.snapshot_service import SnapshotService
from app.services.state import AppState
from app.storage.store import SnapshotStore
from app.stream.models import LiveTick
from tests.replay import ReplayBroker

IST = ZoneInfo("Asia/Kolkata")


def at(h: int, m: int, s: int = 0, day: tuple[int, int, int] = (2026, 11, 23)) -> datetime:
    return datetime(*day, h, m, s, tzinfo=IST).astimezone(UTC)


def tick(price: float, when: datetime) -> LiveTick:
    return LiveTick(key="nse_cm|Nifty 50", kind="index", exchange_segment="nse_cm", instrument_token="Nifty 50", ltp=price, received_at=when)


def test_spot_collection_ends_with_continuous_cash_trading_by_date() -> None:
    assert spot_end(date(2026, 7, 31)) is None  # no closing auction before 3 Aug 2026
    assert spot_end(date(2026, 11, 23)) == time(15, 15)
    assert spot_end(date(2026, 12, 4)) == time(15, 15)
    assert spot_end(date(2026, 12, 7)) == time(15, 30)  # the auction moves to 15:30 from 7 Dec


def test_no_index_bar_is_made_from_the_cash_end_and_none_is_served_or_invented(tmp_path: Path) -> None:
    now = at(15, 13, 30)
    svc = MarketService(MarketStore(tmp_path), clock=lambda: now)
    svc._index_tick = lambda: tick(25366.0, now)
    svc.observe_index(now)  # 15:13, collected
    now = at(15, 14, 30)
    svc._index_tick = lambda: tick(25367.0, now)
    svc.observe_index(now)  # 15:14, collected
    for minute in range(15, 25):  # the auction: indicative values 24,853 and up, one read a second would be the same
        when = at(15, minute, 10)
        svc._index_tick = lambda w=when, m=minute: tick(24853.0 + m, w)
        svc.observe_index(when)
    svc._clock = lambda: at(15, 40)
    bars = svc.index_bars()["bars"]
    assert [b["at"][11:16] for b in bars] == ["09:43", "09:44"]  # UTC: 15:13 and 15:14 IST
    assert all(b["l"] > 25000 and not b.get("proxy") and not b.get("ind") for b in bars)  # nothing from the auction, no stand-in bars


def test_the_bars_the_auction_left_before_this_rule_are_kept_on_disk_but_not_served(tmp_path: Path) -> None:
    store = MarketStore(tmp_path)
    store.record_sample("index1m", at(15, 14).isoformat(), {"o": 25366.0, "h": 25367.0, "l": 25365.0, "c": 25366.4, "n": 59})
    store.record_sample("index1m", at(15, 20).isoformat(), {"o": 25366.0, "h": 25366.0, "l": 24847.1, "c": 24852.75, "n": 49})
    svc = MarketService(store, clock=lambda: at(16, 0))
    assert [b["c"] for b in svc.index_bars()["bars"]] == [25366.4]
    assert len(store.samples_since("index1m", at(9, 0).isoformat())) == 2  # nothing deleted


def snap(spot: float | None, when: datetime) -> OptionChainSnapshot:
    q = lambda kind, p: OptionQuote(  # noqa: E731
        exchange_segment=None, instrument_token=None, trading_symbol=None, option_type=kind, ltp=p, open=None, high=None, low=None,
        prev_close=None, close=None, volume=None, oi=None, oi_previous=None, oi_change=None, oi_change_pct=None, moneyness=None,
    )
    rows = [OptionChainRow(strike=k, call=q("CE", 100.0), put=q("PE", 100.0)) for k in (25300.0, 25400.0)]
    return OptionChainSnapshot(
        snapshot_id=f"s{when.timestamp():.0f}", session_id="s1", underlying="NIFTY", expiry=date(2026, 11, 24), expiry_kinds=[ExpiryKind.WEEKLY],
        source=DataSource.SNAPSHOT, retrieved_at=when, lot_size=65, multiplier=1, requested_strike_count=2, completeness=Completeness.COMPLETE,
        rows=rows, ce_count=2, pe_count=2, underlying_ltp=spot,
    )


def service(tmp_path: Path) -> SnapshotService:
    store = SnapshotStore(tmp_path / "data")
    store.start_session("s1", "live")
    return SnapshotService(ReplayBroker(), store, AppState("s1"), "NIFTY", 40, spot_check=False)


def test_a_capture_in_the_auction_keeps_the_last_traded_level_and_says_so(tmp_path: Path) -> None:
    svc = service(tmp_path)
    assert svc._checked(snap(25364.8, at(15, 14))).underlying_ltp == 25364.8  # continuous trading: as sent, and remembered
    held = svc._checked(snap(24855.85, at(15, 21)))  # the indicative value
    assert held.underlying_ltp == 25364.8 and held.underlying_ltp_broker == 24855.85
    assert held.spot_note is not None and "not collected in the closing auction (from 15:15)" in held.spot_note and "25364.8 at 15:14" in held.spot_note
    assert held.rows == snap(24855.85, at(15, 21)).rows  # option prices, OI and volume are untouched
    later = svc._checked(snap(25349.65, at(15, 31)))  # the broker's index is back to a plain value, still not collected: the F&O session runs to 15:40
    assert later.underlying_ltp == 25364.8


def test_a_capture_in_the_auction_after_a_restart_has_no_held_level_and_is_left_as_sent(tmp_path: Path) -> None:
    svc = service(tmp_path)
    assert svc._checked(snap(24855.85, at(15, 21))).underlying_ltp == 24855.85


def test_the_held_level_is_of_the_same_day_and_from_7_dec_the_cut_is_15_30(tmp_path: Path) -> None:
    svc = service(tmp_path)
    svc._checked(snap(25364.8, at(15, 14, day=(2026, 11, 20))))  # a level of another day is not carried over
    assert svc._checked(snap(24855.85, at(15, 21))).underlying_ltp == 24855.85
    d = (2026, 12, 8)
    assert svc._checked(snap(25400.0, at(15, 20, day=d))).underlying_ltp == 25400.0  # 15:20 is still continuous cash trading from 7 Dec
    assert svc._checked(snap(25410.0, at(15, 29, day=d))).underlying_ltp == 25410.0
    assert svc._checked(snap(25000.0, at(15, 35, day=d))).underlying_ltp == 25410.0  # from 15:30 the level is held

