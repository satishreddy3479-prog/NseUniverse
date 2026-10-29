"""IV, Greeks, forward and expected-move tests. Reference values are solved by hand or by an independent check:
* Black-76 at-the-money call, F=K=100, T=1, sigma=0.2, r=0: price = F (2 N(0.1) - 1) = 100 x (2 x 0.5398278 - 1) = 7.9656.
* Greeks against central finite differences of the price function (an independent computation).
* Chains priced by the model itself with a chosen volatility (FORMULA CHECKS, not market data): the solver must return it.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from app.intraday import volatility as v
from app.intraday.volatility import CALL, PUT, IST

NOW = datetime(2026, 10, 29, 10, 0, tzinfo=IST)
EXPIRY = date(2026, 11, 3)
T = v.years_to_expiry(EXPIRY, NOW)


def test_price_matches_the_hand_solved_value_and_put_call_parity() -> None:
    assert v.price(CALL, 100, 100, 1, 0.2, 0.0) == pytest.approx(7.9656, abs=1e-4)
    c, p = v.price(CALL, 24000, 24100, T, 0.15, 0.06), v.price(PUT, 24000, 24100, T, 0.15, 0.06)
    assert c - p == pytest.approx(v.math.exp(-0.06 * T) * (24000 - 24100), abs=1e-6)  # C - P = e^{-rT} (F - K)


def test_time_to_expiry_is_calendar_time_to_the_close_of_expiry_day() -> None:
    # 29 Oct 10:00 -> 3 Nov 15:30 IST = 5 days 5.5 hours = 5.229166 days
    assert T * 365 == pytest.approx(5 + 5.5 / 24, abs=1e-9)


@pytest.mark.parametrize("side", [CALL, PUT])
@pytest.mark.parametrize("sigma", [0.08, 0.15, 0.35, 0.9])
def test_implied_vol_recovers_the_volatility_that_priced_the_option(side: int, sigma: float) -> None:
    f, k = 24000.0, 24150.0
    px = v.price(side, f, k, T, sigma, 0.06)
    assert v.implied_vol(side, px, f, k, T, 0.06) == pytest.approx(sigma, abs=1e-6)


def test_prices_outside_no_arbitrage_bounds_or_missing_give_no_volatility() -> None:
    f, k = 24000.0, 24000.0
    assert v.implied_vol(CALL, None, f, k, T) is None and v.implied_vol(CALL, 0.0, f, k, T) is None
    assert v.implied_vol(CALL, 5000.0, f, k, T) is None  # above the forward: impossible
    deep = v.price(CALL, 24000, 20000, T, 0.2, 0.06)  # deep ITM
    assert v.implied_vol(CALL, deep * 0.9, 24000, 20000, T, 0.06) is None  # below intrinsic
    assert v.implied_vol(CALL, 10.0, f, k, 0.0) is None  # no time left


@pytest.mark.parametrize("side", [CALL, PUT])
def test_greeks_match_finite_differences(side: int) -> None:
    f, k, s, r = 24000.0, 24100.0, 0.16, 0.06
    g = v.greeks(side, f, k, T, s, r)
    assert g is not None
    h = 1.0
    d = (v.price(side, f + h, k, T, s, r) - v.price(side, f - h, k, T, s, r)) / (2 * h)
    gam = (v.price(side, f + h, k, T, s, r) - 2 * v.price(side, f, k, T, s, r) + v.price(side, f - h, k, T, s, r)) / h**2
    vega = (v.price(side, f, k, T, s + 0.0001, r) - v.price(side, f, k, T, s - 0.0001, r)) / 0.0002 / 100
    dt = 1 / 365 / 24 / 60  # one minute
    theta = (v.price(side, f, k, T - dt, s, r) - v.price(side, f, k, T + dt, s, r)) / (2 * dt) / 365  # per calendar day, value change as time passes
    assert g.delta == pytest.approx(d, abs=1e-6) and g.gamma == pytest.approx(gam, rel=1e-4) and g.vega_pt == pytest.approx(vega, rel=1e-4)
    assert g.theta_day == pytest.approx(theta, rel=1e-3)  # value change per calendar day as time passes: negative
    assert g.theta_day < 0 and g.gamma > 0 and g.vega_pt > 0


def test_forward_is_recovered_from_put_call_parity_and_falls_back_loudly() -> None:
    f_true, r = 24060.0, 0.06
    prices = {(k, s): v.price(s, f_true, k, T, 0.15, r) for k in (23900.0, 24000.0, 24100.0, 24200.0) for s in (CALL, PUT)}
    f, src = v.forward_from_parity(prices, 24000.0, T, r) or (0, "")
    assert f == pytest.approx(f_true, abs=1e-6) and src == "put-call parity at 24000"
    f2, src2 = v.forward_from_parity({(24000.0, CALL): 100.0}, 24000.0, T, r) or (0, "")
    assert src2.startswith("spot x carry") and f2 == pytest.approx(24000 * v.math.exp(r * T))
    assert v.forward_from_parity(prices, None, T) is None


def test_surface_reads_atm_iv_skew_and_expected_move() -> None:
    f_true, r = 24060.0, 0.06

    def sigma(k: float) -> float:  # put side richer than call side: a downside skew (synthetic smile)
        return 0.15 + (24060 - k) / 24060 * 0.4

    prices = {(k, s): v.price(s, f_true, k, T, sigma(k), r) for k in range(23700, 24500, 50) for s in (CALL, PUT)}
    prices = {(float(k), s): p for (k, s), p in prices.items()}
    sf = v.surface(prices, 24040.0, EXPIRY, NOW, r, each_side=8)
    assert sf["status"] == "ok" and sf["forward"] == pytest.approx(f_true, abs=1e-3) and sf["atm_strike"] == 24050.0
    assert sf["atm_iv"] == pytest.approx(sigma(24050.0) * 100, abs=1e-3)
    assert sf["skew_25d_put_minus_call"] is not None and sf["skew_25d_put_minus_call"] > 0  # puts richer than calls
    assert sf["expected_move_straddle_pts"] == pytest.approx(prices[(24050.0, CALL)] + prices[(24050.0, PUT)])
    assert sf["expected_move_iv_1sd_pts"] == pytest.approx(f_true * sigma(24050.0) * T**0.5, abs=0.2)
    otm = [r_ for r_ in sf["rows"] if r_["otm"] and r_["strike"] != 24050.0]
    assert all((r_["delta"] > 0) == (r_["side"] == "CE") for r_ in otm)  # call deltas positive, put deltas negative


def test_expiry_day_and_missing_data_are_reported_not_invented() -> None:
    prices = {(24000.0, CALL): 50.0, (24000.0, PUT): 48.0}
    close = datetime(2026, 11, 3, 15, 20, tzinfo=IST)  # 10 minutes before expiry
    assert v.surface(prices, 24000.0, EXPIRY, close)["status"].startswith("not computed: less than 15 minutes")
    assert v.surface(prices, 24000.0, EXPIRY, datetime(2026, 11, 3, 16, 0, tzinfo=IST))["status"].startswith("not computed")  # expired
    assert v.surface(prices, None, EXPIRY, NOW)["status"] == "not computed: no spot price"
    sf = v.surface({(24000.0, CALL): None, (24000.0, PUT): 48.0}, 24000.0, EXPIRY, NOW)
    assert sf["atm_iv"] is not None and sf["atm_call_iv"] is None  # the put alone still gives an IV; the call stays missing


def test_realised_volatility_and_interpretation() -> None:
    t0 = NOW
    flat = [(t0 + timedelta(minutes=i), 24000.0) for i in range(10)]
    assert v.realized_annualised(flat) is None  # no movement: neither zero nor invented
    assert v.realized_annualised(flat[:3]) is None  # too few points
    zig = [(t0 + timedelta(minutes=i), 24000.0 * (1.001 if i % 2 else 1.0)) for i in range(11)]
    # 10 steps of |ln(1.001)| = 0.0009995: sum of squares = 10 x 9.99e-7 over 10 minutes -> sqrt(9.99e-7 x 94500) = 0.3072 -> 30.7 %
    assert v.realized_annualised(zig) == pytest.approx(30.72, abs=0.05)
    assert "Underlying rising while IV falls" in v.interpret(0.3, -0.5, -2.0)[0]
    assert "Underlying falling while IV rises" in v.interpret(-0.4, 0.6, 1.0)[0]
    assert any("range-bound while the ATM straddle contracts" in x for x in v.interpret(0.02, -0.4, -5.0))
    assert v.interpret(None, 0.5, None) == []
