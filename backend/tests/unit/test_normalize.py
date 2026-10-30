from datetime import UTC, date, datetime
from typing import Any

import pytest

from app.domain.models import Completeness, DataSource, ExpiryKind
from app.domain.normalize import ChainFormatError, normalize_option_chain, parse_number

EXP = date(2026, 11, 3)


def item(side: str, strike: Any, token: str | None = "1001", **quote: Any) -> dict[str, Any]:
    q = {
        "ltp": "101.5",
        "open": "100",
        "high": "110",
        "low": "95",
        "prevClose": "99",
        "close": None,
        "volume": 1500,
    }
    q.update(quote.pop("q", {}))
    oi = {"current": 3000, "previous": 2500, "change": 500, "changePct": 20.0}
    oi.update(quote.pop("oi", {}))
    return {
        "instrument": {
            "neoSymbol": f"nse_fo|{token}" if token else None,
            "symbol": f"NIFTY{strike}{side}",
            "optionType": side,
            "strikePrice": strike,
            "moneyness": "ATM",
        },
        "quote": q,
        "openInterest": oi,
    }


def norm(raw: dict[str, Any], count: int = 2):
    return normalize_option_chain(
        raw,
        snapshot_id="s1",
        session_id="sess",
        underlying="NIFTY",
        expiry=EXP,
        expiry_kinds=[ExpiryKind.WEEKLY],
        source=DataSource.SNAPSHOT,
        retrieved_at=datetime(2026, 10, 28, 9, 0, tzinfo=UTC),
        requested_strike_count=count,
    )


@pytest.mark.parametrize(
    "value,expected",
    [
        (None, (None, False)),
        ("", (None, False)),
        ("-", (None, False)),
        ("1,234.5", (1234.5, False)),
        (7, (7.0, False)),
        ("abc", (None, True)),
        ("nan", (None, True)),
        (float("inf"), (None, True)),
        (True, (None, True)),
        ("-5", (None, True)),
    ],
)
def test_parse_number(value: Any, expected: tuple[float | None, bool]) -> None:
    assert parse_number(value) == expected


def test_negative_allowed_when_requested() -> None:
    assert parse_number("-5", allow_negative=True) == (-5.0, False)


def test_complete_chain() -> None:
    raw = {
        "common_data": {"mktLot": 75, "multiplier": 1, "expiryDt": "2026-11-03"},
        "call": [item("CE", "24000", "1"), item("CE", 24050, "2")],
        "put": [item("PE", "24000", "3"), item("PE", "24050", "4")],
    }
    s = norm(raw)
    assert s.completeness is Completeness.COMPLETE
    assert [r.strike for r in s.rows] == [24000.0, 24050.0]
    c = s.rows[0].call
    assert c is not None and c.instrument_token == "1" and c.exchange_segment == "nse_fo"
    assert c.ltp == 101.5 and c.oi == 3000 and c.oi_change == 500 and c.close is None
    assert s.lot_size == 75 and s.ce_count == 2 and s.pe_count == 2 and not s.warnings


def test_missing_and_invalid_values_stay_none_never_zero() -> None:
    raw = {
        "call": [
            item("CE", "24000", q={"ltp": None, "volume": "x"}, oi={"current": -10, "change": -300})
        ],
        "put": [item("PE", "24000")],
    }
    s = norm(raw, count=1)
    c = s.rows[0].call
    assert c is not None
    assert c.ltp is None and "ltp" not in c.invalid_fields
    assert c.volume is None and "volume" in c.invalid_fields
    assert c.oi is None and "oi" in c.invalid_fields
    assert (
        c.oi_change is None
    )  # computed from cur/prev; invalid current -> missing, never trusted from source


def test_partial_when_side_missing_or_fewer_strikes() -> None:
    raw = {"call": [item("CE", "24000"), item("CE", "24050")], "put": [item("PE", "24000")]}
    s = norm(raw)
    assert s.completeness is Completeness.PARTIAL
    assert s.rows[1].put is None
    s2 = norm({"call": [item("CE", "24000")], "put": [item("PE", "24000")]}, count=4)
    assert s2.completeness is Completeness.PARTIAL and any("requested" in w for w in s2.warnings)


def test_empty_chain() -> None:
    s = norm({"call": [], "put": []})
    assert s.completeness is Completeness.EMPTY and s.rows == []


def test_data_wrapper_accepted() -> None:
    s = norm({"data": {"call": [item("CE", "1")], "put": [item("PE", "1")]}}, count=1)
    assert s.completeness is Completeness.COMPLETE


def test_not_a_chain_raises() -> None:
    with pytest.raises(ChainFormatError):
        norm({"message": "something else"})


def test_malformed_entries_are_skipped_with_warnings() -> None:
    raw = {"call": ["junk", item("CE", None), item("CE", "24000", token=None)], "put": "notalist"}
    s = norm(raw, count=1)
    assert len(s.rows) == 1 and s.rows[0].put is None
    assert any("non-object" in w for w in s.warnings)
    assert any("missing strikePrice" in w for w in s.warnings)
    assert any("missing instrument token" in w for w in s.warnings)
    assert any("not a list" in w for w in s.warnings)


def test_duplicates_and_expiry_mismatch_flagged() -> None:
    raw = {
        "common_data": {"expiryDt": "2026-11-10"},
        "call": [item("CE", "1", "a"), item("CE", "1", "b")],
        "put": [item("PE", "1")],
    }
    s = norm(raw, count=1)
    assert s.rows[0].call is not None and s.rows[0].call.instrument_token == "a"
    assert any("duplicate" in w for w in s.warnings)
    assert any("differs from requested" in w for w in s.warnings)


# --- Observed live response shape (Kotak Neo, 2026-10-28, NIFTY nse_fo). Values are copied
# --- from a real response for three contracts; used to pin the parser to reality.
LIVE_SHAPE = {
    "common_data": {
        "mktLot": "65",
        "multiplier": "1",
        "expiryDt": "2026-11-23",
        "unlSymbol": "NIFTY",
        "exSeg": "nse_fo",
    },
    "call": [
        {
            "inst": {
                "neoSymbol": "nse_fo|64151",
                "symbol": "NIFTY26NOV20700CE",
                "optType": "CE",
                "strkPrc": "20700",
                "exp": "2026-11-23",
                "moneyness": "itm",
            },
            "quote": {
                "ltp": "1900.0000",
                "o": "1900.0000",
                "h": "1900.0000",
                "l": "1900.0000",
                "c": "3951.1",
                "pc": "3951.1",
                "vol": "65",
            },
            "oi": {"cur": "0", "prev": "0", "chg": "-2051.1000", "chgPct": "-51.9100"},
        },
        {
            "inst": {
                "neoSymbol": "nse_fo|64200",
                "symbol": "NIFTY26NOV22700CE",
                "optType": "CE",
                "strkPrc": "22700",
                "exp": "2026-11-23",
                "moneyness": "atm",
            },
            "quote": {
                "ltp": "418.7500",
                "o": "460",
                "h": "470",
                "l": "400",
                "c": "464.2",
                "pc": "464.2",
                "vol": "1500000",
            },
            "oi": {"cur": "2793180", "prev": "2651220", "chg": "-45.4500", "chgPct": "-9.7900"},
        },
    ],
    "put": [
        {
            "inst": {
                "neoSymbol": "nse_fo|64152",
                "symbol": "NIFTY26NOV20700PE",
                "optType": "PE",
                "strkPrc": "20700",
                "exp": "2026-11-23",
                "moneyness": "otm",
            },
            "quote": {
                "ltp": "21.9500",
                "o": "30.5500",
                "h": "30.7000",
                "l": "20.0000",
                "c": "24.95",
                "pc": "24.95",
                "vol": "156780",
            },
            "oi": {"cur": "138710", "prev": "125970", "chg": "-3.0000", "chgPct": "-12.0200"},
        },
    ],
    "future_contracts": [],
    "spot": {
        "exchId": "Nifty 50",
        "exSeg": "nse_cm",
        "symbol": "Nifty 50",
        "ltp": "22698.8500",
        "prevClose": "22749.75",
    },
    "future": {
        "exchId": "61471",
        "symbol": "NIFTY26NOVFUT",
        "ltp": "22775.3000",
        "prevClose": "15572310",
        "expiry": "2026-11-23",
    },
}


def test_observed_live_shape_is_parsed() -> None:
    s = norm(LIVE_SHAPE, count=2)
    assert [r.strike for r in s.rows] == [20700.0, 22700.0]
    first = s.rows[0]
    assert first.call is not None and first.put is not None
    assert first.call.instrument_token == "64151" and first.call.exchange_segment == "nse_fo"
    assert first.call.trading_symbol == "NIFTY26NOV20700CE"
    assert first.call.ltp == 1900.0 and first.call.prev_close == 3951.1 and first.call.volume == 65
    assert first.call.moneyness == "ITM"
    atm = s.rows[1].call
    assert atm is not None and atm.moneyness == "ATM"
    assert s.lot_size == 65 and s.underlying_ltp == 22698.85 and s.underlying_prev_close == 22749.75
    assert s.ce_count == 2 and s.pe_count == 1 and s.completeness is Completeness.PARTIAL


def test_oi_change_is_computed_not_taken_from_misleading_source_field() -> None:
    s = norm(LIVE_SHAPE, count=2)
    atm = s.rows[1].call
    assert atm is not None
    assert atm.oi == 2793180 and atm.oi_previous == 2651220
    assert (
        atm.oi_change == 2793180 - 2651220
    )  # NOT the source's chg of -45.45 (that is price change)
    assert atm.oi_change_pct == pytest.approx((2793180 - 2651220) / 2651220 * 100)
    put = s.rows[0].put
    assert put is not None and put.oi_change == 138710 - 125970


def test_oi_change_pct_undefined_when_previous_oi_is_zero() -> None:
    first = norm(LIVE_SHAPE, count=2).rows[0].call
    assert first is not None
    assert first.oi == 0 and first.oi_change == 0 and first.oi_change_pct is None


def test_future_block_is_ignored() -> None:
    s = norm(LIVE_SHAPE, count=2)
    assert not any("15572310" in w for w in s.warnings)


def test_bad_spot_is_missing_with_warning() -> None:
    raw = {**LIVE_SHAPE, "spot": {"ltp": "abc", "prevClose": None}}
    s = norm(raw, count=2)
    assert s.underlying_ltp is None and s.underlying_prev_close is None
    assert any("spot" in w for w in s.warnings)


@pytest.mark.parametrize("raw", [2.23e17, 8.4e18, "223000000000000000"])
def test_absurd_values_seen_in_real_payloads_are_flagged_not_kept(raw: Any) -> None:
    # Real corrupt OI values seen on 30 Oct 2026 (22100 CE, 24800 CE) must read as invalid.
    assert parse_number(raw) == (None, True)
    assert parse_number(9_000_000) == (9_000_000.0, False)  # a large but real OI is kept
