"""Strike premium: what moved one contract's price over a stored session, hand-checked against the stored prices themselves; and the 7 % default rate."""

from __future__ import annotations

import math
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.intelligence.straddle_service import StraddleDecay
from app.intraday import volatility
from app.intraday.volatility import CALL, PUT, greeks, years_to_expiry
from tests.conftest import make_app
from tests.unit.test_straddle_decay import EXPIRY, OPEN, R
from tests.unit.test_straddle_service import RunningObs

K = 24000.0


def service(n: int = 60, now_offset_days: int = 2) -> tuple[StraddleDecay, RunningObs]:
    obs = RunningObs(n)  # NIFTY climbs 2 points a minute from 24,000; flat 15 % vol; prices made with the rate R
    return StraddleDecay(observations=obs, underlying="NIFTY", gex=None, rate=R, clock=lambda: OPEN + timedelta(days=now_offset_days)), obs


def total(parts: dict[str, float]) -> float:
    return sum(parts[k] for k in ("theta", "vega", "delta", "gamma", "cross", "other"))


def test_the_default_rate_is_7_percent_everywhere() -> None:
    assert volatility.DEFAULT_RATE == 0.07
    assert Settings.model_fields["risk_free_rate"].default == 0.07


def test_a_fixed_strike_straddle_account_adds_up_to_its_real_price_change() -> None:
    s, obs = service()
    out = s.strike_premium(strike=K, window="open")
    assert out["status"] == "ok" and out["strike"] == K and out["contract"] == "straddle" and out["mode"] == "fixed" and out["rate_assumed"] == R
    sm = out["summary"]
    # the stored prices themselves: the 24,000 straddle at the first and the last sample
    first, last = obs.snaps[0].prices, obs.snaps[-1].prices
    by_hand = (last[(K, CALL)] + last[(K, PUT)]) - (first[(K, CALL)] + first[(K, PUT)])
    assert sm["real_change"] == pytest.approx(by_hand, abs=0.006) and by_hand > 0  # NIFTY ran 118 points away from the strike: the straddle is worth more
    assert total(sm["parts"]) == pytest.approx(sm["real_change"], abs=0.02)  # the parts add up to it (each rounded to 0.001)
    assert sm["parts"]["actual"] == pytest.approx(sm["real_change"], abs=0.006)
    p = sm["parts"]
    assert p["theta"] < 0 and p["delta"] + p["gamma"] > 0 and abs(p["vega"]) < 0.3 and abs(p["cross"]) < 0.3  # time cost it, NIFTY moving lifted it, flat vol
    assert sm["steps"] == 59 and sm["minutes"] == 59 and sm["driver"]["name"] == "NIFTY"
    assert out["series"]["price"][0] == pytest.approx(first[(K, CALL)] + first[(K, PUT)], abs=0.006)
    assert out["series"]["cum"]["actual"][-1] == pytest.approx(sm["real_change"], abs=0.02)


def test_call_plus_put_is_the_straddle() -> None:
    s, _ = service()
    c, p, st = (s.strike_premium(strike=K, contract=x, window="open")["summary"] for x in ("call", "put", "straddle"))
    assert c["real_change"] + p["real_change"] == pytest.approx(st["real_change"], abs=0.01)
    for k in ("theta", "vega", "delta", "gamma", "cross", "other"):
        assert c["parts"][k] + p["parts"][k] == pytest.approx(st["parts"][k], abs=0.005), k
    assert c["parts"]["delta"] > 0 > p["parts"]["delta"]  # the call gained from NIFTY rising, the put lost


def test_windows_cut_the_account() -> None:
    s, _ = service()
    w15, w30, wo = (s.strike_premium(strike=K, window=w)["summary"] for w in ("15", "30", "open"))
    assert (w15["steps"], w30["steps"], wo["steps"]) == (15, 30, 59) and (w15["minutes"], w30["minutes"]) == (15, 30)
    assert abs(w15["real_change"]) < abs(w30["real_change"]) < abs(wo["real_change"])
    cut = s.strike_premium(strike=K, window="open", as_of=OPEN + timedelta(minutes=30))  # a replay at the 30th minute
    assert len(cut["series"]["t"]) == 31 and cut["summary"]["steps"] == 30


def test_the_ladder_lists_the_strikes_around_the_money_with_each_contracts_change_and_driver() -> None:
    s, obs = service()
    out = s.strike_premium(strike=K, window="30", each=3)
    rows = out["ladder"]
    assert [r["strike"] for r in rows] == sorted(r["strike"] for r in rows)  # ascending
    assert len(rows) == 7 and sum(1 for r in rows if r["atm"]) == 1 and next(r for r in rows if r["atm"])["strike"] == 24100.0  # 24,118 is nearest 24,100
    row = next(r for r in rows if r["strike"] == K)
    p_now, p_start = obs.snaps[-1].prices[(K, CALL)], obs.snaps[-31].prices[(K, CALL)]
    assert row["call"]["price"] == pytest.approx(p_now, abs=0.006) and row["call"]["change"] == pytest.approx(p_now - p_start, abs=0.011)
    assert total(row["call"]["parts"]) == pytest.approx(row["call"]["change"], abs=0.05) and row["call"]["complete"] is True
    assert row["call"]["driver"]["name"] == "NIFTY" and row["call"]["change"] > 0 and row["put"]["change"] < 0  # the call gained, the put lost
    for r in rows:
        for side in ("call", "put"):
            assert r[side]["driver"]["name"] in ("time", "volatility", "NIFTY", "other")


def test_greeks_now_by_hand() -> None:
    s, obs = service()
    g = s.strike_premium(strike=K, window="30")["greeks_now"]
    last = obs.snaps[-1]
    t = years_to_expiry(EXPIRY, last.at)
    f = last.spot * math.exp(R * t)
    gc, gp = greeks(CALL, f, K, t, 0.15, R), greeks(PUT, f, K, t, 0.15, R)
    assert gc is not None and gp is not None
    assert g["strike"] == K and g["delta"] == pytest.approx(gc.delta + gp.delta, abs=0.004)
    assert g["gamma"] == pytest.approx(gc.gamma + gp.gamma, abs=2e-5) and g["theta_day"] == pytest.approx(gc.theta_day + gp.theta_day, abs=1.0)
    assert g["iv_pct"] == pytest.approx(15.0, abs=0.3)


def test_following_the_atm_removes_the_jumps_of_changing_strike() -> None:
    s, _ = service()
    out = s.strike_premium(mode="atm", contract="straddle", window="open")
    assert out["status"] == "ok" and out["mode"] == "atm"
    price, cum = out["series"]["price"], out["series"]["cum"]["actual"]
    raw_change = price[-1] - price[0]
    # the at-the-money strike moved from 24,000 to 24,100 as NIFTY climbed: the raw line switches contracts, the account measures each step on one contract
    assert abs(cum[-1] - raw_change) > 0.5
    steps = [b - a for a, b in zip(cum, cum[1:], strict=False)]
    assert all(abs(x) < 6 for x in steps)  # no jump the size of a change of strike in any one step


def test_a_strike_that_is_not_listed_and_a_thin_session_are_said_plainly() -> None:
    s, _ = service()
    assert s.strike_premium(strike=99999.0)["status"] == "unavailable" and "not listed" in s.strike_premium(strike=99999.0)["message"]
    thin, _ = service(n=2)
    assert thin.strike_premium(strike=K)["status"] == "unavailable"
    empty = StraddleDecay(observations=RunningObs(60), underlying="NIFTY", gex=None, rate=R, clock=lambda: OPEN + timedelta(days=130))
    assert empty.strike_premium()["status"] == "unavailable"


def test_the_api_serves_the_strike_premium_and_refuses_bad_parameters(tmp_path: Path) -> None:
    s, _ = service()
    app = make_app(tmp_path / "app")
    with TestClient(app) as c:
        app.state.straddle = s
        body = c.get("/api/intelligence/strike-premium?strike=24000&contract=call&window=15&each=2").json()
        assert body["status"] == "ok" and body["contract"] == "call" and body["summary"]["steps"] == 15 and len(body["ladder"]) == 5
        assert c.get("/api/intelligence/strike-premium?contract=bogus").status_code == 400
        assert c.get("/api/intelligence/strike-premium?window=abc").status_code == 400
        assert c.get("/api/intelligence/strike-premium?mode=roll").status_code == 400
        app.state.straddle = StraddleDecay(observations=RunningObs(60), underlying="NIFTY", gex=None, rate=R, enabled=False)
        assert c.get("/api/intelligence/strike-premium").status_code == 404
