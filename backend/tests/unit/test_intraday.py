"""Intraday command center: features, rules-based score, ledger and API.

Option-chain inputs are the REAL Kotak chains captured on 2026-10-28 (tests/fixtures), replayed as
if they had been sampled at chosen times. Spot paths for the price formulas are small hand-built
sequences whose arithmetic is written out in comments; they test formulas, they are not market data.
"""

from __future__ import annotations

import math
import sqlite3
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.domain.models import DataSource, ExpiryKind, OptionChainSnapshot
from app.domain.normalize import normalize_option_chain
from app.intraday.features import (
    CALL,
    IST,
    PUT,
    DailyBar,
    DailyContext,
    Point,
    Quote,
    as_of,
    daily_context,
    efficiency_ratio,
    in_session,
    options_features,
    price_features,
    realized_vol_pct,
    session_phase,
)
from app.intraday.sentiment import (
    SCORE_CONFIG,
    FlowInput,
    GlobalInput,
    assess,
    global_component,
    institutional_component,
    label_for,
    price_component,
    unavailable,
)
from app.intraday.service import IntradayService
from app.intraday.store import IntradayStore
from app.prediction.calendar import TradingCalendar
from app.prediction.flows_store import FlowsStore
from app.prediction.history_store import HistoryStore
from app.storage.observations import ObservationStore, quote_values
from tests.conftest import make_app
from tests.replay import load_payload

EXP = "2026-11-03"


def ist(h: int, m: int, d: date = date(2026, 10, 29)) -> datetime:
    return datetime(d.year, d.month, d.day, h, m, tzinfo=IST)


def real_chain(at: datetime, sid: str, expiry: str = EXP) -> OptionChainSnapshot:
    return normalize_option_chain(
        load_payload(expiry), snapshot_id=sid, session_id="t", underlying="NIFTY",
        expiry=date.fromisoformat(expiry), expiry_kinds=[ExpiryKind.WEEKLY], source=DataSource.SNAPSHOT,
        retrieved_at=at, requested_strike_count=200,
    )  # fmt: skip


def as_chain(snap: OptionChainSnapshot) -> dict[tuple[float, int], Quote]:
    out: dict[tuple[float, int], Quote] = {}
    for r in snap.rows:
        for side, q in ((CALL, r.call), (PUT, r.put)):
            c = quote_values(q)
            if c is not None:
                out[(r.strike, side)] = Quote(c.ltp, c.oi, c.oi_prev, c.volume)
    return out


# ------------------------------------------------------------------------------- session clock


class TestSession:
    def test_phases_follow_the_ist_clock(self) -> None:
        assert session_phase(ist(8, 59), True) == "pre_market"
        assert session_phase(ist(9, 5), True) == "pre_open"
        assert session_phase(ist(9, 15), True) == "opening"
        assert session_phase(ist(10, 0), True) == "morning"
        assert session_phase(ist(12, 0), True) == "midday"
        assert session_phase(ist(14, 0), True) == "afternoon"
        assert session_phase(ist(15, 10), True) == "closing"
        assert session_phase(ist(15, 30), True) == "post_market"

    def test_holiday_from_the_exchange_calendar_is_closed(self) -> None:
        cal = TradingCalendar.load()
        holiday = next(iter(cal.holidays))
        assert (
            session_phase(datetime.combine(holiday, ist(11, 0).timetz()), cal.is_session(holiday))
            == "closed"
        )
        # unknown calendar answer falls back to the weekday rule
        assert session_phase(ist(11, 0, date(2026, 10, 31)), None) == "closed"  # Saturday

    def test_in_session_keeps_only_today_regular_hours_sorted_unique(self) -> None:
        p = [Point(ist(9, 16), 1.0), Point(ist(9, 10), 2.0), Point(ist(15, 31), 3.0),
             Point(ist(9, 16), 4.0), Point(ist(10, 0, date(2026, 10, 28)), 5.0), Point(ist(9, 15), 6.0)]  # fmt: skip
        assert [x.spot for x in in_session(p, date(2026, 10, 29))] == [6.0, 1.0]


# ------------------------------------------------------------------------------- price formulas


def path(values: list[float], start: datetime | None = None, step_min: int = 1) -> list[Point]:
    start = start or ist(9, 15)
    return [Point(start + timedelta(minutes=i * step_min), v) for i, v in enumerate(values)]


class TestPrice:
    def test_efficiency_ratio_hand_calculated(self) -> None:
        # moves +2, -1, +2 -> net 3, path 5 -> 0.6
        assert efficiency_ratio(path([100, 102, 101, 103])) == pytest.approx(0.6)
        assert efficiency_ratio(path([100, 101])) is None  # too few points

    def test_realized_vol_hand_calculated(self) -> None:
        pts = path([100, 101, 100])
        expected = math.sqrt(math.log(1.01) ** 2 + math.log(100 / 101) ** 2) * 100
        assert realized_vol_pct(pts) == pytest.approx(expected)

    def test_as_of_respects_the_slack_and_never_looks_ahead(self) -> None:
        pts = path([100, 101, 102], step_min=10)  # 09:15, 09:25, 09:35
        assert as_of(pts, ist(9, 30), 3) is None  # last at/before is 09:25, 5 min old > 3
        assert as_of(pts, ist(9, 27), 3).spot == 101  # type: ignore[union-attr]
        assert as_of(pts, ist(9, 14), 3) is None  # nothing before

    def test_features_hand_calculated(self) -> None:
        # 61 one-minute samples from 09:15: 20000 rising 2 points a minute to 20120
        pts = path([20000 + 2 * i for i in range(61)])
        ctx = DailyContext(date(2026, 10, 28), 20100.0, 19900.0, 19950.0, 1.0, 1.2, 60)
        f = price_features(pts, pts[-1].at, ctx, feed_prev_close=20000.0)
        assert f.change == pytest.approx(120.0)
        assert f.change_pct == pytest.approx(0.6)
        assert f.prev_close_source.startswith("Kotak")
        assert f.gap_pct == pytest.approx(0.0)
        assert (f.or_low, f.or_high, f.or_samples) == (20000, 20028, 15)  # 09:15..09:29
        assert f.returns_pct[60] == pytest.approx((20120 / 20000 - 1) * 100)
        assert f.returns_pct[5] == pytest.approx((20120 / 20110 - 1) * 100)
        assert f.er_session == pytest.approx(1.0)
        assert f.position_in_range == pytest.approx(1.0)
        assert f.vwap is None and "no traded volume" in f.vwap_reason

    def test_prev_close_falls_back_to_the_daily_bar_and_missing_stays_none(self) -> None:
        ctx = DailyContext(date(2026, 10, 28), None, None, 19950.0)
        f = price_features([], ist(9, 0), ctx, None)
        assert f.prev_close == 19950.0 and f.last is None and f.change is None
        assert f.returns_pct == {}

    def test_daily_context_uses_only_sessions_before_today(self) -> None:
        bars = [
            DailyBar(date(2026, 8, 1) + timedelta(days=i), 100, 101 + i % 3, 99, 100 + (i % 5))
            for i in range(70)
        ]
        today = bars[65].session
        ctx = daily_context(bars, today)
        assert ctx.prev_session == bars[64].session  # bar dated today (and after) are ignored
        assert ctx.prev_close == bars[64].close
        assert ctx.daily_sd_pct is not None and ctx.sessions_used == 60


# ------------------------------------------------------------------------- options on real data


class TestOptions:
    def test_pcr_and_oi_change_on_the_real_captured_chain(self) -> None:
        snap = real_chain(ist(10, 0), "r1")
        ch = as_chain(snap)
        spot = snap.underlying_ltp
        assert spot is not None
        f = options_features(ch, spot, None, None, each_side=10)
        # independent recomputation: 21 strikes nearest spot, sums over present values only
        ks = sorted({k for k, _ in ch})
        i = min(range(len(ks)), key=lambda j: (abs(ks[j] - spot), ks[j]))
        uni = ks[max(0, i - 10) : i + 11]
        ce = sum(
            ch[(k, CALL)].oi or 0 for k in uni if (k, CALL) in ch and ch[(k, CALL)].oi is not None
        )
        pe = sum(
            ch[(k, PUT)].oi or 0 for k in uni if (k, PUT) in ch and ch[(k, PUT)].oi is not None
        )
        assert f.strikes == len(uni) == 21
        assert f.ce_oi == ce and f.pe_oi == pe
        assert f.pcr_oi == pytest.approx(pe / ce)
        dce = sum(ch[(k, CALL)].oi - ch[(k, CALL)].oi_prev for k in uni  # type: ignore[operator]
                  if (k, CALL) in ch and ch[(k, CALL)].oi is not None and ch[(k, CALL)].oi_prev is not None)  # fmt: skip
        assert f.ce_oi_chg == dce
        atm = ks[i]
        assert f.atm_strike == atm
        assert f.straddle == pytest.approx(ch[(atm, CALL)].ltp + ch[(atm, PUT)].ltp)  # type: ignore[operator]

    def test_missing_values_are_counted_never_zero(self) -> None:
        ch = {(100.0, CALL): Quote(5.0, None, None, None), (100.0, PUT): Quote(4.0, 10, 8, 3)}
        f = options_features(ch, 100.0, None, None)
        assert f.ce_oi is None and f.pe_oi == 10 and f.pcr_oi is None
        assert f.missing == {"oi": 1, "volume": 1, "oi_change": 1}

    def test_change_since_first_sample(self) -> None:
        first = {(100.0, CALL): Quote(10.0, 100, 90, 1), (100.0, PUT): Quote(10.0, 100, 90, 1)}
        now = {(100.0, CALL): Quote(8.0, 100, 90, 1), (100.0, PUT): Quote(11.0, 150, 90, 1)}
        f = options_features(now, 100.0, first, 100.0)
        assert f.pcr_oi_first == 1.0 and f.pcr_oi == 1.5 and f.pcr_oi_change == pytest.approx(0.5)
        assert f.straddle_change_pct == pytest.approx((19 / 20 - 1) * 100)


# ---------------------------------------------------------------------------- scoring rules


class TestScore:
    def ctx(self) -> DailyContext:
        return DailyContext(date(2026, 10, 28), 20100.0, 19900.0, 20000.0, 1.0, 1.2, 60)

    def test_price_component_hand_calculated(self) -> None:
        pts = path([20000 + 2 * i for i in range(61)])
        f = price_features(pts, pts[-1].at, self.ctx(), 20000.0)
        c = price_component(f, self.ctx())
        # change 0.6% / sd 1.0 -> 0.6 ; 30-min return (20120/20060-1)=0.299% / (1.0*sqrt(30/375)=0.2828) -> clipped 1.0
        r30 = (20120 / 20060 - 1) * 100
        expected = (0.6 + min(1.0, r30 / math.sqrt(30 / 375))) / 2
        assert c.available and c.score == pytest.approx(expected)

    def test_missing_groups_are_excluded_and_coverage_drops(self) -> None:
        pts = path([20000 + 2 * i for i in range(61)])
        f = price_features(pts, pts[-1].at, self.ctx(), 20000.0)
        price = price_component(f, self.ctx())
        comps = [price, unavailable("breadth", "b", "x"), unavailable("sectors", "s", "x"),
                 unavailable("options", "o", "x"), unavailable("global", "g", "x"), institutional_component(None)]  # fmt: skip
        a = assess(comps, f)
        w = SCORE_CONFIG["weights"]
        assert a.coverage == pytest.approx(w["price"] / sum(w.values()))
        assert a.coverage < SCORE_CONFIG["min_coverage"]
        assert a.score is None and a.label == "Insufficient data"  # never a guess from one group
        assert all(c.score is None for c in comps[1:])  # unavailable is None, not 0

    def test_weighted_average_over_available_groups(self) -> None:
        pts = path([20000 + 2 * i for i in range(61)])
        f = price_features(pts, pts[-1].at, self.ctx(), 20000.0)
        price = price_component(f, self.ctx())
        glob = global_component([GlobalInput("SPX", "S&P 500", "2026-10-28", -1.0, 1.0, True),
                                 GlobalInput("USDINR", "USD/INR", "2026-10-28", 0.0, 0.3, True)])  # fmt: skip
        inst = institutional_component(FlowInput("2026-10-28", -3000.0, 500.0, True))
        opt = unavailable("options", "o", "x")
        comps = [
            price,
            unavailable("breadth", "b", "x"),
            unavailable("sectors", "s", "x"),
            opt,
            glob,
            inst,
        ]
        a = assess(comps, f)
        w = SCORE_CONFIG["weights"]
        g = (-1.0 + 0.0) / 2
        i = math.tanh(-1.0)
        expected = (w["price"] * price.score + w["global"] * g + w["institutional"] * i) / (
            w["price"] + w["global"] + w["institutional"]
        )  # type: ignore[operator]
        assert a.coverage == pytest.approx(
            (w["price"] + w["global"] + w["institutional"]) / sum(w.values())
        )
        assert a.score == pytest.approx(expected)
        assert a.label == label_for(expected)

    def test_stale_flows_are_shown_but_not_scored(self) -> None:
        c = institutional_component(FlowInput("2026-10-20", 900.0, 100.0, False))
        assert not c.available and c.score is None and "2026-10-20" in c.reason

    def test_labels(self) -> None:
        assert label_for(0.6) == "Bullish" and label_for(0.3) == "Moderately bullish"
        assert label_for(0.0) == "Neutral / range-bound" and label_for(-0.3) == "Moderately bearish"
        assert label_for(-0.7) == "Bearish"


# --------------------------------------------------------------------- service, ledger, API


def seed(tmp: Path, times: list[datetime], expiry: str = EXP) -> ObservationStore:
    """Record the real captured chain at the given times (the chain content is the real capture)."""
    obs = ObservationStore(tmp)
    for n, t in enumerate(times):
        obs.record_snapshot(real_chain(t.astimezone(UTC), f"s{n}", expiry), unchanged=False)
    return obs


class TestService:
    def make(self, tmp: Path, times: list[datetime], now: datetime) -> IntradayService:
        return IntradayService(seed(tmp, times), HistoryStore(tmp), FlowsStore(tmp), IntradayStore(tmp),
                               clock=lambda: now.astimezone(UTC))  # fmt: skip

    def test_samples_after_now_are_never_used(self, tmp_path: Path) -> None:
        times = [ist(9, 15) + timedelta(minutes=i) for i in range(30)]
        svc = self.make(tmp_path, times, ist(9, 24) + timedelta(seconds=30))
        out = svc.summary(EXP)
        assert out["market"]["samples_today"] == 10  # 09:15..09:24 only
        assert out["market"]["last_sample_at"] == times[9].astimezone(UTC).isoformat()

    def test_live_phase_without_daily_history_is_insufficient_and_says_why(
        self, tmp_path: Path
    ) -> None:
        times = [ist(9, 15) + timedelta(minutes=i) for i in range(20)]
        svc = self.make(tmp_path, times, ist(9, 35))
        out = svc.summary(EXP)
        assert out["market"]["phase"] == "opening" and out["market"]["mode"] == "live"
        a = out["assessment"]
        assert a["score"] is None and a["label"] == "Insufficient data"
        price = next(c for c in a["components"] if c["key"] == "price")
        assert "daily volatility" in price["reason"]
        assert any(
            h["source"] == "Market breadth" and h["status"] == "not_available"
            for h in out["health"]
        )
        assert out["ml"]["status"] == "collecting" and out["ml"]["labelled_sessions"] == 0 and out["ml"]["model_trained"] is False
        assert out["ml"]["next"]["at_sessions"] == 5
        assert out["scenarios"] == []  # no invented scenarios without an assessment

    def test_stale_and_historical_modes(self, tmp_path: Path) -> None:
        times = [ist(9, 15) + timedelta(minutes=i) for i in range(5)]
        assert (
            self.make(tmp_path / "a", times, ist(10, 0)).summary(EXP)["market"]["mode"] == "stale"
        )
        assert (
            self.make(tmp_path / "b", times, ist(18, 0)).summary(EXP)["market"]["mode"]
            == "historical"
        )
        assert (
            self.make(tmp_path / "c", [], ist(10, 0)).summary(EXP)["market"]["mode"]
            == "unavailable"
        )


class TestLedger:
    def row(self, sample_id: int = 1) -> dict:
        return {"session": "2026-10-29", "expiry": EXP, "sample_id": sample_id, "sample_utc": "2026-10-29T04:00:00+00:00",
                "version": "v", "spot": 1.0, "score": 0.3, "label": "Moderately bullish", "coverage": 0.6,
                "regime": "Uptrend", "volatility": "Normal", "components": []}  # fmt: skip

    def test_append_only_and_idempotent(self, tmp_path: Path) -> None:
        s = IntradayStore(tmp_path)
        assert s.record(self.row()) is True
        assert s.record(self.row()) is False  # same sample + version stored once
        assert s.count() == 1
        db = sqlite3.connect(s.path)
        with pytest.raises(sqlite3.DatabaseError):
            db.execute("UPDATE scores SET score = 1")
        with pytest.raises(sqlite3.DatabaseError):
            db.execute("DELETE FROM scores")

    def test_survives_restart(self, tmp_path: Path) -> None:
        s = IntradayStore(tmp_path)
        s.record(self.row())
        s.close()
        assert (
            IntradayStore(tmp_path).session_rows("2026-10-29", EXP)[0]["label"]
            == "Moderately bullish"
        )


def test_api_summary_and_scores(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path)) as c:
        r = c.get("/api/intraday/summary", params={"expiry": EXP})
        assert r.status_code == 200
        body = r.json()
        for k in ("market", "assessment", "levels", "health", "ml", "context", "config"):
            assert k in body
        assert body["assessment"]["provisional"] is True
        vwap = next(x for x in body["levels"] if x["name"] == "VWAP")
        assert vwap["value"] is None
        r2 = c.get("/api/intraday/scores", params={"expiry": EXP, "session": "2026-10-29"})
        assert r2.status_code == 200 and r2.json()["rows"] == []
        assert c.get("/api/intraday/summary", params={"expiry": "bad"}).status_code == 422


def test_full_session_is_scored_recorded_once_and_explained(tmp_path: Path) -> None:
    """Daily bars below are hand-made scale inputs (a 0.5%-ish daily sd), not market data."""
    from app.prediction.sources.yahoo import RawRow

    hist = HistoryStore(tmp_path)
    rows = []
    d, i = date(2026, 7, 1), 0
    while d < date(2026, 10, 29):
        if d.weekday() < 5:
            c = 25000 * (1 + (0.005 if i % 2 else -0.005))
            rows.append(RawRow(d, c, c * 1.004, c * 0.996, c, None))
            i += 1
        d += timedelta(days=1)
    hist.insert_bars("NIFTY50", rows, source="yahoo", run_id="t")
    times = [ist(9, 15) + timedelta(minutes=i) for i in range(40)]
    now = ist(9, 55)
    svc = IntradayService(seed(tmp_path, times), hist, FlowsStore(tmp_path), IntradayStore(tmp_path),
                          clock=lambda: now.astimezone(UTC))  # fmt: skip
    out = svc.summary(EXP)
    a = out["assessment"]
    # price (0.35) + options (0.20) available; breadth, sectors, global, flows missing -> 0.55
    assert a["coverage"] == pytest.approx(0.55)
    assert a["score"] is not None and a["label"] != "Insufficient data"
    assert out["daily"]["daily_sd_pct"] == pytest.approx(
        1.0, rel=0.05
    )  # alternating +/-0.5% closes
    assert 1 <= len(out["scenarios"]) <= 3 and all(x["probability"] is None for x in out["scenarios"])
    assert len(out["scenarios"]) + len(out["scenarios_ruled_out"]) == 3  # every scenario is either shown or explained away
    assert out["narrative"].startswith("Current assessment:")
    vol = out["volatility"]  # REAL captured chain: implied volatility must come out as a plausible NIFTY number
    # captured 28 Oct chain, 3 Nov expiry: ATM IV about 16.5 %, forward 22703.85 from put-call parity at 22700
    assert vol["status"] == "ok" and vol["atm_iv"] == pytest.approx(16.54, abs=0.1) and vol["forward"] == pytest.approx(22703.85, abs=0.5)
    assert vol["forward_source"] == "put-call parity at 22700" and vol["skew_25d_put_minus_call"] > 0
    # the straddle should be close to 0.8 of the one-standard-deviation move implied by the same IV
    assert vol["expected_move_straddle_pts"] / vol["expected_move_iv_1sd_pts"] == pytest.approx(0.8, abs=0.03)
    assert vol["data"] in ("LIVE", "HISTORICAL") and set(vol["iv_change_pts"]) == {"5", "15", "30"}
    assert svc.store.count() == 1
    svc._cache.clear()
    svc.summary(EXP)
    assert svc.store.count() == 1  # same sample, same version: recorded once


@pytest.mark.parametrize(("close", "warn"), [(22749.75, False), (22698.85, True)])
def test_feed_previous_close_is_cross_checked(tmp_path: Path, close: float, warn: bool) -> None:
    """The captured chain's feed previous close is 22,749.75. A stored 28-Oct bar that agrees keeps
    the feed value; one that disagrees replaces it and raises a visible warning."""
    from app.prediction.sources.yahoo import RawRow

    hist = HistoryStore(tmp_path)
    hist.insert_bars(
        "NIFTY50",
        [RawRow(date(2026, 10, 28), close, close, close, close, None)],
        source="yahoo",
        run_id="t",
    )
    now = ist(9, 30)
    svc = IntradayService(seed(tmp_path, [ist(9, 15), ist(9, 20)]), hist, FlowsStore(tmp_path), IntradayStore(tmp_path),
                          clock=lambda: now.astimezone(UTC))  # fmt: skip
    out = svc.summary(EXP)
    assert out["price"]["prev_close"] == pytest.approx(close)
    assert any(h["source"] == "Previous close check" for h in out["health"]) is warn


# ----------------------------------------------------------------------- scenario relevance


class TestScenarioRelevance:
    """Only scenarios supported by the evidence are shown; the others are listed with the reason."""

    def setup(self, scores: dict[str, float | None], trend: bool, regime: str):
        from app.intraday.sentiment import SCORE_CONFIG, Component, assess, scenarios

        w = SCORE_CONFIG["weights"]
        comps = [Component(k, k, w[k], sc is not None, sc, "" if sc is not None else "n/a") for k, sc in scores.items()]
        vals = [20000 + 2 * i for i in range(61)] if trend else [20000 + (i % 2) * 2 for i in range(61)]
        f = price_features(path(vals), ist(10, 15), DailyContext(date(2026, 10, 28), 20100.0, 19900.0, 20000.0, 1.0, 1.2, 60), 20000.0)
        a = assess(comps, f)
        return scenarios(a, f, options_features({}, None, None, None), DailyContext(), {"primary": regime}), a

    def test_choppy_session_with_only_bullish_evidence_shows_range_first_and_rules_out_bearish(self) -> None:
        (shown, ruled), a = self.setup({"price": 0.3, "options": 0.4, "global": 0.2}, trend=False, regime="Mean-reverting / choppy")
        assert a.direction == "Up"
        assert [x["name"] for x in shown] == ["Range-bound consolidation", "Bullish continuation / recovery"]
        assert [x["name"] for x in ruled] == ["Bearish continuation / reversal"]
        assert "none of the 3 available evidence groups is below -0.10" in ruled[0]["reason"] and "3 are bullish" in ruled[0]["reason"]

    def test_mixed_evidence_shows_all_three(self) -> None:
        (shown, ruled), _ = self.setup({"price": 0.3, "options": -0.4, "global": 0.2}, trend=False, regime="Sideways consolidation")
        assert len(shown) == 3 and ruled == [] and shown[0]["name"] == "Range-bound consolidation"

    def test_a_clean_strong_trend_rules_out_range_and_the_opposite_direction(self) -> None:
        (shown, ruled), a = self.setup({"price": 0.9, "options": 0.8, "global": 0.5}, trend=True, regime="Uptrend")
        assert a.score is not None and a.score >= 0.5
        assert [x["name"] for x in shown] == ["Bullish continuation / recovery"]
        assert {x["name"] for x in ruled} == {"Range-bound consolidation", "Bearish continuation / reversal"}

    def test_no_directional_evidence_falls_back_to_range_bound_only(self) -> None:
        (shown, ruled), _ = self.setup({"price": 0.05, "options": -0.05, "global": 0.0}, trend=False, regime="Sideways consolidation")
        assert [x["name"] for x in shown] == ["Range-bound consolidation"]
        assert len(ruled) == 2

    def test_no_assessment_means_no_scenarios_at_all(self) -> None:
        (shown, ruled), a = self.setup({"price": None, "options": 0.4}, trend=False, regime="Unclassified")
        assert a.score is None and shown == [] and ruled == []


# ------------------------------------------------------------------------------- regime


class TestRegime:
    """The 29 Oct case: NIFTY +171 points with a zigzagging one-minute path was called 'sideways'."""

    ctx = DailyContext(date(2026, 10, 28), 22778.0, 22497.0, 22698.85, 0.705, 1.4, 60)

    def run(self, vals: list[float]):
        from app.intraday.sentiment import regime

        pts = path(vals)
        f = price_features(pts, pts[-1].at, self.ctx, 22698.85)
        return regime(f, self.ctx, False), f

    def test_a_noisy_but_clear_rise_is_an_uptrend(self) -> None:
        # 76 one-minute samples from 22,700 to 22,870 (+0.75%) with +/-4 point zigzag on every sample
        vals = [22700 + 170 * i / 75 + (4 if i % 2 else -4) for i in range(76)]
        r, f = self.run(vals)
        assert f.er_session is not None and f.er_session < 0.35  # the old measure called this noise
        assert f.er_5m is not None and f.er_5m >= 0.2
        assert r["primary"] == "Uptrend"
        assert "60-min move +0.6" in r["reason"] and "x its typical size" in r["reason"]

    def test_the_same_in_reverse_is_a_downtrend(self) -> None:
        vals = [22870 - 170 * i / 75 + (4 if i % 2 else -4) for i in range(76)]
        assert self.run(vals)[0]["primary"] == "Downtrend"

    def test_back_and_forth_without_a_net_move_is_choppy_not_a_trend(self) -> None:
        vals = [22700 + (6 if (i // 3) % 2 else -6) for i in range(76)]
        assert self.run(vals)[0]["primary"] == "Mean-reverting / choppy"

    def test_a_small_drift_inside_normal_size_is_sideways(self) -> None:
        vals = [22700 + 10 * i / 75 + (2 if i % 2 else -2) for i in range(76)]
        assert self.run(vals)[0]["primary"] in ("Sideways consolidation", "Mean-reverting / choppy")

    def test_too_few_samples_are_unclassified(self) -> None:
        assert self.run([22700.0 + i for i in range(10)])[0]["primary"] == "Unclassified"
