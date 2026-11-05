"""The daily swing paper job end to end, on synthetic stocks served by a fake fetcher (no network)."""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import threading
from datetime import UTC, date, datetime, time
from pathlib import Path
from time import sleep

import pytest

pytest.importorskip("pandas")
from fastapi.testclient import TestClient  # noqa: E402

from app.swing.engine import Config  # noqa: E402
from app.swing.fetch import FetchError, RawBar  # noqa: E402
from app.swing.service import SECTOR_INDICES, SwingPaperService  # noqa: E402
from app.swing.store import PaperStore  # noqa: E402
from tests.conftest import make_app  # noqa: E402
from tests.unit.test_swing_indicators import series  # noqa: E402

IST_OFFSET = "+05:30"
NAMES = sorted(f"S{n:02d}" for n in range(30))
CFG = Config(min_score=55.0, cost_per_side=0.0015)
FIRST, LAST = 300, 372  # bootstrap bar index and final bar index of the replayed range


def make_data() -> dict[str, list[RawBar]]:
    raw = {s: series(100 + i, n=LAST + 1, drift=0.0010 + 0.00005 * (i % 7), vol=0.014 + 0.0004 * (i % 5))
           for i, s in enumerate(NAMES)}
    base = raw[NAMES[0]]
    out: dict[str, list[RawBar]] = {}
    for s, b in raw.items():
        out[f"{s}.NS"] = [(b.dates[k], b.o[k], b.h[k], b.low[k], b.c[k], b.v[k]) for k in range(len(b))]
    index = [(base.dates[k], base.bench[k], base.bench[k], base.bench[k], base.bench[k], 0.0) for k in range(len(base))]
    out["^NSEI"] = index
    for t in SECTOR_INDICES.values():
        out[t] = index
    return out


class FakeFetcher:
    def __init__(self, data: dict[str, list[RawBar]]) -> None:
        self.data, self.cut, self.fail = data, None, set()
        self.gate: threading.Event | None = None  # holds every download until released
        self.threads: set[str] = set()  # names of the threads that asked for data

    def universe(self) -> list[dict]:
        return [{"nsecode": s} for s in NAMES]

    def daily(self, ticker: str) -> list[RawBar]:
        self.threads.add(threading.current_thread().name)
        if self.gate is not None:
            self.gate.wait(15)
        if ticker in self.fail:
            raise FetchError(f"{ticker}: down")
        bars = self.data[ticker]
        return bars[: self.cut] if self.cut else bars


def clock_after(data: dict[str, list[RawBar]], idx: int, hour: int = 18):
    d = data["^NSEI"][idx][0]
    t = datetime.fromisoformat(f"{d}T{hour:02d}:00:00{IST_OFFSET}").astimezone(UTC)
    return lambda: t


def service(tmp_path: Path, fetcher: FakeFetcher, clock) -> SwingPaperService:
    sectors = {s: "CNXIT" for s in NAMES}
    return SwingPaperService(PaperStore(tmp_path), fetcher, sectors=sectors, cfg=CFG, clock=clock)


def tables(store: PaperStore) -> dict:
    snap = store.snapshot(trades_limit=100000, decisions_limit=100000)
    # when a day was booked differs between day-by-day runs and one catch-up pass: that is the point of the field
    when = lambda k: k.endswith("_booked_at") or k in ("scanned_at", "seen_at", "entry_seen_at", "exit_seen_at")  # noqa: E731
    strip = lambda rows, drop: [{k: v for k, v in r.items() if k not in drop and not when(k)} for r in rows]  # noqa: E731
    return {
        "equity": snap["equity"],
        "trades": strip(snap["trades"], {"id"}),
        "decisions": strip(snap["decisions"], set()),
        "orders": strip(snap["orders"], {"id"}),
        "positions": strip(snap["positions"], set()),
    }


def test_first_run_starts_the_book_and_queues_orders_without_trading(tmp_path: Path) -> None:
    data = make_data()
    f = FakeFetcher(data)
    f.cut = FIRST
    svc = service(tmp_path, f, clock_after(data, FIRST - 1))
    r = svc.run_once()
    assert r["state"] == "ok" and r["session"] == data["^NSEI"][FIRST - 1][0] and r["sessions"] == 1
    snap = svc.store.snapshot()
    assert len(snap["equity"]) == 1 and snap["equity"][0]["equity"] == CFG.capital
    assert snap["trades"] == [] and snap["decisions"] == [] and snap["positions"] == []
    assert snap["meta"]["started"] == r["session"] and snap["scan"]["universe_size"] == 30
    assert svc.store.snapshot()["orders"] == snap["orders"]
    assert svc.run_once()["state"] == "up_to_date"  # same bar again: nothing is written twice


def test_day_by_day_equals_one_catch_up_pass(tmp_path: Path) -> None:
    data = make_data()
    a_dir, b_dir = tmp_path / "a", tmp_path / "b"
    fa = FakeFetcher(data)
    svc_a = service(a_dir, fa, lambda: None)  # clock replaced per day below
    for cut in range(FIRST, LAST + 2):
        fa.cut = cut
        svc_a._clock = clock_after(data, cut - 1)
        assert svc_a.run_once()["state"] in ("ok", "up_to_date")
    fb = FakeFetcher(data)
    svc_b = service(b_dir, fb, clock_after(data, FIRST - 1))
    fb.cut = FIRST
    assert svc_b.run_once()["state"] == "ok"  # bootstrap on the same first session
    svc_b._clock = clock_after(data, LAST)
    fb.cut = LAST + 1
    r = svc_b.run_once()
    assert r["state"] == "ok" and r["sessions"] == LAST - FIRST + 1
    ta, tb = tables(svc_a.store), tables(svc_b.store)
    assert ta == tb
    assert len(ta["equity"]) == LAST - FIRST + 2
    assert len(ta["trades"]) >= 3 and len(ta["decisions"]) >= 5, "the scenario must trade, or the check means nothing"
    for e in ta["equity"]:
        assert e["equity"] == pytest.approx(e["cash"] + e["invested"])
        assert e["open_positions"] <= CFG.slots


def test_incomplete_data_changes_nothing_and_is_retried(tmp_path: Path) -> None:
    data = make_data()
    f = FakeFetcher(data)
    f.cut = FIRST
    svc = service(tmp_path, f, clock_after(data, FIRST - 1))
    assert svc.run_once()["state"] == "ok"
    before = tables(svc.store)
    f.cut = FIRST + 1
    f.fail = {f"{s}.NS" for s in NAMES[:6]}  # 20 % of the list missing: the scan is not trusted
    svc._clock = clock_after(data, FIRST)
    r = svc.run_once()
    assert r["state"] == "data_unavailable" and "not trusted" in r["detail"]
    assert tables(svc.store) == before
    assert svc.done_on != date.fromisoformat(data["^NSEI"][FIRST][0])  # a failed day is not marked done
    f.fail = set()
    assert svc.run_once()["state"] == "ok"  # the next attempt succeeds and writes exactly one new session
    assert len(tables(svc.store)["equity"]) == len(before["equity"]) + 1


def test_a_missing_bar_for_a_queued_stock_is_retried_not_recorded_as_skipped(tmp_path: Path) -> None:
    """5 Nov 2026: Yahoo sent a 4 Nov row with no close or volume for four of the seven queued stocks. Writing
    "skipped: no price bar" would have been permanent and wrong; the pass waits for the data instead."""
    data = make_data()
    f = FakeFetcher(data)
    svc = service(tmp_path, f, lambda: None)
    cut = FIRST
    while True:  # replay day by day until the book has queued orders for the next session
        f.cut = cut
        svc._clock = clock_after(data, cut - 1)
        assert svc.run_once()["state"] == "ok"
        if svc.store.snapshot()["orders"] or cut >= LAST:
            break
        cut += 1
    queued = svc.store.snapshot()["orders"][0]["symbol"]
    before = tables(svc.store)
    day = data["^NSEI"][cut][0]  # the session those orders are meant for
    f.cut = cut + 1
    f.data = {**data, f"{queued}.NS": [b for b in data[f"{queued}.NS"] if b[0] != day]}  # a hole in the source
    svc._clock = clock_after(data, cut)
    r = svc.run_once()
    assert r["state"] == "data_unavailable" and queued in r["detail"] and day in r["detail"]
    assert tables(svc.store) == before  # no decision, no stop test, nothing committed
    f.data = data  # the source fills the hole
    assert svc.run_once()["state"] == "ok"
    assert not [d for d in tables(svc.store)["decisions"] if "no price bar" in str(d)]


def test_a_day_yahoo_sent_without_prices_is_read_from_the_exchange_file_and_said_so(tmp_path: Path) -> None:
    data = make_data()
    f = FakeFetcher(data)
    svc = service(tmp_path, f, lambda: None)
    cut = FIRST
    while True:
        f.cut = cut
        svc._clock = clock_after(data, cut - 1)
        assert svc.run_once()["state"] == "ok"
        if svc.store.snapshot()["orders"] or cut >= LAST:
            break
        cut += 1
    queued = svc.store.snapshot()["orders"][0]["symbol"]
    day = data["^NSEI"][cut][0]
    hole = [b for b in data[f"{queued}.NS"] if b[0] == day][0]
    f.cut = cut + 1
    f.data = {**data, f"{queued}.NS": [b for b in data[f"{queued}.NS"] if b[0] != day]}
    calls: list[str] = []
    f.nse_day = lambda s: calls.append(s) or {queued: hole}  # type: ignore[attr-defined]  # NSE's file has the stock's real day
    svc._clock = clock_after(data, cut)
    assert svc.run_once()["state"] == "ok" and calls == [day]  # one download for the day, however many stocks need it
    decided = [d for d in tables(svc.store)["decisions"] if d["symbol"] == queued]
    assert decided and "no price bar" not in str(decided)  # judged on the real day, not skipped for lack of data
    assert queued in svc.store.snapshot()["scan"]["note"] and "bhavcopy" in svc.store.snapshot()["scan"]["note"]


def test_recorded_history_is_append_only(tmp_path: Path) -> None:
    data = make_data()
    f = FakeFetcher(data)
    svc = service(tmp_path, f, lambda: None)
    for cut in range(FIRST, LAST + 2):  # enough sessions that every table holds rows
        f.cut = cut
        svc._clock = clock_after(data, cut - 1)
        svc.run_once()
    with sqlite3.connect(svc.store.path) as c:
        for table in ("orders", "decisions", "trades", "equity", "scan_runs", "universe_log"):
            assert c.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] > 0, table  # noqa: S608 - fixed table names
            with pytest.raises(sqlite3.DatabaseError, match="append-only"):
                c.execute(f"UPDATE {table} SET session = 'x'" if table != "trades" else "UPDATE trades SET reason = 'x'")  # noqa: S608
            with pytest.raises(sqlite3.DatabaseError, match="append-only"):
                c.execute(f"DELETE FROM {table}")  # noqa: S608
        n, = c.execute("SELECT MAX(count) FROM universe_log").fetchone()
    assert n == 30  # the point-in-time Chartink list is kept


def test_schedule_runs_once_per_day_after_17_ist_and_retries_until_the_session_arrives(tmp_path: Path) -> None:
    data = make_data()
    f = FakeFetcher(data)
    f.cut = FIRST
    last_day = date.fromisoformat(data["^NSEI"][FIRST - 1][0])
    assert last_day.weekday() < 5
    svc = service(tmp_path, f, clock_after(data, FIRST - 1, 16))
    at = lambda h, m: datetime.fromisoformat(f"{last_day.isoformat()}T{h:02d}:{m:02d}:00{IST_OFFSET}").astimezone(UTC)  # noqa: E731
    assert not svc.due(at(16, 59)) and svc.due(at(17, 0)) and not svc.due(at(23, 45))
    svc._clock = lambda: at(17, 5)
    assert svc.run_once()["state"] == "ok" and svc.done_on == last_day
    assert not svc.due(at(18, 0))  # done for today
    # the next weekday Yahoo has not published the new bar yet: not done, retried after the retry gap
    nxt = datetime.fromisoformat(f"{data['^NSEI'][FIRST][0]}T17:30:00{IST_OFFSET}").astimezone(UTC)
    svc._clock = lambda: nxt
    assert svc.due(nxt)
    assert svc.run_once()["state"] == "up_to_date" and svc.done_on == last_day
    assert not svc.due(nxt) and svc.due(datetime.fromtimestamp(nxt.timestamp() + 901, UTC))
    assert SwingPaperService.expected_session(date(2026, 11, 7)) == date(2026, 11, 6)  # Saturday -> Friday
    assert SwingPaperService.expected_session(date(2026, 11, 4)) == date(2026, 11, 4)
    assert SwingPaperService(PaperStore(tmp_path / "off"), f, sectors={}, enabled=False).due(at(18, 0)) is False
    assert time(17, 0) == svc.run_after


def test_view_and_api_expose_the_book(tmp_path: Path) -> None:
    data = make_data()
    app = make_app(tmp_path)
    with TestClient(app, client=("127.0.0.1", 50000)) as c:
        empty = c.get("/api/swing/paper").json()
        assert empty["book"]["sessions"] == 0 and empty["status"]["enabled"] is False and empty["orders"] == []
        assert empty["book"]["equity"] == empty["book"]["capital"]
        svc = app.state.swing_paper
        f = FakeFetcher(data)
        svc.fetcher, svc.sectors, svc.cfg = f, {s: "CNXIT" for s in NAMES}, CFG
        for cut in range(FIRST, FIRST + 40):
            f.cut = cut
            svc._clock = clock_after(data, cut - 1)
            svc.run_once()
        body = c.get("/api/swing/paper").json()
    json.dumps(body)  # everything is plain JSON
    b = body["book"]
    assert b["sessions"] == 40 and b["as_of"] == data["^NSEI"][FIRST + 38][0]
    assert b["equity"] == pytest.approx(b["cash"] + b["invested"])
    assert b["return_pct"] == pytest.approx((b["equity"] / b["capital"] - 1) * 100)
    assert body["config"]["risk_pct"] == pytest.approx(2.0) and body["config"]["cost_per_side_pct"] == pytest.approx(0.15)
    for p in body["positions"]:
        assert p["stop_stage"] in ("initial stop", "breakeven", "trailing")
        assert p["unrealized_pnl"] == pytest.approx(p["shares"] * (p["last_close"] - p["fill"]))
    for o in body["orders"]:
        assert o["trigger"] == pytest.approx(o["pivot"] * 1.003) and o["max_open"] == pytest.approx(o["pivot"] * 1.025)
    assert body["scan"]["universe_size"] == 30 and body["recent_runs"]


async def test_run_now_starts_in_the_background_shows_progress_and_refuses_a_second_start(tmp_path: Path) -> None:
    data = make_data()
    f = FakeFetcher(data)
    f.cut = FIRST
    f.gate = threading.Event()
    svc = service(tmp_path, f, clock_after(data, FIRST - 1))
    assert svc.status()["running"] is False and svc.status()["progress"] is None
    assert svc.trigger() is True
    for _ in range(100):  # wait until the worker thread is inside the run
        if svc.progress is not None:
            break
        await asyncio.sleep(0.05)
    st = svc.status()
    assert st["running"] is True and st["progress"]["phase"] and st["progress"]["started_at"]
    assert svc.trigger() is False  # a scan is already running
    assert svc.run_once()["state"] == "busy"  # and a second pass changes nothing
    f.gate.set()
    await svc._manual  # let the real run finish
    st = svc.status()
    assert st["running"] is False and st["progress"] is None and st["last_result"].startswith("ok")
    assert len(svc.store.snapshot()["equity"]) == 1  # exactly one session was recorded
    assert svc.trigger() is True  # free again; this pass finds nothing new and says so
    await svc._manual
    assert svc.status()["last_result"].startswith("up_to_date")


def test_run_now_endpoint_is_local_only_and_runs_the_scan(tmp_path: Path) -> None:
    data = make_data()
    app = make_app(tmp_path)
    with TestClient(app, client=("203.0.113.9", 50000)) as remote:  # not the server itself
        assert remote.post("/api/swing/paper/run").status_code == 403
    with TestClient(app, client=("127.0.0.1", 50000)) as c:
        svc = app.state.swing_paper
        f = FakeFetcher(data)
        f.cut = FIRST
        svc.fetcher, svc.sectors, svc.cfg = f, {s: "CNXIT" for s in NAMES}, CFG
        svc._clock = clock_after(data, FIRST - 1)
        r = c.post("/api/swing/paper/run")
        assert r.status_code == 200 and r.json()["started"] is True
        body = {}
        for _ in range(300):
            body = c.get("/api/swing/paper").json()
            if not body["status"]["running"] and body["book"]["sessions"] == 1:
                break
            sleep(0.05)
    assert body["book"]["sessions"] == 1 and body["status"]["last_result"].startswith("ok")
    assert body["status"]["progress"] is None


async def test_the_scan_runs_in_its_own_thread_not_the_shared_worker_pool(tmp_path: Path) -> None:
    data = make_data()
    f = FakeFetcher(data)
    f.cut = FIRST
    svc = service(tmp_path, f, clock_after(data, FIRST - 1))
    assert svc.trigger() is True
    await svc._manual
    assert f.threads == {"swing-paper-scan"}  # not asyncio_0 / ThreadPoolExecutor-*, which the broker calls also use
    f.threads.clear()
    f.cut = FIRST + 1
    svc._clock = clock_after(data, FIRST)
    assert (await svc._run_in_thread("schedule"))["state"] == "ok"
    assert f.threads == {"swing-paper-scan"}
    for _ in range(100):  # the result is handed back from inside the thread, which may still be finishing
        if not [t for t in threading.enumerate() if t.name == "swing-paper-scan"]:
            break
        await asyncio.sleep(0.02)
    assert not [t for t in threading.enumerate() if t.name == "swing-paper-scan"]  # the thread ends with the pass


def test_start_and_finish_are_logged_with_source_and_duration(tmp_path: Path, caplog) -> None:
    data = make_data()
    f = FakeFetcher(data)
    f.cut = FIRST
    svc = service(tmp_path, f, clock_after(data, FIRST - 1))
    with caplog.at_level(logging.INFO, logger="app.swing.service"):
        svc.run_once("manual")
    events = {r.getMessage(): r.fields for r in caplog.records if r.getMessage().startswith("swing_paper_")}  # type: ignore[attr-defined]
    assert events["swing_paper_start"] == {"source": "manual"}
    done = events["swing_paper_run"]
    assert done["state"] == "ok" and done["source"] == "manual" and done["seconds"] >= 0


async def test_an_unexpected_failure_in_the_pass_never_hangs_the_waiter(tmp_path: Path) -> None:
    data = make_data()
    svc = service(tmp_path, FakeFetcher(data), clock_after(data, FIRST - 1))

    def boom(source: str = "schedule") -> dict:
        raise ZeroDivisionError("simulated bug")

    svc.run_once = boom  # type: ignore[method-assign]
    with pytest.raises(ZeroDivisionError):
        await asyncio.wait_for(svc._run_in_thread("manual"), 5)  # a hang would time out here
    assert svc.trigger() is True  # the failed manual run did not leave the service stuck
    with pytest.raises(ZeroDivisionError):
        await asyncio.wait_for(svc._manual, 5)
    assert svc.trigger() is True and svc._manual is not None
    with pytest.raises(ZeroDivisionError):
        await asyncio.wait_for(svc._manual, 5)


def test_snapshot_says_when_each_day_was_booked_and_when_the_live_feed_saw_the_trigger(tmp_path: Path) -> None:
    """The book is settled from daily bars after the close, so it knows the day of a fill, not the minute: the snapshot
    carries when the job recorded the day and, only where the live layer was watching, the moment it saw the rule met."""
    data = make_data()
    f = FakeFetcher(data)
    svc = service(tmp_path, f, lambda: None)
    f.cut = FIRST
    svc._clock = clock_after(data, FIRST - 1)
    assert svc.run_once()["state"] == "ok"
    f.cut = LAST + 1
    svc._clock = clock_after(data, LAST)  # one catch-up pass replays every later session
    assert svc.run_once()["state"] == "ok"
    snap = svc.store.snapshot(trades_limit=1000)
    runs = {r["session"]: r["ran_at"] for r in svc.store.snapshot()["recent_runs"]}
    assert snap["trades"], "the scenario must trade, or the check means nothing"
    last_run = svc.store.snapshot()["recent_runs"][0]
    for x in snap["trades"][:3]:
        assert x["entered_booked_at"] and x["exited_booked_at"]
        assert x["entry_seen_at"] is None and x["exit_seen_at"] is None  # no live layer was watching: nothing is guessed
    assert snap["orders"][0]["scanned_at"] == last_run["ran_at"] == runs[last_run["session"]]
    # a live trigger logged for a traded stock and day appears on that trade, and a stop hit on its exit
    x = snap["trades"][0]
    when = datetime(2026, 11, 5, 4, 7, 57, tzinfo=UTC)
    svc.store.record_live_event(x["entry_session"], when, "entry_trigger", x["symbol"], 100.0, 1, {})
    svc.store.record_live_event(x["exit_session"], when, "stop_hit", x["symbol"], 99.0, 1, {})
    again = svc.store.snapshot(trades_limit=1000)["trades"][0]
    assert again["entry_seen_at"] == when.isoformat()
    assert (again["exit_seen_at"] == when.isoformat()) == str(again["reason"]).startswith("STOP")
