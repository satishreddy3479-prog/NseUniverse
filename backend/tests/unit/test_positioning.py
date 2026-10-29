"""Window PCRs, premium/OI classification, concentration and the IV term structure (hand calculations).

Small chains below are SYNTHETIC numbers chosen to make each rule checkable by hand (formula checks, not market data);
the real captured 28 Oct chain is cross-checked in test_intraday.py."""

from __future__ import annotations

from datetime import date

import pytest

from app.intraday import positioning as ps
from app.intraday.features import Quote
from app.intraday.volatility import term_structure

C, P = 0, 1


def chain(rows: dict[tuple[float, int], tuple]) -> dict:
    return {k: Quote(*v) for k, v in rows.items()}  # (ltp, oi, oi_prev, volume)


NOW = chain({
    (100.0, C): (10, 100, 90, 50), (100.0, P): (8, 200, 150, 60),
    (110.0, C): (4, 300, 250, 10), (110.0, P): (20, 50, 40, 5),
    (120.0, C): (1, 600, 500, 0), (120.0, P): (30, 0, 0, 0),
})  # fmt: skip


def test_window_pcr_uses_the_same_strikes_for_both_sides_and_never_divides_by_zero() -> None:
    w = ps.window_pcr(NOW, 101.0, windows=(1,))
    # ATM = 100, window +/-1 strike = {100, 110}: put OI 200+50 = 250, call OI 100+300 = 400 -> 0.625; volume (60+5)/(50+10)
    assert w["atm_pm1"]["pcr_oi"] == 0.625 and w["atm_pm1"]["pcr_volume"] == round(65 / 60, 4) and w["atm_pm1"]["strikes"] == 2
    assert w["all"]["pcr_oi"] == round(250 / 1000, 4)  # all three strikes: puts 250, calls 1000
    zero_calls = chain({(100.0, C): (10, 0, 0, 0), (100.0, P): (8, 200, 150, 60)})
    assert ps.window_pcr(zero_calls, 100.0)["all"]["pcr_oi"] is None  # zero call OI: undefined, not infinite


def test_oi_change_pcr_needs_a_positive_call_change() -> None:
    ref = chain({(100.0, C): (9, 80, 0, 0), (100.0, P): (7, 150, 0, 0), (110.0, C): (3, 250, 0, 0), (110.0, P): (19, 40, 0, 0)})
    now = chain({(100.0, C): (10, 100, 0, 0), (100.0, P): (8, 200, 0, 0), (110.0, C): (4, 300, 0, 0), (110.0, P): (20, 50, 0, 0)})
    r = ps.oi_change_pcr(now, ref, 100.0)
    assert (r["ce_change"], r["pe_change"], r["value"]) == (70, 60, round(60 / 70, 4))  # calls +20 +50, puts +50 +10
    falling = chain({(100.0, C): (10, 70, 0, 0), (100.0, P): (8, 200, 0, 0)})
    assert ps.oi_change_pcr(falling, ref, 100.0)["value"] is None  # call OI fell: no ratio
    assert ps.oi_change_pcr(now, None, 100.0)["reason"] == "no reference sample"


@pytest.mark.parametrize(
    ("args", "label", "reading"),
    [
        ((12, 10, 120, 100), "Rising premium, rising OI", "new buying more likely"),
        ((8, 10, 120, 100), "Falling premium, rising OI", "new writing more likely"),
        ((12, 10, 80, 100), "Rising premium, falling OI", "short covering more likely"),
        ((8, 10, 80, 100), "Falling premium, falling OI", "long unwinding more likely"),
    ],
)
def test_premium_oi_classification_four_cases(args: tuple, label: str, reading: str) -> None:
    c = ps.classify(*args)
    assert (c["label"], c["reading"]) == (label, reading)


def test_small_changes_and_missing_values_are_not_classified() -> None:
    assert ps.classify(10.04, 10, 120, 100)["label"] == "Unchanged"  # premium +0.4 % < 0.5 %
    assert ps.classify(12, 10, 100.4, 100)["label"] == "Unchanged"  # OI +0.4 %
    assert ps.classify(None, 10, 120, 100)["label"] is None and "missing" in ps.classify(None, 10, 120, 100)["reason"]
    assert ps.classify(5, 0, 120, 100)["label"] == "Rising premium, rising OI"  # a zero reference still has a direction


def test_side_classification_sums_over_the_strikes_that_have_both_samples() -> None:
    ref = chain({(100.0, C): (9, 80, 0, 0), (100.0, P): (9, 250, 0, 0), (110.0, C): (3, 250, 0, 0), (110.0, P): (25, 60, 0, 0)})
    now = chain({(100.0, C): (10, 100, 0, 0), (100.0, P): (8, 200, 0, 0), (110.0, C): (4, 300, 0, 0), (110.0, P): (20, 50, 0, 0)})
    r = ps.side_classification(now, ref, 100.0, each=1)
    # calls: premium 10+4 vs 9+3 (up), OI 400 vs 330 (up); puts: premium 28 vs 34 (down), OI 250 vs 310 (down)
    assert r["calls"]["label"] == "Rising premium, rising OI" and r["calls"]["premium_change"] == 2 and r["calls"]["oi_change"] == 70
    assert r["puts"]["label"] == "Falling premium, falling OI" and r["puts"]["oi_change"] == -60
    assert {(x["strike"], x["side"]) for x in r["strike_rows"]} == {(100.0, "CE"), (100.0, "PE"), (110.0, "CE"), (110.0, "PE")}
    assert ps.side_classification(now, None, 100.0)["available"] is False
    assert "who bought or sold" in r["limits"]


def test_concentration_and_its_shift() -> None:
    now = chain({(k, C): (1, oi, 0, 0) for k, oi in zip((100.0, 110.0, 120.0, 130.0), (100, 300, 600, 0), strict=True)})
    c = ps.concentration(now)["calls"]
    assert c["max_strike"] == 120.0 and c["top3"] == [120.0, 110.0, 100.0] and c["top3_share"] == 1.0  # all OI sits in three strikes
    wide = chain({(k, C): (1, 100, 0, 0) for k in (100.0, 110.0, 120.0, 130.0)})
    assert ps.concentration(wide)["calls"]["top3_share"] == 0.75
    shift = ps.concentration_shift(now, wide)
    assert shift["calls"] == {"top3_share_change": 0.25, "max_strike_from": 100.0, "max_strike_to": 120.0}
    assert ps.concentration(chain({(100.0, P): (1, 5, 0, 0)}))["calls"]["top3_share"] is None  # no call data
    assert ps.concentration_shift(now, None) is None


def test_term_structure_shape_and_slope() -> None:
    pts = [(date(2026, 11, 3), 5.2, 16.5), (date(2026, 11, 24), 26.2, 17.9)]
    t = term_structure(pts)
    assert t["shape"] == "upward (far expiry richer)" and t["iv_far_minus_near"] == 1.4 and t["slope_per_30d"] == round(1.4 / 21 * 30, 3)
    inv = term_structure([(date(2026, 11, 3), 5.2, 20.0), (date(2026, 11, 24), 26.2, 17.0)])
    assert inv["shape"] == "inverted (near expiry richer)"
    assert term_structure([(date(2026, 11, 3), 5.2, 16.5), (date(2026, 11, 24), 26.2, 16.6)])["shape"] == "flat"
    one = term_structure([(date(2026, 11, 3), 5.2, 16.5), (date(2026, 11, 24), 26.2, None)])
    assert one["shape"] is None and one["reason"].startswith("needs ATM IV") and len(one["rows"]) == 2
