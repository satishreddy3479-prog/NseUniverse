"""Black-76 pricing core (app/risk/pricing.py): hand values, put-call parity, the guards, agreement with the pricer the app already uses, and property tests.

Expected numbers are worked out by hand or from an independent formula in the test (N(x) = 0.5 (1 + erf(x / sqrt 2)), not the erfc form the module uses).
"""

from __future__ import annotations

import math
import time
import warnings
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.intraday import volatility as old
from app.risk.pricing import (
    CALL,
    DEFAULT,
    PUT,
    PricingConfig,
    black76,
    intrinsic_value,
    normal_cdf,
    normal_pdf,
    parity_residual,
    prepare,
    years_between,
)

IST = ZoneInfo("Asia/Kolkata")
pytestmark = pytest.mark.filterwarnings("error::RuntimeWarning")  # a NumPy warning (invalid value, overflow, divide) is a failure; unrelated warnings from other tests (unclosed databases) are not  # a RuntimeWarning (invalid, overflow, divide) from NumPy is a failure


def n_ref(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


# ------------------------------------------------------------------ hand values
def test_atm_value_by_hand() -> None:
    # F = K = 100, T = 1, sigma = 0.2, r = 0.05: d1 = 0.5 sigma sqrt T = 0.1, d2 = -0.1.
    # call = e^-0.05 * 100 * (N(0.1) - N(-0.1)) = 0.9512294245 * 100 * 0.0796556746 = 7.5770821; at the money forward the put is worth the same
    want = math.exp(-0.05) * 100.0 * (n_ref(0.1) - n_ref(-0.1))
    assert want == pytest.approx(7.5770821, abs=1e-7)
    assert black76(CALL, 100, 100, 1.0, 0.2, 0.05) == pytest.approx(want, abs=1e-12)
    assert black76(PUT, 100, 100, 1.0, 0.2, 0.05) == pytest.approx(want, abs=1e-12)


def test_off_the_money_value_by_hand() -> None:
    # F = 110, K = 100, T = 0.5, sigma = 0.25, r = 0.04:  sigma sqrt T = 0.1767767, d1 = (ln 1.1 + 0.5 * 0.0625 * 0.5) / 0.1767767 = (0.0953102 + 0.015625) / 0.1767767 = 0.627544
    t, sig, r, f, k = 0.5, 0.25, 0.04, 110.0, 100.0
    v = sig * math.sqrt(t)
    d1 = (math.log(f / k) + 0.5 * sig * sig * t) / v
    d2 = d1 - v
    assert d1 == pytest.approx(0.627544, abs=1e-6)
    call = math.exp(-r * t) * (f * n_ref(d1) - k * n_ref(d2))
    put = math.exp(-r * t) * (k * n_ref(-d2) - f * n_ref(-d1))
    assert black76(CALL, f, k, t, sig, r) == pytest.approx(call, abs=1e-12)
    assert black76(PUT, f, k, t, sig, r) == pytest.approx(put, abs=1e-12)
    assert call - put == pytest.approx(math.exp(-r * t) * (f - k), abs=1e-12)


def test_normal_distribution_function_and_density() -> None:
    x = np.array([-40.0, -8.0, -1.0, 0.0, 1.0, 8.0, 40.0])
    got = normal_cdf(x)
    assert got[3] == 0.5 and got[2] == pytest.approx(0.15865525393145707, abs=1e-15) and got[4] == pytest.approx(0.8413447460685429, abs=1e-15)
    assert got[1] == pytest.approx(6.22096057427178e-16, rel=1e-12)  # exact in the tail: 1 - N(8) done with erf would lose every digit
    assert got[0] == 0.0 and got[6] == 1.0 and np.isfinite(got).all()  # N(-40) ~ 3.7e-350 is below the smallest double: exactly 0, never NaN
    assert normal_pdf(0.0) == pytest.approx(1.0 / math.sqrt(2.0 * math.pi), abs=1e-16) and normal_pdf(60.0) == 0.0
    assert np.isnan(normal_cdf(np.nan))


# ------------------------------------------------------------------ put-call parity (the chain, vectorised)
def test_put_call_parity_across_a_nifty_chain_to_1e_8() -> None:
    strikes = np.arange(23000.0, 28000.1, 50.0)  # 101 strikes around a 25,500 forward
    f, t, r = 25500.0, 3.0 / 365.0, 0.065
    smile = 0.15 + 0.4 * (np.log(strikes / f)) ** 2  # a smile, 15 % at the money
    call, put = black76(CALL, f, strikes, t, smile, r), black76(PUT, f, strikes, t, smile, r)
    assert np.max(np.abs(parity_residual(call, put, f, strikes, t, r))) < 1e-8
    assert np.all(call >= 0) and np.all(put >= 0)


def test_put_call_parity_over_random_inputs_including_extreme_ones() -> None:
    rng = np.random.default_rng(20261120)
    n = 20000
    f = np.exp(rng.uniform(math.log(10.0), math.log(1e5), n))
    k = f * np.exp(rng.uniform(-1.5, 1.5, n))  # strikes from 22 % to 450 % of the forward
    t = np.exp(rng.uniform(math.log(2e-8), math.log(3.0), n))  # from about a second to three years
    sigma = np.exp(rng.uniform(math.log(2e-4), math.log(4.0), n))
    r = rng.uniform(-0.01, 0.12, n)
    call, put = black76(CALL, f, k, t, sigma, r), black76(PUT, f, k, t, sigma, r)
    scale = np.maximum(f, k)
    assert np.max(np.abs(parity_residual(call, put, f, k, t, r)) / scale) < 1e-12  # relative to the size of F and K
    assert np.max(np.abs(parity_residual(call, put, f, k, t, r))) < 1e-7  # and absolutely tiny even at F = 100,000


# ------------------------------------------------------------------ agreement with the pricer the application already uses
def test_agrees_with_the_existing_scalar_pricer_to_1e_9() -> None:
    rng = np.random.default_rng(7)
    for _ in range(400):
        f = float(rng.uniform(100, 40000))
        k = f * float(np.exp(rng.uniform(-0.3, 0.3)))
        t = float(rng.uniform(1e-4, 1.0))
        s = float(rng.uniform(0.05, 1.2))
        r = float(rng.uniform(0.0, 0.1))
        for side, cp in ((old.CALL, CALL), (old.PUT, PUT)):
            assert float(black76(cp, f, k, t, s, r)) == pytest.approx(old.price(side, f, k, t, s, r), abs=1e-9, rel=1e-12)


# ------------------------------------------------------------------ the guards and edge cases
def test_one_second_to_expiry_is_priced_by_the_model_and_less_is_intrinsic() -> None:
    one_s = DEFAULT.t_floor_years
    assert one_s == pytest.approx(1.0 / 31_536_000.0, rel=1e-15)
    atm = float(black76(CALL, 25500, 25500, one_s, 0.15, 0.065))
    assert atm == pytest.approx(25500 * 0.15 * math.sqrt(one_s) / math.sqrt(2 * math.pi), rel=1e-3)  # ATM value ~ F sigma sqrt(T) / sqrt(2 pi): sqrt(3.171e-8) = 1.781e-4, 25500 * 0.15 * 1.781e-4 / 2.5066 = 0.2718
    assert 0.27 < atm < 0.275
    just_under = float(black76(CALL, 25510, 25500, one_s * 0.999, 0.15, 0.065))
    assert just_under == pytest.approx(10.0 * math.exp(-0.065 * one_s * 0.999), abs=1e-12)  # intrinsic, discounted at the real T
    assert float(black76(CALL, 25500, 25500, 0.0, 0.15, 0.065)) == 0.0 and float(black76(PUT, 25490, 25500, -1.0, 0.15, 0.065)) == 10.0  # expired: discount factor 1


def test_low_volatility_is_intrinsic_and_high_volatility_is_clamped() -> None:
    assert float(black76(CALL, 25600, 25500, 0.02, 1e-5, 0.0)) == 100.0  # below the floor of 1e-4
    assert float(black76(CALL, 25600, 25500, 0.02, 0.0, 0.0)) == 100.0 and float(black76(PUT, 25600, 25500, 0.02, -0.3, 0.0)) == 0.0
    at_floor = float(black76(CALL, 25500, 25500, 0.02, 1e-4, 0.0))
    assert 0.0 < at_floor < 0.5  # sigma exactly 1e-4 is a model price: ATM about F sigma sqrt(T) / sqrt(2 pi) = 0.0056
    assert float(black76(CALL, 25500, 25500, 0.5, 50.0, 0.0)) == float(black76(CALL, 25500, 25500, 0.5, 5.0, 0.0))  # clamped at 5.0
    sv = float(black76(CALL, 25500, 25500, 0.01, 0.01, 0.0))  # sigma = 0.01 (1 %)
    assert sv == pytest.approx(25500 * 0.01 * math.sqrt(0.01) / math.sqrt(2 * math.pi), rel=1e-3)  # ~ 10.17


def test_deep_in_and_out_of_the_money_stay_finite_and_inside_the_bounds() -> None:
    deep_otm = black76(CALL, 25500, 60000, 0.01, 0.15, 0.065)  # d1 ~ -60: N underflows to 0
    assert float(deep_otm) == 0.0 and np.isfinite(deep_otm)
    deep_itm_put = black76(PUT, 25500, 60000, 0.01, 0.15, 0.065)
    assert float(deep_itm_put) == pytest.approx(math.exp(-0.065 * 0.01) * (60000 - 25500), abs=1e-6)
    wide = black76(CALL, 25500, np.array([1.0, 1e-6, 1e9]), 1.0, 5.0, 0.0)
    # sigma 500 % keeps even a strike of 1 slightly above intrinsic (K N(d2) with d2 = -0.47 is 0.32): 25,499.6; a strike of 1e-6 is worth the forward; a strike of 1e9 is a 14.6k option at 500 % vol
    assert np.all(np.isfinite(wide)) and 25499.0 <= wide[0] < 25500.0 and wide[1] == pytest.approx(25500.0, abs=1e-3) and 0.0 < wide[2] < 25500.0


def test_missing_or_invalid_inputs_give_nan_never_zero() -> None:
    out = black76(CALL, [np.nan, 25500, -1.0, 25500, 25500, np.inf], [25500, np.nan, 25500, 0.0, 25500, 25500], 0.02, [0.15, 0.15, 0.15, 0.15, np.nan, 0.15], 0.0)  # NaN forward, NaN strike, negative forward, zero strike, NaN volatility, infinite forward
    assert np.all(np.isnan(out))
    assert np.isnan(black76(0.0, 25500, 25500, 0.02, 0.15, 0.0)) and np.isnan(black76(2.0, 25500, 25500, 0.02, 0.15, 0.0))  # cp must be +1 or -1
    mixed = black76(CALL, 25500, [25500, np.nan, 25400], 0.02, 0.15, 0.0)
    assert np.isnan(mixed[1]) and np.isfinite(mixed[0]) and np.isfinite(mixed[2])  # one bad element does not spoil the others


def test_the_guards_are_configurable() -> None:
    cfg = PricingConfig(t_floor_s=3600.0, sigma_min=0.05, sigma_max=1.0)
    t_30min = 1800.0 / (365.0 * 86400.0)
    assert float(black76(CALL, 25600, 25500, t_30min, 0.15, 0.0, cfg)) == 100.0  # under the one-hour floor: intrinsic
    assert float(black76(CALL, 25600, 25500, 0.02, 0.04, 0.0, cfg)) == 100.0  # under the 5 % volatility floor
    assert float(black76(CALL, 25500, 25500, 0.5, 9.0, 0.0, cfg)) == float(black76(CALL, 25500, 25500, 0.5, 1.0, 0.0, cfg))  # clamped at 1.0
    assert float(black76(CALL, 25600, 25500, 0.02, 1e-5, 0.0)) == 100.0  # the default config is unchanged by the others (no shared state)


def test_vectorised_results_equal_element_by_element_results_and_shapes_broadcast() -> None:
    k = np.arange(24000.0, 27000.1, 100.0)
    t = np.array([[1 / 365], [7 / 365], [30 / 365]])  # three expiries down the rows, strikes across
    sigma = 0.12 + 0.05 * np.abs(np.log(k / 25500.0))
    grid = black76(CALL, 25500.0, k, t, sigma, 0.065)
    assert grid.shape == (3, k.size)
    for i in (0, 1, 2):
        for j in (0, 10, 20, k.size - 1):
            assert grid[i, j] == float(black76(CALL, 25500.0, k[j], t[i, 0], sigma[j], 0.065))
    assert black76(CALL, 25500.0, 25500.0, 0.01, 0.15, 0.0).shape == ()  # scalars stay scalar-shaped


def test_prepare_exposes_what_the_greeks_will_reuse() -> None:
    st_ = prepare(CALL, 25500.0, [25500.0, 26000.0], 0.01, 0.15, 0.0)
    assert st_.d1[0] == pytest.approx(0.5 * 0.15 * math.sqrt(0.01), rel=1e-12) and st_.d2[0] == pytest.approx(-0.5 * 0.15 * math.sqrt(0.01), rel=1e-12)
    assert st_.vol[0] == pytest.approx(0.015, rel=1e-12) and not st_.intrinsic.any() and st_.valid.all()
    expired = prepare([CALL, PUT], 25500.0, 25500.0, [0.0, 0.01], 0.15, 0.0)
    assert expired.intrinsic.tolist() == [True, False]


def test_intrinsic_value_and_time_to_expiry_by_hand() -> None:
    assert float(intrinsic_value(CALL, 25600, 25500, 0.0, 0.065)) == 100.0
    assert float(intrinsic_value(PUT, 25600, 25500, 0.01, 0.065)) == 0.0
    assert float(intrinsic_value(CALL, 25600, 25500, 0.01, 0.065)) == pytest.approx(100.0 * math.exp(-0.065 * 0.01), abs=1e-12)
    assert np.isnan(intrinsic_value(CALL, np.nan, 25500))
    # Friday 20 Nov 2026 11:00 IST to Monday 23 Nov 15:40 IST: 3 days 4 h 40 min = 276,000 s = 276000 / 31,536,000 years
    now, end = datetime(2026, 11, 20, 11, 0, tzinfo=IST), datetime(2026, 11, 23, 15, 40, tzinfo=IST)
    assert years_between(now, end) == pytest.approx(276000.0 / 31_536_000.0, rel=1e-15)
    assert years_between(end, now) < 0
    with pytest.raises(ValueError):
        years_between(datetime(2026, 11, 20, 11, 0), end)


# ------------------------------------------------------------------ property tests (Hypothesis)
forwards = st.floats(min_value=50.0, max_value=100_000.0)
moneyness = st.floats(min_value=0.3, max_value=3.0)
years = st.floats(min_value=1.0 / 31_536_000.0, max_value=5.0)
vols = st.floats(min_value=1e-4, max_value=5.0)
rates = st.floats(min_value=-0.02, max_value=0.15)
SETTINGS = settings(max_examples=300, deadline=None)


@SETTINGS
@given(f=forwards, m=moneyness, t=years, s=vols, r=rates, cp=st.sampled_from([CALL, PUT]))
def test_price_is_finite_and_inside_the_no_arbitrage_bounds(f: float, m: float, t: float, s: float, r: float, cp: float) -> None:
    k = f * m
    p = float(black76(cp, f, k, t, s, r))
    df = math.exp(-r * t)
    lower = df * max(cp * (f - k), 0.0)
    upper = df * (f if cp == CALL else k)
    assert math.isfinite(p) and lower - 1e-9 * f <= p <= upper + 1e-9 * f


@SETTINGS
@given(f=forwards, m=moneyness, t=years, s1=vols, s2=vols, r=rates, cp=st.sampled_from([CALL, PUT]))
def test_price_never_falls_as_volatility_rises(f: float, m: float, t: float, s1: float, s2: float, r: float, cp: float) -> None:
    lo, hi = min(s1, s2), max(s1, s2)
    assert float(black76(cp, f, f * m, t, hi, r)) >= float(black76(cp, f, f * m, t, lo, r)) - 1e-9 * f


@SETTINGS
@given(f=forwards, m1=moneyness, m2=moneyness, t=years, s=vols, r=rates)
def test_calls_fall_and_puts_rise_with_the_strike(f: float, m1: float, m2: float, t: float, s: float, r: float) -> None:
    lo, hi = min(m1, m2) * f, max(m1, m2) * f
    tol = 1e-9 * f
    assert float(black76(CALL, f, hi, t, s, r)) <= float(black76(CALL, f, lo, t, s, r)) + tol
    assert float(black76(PUT, f, hi, t, s, r)) >= float(black76(PUT, f, lo, t, s, r)) - tol


@SETTINGS
@given(f=forwards, m=moneyness, t=years, s=vols, r=rates, dm=st.floats(min_value=0.0, max_value=0.5))
def test_calls_rise_and_puts_fall_with_the_forward(f: float, m: float, t: float, s: float, r: float, dm: float) -> None:
    k, f2 = f * m, f * (1.0 + dm)
    tol = 1e-9 * f2
    assert float(black76(CALL, f2, k, t, s, r)) >= float(black76(CALL, f, k, t, s, r)) - tol
    assert float(black76(PUT, f2, k, t, s, r)) <= float(black76(PUT, f, k, t, s, r)) + tol


@SETTINGS
@given(f=forwards, m=moneyness, t=years, s=vols, r=rates)
def test_parity_holds_for_any_valid_input(f: float, m: float, t: float, s: float, r: float) -> None:
    k = f * m
    res = float(parity_residual(black76(CALL, f, k, t, s, r), black76(PUT, f, k, t, s, r), f, k, t, r))
    assert abs(res) <= 1e-9 * max(f, k)


@SETTINGS
@given(f=forwards, m=moneyness, t=years, s=vols, r=rates)
def test_option_value_is_convex_in_the_strike(f: float, m: float, t: float, s: float, r: float) -> None:
    k, h = f * m, 0.01 * f * m
    c0, c1, c2 = (float(black76(CALL, f, k + j * h, t, s, r)) for j in (-1, 0, 1))
    assert c0 - 2.0 * c1 + c2 >= -1e-8 * f  # the butterfly value is not negative


# ------------------------------------------------------------------ speed (generous limits; the real numbers are reported with the checkpoint)
def test_a_full_grid_prices_quickly() -> None:
    k = np.arange(24000.0, 27000.1, 50.0)
    f, t = 25500.0, 3.0 / 365.0
    t0 = time.perf_counter()
    for _ in range(20):
        black76(CALL, f, k, t, 0.15, 0.065)
        black76(PUT, f, k, t, 0.15, 0.065)
    chain_ms = (time.perf_counter() - t0) * 1000 / 20  # both sides of a 61-strike chain
    spots = f + np.linspace(-500, 500, 21)[:, None, None]
    vols = 0.15 + np.linspace(-0.05, 0.05, 21)[None, :, None]
    legs = np.arange(10)[None, None, :] * 100.0 + 25000.0
    t1 = time.perf_counter()
    black76(CALL, spots, legs, t, vols, 0.065)
    grid_ms = (time.perf_counter() - t1) * 1000  # 21 x 21 x 10 legs = 4,410 prices in one call
    assert chain_ms < 25.0 and grid_ms < 100.0
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        black76(CALL, spots, legs, t, vols, 0.065)
