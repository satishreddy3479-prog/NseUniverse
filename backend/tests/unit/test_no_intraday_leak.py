"""Guards that keep intraday and live data out of the daily price history.

Two independent layers are tested:
1. Code boundary: nothing under app/prediction may import live, broker, stream, observation-store,
   API or intraday code (so a future edit cannot wire intraday data into the models by accident).
2. Data boundary: only final daily bars reach the models (a bar of a session that has not finished
   is dropped on download, and a partial bar that was stored too early is replaced by its final
   bar or held back, never used as it was).
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




# ----------------------------------------------- provisional bars of 24-hour series (5 Nov 2026 incident)


def test_futures_fx_yield_bars_are_final_only_after_new_york_midnight() -> None:
    from app.prediction.sources.yahoo import final_after

    # 4 Nov 2026 (EST, UTC-5): 00:00 on the 5th New York + 30 min = 05:30 UTC
    for key in ("BRENT", "WTI", "GOLD", "DXY", "UST10Y"):
        assert final_after(BY_KEY[key], D("2026-11-04")) == datetime(2026, 11, 5, 5, 30, tzinfo=UTC)
    # series with a regular close, and USD/INR, keep their completion time
    assert final_after(BY_KEY["SPX"], D("2026-10-28")) == complete_after(BY_KEY["SPX"], D("2026-10-28"))
    assert final_after(BY_KEY["USDINR"], D("2026-10-28")) == complete_after(BY_KEY["USDINR"], D("2026-10-28"))


async def test_an_evening_bar_of_a_24_hour_series_is_provisional_not_history(tmp_path: Path) -> None:
    store = HistoryStore(tmp_path)
    dl = FakeDownloader()
    clock = Clock(datetime(2026, 11, 5, 3, 13, tzinfo=UTC))  # 08:43 IST, 22:13 New York on the 4th
    dl.data = {"DXY": [row("2026-11-03", c=100.87), row("2026-11-04", c=100.51)]}
    svc = HistoryService(store, downloader=dl, symbols=[BY_KEY["DXY"]], clock=clock, pause_between_s=0, start=D("2026-10-01"))
    out = await svc.refresh()
    assert [b.session for b in store.bars("DXY")] == [D("2026-11-03")]  # never stored as history
    assert out["results"][0]["provisional"] == "2026-11-04"
    bars, prov = store.bars_with_provisional("DXY")
    assert prov is not None and prov.close == 100.51 and bars[-1].session == D("2026-11-04")
    clock.now = datetime(2026, 11, 5, 6, 0, tzinfo=UTC)  # after New York midnight: the final bar is stored
    dl.data = {"DXY": [row("2026-11-03", c=100.87), row("2026-11-04", c=100.6)]}
    await svc.refresh()
    assert store.bars("DXY")[-1].close == 100.6
    assert store.bars_with_provisional("DXY")[1] is None  # nothing newer than the final bar


async def test_a_row_mixed_with_a_live_tick_is_not_used_even_as_provisional(tmp_path: Path) -> None:
    store = HistoryStore(tmp_path)
    dl = FakeDownloader()
    clock = Clock(datetime(2026, 11, 5, 3, 13, tzinfo=UTC))
    bad = row("2026-11-04", c=100.28)
    dl.data = {"DXY": [row("2026-11-03", c=100.87), type(bad)(bad.session, 101.474, 101.416, 101.261, 101.281, None)]}  # open above high
    svc = HistoryService(store, downloader=dl, symbols=[BY_KEY["DXY"]], clock=clock, pause_between_s=0, start=D("2026-10-01"))
    out = await svc.refresh()
    assert out["results"][0]["provisional"] is None
    assert store.bars_with_provisional("DXY")[1] is None  # stays missing and flagged stale; nothing is invented
