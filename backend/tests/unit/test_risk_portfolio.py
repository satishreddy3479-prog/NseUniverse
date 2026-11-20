"""Portfolio risk (app/risk/portfolio.py, cache.py): net Greeks in raw and rupee terms checked against hand-worked positions, beta weighting, expiry buckets, configured limits and their breach flags,
missing legs, and the LRU cache. Surfaces are built from option prices of known SVI smiles; the expected numbers come from closed forms written out in the test.
"""

from __future__ import annotations

import dataclasses
import math
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.risk.cache import LruCache
from app.risk.ivsurface import ExpiryInput, SurfaceSnapshot, build_surface
from app.risk.portfolio import LimitSet, PortfolioConfig, PortfolioRiskEngine
from app.risk.pricing import CALL, PUT, years_between
from app.risk.svi import SVIParams
from app.risk.whatif import Leg, expiry_instant
from tests.unit.test_risk_ivsurface import smile_quotes

pytestmark = pytest.mark.filterwarnings("error")
IST = ZoneInfo("Asia/Kolkata")
NOW = datetime(2026, 11, 20, 11, 0, tzinfo=IST)
R = 0.065
P = {"2026-11-23": SVIParams(1.0e-4, 1.5e-3, -0.35, 0.002, 0.015), "2026-11-30": SVIParams(4.0e-4, 3.0e-3, -0.35, 0.002, 0.03), "2026-12-29": SVIParams(1.5e-3, 6.0e-3, -0.35, 0.002, 0.06)}
E1, E2, E3 = "2026-11-23", "2026-11-30", "2026-12-29"
INST = {e: expiry_instant(e, (15, 40)) for e in P}
TT = {e: years_between(NOW, INST[e]) for e in P}
LOT = 65


@pytest.fixture(scope="module")
def surface() -> SurfaceSnapshot:
    return build_surface([ExpiryInput(e, TT[e], R, smile_quotes(TT[e], P[e]), None) for e in P], NOW)


def n(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def leg_closed_form(surface: SurfaceSnapshot, leg: Leg) -> dict[str, float]:
    """Per-unit Greeks of a leg at the surface's own volatility, from the formulas written out here (scalar math, not the module's code)."""
    sl = surface.slice(leg.expiry)
    assert sl.params is not None
    f, t, r = sl.forward, TT[leg.expiry], sl.rate
    k = math.log(leg.strike / f)
    sigma = float(sl.params.implied_vol(k, sl.t_years))
    vol = sigma * math.sqrt(t)
    d1 = (math.log(f / leg.strike) + 0.5 * sigma * sigma * t) / vol
    d2 = d1 - vol
    df = math.exp(-r * t)
    phi = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
    price = df * (f * n(d1) - leg.strike * n(d2)) if leg.cp > 0 else df * (leg.strike * n(-d2) - f * n(-d1))
    return {
        "delta": leg.cp * df * n(leg.cp * d1), "gamma": df * phi / (f * vol), "vega": df * f * phi * math.sqrt(t),
        "theta": -df * f * phi * sigma / (2 * math.sqrt(t)) + r * price, "rho": -t * price, "price": price, "df": df, "forward": f,
    }  # fmt: skip


def run(surface: SurfaceSnapshot, legs: list[Leg], cfg: PortfolioConfig | None = None, **kw):  # type: ignore[no-untyped-def]
    return PortfolioRiskEngine(cfg or PortfolioConfig()).aggregate(surface, legs, INST, **kw)


# ------------------------------------------------------------------ hand-worked positions
def test_a_short_call_in_raw_and_rupee_terms_by_hand(surface: SurfaceSnapshot) -> None:
    leg = Leg(E1, 25500.0, CALL, -2, LOT)  # short two lots: multiplier -130
    g = leg_closed_form(surface, leg)
    m = -2 * LOT
    res = run(surface, [leg])
    assert res.complete and res.warnings == ()
    r, w = res.net.raw, res.net.rupee
    assert r["delta"] == pytest.approx(m * g["delta"], rel=1e-9) and r["gamma"] == pytest.approx(m * g["gamma"], rel=1e-9)
    assert r["vega"] == pytest.approx(m * g["vega"], rel=1e-9) and r["theta"] == pytest.approx(m * g["theta"], rel=1e-9) and r["rho"] == pytest.approx(m * g["rho"], rel=1e-9)
    assert w["delta"] == pytest.approx(m * g["delta"], rel=1e-9)  # delta in units is rupees per point: one rupee a unit
    assert w["gamma"] == pytest.approx(m * g["gamma"], rel=1e-9)
    assert w["vega"] == pytest.approx(m * g["vega"] / 100.0, rel=1e-9)  # rupees per volatility point
    assert w["theta_day"] == pytest.approx(m * g["theta"] / 365.0, rel=1e-9) and w["theta_day"] > 0  # a short option earns decay
    assert w["theta_hour"] == pytest.approx(w["theta_day"] / 24.0, rel=1e-12) and w["theta_trading_hour"] == pytest.approx(w["theta_day"] / 6.416666666666667, rel=1e-12)
    assert w["rho"] == pytest.approx(m * g["rho"] / 100.0, rel=1e-9)
    assert w["gamma_pnl_1pct"] == pytest.approx(0.5 * m * g["gamma"] * (0.01 * g["forward"]) ** 2, rel=1e-9)
    assert res.net.raw == res.partial_net.raw and res.legs[0].status == "ok" and res.legs[0].rupee["delta"] == w["delta"]
    long = run(surface, [dataclasses.replace(leg, quantity=2)])
    assert long.net.rupee["delta"] == pytest.approx(-w["delta"], rel=1e-12) and long.net.rupee["theta_day"] == pytest.approx(-w["theta_day"], rel=1e-12)


def test_a_synthetic_forward_nets_to_the_discount_factor_and_the_carry(surface: SurfaceSnapshot) -> None:
    long_call, short_put = Leg(E1, 25500.0, CALL, 1, LOT), Leg(E1, 25500.0, PUT, -1, LOT)
    c, p = leg_closed_form(surface, long_call), leg_closed_form(surface, short_put)
    res = run(surface, [long_call, short_put])
    df, f = c["df"], c["forward"]
    assert res.net.raw["delta"] == pytest.approx(LOT * df, rel=1e-9)  # call delta less put delta is the discount factor
    assert abs(res.net.raw["gamma"]) < 1e-9 * abs(LOT * c["gamma"]) + 1e-12 and abs(res.net.raw["vega"]) < 1e-6 * abs(LOT * c["vega"])  # the same curvature and vega on both sides cancel
    assert res.net.raw["theta"] == pytest.approx(LOT * R * df * (f - 25500.0), rel=1e-6, abs=1e-6)  # theta of a forward: r df (F - K), a few rupees at most
    assert res.net.raw["rho"] == pytest.approx(-LOT * TT[E1] * df * (f - 25500.0), rel=1e-6, abs=1e-9)
    assert p["delta"] == pytest.approx(c["delta"] - df, rel=1e-9)  # the two legs' own deltas


def test_the_net_is_the_sum_of_the_legs_and_of_the_buckets(surface: SurfaceSnapshot) -> None:
    legs = [Leg(E1, 25500.0, CALL, -2, LOT), Leg(E1, 25500.0, PUT, -2, LOT), Leg(E1, 25800.0, CALL, 2, LOT), Leg(E2, 25300.0, PUT, 1, LOT), Leg(E3, 25500.0, CALL, 1, LOT), Leg(E3, 25100.0, PUT, -1, LOT)]
    res = run(surface, legs)
    for name in res.net.rupee:
        assert res.net.rupee[name] == pytest.approx(sum(lg.rupee[name] for lg in res.legs), rel=1e-9, abs=1e-9), name
        assert res.net.rupee[name] == pytest.approx(sum(b.net.rupee[name] for b in res.buckets), rel=1e-9, abs=1e-9), name
    for name in res.net.raw:
        assert res.net.raw[name] == pytest.approx(sum(b.net.raw[name] for b in res.buckets), rel=1e-9, abs=1e-9), name
    assert [(b.label, b.expiry, b.n_legs) for b in res.buckets] == [("front", E1, 3), ("next", E2, 1), ("later", E3, 2)]
    assert res.buckets[0].hours_to_expiry == pytest.approx(TT[E1] * 8760.0, rel=1e-12) and res.buckets[0].hours_to_expiry < res.buckets[1].hours_to_expiry < res.buckets[2].hours_to_expiry
    assert res.surface_version_id == surface.version_id and res.as_of_ist == "2026-11-20T11:00:00+05:30"


def test_third_order_nets_are_sums_and_go_missing_when_switched_off(surface: SurfaceSnapshot) -> None:
    legs = [Leg(E1, 25500.0, CALL, -1, LOT), Leg(E1, 25400.0, PUT, -1, LOT), Leg(E2, 25600.0, CALL, 1, LOT)]
    res = run(surface, legs)
    for name in ("speed", "color", "zomma", "ultima"):
        assert math.isfinite(res.net.rupee[name]) and res.net.rupee[name] == pytest.approx(sum(lg.rupee[name] for lg in res.legs), rel=1e-9, abs=1e-12), name
    off = run(surface, legs, PortfolioConfig(third_order=False))
    assert all(math.isnan(off.net.rupee[k]) and math.isnan(off.net.raw[k]) for k in ("speed", "color", "zomma", "ultima"))
    assert math.isfinite(off.net.rupee["delta"]) and off.net.rupee["delta"] == pytest.approx(res.net.rupee["delta"], rel=1e-12)  # the rest is unchanged


# ------------------------------------------------------------------ beta weighting
def test_beta_weighting_is_one_for_nifty_options_and_configurable(surface: SurfaceSnapshot) -> None:
    legs = [Leg(E1, 25500.0, CALL, 3, LOT), Leg(E1, 25300.0, PUT, -1, LOT)]
    base = run(surface, legs)
    assert base.beta == 1.0 and base.beta_source == "config" and base.beta_weighted_delta_units == pytest.approx(base.net.raw["delta"], rel=1e-12)
    assert base.beta_weighted_delta_rupees == pytest.approx(base.net.rupee["delta"], rel=1e-12)
    assert base.delta_rupees_per_1pct == pytest.approx(base.net.raw["delta"] * surface.slice(E1).forward * 0.01, rel=1e-12)
    heavy = run(surface, legs, PortfolioConfig(beta={"NIFTY": 1.1}))
    assert heavy.beta == 1.1 and heavy.beta_weighted_delta_rupees == pytest.approx(1.1 * base.net.rupee["delta"], rel=1e-12)
    hooked = run(surface, legs, beta_provider=lambda u: 0.9 if u == "NIFTY" else None)
    assert hooked.beta == 0.9 and hooked.beta_source == "provider" and hooked.beta_weighted_delta_units == pytest.approx(0.9 * base.net.raw["delta"], rel=1e-12)
    silent = run(surface, legs, beta_provider=lambda u: None)
    assert silent.beta == 1.0 and silent.beta_source == "config"  # the provider has nothing: the configuration answers
    other = run(surface, legs, underlying="BANKNIFTY")
    assert other.beta == 1.0 and other.beta_source == "default" and any("no beta for BANKNIFTY" in w for w in other.warnings)  # documented fallback, with a warning


# ------------------------------------------------------------------ limits
def test_leg_limits_warn_at_eighty_percent_and_breach_above_the_limit(surface: SurfaceSnapshot) -> None:
    legs = [Leg(E1, 25500.0, CALL, -2, LOT), Leg(E1, 25800.0, CALL, 1, LOT)]
    d0 = abs(run(surface, legs).legs[0].rupee["delta"])  # the big leg: about 65 rupees a point per delta unit, two lots short
    breach = run(surface, legs, PortfolioConfig(leg=LimitSet(delta=0.9 * d0)))
    top = breach.breaches[0]
    assert (top.scope, top.metric, top.level, top.partial) == ("leg", "delta", "breach", False) and top.scope_id == f"{E1} 25500 CE"
    assert top.limit == pytest.approx(0.9 * d0) and top.utilisation == pytest.approx(1.0 / 0.9, rel=1e-9) and top.value == pytest.approx(-d0, rel=1e-9)  # a short call: negative delta
    warn = run(surface, legs, PortfolioConfig(leg=LimitSet(delta=1.1 * d0)))
    assert [(b.level, b.scope_id) for b in warn.breaches if b.metric == "delta"] == [("warn", f"{E1} 25500 CE")]  # 0.909 of the limit: at or above 0.8
    quiet = run(surface, legs, PortfolioConfig(leg=LimitSet(delta=2.0 * d0)))
    assert [b for b in quiet.breaches if b.metric == "delta"] == []  # half the limit
    exact = run(surface, legs, PortfolioConfig(leg=LimitSet(delta=d0)))
    assert [b.level for b in exact.breaches if b.metric == "delta"] == ["warn"]  # exactly at the limit is not above it
    assert run(surface, legs, PortfolioConfig()).breaches == ()  # no limits configured: nothing is checked
    qty = run(surface, legs, PortfolioConfig(leg=LimitSet(quantity=1.5)))
    assert [(b.scope_id, b.metric, b.value) for b in qty.breaches] == [(f"{E1} 25500 CE", "quantity", -2.0)]  # two lots against a limit of 1.5


def test_portfolio_and_bucket_limits_and_the_theta_floor(surface: SurfaceSnapshot) -> None:
    short = [Leg(E1, 25500.0, CALL, -2, LOT), Leg(E1, 25500.0, PUT, -2, LOT), Leg(E2, 25500.0, CALL, -1, LOT), Leg(E2, 25500.0, PUT, -1, LOT)]
    base = run(surface, short)
    vega = base.net.rupee["vega"]
    assert vega < 0 and base.net.rupee["theta_day"] > 0
    res = run(surface, short, PortfolioConfig(portfolio=LimitSet(vega=abs(vega) / 2.0, theta_day=1.0), bucket=LimitSet(vega=abs(base.buckets[0].net.rupee["vega"]) * 0.99)))
    kinds = {(b.scope, b.metric, b.level) for b in res.breaches}
    assert ("portfolio", "vega", "breach") in kinds and ("bucket", "vega", "breach") in kinds
    assert not any(b.metric == "theta_day" for b in res.breaches)  # positive theta (decay earned) is never limited
    longs = [dataclasses.replace(lg, quantity=-lg.quantity) for lg in short]
    paid = run(surface, longs).net.rupee["theta_day"]
    assert paid < 0
    tight = run(surface, longs, PortfolioConfig(portfolio=LimitSet(theta_day=abs(paid) / 2.0)))
    b = next(x for x in tight.breaches if x.metric == "theta_day")
    assert b.level == "breach" and b.utilisation == pytest.approx(2.0, rel=1e-9) and b.value == pytest.approx(paid)  # decay paid is twice the floor
    loose = run(surface, longs, PortfolioConfig(portfolio=LimitSet(theta_day=abs(paid) * 3.0)))
    assert not any(x.metric == "theta_day" and x.level == "breach" for x in loose.breaches)
    half = abs(base.beta_weighted_delta_rupees) / 2.0
    assert half > 0.0
    bw = [x for x in run(surface, short, PortfolioConfig(beta_weighted_delta=half)).breaches if x.metric == "beta_weighted_delta"]
    assert len(bw) == 1 and bw[0].scope == "portfolio" and bw[0].level == "breach" and bw[0].utilisation == pytest.approx(2.0, rel=1e-9) and bw[0].value == pytest.approx(base.beta_weighted_delta_rupees)
    beta_heavy = [x for x in run(surface, short, PortfolioConfig(beta_weighted_delta=abs(base.beta_weighted_delta_rupees) * 1.05, beta={"NIFTY": 1.2})).breaches if x.metric == "beta_weighted_delta"]
    assert len(beta_heavy) == 1 and beta_heavy[0].value == pytest.approx(1.2 * base.net.rupee["delta"], rel=1e-9)  # the limit applies to the beta-weighted delta, not the plain one
    ordered = [x.utilisation for x in res.breaches]
    assert ordered == sorted(ordered, reverse=True)  # worst first


def test_the_config_is_validated_so_a_typo_cannot_disable_a_limit() -> None:
    ok = PortfolioConfig.from_mapping({"leg": {"delta": 5000, "vega": None}, "portfolio": {"gamma": 40.5, "theta_day": 8000}, "bucket": {"delta": 2000}, "beta_weighted_delta": 9000,
                                       "warn_fraction": 0.7, "beta": {"NIFTY": 1.05}, "third_order": False, "cache_size": 100})  # fmt: skip
    assert ok.leg == LimitSet(delta=5000.0) and ok.portfolio == LimitSet(gamma=40.5, theta_day=8000.0) and ok.bucket.delta == 2000.0 and ok.beta_weighted_delta == 9000.0
    assert ok.warn_fraction == 0.7 and dict(ok.beta) == {"NIFTY": 1.05} and ok.third_order is False and ok.cache_size == 100
    assert PortfolioConfig.from_mapping({}) == PortfolioConfig()  # an empty configuration is the default, with no limits
    for bad in ({"legs": {}}, {"leg": {"dellta": 1}}, {"leg": {"delta": -5}}, {"portfolio": {"vega": float("nan")}}, {"warn_fraction": 0.0}, {"warn_fraction": 1.5}, {"beta": 1.0}, {"beta_weighted_delta": -1}, {"leg": 5}):
        with pytest.raises(ValueError):
            PortfolioConfig.from_mapping(bad)


# ------------------------------------------------------------------ legs that cannot be valued
def test_a_leg_that_cannot_be_valued_leaves_the_total_missing_and_limits_say_so(surface: SurfaceSnapshot) -> None:
    ok_leg = Leg(E1, 25500.0, CALL, -2, LOT)
    legs = [ok_leg, Leg("2031-01-01", 25500.0, CALL, 1, LOT), Leg(E2, 25500.0, PUT, 1, LOT)]
    engine = PortfolioRiskEngine(PortfolioConfig(portfolio=LimitSet(vega=1.0)))
    res = engine.aggregate(surface, legs, {**INST, "2031-01-01": expiry_instant("2031-01-01", (15, 40))})
    assert not res.complete and all(math.isnan(v) for v in res.net.rupee.values()) and all(math.isnan(v) for v in res.net.raw.values())
    assert res.legs[1].status == "expiry not on the surface" and math.isnan(res.legs[1].iv) and math.isnan(res.legs[1].rupee["delta"])
    assert res.partial_net.rupee["delta"] == pytest.approx(res.legs[0].rupee["delta"] + res.legs[2].rupee["delta"], rel=1e-12)
    assert math.isnan(res.beta_weighted_delta_rupees) and math.isnan(res.delta_rupees_per_1pct) and len(res.warnings) == 1 and "2031-01-01" in res.warnings[0]
    b = next(x for x in res.breaches if x.scope == "portfolio" and x.metric == "vega")
    assert b.partial  # checked on the two legs that could be valued, and flagged as such
    assert [bk.label for bk in res.buckets] == ["front", "next"]  # buckets of the legs that were valued
    empty = run(surface, [])
    assert empty.complete and empty.net.rupee["delta"] == 0.0 and empty.buckets == () and empty.breaches == ()


# ------------------------------------------------------------------ the cache
def test_the_lru_cache_evicts_the_least_recently_used_and_counts() -> None:
    c: LruCache[str, int] = LruCache(2)
    c.put("a", 1)
    c.put("b", 2)
    assert c.get("a") == 1  # a is now the most recent
    c.put("c", 3)  # evicts b
    assert c.get("b") is None and c.get("a") == 1 and c.get("c") == 3 and len(c) == 2
    s = c.stats()
    assert (s.size, s.max_size, s.hits, s.misses, s.evictions) == (2, 2, 3, 1, 1)
    with pytest.raises(ValueError):
        LruCache(0)


def test_leg_greeks_are_cached_per_surface_version_and_never_served_for_another(surface: SurfaceSnapshot) -> None:
    legs = [Leg(E1, 25500.0, CALL, -2, LOT), Leg(E1, 25500.0, PUT, -2, LOT), Leg(E2, 25700.0, CALL, 1, LOT)]
    eng = PortfolioRiskEngine()
    first = eng.aggregate(surface, legs, INST)
    assert (first.cache.hits, first.cache.misses, first.cache.size) == (0, 3, 3)
    again = eng.aggregate(surface, legs, INST)
    assert again.cache.hits == 3 and again.cache.misses == 3 and again.net == first.net and again.legs == first.legs  # served from the cache, identical
    resized = eng.aggregate(surface, [dataclasses.replace(legs[0], quantity=-6)], INST)  # another quantity of the same contract: the per-unit Greeks are shared
    assert resized.cache.hits == 4 and resized.net.rupee["delta"] == pytest.approx(3.0 * first.legs[0].rupee["delta"], rel=1e-12)
    moved = build_surface([ExpiryInput(e, TT[e], R, smile_quotes(TT[e], P[e]), 25490.0) for e in P], NOW, seq=2)  # a different forward: a new surface version
    assert moved.version_id != surface.version_id
    other = eng.aggregate(moved, legs, INST)
    assert other.cache.misses == 3 + 3 and other.net.rupee["delta"] != first.net.rupee["delta"]  # no stale entry was served
    later = eng.aggregate(surface, legs, INST, as_of=datetime(2026, 11, 20, 12, 0, tzinfo=IST))  # an hour later: a different key, a new time to expiry
    assert later.cache.misses == 3 + 3 + 3 and later.net.rupee["theta_day"] != first.net.rupee["theta_day"]
    fresh = PortfolioRiskEngine().aggregate(surface, legs, INST)
    assert fresh.net == first.net  # the cache changes speed, never numbers


def test_aggregation_is_fast_and_repeatable(surface: SurfaceSnapshot) -> None:
    legs = [Leg(E1 if i % 2 == 0 else E2, 25000.0 + 50.0 * i, CALL if i % 3 else PUT, (-1) ** i * (1 + i % 3), LOT) for i in range(20)]
    eng = PortfolioRiskEngine()
    t0 = time.perf_counter()
    cold = eng.aggregate(surface, legs, INST)
    cold_ms = (time.perf_counter() - t0) * 1000
    t1 = time.perf_counter()
    for _ in range(20):
        warm = eng.aggregate(surface, legs, INST)
    warm_ms = (time.perf_counter() - t1) * 1000 / 20
    assert cold_ms < 100.0 and warm_ms < 30.0 and warm.net == cold.net
