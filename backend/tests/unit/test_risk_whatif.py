"""What-If engine (app/risk/whatif.py): the zero scenario is exactly zero, the P&L of small shocks agrees with the Greeks, an independent re-computation of every scenario, the three sticky rules, the expiry
instant, grids, the payoff at expiry, presets, and the performance targets (single 10-leg scenario under 5 ms, 21 x 21 grid under 200 ms).

The surface is built from option prices of a known SVI smile, so the volatility of every strike is known independently of the engine.
"""

from __future__ import annotations

import math
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pytest

from app.risk.greeks import greeks
from app.risk.ivsurface import ExpiryInput, SurfaceSnapshot, build_surface
from app.risk.pricing import CALL, PUT, black76, years_between
from app.risk.svi import SVIParams
from app.risk.whatif import (
    STICKY_RULES,
    Leg,
    Scenario,
    WhatIfConfig,
    WhatIfEngine,
    expiry_instant,
    presets_for,
)
from tests.unit.test_risk_ivsurface import smile_quotes

pytestmark = pytest.mark.filterwarnings("error::RuntimeWarning")  # a NumPy warning (invalid value, overflow, divide) is a failure; unrelated warnings from other tests (unclosed databases) are not
IST = ZoneInfo("Asia/Kolkata")
NOW = datetime(2026, 11, 20, 11, 0, tzinfo=IST)
R = 0.065
P1 = SVIParams(1.0e-4, 1.5e-3, -0.35, 0.002, 0.015)
P2 = SVIParams(4.0e-4, 3.0e-3, -0.35, 0.002, 0.03)
E1, E2 = "2026-11-23", "2026-11-30"
INST = {E1: expiry_instant(E1, (15, 40)), E2: expiry_instant(E2, (15, 40))}
T1, T2 = years_between(NOW, INST[E1]), years_between(NOW, INST[E2])
HPY = 24.0 * 365.0


@pytest.fixture(scope="module")
def surface() -> SurfaceSnapshot:
    return build_surface([ExpiryInput(E1, T1, R, smile_quotes(T1, P1), None), ExpiryInput(E2, T2, R, smile_quotes(T2, P2), None)], NOW)


def ten_legs() -> list[Leg]:
    return [
        Leg(E1, 25500.0, CALL, -2, 65, 140.0), Leg(E1, 25500.0, PUT, -2, 65, 130.0), Leg(E1, 25800.0, CALL, 2, 65, 20.0), Leg(E1, 25200.0, PUT, 2, 65, 25.0),
        Leg(E2, 25500.0, CALL, 1, 65), Leg(E2, 25500.0, PUT, 1, 65), Leg(E1, 25600.0, CALL, -1, 65), Leg(E1, 25400.0, PUT, -1, 65),
        Leg(E2, 25700.0, CALL, -1, 65), Leg(E2, 25300.0, PUT, -1, 65),
    ]  # fmt: skip


@pytest.fixture(scope="module")
def engine(surface: SurfaceSnapshot) -> WhatIfEngine:
    return WhatIfEngine(surface, ten_legs(), INST)


def svi_vol(surface: SurfaceSnapshot, expiry: str, k: float) -> float:
    s = surface.slice(expiry)
    assert s.params is not None
    return float(s.params.implied_vol(k, s.t_years))


# ------------------------------------------------------------------ the zero scenario
@pytest.mark.parametrize("rule", STICKY_RULES)
def test_the_zero_scenario_returns_exactly_zero_for_every_rule(engine: WhatIfEngine, rule: str) -> None:
    res = engine.run(Scenario(sticky_rule=rule))
    assert res.pnl == 0.0 and res.partial_pnl == 0.0 and all(leg.pnl == 0.0 and leg.new_value == leg.base_value and leg.new_iv == leg.base_iv for leg in res.legs)
    assert res.warnings == () and res.surface_version_id == engine.surface.version_id and res.as_of_ist == "2026-11-20T11:00:00+05:30"
    g = engine.grid_spot_iv(rule=rule)
    assert g.pnl[10, 10] == 0.0  # the centre of the default grid: no spot move, no volatility move
    gt = engine.grid_spot_time(rule=rule)
    assert gt.pnl[10, 0] == 0.0  # no spot move at hour zero


def test_the_zero_scenario_is_zero_with_a_nonzero_rate_and_other_expiry_sets(surface: SurfaceSnapshot) -> None:
    only_far = WhatIfEngine(surface, [Leg(E2, 25500.0, CALL, -3, 65)], INST)
    assert only_far.run(Scenario()).pnl == 0.0
    assert only_far.run(Scenario(rate_shock=0.0)).pnl == 0.0
    assert WhatIfEngine(surface, [], INST).run(Scenario()).pnl == 0.0  # no legs: nothing to lose or gain
    assert abs(only_far.run(Scenario(spot_shock=1e-9)).pnl) < 1e-5  # and a vanishing shock a vanishing P&L: the engine is continuous at zero


# ------------------------------------------------------------------ independent recomputation
def test_a_scenario_equals_an_independent_repricing_by_the_formulas(surface: SurfaceSnapshot, engine: WhatIfEngine) -> None:
    ds, dv, hours, dr = 180.0, 3.0, 20.0, 0.002
    res = engine.run(Scenario(spot_shock=ds, iv_shock=dv, time_elapsed_hours=hours, rate_shock=dr))
    total = 0.0
    for leg, r in zip(ten_legs(), res.legs, strict=True):
        sl = surface.slice(leg.expiry)
        t0 = years_between(NOW, INST[leg.expiry])
        base_vol = svi_vol(surface, leg.expiry, math.log(leg.strike / sl.forward))
        base = float(black76(leg.cp, sl.forward, leg.strike, t0, base_vol, sl.rate))
        vol = svi_vol(surface, leg.expiry, math.log(leg.strike / (sl.forward + ds))) + dv / 100.0  # sticky moneyness, then the parallel shock
        new = float(black76(leg.cp, sl.forward + ds, leg.strike, t0 - hours / HPY, vol, sl.rate + dr))
        want = leg.quantity * leg.lot_size * (new - base)
        total += want
        assert r.pnl == pytest.approx(want, rel=1e-9, abs=1e-9) and r.new_iv == pytest.approx(vol, abs=1e-12) and r.base_iv == pytest.approx(base_vol, abs=1e-12)
        if leg.entry_price is not None:
            assert r.pnl_vs_entry == pytest.approx(leg.quantity * leg.lot_size * (new - leg.entry_price), rel=1e-9)
        else:
            assert r.pnl_vs_entry is None
    assert res.pnl == pytest.approx(total, rel=1e-9) and res.pnl == pytest.approx(sum(r.pnl for r in res.legs), rel=1e-12)
    assert res.forward_after[E1] == pytest.approx(surface.slice(E1).forward + ds, abs=1e-9)
    assert res.t_years_after[E1] == pytest.approx(T1 - hours / HPY, rel=1e-12)


# ------------------------------------------------------------------ small shocks against the Greeks
def position_greeks(surface: SurfaceSnapshot, legs: list[Leg]):  # type: ignore[no-untyped-def]
    out = []
    for leg in legs:
        sl = surface.slice(leg.expiry)
        t0 = years_between(NOW, INST[leg.expiry])
        vol = svi_vol(surface, leg.expiry, math.log(leg.strike / sl.forward))
        out.append((leg, greeks(leg.cp, sl.forward, leg.strike, t0, vol, sl.rate)))
    return out


def test_small_shocks_agree_with_the_greeks(surface: SurfaceSnapshot, engine: WhatIfEngine) -> None:
    pg = position_greeks(surface, ten_legs())
    m = [leg.quantity * leg.lot_size for leg, _ in pg]
    ds = 0.4  # points; sticky strike so the volatility does not move with the spot
    want = sum(mm * (float(g.delta) * ds + 0.5 * float(g.gamma) * ds * ds) for mm, (_, g) in zip(m, pg, strict=True))
    assert engine.run(Scenario(spot_shock=ds, sticky_rule="strike")).pnl == pytest.approx(want, rel=1e-5)
    dv = 0.05  # volatility points (a small shock: the third-order term ultima dv^3 / 6 is about 1e-4 of the first-order one at 0.3)
    want = sum(mm * (float(g.vega) * dv / 100.0 + 0.5 * float(g.vomma) * (dv / 100.0) ** 2) for mm, (_, g) in zip(m, pg, strict=True))
    assert engine.run(Scenario(iv_shock=dv)).pnl == pytest.approx(want, rel=1e-5)
    hours = 0.02  # small: the second-order term of a time step is about dt / (4 T) of theta dt, 7e-5 here
    want = sum(mm * float(g.theta) * hours / HPY for mm, (_, g) in zip(m, pg, strict=True))  # theta is dV/dt per year
    assert engine.run(Scenario(time_elapsed_hours=hours)).pnl == pytest.approx(want, rel=5e-4)
    dr = 1e-4
    want = sum(mm * float(g.rho) * dr for mm, (_, g) in zip(m, pg, strict=True))
    assert engine.run(Scenario(rate_shock=dr)).pnl == pytest.approx(want, rel=1e-3)


def test_signs_and_scaling_of_the_position(surface: SurfaceSnapshot) -> None:
    long_leg, short_leg, three = Leg(E1, 25500.0, CALL, 1, 65), Leg(E1, 25500.0, CALL, -1, 65), Leg(E1, 25500.0, CALL, 3, 65)
    sc = Scenario(spot_shock=120.0, iv_shock=2.0, time_elapsed_hours=6.0)
    lo, sh, th = (WhatIfEngine(surface, [x], INST).run(sc).pnl for x in (long_leg, short_leg, three))
    assert sh == pytest.approx(-lo, rel=1e-12) and th == pytest.approx(3.0 * lo, rel=1e-12) and lo > 0  # a long call gains from a rally
    odd_lot = WhatIfEngine(surface, [Leg(E1, 25500.0, CALL, 1, 130)], INST).run(sc).pnl
    assert odd_lot == pytest.approx(2.0 * lo, rel=1e-12)  # the lot size multiplies
    assert WhatIfEngine(surface, [Leg(E1, 25500.0, CALL, 0, 65)], INST).run(sc).pnl == 0.0


# ------------------------------------------------------------------ sticky rules
def test_sticky_strike_keeps_each_strikes_volatility_and_moneyness_moves_the_smile_with_the_spot(surface: SurfaceSnapshot, engine: WhatIfEngine) -> None:
    ds = 200.0
    keep = engine.run(Scenario(spot_shock=ds, sticky_rule="strike"))
    move = engine.run(Scenario(spot_shock=ds, sticky_rule="moneyness"))
    for a, b in zip(keep.legs, move.legs, strict=True):
        assert a.new_iv == a.base_iv  # exactly the volatility the strike had
        want = svi_vol(surface, a.expiry, math.log(a.strike / (surface.slice(a.expiry).forward + ds)))
        assert b.new_iv == pytest.approx(want, abs=1e-12)
    atm = next(i for i, leg in enumerate(ten_legs()) if leg.expiry == E1 and leg.strike == 25500.0)
    assert move.legs[atm].new_iv > keep.legs[atm].new_iv  # the smile slopes down with the strike: after a rally the 25,500 strike is relatively lower and its volatility is higher


def test_sticky_delta_holds_the_smile_as_a_function_of_delta(surface: SurfaceSnapshot, engine: WhatIfEngine) -> None:
    for ds in (-600.0, -150.0, 150.0, 600.0):
        res = engine.run(Scenario(spot_shock=ds, sticky_rule="delta"))
        for leg, r in zip(ten_legs(), res.legs, strict=True):
            sl = surface.slice(leg.expiry)
            assert sl.params is not None
            t = sl.t_years
            d1 = (math.log((sl.forward + ds) / leg.strike) + 0.5 * r.new_iv**2 * t) / (r.new_iv * math.sqrt(t))
            target = 0.5 * math.erfc(-d1 / math.sqrt(2.0))  # the call delta of the shocked option at its new volatility, at the surface's maturity
            lo, hi = -0.8, 0.8  # find the moneyness on the base smile that has this delta (delta falls as the moneyness rises)
            for _ in range(80):
                mid = 0.5 * (lo + hi)
                v = float(sl.params.implied_vol(mid, t))
                delta = 0.5 * math.erfc(-((-mid + 0.5 * v * v * t) / (v * math.sqrt(t))) / math.sqrt(2.0))
                lo, hi = (mid, hi) if delta > target else (lo, mid)
            assert r.new_iv == pytest.approx(float(sl.params.implied_vol(0.5 * (lo + hi), t)), abs=1e-7), (ds, leg.strike)
    # with no time elapsed the delta rule IS the moneyness rule (the same maturity and volatility give the same moneyness); once time elapses they differ
    for ds_ in (-600.0, -150.0, 150.0, 600.0):  # inside the fitted range
        same = engine.run(Scenario(spot_shock=ds_, sticky_rule="delta")), engine.run(Scenario(spot_shock=ds_, sticky_rule="moneyness"))
        assert max(abs(a.new_iv - b.new_iv) for a, b in zip(same[0].legs, same[1].legs, strict=True)) < 1e-9
    # beyond the fitted strikes the delta rule holds the volatility flat at the edge of the data; the moneyness rule extrapolates the SVI curve
    far = engine.run(Scenario(spot_shock=-1200.0, sticky_rule="delta"))
    far_m = engine.run(Scenario(spot_shock=-1200.0, sticky_rule="moneyness"))
    sl1 = surface.slice(E1)
    assert sl1.params is not None
    used_k = [math.log(x.strike / sl1.forward) for x in surface.strikes if x.expiry == E1 and x.status == "used"]
    edge_vol = float(sl1.params.implied_vol(max(used_k) + engine.cfg.delta_range_pad, sl1.t_years))
    idx = next(i for i, leg in enumerate(ten_legs()) if leg.expiry == E1 and leg.strike == 25800.0)  # k' = ln(25800 / 24300) = 0.0599, past the edge of 0.0382 + 0.02
    assert far.legs[idx].new_iv == pytest.approx(edge_vol, abs=1e-9) and far_m.legs[idx].new_iv != pytest.approx(edge_vol, abs=1e-6)
    d = engine.run(Scenario(spot_shock=-300.0, time_elapsed_hours=48.0, sticky_rule="delta"))
    m = engine.run(Scenario(spot_shock=-300.0, time_elapsed_hours=48.0, sticky_rule="moneyness"))
    assert max(abs(a.new_iv - b.new_iv) for a, b in zip(d.legs, m.legs, strict=True)) > 2e-3
    t_after = T1 - 48.0 / HPY  # the delta rule's own relation, now at the shortened maturity: N(d1) of the shocked option equals N(d1) of the base smile at the volatility read
    sl = surface.slice(E1)
    assert sl.params is not None
    for leg, r in zip(ten_legs(), d.legs, strict=True):
        if leg.expiry != E1 or abs(leg.strike - 25500.0) > 1.0:
            continue
        d1 = (math.log((sl.forward - 300.0) / leg.strike) + 0.5 * r.new_iv**2 * t_after) / (r.new_iv * math.sqrt(t_after))
        k_star = float(np.interp(0.5 * math.erfc(-d1 / math.sqrt(2.0)), *(lambda kk: (0.5 * np.vectorize(math.erfc)(-((-kk + 0.5 * sl.params.implied_vol(kk, sl.t_years) ** 2 * sl.t_years) / (sl.params.implied_vol(kk, sl.t_years) * math.sqrt(sl.t_years))) / math.sqrt(2.0)), kk))(np.linspace(0.04, -0.04, 4001))[::1]))
        assert r.new_iv == pytest.approx(float(sl.params.implied_vol(k_star, sl.t_years)), abs=2e-5)


def test_time_alone_changes_value_through_the_expiry_only_except_under_sticky_delta(engine: WhatIfEngine) -> None:
    for rule in ("moneyness", "strike"):
        res = engine.run(Scenario(time_elapsed_hours=12.0, sticky_rule=rule))
        assert all(r.new_iv == r.base_iv for r in res.legs)  # the annualised smile is unchanged: time acts through T alone
    assert engine.run(Scenario(time_elapsed_hours=12.0, sticky_rule="moneyness")).pnl == engine.run(Scenario(time_elapsed_hours=12.0, sticky_rule="strike")).pnl
    delta = engine.run(Scenario(time_elapsed_hours=12.0, sticky_rule="delta"))
    assert any(abs(r.new_iv - r.base_iv) > 1e-5 for r in delta.legs)  # under sticky delta the strikes drift in delta terms as time passes, so their volatilities move
    assert max(abs(r.new_iv - r.base_iv) for r in delta.legs) < 0.01  # a little, over twelve hours of three days


def test_a_parallel_volatility_shock_is_exactly_that_many_points_and_the_rule_name_is_checked(engine: WhatIfEngine) -> None:
    res = engine.run(Scenario(iv_shock=5.0))
    assert all(r.new_iv - r.base_iv == pytest.approx(0.05, abs=1e-15) for r in res.legs)
    with pytest.raises(ValueError):
        engine.run(Scenario(sticky_rule="sticky-magic"))
    with pytest.raises(ValueError):
        WhatIfEngine(engine.surface, [], INST, cfg=WhatIfConfig(default_sticky="nonsense"))
    assert engine.run(Scenario(spot_shock=100.0, sticky_rule="")).pnl == engine.run(Scenario(spot_shock=100.0, sticky_rule="moneyness")).pnl  # an empty rule means the configured default


# ------------------------------------------------------------------ the expiry instant
def test_time_to_expiry_is_measured_to_the_session_close_not_to_midnight() -> None:
    expiry_day = datetime(2026, 11, 23, 11, 0, tzinfo=IST)
    inst = expiry_instant("2026-11-23", (15, 40))
    assert years_between(expiry_day, inst) == pytest.approx(16800.0 / 31_536_000.0, rel=1e-15)  # 4 h 40 min = 16,800 s
    midnight_bug = datetime(2026, 11, 24, 0, 0, tzinfo=IST)
    assert years_between(expiry_day, midnight_bug) == pytest.approx(46800.0 / 31_536_000.0, rel=1e-15)  # 13 h: what a midnight expiry would give
    assert years_between(expiry_day, expiry_instant("2026-11-23", (15, 45))) == pytest.approx(17100.0 / 31_536_000.0, rel=1e-15)  # the close from 7 December 2026 is 15:45: 4 h 45 min = 17,100 s


def test_on_the_expiry_day_time_runs_out_at_the_close_and_the_last_second_is_intrinsic() -> None:
    day = datetime(2026, 11, 23, 11, 0, tzinfo=IST)
    inst = {E1: expiry_instant(E1, (15, 40))}
    t = years_between(day, inst[E1])
    p = SVIParams(6e-6, 1.5e-4, -0.3, 0.0, 0.01)  # a smile for a contract with 4 h 40 min left
    snap = build_surface([ExpiryInput(E1, t, R, smile_quotes(t, p, np.arange(25200.0, 25800.1, 25.0)), None)], day)
    assert snap.slices[0].params is not None
    straddle = [Leg(E1, 25500.0, CALL, -1, 65), Leg(E1, 25500.0, PUT, -1, 65)]  # a short straddle
    eng = WhatIfEngine(snap, straddle, inst, as_of=day)
    assert eng.t0[0] == pytest.approx(16800.0 / 31_536_000.0, rel=1e-12)
    assert eng.hours_to_nearest_expiry() == pytest.approx(4.0 + 40.0 / 60.0, abs=1e-9)
    premium = 65.0 * float(np.sum(eng.value0))
    assert premium > 0
    at_close = eng.run(Scenario(time_elapsed_hours=eng.hours_to_nearest_expiry()))  # the clock reaches the expiry instant exactly: intrinsic
    assert at_close.pnl == pytest.approx(premium, rel=1e-9)  # the spot did not move: the whole premium is kept (value 0 for a straddle struck at the forward)
    at_close_plus = eng.run(Scenario(time_elapsed_hours=eng.hours_to_nearest_expiry() + 1.0))  # an hour past the close: still intrinsic, no NaN
    assert at_close_plus.pnl == pytest.approx(premium, rel=1e-9)
    one_second = eng.run(Scenario(time_elapsed_hours=eng.hours_to_nearest_expiry() - 1.5 / 3600.0))  # 1.5 s left: priced by the model, a few rupees of premium remain
    assert 0.0 < premium - one_second.pnl < 0.02 * premium
    assert eng.payoff_at_expiry([0.0]).pnl[0, 0] == pytest.approx(premium, rel=1e-9)


# ------------------------------------------------------------------ grids
def test_the_default_grid_is_21_by_21_spans_two_standard_deviations_and_matches_single_scenarios(engine: WhatIfEngine) -> None:
    g = engine.grid_spot_iv()
    assert g.pnl.shape == (21, 21) and g.col_kind == "iv_points" and len(g.row_axis) == 21 and len(g.col_axis) == 21
    f, vol, t = engine.nearest_atm() or (0, 0, 0)
    half = 2.0 * f * vol * math.sqrt(t)  # two standard deviations of the nearest expiry, in points
    assert g.row_axis[0] == pytest.approx(-half, rel=1e-12) and g.row_axis[-1] == pytest.approx(half, rel=1e-12) and g.row_axis[10] == pytest.approx(0.0, abs=1e-9)
    assert g.col_axis[0] == -10.0 and g.col_axis[-1] == 10.0
    assert g.surface_version_id == engine.surface.version_id and g.as_of_ist.endswith("+05:30")
    for i, j in ((0, 0), (3, 17), (10, 10), (20, 20), (7, 2)):
        single = engine.run(Scenario(spot_shock=g.row_axis[i], iv_shock=g.col_axis[j]))
        assert g.pnl[i, j] == pytest.approx(single.pnl, rel=1e-9, abs=1e-6)


def test_the_spot_by_time_grid_and_the_payoff_at_expiry(surface: SurfaceSnapshot) -> None:
    straddle = WhatIfEngine(surface, [Leg(E1, 25500.0, CALL, -1, 65), Leg(E1, 25500.0, PUT, -1, 65)], INST)
    g = straddle.grid_spot_time()
    assert g.col_kind == "hours" and g.pnl.shape == (21, 21) and g.col_axis[0] == 0.0 and g.col_axis[-1] == pytest.approx(straddle.hours_to_nearest_expiry(), rel=1e-12)
    centre = g.pnl[10]  # no spot move: a short straddle earns time decay all the way to the expiry
    assert centre[0] == 0.0 and all(b >= a - 1e-9 for a, b in zip(centre, centre[1:], strict=False)) and centre[-1] == pytest.approx(65.0 * float(np.sum(straddle.value0)), rel=1e-9)
    # a vertical call spread (long 25,500, short 25,600) paid at expiry against its value now: intrinsic 0 below, 100 above, less the current value
    spread = WhatIfEngine(surface, [Leg(E1, 25500.0, CALL, 1, 65), Leg(E1, 25600.0, CALL, -1, 65)], INST)
    now_value = 65.0 * (spread.value0[0] - spread.value0[1])
    f0 = surface.slice(E1).forward
    pay = spread.payoff_at_expiry([-400.0, 0.0, 100.0, 300.0]).pnl[:, 0]
    k1, k2 = 25500.0, 25600.0
    want = [65.0 * (max(f0 + d - k1, 0.0) - max(f0 + d - k2, 0.0)) - now_value for d in (-400.0, 0.0, 100.0, 300.0)]
    assert pay == pytest.approx(want, rel=1e-9, abs=1e-6)
    assert pay[0] == pytest.approx(-now_value, rel=1e-9) and pay[3] == pytest.approx(65.0 * 100.0 - now_value, rel=1e-9)  # below both strikes the spread is lost; above both it is worth 100 a unit


def test_a_position_that_cannot_be_valued_has_no_total_and_says_why(surface: SurfaceSnapshot) -> None:
    legs = [Leg(E1, 25500.0, CALL, -1, 65), Leg("2030-01-01", 25500.0, CALL, 1, 65), Leg(E2, 25500.0, PUT, 1, 65)]
    eng = WhatIfEngine(surface, legs, {**INST, "2030-01-01": expiry_instant("2030-01-01", (15, 40))})
    res = eng.run(Scenario(spot_shock=100.0))
    assert math.isnan(res.pnl) and res.legs[1].status == "expiry not on the surface" and math.isnan(res.legs[1].pnl)
    assert res.partial_pnl == pytest.approx(res.legs[0].pnl + res.legs[2].pnl, rel=1e-12) and len(res.warnings) == 1 and "2030-01-01" in res.warnings[0]
    assert np.isnan(eng.grid_spot_iv().pnl).all() and eng.grid_spot_iv().warnings == res.warnings
    no_instant = WhatIfEngine(surface, [Leg(E1, 25500.0, CALL, 1, 65)], {})
    assert no_instant.run(Scenario()).legs[0].status == "no expiry instant"
    crash = WhatIfEngine(surface, [Leg(E1, 25500.0, CALL, 1, 65)], INST).run(Scenario(spot_shock=-30000.0))
    assert math.isnan(crash.pnl)  # a forward below zero has no price


# ------------------------------------------------------------------ presets
def test_presets_by_hand(engine: WhatIfEngine) -> None:
    f, vol, t = 25500.0, 0.15, 3.0 / 365.0
    p = presets_for(f, vol, t, 76.0)
    assert p["gap_down"].spot_shock == pytest.approx(-510.0, abs=1e-9)  # 2 % of 25,500
    assert p["iv_spike"].iv_shock == 5.0 and p["iv_spike"].spot_shock == 0.0
    sd = 25500.0 * 0.15 * math.sqrt(3.0 / 365.0)  # = 25500 * 0.15 * 0.090660 = 346.8 points
    assert sd == pytest.approx(346.8, abs=0.05)
    assert p["sd_plus_1"].spot_shock == pytest.approx(sd, rel=1e-12) and p["sd_minus_2"].spot_shock == pytest.approx(-2.0 * sd, rel=1e-12)
    assert p["expiry_crush"].iv_shock == -4.0 and p["expiry_crush"].time_elapsed_hours == pytest.approx(75.0, abs=1e-12)  # 76 hours left: the clock moves to one hour before the expiry instant
    assert presets_for(f, vol, t, 0.5)["expiry_crush"].time_elapsed_hours == 0.0  # never negative
    assert set(p) == {"gap_down", "iv_spike", "expiry_crush", "expiry_minus_3h", "expiry_minus_1h", "expiry_minus_15m", "sd_plus_1", "sd_minus_1", "sd_plus_2", "sd_minus_2"}
    assert p["expiry_minus_3h"].time_elapsed_hours == pytest.approx(73.0, abs=1e-12) and p["expiry_minus_15m"].time_elapsed_hours == pytest.approx(75.75, abs=1e-12)  # 76 h left minus 3 h / minus 15 min
    assert p["expiry_minus_1h"].iv_shock == 0.0 and p["expiry_minus_1h"].spot_shock == 0.0  # the clock alone
    near = presets_for(f, vol, t, 2.0)  # 2 h left: the 3 h step is already past, so it is not offered
    assert "expiry_minus_3h" not in near and near["expiry_minus_1h"].time_elapsed_hours == pytest.approx(1.0, abs=1e-12)
    assert presets_for(f, vol, t, 76.0, WhatIfConfig(gap_down_pct=3.0, iv_spike_pts=8.0), rule="strike")["gap_down"].spot_shock == pytest.approx(-765.0, abs=1e-9)  # configurable
    assert presets_for(f, vol, t, 76.0, rule="strike")["iv_spike"].sticky_rule == "strike"
    for name, sc in engine.presets().items():
        assert math.isfinite(engine.run(sc).pnl), name
    assert engine.presets()["gap_down"].spot_shock < 0 and engine.run(engine.presets()["iv_spike"]).pnl != 0.0
    assert WhatIfEngine(engine.surface, [Leg("2030-01-01", 1.0, CALL, 1, 65)], INST).presets() == {}


# ------------------------------------------------------------------ determinism and speed
def test_the_same_surface_and_scenario_always_give_the_same_result(surface: SurfaceSnapshot) -> None:
    sc = Scenario(spot_shock=137.0, iv_shock=-1.5, time_elapsed_hours=9.0, sticky_rule="delta")
    a = WhatIfEngine(surface, ten_legs(), INST).run(sc)
    b = WhatIfEngine(surface, ten_legs(), INST).run(sc)
    assert a == b and a.surface_version_id == surface.version_id


def test_the_performance_targets(engine: WhatIfEngine) -> None:
    sc = Scenario(spot_shock=150.0, iv_shock=2.0, time_elapsed_hours=24.0)
    engine.run(sc)
    t0 = time.perf_counter()
    for _ in range(50):
        engine.run(sc)
    single_ms = (time.perf_counter() - t0) * 1000 / 50  # a 10-leg scenario with the per-leg breakdown
    worst_grid = 0.0
    for rule in STICKY_RULES:
        t1 = time.perf_counter()
        engine.grid_spot_iv(rule=rule)
        worst_grid = max(worst_grid, (time.perf_counter() - t1) * 1000)
    assert single_ms < 5.0 and worst_grid < 200.0
