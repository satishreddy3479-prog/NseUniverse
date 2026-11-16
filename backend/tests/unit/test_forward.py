"""Forward test: exit rules on real stored one-minute prices of 16 Nov 2026, the re-arming rule, charges, the service flow on a fake chain, the metrics and the API.

tests/fixtures/forward/nifty_25300_20261116.json holds the real stored last traded prices of the NIFTY 17 Nov 25300 CE and PE from 10:25 to 13:42 IST (the day the
user's short straddle had its put stopped); the service-flow tests use a made-up chain (labelled) to exercise the rules, not as market data.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient

from app.forward import analytics
from app.forward.engine import VARIANTS, costs, is_done, new_state, settle, step
from app.forward.service import ForwardService, next_arm
from app.forward.store import ForwardStore
from app.storage.observations import CALL, PUT, Contract, Sample
from tests.conftest import make_app

FIX = Path(__file__).parent.parent / "fixtures" / "forward" / "nifty_25300_20261116.json"
IST = ZoneInfo("Asia/Kolkata")
LOT = 65


def real_rows() -> list[list[Any]]:
    return json.loads(FIX.read_text())["rows"]  # [time, spot, ce, pe]


def run_variant(variant: str) -> dict[str, Any]:
    rows = real_rows()
    ce0, pe0 = rows[0][2], rows[0][3]
    st = new_state()
    for t, _spot, ce, pe in rows[1:]:
        st = step(variant, ce0, pe0, st, ce, pe, t)
    r = settle(variant, ce0, pe0, st, LOT)
    assert r is not None
    return r | {"state": st}


# ------------------------------------------------------------------ exit rules on the real prices
def test_the_entry_of_16_nov_and_the_hand_calculated_results_of_each_exit() -> None:
    rows = real_rows()
    assert rows[0][:1] + rows[0][2:] == ["10:25", 92.95, 107.3]  # sold at 10:25: call 92.95, put 107.30, premium 200.25
    hold = run_variant("hold")
    assert hold["gross"] == pytest.approx(((92.95 - 70.45) + (107.3 - 105.2)) * LOT)  # 22.5 + 2.1 = 24.6 points = 1,599 at the 13:42 prices
    assert hold["reason"] == "close 15:20" and hold["stopped_at"] is None
    # 30% on the put = 139.49: the sample of 10:34 (143.00) shows it
    leg30 = run_variant("leg30")
    assert leg30["pe_exit"] == 143.0 and leg30["stopped_at"] == "10:34" and leg30["ce_exit"] == 70.45
    assert leg30["gross"] == pytest.approx(((92.95 - 70.45) + (107.3 - 143.0)) * LOT)  # -13.2 points = -858
    # 40% = 150.22: the minute samples first show it at 10:46 (156.65), the server's tick data caught 149.25 at 10:34:38: a stop is only as fine as the samples
    leg40 = run_variant("leg40")
    assert leg40["pe_exit"] == 156.65 and leg40["stopped_at"] == "10:46"
    assert leg40["gross"] == pytest.approx(((92.95 - 70.45) + (107.3 - 156.65)) * LOT)  # -26.85 points = -1,745
    # 60% = 171.68 and 80% were never reached today, nor was a combined premium of +15% (230.29, the high was 218.75): the same as holding
    for v in ("leg60", "leg70", "leg80", "comb15", "comb25", "comb40"):
        assert run_variant(v)["gross"] == pytest.approx(hold["gross"]), v


def test_moving_the_other_leg_to_cost_turned_a_recovery_into_a_second_stop() -> None:
    r = run_variant("leg40_cost")
    # after the put stop (10:46) the call's stop is its entry price 92.95; it first shows 103.50 at 12:10
    assert r["pe_exit"] == 156.65 and r["ce_exit"] == 103.5 and r["reason"] == "stop, stop at cost" and r["stopped_at"] == "10:46"
    assert r["gross"] == pytest.approx(((92.95 - 103.5) + (107.3 - 156.65)) * LOT)  # -59.9 points = -3,893.5


def test_the_deepest_point_and_a_missing_price() -> None:
    hold = run_variant("hold")
    assert hold["worst"] == pytest.approx(min(((92.95 - ce) + (107.3 - pe)) for _t, _s, ce, pe in real_rows()[1:]) * LOT)
    st = new_state()
    assert step("hold", 100, 100, st, None, None) is st  # no price at all: nothing changes, nothing is invented
    st = step("leg40", 100, 100, st, 90, 100)
    st = step("leg40", 100, 100, st, None, 150)  # the call has no price this minute: its last one is kept, the put stops
    assert st["pe_x"] == 150 and st["ce_open"] and st["last_ce"] == 90
    assert settle("hold", 100, 100, new_state(), LOT) is None  # never saw a price: no result, not a zero
    for v, _k, _x in VARIANTS:
        assert not is_done(new_state()), v


def test_charges_hand_calculated() -> None:
    # sell 100 + 100 and buy back 50 + 50, lot 65: sell turnover 13,000, buy 6,500
    # brokerage 4 x 20 = 80; exchange 19,500 x 0.0356% = 6.942; SEBI 19,500 x 0.0001% = 0.0195; STT 13,000 x 0.1% = 13; stamp 6,500 x 0.003% = 0.195;
    # GST 18% x (80 + 6.942 + 0.0195) = 15.653; total 115.81
    assert costs(100, 100, 50, 50, LOT) == pytest.approx(115.81, abs=0.01)
    r = settle("hold", 100, 100, step("hold", 100, 100, new_state(), 50, 50), LOT)
    assert r and r["gross"] == 6500.0 and r["net"] == pytest.approx(6500 - 115.81, abs=0.01)


# ------------------------------------------------------------------ the re-arming rule
def test_every_recrossing_counts_after_thirty_minutes_below_sixty_at_most_three_a_day() -> None:
    t0 = datetime(2026, 11, 16, 5, 0, tzinfo=UTC)
    arm: dict[str, Any] = {"count": 0, "armed": True, "below_since": None}
    arm, fire = next_arm(arm, 59.0, t0)
    assert not fire and arm["armed"]  # below 60 before the first trigger: nothing
    arm, fire = next_arm(arm, 61.0, t0 + timedelta(minutes=1))
    assert fire and arm["count"] == 1 and not arm["armed"]
    arm, fire = next_arm(arm, 70.0, t0 + timedelta(minutes=2))
    assert not fire  # still above: no second position
    arm, _ = next_arm(arm, 55.0, t0 + timedelta(minutes=3))  # below: the 30-minute clock starts
    arm, fire = next_arm(arm, 62.0, t0 + timedelta(minutes=20))  # back above after 17 minutes: the clock is cleared, not re-armed
    assert not fire and arm["below_since"] is None and not arm["armed"]
    arm, _ = next_arm(arm, 50.0, t0 + timedelta(minutes=21))
    arm, _ = next_arm(arm, 52.0, t0 + timedelta(minutes=40))
    assert not arm["armed"]  # 19 minutes below
    arm, _ = next_arm(arm, 52.0, t0 + timedelta(minutes=52))
    assert arm["armed"]  # 31 minutes below: armed again
    arm, fire = next_arm(arm, 64.0, t0 + timedelta(minutes=53))
    assert fire and arm["count"] == 2
    arm, _ = next_arm(arm, 40.0, t0 + timedelta(minutes=54))
    arm, _ = next_arm(arm, 40.0, t0 + timedelta(minutes=90))
    arm, fire = next_arm(arm, 66.0, t0 + timedelta(minutes=91))
    assert fire and arm["count"] == 3
    arm, _ = next_arm(arm, 40.0, t0 + timedelta(minutes=92))
    arm, _ = next_arm(arm, 40.0, t0 + timedelta(minutes=140))
    arm, fire = next_arm(arm, 70.0, t0 + timedelta(minutes=141))
    assert not fire and arm["count"] == 3  # the cap of three a day
    same, fire = next_arm({"count": 0, "armed": True, "below_since": None}, None, t0)
    assert not fire and same == {"count": 0, "armed": True, "below_since": None}  # no score: nothing changes


# ------------------------------------------------------------------ the service on a made-up chain (a flow test, not market data)
class FakeObs:
    """Samples every minute of 16 Nov 2026 from 09:30 to 15:30 IST: spot drifts, premiums follow a simple model; strikes every 50."""

    def __init__(self) -> None:
        self.t0 = datetime(2026, 11, 16, 9, 30, tzinfo=IST).astimezone(UTC)
        self.spot = {i: 25250.0 + (i // 10) * 2.0 - (90.0 if 70 <= i < 90 else 0.0) for i in range(0, 361)}  # a dip of 90 points between 10:40 and 11:00

    def samples(self, underlying: str, expiry: str, since: datetime | None = None, until: datetime | None = None, limit: int = 5000) -> list[Sample]:
        out = []
        for i in range(0, 361):
            at = self.t0 + timedelta(minutes=i)
            if (since is None or at >= since) and (until is None or at <= until):
                out.append(Sample(i + 1, expiry, at, self.spot[i], None, False, "test", None, i + 1))
        return out

    def contracts(self, sample_id: int) -> dict[tuple[float, int], Contract]:
        i = sample_id - 1
        s = self.spot[i]
        out = {}
        for k in range(24800, 25701, 50):
            tv = max(8.0, 90.0 - abs(s - k) * 0.5 - i * 0.05)
            out[(float(k), CALL)] = Contract(round(max(s - k, 0) + tv, 2), 1000, 900, 10)
            out[(float(k), PUT)] = Contract(round(max(k - s, 0) + tv, 2), 1000, 900, 10)
        return out


class FakeStraddle:
    def __init__(self, scores: dict[str, list[float | None]], clock: list[datetime]) -> None:
        self.scores, self.clock = scores, clock

    def summary(self, expiry: str | None = None) -> dict[str, Any]:
        now = self.clock[0]
        i = int((now - datetime(2026, 11, 16, 9, 30, tzinfo=IST).astimezone(UTC)).total_seconds() // 60)
        seq = self.scores["weekly" if expiry == "2026-11-17" else "monthly"]
        score = seq[min(i, len(seq) - 1)]
        return {
            "status": "ok", "session": "2026-11-16", "expiry": expiry, "expiry_day": False, "quality": {"live": True, "age_minutes": 0.5},
            "environment": {"seller": {"score": score}, "buyer": {"score": 40.0}, "evidence": {"orderflow": -45.0, "heavy15": -10.0, "cvd": -5.0, "vwap_pct": -0.05, "positioning": 12.0}},
            "regime": {"label": "volatility compression", "path_efficiency_30m": 0.28, "accel": {"ratio": 0.8}},
            "realised_vs_implied": {"iv_now": 17.1, "iv_open": 20.5, "gap": {"15": 9.4, "60": 4.9}, "implied_move_pts": 200.0},
            "climate": {"label": "favourable"}, "history": {"spot": [25250.0, 25252.0]},
        }  # fmt: skip


def make_service(tmp_path: Path, weekly_scores: list[float | None], monthly_scores: list[float | None] | None = None) -> tuple[ForwardService, list[datetime]]:
    clock = [datetime(2026, 11, 16, 9, 30, tzinfo=IST).astimezone(UTC)]

    async def expiries() -> tuple[str | None, str | None]:
        return "2026-11-17", "2026-11-24"

    svc = ForwardService(
        observations=FakeObs(), straddle=FakeStraddle({"weekly": weekly_scores, "monthly": monthly_scores or [50.0]}, clock), store=ForwardStore(tmp_path), underlying="NIFTY",
        expiries=expiries, lot=LOT, clock=lambda: clock[0],
    )  # fmt: skip
    return svc, clock


def run_day(svc: ForwardService, clock: list[datetime], until_minute: int = 360) -> None:
    for i in range(0, until_minute + 1):
        clock[0] = datetime(2026, 11, 16, 9, 30, tzinfo=IST).astimezone(UTC) + timedelta(minutes=i)
        asyncio.run(svc.tick())


def test_a_trigger_opens_a_straddle_and_a_strangle_with_every_variant_and_settles_at_1520(tmp_path: Path) -> None:
    # the weekly seller score is 55 until 10:00, then 62 for the rest of the day; the monthly never reaches 60
    scores = [55.0] * 30 + [62.0] * 400
    svc, clock = make_service(tmp_path, scores)
    run_day(svc, clock, 29)
    assert svc.store.counts() == {"open": 0, "settled": 0, "days": 0}  # nothing before the score reaches 60
    run_day(svc, clock, 31)
    assert svc.store.counts()["open"] == 2  # at 10:01 (first minute at 62): a straddle and a strangle of the weekly cohort
    t = {x["structure"]: x for x in svc.store.open_trades()}
    atm = t["straddle"]["ce_strike"]
    assert t["straddle"]["pe_strike"] == atm and t["strangle"]["ce_strike"] == atm + 50 and t["strangle"]["pe_strike"] == atm - 50
    assert t["straddle"]["cohort"] == "weekly" and t["straddle"]["expiry"] == "2026-11-17" and t["straddle"]["seller"] == 62.0 and t["straddle"]["regime"] == "volatility compression"
    assert t["straddle"]["context"]["dte"] == 1 and t["straddle"]["context"]["orderflow"] == -45.0 and t["straddle"]["context"]["rv_gap_15"] == 9.4
    assert len(svc.store.variants_of(t["straddle"]["id"])) == len(VARIANTS) == 11
    run_day(svc, clock, 360)  # to 15:30
    assert svc.store.counts() == {"open": 0, "settled": 2, "days": 1}  # no second trigger: the score never dipped; the cap and re-arming are not touched
    settled = svc.store.settled()
    for tr in settled:
        assert tr["settled_at"] and tr["eod"]["range_pts"] > 0 and set(tr["variants"]) == {v for v, _, _ in VARIANTS}
        hold = tr["variants"]["hold"]
        assert hold["gross"] == pytest.approx(((tr["ce0"] - hold["ce_exit"]) + (tr["pe0"] - hold["pe_exit"])) * LOT, abs=0.01)
        assert hold["net"] == pytest.approx(hold["gross"] - hold["cost"], abs=0.01) and hold["cost"] > 80 and hold["reason"] == "close 15:20"
    # the 90-point dip between 10:40 and 11:00 puts a 30%+ rise on a put leg: a stop variant fired, hold did not
    st = next(x for x in settled if x["structure"] == "straddle")
    assert st["variants"]["leg30"]["stopped_at"] is not None and st["variants"]["hold"]["stopped_at"] is None


def test_both_cohorts_and_every_recrossing_are_tracked_separately(tmp_path: Path) -> None:
    # weekly: above 60 at once, below for 40 minutes (10:00-10:40), above again from 10:40; monthly above 60 from 10:30
    weekly = [62.0] * 30 + [50.0] * 40 + [63.0] * 400
    monthly = [50.0] * 60 + [61.0] * 400
    svc, clock = make_service(tmp_path, weekly, monthly)
    run_day(svc, clock, 100)
    rows = svc.store.open_trades()
    by = {(r["cohort"], r["n"], r["structure"]) for r in rows}
    assert by == {("weekly", 1, "straddle"), ("weekly", 1, "strangle"), ("weekly", 2, "straddle"), ("weekly", 2, "strangle"), ("monthly", 1, "straddle"), ("monthly", 1, "strangle")}
    second = next(r for r in rows if r["cohort"] == "weekly" and r["n"] == 2)
    assert datetime.fromisoformat(second["trigger_at"]).astimezone(IST).strftime("%H:%M") >= "10:40"
    assert {r["expiry"] for r in rows if r["cohort"] == "monthly"} == {"2026-11-24"}
    # restarting the service changes nothing: the arming state and the positions are in the store
    svc2, clock2 = make_service(tmp_path, weekly, monthly)
    clock2[0] = clock[0]
    asyncio.run(svc2.tick())
    assert len(svc2.store.open_trades()) == len(rows)


def test_a_minute_without_prices_keeps_the_trigger_armed(tmp_path: Path) -> None:
    svc, clock = make_service(tmp_path, [62.0] * 400)
    clock[0] = datetime(2026, 11, 16, 8, 0, tzinfo=IST).astimezone(UTC)  # before the first stored sample: no sample to price the entry from
    now = datetime(2026, 11, 16, 9, 30, tzinfo=IST).astimezone(UTC) - timedelta(minutes=30)
    assert svc.run_once(now, "2026-11-17", None)["opened"] == 0  # outside the entry window anyway
    clock[0] = datetime(2026, 11, 16, 14, 40, tzinfo=IST).astimezone(UTC)
    assert svc.run_once(clock[0], "2026-11-17", None)["opened"] == 0  # after 14:30: no entries
    assert svc.store.arm_get("2026-11-16", "weekly") == {"count": 0, "armed": True, "below_since": None}


# ------------------------------------------------------------------ metrics
def trade(i: int, regime: str, nets: dict[str, float], at: str = "2026-11-16T05:00:00+00:00", **extra: Any) -> dict[str, Any]:
    return {
        "id": i, "session": "2026-11-16", "cohort": "weekly", "structure": extra.pop("structure", "straddle"), "n": 1, "trigger_at": at, "regime": regime, "seller": extra.pop("seller", 64.0),
        "buyer": 40.0, "context": extra.pop("context", {"dte": 1, "weekday": 0, "orderflow": -45.0, "rv_gap_15": 9.0, "path_eff_30": 0.28}), "eod": extra.pop("eod", {"trend_day": False}),
        "variants": {v: {"net": n, "worst": -100.0, "stopped_at": "10:30" if v.startswith("leg") else None, "reason": "x"} for v, n in nets.items()},
    }  # fmt: skip


def test_variant_table_and_equity_by_hand() -> None:
    ts = [
        trade(1, "volatility compression", {"hold": 1000.0, "leg40": 1000.0}, "2026-11-10T05:00:00+00:00"),
        trade(2, "volatility expansion", {"hold": -400.0, "leg40": -2000.0}, "2026-11-11T05:00:00+00:00"),
        trade(3, "volatility compression", {"hold": 600.0, "leg40": -500.0}, "2026-11-12T05:00:00+00:00"),
    ]
    tab = {r["variant"]: r for r in analytics.variant_table(ts)}
    h, leg = tab["hold"], tab["leg40"]
    assert (h["n"], h["wins"], h["total"], h["avg"], h["best"], h["worst"]) == (3, 2, 1200.0, 400.0, 1000.0, -400.0)
    assert h["win_rate"] == 66.7 and h["profit_factor"] == 4.0  # 1,600 won against 400 lost
    assert h["max_drawdown"] == -400.0  # equity 1000, 600, 1200: the dip from 1000 to 600
    assert (leg["total"], leg["max_drawdown"], leg["stop_rate"]) == (-1500.0, -2500.0, 100.0)  # equity 1000, -1000, -1500: peak 1000 to -1500
    assert tab["comb15"]["n"] == 0  # a variant with no result is empty, not zero
    eq = analytics.equity(ts)
    assert eq["curves"]["hold"] == [1000.0, 600.0, 1200.0] and eq["curves"]["leg40"] == [1000.0, -1000.0, -1500.0]


def test_breakdown_by_regime_and_other_conditions() -> None:
    ts = [
        trade(1, "volatility compression", {"hold": 1000.0}, seller=62.0),
        trade(2, "volatility compression", {"hold": 600.0}, seller=72.0, context={"dte": 0, "weekday": 1, "orderflow": 40.0, "rv_gap_15": 3.0, "path_eff_30": 0.5}, eod={"trend_day": True}),
        trade(3, "volatility expansion", {"hold": -400.0}),
    ]
    b = analytics.breakdown(ts, "regime")
    rows = {r["bucket"]: r for r in b["rows"]}
    assert rows["volatility compression"]["n"] == 2 and rows["volatility compression"]["cells"]["hold"] == {"n": 2, "avg": 800.0, "win_rate": 100.0, "total": 1600.0}
    assert rows["volatility expansion"]["cells"]["hold"]["avg"] == -400.0 and rows["volatility compression"]["cells"]["leg40"]["avg"] is None
    assert b["min_trades"] == 20 and "seller" in b["options"]
    seller = {r["bucket"] for r in analytics.breakdown(ts, "seller")["rows"]}
    assert seller == {"60-65", "70-75"}
    assert {r["bucket"] for r in analytics.breakdown(ts, "flow")["rows"]} == {"bearish (below -30)", "bullish (above +30)"}
    assert {r["bucket"] for r in analytics.breakdown(ts, "dte")["rows"]} == {"expiry day", "1 day"}
    assert {r["bucket"] for r in analytics.breakdown(ts, "day_type")["rows"]} == {"range day", "trend day"}
    assert {r["bucket"] for r in analytics.breakdown(ts, "time")["rows"]} == {"10:30-11:30"}  # 05:00 UTC is 10:30 IST
    assert analytics.filtered(ts + [trade(4, "x", {"hold": 1.0}, structure="strangle")], "strangle")[0]["id"] == 4


# ------------------------------------------------------------------ the API and the overview of a settled day
def test_the_overview_of_a_settled_day_and_the_api(tmp_path: Path) -> None:
    svc, clock = make_service(tmp_path, [62.0] * 400)
    run_day(svc, clock, 360)
    o = svc.overview()
    assert o["meta"]["counts"] == {"open": 0, "settled": 2, "days": 1} and o["meta"]["rules"]["exit"] == "15:20 IST the same day" and o["meta"]["min_trades"] == 20
    assert {v["variant"] for v in o["variants"]} == {v for v, _, _ in VARIANTS} and all(v["n"] == 2 for v in o["variants"])
    assert len(o["trades"]) == 2 and o["trades"][0]["nets"]["hold"] is not None and o["equity"]["times"]
    only = svc.overview(structure="strangle", cohort="weekly")
    assert all(v["n"] == 1 for v in only["variants"]) and svc.overview(cohort="monthly")["variants"][0]["n"] == 0
    app = make_app(tmp_path / "app")
    with TestClient(app) as c:
        app.state.forward = svc
        body = c.get("/api/forward/overview", params={"structure": "straddle", "dim": "time"}).json()
        assert body["filters"] == {"structure": "straddle", "cohort": "all"} and body["breakdown"]["dimension"] == "time"
        assert c.get("/api/forward/overview", params={"structure": "bogus"}).status_code == 422
