"""The small read of the newest seller and buyer scores for the top bar."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from app.intelligence.straddle_service import StraddleDecay
from app.intelligence.straddle_store import StraddleStore
from tests.conftest import make_app

T0 = datetime(2026, 11, 16, 4, 55, tzinfo=UTC)  # 10:25 IST; the scores below are the real ones of 16 Nov 2026 (10:25 seller 64.3 buyer 38.8, 10:34 72.6 / 38.4)


def service(tmp_path: Path, now: datetime, rows: list[tuple[datetime, float | None, float | None]]) -> StraddleDecay:
    store = StraddleStore(tmp_path)
    for at, seller, buyer in rows:
        store.record("2026-11-16", at, "2026-11-17", {"spot": 25277.0, "seller": seller, "buyer": buyer, "regime": "volatility compression"})
    return StraddleDecay(observations=None, underlying="NIFTY", gex=None, rate=0.06, clock=lambda: now, store=store)


def test_the_newest_scores_their_age_and_where_they_were_fifteen_minutes_before(tmp_path: Path) -> None:
    rows = [(T0 + timedelta(minutes=m), 64.3 + m * 0.5, 38.8 - m * 0.1) for m in range(0, 20)]  # 10:25 to 10:44
    s = service(tmp_path, T0 + timedelta(minutes=21), rows)
    d = s.latest_scores()
    assert d["available"] and d["session"] == "2026-11-16" and d["expiry"] == "2026-11-17" and d["regime"] == "volatility compression"
    assert d["seller"] == 64.3 + 19 * 0.5 and d["buyer"] == 38.8 - 19 * 0.1  # the 10:44 row
    assert d["age_s"] == 120  # recorded 2 minutes ago
    assert d["seller_15m"] == 64.3 + 4 * 0.5 and d["buyer_15m"] == 38.8 - 4 * 0.1  # the 10:29 row, 15 minutes before 10:44


def test_no_comparison_when_there_is_no_row_fifteen_minutes_back_and_nothing_when_nothing_is_recorded(tmp_path: Path) -> None:
    s = service(tmp_path, T0 + timedelta(minutes=5), [(T0, 64.3, 38.8), (T0 + timedelta(minutes=2), 66.0, 37.0)])
    d = s.latest_scores()
    assert d["available"] and d["seller"] == 66.0 and d["seller_15m"] is None and d["buyer_15m"] is None  # missing stays missing
    assert service(tmp_path / "empty", T0, []).latest_scores() == {"available": False}
    assert service(tmp_path / "none", T0, [(T0, None, None)]).latest_scores() == {"available": False}  # a minute without scores is not a score of zero
    off = StraddleDecay(observations=None, underlying="NIFTY", gex=None, rate=0.06, enabled=False, store=StraddleStore(tmp_path / "off"))
    assert off.latest_scores() == {"available": False}


def test_the_api_serves_the_scores(tmp_path: Path) -> None:
    app = make_app(tmp_path / "app")
    with TestClient(app) as c:
        app.state.straddle = service(tmp_path / "s", T0 + timedelta(minutes=1), [(T0, 64.3, 38.8)])
        body = c.get("/api/intelligence/straddle/scores").json()
        assert body["available"] and body["seller"] == 64.3 and body["buyer"] == 38.8 and body["age_s"] == 60


def test_the_scores_are_the_live_calculation_not_the_last_recorded_minute(tmp_path: Path) -> None:
    # 19 Nov 2026: at 09:20:26 IST the recorded minute (09:20) said seller 44.8 / buyer 53.5 while the live calculation on the 09:20:04 sample said 42.9 / 59.1
    now = datetime(2026, 11, 19, 3, 50, 26, tzinfo=UTC)
    store = StraddleStore(tmp_path)
    store.record("2026-11-19", datetime(2026, 11, 19, 3, 50, tzinfo=UTC), "2026-11-23", {"spot": 25200.0, "seller": 44.8, "buyer": 53.5, "regime": "undetermined"})
    s = StraddleDecay(observations=object(), underlying="NIFTY", gex=None, rate=0.06, clock=lambda: now, store=store)  # type: ignore[arg-type]
    live = {"status": "ok", "session": "2026-11-19", "expiry": "2026-11-23", "quality": {"live": True, "last_sample_at": "2026-11-19T03:50:04.655000+00:00"},
            "environment": {"seller": {"score": 42.9}, "buyer": {"score": 59.1}}, "regime": {"label": "undetermined"}}
    s.summary = lambda *a, **k: live  # type: ignore[method-assign]
    d = s.latest_scores()
    assert d["source"] == "live" and d["seller"] == 42.9 and d["buyer"] == 59.1 and d["age_s"] == 21
    live["quality"] = {"live": False, "last_sample_at": "2026-11-19T03:50:04.655000+00:00"}  # no live calculation: the recorded minute, labelled as such
    d = s.latest_scores()
    assert d["source"] == "recorded" and d["seller"] == 44.8 and d["buyer"] == 53.5
