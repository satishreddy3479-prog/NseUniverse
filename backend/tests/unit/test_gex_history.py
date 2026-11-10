# ruff: noqa: E501
"""Server-side GEX reconstruction against hand calculations and an independent brute-force scan (same numbers as the browser tests)."""

from __future__ import annotations

import math
from dataclasses import dataclass

import pytest

from app.intraday import gex_history as g
from app.intraday import volatility as vm


@dataclass
class C:
    oi: int | None


def rows_and_chain(spot: float, strikes: list[float], sigma: float, t: float, ce_oi: dict[float, int | None], pe_oi: dict[float, int | None], r: float = 0.0):
    rows, chain = [], {}
    for k in strikes:
        for side, name, oi in ((0, "CE", ce_oi.get(k)), (1, "PE", pe_oi.get(k))):
            rows.append({"strike": k, "side": name, "iv": sigma * 100})
            chain[(k, side)] = C(oi)
    return rows, chain


def test_gex_at_the_money_matches_the_browser_hand_calculation() -> None:
    # 20 % vol, 0.1 year, no carry or rate, spot 24000, OI 1,000,000 each side: gamma 2.6269e-4, GEX 151.31 crore (see gamma-analysis-lib.test.ts)
    gam = g.spot_gamma(24000, 1.0, 24000, 0.1, 0.2, 0.0)
    assert gam == pytest.approx(2.6269e-4, abs=1e-7)
    assert g.exposure(gam, 1_000_000, 24000) == pytest.approx(151.31, abs=0.05)
    rows, chain = rows_and_chain(24000, [24000.0], 0.2, 0.1, {24000.0: 1_000_000}, {24000.0: 1_000_000})
    lv = g.levels(g.contracts_of(rows, chain), 24000, 1.0, 0.1, 0.0)
    assert lv["ce"] == pytest.approx(151.31, abs=0.05) and lv["pe"] == pytest.approx(-151.31, abs=0.05)
    assert abs(lv["net"]) < 0.05 and lv["abs"] == pytest.approx(302.6, abs=0.1)  # equal OI cancels; absolute adds


def test_oi_is_in_units_so_the_lot_size_is_never_applied_again() -> None:
    a = g.exposure(2.6269e-4, 1_000_000, 24000)
    assert a is not None and a * 65 != pytest.approx(a)  # a 65-fold figure would be what a second lot multiplication produces
    assert g.exposure(2.6269e-4, 1_000_000, 24000) == pytest.approx(151.31, abs=0.05)


def test_missing_oi_or_iv_gives_no_exposure_and_is_counted_not_zeroed() -> None:
    rows, chain = rows_and_chain(24000, [24000.0, 24100.0], 0.2, 0.1, {24000.0: 1_000_000, 24100.0: None}, {24000.0: None, 24100.0: 500_000})
    rows[3]["iv"] = None  # 24100 PE has no solved volatility
    out = g.reconstruct(rows, chain, 24000, 24000, 0.1, 0.0, 24000, 5)
    full = out["universes"]["full"]
    assert out["missing"] == {"contracts": 4, "no_iv": 1, "no_oi": 2}
    assert full["net"] is None and full["used"] == 0 and full["excluded"] == 2  # no strike has both sides: no net, not a half sum
    assert full["ce"] == pytest.approx(151.31, abs=0.05) and full["pe"] is None


def test_walls_peak_and_universes_by_strike() -> None:
    strikes = [23800.0, 23900.0, 24000.0, 24100.0, 24200.0, 24300.0]
    ce = {23800.0: 100_000, 23900.0: 200_000, 24000.0: 500_000, 24100.0: 900_000, 24200.0: 300_000, 24300.0: 100_000}
    pe = {23800.0: 700_000, 23900.0: 800_000, 24000.0: 400_000, 24100.0: 100_000, 24200.0: 50_000, 24300.0: 10_000}
    rows, chain = rows_and_chain(24000, strikes, 0.2, 0.05, ce, pe)
    out = g.reconstruct(rows, chain, 24000, 24000, 0.05, 0.0, 24200, 1)
    full, dyn, fixed = out["universes"]["full"], out["universes"]["dynamic"], out["universes"]["fixed"]
    assert full["call_wall"] == 24100.0  # biggest call OI at or above spot (gamma is similar across these strikes; OI decides)
    assert full["put_wall"] == 23900.0  # at or below spot: 23900 holds the most put GEX
    assert dyn["strikes"] == 3 and fixed["strikes"] == 3 and full["strikes"] == 6  # spot 24000 +-1 and opening ATM 24200 +-1
    assert fixed["call_wall"] == 24100.0 and fixed["put_wall"] is None  # fixed set 24100..24300: all above spot 24000, so no put wall exists in it
    assert out["universes"]["dynamic"]["strikes"] + 3 == 6


def test_gamma_flip_is_where_net_gex_changes_sign_checked_by_independent_scan() -> None:
    # call OI heavy above spot, put OI heavy below: net GEX is positive above the cross-over and negative below (or the reverse); find it by scanning
    strikes = [float(k) for k in range(23600, 24500, 100)]
    ce = {k: (900_000 if k >= 24200 else 50_000) for k in strikes}
    pe = {k: (900_000 if k <= 23800 else 50_000) for k in strikes}
    rows, chain = rows_and_chain(24000, strikes, 0.18, 0.04, {float(k): v for k, v in ce.items()}, {float(k): v for k, v in pe.items()})
    cs = g.contracts_of(rows, chain)
    flip = g.gamma_flip(cs, 24000, 1.0, 0.04, 0.0)
    scan = [(24000 * (0.92 + 0.16 * i / 4000), g.net_at(cs, 24000 * (0.92 + 0.16 * i / 4000), 1.0, 0.04, 0.0)) for i in range(4001)]
    crossings = [a for (a, va), (_, vb) in zip(scan, scan[1:], strict=False) if va is not None and vb is not None and (va < 0) != (vb < 0)]
    if crossings:
        assert flip is not None
        nearest = min(crossings, key=lambda x: abs(x - 24000))
        assert flip == pytest.approx(nearest, abs=24000 * 0.16 / 4000 + 1)
        assert abs(g.net_at(cs, flip, 1.0, 0.04, 0.0) or 0) < 0.05 * max(abs(v) for _, v in scan if v is not None)
    else:
        assert flip is None


def test_no_crossing_means_no_flip() -> None:
    rows, chain = rows_and_chain(24000, [24000.0, 24100.0], 0.2, 0.1, {24000.0: 1_000_000, 24100.0: 1_000_000}, {24000.0: None, 24100.0: None})
    assert g.gamma_flip(g.contracts_of(rows, chain), 24000, 1.0, 0.1, 0.0) is None  # calls only: net GEX never changes sign


def test_surface_rows_feed_the_reconstruction() -> None:
    f, t, r = 24010.0, 0.05, 0.06
    prices = {}
    for k in range(23700, 24400, 100):
        for side in (0, 1):
            prices[(float(k), side)] = vm.price(side, f, float(k), t, 0.17, r)
    from datetime import UTC, datetime, timedelta

    from app.domain.session import session_close

    exp = (datetime(2026, 11, 3, tzinfo=UTC)).date()
    now = datetime.combine(exp, session_close(), vm.IST) - timedelta(days=t * 365)
    sf = vm.surface(prices, 24000.0, exp, now, r, 50)
    assert sf["status"] == "ok"
    chain = {key: C(1_000_000) for key in prices}
    out = g.reconstruct(sf["rows"], chain, 24000.0, sf["forward"], sf["time_to_expiry_days"] / 365.0, r, 24000.0, 2)
    assert out["missing"]["no_iv"] == 0 and out["universes"]["full"]["used"] == 7
    assert math.isfinite(out["universes"]["dynamic"]["net"])


def test_the_fast_re_pricing_equals_the_direct_per_contract_formula() -> None:
    strikes = [float(k) for k in range(23600, 24500, 100)]
    ce = {k: 100_000 * (1 + i) for i, k in enumerate(strikes)}
    pe = {k: 100_000 * (10 - i) for i, k in enumerate(strikes)}
    rows, chain = rows_and_chain(24000, strikes, 0.19, 0.03, ce, pe, r=0.06)
    cs = g.contracts_of(rows, chain)
    q, t, r = 1.002, 0.03, 0.06
    for s in (23500.0, 23950.0, 24000.0, 24333.0):
        direct = 0.0
        for c in cs:
            e = g.exposure(g.spot_gamma(s, q, c["strike"], t, c["iv"], r), c["oi"], s)
            direct += e if c["side"] == "CE" else -e
        assert g.net_at(cs, s, q, t, r) == pytest.approx(direct, rel=1e-9)
