# ruff: noqa: E501
"""Backtest engine: forward windows, no look-ahead, no cross-session targets, chronological split, thinning, statistics (hand arithmetic)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.intraday import backtest as bt

T0 = datetime(2026, 11, 2, 4, 0, tzinfo=UTC)


def snaps(day: int, spots: list[float], **kw: float | None) -> list[bt.Snap]:
    start = T0 + timedelta(days=day)
    return [bt.Snap(at=start + timedelta(minutes=5 * i), session=start.date().isoformat(), spot=s, **kw) for i, s in enumerate(spots)]  # type: ignore[arg-type]


def test_forward_return_is_percent_over_the_next_30_minutes_and_stays_in_the_session() -> None:
    s = snaps(0, [100, 101, 102, 103, 104, 105, 106, 107])  # 5-minute steps: index 0..7 = 0..35 minutes
    f = bt.forward(s, 0)
    assert f is not None and f["ret_pct"] == pytest.approx(6.0)  # 106 / 100 at minute 30
    assert bt.forward(s, 3) is None  # only 20 minutes of the session left: not scored, not padded from the next day
    nxt = s + snaps(1, [200, 210, 220, 230, 240, 250, 260])
    assert bt.forward(nxt, 3) is None  # the next session's prices are never used


def test_a_feature_uses_only_the_past_so_changing_the_future_changes_nothing() -> None:
    a = snaps(0, [100] * 8, ce25=[10, 10, 10, 11, 12, 13, 14, 15][0])
    for i, v in enumerate([10, 10, 10, 11, 12, 13, 14, 15]):
        a[i].ce25 = v
    before = bt.change(a, 4, "ce25", 15)  # 20 min mark: snapshot 15 minutes earlier is index 1 (ce25 10): 12 - 10
    assert before == 2
    a[7].ce25 = 999  # a later value must not alter the feature at index 4
    assert bt.change(a, 4, "ce25", 15) == 2


def test_events_are_thinned_so_windows_do_not_overlap() -> None:
    s = snaps(0, [100] * 14)
    kept = bt.thin(list(range(14)), s, 30)  # every snapshot is an event: keep minute 0, 30, 60
    assert kept == [0, 6, 12]


def test_sessions_are_split_chronologically_and_never_shuffled() -> None:
    s = [x for d in range(5) for x in snaps(d, [100, 101])]
    ins, oos = bt.split_sessions(s, 0.4)
    assert sorted(ins) == [(T0 + timedelta(days=d)).date().isoformat() for d in range(3)]
    assert sorted(oos) == [(T0 + timedelta(days=d)).date().isoformat() for d in (3, 4)]
    assert max(ins) < min(oos)


def test_statistics_by_hand() -> None:
    st = bt.stats([1.0, -0.5, 2.0, -1.0])
    assert st["n"] == 4 and st["win_rate"] == 50.0 and st["mean"] == pytest.approx(0.375) and st["total"] == 1.5
    assert st["risk_reward"] == pytest.approx(1.5 / 0.75)  # mean win 1.5, mean loss 0.75
    assert st["max_drawdown"] == pytest.approx(1.0)  # cumulative 1, 0.5, 2.5, 1.5: peak 2.5 to 1.5
    # standard error: sample sd of [1, -0.5, 2, -1] is sqrt(((0.625)^2 + (0.875)^2 + (1.625)^2 + (1.375)^2) / 3) = 1.3769; se = sd / 2
    lo, hi = st["ci95"]
    assert (hi - lo) / 2 == pytest.approx(1.96 * 1.3769 / 2, abs=1e-3)
    assert bt.stats([])["n"] == 0 and bt.stats([])["mean"] is None


def test_end_to_end_skew_hypothesis_is_scored_out_of_sample_net_of_costs() -> None:
    # 10 sessions; in every session skew is negative from the open and NIFTY rises 0.6 % over the next 30 minutes at each event
    allsnaps: list[bt.Snap] = []
    for d in range(10):
        spots = [100 + 0.1 * i for i in range(60)]  # +0.1 per 5 min: 30 minutes = +0.6 points on ~100 = about +0.6 %
        allsnaps += snaps(d, spots, skew25=-1.0)
    h = next(x for x in bt.HYPOTHESES if x.id == "skew_negative")
    out = bt.run(allsnaps, h, cost_bps=5.0)
    assert out["sessions"]["out_of_sample"] and max(out["sessions"]["in_sample"]) < min(out["sessions"]["out_of_sample"])
    oos = out["out_of_sample"]
    assert oos["events"] >= bt.MIN_EVENTS and out["status"] == "ok"
    first = oos["net_return_pct"]
    # a +0.6 % move less 5 bps cost = about +0.55 % per event: every event wins
    assert first["win_rate"] == 100.0 and first["mean"] == pytest.approx(0.55, abs=0.03)


def test_too_few_events_say_so_instead_of_reporting_a_result() -> None:
    s = snaps(0, [100 + i for i in range(10)], skew25=-1.0) + snaps(1, [100 + i for i in range(10)], skew25=-1.0)
    out = bt.run(s, bt.HYPOTHESES[0])
    assert out["status"].startswith("insufficient out-of-sample sample")


def test_non_directional_target_is_a_difference_of_means() -> None:
    d = bt._mean_diff([2.0, 4.0, 6.0], [1.0, 2.0, 3.0])
    assert d["diff"] == pytest.approx(2.0) and d["mean_event"] == 4.0 and d["mean_other"] == 2.0
    assert bt._mean_diff([1.0], [1.0, 2.0])["diff"] is None


# ---------------------------------------------------------------- GEX and gamma-flip hypotheses
def gsnaps(day: int, spots: list[float], net: list[float | None], flip: list[float | None], ab: float = 100.0) -> list[bt.Snap]:
    s = snaps(day, spots)
    for x, n, f in zip(s, net, flip, strict=True):
        x.extra = {"dynamic.net": n, "dynamic.abs": ab, "dynamic.flip": f}
    return s


def hyp(h_id: str, u: str = "dynamic") -> bt.Hypothesis:
    return next(h for h in bt.gex_hypotheses(u) if h.id == h_id)


def test_flip_crossing_is_detected_only_from_two_consecutive_snapshots_with_known_flips() -> None:
    s = gsnaps(0, [99.0, 101.0, 102.0, 98.0], [1, 1, 1, 1], [100.0, 100.0, None, 100.0])
    up, down = hyp("flip_cross_up"), hyp("flip_cross_down")
    assert up.event(s, 1) is True and down.event(s, 1) is False  # 99 -> 101 through 100
    assert up.event(s, 2) is None  # this snapshot's own flip is missing: not evaluable
    known = gsnaps(0, [99.0, 98.0, 102.0], [1, 1, 1], [100.0, 100.0, 100.0])
    assert up.event(known, 1) is False and up.event(known, 2) is True  # 98 -> 102 crosses; 99 -> 98 does not
    assert up.event(s, 3) is None and down.event(s, 3) is None  # the previous flip is missing: not evaluable, never a guess
    assert up.event(s, 0) is None  # first snapshot of a session has no previous one


def test_divergence_reads_the_signs_of_spot_and_net_gex_over_15_minutes() -> None:
    # 5-minute steps; spot +0.2 % over 15 minutes while net GEX falls from 100 to 60 (-40 % of the larger |net|): amplifying up
    s = gsnaps(0, [100.0, 100.05, 100.1, 100.2], [100.0, 90.0, 75.0, 60.0], [None] * 4)
    assert hyp("div_amp_up").event(s, 3) is True
    assert hyp("div_stab_up").event(s, 3) is False and hyp("div_amp_down").event(s, 3) is False
    flat = gsnaps(0, [100.0, 100.0, 100.0, 100.01], [100.0, 99.0, 99.0, 98.0], [None] * 4)
    assert hyp("div_amp_up").event(flat, 3) is False  # NIFTY flat and a 2 % GEX change: neither condition holds
    assert hyp("div_amp_up").event(s, 1) is None  # no snapshot 15 minutes earlier yet


def test_a_feature_known_only_later_never_changes_an_earlier_event() -> None:
    s = gsnaps(0, [100.0, 100.05, 100.1, 100.2, 100.3], [100.0, 90.0, 75.0, 60.0, 10.0], [None] * 5)
    before = hyp("div_amp_up").event(s, 3)
    s[4].extra["dynamic.net"] = -999.0
    s[4].spot = 50.0
    assert hyp("div_amp_up").event(s, 3) == before


def test_gex_versus_rv_correlation_is_computed_out_of_sample_with_an_interval() -> None:
    # volatility falls as the net/abs ratio rises: build 10 sessions, a ratio per snapshot and a spot path whose step size follows it
    allsnaps: list[bt.Snap] = []
    for d in range(10):
        spots, nets = [100.0], []
        for i in range(60):
            ratio = -1 + 2 * ((i * 7 + d) % 20) / 19  # -1 .. 1
            nets.append(ratio * 100)
            step = 0.2 * (1.5 - ratio) * (1 if i % 2 else -1)  # larger swings when the ratio is low
            spots.append(spots[-1] * (1 + step / 100))
        s = snaps(d, spots[:60])
        for x, n in zip(s, nets, strict=True):
            x.extra = {"dynamic.net": n, "dynamic.abs": 100.0}
        allsnaps += s
    out = bt.run(allsnaps, hyp("gex_vs_rv"))
    c = out["out_of_sample"]["correlation"]
    assert c is not None and c["n"] >= bt.MIN_EVENTS and -1 <= c["r"] <= 1 and c["ci95"][0] <= c["r"] <= c["ci95"][1]
    assert max(out["sessions"]["in_sample"]) < min(out["sessions"]["out_of_sample"])


def test_universe_is_a_parameter_so_the_same_one_is_used_throughout() -> None:
    fixed = bt.gex_hypotheses("fixed")
    assert all("fixed universe" in h.rule for h in fixed)
    assert len(fixed) == 10 and len(bt.NOT_TESTABLE) == 1
