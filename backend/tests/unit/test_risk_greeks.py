"""Greeks engine (app/risk/greeks.py): every analytic Greek against an independent finite difference, put-call relations, the third-order bump-and-reprice against closed forms (used here only as an oracle),
the guards, units and rupee terms by hand, and property tests.

The finite differences in this file are written separately from the module's own (Richardson-extrapolated central differences of the price), so a mistake in a formula cannot hide in a shared helper.
Tolerances: 1e-6 relative at the money, 1e-4 in the wings (strikes two to three standard deviations away), as specified.
"""

from __future__ import annotations

import math
import time
from collections.abc import Callable

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.risk.greeks import GreeksConfig, greeks, higher_order, in_rupees, scale
from app.risk.pricing import CALL, DEFAULT, PUT, black76

pytestmark = pytest.mark.filterwarnings("error")

F0, R0 = 25500.0, 0.065


def n_ref(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def fd1(fn: Callable[[float], float], x: float, h: float) -> float:
    """First derivative: central difference with Richardson extrapolation (error O(h^4))."""
    d_h = (fn(x + h) - fn(x - h)) / (2 * h)
    d_2h = (fn(x + 2 * h) - fn(x - 2 * h)) / (4 * h)
    return (4 * d_h - d_2h) / 3


def fd2(fn: Callable[[float], float], x: float, h: float) -> float:
    """Second derivative: central second difference with Richardson extrapolation."""
    d_h = (fn(x + h) - 2 * fn(x) + fn(x - h)) / h**2
    d_2h = (fn(x + 2 * h) - 2 * fn(x) + fn(x - 2 * h)) / (2 * h) ** 2
    return (4 * d_h - d_2h) / 3


def case(cp: float, k_sd: float, t: float, sigma: float) -> tuple[float, float, float, float, float]:
    """(cp, K, T, sigma, r) with the strike ``k_sd`` standard deviations (sigma sqrt T) from the forward."""
    k = F0 * math.exp(k_sd * sigma * math.sqrt(t))
    return cp, k, t, sigma, R0


ATM = [case(cp, 0.0, t, s) for cp in (CALL, PUT) for t in (1 / 365, 3 / 365, 30 / 365, 1.0) for s in (0.1, 0.15, 0.3)]
WINGS = [case(cp, ksd, t, s) for cp in (CALL, PUT) for ksd in (-3.0, -2.0, 2.0, 3.0) for t in (1 / 365, 3 / 365, 30 / 365) for s in (0.1, 0.15, 0.3)]


def check_one(cp: float, k: float, t: float, s: float, r: float, rel: float) -> None:
    def price(f: float = F0, tt: float = t, ss: float = s, rr: float = r) -> float:
        return float(black76(cp, f, k, tt, ss, rr))

    def at(f: float = F0, tt: float = t, ss: float = s, rr: float = r):  # type: ignore[no-untyped-def]
        return greeks(cp, f, k, tt, ss, rr)

    g = at()
    vol = s * math.sqrt(t)
    hf, hs, ht, hr = 0.02 * vol * F0, 0.02 * s, 0.02 * t, 1e-3
    want = {
        "delta": fd1(lambda x: price(f=x), F0, hf),
        "gamma": fd2(lambda x: price(f=x), F0, hf),
        "vega": fd1(lambda x: price(ss=x), s, hs),
        "theta": -fd1(lambda x: price(tt=x), t, ht),  # theta is dV/dt, T = expiry - t
        "rho": fd1(lambda x: price(rr=x), r, hr),
        "vanna": fd1(lambda x: float(at(ss=x).delta), s, hs),
        "vomma": fd1(lambda x: float(at(ss=x).vega), s, hs),
        "charm": -fd1(lambda x: float(at(tt=x).delta), t, ht),
        "veta": -fd1(lambda x: float(at(tt=x).vega), t, ht),
    }
    for name, expect in want.items():
        got = float(getattr(g, name))
        assert got == pytest.approx(expect, rel=rel, abs=1e-9 * max(1.0, abs(expect))), f"{name} cp={cp} K={k:.1f} T={t:.4f} sigma={s}: analytic {got!r}, finite difference {expect!r}"


def check_against_fd(cases: list[tuple[float, float, float, float, float]], rel: float) -> None:
    for cp, k, t, s, r in cases:
        check_one(cp, k, t, s, r, rel)


def test_every_analytic_greek_matches_a_finite_difference_at_the_money_to_1e_6() -> None:
    check_against_fd(ATM, rel=1e-6)


def test_every_analytic_greek_matches_a_finite_difference_in_the_wings_to_1e_4() -> None:
    check_against_fd(WINGS, rel=1e-4)


def cross_check(cp: float, k: float, t: float, s: float, r: float) -> None:
    vol = s * math.sqrt(t)
    hf = 0.02 * vol * F0
    g = greeks(cp, F0, k, t, s, r)
    vanna_via_vega = fd1(lambda x: float(greeks(cp, x, k, t, s, r).vega), F0, hf)  # d vega / dF equals d delta / d sigma
    gamma_via_delta = fd1(lambda x: float(greeks(cp, x, k, t, s, r).delta), F0, hf)
    assert float(g.vanna) == pytest.approx(vanna_via_vega, rel=1e-6, abs=1e-9)
    assert float(g.gamma) == pytest.approx(gamma_via_delta, rel=1e-6, abs=1e-12)


def test_cross_derivatives_agree_both_ways_and_gamma_two_ways() -> None:
    for cp, k, t, s, r in ATM[:6] + WINGS[:6]:
        cross_check(cp, k, t, s, r)


# ------------------------------------------------------------------ relations that need no finite difference
def test_put_call_relations_of_the_greeks() -> None:
    k = np.arange(24000.0, 27000.1, 100.0)
    s = 0.15 + 0.4 * np.log(k / F0) ** 2
    t = 3 / 365
    c, p = greeks(CALL, F0, k, t, s, R0), greeks(PUT, F0, k, t, s, R0)
    df = math.exp(-R0 * t)
    assert np.allclose(c.delta - p.delta, df, rtol=0, atol=1e-13)  # a call less a put is a forward: delta df
    for name in ("gamma", "vega", "vanna", "vomma", "veta"):
        assert np.allclose(getattr(c, name), getattr(p, name), rtol=1e-12, atol=1e-15), name  # the same for calls and puts
    assert np.allclose(c.theta - p.theta, R0 * df * (F0 - k), rtol=1e-12, atol=1e-9)  # theta of the forward position: r df (F - K)
    assert np.allclose(c.rho - p.rho, -t * df * (F0 - k), rtol=1e-12, atol=1e-9)
    assert np.allclose(c.charm - p.charm, R0 * df, rtol=1e-12, atol=1e-13)


# ------------------------------------------------------------------ third order by bump-and-reprice
def closed_forms(cp: float, k: float, t: float, s: float, r: float) -> dict[str, float]:
    """The textbook closed forms, written out here only as an oracle for the bump-and-reprice (the engine does not use them)."""
    vol = s * math.sqrt(t)
    d1 = (math.log(F0 / k) + 0.5 * s * s * t) / vol
    d2 = d1 - vol
    df = math.exp(-r * t)
    phi = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
    gamma = df * phi / (F0 * vol)
    vega = df * F0 * phi * math.sqrt(t)
    return {
        "speed": -gamma / F0 * (d1 / vol + 1.0),
        "zomma": gamma * (d1 * d2 - 1.0) / s,
        "color": gamma * (r - (d1 * d2 - 1.0) / (2 * t)),
        "ultima": vega / s**2 * ((d1 * d2) ** 2 - d1 * d1 - d2 * d2 - d1 * d2),
    }


def test_third_order_matches_the_closed_forms_at_the_money_and_in_the_wings() -> None:
    for cases, rel in ((ATM, 1e-6), (WINGS, 1e-4)):
        for cp, k, t, s, r in cases:
            h = higher_order(cp, F0, k, t, s, r)
            want = closed_forms(cp, k, t, s, r)
            assert not bool(h.unavailable)
            for name, expect in want.items():
                got = float(getattr(h, name))
                assert got == pytest.approx(expect, rel=rel, abs=1e-12 * max(1.0, abs(expect))), f"{name} cp={cp} K={k:.1f} T={t:.4f} sigma={s}: bump {got!r}, closed form {expect!r}"


def test_third_order_is_unavailable_next_to_the_expiry_floor_and_flags_noise() -> None:
    floor = DEFAULT.t_floor_years
    # the time bump is 2 % of T each way (and twice that for the check), so it stays above the floor only from T = floor / 0.96 = 1.0417 floor
    near = higher_order(CALL, F0, F0, [floor, 1.02 * floor, 1.05 * floor, 100 * floor], 0.15, R0)
    assert near.unavailable.tolist() == [True, True, False, False] and np.isnan(near.color[:2]).all() and np.isfinite(near.color[2:]).all()
    assert not near.noisy[3]  # 100 seconds out: still a clean difference
    edge = higher_order(CALL, F0, F0, 0.01, [1.02e-4, 0.15, 4.95], R0)  # 1.02 x the 1e-4 floor, a mid value, and 99 % of the 5.0 cap: the volatility bump of 4 % would cross the floor or the cap
    assert edge.unavailable.tolist() == [True, False, True]
    # at an extreme wing the Greeks are real but tiny: the result is either a good difference or it says so
    far = higher_order(CALL, F0, 1.2 * F0, 1 / 365, 0.15, R0)
    assert far.noisy or abs(float(far.speed)) < 1e-12
    gone = higher_order(CALL, F0, 3.0 * F0, 1 / 365, 0.15, R0)  # everything underflows: zeros, not noise, not NaN
    assert float(gone.speed) == 0.0 and float(gone.ultima) == 0.0 and not bool(gone.noisy) and not bool(gone.unavailable)


# ------------------------------------------------------------------ guards
def test_expired_and_flat_volatility_options_get_step_deltas_and_no_curvature() -> None:
    g = greeks([CALL, CALL, PUT, CALL, CALL], [25600.0, 25400.0, 25400.0, 25500.0, 25600.0], 25500.0, [0.0, 0.0, 0.0, 0.0, 0.02], [0.15, 0.15, 0.15, 0.15, 1e-5], 0.0)
    assert g.intrinsic.all()
    assert g.delta.tolist() == [1.0, 0.0, -1.0, 0.5, 1.0]  # in the money call, out of the money call, in the money put, exactly at the money, flat volatility
    for name in ("gamma", "vega", "vanna", "vomma", "charm", "veta", "theta"):
        assert (getattr(g, name) == 0.0).all(), name
    assert g.price.tolist() == [100.0, 0.0, 100.0, 0.0, 100.0]


def test_missing_and_invalid_inputs_give_nan_for_every_greek() -> None:
    g = greeks(CALL, [np.nan, -1.0, 25500.0, 25500.0], [25500.0, 25500.0, 0.0, np.nan], 0.02, 0.15, 0.0)
    for name in ("price", "delta", "gamma", "vega", "theta", "rho", "vanna", "charm", "vomma", "veta"):
        assert np.isnan(getattr(g, name)).all(), name
    h = higher_order(CALL, [np.nan, 25500.0], 25500.0, 0.02, 0.15, 0.0)
    assert np.isnan(h.speed[0]) and h.unavailable[0] and np.isfinite(h.speed[1])


def test_deep_wings_stay_finite_and_zero_not_nan() -> None:
    g = greeks(CALL, F0, [60000.0, 1.0], 0.01, 0.15, R0)
    assert np.isfinite(g.delta).all() and g.gamma[0] == 0.0 and g.vega[0] == 0.0 and g.delta[1] == pytest.approx(math.exp(-R0 * 0.01), abs=1e-12)


# ------------------------------------------------------------------ units and rupees, by hand
def test_units_and_rupee_terms_by_hand() -> None:
    f, k, t, s, r = 25500.0, 25500.0, 3 / 365, 0.15, 0.0
    g = greeks(CALL, f, k, t, s, r)
    h = higher_order(CALL, f, k, t, s, r)
    vol = s * math.sqrt(t)
    d1 = 0.5 * vol
    phi = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
    delta = n_ref(d1)
    vega = f * phi * math.sqrt(t)  # per 1.00 of volatility
    theta_year = -f * phi * s / (2 * math.sqrt(t))  # r = 0
    sc = scale(g, h, GreeksConfig(day_count=365.0, trading_hours_per_day=6.5))
    assert float(sc.delta) == pytest.approx(delta, abs=1e-12) and float(sc.vega) == pytest.approx(vega / 100.0, rel=1e-12)
    assert float(sc.theta_day) == pytest.approx(theta_year / 365.0, rel=1e-12) and float(sc.theta_hour) == pytest.approx(theta_year / 365.0 / 24.0, rel=1e-12)
    assert float(sc.theta_trading_hour) == pytest.approx(theta_year / 365.0 / 6.5, rel=1e-12)
    price = f * (n_ref(d1) - n_ref(-d1))  # at the money with r = 0: F (N(d1) - N(d2)), d2 = -d1
    assert float(sc.rho) == pytest.approx(-t * price / 100.0, rel=1e-12)  # rho = -T V is not zero even at r = 0: the discount factor still moves with the rate; about 0.0114 rupees per 1 % for a unit
    assert float(sc.vanna) == pytest.approx(float(g.vanna) / 100.0, rel=1e-15)
    assert float(sc.vomma) == pytest.approx(float(g.vomma) / 1e4, rel=1e-15) and float(sc.ultima) == pytest.approx(float(h.ultima) / 1e6, rel=1e-15)
    # a short position of 2 lots of 65: every rupee Greek is the scaled Greek times -130
    rp = in_rupees(sc, f, 65, -2)
    assert float(rp.delta) == pytest.approx(-130.0 * delta, rel=1e-12)
    assert float(rp.vega) == pytest.approx(-130.0 * vega / 100.0, rel=1e-12)  # rupees per volatility point
    assert float(rp.theta_day) == pytest.approx(-130.0 * theta_year / 365.0, rel=1e-12) and float(rp.theta_day) > 0  # a short option earns time decay
    assert float(rp.gamma_pnl_1pct) == pytest.approx(-130.0 * 0.5 * float(g.gamma) * (255.0) ** 2, rel=1e-12)  # 1 % of 25,500 is 255 points
    long = in_rupees(sc, f, 65, 3)
    assert float(long.delta) == pytest.approx(195.0 * delta, rel=1e-12) and float(long.theta_day) < 0


# ------------------------------------------------------------------ properties
forwards = st.floats(min_value=500.0, max_value=60_000.0)
moneyness = st.floats(min_value=0.6, max_value=1.6)
years = st.floats(min_value=1.0 / 365.0 / 24.0, max_value=3.0)
vols = st.floats(min_value=0.02, max_value=3.0)
rates = st.floats(min_value=-0.01, max_value=0.12)
SETTINGS = settings(max_examples=300, deadline=None)


@SETTINGS
@given(f=forwards, m=moneyness, t=years, s=vols, r=rates, cp=st.sampled_from([CALL, PUT]))
def test_signs_bounds_and_finiteness(f: float, m: float, t: float, s: float, r: float, cp: float) -> None:
    g = greeks(cp, f, f * m, t, s, r)
    df = math.exp(-r * t)
    for name in ("price", "delta", "gamma", "vega", "theta", "rho", "vanna", "charm", "vomma", "veta"):
        assert math.isfinite(float(getattr(g, name))), name
    assert float(g.gamma) >= 0.0 and float(g.vega) >= 0.0 and float(g.vomma) * 0.0 == 0.0
    assert -df - 1e-12 <= float(g.delta) <= df + 1e-12
    assert (float(g.delta) >= -1e-12) == (cp == CALL) or abs(float(g.delta)) < 1e-12  # a call's delta is not negative, a put's is not positive
    assert float(g.rho) <= 1e-9 * (1.0 + float(g.price))  # rho = -T V is not positive


@SETTINGS
@given(f=forwards, m=moneyness, t=years, s=vols, r=rates)
def test_put_call_delta_and_theta_relations_hold_everywhere(f: float, m: float, t: float, s: float, r: float) -> None:
    k = f * m
    c, p = greeks(CALL, f, k, t, s, r), greeks(PUT, f, k, t, s, r)
    df = math.exp(-r * t)
    assert float(c.delta - p.delta) == pytest.approx(df, abs=1e-10)
    assert float(c.theta - p.theta) == pytest.approx(r * df * (f - k), rel=1e-9, abs=1e-7 * max(f, k))
    assert float(c.gamma) == pytest.approx(float(p.gamma), rel=1e-9, abs=1e-15) and float(c.vega) == pytest.approx(float(p.vega), rel=1e-9, abs=1e-12)


# ------------------------------------------------------------------ speed (reported with the checkpoint; the limits here are generous)
def test_a_whole_chain_of_greeks_is_fast() -> None:
    k = np.arange(20500.0, 30500.1, 50.0)  # 201 strikes
    s = 0.15 + 0.4 * np.log(k / F0) ** 2
    t0 = time.perf_counter()
    for _ in range(20):
        greeks(CALL, F0, k, 3 / 365, s, R0)
        greeks(PUT, F0, k, 3 / 365, s, R0)
    analytic_ms = (time.perf_counter() - t0) * 1000 / 20  # 402 options
    t1 = time.perf_counter()
    for _ in range(5):
        higher_order(CALL, F0, k, 3 / 365, s, R0)
        higher_order(PUT, F0, k, 3 / 365, s, R0)
    bump_ms = (time.perf_counter() - t1) * 1000 / 5
    assert analytic_ms < 40.0 and bump_ms < 400.0
