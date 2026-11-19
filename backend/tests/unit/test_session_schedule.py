"""The schedule changes on Monday 7 Dec 2026: continuous cash trading to 15:30, the closing auction 15:30-15:40, F&O to 15:45.

Until 4 Dec the cash segment's continuous trading ends at 15:15 and F&O closes at 15:40 (seen live on 19 Nov 2026).
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Any

import pytest

from app.domain import session as sess
from app.lifecycle.session_close import decide, observed_closes, same_regime, snap
from app.market.index_check import flag_bars, minute_key, proxy_bars
from app.stream.index_watch import IndexWatch, in_snapshot_window

MON = date(2026, 12, 7)
FRI = date(2026, 12, 4)
THU = date(2026, 11, 19)


def test_the_regimes_and_their_default_closes() -> None:
    assert [sess.regime(d) for d in (date(2026, 7, 31), date(2026, 8, 3), THU, FRI, MON)] == [0, 1, 1, 1, 2]
    assert sess.default_close(FRI) == time(15, 40) and sess.default_close(MON) == time(15, 45)
    assert sess.default_close(date(2026, 7, 31)) == time(15, 30)
    assert time(15, 45) in sess.KNOWN_CLOSES and snap(time(15, 45, 3)) == time(15, 45)  # a feed "closed" at 15:45:03 is the new close, not "unknown"


def test_the_closing_auction_windows_by_date() -> None:
    a, b = sess.closing_schedule(THU), sess.closing_schedule(MON)
    assert (a.cash_end, a.indicative_from, a.index_end) == (time(15, 15), time(15, 20), time(15, 30))  # 19 Nov 2026, as observed
    assert (b.cash_end, b.indicative_from, b.index_end) == (time(15, 30), time(15, 31), time(15, 40))  # Kotak Neo: reference price 15:30-15:31, order entry to 15:40
    assert sess.closing_schedule(FRI) == a and (b.watch_from, b.watch_to, b.snapshot_to) == (time(15, 25), time(15, 45), time(15, 32))


def test_the_close_in_force_follows_the_schedule_and_an_old_confirmation_does_not_carry_over(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 15:40 close confirmed on Friday 4 Dec must not hold the sampler at 15:40 on Monday 7 Dec, when F&O trades to 15:45."""
    monkeypatch.setattr(sess, "_today", lambda: FRI)
    sess.set_session_close(time(15, 40), "the exchange feed closed at 15:40 on 2026-12-03 and 2026-12-04")
    assert sess.session_close() == time(15, 40) and sess.session_label() == "09:15–15:40 IST"
    monkeypatch.setattr(sess, "_today", lambda: MON)  # the same process, the next trading day
    assert sess.session_close() == time(15, 45) and sess.session_label() == "09:15–15:45 IST"
    assert "not yet confirmed" in sess.session_source()
    sess.set_session_close(time(15, 45), "the exchange feed closed at 15:45 on 2026-12-07 and 2026-12-08")
    assert sess.session_close() == time(15, 45) and "15:45" in sess.session_source()
    sess.set_session_close(sess.DEFAULT_CLOSE, "default")  # back to the test default


def test_closes_seen_before_the_change_say_nothing_about_the_new_schedule() -> None:
    seen = [{"day": "2026-12-03", "closed_at": "15:40:02", "close": "15:40"}, {"day": "2026-12-04", "closed_at": "15:40:01", "close": "15:40"},
            {"day": "2026-12-07", "closed_at": "15:45:03", "close": "15:45"}]  # fmt: skip
    assert [o["day"] for o in same_regime(seen, MON)] == ["2026-12-07"]
    assert [o["day"] for o in same_regime(seen, FRI)] == ["2026-12-03", "2026-12-04"]
    d = decide(same_regime(seen, MON), "auto", time(15, 45))
    assert d["close"] == time(15, 45) and d["pending"] is None  # one session at 15:45 agrees with the schedule: nothing pending
    # Monday morning, before any 15:45 close has been seen: only the two 15:40 closes of the old schedule exist
    old_only = seen[:2]
    assert decide(old_only, "auto", time(15, 45))["close"] == time(15, 40)  # unfiltered, they would move the close back to 15:40
    assert decide(same_regime(old_only, MON), "auto", time(15, 45))["close"] == time(15, 45)  # filtered, the schedule's 15:45 stays


def test_the_feed_close_of_the_f_and_o_segment_is_read_inside_the_window() -> None:
    at = datetime(2026, 12, 7, 10, 15, 3, tzinfo=UTC)  # 15:45:03 IST
    ev = [{"at": at, "detail": "nse_fo: closed (code 2)"}]
    assert observed_closes(ev) == [{"day": "2026-12-07", "closed_at": "15:45:03", "close": "15:45"}]


def bar(day: date, hm: tuple[int, int], c: float, n: int = 59, h: float | None = None, low: float | None = None) -> dict[str, object]:
    at = datetime(day.year, day.month, day.day, hm[0], hm[1], tzinfo=sess._IST).astimezone(UTC)
    return {"at": at.isoformat(), "o": c, "h": h if h is not None else c + 2, "l": low if low is not None else c - 2, "c": c, "n": n}


def test_from_7_dec_the_index_trades_to_15_30_and_the_auction_window_moves() -> None:
    """Monday 7 Dec (continuous to 15:30): bars 15:15-15:29 are ordinary traded bars, 15:30 is the silent transition, 15:31-15:33 are indicative auction values."""
    futs: dict[str, float] = {}
    bars: list[dict[str, object]] = []
    for i in range(30):  # 15:00-15:29, the index 17 below its future
        m = 15 * 60 + i
        b = bar(MON, (m // 60, m % 60), 25500.0 + (i % 5))
        bars.append(b)
        futs[minute_key(datetime.fromisoformat(str(b["at"])))] = float(b["c"]) + 17.0  # type: ignore[arg-type]
    for hm, c in (((15, 31), 25590.0), ((15, 32), 25570.0), ((15, 33), 25540.0)):  # indicative closing values, well above the future-implied level
        b = bar(MON, hm, c, n=58)
        bars.append(b)
        futs[minute_key(datetime.fromisoformat(str(b["at"])))] = 25521.0
    futs[minute_key(datetime.fromisoformat(str(bar(MON, (15, 30), 0)["at"])))] = 25522.0  # the future trades through the silent minute
    flag_bars(bars, futs)
    assert not any("ind" in b or "off" in b for b in bars[:30])  # 15:00-15:29: traded prices, never called indicative or suspect
    assert [b.get("ind") for b in bars[30:]] == [True, True, True] and not any("off" in b for b in bars[30:])
    stand_in = proxy_bars(bars, futs)
    assert [p["at"] for p in stand_in] == [bar(MON, (15, 30), 0)["at"]]  # only the silent minute 15:30 gets a stand-in
    # the same clock times on 19 Nov (the earlier schedule) are in the auction: bars at 15:16-15:19 would be silent minutes there
    old = bar(THU, (15, 24), 25500.0)
    flag_bars([old], {minute_key(datetime.fromisoformat(str(old["at"]))): 25517.0})
    assert old.get("ind") is True


def test_the_tick_account_and_the_snapshot_requests_move_with_the_schedule() -> None:
    w = IndexWatch()
    at = lambda d, hh, mm, ss=0: datetime(d.year, d.month, d.day, hh, mm, ss, tzinfo=sess._IST)  # noqa: E731
    assert w.observe(at(MON, 15, 20), 25500.0) == []  # 15:20 on 7 Dec: continuous trading, not the auction: nothing is counted
    assert w.observe(at(MON, 15, 30, 5), 25500.0) == [] and w.observe(at(MON, 15, 30, 9), 25501.0) == []  # counting starts (window 15:25-15:45)
    done = w.observe(at(MON, 15, 32, 1), 25570.0)  # 15:30 finished, 15:31 had no tick
    assert [(a["minute"], a["ticks"]) for a in done] == [("15:30", 2), ("15:31", 0)]
    w2: Any = IndexWatch()
    assert w2.observe(at(THU, 15, 20), 25560.0) == [] and w2.observe(at(THU, 15, 21, 2), 25561.0) == [{"minute": "15:20", "ticks": 1, "distinct": 1, "first": 25560.0, "last": 25560.0}]  # 19 Nov: counting
    assert in_snapshot_window(at(THU, 15, 16)) and not in_snapshot_window(at(THU, 15, 21)) and not in_snapshot_window(at(THU, 15, 30))
    assert in_snapshot_window(at(MON, 15, 30, 30)) and in_snapshot_window(at(MON, 15, 31, 59)) and not in_snapshot_window(at(MON, 15, 32)) and not in_snapshot_window(at(MON, 15, 16))


def test_other_clocks_follow_the_session_close(monkeypatch: pytest.MonkeyPatch) -> None:
    """The server-side auto-close rule and the "is a fresh chain worth fetching" window carried their own 15:40 / 15:45."""
    from app.services.universe import market_hours
    from app.strategy.automation import hold_problem

    def at(d: date, hh: int, mm: int) -> datetime:
        return datetime(d.year, d.month, d.day, hh, mm, tzinfo=sess._IST)

    monkeypatch.setattr(sess, "_today", lambda: MON)  # close 15:45
    assert hold_problem({"mode": "intraday", "closeAt": "15:42"}) is None
    assert "09:15-15:45" in (hold_problem({"mode": "intraday", "closeAt": "15:46"}) or "")
    assert market_hours(at(MON, 15, 49)) and not market_hours(at(MON, 15, 50))
    monkeypatch.setattr(sess, "_today", lambda: THU)  # close 15:40, as in force today
    assert "09:15-15:40" in (hold_problem({"mode": "intraday", "closeAt": "15:42"}) or "")
    assert market_hours(at(THU, 15, 44)) and not market_hours(at(THU, 15, 45))


def test_stored_samples_up_to_the_close_in_force_count_as_a_session(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """Ten samples 15:36-15:45 are in-session when the close is 15:45 (from 7 Dec) and mostly after the close when it is 15:40."""
    from pathlib import Path

    from tests.unit.test_data_integrity import EXP
    from tests.unit.test_intraday import ist, seed

    times = [ist(15, 36) + timedelta(minutes=i) for i in range(10)]
    obs = seed(Path(str(tmp_path)), times)
    monkeypatch.setattr(sess, "_today", lambda: THU)  # close 15:40: only 15:36-15:40 count
    assert obs.last_session_by_expiry("NIFTY") == {} and list(obs.session_sample_counts("NIFTY").values()) == [5]
    monkeypatch.setattr(sess, "_today", lambda: MON)  # close 15:45: all ten count
    assert obs.last_session_by_expiry("NIFTY") == {EXP: "2026-10-29"} and list(obs.session_sample_counts("NIFTY").values()) == [10]
