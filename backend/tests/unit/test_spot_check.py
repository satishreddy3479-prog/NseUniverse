"""A frozen index quote in a chain snapshot is replaced by the level the chain's own prices imply.

17 Nov 2026 (expiry day): the index quote repeated 25,413 from 15:15 to 15:27 while the options kept
moving. At 15:20 the 25,300 call traded at 154.2 and the put at 0.4, so parity says
25,300 + 154.2 - 0.4 = 25,453.8 (discounted by e^(-0.06 x 10 minutes / 365 days), under 0.01 point).
"""

from __future__ import annotations

from datetime import UTC, date, datetime

from app.domain.models import OptionChainRow, OptionQuote
from app.domain.spot_check import checked_spot, parity_spot

EXPIRY = date(2026, 11, 17)
AT = datetime(2026, 11, 17, 9, 50, tzinfo=UTC)  # 15:20 IST, ten minutes before the 15:30 expiry close


def quote(kind: str, ltp: float | None) -> OptionQuote:
    return OptionQuote(
        exchange_segment=None, instrument_token=None, trading_symbol=None, option_type=kind,
        ltp=ltp, open=None, high=None, low=None, prev_close=None, close=None, volume=None,
        oi=None, oi_previous=None, oi_change=None, oi_change_pct=None, moneyness=None,
    )  # fmt: skip


def rows(index: float, ks: list[float]) -> list[OptionChainRow]:
    """Prices that satisfy parity exactly for an index at ``index`` (call - put = index - K)."""
    out = []
    for k in ks:
        time_value = 10.0
        call = max(index - k, 0) + time_value
        put = max(k - index, 0) + time_value
        out.append(OptionChainRow(strike=k, call=quote("CE", call), put=quote("PE", put)))
    return out


def test_parity_gives_the_hand_calculated_level() -> None:
    chain = [OptionChainRow(strike=25300.0, call=quote("CE", 154.2), put=quote("PE", 0.4))]
    chain += rows(25453.8, [25250.0, 25350.0])
    implied = parity_spot(chain, 25413.0, EXPIRY, AT)
    assert implied is not None and abs(implied - 25453.8) < 0.05  # 25,300 + 153.8, discounted by under 0.01


def test_a_frozen_quote_is_replaced_and_the_broker_value_kept() -> None:
    chain = rows(25453.8, [25300.0, 25350.0, 25400.0, 25450.0, 25500.0])
    spot, broker, note = checked_spot(chain, 25413.0, EXPIRY, AT, frozen=True)
    assert broker == 25413.0 and spot is not None and abs(spot - 25453.8) < 0.05
    assert note is not None and "25413" in note and "41 points below" in note
    assert checked_spot(chain, 25413.0, EXPIRY, AT) == (25413.0, None, None)  # the same quote that is still moving (not frozen) is used as sent


def test_a_quote_within_thirty_points_is_used_as_sent() -> None:
    chain = rows(25453.8, [25300.0, 25350.0, 25400.0, 25450.0, 25500.0])
    assert checked_spot(chain, 25430.0, EXPIRY, AT, frozen=True) == (25430.0, None, None)  # 23.8 points apart, even when frozen


def test_nothing_is_judged_without_enough_prices_or_for_a_far_expiry() -> None:
    thin = rows(25453.8, [25400.0, 25450.0])  # two strikes: parity needs three
    assert checked_spot(thin, 25413.0, EXPIRY, AT) == (25413.0, None, None)
    chain = rows(25453.8, [25300.0, 25350.0, 25400.0, 25450.0, 25500.0])
    far = date(2026, 12, 29)  # six weeks away: dividends missing from the model could move the forward more than the allowance
    assert checked_spot(chain, 25413.0, far, AT) == (25413.0, None, None)
    gone = [OptionChainRow(strike=r.strike, call=quote("CE", None), put=r.put) for r in chain]  # missing stays missing
    assert checked_spot(gone, 25413.0, EXPIRY, AT) == (25413.0, None, None)
    assert checked_spot(chain, None, EXPIRY, AT) == (None, None, None)


def test_the_atm_row_of_a_stored_observation_follows_the_checked_level_not_the_broker_label() -> None:
    from app.domain.models import Completeness, DataSource, OptionChainSnapshot
    from app.services.history import _universe

    ks = [25300.0, 25350.0, 25400.0, 25450.0, 25500.0]
    chain = rows(25453.8, ks)
    for r in chain:  # the broker labelled 25,400 ATM from its frozen quote of 25,413
        assert r.call is not None
        r.call.moneyness = "ATM" if r.strike == 25400.0 else "OTM"
    spot, broker, note = checked_spot(chain, 25413.0, EXPIRY, AT, frozen=True)
    snap = OptionChainSnapshot(
        snapshot_id="s", session_id="x", underlying="NIFTY", expiry=EXPIRY, expiry_kinds=[],
        source=DataSource.SNAPSHOT, retrieved_at=AT, lot_size=65, multiplier=1, underlying_ltp=spot,
        underlying_ltp_broker=broker, spot_note=note, requested_strike_count=5,
        completeness=Completeness.COMPLETE, rows=chain, ce_count=5, pe_count=5,
    )  # fmt: skip
    _, atm = _universe(snap, 2)
    assert atm.strike == 25450.0  # nearest 25,453.8
    labelled = snap.model_copy(update={"spot_note": None, "underlying_ltp": 25413.0})
    assert _universe(labelled, 2)[1].strike == 25400.0  # without the note the broker's label still rules


def test_a_moving_quote_is_not_replaced_on_the_real_capture_of_19_nov_2026_09_20_ist() -> None:
    """Real chain, 19 Nov 2026 03:50:04 UTC (09:20 IST), expiry 23 Nov: the broker's index quote was 25,197.3 and the live index bars of that minute closed 25,178-25,201, while the five
    strikes nearest it agreed on K + C - P = 25,178.0, 25,178.2, 25,178.8, 25,178.3 and 25,177.7 (median 25,178.2). 4.257 days to the 23 Nov 15:30 close: 25,178.2 / e^(0.06 x 4.257 / 365)
    = 25,178.2 / 1.0007 = 25,160.6. That level was 37 points below the quote and the check replaced a healthy quote 32 times in the first 33 minutes."""
    at = datetime(2026, 11, 19, 3, 50, 4, tzinfo=UTC)
    expiry = date(2026, 11, 23)
    real = {25200.0: (134.8, 156.8), 25150.0: (160.0, 131.8), 25250.0: (113.05, 184.2), 25100.0: (188.1, 109.75), 25300.0: (93.5, 215.8)}
    chain = [OptionChainRow(strike=k, call=quote("CE", c), put=quote("PE", p)) for k, (c, p) in real.items()]
    implied = parity_spot(chain, 25197.3, expiry, at)
    assert implied is not None and abs(implied - 25160.6) < 0.1
    assert checked_spot(chain, 25197.3, expiry, at) == (25197.3, None, None)  # moving quote: used as sent
    spot, broker, note = checked_spot(chain, 25197.3, expiry, at, frozen=True)  # the same numbers with a frozen quote would be replaced
    assert broker == 25197.3 and spot is not None and abs(spot - 25160.6) < 0.1 and note is not None and "has not moved" in note


def test_a_quote_counts_as_frozen_after_three_identical_captures_ninety_seconds_apart() -> None:
    """The 19 Nov 2026 close: the chain's index level read 25,503.70 in every capture from 15:15:04 to 15:28:04 (once a minute); in the morning it changed every minute."""
    from datetime import timedelta
    from types import SimpleNamespace

    from app.services.snapshot_service import SnapshotService

    svc = object.__new__(SnapshotService)  # the freeze test only needs its own history
    svc._broker_levels = {}
    svc._last_traded = None
    t0 = datetime(2026, 11, 19, 9, 45, 4, tzinfo=UTC)  # 15:15:04 IST

    def cap(seconds: int, level: float) -> bool:
        return svc._quote_frozen(SimpleNamespace(expiry=EXPIRY, retrieved_at=t0 + timedelta(seconds=seconds), underlying_ltp=level))

    assert [cap(0, 25503.7), cap(60, 25503.7), cap(120, 25503.7)] == [False, False, True]  # third identical capture, 120 s after the first
    assert cap(180, 25503.7) is True and cap(240, 25514.3) is False  # the 15:29 close moves it
    svc._broker_levels = {}
    svc._last_traded = None
    assert [cap(0, 25186.8), cap(60, 25190.7), cap(120, 25193.6), cap(180, 25208.05)] == [False, False, False, False]  # 09:14-09:17 IST: moving every minute
    svc._broker_levels = {}
    svc._last_traded = None
    assert [cap(0, 25503.7), cap(5, 25503.7), cap(10, 25503.7)] == [False, False, False]  # captures a few seconds apart count once
    assert svc._quote_frozen(SimpleNamespace(expiry=EXPIRY, retrieved_at=t0, underlying_ltp=None)) is False  # missing stays missing


def test_every_replacement_is_written_to_the_override_ledger() -> None:
    """17 Nov 2026 frozen quote: the third identical capture is replaced and the ledger counts it (the 19 Nov false positives were only a log line)."""
    from datetime import timedelta

    from app.domain.models import Completeness, DataSource, OptionChainSnapshot
    from app.domain.overrides import ledger
    from app.services.snapshot_service import SnapshotService

    ledger.reset()
    svc = object.__new__(SnapshotService)
    svc.spot_check = True
    svc._broker_levels = {}
    svc._last_traded = None
    chain = rows(25453.8, [25300.0, 25350.0, 25400.0, 25450.0, 25500.0])
    out = []
    for i in range(3):
        at = AT + timedelta(seconds=60 * i)
        snap = OptionChainSnapshot(
            snapshot_id=f"s{i}", session_id="x", underlying="NIFTY", expiry=EXPIRY, expiry_kinds=[],
            source=DataSource.SNAPSHOT, retrieved_at=at, lot_size=65, multiplier=1, underlying_ltp=25413.0,
            requested_strike_count=5, completeness=Completeness.COMPLETE, rows=chain, ce_count=5, pe_count=5,
        )  # fmt: skip
        out.append(svc._checked(snap))
    assert [s.underlying_ltp_broker for s in out] == [None, None, 25413.0]  # only the third, frozen capture is replaced
    assert ledger.counts(AT + timedelta(minutes=5))["index_quote_replaced"] == {"today": 1, "last_hour": 1}
    assert "25413" in ledger.recent(1)[0]["detail"]
    ledger.reset()
