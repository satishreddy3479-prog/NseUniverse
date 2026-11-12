"""Flow tracking across a restart of the backend: the cumulative buy/sell volume continues from the last stored minute, the volume traded while the
backend was down stays unclassified, and a rolling window spanning the restart is available instead of being refused. Synthetic numbers = FORMULA CHECKS."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.intelligence import rolling
from app.market.flow import FlowTracker, last_cumulative

T0 = datetime(2026, 11, 11, 4, 0, tzinfo=UTC)
DAY = "2026-11-11"


def test_restore_continues_the_cumulative_and_leaves_the_downtime_volume_unclassified() -> None:
    f = FlowTracker("HDFCBANK")
    f.restore(buy=600, sell=400)  # the last stored minute before the restart
    assert (f.buy, f.sell, f.carried, f.last_volume) == (600, 400, 1000, None)
    f.update(T0, "10:10", DAY, 5000, 100.0)  # first push after the restart: 5000 traded so far, a baseline, nothing classified
    assert (f.buy, f.sell, f.unclassified) == (600, 400, 0)
    f.update(T0, "10:11", DAY, 5100, 100.05, bid=100.0, ask=100.05)  # 100 at the ask: buy
    f.update(T0, "10:12", DAY, 5150, 100.0, bid=100.0, ask=100.05)  # 50 at the bid: sell
    assert (f.buy, f.sell) == (700, 450)
    pub = f.public(T0)
    assert pub["cvd"] == 250  # 700 - 450: continues from the stored 600 - 400 = 200, plus 100 - 50
    assert pub["restored_volume"] == 1000
    assert pub["quote_rule_share"] == 1.0  # of the 150 seen since the restart, all by the quote rule; the restored 1000 has no stored split
    assert pub["coverage_of_day_volume"] == round(min(1.0, 1150 / 5150), 3)  # restored 1000 + 150 seen of 5150 traded: the downtime gap stays missing


def test_restore_is_ignored_once_the_tracker_has_seen_a_push_and_a_new_day_starts_clean() -> None:
    f = FlowTracker("LT")
    f.update(T0, "09:20", DAY, 1000, 50.0)
    f.restore(buy=9, sell=1)
    assert (f.buy, f.sell, f.carried) == (0, 0, 0)
    g = FlowTracker("LT")
    g.restore(buy=600, sell=400)
    g.update(T0, "09:20", DAY, 1000, 50.0)
    g.update(T0 + timedelta(days=1), "09:20", "2026-11-12", 100, 50.0)  # a new session: nothing of yesterday survives
    assert (g.buy, g.sell, g.carried) == (0, 0, 0)


def test_last_cumulative_reads_the_future_and_the_heavyweight_rows() -> None:
    fut = [("2026-11-11T04:01:00+00:00", {"b": 10, "s": 5, "cvd": 5, "v": 20}), ("2026-11-11T04:02:00+00:00", {"b": None, "s": None, "cvd": None, "v": 30})]
    assert last_cumulative(fut, "NIFTYFUT") == (10, 5)  # the newest sample with both figures; a missing one is skipped, not zero
    heavy = [("t1", {"rows": [["HDFCBANK", 200, 600, 400, 1000], ["LT", 1, 2, 1, 3]]}), ("t2", {"rows": [["LT", 5, 7, 2, 9]]})]
    assert last_cumulative(heavy, "HDFCBANK") == (600, 400)
    assert last_cumulative(heavy, "LT") == (7, 2)
    assert last_cumulative(heavy, "RELIANCE") is None
    assert last_cumulative([], "NIFTYFUT") is None


def test_a_rolling_window_across_a_restart_is_available() -> None:
    """Samples every minute for 20 minutes with the backend restarting after minute 10. Cumulative buy/sell continue, so the 15-minute window is ok."""
    samples = []
    b = s = 0
    for i in range(21):
        if i == 11:
            pass  # a restart between minute 10 and 11: with restore the counters carry on (without it they would have fallen back to zero)
        b += 60
        s += 40
        samples.append(((T0 + timedelta(minutes=i)).isoformat(), {"b": b, "s": s, "cvd": b - s, "v": (b + s) * 3}))
    w = rolling.window(samples, 15)
    assert w["status"] == "ok" and w["cvd"] == 15 * 20 and w["cvd_pct"] == 20.0  # 15 minutes x (60 - 40) = 300 of 1500 classified
    # the old behaviour: the counters began again after the restart and the window was refused
    broken = [(t, p | {"b": p["b"] - 660 if i > 10 else p["b"], "s": p["s"] - 440 if i > 10 else p["s"]}) for i, (t, p) in enumerate(samples)]
    broken = [(t, p | {"cvd": p["b"] - p["s"], "v": (p["b"] + p["s"]) * 3}) for t, p in broken]
    assert rolling.window(broken, 15)["status"].startswith("unavailable: the backend restarted")


def test_a_late_older_volume_figure_does_not_wipe_the_restored_session() -> None:
    """12 Nov 2026: after a restart HDFCBANK and BHARTIARTL lost the whole session's flow (11.3 M of 11.9 M traded -> 53 k) because one push carried a
    cumulative volume below the baseline. A figure within 2 % below the last one is a late or foreign quote: ignored, nothing reset."""
    f = FlowTracker("HDFCBANK")
    f.restore(buy=6_000_000, sell=5_000_000)
    f.update(T0, "10:25", DAY, 11_900_000, 100.0)  # baseline after the restart
    f.update(T0, "10:25", DAY, 11_850_000, 100.0)  # 0.4 % lower: ignored
    assert (f.buy, f.sell, f.restarts, f.last_volume) == (6_000_000, 5_000_000, 0, 11_900_000)
    f.update(T0, "10:26", DAY, 11_950_000, 100.05, bid=100.0, ask=100.05)  # the next real push: 50 000 at the ask
    assert (f.buy, f.sell) == (6_050_000, 5_000_000)  # the delta is from 11.90 M, so the late figure was not double counted


def test_a_real_counter_restart_keeps_the_flow_already_classified_and_leaves_the_gap_unclassified() -> None:
    f = FlowTracker("BHARTIARTL")
    f.update(T0, "09:20", DAY, 1000, 50.0)
    f.update(T0, "09:21", DAY, 1100, 50.1, bid=50.0, ask=50.1)  # 100 at the ask
    assert (f.buy, f.sell) == (100, 0)
    f.update(T0, "09:22", DAY, 300, 50.0)  # the counter fell by 70 %: the feed restarted it
    assert (f.buy, f.sell, f.restarts, f.last_volume) == (100, 0, 1, 300)  # kept, not wiped; the missing 800 is not guessed
    f.update(T0, "09:23", DAY, 360, 49.9, bid=49.9, ask=50.0)  # 60 at the bid
    assert (f.buy, f.sell) == (100, 60)
    assert f.public(T0)["cvd"] == 40
    f.update(T0, "09:20", "2026-11-12", 10, 51.0)  # the next trading day still starts clean
    assert (f.buy, f.sell, f.restarts) == (0, 0, 0)


def test_the_stored_minutes_keep_a_rolling_window_available_across_a_counter_restart() -> None:
    f = FlowTracker("X")
    t = T0
    f.update(t, "10:00", DAY, 10_000, 100.0)
    samples = []
    for i in range(1, 25):
        vol = 10_000 + i * 100 if i < 12 else 500 + (i - 12) * 100  # the counter falls after minute 11
        f.update(t + timedelta(minutes=i), f"10:{i:02d}", DAY, vol, 100.0 + (i % 2) * 0.05, bid=100.0, ask=100.05)
        samples.append((t + timedelta(minutes=i), f.buy - f.sell))
    cum = [c for _, c in samples]
    assert all(b >= a - 100 for a, b in zip(cum, cum[1:], strict=False))  # no fall of the cumulative CVD, so nothing marks the window as broken


def test_last_cumulative_repairs_a_wiped_session_from_the_stored_minutes() -> None:
    """The real 12 Nov 2026 HDFCBANK minutes (buy + sell): 11 337 552 at 10:25, then 53 319 after the wipe, then growing again. The observed total is the sum of the
    increases, 11 337 552 + 53 319 + (201 199 - 53 319), not the last figure."""
    def row(b: int, s: int) -> dict[str, list[list[int | str]]]:
        return {"rows": [["HDFCBANK", b - s, b, s, 0]]}
    heavy = [("t1", row(5_000_000, 6_337_552)), ("t2", row(30_000, 23_319)), ("t3", row(100_000, 101_199))]
    assert last_cumulative(heavy, "HDFCBANK") == (5_000_000 + 30_000 + 70_000, 6_337_552 + 23_319 + 77_880)
    # a normal run, with no fall, is simply the newest sample
    ok = [("t1", row(10, 4)), ("t2", row(30, 9)), ("t3", row(50, 20))]
    assert last_cumulative(ok, "HDFCBANK") == (50, 20)
    # a sample without the stock is skipped, not read as zero
    assert last_cumulative([("t1", row(10, 4)), ("t2", {"rows": [["LT", 0, 1, 1, 0]]}), ("t3", row(12, 5))], "HDFCBANK") == (12, 5)
