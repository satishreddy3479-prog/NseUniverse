"""The safeguarded Newton solver returns the same volatility as plain bisection, and still refuses prices no volatility reproduces."""

from __future__ import annotations

import math

import pytest

from app.intraday import volatility as vm


def bisect(side: int, mkt: float, f: float, k: float, t: float, r: float) -> float:
    lo, hi = 1e-4, vm.MAX_IV
    for _ in range(100):
        mid = (lo + hi) / 2
        if vm.price(side, f, k, t, mid, r) < mkt:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-8:
            break
    return (lo + hi) / 2


@pytest.mark.parametrize("side", [vm.CALL, vm.PUT])
@pytest.mark.parametrize("sigma", [0.05, 0.12, 0.2, 0.45, 1.1])
@pytest.mark.parametrize("moneyness", [0.9, 0.97, 1.0, 1.03, 1.1])
@pytest.mark.parametrize("t", [0.003, 0.02, 0.1, 0.5])
def test_agrees_with_bisection_across_the_surface(side: int, sigma: float, moneyness: float, t: float) -> None:
    f, k, r = 24000.0, 24000.0 * moneyness, 0.06
    px = vm.price(side, f, k, t, sigma, r)
    got = vm.implied_vol(side, px, f, k, t, r)
    if got is None:  # a price at or below intrinsic cannot be inverted: the solver says so instead of guessing
        assert px <= math.exp(-r * t) * (max(f - k, 0) if side == vm.CALL else max(k - f, 0)) + 1e-6
        return
    assert got == pytest.approx(bisect(side, px, f, k, t, r), abs=1e-6)  # plain bisection is itself only good to a few 1e-7 where the price hardly depends on volatility
    assert got == pytest.approx(sigma, abs=1e-4) or px < 1e-3  # a price this small barely identifies the volatility


def test_still_refuses_what_it_refused_before() -> None:
    assert vm.implied_vol(vm.CALL, 0.0, 24000, 24000, 0.1) is None
    assert vm.implied_vol(vm.CALL, 5.0, 24000, 23000, 0.1) is None  # below intrinsic
    assert vm.implied_vol(vm.CALL, 1e9, 24000, 24000, 0.1) is None  # above the model ceiling
    assert vm.implied_vol(vm.CALL, 100.0, 24000, 24000, 0.0) is None
