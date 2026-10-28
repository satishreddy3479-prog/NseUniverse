"""Prediction foundations. All market-like numbers here are SYNTHETIC TEST INPUTS with hand-worked
answers; they never reach the application's data or any training set."""

from __future__ import annotations

import math
import sqlite3
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from statistics import stdev
from zoneinfo import ZoneInfo

import pytest

from app.prediction.calendar import CalendarCoverageError, SessionCalendar, TradingCalendar
from app.prediction.evaluation import (
    balanced_accuracy,
    brier,
    calibration_bins,
    climatology_probability,
    empirical_quantile,
    interval_coverage,
    log_loss,
    mae,
    pinball,
    rmse,
    walk_forward_splits,
    wilson_interval,
)
from app.prediction.ledger import Forecast, ForecastLedger, LedgerError
from app.prediction.pit import (
    IST,
    LeakageError,
    Observation,
    PublicationRule,
    assert_point_in_time,
    forecast_cutoff,
    latest_available,
    select_available,
)
from app.prediction.targets import Bar, BarError, Thresholds, make_labels

CAL = TradingCalendar.load()
D = date.fromisoformat


class TestCalendar:
    def test_official_2026_holidays_are_loaded(self) -> None:
        assert len(CAL.holidays) == 16  # NSE/CMTR/71775 (15) + NSE/CMTR/72260 (15 Jan)
        for d in ("2026-01-15", "2026-10-02", "2026-10-20", "2026-11-10", "2026-12-25"):
            assert not CAL.is_session(D(d))

    def test_weekends_and_ordinary_days(self) -> None:
        assert CAL.is_session(D("2026-10-28"))  # Wednesday
        assert not CAL.is_session(D("2026-10-31"))  # Saturday
        assert not CAL.is_session(D("2026-11-01"))  # Sunday

    def test_next_session_skips_holidays_and_weekends(self) -> None:
        assert CAL.next_session(D("2026-10-19")) == D("2026-10-21")  # Dussehra on the 20th
        assert CAL.next_session(D("2026-10-30"), 1) == D("2026-11-02")  # Friday -> Monday
        assert CAL.next_session(D("2026-10-30"), 5) == D("2026-11-06")
        # Diwali-Balipratipada (Tue 10 Nov) sits inside the window: five sessions after Fri 6 Nov
        assert CAL.next_session(D("2026-11-06"), 5) == D("2026-11-16")

    def test_prev_session(self) -> None:
        assert CAL.prev_session(D("2026-11-11")) == D("2026-11-09")
        assert CAL.prev_session(D("2026-11-02"), 2) == D("2026-10-29")

    def test_muhurat_sunday_is_special_not_regular(self) -> None:
        d = D("2026-11-08")
        assert CAL.is_special_session(d) and not CAL.is_session(d)
        assert CAL.next_session(D("2026-11-06")) == D(
            "2026-11-09"
        )  # never lands on the Muhurat session

    def test_refuses_dates_it_has_no_circular_for(self) -> None:
        with pytest.raises(CalendarCoverageError):
            CAL.is_session(D("2027-01-04"))
        with pytest.raises(CalendarCoverageError):
            CAL.next_session(D("2026-12-30"), 3)  # would cross into uncovered 2027
        with pytest.raises(ValueError):
            CAL.next_session(D("2026-10-28"), 0)

    def test_sessions_between(self) -> None:
        assert CAL.sessions_between(D("2026-11-06"), D("2026-11-11")) == [
            D("2026-11-06"), D("2026-11-09"), D("2026-11-11")
        ]  # fmt: skip

    def test_history_calendar_uses_the_recorded_dates(self) -> None:
        sc = SessionCalendar(
            [D("2019-02-01"), D("2019-02-04"), D("2019-02-02")]
        )  # a Saturday session
        assert sc.is_session(D("2019-02-02"))
        assert sc.next_session(D("2019-02-01")) == D("2019-02-02")
        assert sc.prev_session(D("2019-02-04"), 2) == D("2019-02-01")
        with pytest.raises(CalendarCoverageError):
            sc.next_session(D("2019-02-04"))


def bars(closes_and_ohlc: list[tuple[date, float, float, float, float]]) -> list[Bar]:
    return [Bar(d, o, h, low, c) for d, o, h, low, c in closes_and_ohlc]


# SYNTHETIC consecutive sessions Mon 26 Oct .. Tue 3 Nov 2026 (weekend skipped)
S = [
    D(x)
    for x in (
        "2026-10-26",
        "2026-10-27",
        "2026-10-28",
        "2026-10-29",
        "2026-10-30",
        "2026-11-02",
        "2026-11-03",
    )
]
SERIES = bars([
    (S[0], 99.0, 101.0, 98.0, 100.0),
    (S[1], 100.5, 102.0, 100.0, 101.2),   # gap +0.5%, close +1.2%
    (S[2], 101.0, 101.5, 98.5, 99.0),
    (S[3], 99.5, 100.5, 99.0, 100.0),
    (S[4], 100.0, 102.5, 99.8, 102.0),
    (S[5], 102.5, 103.5, 102.0, 103.0),
    (S[6], 103.0, 104.0, 102.5, 103.5),
])  # fmt: skip


class TestTargets:
    def test_t1_formulas_hand_calculated(self) -> None:
        lab = make_labels(SERIES, CAL).t1[0]
        assert lab.reference_session == S[0] and lab.target_session == S[1]
        assert lab.gap == pytest.approx(
            100.5 / 100 - 1
        )  # +0.5%: the opening gap uses the previous CLOSE
        assert lab.close_to_close == pytest.approx(0.012)
        assert lab.open_to_close == pytest.approx(
            101.2 / 100.5 - 1
        )  # NOT the same as close-to-close
        assert lab.range_pct == pytest.approx(
            (102.0 - 100.0) / 100.0
        )  # scaled by the reference close
        assert lab.positive and not lab.negative
        assert lab.large_up == {0.005: True, 0.01: True} and lab.large_down == {
            0.005: False,
            0.01: False,
        }
        assert lab.gap_up[0.003] and lab.gap_up[0.005] and not lab.gap_down[0.003]

    def test_gap_is_not_close_to_close(self) -> None:
        lab = make_labels(SERIES, CAL).t1[1]  # ref 101.2 -> next open 101.0, close 99.0
        assert lab.gap == pytest.approx(101.0 / 101.2 - 1) and lab.close_to_close == pytest.approx(
            99.0 / 101.2 - 1
        )
        assert lab.negative and lab.gap != lab.close_to_close

    def test_t5_formulas_hand_calculated(self) -> None:
        lab = make_labels(SERIES, CAL).t5[0]
        assert (
            lab.reference_session == S[0] and lab.target_session == S[5]
        )  # the fifth session after t
        assert lab.ret5 == pytest.approx(0.03)  # 103/100 - 1
        closes = [100.0, 101.2, 99.0, 100.0, 102.0, 103.0]
        daily = [closes[i + 1] / closes[i] - 1 for i in range(5)]
        assert lab.realized_vol == pytest.approx(stdev(daily))
        assert lab.mfe == pytest.approx(103.5 / 100 - 1)  # highest high over t+1..t+5 is 103.5
        assert lab.mae == pytest.approx(98.5 / 100 - 1)  # lowest low is 98.5
        assert lab.adverse is False  # worst close is 99.0 = -1.0%, threshold -2%
        assert lab.exceed_up == {0.01: True, 0.02: True} and lab.exceed_down == {
            0.01: False,
            0.02: False,
        }

    def test_adverse_flag_triggers_on_a_close_based_drawdown(self) -> None:
        series = [Bar(S[0], 100, 100, 100, 100)] + [Bar(d, 97, 98, 96, 97) for d in S[1:6]]
        assert make_labels(series, CAL).t5[0].adverse is True  # -3% close

    def test_last_sessions_have_no_label(self) -> None:
        ls = make_labels(SERIES, CAL)
        assert len(ls.t1) == 6  # the last session has no successor
        assert len(ls.t5) == 2  # reference sessions 0 and 1 only; later ones lack five sessions

    def test_holiday_inside_the_window_is_handled_by_the_calendar(self) -> None:
        d = [
            D("2026-11-06"),
            D("2026-11-09"),
            D("2026-11-11"),
            D("2026-11-12"),
            D("2026-11-13"),
            D("2026-11-16"),
        ]
        series = [Bar(x, 100 + i, 101 + i, 99 + i, 100 + i) for i, x in enumerate(d)]
        ls = make_labels(series, CAL)
        assert [x.target_session for x in ls.t1][:2] == [
            D("2026-11-09"),
            D("2026-11-11"),
        ]  # 10 Nov skipped
        assert ls.t5[0].target_session == D("2026-11-16") and not ls.skipped

    def test_a_missing_day_in_history_invalidates_labels_instead_of_bridging_it(self) -> None:
        gapped = [b for b in SERIES if b.session != S[2]]  # drop Wed 28 Oct
        ls = make_labels(gapped, CAL)
        reasons = dict(ls.skipped)
        assert S[1] in reasons and "missing session" in reasons[S[1]]
        assert all(x.reference_session != S[1] for x in ls.t1)  # no T+1 label bridging the hole
        assert all(x.reference_session not in (S[0], S[1]) for x in ls.t5)

    def test_without_a_calendar_only_big_gaps_are_detectable(self) -> None:
        a = Bar(D("2026-01-01"), 100, 101, 99, 100)
        b = Bar(D("2026-01-20"), 100, 101, 99, 100)
        assert make_labels([a, b]).skipped and not make_labels([a, b]).t1

    def test_impossible_bars_are_rejected_not_repaired(self) -> None:
        with pytest.raises(BarError):
            Bar(S[0], 100, 99, 98, 100)  # high below close
        with pytest.raises(BarError):
            Bar(S[0], 0, 1, 0, 1)
        with pytest.raises(BarError):
            Bar(S[0], float("nan"), 1, 1, 1)
        with pytest.raises(BarError):
            make_labels([SERIES[0], SERIES[0]], CAL)  # duplicate session

    def test_thresholds_are_configurable(self) -> None:
        ls = make_labels(SERIES, CAL, Thresholds(t1_return=(0.02,), t1_gap=(0.01,)))
        assert ls.t1[0].large_up == {0.02: False} and ls.t1[0].gap_up == {0.01: False}


UTC_ = UTC
CUT = forecast_cutoff(D("2026-10-28"), 8, 30)  # 08:30 IST on 28 Oct == 03:00 UTC


def obs(
    name: str,
    published: datetime | None,
    effective: datetime,
    value: float | None = 1.0,
    **kw: object,
) -> Observation:
    return Observation("test", name, value, effective_at=effective, published_at=published, **kw)  # type: ignore[arg-type]


class TestPointInTime:
    def test_cutoff_is_timezone_aware_ist(self) -> None:
        assert CUT == datetime(2026, 10, 28, 3, 0, tzinfo=UTC_)

    def test_published_after_cutoff_is_unavailable(self) -> None:
        late = obs(
            "fii_net",
            datetime(2026, 10, 28, 12, 30, tzinfo=UTC_),
            datetime(2026, 10, 27, 10, tzinfo=UTC_),
        )
        early = obs(
            "us_close",
            datetime(2026, 10, 28, 2, 0, tzinfo=UTC_),
            datetime(2026, 10, 28, 1, tzinfo=UTC_),
        )
        use, skip = select_available([late, early], CUT)
        assert use == [early] and skip == [late]
        with pytest.raises(LeakageError):
            assert_point_in_time([early, late], CUT)
        assert_point_in_time([early], CUT)  # no error

    def test_the_boundary_is_inclusive(self) -> None:
        at = obs("x", CUT, CUT)
        assert at.available_at(CUT) and not at.available_at(CUT - timedelta(seconds=1))

    def test_unknown_publication_time_is_never_assumed(self) -> None:
        o = obs("x", None, datetime(2026, 10, 20, tzinfo=UTC_))
        assert not o.available_at(CUT)
        with pytest.raises(LeakageError):
            assert_point_in_time([o], CUT)

    def test_missing_or_unavailable_values_are_not_usable(self) -> None:
        assert not obs("x", CUT, CUT, value=None).available_at(CUT)
        assert not obs("x", CUT, CUT, quality="unavailable").available_at(CUT)

    def test_naive_timestamps_are_rejected(self) -> None:
        with pytest.raises(ValueError):
            obs("x", datetime(2026, 10, 28, 3, 0), CUT)

    def test_us_close_is_known_at_the_morning_cutoff_but_not_the_evening_one(self) -> None:
        ny = ZoneInfo("America/New_York")
        us_close = datetime(2026, 10, 27, 16, 0, tzinfo=ny)  # 16:00 EDT == 01:30 IST on the 28th
        o = obs("spx_close", us_close, us_close)
        assert o.available_at(forecast_cutoff(D("2026-10-28"), 8, 30))
        assert not o.available_at(forecast_cutoff(D("2026-10-27"), 18, 0))  # still trading then

    def test_a_revised_value_is_seen_as_it_was_known_at_the_time(self) -> None:
        eff = datetime(2026, 9, 30, tzinfo=UTC_)
        first = obs("cpi", datetime(2026, 10, 12, 10, tzinfo=UTC_), eff, 4.0, version="first")
        revised = obs("cpi", datetime(2026, 11, 12, 10, tzinfo=UTC_), eff, 4.4, version="revised")
        assert (
            latest_available([first, revised], "cpi", datetime(2026, 10, 28, tzinfo=UTC_)) == first
        )
        assert (
            latest_available([first, revised], "cpi", datetime(2026, 11, 20, tzinfo=UTC_))
            == revised
        )
        assert latest_available([first, revised], "cpi", datetime(2026, 10, 1, tzinfo=UTC_)) is None

    def test_publication_rules_must_be_verified(self) -> None:
        eff = datetime(2026, 10, 27, 10, tzinfo=UTC_)
        unverified = PublicationRule(
            "fii_dii", "published after close", verified=False, at_ist=(18, 30)
        )
        with pytest.raises(LeakageError):
            unverified.published_at(eff)
        ok = PublicationRule("us_cpi", "08:30 ET", verified=True, lag=timedelta(hours=1))
        assert ok.published_at(eff) == eff + timedelta(hours=1)
        clock = PublicationRule("x", "18:30 IST same day", verified=True, at_ist=(18, 30))
        assert clock.published_at(eff) == datetime(2026, 10, 27, 18, 30, tzinfo=IST)
        nxt = PublicationRule(
            "y", "08:00 IST next day", verified=True, at_ist=(8, 0), next_day=True
        )
        assert nxt.published_at(eff) == datetime(2026, 10, 28, 8, 0, tzinfo=IST)


T1_REF, T1_TGT = D("2026-10-27"), D("2026-10-28")


def fc(**over: object) -> Forecast:
    base: dict[str, object] = dict(
        horizon="T1", model_name="baseline_clim", model_version="0.0.1", dataset_version="none",
        feature_version="none", cutoff=forecast_cutoff(T1_TGT, 8, 30),
        generated_at=forecast_cutoff(T1_TGT, 8, 45), reference_session=T1_REF,
        reference_price=100.0,
        first_target_session=T1_TGT, target_session=T1_TGT, payload={"p_up": 0.52},
        data_quality={"overall": "test"}, excluded_inputs=["fii_dii (published later)"],
    )  # fmt: skip
    base.update(over)
    return Forecast(**base)  # type: ignore[arg-type]


class Clock:
    def __init__(self, at: datetime) -> None:
        self.now = at

    def __call__(self) -> datetime:
        return self.now


class TestLedger:
    def make(self, tmp_path: Path, now: datetime | None = None) -> tuple[ForecastLedger, Clock]:
        clock = Clock(now or forecast_cutoff(T1_TGT, 8, 50))
        return ForecastLedger(tmp_path, clock), clock

    def test_a_forecast_is_stored_and_verifiable(self, tmp_path: Path) -> None:
        led, _ = self.make(tmp_path)
        fid = led.record(fc())
        got = led.get("T1", fid)
        assert got and got["intact"] and got["outcome"] is None
        assert got["forecast"]["payload"] == {"p_up": 0.52} and got["forecast"]["excluded_inputs"]

    def test_the_same_forecast_cannot_be_written_twice(self, tmp_path: Path) -> None:
        led, _ = self.make(tmp_path)
        led.record(fc())
        with pytest.raises(LedgerError, match="append-only"):
            led.record(fc(payload={"p_up": 0.9}))  # a hindsight rewrite is refused

    def test_stored_forecasts_cannot_be_updated_or_deleted(self, tmp_path: Path) -> None:
        led, _ = self.make(tmp_path)
        fid = led.record(fc())
        raw = sqlite3.connect(led.path)
        with pytest.raises(sqlite3.DatabaseError, match="immutable"):
            raw.execute("UPDATE t1_forecasts SET content='{}' WHERE forecast_id=?", (fid,))
        with pytest.raises(sqlite3.DatabaseError, match="immutable"):
            raw.execute("DELETE FROM t1_forecasts WHERE forecast_id=?", (fid,))

    def test_tampering_is_detected_even_if_the_triggers_are_removed(self, tmp_path: Path) -> None:
        led, _ = self.make(tmp_path)
        fid = led.record(fc())
        raw = sqlite3.connect(led.path)
        raw.execute("DROP TRIGGER t1_forecasts_no_update")
        raw.execute(
            "UPDATE t1_forecasts SET content=replace(content,'0.52','0.99') WHERE forecast_id=?",
            (fid,),
        )
        raw.commit()
        assert led.get("T1", fid)["intact"] is False  # type: ignore[index]

    def test_refuses_forecasts_that_could_not_be_genuine(self, tmp_path: Path) -> None:
        led, _ = self.make(tmp_path)
        late, late_clock = self.make(tmp_path / "late", forecast_cutoff(T1_TGT, 9, 30))
        with pytest.raises(LedgerError, match="before its first target session opens"):
            late.record(fc(generated_at=forecast_cutoff(T1_TGT, 9, 20)))
        assert late_clock.now > fc().generated_at
        with pytest.raises(LedgerError, match="cutoff is after"):
            led.record(fc(cutoff=forecast_cutoff(T1_TGT, 8, 50)))
        with pytest.raises(LedgerError, match="future"):
            led.record(fc(generated_at=forecast_cutoff(T1_TGT, 8, 55)))  # ledger clock says 08:50
        with pytest.raises(LedgerError, match="session order"):
            led.record(fc(reference_session=T1_TGT))
        with pytest.raises(LedgerError, match="timezone"):
            led.record(fc(cutoff=datetime(2026, 10, 28, 3, 0)))

    def test_outcome_only_after_the_target_session_closes_and_only_once(
        self, tmp_path: Path
    ) -> None:
        led, clock = self.make(tmp_path)
        fid = led.record(fc())
        with pytest.raises(LedgerError, match="not completed"):
            led.attach_outcome("T1", fid, {"close_to_close": 0.004})
        clock.now = forecast_cutoff(T1_TGT, 15, 29)
        with pytest.raises(LedgerError, match="not completed"):
            led.attach_outcome("T1", fid, {"close_to_close": 0.004})
        clock.now = forecast_cutoff(T1_TGT, 15, 31)
        led.attach_outcome("T1", fid, {"close_to_close": 0.004})
        assert led.get("T1", fid)["outcome"]["realized"] == {"close_to_close": 0.004}  # type: ignore[index]
        with pytest.raises(LedgerError, match="already attached"):
            led.attach_outcome("T1", fid, {"close_to_close": 0.5})
        raw = sqlite3.connect(led.path)
        with pytest.raises(sqlite3.DatabaseError, match="append-once"):
            raw.execute("UPDATE t1_outcomes SET realized='{}'")

    def test_t1_and_t5_are_kept_apart(self, tmp_path: Path) -> None:
        led, clock = self.make(tmp_path)
        led.record(fc())
        led.record(fc(horizon="T5", target_session=D("2026-11-03"), payload={"p_up": 0.55}))
        assert led.counts() == {
            "T1": {"forecasts": 1, "outcomes": 0},
            "T5": {"forecasts": 1, "outcomes": 0},
        }
        assert (
            len(led.list("T1")) == 1
            and led.list("T5")[0]["forecast"]["target_session"] == "2026-11-03"
        )
        with pytest.raises(LedgerError):
            led.get("T9", "x")  # type: ignore[arg-type]
        assert led.get("T5", fc().forecast_id) is None  # a T+1 id is not in the T+5 ledger
        clock.now = forecast_cutoff(D("2026-11-03"), 16, 0)
        led.attach_outcome(
            "T5", fc(horizon="T5", target_session=D("2026-11-03")).forecast_id, {"ret5": 0.01}
        )
        assert led.counts()["T1"]["outcomes"] == 0 and led.counts()["T5"]["outcomes"] == 1

    def test_forecasts_survive_a_restart(self, tmp_path: Path) -> None:
        led, clock = self.make(tmp_path)
        fid = led.record(fc())
        led.close()
        again = ForecastLedger(tmp_path, clock)
        assert again.get("T1", fid)["intact"]  # type: ignore[index]


class TestEvaluation:
    def test_walk_forward_never_lets_label_windows_cross_the_boundary(self) -> None:
        n, h, emb = 60, 5, 2
        splits = list(walk_forward_splits(n, initial_train=20, test_size=8, horizon=h, embargo=emb))
        assert splits
        for train, test in splits:
            assert (
                max(train) + h < min(test) - emb + 0
            )  # label of the last train sample ends before the test
            assert train == sorted(train) and test == sorted(test) and train[0] == 0
            assert set(train).isdisjoint(test)
        assert splits[-1][1][-1] <= n - 1
        assert splits[1][1][0] - splits[0][1][0] == 8  # rolls forward by the test size

    def test_t1_purge_is_just_the_adjacent_sample(self) -> None:
        train, test = next(walk_forward_splits(30, initial_train=10, test_size=5, horizon=1))
        assert train[-1] == 8 and test[0] == 10  # sample 9's label uses sample 10 -> dropped

    def test_probability_metrics_hand_calculated(self) -> None:
        assert brier([0.8, 0.2], [1, 0]) == pytest.approx(0.04)
        assert log_loss([0.8, 0.2], [1, 0]) == pytest.approx(-math.log(0.8))
        assert log_loss([1.0], [0]) < 40  # clipped, never infinite
        with pytest.raises(ValueError):
            brier([], [])

    def test_calibration_table_reports_empty_bins_as_empty(self) -> None:
        bins = calibration_bins([0.05, 0.15, 0.95, 0.97], [0, 1, 1, 1], bins=10)
        assert bins[0].n == 1 and bins[0].observed_frequency == 0.0
        assert (
            bins[9].n == 2
            and bins[9].mean_predicted == pytest.approx(0.96)
            and bins[9].observed_frequency == 1.0
        )
        assert bins[5].n == 0 and bins[5].mean_predicted is None

    def test_wilson_interval_and_balanced_accuracy(self) -> None:
        lo, hi = wilson_interval(60, 100)
        assert lo == pytest.approx(0.5020, abs=1e-3) and hi == pytest.approx(0.6906, abs=1e-3)
        assert wilson_interval(6, 10)[1] - wilson_interval(6, 10)[0] > hi - lo  # small n => wider
        assert balanced_accuracy([1, 1, 1, 1], [1, 1, 1, 0]) == pytest.approx(
            (1.0 + 0.0) / 2
        )  # all-up guess
        assert balanced_accuracy([1, 1], [1, 1]) is None  # one class only: undefined, not 1.0

    def test_return_metrics_and_quantiles(self) -> None:
        assert mae([1.0, 2.0], [0.0, 4.0]) == pytest.approx(1.5)
        assert rmse([1.0, 2.0], [0.0, 4.0]) == pytest.approx(math.sqrt((1 + 4) / 2))
        assert pinball([1.0], [2.0], 0.9) == pytest.approx(0.9)
        assert pinball([1.0], [0.0], 0.9) == pytest.approx(0.1)
        assert interval_coverage([0, 0, 0], [1, 1, 1], [0.5, 2.0, 1.0]) == (
            pytest.approx(2 / 3),
            1.0,
        )
        assert (
            empirical_quantile([1, 2, 3, 4], 0.5) == 2.5
            and empirical_quantile([1, 2, 3, 4], 1.0) == 4
        )

    def test_baselines_use_only_the_training_labels_given(self) -> None:
        assert climatology_probability([1, 0, 1, 1]) == 0.75
        with pytest.raises(ValueError):
            climatology_probability([])
