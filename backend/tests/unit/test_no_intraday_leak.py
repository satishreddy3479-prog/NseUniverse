"""Guards that keep intraday and live data out of the prediction models, and keep the models'
training and evaluation away from market hours.

Three independent layers are tested:
1. Code boundary: nothing under app/prediction may import live, broker, stream, observation-store,
   API or intraday code (so a future edit cannot wire intraday data into the models by accident).
2. Data boundary: only final daily bars reach the models (a bar of a session that has not finished
   is dropped on download, and a partial bar that was stored too early is replaced by its final
   bar or held back, never used as it was).
3. Time boundary: models are trained and evaluated only outside 09:15-15:45 IST on trading days.
"""

from __future__ import annotations

import ast
import sqlite3
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from app.prediction.history_service import HistoryService
from app.prediction.history_store import HistoryStore
from app.prediction.sources.yahoo import BY_KEY, complete_after
from tests.unit.test_history import EVENING, Clock, FakeDownloader, row
from tests.unit.test_research import _at, _Cal, _service, _walk

APP = Path(__file__).resolve().parents[2] / "app"
FORBIDDEN = (
    "app.intraday", "app.storage", "app.stream", "app.services", "app.broker", "app.api",
    "app.main", "app.domain", "app.lifecycle",
)  # fmt: skip
D = date.fromisoformat


# ------------------------------------------------------------------------- 1. code boundary


def _imports(path: Path) -> set[str]:
    out: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text("utf-8"))):
        if isinstance(node, ast.Import):
            out |= {a.name for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            out.add(node.module)
    return out


def test_prediction_code_imports_no_live_or_intraday_code() -> None:
    bad = {}
    for f in (APP / "prediction").rglob("*.py"):
        hit = sorted(m for m in _imports(f) if any(m == p or m.startswith(p + ".") for p in FORBIDDEN))
        if hit:
            bad[str(f.relative_to(APP))] = hit
    assert bad == {}, f"prediction code must not depend on live/intraday code: {bad}"


def test_prediction_code_never_names_the_intraday_or_observation_databases() -> None:
    for f in (APP / "prediction").rglob("*.py"):
        text = f.read_text("utf-8")
        assert "intraday.sqlite3" not in text and "observations.sqlite3" not in text, f.name


def test_intraday_package_never_imports_the_model_code() -> None:
    """The reverse direction: intraday and lifecycle code may read stored daily data, never the models."""
    models = ("app.prediction.research", "app.prediction.models", "app.prediction.features", "app.prediction.features_multi", "app.prediction.ledger")
    for f in [*(APP / "intraday").rglob("*.py"), *(APP / "lifecycle").rglob("*.py")]:
        assert not [m for m in _imports(f) if m in models], f.name


# ----------------------------------------------------------------------- 2. data boundary


def test_completion_times_are_per_exchange() -> None:
    # India (derivatives and index) close 15:40 IST -> final 16:10 IST = 10:40 UTC
    assert complete_after(BY_KEY["NIFTY50"], D("2026-10-28")) == datetime(2026, 10, 28, 10, 40, tzinfo=UTC)
    # S&P closes 16:00 New York (EDT, UTC-4 until 1 Nov) -> final 16:30 ET = 20:30 UTC
    assert complete_after(BY_KEY["SPX"], D("2026-10-28")) == datetime(2026, 10, 28, 20, 30, tzinfo=UTC)
    # futures-style series (no regular close) -> 17:00 New York + buffer
    assert complete_after(BY_KEY["BRENT"], D("2026-10-28")) == datetime(2026, 10, 28, 21, 30, tzinfo=UTC)
    # USD/INR is dated in UTC -> after the day ends
    assert complete_after(BY_KEY["USDINR"], D("2026-10-28")) > datetime(2026, 10, 29, 0, 0, tzinfo=UTC)


async def test_a_bar_of_a_session_still_running_is_never_stored(tmp_path: Path) -> None:
    store = HistoryStore(tmp_path)
    dl, clock = FakeDownloader(), Clock(datetime(2026, 10, 28, 4, 30, tzinfo=UTC))  # 10:00 IST, market open
    dl.data = {"NIFTY50": [row("2026-10-27"), row("2026-10-28", c=101)]}  # today's row is a partial bar
    svc = HistoryService(store, downloader=dl, symbols=[BY_KEY["NIFTY50"]], clock=clock, pause_between_s=0, start=D("2026-10-01"))
    out = await svc.refresh()
    assert [b.session for b in store.bars("NIFTY50")] == [D("2026-10-27")]
    assert out["results"][0]["partial_skipped"] == 1
    clock.now = EVENING  # 19:00 IST: the session is final and the next run stores it
    await svc.refresh()
    assert [b.session for b in store.bars("NIFTY50")] == [D("2026-10-27"), D("2026-10-28")]


def test_the_real_incident_a_us_bar_stored_mid_session_is_held_back_then_corrected(tmp_path: Path) -> None:
    """28 Oct 2026: S&P 500 etc. were stored at 15:15 UTC (11:15 New York), five hours before the close."""
    st = HistoryStore(tmp_path)
    mid_session = datetime(2026, 10, 28, 15, 15, tzinfo=UTC)
    st.insert_bars("SPX", [row("2026-10-27", c=100), row("2026-10-28", c=99.5)], source="yahoo", run_id="r1", now=mid_session)
    # the 27th was stored 09:15 UTC the day after? no: it was also stored before its own completion time
    # only the 28th must be held back; 27th (complete by 20:30 UTC on the 27th) is final
    assert [b.session for b in st.bars("SPX")] == [D("2026-10-27")]
    assert [(b["symbol"], b["session"], b["corrected"]) for b in st.premature_bars()] == [("SPX", "2026-10-28", False)]
    assert st.coverage()[0]["last"] == "2026-10-27"  # the series counts as one session behind, so it is 'stale' to the models

    # the next download happens after the close and carries the final bar
    after = datetime(2026, 10, 29, 2, 0, tzinfo=UTC)
    res = st.insert_bars("SPX", [row("2026-10-28", c=100.8)], source="yahoo", run_id="r2", now=after)
    assert (res.corrected, res.changed, res.new) == (1, 0, 0)
    bars = st.bars("SPX")
    assert [(b.session, b.close) for b in bars] == [(D("2026-10-27"), 100), (D("2026-10-28"), 100.8)]
    assert st.coverage()[0]["last"] == "2026-10-28"
    assert [b["corrected"] for b in st.premature_bars()] == [True]

    # nothing was deleted or rewritten: the partial bar is still on record beside its correction
    raw = sqlite3.connect(st.path)
    assert raw.execute("SELECT close FROM daily_bars WHERE symbol='SPX' AND session='2026-10-28'").fetchone() == (99.5,)
    assert raw.execute("SELECT close, replaces_retrieved_utc FROM bar_corrections").fetchone()[0] == 100.8
    with pytest.raises(sqlite3.DatabaseError, match="never overwritten"):
        raw.execute("UPDATE bar_corrections SET close=1")
    with pytest.raises(sqlite3.DatabaseError, match="never deleted"):
        raw.execute("DELETE FROM bar_corrections")
    raw.close()

    # a later, different value for an already corrected bar is a normal logged disagreement
    res = st.insert_bars("SPX", [row("2026-10-28", c=100.2)], source="yahoo", run_id="r3", now=after + timedelta(days=1))
    assert (res.corrected, res.changed) == (0, 1)
    assert st.bars("SPX")[-1].close == 100.8


def test_a_bar_stored_in_time_is_used_as_it_is(tmp_path: Path) -> None:
    st = HistoryStore(tmp_path)
    st.insert_bars("SPX", [row("2026-10-28", c=100.8)], source="yahoo", run_id="r1", now=datetime(2026, 10, 29, 2, 0, tzinfo=UTC))
    assert st.premature_bars() == [] and [b.close for b in st.bars("SPX")] == [100.8]


async def test_overnight_retry_logic_sees_a_held_back_bar_as_missing(tmp_path: Path) -> None:
    st = HistoryStore(tmp_path)
    clock = Clock(datetime(2026, 10, 29, 2, 10, tzinfo=UTC))  # 07:40 IST
    for k in ("SPX", "VIX", "BRENT", "DXY", "USDINR", "UST10Y"):
        st.insert_bars(k, [row("2026-10-27")], source="yahoo", run_id="a", now=datetime(2026, 10, 28, 6, 0, tzinfo=UTC))
        st.insert_bars(k, [row("2026-10-28")], source="yahoo", run_id="b", now=datetime(2026, 10, 28, 15, 15, tzinfo=UTC))
    svc = HistoryService(st, downloader=FakeDownloader(), symbols=[], clock=clock, pause_between_s=0)
    assert set(svc.overnight_missing(clock.now)) == {"SPX", "VIX", "BRENT", "DXY", "USDINR", "UST10Y"}


# ------------------------------------------------------------------------ 3. time boundary


def _paused(tmp_path: Path, now: datetime) -> bool:
    svc, _ = _service(tmp_path, 560, now)
    svc._pause_in_market_hours = True
    s = svc.summary()
    return bool(s.get("paused"))


def test_models_are_not_trained_during_market_hours_but_are_after_the_close(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    assert _paused(tmp_path / "a", _at(last, 10, 30))  # mid-session: paused
    assert _paused(tmp_path / "b", _at(last, 15, 40))  # settlement window
    assert not _paused(tmp_path / "c", _at(last, 15, 50))  # after the close: runs
    assert not _paused(tmp_path / "d", _at(last, 9, 5))  # before the open (the 08:35-09:10 forecast window)


def test_models_may_run_at_weekends(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    saturday = last + timedelta(days=(5 - last.weekday()) % 7 or 7)
    assert not _paused(tmp_path, _at(saturday, 11, 0))


def test_paused_state_still_serves_a_cached_report(tmp_path: Path) -> None:
    last = _walk(560, 1)[-1].session
    svc, _ = _service(tmp_path, 560, _at(last, 16, 30))
    ready = svc.summary(block=True)
    assert ready.get("ready", True) is not False
    next_day = _Cal().next_session(last)
    svc._clock = lambda: _at(next_day, 11, 0)  # the market is open again next day; no new bar yet
    svc._pause_in_market_hours = True
    again = svc.summary()
    assert "paused" not in again and "forecasts" in again
