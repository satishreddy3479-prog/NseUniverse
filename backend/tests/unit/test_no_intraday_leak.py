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
from datetime import UTC, date, datetime
from pathlib import Path

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
    assert complete_after(BY_KEY["INDIAVIX"], D("2026-10-28")) == datetime(2026, 10, 28, 10, 40, tzinfo=UTC)


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


def test_a_bar_stored_in_time_is_used_as_it_is(tmp_path: Path) -> None:
    st = HistoryStore(tmp_path)
    st.insert_bars("SPX", [row("2026-10-28", c=100.8)], source="yahoo", run_id="r1", now=datetime(2026, 10, 29, 2, 0, tzinfo=UTC))
    assert st.premature_bars() == [] and [b.close for b in st.bars("SPX")] == [100.8]


# ----------------------------------------------- provisional bars of 24-hour series (5 Nov 2026 incident)


