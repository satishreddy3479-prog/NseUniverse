"""The Greeks and What-If API (app/api/risk_routes.py, app/risk/service.py): version and time stamps on every response, input validation, valid JSON (a missing number is null), the numbers equal to the engine
called directly, the surface rebuilt only when quotes change, live books preferred over last prices, limits from configuration, and a bad configuration answered with 503 instead of silence.

Chains are synthetic but exact: option prices generated from known SVI smiles, stored in the app's own snapshot store, so the right answers are known.
"""

from __future__ import annotations

import json
import math
import time
from collections.abc import Iterator
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.domain.models import (
    Completeness,
    DataSource,
    ExpiryKind,
    OptionChainRow,
    OptionChainSnapshot,
    OptionQuote,
)
from app.risk.pricing import CALL, PUT, black76, years_between
from app.risk.svi import SVIParams
from app.risk.whatif import Leg, Scenario, WhatIfEngine
from app.stream.models import LiveTick
from tests.conftest import make_app

IST = ZoneInfo("Asia/Kolkata")
NOW = datetime(2026, 10, 28, 5, 30, tzinfo=UTC)  # 11:00 IST, a Wednesday
E1, E2 = "2026-11-03", "2026-11-23"  # the weekly and monthly expiry the replay broker reports
SMILE = {E1: SVIParams(1.0e-4, 1.5e-3, -0.35, 0.002, 0.015), E2: SVIParams(1.5e-3, 6.0e-3, -0.35, 0.002, 0.06)}
F, R, LOT = 25500.0, 0.06, 65


def instant(expiry: str) -> datetime:
    return datetime(*(int(x) for x in expiry.split("-")), 15, 40, tzinfo=IST)  # the schedule's F&O close in force on these dates


def chain(expiry: str, at: datetime, *, sid: str, bump: float = 0.0, strikes: np.ndarray | None = None, tokens: bool = True) -> OptionChainSnapshot:
    t = years_between(at, instant(expiry))
    p = SMILE[expiry]
    rows = []
    for k in np.arange(24500.0, 26500.1, 50.0) if strikes is None else strikes:
        vol = float(p.implied_vol(math.log(k / F), t))
        qs = []
        for cp, side in ((CALL, "CE"), (PUT, "PE")):
            px = round(float(black76(cp, F, float(k), t, vol, R)) + bump, 2)
            qs.append(
                OptionQuote(
                    exchange_segment="nse_fo" if tokens else None, instrument_token=f"{expiry[-2:]}{int(k)}{side}" if tokens else None, trading_symbol=None, option_type=side, ltp=px, open=None, high=None,
                    low=None, prev_close=None, close=None, volume=100.0, oi=1000.0, oi_previous=900.0, oi_change=100.0, oi_change_pct=None, moneyness=None,
                )
            )  # fmt: skip
        rows.append(OptionChainRow(strike=float(k), call=qs[0], put=qs[1]))
    return OptionChainSnapshot(
        snapshot_id=sid, session_id="s1", underlying="NIFTY", expiry=date.fromisoformat(expiry), expiry_kinds=[ExpiryKind.WEEKLY], source=DataSource.SNAPSHOT, retrieved_at=at, lot_size=LOT, multiplier=1,
        requested_strike_count=len(rows), completeness=Completeness.COMPLETE, rows=rows, ce_count=len(rows), pe_count=len(rows), underlying_ltp=F,
    )  # fmt: skip


@pytest.fixture()
def client(tmp_path: Path) -> Iterator[tuple[TestClient, Any]]:
    app = make_app(tmp_path)
    with TestClient(app) as c:
        app.state.risk._clock = lambda: NOW  # noqa: SLF001 - a fixed clock: the surface and the expiry instants are reproducible
        for e in (E1, E2):
            app.state.store.save(chain(e, NOW, sid=f"snap-{e}"), {})
        yield c, app


def strict(text: str) -> Any:
    """Parse JSON refusing the NaN and Infinity tokens Python would accept."""

    def refuse(x: str) -> None:
        raise AssertionError(f"invalid JSON token {x}")

    return json.loads(text, parse_constant=refuse)


def get(c: TestClient, url: str, **kw: Any) -> Any:
    r = c.get(url, **kw)
    assert r.status_code == 200, r.text
    return strict(r.text)


def post(c: TestClient, url: str, body: dict[str, Any], status: int = 200) -> Any:
    r = c.post(url, json=body)
    assert r.status_code == status, r.text
    return strict(r.text)


def leg(expiry: str, strike: float, type_: str, action: str, lots: int, entry: float | None = None) -> dict[str, Any]:
    return {"expiry": expiry, "strike": strike, "type": type_, "action": action, "lots": lots, "entry_price": entry}


STRADDLE = [leg(E1, 25500.0, "CE", "SELL", 2, 140.0), leg(E1, 25500.0, "PE", "SELL", 2, 130.0), leg(E1, 25800.0, "CE", "BUY", 2), leg(E1, 25200.0, "PE", "BUY", 2), leg(E2, 25500.0, "CE", "BUY", 1)]


# ------------------------------------------------------------------ stamps, status, configuration
def test_every_response_carries_the_surface_version_and_the_time(client: tuple[TestClient, Any]) -> None:
    c, _ = client
    bodies = [
        get(c, "/api/risk/surface"), get(c, f"/api/risk/chain-greeks?expiry={E1}"), post(c, "/api/risk/scenario", {"legs": STRADDLE, "scenario": {"spot_shock": 100}}),
        post(c, "/api/risk/grid", {"legs": STRADDLE}), post(c, "/api/risk/portfolio", {"legs": STRADDLE}), post(c, "/api/risk/presets", {"legs": STRADDLE}),
    ]  # fmt: skip
    ids = {b["surface_version_id"] for b in bodies}
    assert len(ids) == 1 and next(iter(ids)).startswith("v1-") and len(next(iter(ids))) == len("v1-") + 12
    for b in bodies:
        assert b["as_of_ist"] == "2026-10-28T11:00:00+05:30" and b["source"] == "stored" and b["stale"] is False
        assert {d["expiry"] for d in b["data"]} >= {E1} and all(d["lot_size"] == LOT and d["status"] == "ok" for d in b["data"])
    st = get(c, "/api/risk/status")
    assert st["enabled"] and st["config_error"] is None and st["surface_version_id"] == next(iter(ids)) and st["rebuilds"] == 1 and st["sticky_rules"] == ["moneyness", "strike", "delta"]


def test_the_surface_is_rebuilt_only_when_quotes_change(client: tuple[TestClient, Any]) -> None:
    c, app = client
    first = get(c, "/api/risk/surface")["surface_version_id"]
    for _ in range(3):
        assert get(c, "/api/risk/surface")["surface_version_id"] == first  # polling again changes nothing
    assert app.state.risk.rebuilds == 1
    app.state.store.save(chain(E1, NOW, sid="snap-moved", bump=1.5), {})  # every price a rupee and a half higher: more than ten quotes changed
    second = get(c, "/api/risk/surface")["surface_version_id"]
    assert second != first and second.startswith("v2-") and app.state.risk.rebuilds == 2


def test_a_stored_chain_older_than_the_threshold_is_reported_stale(client: tuple[TestClient, Any]) -> None:
    c, app = client
    app.state.risk._clock = lambda: datetime(2026, 10, 28, 9, 30, tzinfo=UTC)  # four hours after the chain was stored  # noqa: SLF001
    b = get(c, "/api/risk/surface")
    assert b["stale"] is True and b["source"] == "stored" and b["data"][0]["age_s"] == pytest.approx(4 * 3600.0)
    assert b["as_of_ist"] == "2026-10-28T11:00:00+05:30"  # the surface is as of the chain's own time: prices and clock stay consistent


def test_the_engine_can_be_switched_off_and_a_bad_limit_configuration_says_so(tmp_path: Path) -> None:
    off = make_app(tmp_path / "off", greeks_enabled=False)
    with TestClient(off) as c:
        r = c.get("/api/risk/status")
        assert r.status_code == 404 and r.json()["detail"]["code"] == "disabled"
    bad = make_app(tmp_path / "bad", greeks_limits_json='{"leg": {"dellta": 5}}')
    with TestClient(bad) as c:
        st = get(c, "/api/risk/status")
        assert "dellta" in st["config_error"]  # the application started; the engine says why it will not answer
        r = c.get("/api/risk/surface")
        assert r.status_code == 503 and r.json()["detail"]["code"] == "config_error"
        assert c.post("/api/risk/portfolio", json={"legs": STRADDLE}).status_code == 503


# ------------------------------------------------------------------ the surface
def test_the_surface_endpoint_returns_fits_residuals_and_reasons(client: tuple[TestClient, Any]) -> None:
    c, _ = client
    b = get(c, f"/api/risk/surface?expiry={E1}")
    assert [s["expiry"] for s in b["slices"]] == [E1] and all(x["expiry"] == E1 for x in b["strikes"])
    s = b["slices"][0]
    assert s["forward"] == pytest.approx(F, abs=0.1) and s["forward_source"].startswith("parity") and s["degraded"] is False and s["butterfly_ok"] and s["calendar_ok"]
    assert s["params"]["rho"] == pytest.approx(-0.35, abs=0.02) and s["rms_vol_pts"] < 0.1
    used = [x for x in b["strikes"] if x["status"] == "used"]
    assert used and all(abs(x["residual_vol_pts"]) < 0.2 and x["source"] == "ltp" and x["weight"] == 0.5 for x in used)  # stored chains carry last prices only: labelled, half weight
    rejected = [x for x in b["strikes"] if x["status"] == "rejected"]
    assert all(x["iv"] is None and x["reason"] for x in rejected) or rejected == []  # a missing volatility is null, with its reason
    both = get(c, f"/api/risk/surface?expiry={E1}&expiry={E2}")
    assert {s["expiry"] for s in both["slices"]} == {E1, E2} and both["surface_version_id"].startswith("v2-")  # asking for another expiry rebuilds once, to cover it
    default = get(c, "/api/risk/surface")  # the weekly and the monthly the broker reports
    assert {s["expiry"] for s in default["slices"]} == {E1, E2}


def test_a_live_book_is_preferred_to_the_stored_last_price_and_a_stale_tick_is_not(client: tuple[TestClient, Any]) -> None:
    c, app = client
    t = years_between(NOW, instant(E1))
    vol = float(SMILE[E1].implied_vol(0.0, t))
    mid = float(black76(CALL, F, 25500.0, t, vol, R))

    def tick(token: str, at: datetime, bid: float, ask: float) -> LiveTick:
        return LiveTick(key=f"nse_fo|{token}", kind="scrip", exchange_segment="nse_fo", instrument_token=token, ltp=mid, bid=bid, ask=ask, received_at=at, seq=1, source="live")

    app.state.stream.book.update(tick(f"{E1[-2:]}25500CE", NOW, mid - 0.5, mid + 0.5))
    b = get(c, f"/api/risk/surface?expiry={E1}")
    atm = next(x for x in b["strikes"] if x["strike"] == 25500.0 and x["cp"] == 1.0)
    assert b["source"] == "live" and b["data"][0]["live_books"] == 1 and atm["source"] == "mid" and atm["weight"] == 1.0 and atm["price"] == pytest.approx(mid, abs=1e-9)
    stale = datetime(2026, 10, 28, 5, 28, tzinfo=UTC)  # two minutes old: past the 30 s limit
    app.state.stream.book.update(tick(f"{E1[-2:]}25600CE", stale, 1.0, 2.0))
    again = get(c, f"/api/risk/surface?expiry={E1}")
    assert again["data"][0]["live_books"] == 1  # the stale tick was ignored


# ------------------------------------------------------------------ chain Greeks
def test_chain_greeks_are_consistent_with_the_surface_and_the_formulas(client: tuple[TestClient, Any]) -> None:
    c, _ = client
    b = get(c, f"/api/risk/chain-greeks?expiry={E1}&strikes=5&third_order=true")
    assert len(b["rows"]) == 11 and b["lot_size"] == LOT and b["rows"][5]["strike"] == 25500.0 and b["t_years"] == pytest.approx(years_between(NOW, instant(E1)), rel=1e-12)
    row = b["rows"][5]
    cl, pu = row["call"], row["put"]
    assert cl["model_iv"] == pytest.approx(pu["model_iv"], rel=1e-12)  # one volatility per strike, from the smile
    assert cl["unit"]["delta"] - pu["unit"]["delta"] == pytest.approx(math.exp(-R * b["t_years"]), abs=1e-9)  # call delta less put delta is the discount factor
    assert cl["unit"]["gamma"] == pytest.approx(pu["unit"]["gamma"], rel=1e-9) and cl["unit"]["vega"] == pytest.approx(pu["unit"]["vega"], rel=1e-9)
    f, t, s, k = b["forward"], b["t_years"], cl["model_iv"], 25500.0
    vol = s * math.sqrt(t)
    d1 = (math.log(f / k) + 0.5 * vol * vol) / vol
    phi = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
    assert cl["unit"]["gamma"] == pytest.approx(math.exp(-R * t) * phi / (f * vol), rel=1e-9)
    assert cl["unit"]["vega"] == pytest.approx(math.exp(-R * t) * f * phi * math.sqrt(t) / 100.0, rel=1e-9)  # per volatility point
    assert cl["rupee_per_long_lot"]["delta"] == pytest.approx(LOT * cl["unit"]["delta"], rel=1e-12) and cl["unit"]["theta_day"] < 0
    assert all(math.isfinite(cl["unit"][k_]) for k_ in ("speed", "color", "zomma", "ultima"))
    assert cl["market_iv"] == pytest.approx(cl["model_iv"], abs=2e-3) and cl["price_source"] == "ltp" and cl["iv_status"] in ("used", "unused")
    plain = get(c, f"/api/risk/chain-greeks?expiry={E1}&strikes=2")
    assert len(plain["rows"]) == 5 and plain["rows"][0]["call"]["unit"]["speed"] is None  # third order was not asked for: missing, not zero
    assert len(get(c, f"/api/risk/chain-greeks?expiry={E1}&strikes=all")["rows"]) == 41


# ------------------------------------------------------------------ scenarios, grids, portfolio
def direct_engine(app: Any, legs: list[dict[str, Any]]) -> WhatIfEngine:
    bundle = app.state.risk.surface([E1, E2])
    ls = [Leg(x["expiry"], x["strike"], 1.0 if x["type"] == "CE" else -1.0, float(x["lots"] if x["action"] == "BUY" else -x["lots"]), LOT, x["entry_price"]) for x in legs]
    return WhatIfEngine(bundle.surface, ls, bundle.instants)


def test_a_scenario_over_http_equals_the_engine_called_directly(client: tuple[TestClient, Any]) -> None:
    c, app = client
    zero = post(c, "/api/risk/scenario", {"legs": STRADDLE})
    assert zero["result"]["pnl"] == 0.0 and all(x["pnl"] == 0.0 for x in zero["result"]["legs"])
    sc = {"spot_shock": 150.0, "iv_shock": 2.0, "time_elapsed_hours": 12.0, "sticky_rule": "delta", "rate_shock": 0.001}
    got = post(c, "/api/risk/scenario", {"legs": STRADDLE, "scenario": sc})["result"]
    want = direct_engine(app, STRADDLE).run(Scenario(150.0, 2.0, 12.0, "delta", 0.001))
    assert got["pnl"] == pytest.approx(want.pnl, rel=1e-12) and [x["pnl"] for x in got["legs"]] == pytest.approx([x.pnl for x in want.legs], rel=1e-12)
    assert got["legs"][0]["pnl_vs_entry"] == pytest.approx(want.legs[0].pnl_vs_entry, rel=1e-12) and got["legs"][2]["pnl_vs_entry"] is None
    assert got["scenario"]["sticky_rule"] == "delta" and got["warnings"] == []
    default_rule = post(c, "/api/risk/scenario", {"legs": STRADDLE, "scenario": {"spot_shock": 100.0}})["result"]
    assert default_rule["scenario"]["sticky_rule"] == "moneyness"  # the configured default
    assert post(c, "/api/risk/scenario", {"legs": [leg(E1, 25500.0, "CE", "BUY", 3)]})["result"]["legs"][0]["quantity"] == 3.0
    assert post(c, "/api/risk/scenario", {"legs": [leg(E1, 25500.0, "CE", "SELL", 3)]})["result"]["legs"][0]["quantity"] == -3.0


def test_grids_over_http(client: tuple[TestClient, Any]) -> None:
    c, app = client
    g = post(c, "/api/risk/grid", {"legs": STRADDLE})
    grid = g["grid"]
    eng = direct_engine(app, STRADDLE)
    assert len(grid["pnl"]) == 21 and len(grid["pnl"][0]) == 21 and grid["col_kind"] == "iv_points" and grid["pnl"][10][10] == 0.0 and g["forward"] == pytest.approx(F, abs=0.1)
    want = eng.grid_spot_iv()
    assert np.array(grid["pnl"]) == pytest.approx(want.pnl, rel=1e-9, abs=1e-6) and grid["row_axis"] == pytest.approx(list(want.row_axis))
    custom = post(c, "/api/risk/grid", {"legs": STRADDLE, "spot_shocks": [-100, 0, 100], "iv_shocks": [-5, 5], "sticky_rule": "strike", "fixed_hours": 6})["grid"]
    assert len(custom["pnl"]) == 3 and len(custom["pnl"][0]) == 2 and custom["sticky_rule"] == "strike" and custom["pnl"][1][0] != 0.0  # time elapsed: no longer the centre
    st = post(c, "/api/risk/grid", {"legs": STRADDLE, "kind": "spot_time"})["grid"]
    assert st["col_kind"] == "hours" and st["col_axis"][0] == 0.0 and len(st["pnl"][0]) == 21
    pay = post(c, "/api/risk/grid", {"legs": [leg(E1, 25500.0, "CE", "BUY", 1), leg(E1, 25600.0, "CE", "SELL", 1)], "kind": "payoff", "spot_shocks": [-400, 300]})["grid"]
    assert len(pay["pnl"]) == 2 and pay["pnl"][1][0] > 0 > pay["pnl"][0][0]  # a bull call spread loses below both strikes and gains above them


def test_portfolio_and_presets_over_http(client: tuple[TestClient, Any]) -> None:
    c, app = client
    p = post(c, "/api/risk/portfolio", {"legs": STRADDLE})["portfolio"]
    assert p["complete"] and p["beta"] == 1.0 and p["beta_source"] == "config" and [b["label"] for b in p["buckets"]] == ["front", "next"]
    want = app.state.risk.portfolio.aggregate(app.state.risk.surface([E1, E2]).surface, direct_engine(app, STRADDLE).legs, app.state.risk.surface([E1, E2]).instants)
    assert p["net"]["rupee"]["delta"] == pytest.approx(want.net.rupee["delta"], rel=1e-12) and p["net"]["rupee"]["vega"] == pytest.approx(want.net.rupee["vega"], rel=1e-12)
    assert p["beta_weighted_delta_rupees"] == pytest.approx(p["net"]["rupee"]["delta"], rel=1e-12) and p["breaches"] == []
    pr = post(c, "/api/risk/presets", {"legs": STRADDLE})
    assert set(pr["presets"]) == {"gap_down", "iv_spike", "expiry_crush", "sd_plus_1", "sd_minus_1", "sd_plus_2", "sd_minus_2"}
    assert all(isinstance(v["pnl"], float) for v in pr["presets"].values()) and pr["presets"]["gap_down"]["scenario"]["spot_shock"] == pytest.approx(-0.02 * F, abs=0.5)


def test_limits_come_from_configuration(tmp_path: Path) -> None:
    app = make_app(tmp_path, greeks_limits_json=json.dumps({"portfolio": {"vega": 100.0}, "leg": {"delta": 50.0}, "warn_fraction": 0.5}))
    with TestClient(app) as c:
        app.state.risk._clock = lambda: NOW  # noqa: SLF001
        for e in (E1, E2):
            app.state.store.save(chain(e, NOW, sid=f"snap-{e}"), {})
        p = post(c, "/api/risk/portfolio", {"legs": STRADDLE})["portfolio"]
        kinds = {(b["scope"], b["metric"], b["level"]) for b in p["breaches"]}
        assert ("portfolio", "vega", "breach") in kinds and ("leg", "delta", "breach") in kinds
        assert p["breaches"] == sorted(p["breaches"], key=lambda b: -b["utilisation"]) and all(b["limit"] in (100.0, 50.0) for b in p["breaches"])


# ------------------------------------------------------------------ validation and errors
@pytest.mark.parametrize(
    "body",
    [
        {"legs": []},
        {"legs": [leg(E1, 25500.0, "CE", "BUY", 0)]},
        {"legs": [leg(E1, -5.0, "CE", "BUY", 1)]},
        {"legs": [leg(E1, 25500.0, "XX", "BUY", 1)]},
        {"legs": [leg(E1, 25500.0, "CE", "HOLD", 1)]},
        {"legs": [leg("not-a-date", 25500.0, "CE", "BUY", 1)]},
        {"legs": [leg(E1, 25500.0, "CE", "BUY", 1)], "scenario": {"sticky_rule": "magic"}},
        {"legs": [leg(E1, 25500.0, "CE", "BUY", 1)], "scenario": {"spot_shock": 1e9}},
        {"legs": [leg(E1, 25500.0, "CE", "BUY", 1)], "scenario": {"iv_shock": float("nan")}},
    ],
)
def test_bad_input_is_refused_at_the_boundary(client: tuple[TestClient, Any], body: dict[str, Any]) -> None:
    c, _ = client
    assert c.post("/api/risk/scenario", content=json.dumps(body), headers={"content-type": "application/json"}).status_code == 422


def test_limits_on_legs_axes_and_missing_data(client: tuple[TestClient, Any], tmp_path: Path) -> None:
    c, _ = client
    assert c.post("/api/risk/grid", json={"legs": STRADDLE, "spot_shocks": list(range(102))}).status_code == 422  # at most 101 axis values
    assert c.post("/api/risk/grid", json={"legs": STRADDLE, "kind": "volcano"}).status_code == 422
    assert c.get("/api/risk/chain-greeks?expiry=2026-11-03&strikes=banana").status_code == 422
    r = c.post("/api/risk/scenario", json={"legs": [leg(E1, 25500.0, "CE", "BUY", 1), leg("2026-12-29", 25500.0, "CE", "BUY", 1)]})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "expiry_unavailable"  # a surface exists for the first leg's expiry, but not for the second's
    only = c.post("/api/risk/scenario", json={"legs": [leg("2026-12-29", 25500.0, "CE", "BUY", 1)]})
    assert only.status_code == 409 and only.json()["detail"]["code"] == "expiry_unavailable"  # the service keeps the expiries it has seen, so the surface exists and only this expiry is missing
    few = make_app(tmp_path / "few", greeks_max_legs=2)
    with TestClient(few) as c2:
        r2 = c2.post("/api/risk/portfolio", json={"legs": STRADDLE})
        assert r2.status_code == 422 and r2.json()["detail"]["code"] == "too_many_legs"
    empty = make_app(tmp_path / "empty")
    with TestClient(empty) as c3:
        r3 = c3.post("/api/risk/scenario", json={"legs": [leg(E1, 25500.0, "CE", "BUY", 1)]})
        assert r3.status_code == 503 and r3.json()["detail"]["code"] == "no_surface"  # no stored chain: no numbers, no invention
        assert c3.get("/api/risk/surface").status_code == 503


def test_a_degraded_expiry_is_reported_and_its_numbers_are_missing_not_zero(client: tuple[TestClient, Any]) -> None:
    c, app = client
    sparse = chain(E1, NOW, sid="sparse", strikes=np.array([25400.0, 25500.0, 25600.0]))  # three strikes: too few for a fit
    app.state.store.save(sparse, {})
    b = get(c, f"/api/risk/surface?expiry={E1}")
    assert b["slices"][0]["params"] is None and b["slices"][0]["degraded"] is True and "usable points" in b["slices"][0]["degraded_reason"]
    r = c.get(f"/api/risk/chain-greeks?expiry={E1}")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "no_fit"
    sc = post(c, "/api/risk/scenario", {"legs": [leg(E1, 25500.0, "CE", "BUY", 1)]})["result"]
    assert sc["pnl"] is None and sc["legs"][0]["status"] == "no fitted smile for the expiry" and sc["legs"][0]["new_iv"] is None and sc["warnings"]


# ------------------------------------------------------------------ speed
def test_the_endpoints_answer_quickly_when_the_surface_is_current(client: tuple[TestClient, Any]) -> None:
    c, _ = client
    get(c, "/api/risk/surface")
    t0 = time.perf_counter()
    for _ in range(10):
        post(c, "/api/risk/scenario", {"legs": STRADDLE, "scenario": {"spot_shock": 100}})
        post(c, "/api/risk/grid", {"legs": STRADDLE})
        post(c, "/api/risk/portfolio", {"legs": STRADDLE})
    per_call_ms = (time.perf_counter() - t0) * 1000 / 30
    assert per_call_ms < 60.0
