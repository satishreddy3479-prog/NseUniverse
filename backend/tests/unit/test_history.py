"""Price-history store and downloader. The downloader is a FAKE returning test rows: no network, and
no number here is ever written to the application's data."""

from __future__ import annotations

import sqlite3
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.prediction.history_service import HistoryService
from app.prediction.history_store import HistoryStore
from app.prediction.sources.yahoo import BY_KEY, SYMBOLS, RawRow, SymbolSpec, rows_from_frame
from tests.conftest import make_app

D = date.fromisoformat
NIFTY = BY_KEY["NIFTY50"]
VIX = BY_KEY["INDIAVIX"]


def row(
    d: str, o: float = 100, h: float = 101, low: float = 99, c: float = 100.5, v: float | None = 0
) -> RawRow:
    return RawRow(D(d), o, h, low, c, v)


class TestStore:
    def test_new_bars_are_stored_with_provenance(self, tmp_path: Path) -> None:
        st = HistoryStore(tmp_path)
        res = st.insert_bars(
            "NIFTY50", [row("2026-10-27"), row("2026-10-28", c=101)], source="yahoo", run_id="r1"
        )
        assert (res.new, res.unchanged, res.changed) == (2, 0, 0)
        bars = st.bars("NIFTY50")
        assert [b.session for b in bars] == [D("2026-10-27"), D("2026-10-28")] and bars[
            1
        ].close == 101
        assert st.last_session("NIFTY50") == D("2026-10-28")
        assert st.coverage()[0]["bars"] == 2

    def test_first_seen_values_are_never_overwritten_and_disagreements_are_logged(
        self, tmp_path: Path
    ) -> None:
        st = HistoryStore(tmp_path)
        st.insert_bars("NIFTY50", [row("2026-10-27", c=100.5)], source="yahoo", run_id="r1")
        again = st.insert_bars("NIFTY50", [row("2026-10-27", c=100.5)], source="yahoo", run_id="r2")
        assert (again.new, again.unchanged) == (0, 1)
        res = st.insert_bars("NIFTY50", [row("2026-10-27", c=100.9)], source="yahoo", run_id="r3")
        assert res.changed == 1
        assert st.bars("NIFTY50")[0].close == 100.5  # the stored bar did not move
        assert st.coverage()[0]["disagreements"] == 1
        raw = sqlite3.connect(st.path)
        with pytest.raises(sqlite3.DatabaseError, match="never overwritten"):
            raw.execute("UPDATE daily_bars SET close=1")
        with pytest.raises(sqlite3.DatabaseError, match="never deleted"):
            raw.execute("DELETE FROM daily_bars")

    def test_incomplete_and_impossible_rows_are_counted_not_stored(self, tmp_path: Path) -> None:
        st = HistoryStore(tmp_path)
        rows = [
            RawRow(D("2026-10-26"), None, None, None, None, None),  # holiday-like row
            RawRow(D("2026-10-27"), 100, 99, 98, 100, 0),  # high below close
            RawRow(D("2026-10-28"), -1, 1, 1, 1, 0),
            row("2026-10-29"),
        ]
        res = st.insert_bars("NIFTY50", rows, source="yahoo", run_id="r1")
        assert (res.incomplete, res.invalid, res.new) == (1, 2, 1)
        assert len(st.bars("NIFTY50")) == 1

    def test_zero_index_volume_is_stored_as_missing(self, tmp_path: Path) -> None:
        st = HistoryStore(tmp_path)
        st.insert_bars("NIFTY50", [row("2026-10-27", v=0)], source="yahoo", run_id="r1")
        raw = sqlite3.connect(st.path)
        assert raw.execute("SELECT volume FROM daily_bars").fetchone() == (None,)


class TestFrameConversion:
    def test_yfinance_style_frame_becomes_rows(self) -> None:
        pd = pytest.importorskip("pandas")
        idx = pd.DatetimeIndex(["2026-10-27", "2026-10-28"]).tz_localize("Asia/Kolkata")
        nan = float("nan")
        df = pd.DataFrame(
            {
                "Open": [100.0, nan],
                "High": [101.0, nan],
                "Low": [99.0, nan],
                "Close": [100.5, nan],
                "Volume": [0, 0],
            },
            index=idx,
        )
        rows = rows_from_frame(df)
        assert rows[0].session == D("2026-10-27") and rows[0].close == 100.5
        assert rows[1].close is None  # NaN becomes missing, never a number
        assert rows_from_frame(None) == [] and rows_from_frame(pd.DataFrame()) == []


class FakeDownloader:
    def __init__(self) -> None:
        self.calls: list[tuple[str, date, date]] = []
        self.fail: set[str] = set()
        self.data: dict[str, list[RawRow]] = {}

    def __call__(self, spec: SymbolSpec, start: date, end: date) -> list[RawRow]:
        self.calls.append((spec.key, start, end))
        if spec.key in self.fail:
            raise ConnectionError("simulated outage")
        return [r for r in self.data.get(spec.key, []) if start <= r.session < end]


class Clock:
    def __init__(self, at: datetime) -> None:
        self.now = at

    def __call__(self) -> datetime:
        return self.now


EVENING = datetime(2026, 10, 28, 13, 30, tzinfo=UTC)  # 19:00 IST on Wednesday


def make(tmp_path: Path, **kw: object) -> tuple[HistoryService, FakeDownloader, Clock]:
    dl, clock = FakeDownloader(), Clock(EVENING)
    dl.data = {
        "NIFTY50": [row("2026-10-27"), row("2026-10-28", c=101)],
        "INDIAVIX": [row("2026-10-28", 14, 15, 13, 14.5)],
    }
    svc = HistoryService(
        HistoryStore(tmp_path), downloader=dl, symbols=[NIFTY, VIX], clock=clock, pause_between_s=0,
        start=D("2026-10-01"), **kw,  # type: ignore[arg-type]
    )  # fmt: skip
    return svc, dl, clock


class TestService:
    async def test_first_refresh_downloads_everything_and_reports_per_symbol(
        self, tmp_path: Path
    ) -> None:
        svc, dl, _ = make(tmp_path)
        out = await svc.refresh()
        assert out["ok_symbols"] == 2 and out["new_bars"] == 3 and not out["failed_symbols"]
        assert dl.calls[0][1] == D("2026-10-01")  # no stored history yet: from the configured start
        assert dl.calls[0][2] == D("2026-10-29")  # end is exclusive: today (IST) + 1
        st = svc.status()
        assert [s["has_data"] for s in st["symbols"]] == [True, True]
        assert (
            st["symbols"][0]["last"] == "2026-10-28"
            and st["last_run"]["summary"]["ok_symbols"] == 2
        )

    async def test_later_runs_only_ask_for_the_overlap_window(self, tmp_path: Path) -> None:
        svc, dl, clock = make(tmp_path)
        await svc.refresh()
        dl.calls.clear()
        clock.now = EVENING + timedelta(days=1)
        await svc.refresh()
        assert dl.calls[0][1] == D("2026-10-28") - timedelta(days=10)

    async def test_one_failing_symbol_does_not_stop_the_others(self, tmp_path: Path) -> None:
        svc, dl, _ = make(tmp_path)
        dl.fail = {"NIFTY50"}
        out = await svc.refresh()
        assert out["failed_symbols"] == ["NIFTY50"] and out["ok_symbols"] == 1
        assert (
            svc.status()["symbols"][0]["has_data"] is False
        )  # nothing invented for the failed one
        assert "ConnectionError" in out["results"][0]["error"]

    async def test_a_symbol_with_no_data_is_reported_empty_not_ok(self, tmp_path: Path) -> None:
        svc, dl, _ = make(tmp_path)
        dl.data["INDIAVIX"] = []
        out = await svc.refresh()
        assert out["empty_symbols"] == ["INDIAVIX"] and out["ok_symbols"] == 1

    async def test_schedule_runs_first_then_once_a_day_after_the_close(
        self, tmp_path: Path
    ) -> None:
        svc, _, clock = make(tmp_path)
        assert svc.due()  # nothing downloaded yet
        await svc.refresh()
        assert not svc.due()  # already done today
        clock.now = datetime(2026, 10, 29, 0, 30, tzinfo=UTC)  # 06:00 IST next day: before the morning run
        assert not svc.due()
        clock.now = datetime(2026, 10, 29, 2, 30, tzinfo=UTC)  # 08:00 IST: the overnight US close is in
        svc.last_attempt = None
        assert svc.due()
        svc.last_attempt = clock.now  # (that run happens) ...
        clock.now = datetime(2026, 10, 29, 4, 0, tzinfo=UTC)  # 09:30 IST: not again until the evening run
        svc.last_attempt = None
        svc.store.last_success_utc = lambda: datetime(2026, 10, 29, 2, 40, tzinfo=UTC)  # type: ignore[method-assign]
        assert not svc.due()
        svc.store.last_success_utc = lambda: datetime(2026, 10, 28, 15, 0, tzinfo=UTC)  # type: ignore[method-assign]
        clock.now = datetime(2026, 10, 29, 13, 30, tzinfo=UTC)  # 19:00 IST
        assert svc.due()
        clock.now = datetime(2026, 10, 31, 13, 30, tzinfo=UTC)  # Saturday evening
        svc.last_attempt = None
        assert not svc.due()

    async def test_a_failed_run_is_retried_after_an_hour_not_every_poll(
        self, tmp_path: Path
    ) -> None:
        svc, dl, clock = make(tmp_path)
        dl.fail = {"NIFTY50", "INDIAVIX"}
        await svc.refresh()
        assert not svc.due()  # one attempt just failed
        clock.now += timedelta(minutes=61)
        assert svc.due()  # nothing ever succeeded, so it tries again

    async def test_disabled_service_never_runs(self, tmp_path: Path) -> None:
        svc, _, _ = make(tmp_path, enabled=False)
        assert not svc.due()


def test_registry_is_honest_about_what_is_verified() -> None:
    assert BY_KEY["NIFTY50"].timing_verified and BY_KEY["NIFTY50"].yahoo == "^NSEI"
    # every series is used only through "last bar dated on or before the reference session", which is
    # complete by 08:30 IST the next morning (see the note above SYMBOLS); series with a stated close
    # time must satisfy that rule in their own timezone
    from datetime import datetime as _dt
    from zoneinfo import ZoneInfo

    assert all(s.timing_verified for s in SYMBOLS)
    for s in SYMBOLS:
        if s.close is None:
            continue
        closes = _dt(2026, 10, 28, s.close.hour, s.close.minute, tzinfo=ZoneInfo(s.timezone))
        assert closes.astimezone(ZoneInfo("Asia/Kolkata")) < _dt(2026, 10, 29, 8, 30, tzinfo=ZoneInfo("Asia/Kolkata")), s.key
    assert len({s.key for s in SYMBOLS}) == len(SYMBOLS) and BY_KEY["USDINR"].close is None


def test_api_status_and_refresh_endpoints(tmp_path: Path) -> None:
    app = make_app(tmp_path)  # autofetch is off in tests
    with TestClient(app, client=("127.0.0.1", 50000)) as c:
        st = c.get("/api/prediction/history/status").json()
        assert st["enabled"] is False and st["running"] is False
        assert st["symbols"][0]["key"] == "NIFTY50" and st["symbols"][0]["has_data"] is False
        # replace the real downloader with the fake so the endpoint can be exercised offline
        dl = FakeDownloader()
        dl.data = {"NIFTY50": [row("2026-10-28")]}
        svc: HistoryService = app.state.history
        svc._download = dl  # type: ignore[assignment]
        svc.symbols = [NIFTY]
        svc._pause = 0
        r = c.post("/api/prediction/history/refresh").json()
        assert r["started"] is True
    with TestClient(app, client=("203.0.113.9", 4000)) as remote:
        assert (
            remote.post("/api/prediction/history/refresh").status_code == 403
        )  # local control only
