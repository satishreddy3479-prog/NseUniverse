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
