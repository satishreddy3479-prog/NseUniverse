"""The decay-probability core (D214), checked against closed forms and by hand.

The grid distribution is compared with the exact lognormal answer where one exists (leaving at the expiry), with the martingale property the model must have (selling at the market's own volatility
has an expected result of zero before costs), and with hand-built rules. A run on a real stored chain (19 Nov 2026, 09:45) checks that nothing is inconsistent on real prices.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.intelligence import decay_probability as dp
from app.intelligence import straddle as sd
from app.intraday.volatility import CALL, PUT, price
from tests.unit.test_entry_lab import REAL

IST = ZoneInfo("Asia/Kolkata")
Y_MIN = 365 * 1440  # calendar minutes in a year


def phi(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2))


def test_the_volatility_that_reproduces_a_straddle_price_is_found() -> None:
    t = 4 / 365
    p = dp.straddle_price(25000.0, 25000.0, t, 0.15, 0.06)
    assert dp.straddle_sigma(25000.0, 25000.0, t, p, 0.06) == pytest.approx(0.15, abs=1e-6)
    assert dp.straddle_sigma(25000.0, 25000.0, t, 1e-9, 0.06) is None  # below what any volatility gives
    assert dp.straddle_sigma(25000.0, 25000.0, 0.0, 100.0, 0.06) is None


def test_trading_minutes_by_hand() -> None:
    thu = datetime(2026, 11, 19, tzinfo=IST)
    assert dp.trading_minutes(thu.replace(hour=9, minute=45), thu.replace(hour=15, minute=15)) == 330
    # Thursday 15:15 -> Friday 09:45: 25 minutes to the 15:40 close, 30 after the 09:15 open
    assert dp.trading_minutes(thu.replace(hour=15, minute=15), (thu + timedelta(days=1)).replace(hour=9, minute=45)) == 55
    # Friday 15:00 -> Monday 09:30: 40 + 15, the weekend adds nothing
    fri = datetime(2026, 11, 20, 15, 0, tzinfo=IST)
    assert dp.trading_minutes(fri, datetime(2026, 11, 23, 9, 30, tzinfo=IST)) == 55
    assert dp.trading_minutes(thu.replace(hour=12), thu.replace(hour=11)) == 0.0
    assert dp.trading_minutes(thu.replace(hour=7), thu.replace(hour=9, minute=15)) == 0.0  # before the open


def expiry_case(minutes: float = 120.0, sigma: float = 0.12, f0: float = 25000.0) -> dict[str, float]:
    t0 = minutes / Y_MIN
    return {"f0": f0, "strike": f0, "premium": dp.straddle_price(f0, f0, t0, sigma, 0.06), "sigma": sigma, "t0": t0, "minutes_to_exit": minutes, "minutes_to_expiry": minutes}


def test_leaving_at_the_expiry_matches_the_exact_lognormal_answer() -> None:
    """At the expiry the straddle is worth |F - K|, so the sale pays when F ends within the premium of the strike: an exact lognormal probability
    (ln F ~ N(ln F0 - v/2, v), v = sigma^2 t0)."""
    c = expiry_case()
    d = dp.distribution(**c, rate=0.0, cost=0.0)
    v = c["sigma"] ** 2 * c["t0"]
    lo, hi = c["strike"] - c["premium"], c["strike"] + c["premium"]
    mu, sd_ = math.log(c["f0"]) - v / 2, math.sqrt(v)
    exact = phi((math.log(hi) - mu) / sd_) - phi((math.log(lo) - mu) / sd_)
    assert d["p_profit"] == pytest.approx(exact, abs=0.01)
    assert 0.5 < d["p_profit"] < 0.7  # the premium is about 0.8 of one standard deviation: a bit over half the time it pays


def test_selling_at_the_markets_own_volatility_has_an_expected_result_of_zero() -> None:
    """The premium is a martingale in the model: before costs the expected net result is about zero, at the expiry and with days left."""
    assert dp.distribution(**expiry_case(), rate=0.0, cost=0.0)["mean"] == pytest.approx(0.0, abs=0.5)
    t0, m_exp = 4 / 365, 4 * 375
    p0 = dp.straddle_price(25000.0, 25000.0, t0, 0.14, 0.0)
    d = dp.distribution(f0=25000.0, strike=25000.0, premium=p0, sigma=0.14, t0=t0, minutes_to_exit=330, minutes_to_expiry=m_exp, rate=0.0, cost=0.0)
    assert d["mean"] == pytest.approx(0.0, abs=0.5) and d["p_stop"] == 0 and d["p_target"] == 0 and d["p_exit_time"] == 1.0
    assert d["quantiles"]["p50"] > 0 > d["quantiles"]["p5"]  # the usual shape: a positive typical day, a bad tail


def test_the_cost_is_taken_once_and_a_lower_realised_volatility_pays_more() -> None:
    c = expiry_case()
    free = dp.distribution(**c, rate=0.0, cost=0.0)
    paid = dp.distribution(**c, rate=0.0, cost=2.0)
    assert paid["mean"] == pytest.approx(free["mean"] - 2.0, abs=1e-6)
    calm = dp.distribution(**c, rate=0.0, cost=0.0, vol_scale=0.8)
    wild = dp.distribution(**c, rate=0.0, cost=0.0, vol_scale=1.2)
    assert calm["mean"] > free["mean"] > wild["mean"] and calm["p_profit"] > free["p_profit"] > wild["p_profit"]
    assert calm["mean"] > 3.0  # 20% less volatility than sold is worth several points on a 35-point premium


def test_a_stop_caps_the_bad_day_and_the_outcomes_add_up() -> None:
    t0, m_exp = 4 / 365, 4 * 375
    p0 = dp.straddle_price(25000.0, 25000.0, t0, 0.14, 0.0)
    base = {"f0": 25000.0, "strike": 25000.0, "premium": p0, "sigma": 0.14, "t0": t0, "minutes_to_exit": 330, "minutes_to_expiry": m_exp, "rate": 0.0, "cost": 2.0}
    plain = dp.distribution(**base)
    stopped = dp.distribution(**base, stop_pct=20.0)
    assert stopped["p_stop"] + stopped["p_target"] + stopped["p_exit_time"] == pytest.approx(1.0, abs=1e-3)
    assert stopped["p_stop"] > 0.05
    assert stopped["quantiles"]["p5"] >= -0.2 * p0 - 2.0 - 0.01  # nothing is worse than the stop level plus the cost
    assert stopped["quantiles"]["p5"] > plain["quantiles"]["p5"]  # the tail is cut
    # with four days to expiry the premium falls only about 12% over the day if the index stays put (theta is small on non-expiry days): a 30% target is out of reach, 10% is not
    assert dp.distribution(**base, target_pct=30.0)["p_target"] == 0.0
    both = dp.distribution(**base, stop_pct=20.0, target_pct=10.0)
    assert both["p_target"] > 0.2 and both["p_stop"] <= stopped["p_stop"] + 1e-9  # a target takes some paths away from the stop (and the time exit)
    assert both["quantiles"]["p95"] <= 0.1 * p0 - 2.0 + 0.01  # nothing is better than the target level less the cost
    wide = dp.distribution(**base, stop_pct=200.0)
    assert wide["p_stop"] < stopped["p_stop"]  # a far stop is hit less often


def test_the_break_even_touch_probability_is_at_least_the_chance_of_ending_beyond_them() -> None:
    d = dp.distribution(**expiry_case(), rate=0.0, cost=0.0)
    ending_out = 1 - d["p_profit"]
    assert d["p_touch_breakeven"] >= ending_out - 1e-6
    assert d["p_touch_breakeven"] <= 1.0 and d["breakeven"]["up"] - d["breakeven"]["down"] == pytest.approx(2 * d["breakeven"]["move_pts"], abs=0.2)


def test_bad_inputs_are_refused_not_guessed() -> None:
    c = expiry_case()
    with pytest.raises(ValueError):
        dp.distribution(**{**c, "minutes_to_exit": 0.0})
    with pytest.raises(ValueError):
        dp.distribution(**{**c, "minutes_to_exit": 200.0})  # leaves after the expiry


def chain_point(at: datetime, expiry: date, iv: float = 0.15) -> sd.Point:
    spot, strikes = 24000.0, [23800.0 + 50 * i for i in range(13)]
    t = sd.years_to_expiry(expiry, at)
    f = spot * math.exp(0.06 * t)
    prices = {(k, s): price(s, f, k, t, iv, 0.06) for k in strikes for s in (CALL, PUT)}
    p, why = sd.build_point(sd.Snap(at, spot, prices), expiry, 0.06)
    assert p is not None, why
    return p


def test_a_chain_priced_at_a_flat_volatility_gives_that_volatility_back() -> None:
    at = datetime(2026, 11, 11, 9, 45, tzinfo=IST)
    expiry = date(2026, 11, 12)
    p = chain_point(at, expiry)
    out = dp.for_point(p, datetime.combine(expiry, dp.default_close(expiry), IST), datetime(2026, 11, 11, 15, 15, tzinfo=IST), stop_pct=20.0)
    assert out["available"] and out["strike"] == 24000.0 and out["implied_vol_pct"] == pytest.approx(15.0, abs=0.01)
    assert out["steps"] == 33 and out["step_min"] == 10.0 and 0.3 < out["p_profit"] < 0.8
    late = dp.for_point(p, datetime.combine(expiry, dp.default_close(expiry), IST), datetime(2026, 11, 11, 9, 46, tzinfo=IST))
    assert late == {"available": False, "reason": "too close to the exit time"}


def test_the_real_session_of_19_nov_at_0945_is_coherent_and_the_answer_reads_in_words() -> None:
    day = REAL["2026-11-19"]
    i = next(i for i, t in enumerate(day.times) if (t.astimezone(IST).hour, t.astimezone(IST).minute) >= (9, 45))
    expiry = date(2026, 11, 23)
    snap = sd.Snap(day.times[i], day.spots[i], dict(day.prices[i]))
    p, why = sd.build_point(snap, expiry, 0.06)
    assert p is not None, why
    out = dp.for_point(p, datetime.combine(expiry, dp.default_close(expiry), IST), datetime(2026, 11, 19, 15, 15, tzinfo=IST), stop_pct=20.0, target_pct=30.0)
    assert out["available"] and 200 < out["premium"] < 400  # the strike nearest the forward, which carries a few days of interest above the index
    assert 5 < out["implied_vol_pct"] < 30 and out["p_stop"] + out["p_target"] + out["p_exit_time"] == pytest.approx(1.0, abs=1e-3)
    assert out["quantiles"]["p5"] <= out["quantiles"]["p50"] <= out["quantiles"]["p95"] and out["steps"] == 33
    lines = dp.explain(out)
    assert len(lines) == 3 and "Break-evens" in lines[1] and "stopped out" in lines[2]


# ------------------------------------------------------------------ the calibration of the engine on recorded days
def test_the_calibration_follows_the_straddle_the_engine_priced_to_the_exit_by_hand() -> None:
    from datetime import time

    from app.intelligence import decay_calibration as dc
    from tests.unit.test_entry_lab import session

    # one strike, spot flat at 25,000, premium 200 falling 0.1 point a minute from 09:15 (index = minutes since the open)
    n = 400
    day = session("2026-11-19", [25000.0] * n, [200.0 - 0.1 * i for i in range(n)], dte=4)
    rows = dc.outcome_rows(day, dc.DEFAULT_ENTRIES, time(15, 15), 1.0)
    assert [r["entry"] for r in rows] == ["09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30"]
    first = rows[0]
    # sold at 09:30 (index 15, premium 198.5), bought back at 15:15 (index 360, premium 164.0), 2 points of cost
    assert first["actual"] == pytest.approx(198.5 - 164.0 - 2.0, abs=0.01) and first["win"] is True
    assert 0.0 < first["p_profit"] < 1.0 and first["p5"] < first["p50"] < first["p95"]
    assert dc.outcome_rows(day, [time(15, 10)], time(15, 15), 1.0) == []  # too short a hold to follow


def test_the_summary_by_hand() -> None:
    from app.intelligence import decay_calibration as dc

    def row(day: str, p: float, actual: float) -> dict[str, object]:
        return {"day": day, "entry": "09:30", "p_profit": p, "mean": 0.0, "p5": -50.0, "p50": 0.0, "p95": 40.0, "actual": actual, "win": actual > 0}

    rows = [row("a", 0.8, 5), row("a", 0.8, 5), row("b", 0.8, 5), row("b", 0.8, -5), row("c", 0.3, -5), row("c", 0.3, -5), row("d", 0.3, -5), row("d", 0.3, 5)]
    s = dc.summarise(rows)
    assert s["entries"] == 8 and s["days"] == 4 and s["base_rate"] == 0.5
    # Brier: (0.2^2 x3 + 0.8^2 + 0.3^2 x3 + 0.7^2) / 8 = (0.12 + 0.64 + 0.27 + 0.49) / 8 = 0.19
    assert s["brier"] == pytest.approx(0.19, abs=1e-4) and s["brier_base_rate"] == 0.25 and s["beats_base_rate"] is True
    bands = {(b["from"], b["to"]): b for b in s["reliability"]}
    assert bands[(0.75, 1.0)]["predicted"] == 0.8 and bands[(0.75, 1.0)]["actual"] == 0.75 and bands[(0.0, 0.45)]["actual"] == 0.25
    assert s["below_predicted"] == {"p5": 0.0, "p50": 0.5, "p95": 1.0}  # 4 of 8 results (the -5s) are under the median 0; none under -50
    assert dc.summarise([]) == {"entries": 0, "days": 0}


def test_calibrating_says_how_many_days_and_refuses_a_verdict_on_few() -> None:
    from app.intelligence import decay_calibration as dc

    out = dc.calibrate(list(REAL.values()), scales=(0.9, 1.0))
    assert out["days"] == 3 and out["variants_tried"] == 2 and out["sufficient"] is False and "not a verdict" in out["note"]
    one = out["scales"]["1"]
    assert one["entries"] == 27 and one["mean_predicted_pnl"] == pytest.approx(-2.0, abs=0.3)  # the market's own volatility: zero before the 2 points of cost


# ------------------------------------------------------------------ the service, the endpoints and the background calibration
def test_the_live_method_prices_the_newest_stored_chain_and_says_when_it_is_too_late() -> None:
    from datetime import timedelta

    from tests.unit.test_straddle_service import OPEN, svc

    s = svc(60, now=OPEN + timedelta(minutes=60))  # 09:16 + 59 minutes: the newest chain is from about 10:15
    out = s.decay_probability(stop_pct=20.0, target_pct=10.0)
    assert out["available"] and out["session"] == "2026-11-11" and out["expiry"] == "2026-11-12" and out["stale"] is False
    assert out["implied_vol_pct"] == pytest.approx(15.0, abs=0.05) and out["exit"] == "15:15" and out["stop_pct"] == 20.0
    assert out["p_stop"] + out["p_target"] + out["p_exit_time"] == pytest.approx(1.0, abs=1e-3) and len(out["lines"]) == 3
    late = svc(400, now=OPEN + timedelta(minutes=400)).decay_probability()  # the newest chain is from 15:55, after the exit time
    assert late["available"] is False and late["reason"] == "too close to the exit time" and late["session"] == "2026-11-11"
    old = svc(60, now=OPEN + timedelta(hours=5)).decay_probability()
    assert old["stale"] is True and old["age_minutes"] > 200  # an old chain is priced as it was and called stale
    off = svc(60)
    off.enabled = False
    assert off.decay_probability() == {"available": False, "reason": "straddle analysis is off"}


def test_the_endpoints_pass_the_rule_and_refuse_bad_times(tmp_path) -> None:  # type: ignore[no-untyped-def]
    from types import SimpleNamespace

    from fastapi.testclient import TestClient

    from tests.unit.test_globalmkts import make_app

    asked: list[tuple[object, ...]] = []

    def fake(*a: object) -> dict[str, object]:
        asked.append(a)
        return {"available": True}

    app = make_app(tmp_path)
    with TestClient(app) as c:
        real_straddle, real_lab = app.state.straddle, app.state.entry_lab
        app.state.straddle = SimpleNamespace(enabled=True, decay_probability=fake)
        assert c.get("/api/intelligence/decay-probability", params={"stop": 20, "target": 10, "exit": "14:30", "cost": 3, "vol_scale": 0.9}).json() == {"available": True}
        assert asked[-1][:2] == (20.0, 10.0) and asked[-1][3:] == (3.0, 0.9) and f"{asked[-1][2]:%H:%M}" == "14:30"
        assert c.get("/api/intelligence/decay-probability", params={"exit": "2pm"}).status_code == 422
        assert c.get("/api/intelligence/decay-probability", params={"vol_scale": 3}).status_code == 422
        app.state.entry_lab = None
        assert c.get("/api/intelligence/decay-calibration").status_code == 503
        app.state.straddle, app.state.entry_lab = real_straddle, real_lab


def test_the_calibration_runs_in_the_background_and_is_kept_until_the_days_change(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from datetime import datetime

    from app.intelligence import decay_calibration as dc
    from tests.unit.test_entry_lab import stub_service

    calls: list[int] = []

    def fake_calibrate(days):  # type: ignore[no-untyped-def]
        calls.append(len(days))
        return {"days": len(days), "scales": {}, "variants_tried": 0}

    monkeypatch.setattr(dc, "calibrate", fake_calibrate)
    svc = stub_service(list(REAL.values()), datetime(2026, 11, 20, 16, 30, tzinfo=IST))
    svc.start()
    assert svc._thread is not None
    svc._thread.join(timeout=10)
    first = svc.calibration()
    assert first["status"] == "computing" and first["previous"] is None
    assert svc._cal_thread is not None
    svc._cal_thread.join(timeout=10)
    again = svc.calibration()
    assert again["status"] == "ready" and again["days"] == 3 and calls == [3]  # kept: not computed twice
