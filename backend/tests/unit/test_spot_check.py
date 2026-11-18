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
    spot, broker, note = checked_spot(chain, 25413.0, EXPIRY, AT)
    assert broker == 25413.0 and spot is not None and abs(spot - 25453.8) < 0.05
    assert note is not None and "25413" in note and "41 points below" in note


def test_a_quote_within_fifteen_points_is_used_as_sent_and_one_further_off_is_replaced() -> None:
    chain = rows(25453.8, [25300.0, 25350.0, 25400.0, 25450.0, 25500.0])
    assert checked_spot(chain, 25440.0, EXPIRY, AT) == (25440.0, None, None)  # 13.8 points apart
    spot, broker, _ = checked_spot(chain, 25430.0, EXPIRY, AT)  # 23.8 points apart: 18 Nov 15:20, the chain said 25,220.45 while its prices implied 25,247
    assert broker == 25430.0 and spot is not None and abs(spot - 25453.8) < 0.05


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
    spot, broker, note = checked_spot(chain, 25413.0, EXPIRY, AT)
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
