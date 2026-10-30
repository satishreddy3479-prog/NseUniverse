"""The session close follows the exchange feed: two matching sessions change it, one odd day does not."""

from __future__ import annotations

from datetime import UTC, datetime, time
from pathlib import Path

from app.domain.session import (
    DEFAULT_CLOSE,
    market_time,
    session_close,
    session_label,
    set_session_close,
)
from app.lifecycle.session_close import SessionCloseTracker, decide, observed_closes, snap
from app.storage.observations import ObservationStore


def ev(day: str, hhmm: str, text: str = "nse_fo: closed (code 2)") -> dict:
    # IST wall time -> UTC
    h, m, *s = (int(x) for x in hhmm.split(":"))
    at = datetime.fromisoformat(f"{day}T{h:02d}:{m:02d}:{(s or [0])[0]:02d}+05:30").astimezone(UTC)
    return {"at": at, "detail": text}


def test_close_is_the_first_fo_closed_message_in_the_closing_window_each_weekday() -> None:
    events = [
        ev("2026-10-27", "09:00:05"),                    # morning "closed": before the open, not a close
        ev("2026-10-27", "15:40:04"),                    # Tue: the close
        ev("2026-10-27", "15:40:30"),                    # repeat message: ignored
        ev("2026-10-28", "15:30:02", "nse_cm: closed (code 2)"),  # cash segment, not F&O
        ev("2026-10-28", "15:40:03"),
        ev("2026-10-31", "15:40:00"),                    # Saturday: ignored
    ]
    got = observed_closes(events)
    assert [(o["day"], o["close"]) for o in got] == [("2026-10-27", "15:40"), ("2026-10-28", "15:40")]
    assert snap(time(15, 31, 50)) == time(15, 30) and snap(time(15, 36)) is None  # 4+ min from both: not guessed


def test_two_matching_sessions_change_the_close_and_one_odd_day_does_not() -> None:
    old = [{"day": "2026-11-02", "closed_at": "15:40:03", "close": "15:40"}]
    one = old + [{"day": "2026-11-03", "closed_at": "15:30:02", "close": "15:30"}]
    two = one + [{"day": "2026-11-04", "closed_at": "15:30:01", "close": "15:30"}]
    d1 = decide(one, "auto", DEFAULT_CLOSE)
    assert d1["close"] == DEFAULT_CLOSE and d1["pending"]["close"] == "15:30"  # flagged, not applied yet
    d2 = decide(two, "auto", DEFAULT_CLOSE)
    assert d2["close"] == time(15, 30) and d2["pending"] is None and "2026-11-03" in d2["source"]
    back = decide(two + [{"day": "2026-11-05", "closed_at": "15:40:00", "close": "15:40"}] * 2, "auto", time(15, 30))
    assert back["close"] == DEFAULT_CLOSE  # and it can move back
    assert decide(two, "15:40", DEFAULT_CLOSE)["close"] == time(15, 40)  # a hand setting wins


def test_a_changed_close_moves_the_whole_session_clock(tmp_path: Path) -> None:
    ist = lambda d, hh, mm: datetime.fromisoformat(f"{d}T{hh:02d}:{mm:02d}:00+05:30")  # noqa: E731
    assert market_time(ist("2026-10-30", 15, 35)) == ist("2026-10-30", 15, 35)  # 15:35 is in the session at 15:40
    set_session_close(time(15, 30), "test")
    assert session_label() == "09:15–15:30 IST"
    assert market_time(ist("2026-10-30", 15, 35)) == ist("2026-10-30", 15, 30)  # now it is after the close
    # the tracker reads the feed's own history from the stored events
    o = ObservationStore(tmp_path)
    for d in ("2026-10-28", "2026-10-29"):
        o._db.execute(
            "INSERT INTO events(ts_ms, session_id, kind, detail) VALUES (?,?,?,?)",
            (int(datetime.fromisoformat(f"{d}T15:30:02+05:30").timestamp() * 1000), None, "market_status", "nse_fo: closed (code 2)"),
        )
    o._db.commit()
    set_session_close(DEFAULT_CLOSE, "default")
    # events older than the lookback window are ignored, so pretend 'now' is close to them
    import app.lifecycle.session_close as sc
    real = sc.LOOKBACK_DAYS
    sc.LOOKBACK_DAYS = 10_000
    try:
        t = SessionCloseTracker(o, "auto")
    finally:
        sc.LOOKBACK_DAYS = real
    assert session_close() == time(15, 30) and t.info["pending"] is None
