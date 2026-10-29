"""Adversarial and property tests added by the 29 Oct 2026 audit.

Each test targets a way the analysis could silently mislead: repainting signals, look-ahead in replay, leakage between sessions,
statuses that flicker, paper trades that fill before their signal, and gates that pass on noise. Random walks use fixed seeds;
inputs are synthetic by design (these are invariants, not market claims).
"""

from __future__ import annotations

import random
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.intraday import evaluate as ev
from app.intraday import labels as lb
from app.intraday import paper, setups
from app.intraday import price_structure as ps
from app.intraday.costs import CostModel
from app.intraday.features import Point
from app.intraday.service import IntradayService
from app.intraday.store import IntradayStore
from app.market.flow import FlowTracker
from app.prediction.flows_store import FlowsStore
from app.prediction.history_store import HistoryStore
from tests.unit.test_intraday import EXP, ist, seed

IST = ZoneInfo("Asia/Kolkata")
B = datetime(2026, 10, 29, 9, 15, tzinfo=IST)


def walk(seed_: int, n: int = 300, start: float = 24000.0, step: float = 6.0) -> list[Point]:
    rng = random.Random(seed_)
    px, out = start, []
    for i in range(n):
        px += rng.gauss(0, step)
        out.append(Point(B + timedelta(minutes=i, seconds=10), round(px, 2)))
    return out


# ---------------------------------------------------------------------------------------------- repainting
@pytest.mark.parametrize("seed_", range(8))
def test_confirmed_swings_never_disappear_when_more_data_arrives(seed_: int) -> None:
    pts = walk(seed_)
    seen: set[tuple[str, int, float]] = set()
    for n in range(20, len(pts), 3):
        closes = ps.minute_closes(pts[:n], pts[n - 1].at + timedelta(minutes=1))
        now = {(s["kind"], s["minute"], s["price"]) for s in ps.swings(closes)}
        assert seen <= now, f"a swing that was reported earlier vanished at sample {n}: {sorted(seen - now)[:3]}"
        seen |= now


@pytest.mark.parametrize("seed_", range(12))
def test_breakout_status_never_regresses_after_confirmation_and_replays_identically(seed_: int) -> None:
    pts = walk(seed_, 120, step=9.0)
    base = ps.analyze(pts[:15], pts[14].at + timedelta(minutes=1))["ranges"][0]
    assert base["state"] == "complete"
    confirmed_dir = None
    for n in range(16, len(pts)):
        b = ps.analyze(pts[:n], pts[n - 1].at + timedelta(minutes=1), or_minutes=(15,))["breakout"]
        again = ps.analyze(pts[:n], pts[n - 1].at + timedelta(minutes=1), or_minutes=(15,))["breakout"]
        assert b == again  # deterministic
        if b is None:
            continue
        if confirmed_dir == b["direction"] and b["status"] not in ("CONFIRMED", "FAILED", "INVALIDATED"):
            pytest.fail(f"confirmed break flickered to {b['status']} at sample {n}")
        confirmed_dir = b["direction"] if b["status"] == "CONFIRMED" else (None if b["status"] in ("FAILED", "INVALIDATED") else confirmed_dir)


def test_a_dip_into_the_buffer_does_not_unconfirm_a_confirmed_breakout() -> None:
    OR = [24000, 24020, 24000, 24040, 24020, 24000, 24020, 24040, 24020, 24000, 24020, 24000, 24040, 24020, 24000]
    # 3 clear closes (>24044), then a close at 24042: beyond the boundary but inside the buffer. Still CONFIRMED.
    path = [Point(B + timedelta(minutes=i, seconds=10), float(s)) for i, s in enumerate(OR + [24045, 24046, 24047, 24042])]
    assert ps.analyze(path, path[-1].at + timedelta(minutes=1))["breakout"]["status"] == "CONFIRMED"
    # 31 minutes of grinding just above the line after confirmation must not expire it
    long = [*OR, 24045, 24046, 24047, *([24042] * 40)]
    path = [Point(B + timedelta(minutes=i, seconds=10), float(s)) for i, s in enumerate(long)]
    assert ps.analyze(path, path[-1].at + timedelta(minutes=1))["breakout"]["status"] == "CONFIRMED"


def test_a_break_right_after_a_failure_is_a_new_candidate() -> None:
    OR = [24000, 24020, 24000, 24040, 24020, 24000, 24020, 24040, 24020, 24000, 24020, 24000, 24040, 24020, 24000]
    path = [Point(B + timedelta(minutes=i, seconds=10), float(s)) for i, s in enumerate(OR + [24045, 24046, 24030, 24050])]
    b = ps.analyze(path, path[-1].at + timedelta(minutes=1))["breakout"]
    assert b["status"] == "UNCONFIRMED" and b["previous"] == "up FAILED"  # the failing close was already the close back inside


# ---------------------------------------------------------------------------------------------- labels
@pytest.mark.parametrize("seed_", range(6))
def test_labels_depend_only_on_later_samples_and_touches_are_consistent(seed_: int) -> None:
    pts = walk(seed_, 120)
    for i in range(0, 60, 7):
        a = lb.label_at(pts, i, 15, 1.0)
        mutated = [Point(p.at, p.spot * 3) if k < i else p for k, p in enumerate(pts)]  # rewrite the past
        assert lb.label_at(mutated, i, 15, 1.0) == a
        if a["outcome"] in ("up", "down"):
            assert abs(a["mfe_pts"] if a["outcome"] == "up" else a["mae_pts"]) >= a["barrier_pts"] - 1e-9  # a touch means the excursion reached the barrier
            assert 0 < a["minutes_to_touch"] <= 15
        if a["outcome"] == "none":
            assert a["mfe_pts"] < a["barrier_pts"] and -a["mae_pts"] < a["barrier_pts"]  # neither barrier was reached


def test_the_first_barrier_touched_wins_even_if_the_other_is_touched_later() -> None:
    up_then_down = [Point(B + timedelta(minutes=i), s) for i, s in enumerate([24000, 24010, 24030, 24000, 23960] + [23960] * 12)]
    assert lb.label_at(up_then_down, 0, 15, 1.0)["outcome"] == "up"


# ---------------------------------------------------------------------------------------------- paper trading
@pytest.mark.parametrize("seed_", range(10))
def test_paper_trades_obey_every_invariant_on_random_paths(seed_: int) -> None:
    pts = walk(seed_, 330, step=8.0)
    r = setups.RiskConfig()
    c = CostModel()
    trades = paper.simulate_session(pts, 1.0, r, c)
    last_exit = None
    for t in trades:
        assert t["entry_at"] > t["signal_at"]  # filled after the signal, never on it
        assert t["exit_at"] > t["entry_at"]
        assert last_exit is None or t["entry_at"] >= last_exit  # one trade at a time
        last_exit = t["exit_at"]
        assert t["net_rupees"] == pytest.approx(t["gross_rupees"] - t["charges_rupees"] - t["slippage_rupees"], abs=0.05)
        assert t["charges_rupees"] > 0 and t["slippage_rupees"] > 0 and t["lots"] >= 1
        assert t["reward_risk_at_fill"] >= r.min_reward_risk
        assert datetime.fromisoformat(t["entry_at"]).astimezone(IST).time() < r.cutoff or t["exit_reason"] in ("cutoff", "time")
    assert len(trades) <= r.max_trades_per_day
    assert len({(t["setup"], t["direction"]) for t in trades}) == len(trades)  # one per setup and direction
    # the daily loss limit stops new trades: after cumulative losses beyond it, nothing more is opened
    run = 0.0
    for t in trades:
        assert run > -r.max_daily_loss_rs
        run += t["net_rupees"]


def test_paper_never_trades_when_every_sample_is_the_same_price() -> None:
    assert paper.simulate_session([Point(B + timedelta(minutes=i), 24000.0) for i in range(200)], 1.0) == []


def test_costs_always_reduce_the_result_and_scale_with_lots() -> None:
    c = CostModel()
    for lots in (1, 2, 5):
        one = c.round_trip(24000, 24100, lots, "long")
        assert one["net_rupees"] < one["gross_rupees"] and one["charges_rupees"] > 0
    assert c.round_trip(24000, 24100, 4, "long")["gross_rupees"] == 4 * c.round_trip(24000, 24100, 1, "long")["gross_rupees"]
    assert c.round_trip(24000, 24100, 4, "long")["charges_rupees"] < 4 * c.round_trip(24000, 24100, 1, "long")["charges_rupees"] + 1e-6  # flat brokerage is shared... never more than 4x


# ---------------------------------------------------------------------------------------------- evaluation honesty
def test_shuffled_labels_never_pass_the_gate_and_the_model_has_no_edge() -> None:
    wins = 0
    for seed_ in range(4):
        rng = random.Random(seed_)
        rows = []
        for s in range(22):
            for _ in range(60):
                rows.append({"session": f"2026-09-{s + 1:02d}" if s < 30 else "x", "features": {"ret_15m": rng.gauss(0, 1), "ret_5m": rng.gauss(0, 1), "er_5m": rng.random()}, "outcome": rng.choice(ev.CLASSES)})
        r = ev.walk_forward(rows, 3, stride=2)
        assert r["gate"]["show_probabilities"] is False
        if r["models"]["logistic"]["log_loss"] < r["models"]["majority"]["log_loss"] - 0.01:
            wins += 1
    assert wins == 0  # a pure coin must not look better than the majority baseline by a margin


def test_the_gate_demands_a_statistically_convincing_edge_not_just_a_majority_of_sessions() -> None:
    sess = [{"logistic": 1.0, "majority": 1.0 + (0.002 if i % 3 else -0.002)} for i in range(24)]  # ahead in 2/3 of sessions by a hair
    res = {"sessions": 70, "models": {"logistic": {"calibration": {"ece": 0.01}}, "majority": {}}, "per_session_log_loss": sess}
    g = ev.gate(res)
    assert g["show_probabilities"] is False and any("mean log-loss gain" in x for x in g["reasons"])
    strong = {"sessions": 70, "models": res["models"], "per_session_log_loss": [{"logistic": 0.9, "majority": 1.0}] * 20 + [{"logistic": 1.01, "majority": 1.0}] * 2}
    assert ev.gate(strong)["show_probabilities"] is True and ev.gate(strong)["sign_test_p"] < 0.001
    coin = {"sessions": 70, "models": res["models"], "per_session_log_loss": [{"logistic": 0.9, "majority": 1.0}] * 9 + [{"logistic": 1.2, "majority": 1.0}] * 8}
    assert ev.gate(coin)["show_probabilities"] is False and any("sign test" in x for x in ev.gate(coin)["reasons"])


def test_sign_test_values() -> None:
    assert ev.sign_test_p(5, 5) == pytest.approx(1 / 32) and ev.sign_test_p(0, 10) == 1.0 and ev.sign_test_p(13, 17) == pytest.approx(0.02452, abs=1e-5)


# ---------------------------------------------------------------------------------------------- flow tracker
def test_flow_volume_is_conserved_and_classes_never_exceed_the_traded_volume() -> None:
    rng = random.Random(3)
    f = FlowTracker("F")
    vol, px = 1000, 24000.0
    t0 = B.astimezone(UTC)
    f.update(t0, "09:15", "d", vol, px, 23999.0, 24001.0)
    start = vol
    for i in range(1, 400):
        vol += rng.choice([0, 0, 5, 20, 100])
        px += rng.choice([-1.0, 0.0, 1.0])
        f.update(t0 + timedelta(seconds=i), f"09:{15 + i // 60:02d}", "d", vol, px, px - 1, px + 1, rng.randint(1, 900), rng.randint(1, 900))
    p = f.public()
    assert p["buy_volume"] + p["sell_volume"] + p["unclassified_volume"] == vol - start  # nothing created or lost
    assert -1 <= p["depth_imbalance"] <= 1 and -100 <= p["cvd_pct"] <= 100


# ---------------------------------------------------------------------------------------------- replay look-ahead
def test_replay_never_reads_institutional_flows_published_after_that_day(tmp_path: Path) -> None:
    times = [ist(9, 15) + timedelta(minutes=i) for i in range(60)]
    flows = FlowsStore(tmp_path)
    rows = []
    for session, net in (("2026-10-27", 111.0), ("2026-10-28", 222.0), ("2026-10-29", 333.0), ("2026-10-30", 444.0)):
        rows += [{"session": session, "category": "FII/FPI", "buy": 1.0, "sell": 1.0, "net": net}, {"session": session, "category": "DII", "buy": 1.0, "sell": 1.0, "net": net}]
    flows.save_cash(rows)
    svc = IntradayService(seed(tmp_path, times), HistoryStore(tmp_path), flows, IntradayStore(tmp_path), clock=lambda: ist(16, 0).astimezone(UTC))
    out = svc.replay("2026-10-29", EXP, "10:00")["summary"]
    inst = str(out.get("institutional"))
    assert "444.0" not in inst and "333.0" not in inst  # neither the next day's figure nor the same day's evening publication
    assert out["institutional"] is None or out["institutional"]["session"] == "2026-10-28"
    assert "ml" not in out  # readiness counts describe the present, so a replay does not show them


def test_replay_of_an_earlier_moment_equals_the_live_view_at_that_moment(tmp_path: Path) -> None:
    times = [ist(9, 15) + timedelta(minutes=i) for i in range(60)]
    live_at_10 = IntradayService(seed(tmp_path, times), HistoryStore(tmp_path), FlowsStore(tmp_path), IntradayStore(tmp_path), clock=lambda: ist(10, 0).astimezone(UTC)).summary(EXP)
    later = IntradayService(seed(tmp_path / "y", times), HistoryStore(tmp_path / "y"), FlowsStore(tmp_path / "y"), IntradayStore(tmp_path / "y"), clock=lambda: ist(16, 0).astimezone(UTC))
    replayed = later.replay("2026-10-29", EXP, "10:00")["summary"]
    for key in ("assessment", "price", "options", "regime", "scenarios", "levels", "volatility", "positioning", "structure", "setups"):
        a, b = replayed[key], live_at_10[key]
        if key == "structure":  # the same instant, written in IST here and UTC there
            a, b = {**a, "as_of": None}, {**b, "as_of": None}
        assert a == b, key  # the replay shows exactly what the live view showed then


# ---------------------------------------------------------------------------------------------- research pipeline join
def test_research_joins_stored_feature_rows_to_barrier_labels_from_the_stored_path(tmp_path: Path) -> None:
    """End to end on the real captured chain: end-of-day build -> feature rows -> research labels. Spot is constant in the
    capture, so every outcome is 'none'; the point is that the join between rows and the stored path works and nothing is dropped silently."""
    from datetime import date

    from app.intraday.service import IntradayService
    from app.prediction.sources.yahoo import RawRow
    from tests.unit.test_lifecycle import DAY, fill, service

    obs = fill(tmp_path, 120)
    hist = HistoryStore(tmp_path)
    rows, d, i = [], date(2026, 7, 1), 0
    while d < DAY:
        if d.weekday() < 5:
            c = 25000 * (1 + (0.005 if i % 2 else -0.005))
            rows.append(RawRow(d, c, c * 1.004, c * 0.996, c, None))
            i += 1
        d += timedelta(days=1)
    hist.insert_bars("NIFTY50", rows, source="yahoo", run_id="t")
    service(tmp_path, obs, ist(16, 0)).run()
    svc = IntradayService(obs, hist, FlowsStore(tmp_path), IntradayStore(tmp_path), clock=lambda: ist(17, 0).astimezone(UTC))
    r = svc.research(15)
    assert r["sessions"] == 1 and r["status"] == "insufficient" and "needs more than 3 labelled sessions" in r["reason"]
    # 120 samples - 15 warm-up = 105 rows; the last ~15 minutes cannot be labelled (horizon not covered): they are counted as dropped, not lost
    assert r["rows"] + r["dropped"]["missing"] + r["dropped"]["ambiguous"] == 105
    assert r["rows"] >= 80 and r["dropped"]["missing"] >= 10
    assert r["horizon_minutes"] == 15 and r["features_version"] == "if-2"


# ---------------------------------------------------------------------------------------------- live / stale / historical labels
@pytest.mark.parametrize(
    ("clock", "data", "live"),
    [((10, 15), "LIVE", True), ((10, 20), "DELAYED", False), ((10, 40), "STALE", False), ((16, 0), "HISTORICAL", False)],
)
def test_every_derived_block_carries_the_same_honest_data_status(tmp_path: Path, clock: tuple[int, int], data: str, live: bool) -> None:
    times = [ist(9, 15) + timedelta(minutes=i) for i in range(60)]  # last sample 10:14
    svc = IntradayService(seed(tmp_path, times), HistoryStore(tmp_path), FlowsStore(tmp_path), IntradayStore(tmp_path), clock=lambda: ist(*clock).astimezone(UTC))
    out = svc.summary(EXP)
    assert out["volatility"]["data"] == data and out["positioning"]["data"] == data
    assert out["structure"]["data"] == ("LIVE" if live else "HISTORICAL") and (live or out["structure"]["breakout"] is None)
    if not live:
        assert out["volatility"]["interpretation"] == []
        assert "data is not live" in out["setups"]["global_blockers"]
        assert all(c["status"] != "ACTIVE" for c in out["setups"]["candidates"]) and out["setups"]["decision"].startswith("NO TRADE")


def test_yesterdays_samples_never_make_a_live_score_today(tmp_path: Path) -> None:
    times = [ist(9, 15, date(2026, 10, 28)) + timedelta(minutes=i) for i in range(60)]
    svc = IntradayService(seed(tmp_path, times), HistoryStore(tmp_path), FlowsStore(tmp_path), IntradayStore(tmp_path), clock=lambda: ist(10, 0).astimezone(UTC))
    out = svc.summary(EXP)
    assert out["assessment"]["score"] is None and out["assessment"]["label"] == "Insufficient data"  # price needs today's samples
    assert out["market"]["samples_today"] == 0 and out["market"]["mode"] in ("stale", "historical")
    assert out["volatility"]["data"] in ("STALE", "HISTORICAL") and svc.store.count() == 0  # nothing recorded as a live score
    assert out["setups"]["active"] == 0


# ---------------------------------------------------------------------------------------------- failures are shown, not hidden
def test_a_failing_breadth_service_is_reported_as_failed_not_as_turned_off(tmp_path: Path) -> None:
    class Broken:
        enabled = True

        def summary(self, now: datetime) -> dict:
            raise RuntimeError("boom")

    times = [ist(9, 15) + timedelta(minutes=i) for i in range(30)]
    svc = IntradayService(seed(tmp_path, times), HistoryStore(tmp_path), FlowsStore(tmp_path), IntradayStore(tmp_path), clock=lambda: ist(9, 45).astimezone(UTC), market=Broken())
    rows = {h["source"]: h for h in svc.summary(EXP)["health"]}
    assert rows["Market breadth"]["status"] == "api_failure" and "stock breadth failed: RuntimeError: boom" in rows["Market breadth"]["detail"]


def test_a_failing_tick_handler_is_counted_and_visible_and_never_reaches_the_feed(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from app.stream.models import FeedEvent, LiveTick
    from tests.conftest import make_app

    with TestClient(make_app(tmp_path)) as c:
        stream = c.app.state.stream
        stream.book.internal_keys = {"nse_cm|7"}

        def bad(_t: LiveTick) -> None:
            raise ValueError("x")

        stream.on_internal = bad
        tick = LiveTick(key="nse_cm|7", kind="scrip", exchange_segment="nse_cm", instrument_token="7", ltp=1.0, received_at=datetime.now(UTC))
        stream._handle(FeedEvent(kind="tick", tick=tick), feed=None)  # type: ignore[arg-type]
        assert stream.on_internal_errors == 1 and stream.book.internal_ticks()["nse_cm|7"].ltp == 1.0  # the tick itself was stored
        assert c.get("/api/market/status").json()["stream"]["handler_errors"] == 1


# ---------------------------------------------------------------------------------------------- garbage in
def test_nan_inf_zero_and_missing_inputs_give_none_or_a_clear_error_never_a_number() -> None:
    import math
    from datetime import date as d

    from app.intraday import positioning, volatility

    nan, inf = float("nan"), float("inf")
    assert volatility.implied_vol(0, nan, 24000, 24000, 0.01) is None and volatility.implied_vol(0, inf, 24000, 24000, 0.01) is None
    assert volatility.implied_vol(0, 50.0, nan, 24000, 0.01) is None and volatility.implied_vol(0, 50.0, 24000, 24000, nan) is None
    sf = volatility.surface({(24000.0, 0): nan, (24000.0, 1): nan}, 24000.0, d(2026, 11, 3), B)
    assert sf["atm_iv"] is None and sf["straddle"] is not None and math.isnan(sf["straddle"])  # the NaN is visible, not turned into a volatility
    assert lb.label_at([Point(B, 0.0), Point(B + timedelta(minutes=20), 0.0)], 0, 15, 1.0)["outcome"] == "missing"
    with pytest.raises(ValueError, match="at least one lot"):
        CostModel().round_trip(100, 101, 0, "long")
    with pytest.raises(ValueError, match="positive"):
        CostModel().cost_points(0.0)
    assert setups.detect(setups.Context(spot=0.0, minute=0, clock=B.time(), structure={}, regime=None, daily_sd_pct=None))["decision"].startswith("NO TRADE")
    assert positioning.window_pcr({}, 24000.0)["all"]["pcr_oi"] is None and positioning.side_classification({}, {}, 24000.0)["strike_rows"] == []
    assert ps.analyze([], B)["breakout"] is None and ev.walk_forward([], 3)["status"] == "insufficient"
