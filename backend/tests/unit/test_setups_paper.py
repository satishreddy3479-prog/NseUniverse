"""Costs, setup candidates, risk gating, paper trading and the if-2 dataset enrichment.

Paths are SYNTHETIC (hand-built around an index level of 24000 so cost and sizing arithmetic is realistic); every expected value
below is calculated by hand in the comments. They are formula/rule checks, not market data.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.intraday import enrich, paper, setups
from app.intraday import price_structure as ps
from app.intraday import volatility as vol
from app.intraday.costs import CostModel
from app.intraday.dataset import build_rows
from app.intraday.features import Point

IST = ZoneInfo("Asia/Kolkata")
B = datetime(2026, 10, 29, 9, 15, tzinfo=IST)
OR = [24000, 24020, 24000, 24040, 24020, 24000, 24020, 24040, 24020, 24000, 24020, 24000, 24040, 24020, 24000]  # minutes 0-14: 24000-24040, width 40
SD = 1.0


def pts(spots: list[float]) -> list[Point]:
    return [Point(B + timedelta(minutes=i, seconds=10), s) for i, s in enumerate(spots)]


# ---------------------------------------------------------------------------------------------------- costs
def test_cost_legs_match_a_hand_calculation() -> None:
    c = CostModel()
    # sell 1 lot at 25000: turnover 1,625,000. brokerage 20 + exchange 29.7375 + SEBI 1.625 + GST 18% of 51.3625 (9.2453) + STT 0.05% = 812.5
    assert c.leg(25000, 1, "sell") == pytest.approx(20 + 29.7375 + 1.625 + 9.24525 + 812.5, abs=1e-3)
    # buy leg: no STT, stamp duty 0.002% = 32.5 instead
    assert c.leg(25000, 1, "buy") == pytest.approx(20 + 29.7375 + 1.625 + 9.24525 + 32.5, abs=1e-3)


def test_round_trip_net_result_and_short_direction() -> None:
    c = CostModel()
    r = c.round_trip(25000, 25050, 1, "long")
    # gross 50 x 65 = 3250; charges 93.108 (buy 25000) + 874.807 (sell 25050); slippage 2 x 0.5 x 65 = 65
    assert r["gross_rupees"] == 3250 and r["slippage_rupees"] == 65 and r["charges_rupees"] == pytest.approx(967.91, abs=0.01)
    assert r["net_rupees"] == pytest.approx(3250 - 65 - 967.91, abs=0.02)
    s = c.round_trip(25050, 25000, 2, "short")  # short: sells 25050 first, buys back 25000; 2 lots
    assert s["gross_points"] == 50 and s["gross_rupees"] == 6500 and s["net_rupees"] < s["gross_rupees"]
    assert c.round_trip(25000, 25000, 1, "long")["net_rupees"] < 0  # a flat trade still pays costs
    assert 14 < c.cost_points(25000) < 18  # about 15.9 index points round trip at 25000 per lot


# ---------------------------------------------------------------------------------------------------- setups
def ctx_for(spots: list[float], **kw) -> setups.Context:
    p = pts(spots)
    now = p[-1].at + timedelta(minutes=1)
    return setups.Context(spot=spots[-1], minute=len(spots) - 1, clock=time(10, 30), structure=ps.analyze(p, now), regime=kw.pop("regime", None), daily_sd_pct=SD, **kw)


def test_confirmed_opening_range_breakout_is_active_with_hand_calculated_levels() -> None:
    # closes 24045, 24046, 24047 are beyond the 24040 high and the buffer (0.1 x 40 = 4 -> above 24044): CONFIRMED on the third
    d = setups.detect(ctx_for(OR + [24045, 24046, 24047]))
    c = d["candidates"][0]
    assert c["setup"] == "OR_BREAKOUT" and c["direction"] == "long" and c["status"] == "ACTIVE"
    # stop = boundary 24040, target = 24040 + width 40 = 24080, entry 24047: risk 7, reward 33, reward/risk 4.71
    assert (c["entry_ref"], c["stop"], c["target"], c["risk_pts"], c["reward_pts"], c["reward_risk"]) == (24047, 24040, 24080, 7, 33, 4.71)
    assert c["lots"] == 4 and c["max_loss_rs"] == 1820  # floor(2000 / (7 x 65)) = 4 lots; 4 x 7 x 65
    assert c["net_reward_after_costs_pts"] == pytest.approx(33 - CostModel().cost_points(24047, 1, None), abs=0.05)
    assert c["probability"] is None and "no validated model" in c["probability_note"]
    assert d["decision"] == "CANDIDATE" and d["read_only"] is True and d["active"] == 1


def test_an_extended_breakout_is_rejected_not_chased() -> None:
    d = setups.detect(ctx_for(OR + [24060, 24080, 24098]))  # price is already past the 24080 target
    c = d["candidates"][0]
    assert c["status"] == "REJECTED" and any("reward/risk" in x for x in c["rejected_because"])
    assert d["decision"] == "NO TRADE: INSUFFICIENT EVIDENCE"


def test_developing_break_is_only_watched_and_a_failed_break_is_a_poor_fade() -> None:
    w = setups.detect(ctx_for(OR + [24045, 24046]))["candidates"][0]
    assert w["status"] == "WATCH" and "wait for 3 closes" in w["entry_condition"]
    f = setups.detect(ctx_for(OR + [24045, 24046, 24030, 24030]))["candidates"][0]
    # failed: back inside; short from 24030, stop at the failed extreme 24046, target the midpoint 24020 -> reward 10 vs risk 16
    assert f["setup"] == "OR_FAILED" and f["direction"] == "short" and f["reward_risk"] == 0.62 and f["status"] == "REJECTED"


def test_risk_controls_block_an_otherwise_valid_setup() -> None:
    path = OR + [24045, 24046, 24047]
    r = setups.RiskConfig()
    for kw, text in [
        ({"day": setups.DayState(trades=4)}, "daily trade limit"),
        ({"day": setups.DayState(pnl_rs=-5000)}, "daily loss limit"),
        ({"day": setups.DayState(consecutive_losses=2)}, "consecutive losses"),
        ({"spread_pts": 3.0}, "spread"),
        ({"event_risk": True}, "event risk"),
        ({"data_live": False}, "not live"),
    ]:
        c = setups.detect(ctx_for(path, **kw), r)["candidates"][0]
        assert c["status"] == "BLOCKED" and any(text in x for x in c["blocked_because"]), kw
    late = ctx_for(path)
    late.clock = time(15, 5)
    assert setups.detect(late, r)["candidates"][0]["status"] == "BLOCKED"  # after the 15:00 cutoff
    tight = setups.RiskConfig(max_loss_per_trade_rs=100)  # 100 rupees cannot cover even one lot with a 7-point stop (455)
    c = setups.detect(ctx_for(path), tight)["candidates"][0]
    assert c["status"] == "REJECTED" and c["lots"] == 0 and any("loss limit" in x for x in c["rejected_because"])


def test_vwap_reclaim_candidate_and_range_watch() -> None:
    v = {"price": 24095.0, "vwap": 24092.0, "events": [{"event": "vwap_reclaim", "minute": 40}], "side": "above"}
    c = setups.detect(ctx_for(OR + [24020] * 30, vwap=v, regime="Sideways consolidation"))["candidates"][0]
    # U15 = 1.0 x 1% x sqrt(15/375) x 24020 = 48.04; stop = 24092 - 24.02, target = 24095 + 48.04: risk 27.02, reward 48.04
    assert c["setup"] == "VWAP_RECLAIM" and c["direction"] == "long" and c["reward_risk"] == pytest.approx(48.04 / 27.02, abs=0.01) and c["status"] == "ACTIVE"
    old = {"price": 24095.0, "vwap": 24092.0, "events": [{"event": "vwap_reclaim", "minute": 5}], "side": "above"}  # too old to act on
    rb = setups.detect(ctx_for(OR + [24020] * 30, vwap=old, regime="Sideways consolidation"))["candidates"][0]
    assert rb["setup"] == "RANGE_BOUND" and rb["status"] == "WATCH" and rb["levels"] == [24000, 24040]


# ---------------------------------------------------------------------------------------------------- paper trading
def test_paper_trade_enters_on_the_next_sample_and_exits_at_the_target() -> None:
    path = OR + [24045, 24046, 24047, 24048, 24060, 24081]  # signal after the 3rd closes beyond; fill on the next sample 24048
    t = paper.simulate_session(pts(path), SD)
    assert len(t) == 1
    x = t[0]
    assert (x["setup"], x["direction"], x["fill"], x["stop"], x["target"], x["lots"]) == ("OR_BREAKOUT", "long", 24048, 24040, 24080, 4)  # risk at the signal 7 -> 4 lots
    assert x["exit_reason"] == "target" and x["exit_price"] == 24080 and x["gross_points"] == 32 and x["gross_rupees"] == 32 * 65 * 4
    assert x["net_rupees"] == pytest.approx(x["gross_rupees"] - x["charges_rupees"] - x["slippage_rupees"], abs=0.02) and x["net_rupees"] < x["gross_rupees"]
    assert x["entry_at"] > x["signal_at"]  # never filled on the signal sample


def test_a_gap_through_the_stop_is_suffered_at_the_sample_price() -> None:
    t = paper.simulate_session(pts(OR + [24045, 24046, 24047, 24048, 24035, 24035]), SD)
    assert len(t) == 1 and t[0]["exit_reason"] == "stop" and t[0]["exit_price"] == 24035  # not rounded up to the 24040 stop
    assert t[0]["gross_points"] == -13 and t[0]["net_rupees"] < -13 * 65 * 4


def test_time_stop_one_trade_per_setup_and_no_trade_in_a_flat_market() -> None:
    drift = OR + [24045, 24046, 24047, 24048] + [24050] * 40
    t = paper.simulate_session(pts(drift), SD)
    assert len(t) == 1 and t[0]["exit_reason"] == "time" and t[0]["minutes_held"] == 30.0  # 30-minute hold, then out; no second entry on the same signal
    assert paper.simulate_session(pts(OR + [24020] * 40), SD) == []
    # the opening-range rules need no volatility scale (stop and target come from the range); rules built on U15 do
    assert len(paper.simulate_session(pts(OR + [24045, 24046, 24047, 24048, 24081]), None)) == 1
    nosd = setups.Context(spot=24020, minute=44, clock=time(10, 30), structure=ps.analyze(pts(OR + [24020] * 30), B + timedelta(minutes=46)), regime="Sideways", daily_sd_pct=None, vwap={"price": 24095.0, "vwap": 24092.0, "events": [{"event": "vwap_reclaim", "minute": 40}]})
    assert [c["setup"] for c in setups.detect(nosd)["candidates"]] == ["RANGE_BOUND"]  # no U15 -> no VWAP candidate


def test_daily_trade_limit_is_enforced_by_the_simulation() -> None:
    r = setups.RiskConfig(max_trades_per_day=0)
    assert paper.simulate_session(pts(OR + [24045, 24046, 24047, 24048, 24081]), SD, r) == []


def test_summary_metrics_by_hand_and_the_minimum_trade_rule() -> None:
    mk = lambda net, s="OR_BREAKOUT": {"net_rupees": net, "gross_rupees": net + 100, "charges_rupees": 80.0, "slippage_rupees": 20.0, "minutes_held": 10.0, "setup": s, "exit_reason": "target" if net > 0 else "stop"}  # noqa: E731
    s = paper.summarize([mk(2000), mk(-500)], 3)
    assert s["trades"] == 2 and s["net_rupees"] == 1500 and s["win_rate"] == 0.5 and s["expectancy_rupees"] == 750
    assert s["profit_factor"] == 4.0 and s["max_drawdown_rupees"] == 500 and s["costs_and_slippage_rupees"] == 200
    assert s["conclusion"].startswith("no conclusion: 2 trades is fewer than 30")
    assert paper.summarize([], 5)["conclusion"] == "no trades were triggered on the stored sessions"
    big = paper.summarize([mk(-10)] * 30, 9)
    assert big["conclusion"].startswith("net of costs the rules lost money") and big["profit_factor"] == 0.0


# ---------------------------------------------------------------------------------------------------- if-2 enrichment
def priced_chain(f: float, sigma: float, at: datetime) -> dict[tuple[float, int], float]:
    t = vol.years_to_expiry(date(2026, 11, 3), at)
    return {(float(k), s): vol.price(s, f, k, t, sigma, 0.06) for k in range(23700, 24500, 50) for s in (0, 1)}


def test_enrichment_is_as_of_the_sample_and_missing_stays_missing() -> None:
    n = 40
    p = pts([24000.0 + i for i in range(n)])
    prices = {i: priced_chain(24060 + i, 0.15 + (0.01 if i >= 20 else 0.0), p[i].at) for i in range(n)}
    t30 = p[30].at
    market = {
        "fut": [(t30 - timedelta(minutes=1), {"v": 1000, "cvd": 100, "ltp": 24101.0, "atp": 24100.0, "di": 0.2})],
        "nifty50": [(p[10].at, {"advancing": 5, "declining": 3, "idx": 0.1, "equal_weight_return": 0.2}), (t30, {"advancing": 6, "declining": 2, "idx": 0.3, "equal_weight_return": 0.4})],
    }
    e = enrich.Enricher(p, date(2026, 11, 3), lambda i: prices[i], market)
    f = e(30)
    assert f["iv_atm"] == pytest.approx(16.0, abs=0.05) and f["iv_chg_15m"] == pytest.approx(1.0, abs=0.1)  # 16 % now vs 15 % 15 minutes earlier
    assert f["fut_vwap_dist_pct"] == pytest.approx(1 / 24100 * 100, abs=1e-4) and f["fut_cvd_share"] == 0.1 and f["fut_depth_imb"] == 0.2
    assert f["ad_balance"] == 0.5 and f["breadth_eq_return"] == 0.4  # (6-2)/(6+2)
    assert f["breadth_mom_15m"] is None  # the reference sample 15 minutes earlier is older than 3 minutes: missing, not guessed
    assert f["breakout_state"] == 0.0  # market data exists this session and no breakout was recorded
    early = e(5)
    assert early["fut_vwap_dist_pct"] is None and early["ad_balance"] is None and early["iv_chg_15m"] is None  # nothing at or before it
    nomarket = enrich.Enricher(p, date(2026, 11, 3), lambda i: prices[i], {})
    assert nomarket(30)["breakout_state"] is None and nomarket(30)["ad_balance"] is None and nomarket(30)["iv_atm"] is not None


def test_a_later_sample_can_never_change_an_earlier_row() -> None:
    n = 40
    p = pts([24000.0 + i for i in range(n)])
    prices = {i: priced_chain(24060, 0.15, p[i].at) for i in range(n)}
    base_m = {"fut": [(p[20].at, {"v": 1000, "cvd": 100, "ltp": 24101.0, "atp": 24100.0, "di": 0.2})]}
    later_m = {"fut": [*base_m["fut"], (p[30].at, {"v": 9999, "cvd": -9999, "ltp": 1.0, "atp": 99999.0, "di": -1.0})]}
    a = enrich.Enricher(p, date(2026, 11, 3), lambda i: prices[i], base_m)(22)
    b = enrich.Enricher(p, date(2026, 11, 3), lambda i: prices[i], later_m)(22)
    assert a == b  # a recording made at sample 30 does not exist for sample 22


def test_dataset_rows_carry_the_extra_columns_and_labels_use_only_later_samples() -> None:
    n = 40
    p = pts([24000.0 + i for i in range(n)])
    from app.intraday.features import Quote, daily_context

    chain = {(24000.0, 0): Quote(10, 100, 90, 5)}

    c = daily_context([], date(2026, 10, 29))
    rows = build_rows(p, lambda i: chain, 23990.0, c, date(2026, 11, 3), date(2026, 10, 29), extra=lambda i: {"iv_atm": float(i)})
    assert rows and all("iv_atm" in r["features"] for r in rows) and rows[0]["features"]["iv_atm"] == 15.0  # warm-up 15 samples
    assert rows[0]["labels"]["fwd_5m"] == round((p[20].spot / p[15].spot - 1) * 100, 6)  # the label is the return to a LATER sample
