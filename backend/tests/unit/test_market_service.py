"""Parsers (on real NSE file lines), the append-only store, the service on stand-in ticks, stream isolation and
the link into the intraday score.

File lines below are REAL lines of the NSE files as fetched on 2026-10-29 (index list, bhavcopy of 28 Oct 2026).
Kotak tokens and live ticks are stand-ins (no stock ticks have been captured yet): they test arithmetic and wiring only.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.market import sources
from app.market.service import MarketService
from app.market.sources import (
    SourceError,
    TokenInfo,
    parse_bhavcopy,
    parse_index_list,
    parse_scrip_master,
)
from app.market.store import MarketStore
from app.stream.models import LiveTick
from tests.conftest import make_app

LIST_TEXT = """Company Name,Industry,Symbol,Series,ISIN Code
Adani Enterprises Ltd.,Metals & Mining,ADANIENT,EQ,INE423A01024
Adani Ports and Special Economic Zone Ltd.,Services,ADANIPORTS,EQ,INE742F01042
Apollo Hospitals Enterprise Ltd.,Healthcare,APOLLOHOSP,EQ,INE437A01024
Asian Paints Ltd.,Consumer Durables,ASIANPAINT,EQ,INE021A01026
Axis Bank Ltd.,Financial Services,AXISBANK,EQ,INE238A01034
BSE Ltd.,Financial Services,BSE,EQ,INE118H01025
Bajaj Auto Ltd.,Automobile and Auto Components,BAJAJ-AUTO,EQ,INE917I01010
Bajaj Finance Ltd.,Financial Services,BAJFINANCE,EQ,INE296A01032
"""
BHAV_TEXT = """SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER
20MICRONS, EQ, 28-Oct-2026, 188.69, 187.80, 187.84, 156.76, 158.60, 161.04, 165.51, 1133822, 1876.57, 17308, 304588, 26.86
21STCENMGM, EQ, 28-Oct-2026, 49.96, 52.37, 52.45, 48.75, 52.45, 52.45, 52.06, 33152, 17.26, 216, 22348, 67.41
360ONE, EQ, 28-Oct-2026, 973.00, 973.00, 995.30, 965.70, 991.00, 991.00, 979.05, 330282, 3233.62, 12364, 208810, 63.22
3BBLACKBIO, EQ, 28-Oct-2026, 1381.60, 1378.00, 1398.10, 1354.90, 1370.00, 1363.00, 1371.09, 4676, 64.11, 688, 2427, 51.90
"""
SYMS = ["ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK", "BSE", "BAJAJ-AUTO", "BAJFINANCE"]
NOW = datetime(2026, 10, 29, 4, 30, tzinfo=UTC)  # 10:00 IST, a Thursday


@pytest.fixture(autouse=True)
def _small_lists(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sources.INDEXES, "nifty50", (1, 60))
    monkeypatch.setitem(sources.INDEXES, "nifty500", (1, 600))


# ---------------------------------------------------------------------------------- parsers


def test_index_list_parses_the_real_nse_format() -> None:
    items = parse_index_list(LIST_TEXT, "nifty50")
    assert [c.symbol for c in items] == SYMS
    assert items[6].industry == "Automobile and Auto Components" and items[6].isin == "INE917I01010"
    assert items[0].name == "Adani Enterprises Ltd."
    assert len(parse_index_list("﻿" + LIST_TEXT, "nifty50")) == 8  # byte-order mark tolerated


def test_index_list_rejects_wrong_sizes_and_missing_columns(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sources.INDEXES, "nifty50", (50, 50))
    with pytest.raises(SourceError, match="expected 50-50"):
        parse_index_list(LIST_TEXT, "nifty50")
    with pytest.raises(SourceError, match="no 'symbol' column"):
        parse_index_list("Name,Industry\nA,B\n", "nifty50")
    # non-EQ series and duplicates are skipped
    monkeypatch.setitem(sources.INDEXES, "nifty50", (1, 60))
    text = LIST_TEXT + "Foo Ltd.,Services,FOO,BE,INE000000000\nAdani Enterprises Ltd.,Metals & Mining,ADANIENT,EQ,INE423A01024\n"
    assert len(parse_index_list(text, "nifty50")) == 8


def test_bhavcopy_parses_the_real_format_with_spaces_after_commas() -> None:
    rows = parse_bhavcopy(BHAV_TEXT)
    assert len(rows) == 4
    r = rows[0]
    assert (r.symbol, r.session, r.prev_close, r.close, r.volume, r.deliv_qty) == ("20MICRONS", date(2026, 10, 28), 188.69, 161.04, 1133822, 304588)
    assert parse_bhavcopy(BHAV_TEXT, only={"360ONE"})[0].volume == 330282
    assert parse_bhavcopy(BHAV_TEXT.replace(" EQ,", " BE,", 1))[0].symbol == "21STCENMGM"  # non-EQ rows are skipped


def test_bhavcopy_missing_values_stay_missing_and_bad_files_are_rejected() -> None:
    text = BHAV_TEXT.splitlines()[0] + "\nAAA, EQ, 28-Oct-2026, 10.0, 10, 10, 10, 10, 10, 10, 500, 1.0, 5, -, -\n"
    assert parse_bhavcopy(text)[0].deliv_qty is None
    with pytest.raises(SourceError):
        parse_bhavcopy("not,a,bhavcopy\n1,2,3\n")
    with pytest.raises(SourceError, match="no equity rows"):
        parse_bhavcopy(BHAV_TEXT.splitlines()[0] + "\n")


def test_scrip_master_keeps_equity_trading_symbols_only() -> None:
    """Column names follow the Kotak SDK documentation (pSymbol, pTrdSymbol, pExchSeg); verified live in the capture."""
    rows = [
        {"pSymbol": "1333", "pTrdSymbol": "HDFCBANK-EQ", "pExchSeg": "nse_cm", "pGroup": "EQ"},
        {"pSymbol": "4963", "pTrdSymbol": "BAJAJ-AUTO-EQ", "pExchSeg": "nse_cm"},
        {"pSymbol": "99", "pTrdSymbol": "HDFCBANK-BE", "pExchSeg": "nse_cm"},
        {"pSymbol": "55", "pTrdSymbol": "SBIN-EQ", "pExchSeg": "bse_cm"},
        {"pSymbol": "", "pTrdSymbol": "X-EQ", "pExchSeg": "nse_cm"},
    ]
    t = parse_scrip_master(rows)
    assert set(t) == {"HDFCBANK", "BAJAJ-AUTO"} and t["BAJAJ-AUTO"] == TokenInfo("BAJAJ-AUTO", "4963", "BAJAJ-AUTO-EQ")


# ------------------------------------------------------------------------------------ store


def test_store_is_append_only_idempotent_and_picks_official_weights(tmp_path: Path) -> None:
    st = MarketStore(tmp_path)
    items = parse_index_list(LIST_TEXT, "nifty50")
    assert st.save_list("nifty50", items, LIST_TEXT.encode(), NOW) is True
    assert st.save_list("nifty50", items, LIST_TEXT.encode(), NOW) is False  # same file, nothing new
    got, meta = st.current_list("nifty50") or ([], {})
    assert [c.symbol for c in got] == sorted(SYMS) and len(meta["sha256"]) == 64
    st.save_weights("nifty50", {"AXISBANK": 60.0, "BSE": 40.0}, date(2026, 9, 30), "approx-yahoo-float", NOW)
    assert (st.latest_weights("nifty50") or ({}, "", ""))[2] == "approx-yahoo-float"
    st.save_weights("nifty50", {"AXISBANK": 70.0, "BSE": 30.0}, date(2026, 9, 30), "NSE factsheet", NOW)
    w, as_of, src = st.latest_weights("nifty50") or ({}, "", "")
    assert src == "NSE factsheet" and w["AXISBANK"] == 70.0  # official beats approximate of the same date
    st.save_bhav(parse_bhavcopy(BHAV_TEXT))
    raw = sqlite3.connect(st.path)
    with pytest.raises(sqlite3.DatabaseError, match="never changed"):
        raw.execute("UPDATE bhav SET volume = 1")
    with pytest.raises(sqlite3.DatabaseError, match="never deleted"):
        raw.execute("DELETE FROM constituents")
    raw.close()


def test_average_volume_needs_enough_sessions(tmp_path: Path) -> None:
    st = MarketStore(tmp_path)
    for i in range(9):
        st.save_bhav([r for r in parse_bhavcopy(BHAV_TEXT.replace("28-Oct-2026", f"{i + 1:02d}-Oct-2026"))])
    assert st.avg_volume(["360ONE"]) == {}  # 9 sessions < 10
    st.save_bhav(parse_bhavcopy(BHAV_TEXT.replace("28-Oct-2026", "10-Oct-2026")))
    assert st.avg_volume(["360ONE", "NOSUCH"]) == {"360ONE": 330282.0}


# ---------------------------------------------------------------------------------- service

TOKENS = {s: str(100 + i) for i, s in enumerate(SYMS)}  # stand-in tokens
WEIGHTS = dict(zip(SYMS, [20.0, 15.0, 10.0, 5.0, 25.0, 5.0, 10.0, 10.0], strict=True))
PREV = dict.fromkeys(SYMS, 100.0)


def lt(sym: str, ltp: float | None, vol: int | None = 100, high: float | None = None, low: float | None = None, age_s: float = 5) -> LiveTick:
    return LiveTick(key=f"nse_cm|{TOKENS[sym]}", kind="scrip", exchange_segment="nse_cm", instrument_token=TOKENS[sym], trading_symbol=f"{sym}-EQ",
                    ltp=ltp, high=high, low=low, prev_close=PREV[sym], volume=vol, received_at=NOW - timedelta(seconds=age_s))  # fmt: skip


def build(tmp_path: Path, ticks: dict[str, float | None], *, weights: bool = True, volumes: bool = True, vol: int = 100) -> MarketService:
    st = MarketStore(tmp_path)
    items = parse_index_list(LIST_TEXT, "nifty50")
    st.save_list("nifty50", items, LIST_TEXT.encode(), NOW)
    st.save_list("nifty500", items, (LIST_TEXT + "\n").encode(), NOW)
    st.save_tokens({s: TokenInfo(s, t, f"{s}-EQ") for s, t in TOKENS.items()}, date(2026, 10, 29))
    if weights:
        st.save_weights("nifty50", WEIGHTS, date(2026, 9, 30), "NSE factsheet", NOW)
    if volumes:
        for d in range(1, 13):
            st.save_bhav([sources.BhavRow(date(2026, 10, d), s, 100.0, 100.0, 1000, None) for s in SYMS])
    book = {f"nse_cm|{TOKENS[s]}": lt(s, p, vol, high=p, low=PREV[s]) for s, p in ticks.items() if p is not None}
    book["nse_cm|Nifty 50"] = LiveTick(key="nse_cm|Nifty 50", kind="index", exchange_segment="nse_cm", instrument_token="Nifty 50", ltp=101.0, prev_close=100.0, received_at=NOW)
    return MarketService(st, ticks=lambda: book, clock=lambda: NOW)


def test_summary_is_hand_calculated(tmp_path: Path) -> None:
    # changes: ADANIENT +2, ADANIPORTS +1, APOLLOHOSP +1, ASIANPAINT -1, AXISBANK +1.5, BSE +0.02 (flat), BAJAJ-AUTO -2, BAJFINANCE no tick
    px = {"ADANIENT": 102.0, "ADANIPORTS": 101.0, "APOLLOHOSP": 101.0, "ASIANPAINT": 99.0, "AXISBANK": 101.5, "BSE": 100.02, "BAJAJ-AUTO": 98.0, "BAJFINANCE": None}
    s = build(tmp_path, px).summary(NOW)
    b = s["nifty50"]["breadth"]
    assert (b["total"], b["covered"], b["advancing"], b["declining"], b["flat"]) == (8, 7, 4, 2, 1)
    assert b["ad_balance"] == pytest.approx(2 / 6) and b["equal_weight_return"] == pytest.approx((2 + 1 + 1 - 1 + 1.5 + 0.02 - 2) / 7)
    c = s["nifty50"]["contribution"]
    # w/100 * change: 0.4 + 0.15 + 0.1 - 0.05 + 0.375 + 0.001 - 0.2 = 0.776 over the covered weight 90 (BAJFINANCE's 10 missing)
    assert c["net_points_pct"] == pytest.approx(0.776) and c["weight_covered"] == 90 and c["weight_loaded"] == 100
    assert c["cap_weight_return"] == pytest.approx(0.776 / 0.9)
    assert s["nifty50"]["stocks"][0]["symbol"] == "AXISBANK" or s["nifty50"]["stocks"][0]["symbol"] == "ADANIENT"
    assert s["index_change_pct"] == pytest.approx(1.0) and s["nifty500"]["breadth"]["covered"] == 7
    assert s["sources"]["tokens"]["found"] == 8 and s["sources"]["weights"]["approximate"] is False


def test_volume_baseline_and_relative_volume(tmp_path: Path) -> None:
    px = {s: 101.0 for s in SYMS}
    # 10:00 IST = 45 min = 12 % of the session; average 1000/day -> expected 120 so far; volume 60 -> 0.5x, thin
    s = build(tmp_path, px, vol=60).summary(NOW)
    v = s["nifty50"]["volume"]
    assert v["reference"] == "linear" and v["weighted_rv"] == pytest.approx(60 / (1000 * 45 / 375))
    assert s["nifty50"]["quality"]["state"] == "thin"
    row = next(r for r in s["nifty50"]["stocks"] if r["symbol"] == "AXISBANK")
    assert row["relative_volume"] == pytest.approx(0.5) and row["contribution"] == pytest.approx(0.25)


def test_without_weights_or_volume_baseline_those_parts_are_missing_not_guessed(tmp_path: Path) -> None:
    s = build(tmp_path, {s: 101.0 for s in SYMS}, weights=False, volumes=False).summary(NOW)
    assert s["nifty50"]["contribution"] is None and s["nifty50"]["volume"] is None and s["nifty50"]["weights"] is None
    assert s["nifty50"]["breadth"]["advancing"] == 8  # counts do not need weights
    assert s["sources"]["volume_baseline"]["stocks"] == 0


def test_sectors_and_rotation_state_are_reported(tmp_path: Path) -> None:
    px = {"ADANIENT": 102.0, "ADANIPORTS": 101.0, "APOLLOHOSP": 101.0, "ASIANPAINT": 99.0, "AXISBANK": 101.5, "BSE": 101.0, "BAJAJ-AUTO": 98.0, "BAJFINANCE": 100.5}
    s = build(tmp_path, px).summary(NOW)
    fin = next(r for r in s["sectors"]["nifty50"] if r["sector"] == "Financial Services")
    assert fin["covered"] == 3 and fin["equal_weight_return"] == pytest.approx((1.5 + 1 + 0.5) / 3)
    assert fin["contribution_pts"] == pytest.approx(0.25 * 1.5 + 0.05 * 1 + 0.1 * 0.5)  # 0.375 + 0.05 + 0.05
    ranks = [r["rank"] for r in s["sectors"]["nifty50"] if r["rank"]]
    assert ranks == sorted(ranks) and ranks[0] == 1


def test_minute_samples_are_stored_once_and_only_in_session(tmp_path: Path) -> None:
    svc = build(tmp_path, {s: 101.0 for s in SYMS})
    assert svc.sample(NOW) is True
    assert svc.sample(NOW) is True  # same minute: the sample table ignores the duplicate
    assert len(svc.store.recent_samples("nifty50")) == 1 and svc.store.recent_samples("stocks50")[0]["rows"][0][0]
    assert svc.sample(datetime(2026, 10, 29, 12, 30, tzinfo=UTC)) is False  # 18:00 IST: closed
    empty = MarketService(MarketStore(tmp_path / "x"), clock=lambda: NOW)
    assert empty.sample(NOW) is False  # no stocks streaming


def test_coverage_report_says_what_is_missing(tmp_path: Path) -> None:
    px = {s: 101.0 for s in SYMS}
    px["BSE"] = None
    rep = build(tmp_path, px).coverage_report()["nifty50"]
    assert rep["stocks"] == 8 and rep["token"] == 8 and rep["tick"] == 7 and rep["token_without_tick"] == ["BSE"]


def test_import_weights_validates_total_and_symbols(tmp_path: Path) -> None:
    svc = build(tmp_path, {}, weights=False)
    ok = "symbol,weight\n" + "\n".join(f"{s},{w}" for s, w in WEIGHTS.items())
    assert svc.import_weights(ok, date(2026, 9, 30), "NSE factsheet")["sum"] == pytest.approx(100.0)
    with pytest.raises(SourceError, match="sum to"):
        svc.import_weights("symbol,weight\nAXISBANK,50\n", date(2026, 10, 1), "x")
    with pytest.raises(SourceError, match="not in the NIFTY 50 list"):
        svc.import_weights("symbol,weight\nZZZ,100\n", date(2026, 10, 1), "x")
    with pytest.raises(SourceError, match="need columns"):
        svc.import_weights("a,b\n1,2\n", date(2026, 10, 1), "x")


def test_refresh_lists_rejects_a_bad_download_and_keeps_the_old_list(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.market import service as svc_mod
    from app.prediction.sources.nse import Fetched

    svc = build(tmp_path, {})
    monkeypatch.setitem(sources.INDEXES, "nifty50", (50, 50))
    monkeypatch.setattr(svc_mod, "fetch_text", lambda url: (Fetched(200, LIST_TEXT.encode()), LIST_TEXT))
    res = svc.refresh_lists()
    assert res["nifty50"].startswith("rejected") and len(svc.universe("nifty50")) == 8
    monkeypatch.setattr(svc_mod, "fetch_text", lambda url: (Fetched(403, None, "HTTP 403"), None))
    assert svc.refresh_lists()["nifty50"].startswith("not fetched") and svc.store.last_attempt("lists")["ok"] is False  # type: ignore[index]


def test_due_logic_for_the_scheduled_jobs(tmp_path: Path) -> None:
    empty = MarketService(MarketStore(tmp_path / "e"), clock=lambda: NOW)
    assert empty.due("lists", NOW) is True and empty.due("tokens", NOW) is False  # tokens need the lists first
    svc = build(tmp_path, {}, volumes=False)
    evening = datetime(2026, 10, 29, 14, 30, tzinfo=UTC)  # 20:00 IST
    assert svc.due("bhav", evening) is True and svc.due("bhav", NOW) is False  # not before 19:30 IST
    assert svc.due("bhav_backfill", NOW) is True  # fewer than 20 sessions stored


# ------------------------------------------------------------------- stream isolation and intraday link


def test_breadth_stocks_stay_off_the_browser_feed_and_the_freshness_clock() -> None:
    import asyncio

    from app.stream.hub import Hub
    from app.stream.manager import StreamConfig, StreamManager, Universe
    from app.stream.models import FeedEvent, FeedToken

    async def go() -> None:
        async def uni() -> Universe:
            return Universe(tokens=[], test_tokens=[])

        mgr = StreamManager(feed_factory=lambda: None, universe_provider=uni, config=StreamConfig(), hub=Hub(max_clients=2))  # type: ignore[arg-type]
        stock = FeedToken(exchange_segment="nse_cm", instrument_token="1333", kind="scrip")
        mgr.book.internal_keys = {stock.key}
        tick = LiveTick(key=stock.key, kind="scrip", exchange_segment="nse_cm", instrument_token="1333", ltp=10.0, prev_close=9.0, received_at=NOW)
        mgr._handle(FeedEvent(kind="tick", tick=tick), None)  # type: ignore[arg-type]
        assert mgr.message_count == 0 and mgr.last_market_data_at is None  # not option-feed activity
        assert mgr.market_message_count == 1 and mgr.book.drain_pending() == [] and mgr.book.snapshot() == []
        assert mgr.book.internal_ticks()[stock.key].ltp == 10.0

    asyncio.run(go())


def test_a_failing_stock_subscription_never_reaches_the_option_feed() -> None:
    import asyncio

    from app.stream.hub import Hub
    from app.stream.manager import StreamConfig, StreamManager, Universe
    from app.stream.models import FeedToken

    class Feed:
        def __init__(self) -> None:
            self.calls = 0

        async def subscribe(self, tokens: list[FeedToken]) -> None:
            self.calls += 1
            if self.calls == 2:
                raise RuntimeError("limit")

    async def go() -> None:
        async def uni() -> Universe:
            return Universe(tokens=[], test_tokens=[])

        mgr = StreamManager(feed_factory=lambda: None, universe_provider=uni, config=StreamConfig(), hub=Hub(max_clients=2))  # type: ignore[arg-type]
        toks = [FeedToken(exchange_segment="nse_cm", instrument_token=str(i), kind="scrip") for i in range(450)]
        await mgr._subscribe_market(Feed(), Universe(tokens=[], test_tokens=[], market_tokens=toks))  # type: ignore[arg-type]
        assert mgr.market_subscribed == 200 and "stopped after 200 of 450" in mgr.market_note and "RuntimeError" in mgr.market_note
        await mgr._subscribe_market(Feed(), Universe(tokens=[], test_tokens=[]))  # type: ignore[arg-type]
        assert mgr.market_note == "not requested"

    asyncio.run(go())


def test_breadth_and_sectors_feed_the_intraday_score_and_context(tmp_path: Path) -> None:
    from app.intraday.sentiment import breadth_component, sectors_component

    px = {"ADANIENT": 102.0, "ADANIPORTS": 101.0, "APOLLOHOSP": 101.0, "ASIANPAINT": 99.0, "AXISBANK": 101.5, "BSE": 101.0, "BAJAJ-AUTO": 98.0, "BAJFINANCE": 100.5}
    mk = build(tmp_path, px).summary(NOW)
    c = breadth_component(mk)
    # NIFTY 50 and NIFTY 500 both: 6 up, 2 down -> (6 - 2) / 8 = 0.5
    assert c.available and c.score == pytest.approx(0.5) and len(c.inputs) == 2
    assert not breadth_component(None).available and "turned off" in breadth_component(None).reason
    s = sectors_component(mk)
    assert not s.available and "only" in s.reason  # 6 industries here, but fewer than 3 stocks each in NIFTY 500 => no returns
    stale = build(tmp_path / "s", {k: v for k, v in px.items()}).summary(NOW + timedelta(minutes=30))
    sc = breadth_component(stale)
    assert not sc.available and sc.score is None and sc.reason == "too few stocks have a fresh price"  # ticks older than 5 minutes do not count


def test_api_reports_breadth_off_by_default_in_tests(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path)) as c:
        assert c.get("/api/market/summary").status_code == 404
        st = c.get("/api/market/status").json()
        assert st["enabled"] is False and st["stream"]["note"] == "not requested"
        bad = c.post("/api/market/weights/import", json={"csv": "symbol,weight\nZZZ,100\n", "as_of": "2026-10-01", "source": "x"})
        assert bad.status_code == 422 or bad.status_code == 403


def test_the_intraday_summary_uses_stock_breadth_for_score_context_and_health(tmp_path: Path) -> None:
    from app.intraday.service import IntradayService
    from app.intraday.store import IntradayStore
    from app.prediction.flows_store import FlowsStore
    from app.prediction.history_store import HistoryStore
    from tests.unit.test_intraday import EXP, ist, seed

    px = {"ADANIENT": 102.0, "ADANIPORTS": 101.0, "APOLLOHOSP": 101.0, "ASIANPAINT": 99.0, "AXISBANK": 101.5, "BSE": 101.0, "BAJAJ-AUTO": 98.0, "BAJFINANCE": 100.5}
    market = build(tmp_path / "m", px)
    now = ist(10, 0)
    svc = IntradayService(seed(tmp_path / "o", [ist(9, 15) + timedelta(minutes=i) for i in range(40)]), HistoryStore(tmp_path / "o"), FlowsStore(tmp_path / "o"),
                          IntradayStore(tmp_path / "o"), clock=lambda: now.astimezone(UTC), market=market)  # fmt: skip
    market._clock = lambda: now.astimezone(UTC)  # noqa: SLF001
    out = svc.summary(EXP)
    comps = {c["key"]: c for c in out["assessment"]["components"]}
    assert "stocks" in out and out["stocks"]["nifty50"]["breadth"]["covered"] == 8
    ctx = {c["question"]: c["answer"] for c in out["context"]}
    assert "Unknown" not in ctx["Broad or concentrated participation?"]
    assert "NIFTY 50: 6 up, 2 down" in ctx["Broad or concentrated participation?"] and "provisional rule" in ctx["Broad or concentrated participation?"]
    health = {h["source"]: h for h in out["health"]}
    assert health["Market breadth"]["status"] in ("fresh", "warning") and "Index weights" in health and "Volume baseline" in health
    # the market block is the same object the score was built from: no second, conflicting calculation
    assert comps["breadth"]["inputs"][0]["name"].startswith("NIFTY 50")
    # without a market service everything stays honestly unavailable
    svc.market = None
    svc._cache.clear()  # noqa: SLF001
    off = svc.summary(EXP)
    assert next(c for c in off["assessment"]["components"] if c["key"] == "breadth")["available"] is False
    assert off["stocks"] is None


# ------------------------------------------------------------------------------------ futures, heavyweights, flow


def depth_tick(key: str, sym: str, ltp: float, vol: int, bid: float, ask: float, kind_seg: str = "nse_cm", token: str | None = None) -> LiveTick:
    tok = token or TOKENS[sym]
    return LiveTick(key=key, kind="scrip", exchange_segment=kind_seg, instrument_token=tok, ltp=ltp, prev_close=100.0, volume=vol, bid=bid, ask=ask,
                    bid_qty=800, ask_qty=200, received_at=NOW)  # fmt: skip


def test_heavy_five_follow_the_weights_and_get_depth_tokens(tmp_path: Path) -> None:
    svc = build(tmp_path, {s: 101.0 for s in SYMS})
    svc.store.save_tokens({"FUT:NIFTY": TokenInfo("FUT:NIFTY", "55001", "NIFTY26NOVFUT")}, date(2026, 10, 29))
    heavy, basis = svc.heavy()
    assert heavy[:3] == ["AXISBANK", "ADANIENT", "ADANIPORTS"] and len(heavy) == 5 and basis == "official index weights"
    toks = svc.stream_tokens()
    depth = {t.key for t in toks if t.depth}
    assert depth == {f"nse_cm|{TOKENS[s]}" for s in heavy} | {"nse_fo|55001"}
    assert len([t for t in toks if t.exchange_segment == "nse_cm"]) == 8  # no duplicate subscription for the five


def test_without_weights_the_five_are_chosen_by_traded_value_and_labelled_as_a_proxy(tmp_path: Path) -> None:
    svc = build(tmp_path, {s: 101.0 for s in SYMS}, weights=False, volumes=False)
    svc.store.save_bhav([sources.BhavRow(date(2026, 10, 28), s, 100.0, 100.0 + i, 1000 * (i + 1), None) for i, s in enumerate(SYMS)])
    heavy, basis = svc.heavy()
    assert heavy == ["BAJFINANCE", "BAJAJ-AUTO", "BSE", "AXISBANK", "ASIANPAINT"] and "proxy" in basis  # close x volume: 856000, 742000, 630000, 520000, 412000


def test_depth_ticks_feed_the_flow_tracker_and_the_summary(tmp_path: Path) -> None:
    svc = build(tmp_path, {s: 101.0 for s in SYMS})
    k = f"nse_cm|{TOKENS['AXISBANK']}"
    svc.on_tick(depth_tick(k, "AXISBANK", 100.0, 1000, 99.95, 100.0))
    svc.on_tick(depth_tick(k, "AXISBANK", 100.0, 1300, 99.95, 100.0))  # traded at the ask: 300 buy
    svc.on_tick(depth_tick("nse_cm|999", "ADANIENT", 100.0, 5, 99.0, 101.0, token="999"))  # not a depth stock: ignored
    ax = next(r for r in svc.summary(NOW)["flow"]["heavy5"]["stocks"] if r["symbol"] == "AXISBANK")
    assert ax["flow"]["buy_volume"] == 300 and ax["flow"]["cvd"] == 300 and ax["flow"]["depth_imbalance"] == pytest.approx(0.6)  # (800-200)/1000
    assert ax["weight"] == 25.0 and ax["technical"]["bars"] == 12 and ax["technical"]["sma50"] is None  # 12 stored sessions: no 50-day average
    assert "999" not in {t.symbol for t in svc.trackers.values()} and set(svc.trackers) == {"AXISBANK"}


def test_futures_relative_volume_uses_the_profile_built_from_earlier_sessions(tmp_path: Path) -> None:
    svc = build(tmp_path, {s: 101.0 for s in SYMS})
    svc.store.save_tokens({"FUT:NIFTY": TokenInfo("FUT:NIFTY", "55001", "NIFTY26NOVFUT")}, date(2026, 10, 29))
    # five earlier sessions of recorded futures volume, front-loaded: share done = sqrt(t/375), 1000 lots by the close
    # (a formula-built stand-in series; real recordings accumulate from the first market-hours session)
    for day in (22, 23, 26, 27, 28):
        for t in range(0, 376):
            at = datetime(2026, 10, day, 9, 15, tzinfo=UTC) - timedelta(hours=5, minutes=30) + timedelta(minutes=t)
            svc.store.record_sample("fut", at.isoformat(), {"v": round(1000 * (t / 375) ** 0.5, 4)})
    k = "nse_fo|55001"
    svc.on_tick(depth_tick(k, "AXISBANK", 25000.0, 600, 24999.0, 25000.0, "nse_fo", "55001"))
    svc.on_tick(depth_tick(k, "AXISBANK", 25000.0, 700, 24999.0, 25000.0, "nse_fo", "55001"))
    f = svc.summary(NOW)["flow"]
    assert f["futures"]["cvd"] == 100 and f["futures_contract"] == "NIFTY26NOVFUT"
    # 10:00 IST = minute 45: expected share (45/375)^0.5 = 0.3464 of 1000 -> 700 / 346.4 = 2.02
    assert f["futures"]["relative_volume"] == pytest.approx(700 / (1000 * (45 / 375) ** 0.5), abs=0.01)
    assert f["futures"]["relative_volume_reference"] == "profile" and f["baseline"]["futures_profile_ready"] is True


def test_futures_have_no_relative_volume_until_five_sessions_exist(tmp_path: Path) -> None:
    svc = build(tmp_path, {s: 101.0 for s in SYMS})
    svc.store.save_tokens({"FUT:NIFTY": TokenInfo("FUT:NIFTY", "55001", "NIFTY26NOVFUT")}, date(2026, 10, 29))
    k = "nse_fo|55001"
    svc.on_tick(depth_tick(k, "AXISBANK", 25000.0, 600, 24999.0, 25000.0, "nse_fo", "55001"))
    svc.on_tick(depth_tick(k, "AXISBANK", 25000.0, 700, 24999.0, 25000.0, "nse_fo", "55001"))
    fut = svc.summary(NOW)["flow"]["futures"]
    assert fut["relative_volume"] is None and fut["cvd"] == 100  # flow works at once; the volume reference needs history


def test_weights_are_estimated_from_recorded_minutes_and_never_replace_official_ones(tmp_path: Path) -> None:
    """FORMULA CHECK: the recorded index change is built from known weights, then recovered."""
    import random

    random.seed(3)
    svc = build(tmp_path, {s: 101.0 for s in SYMS}, weights=False)
    assert svc.estimate_weights(NOW).startswith("not enough clean data")
    for i in range(200):
        chg = {s: random.gauss(0, 0.5) for s in SYMS}
        idx = sum(WEIGHTS[s] / 100 * chg[s] for s in SYMS)
        stamp = (NOW - timedelta(minutes=300 - i)).replace(second=0, microsecond=0).isoformat()
        svc.store.record_sample("nifty50", stamp, {"idx": idx})
        svc.store.record_sample("stocks50", stamp, {"rows": [[s, chg[s], 10] for s in SYMS]})
    assert "estimated weights" in svc.estimate_weights(NOW)
    w, _, src = svc.store.latest_weights("nifty50") or ({}, "", "")
    assert src.startswith("approx-regression") and all(abs(w[s] - WEIGHTS[s]) < 0.1 for s in SYMS)
    assert svc.summary(NOW)["nifty50"]["weights"]["approximate"] is True
    svc.store.save_weights("nifty50", WEIGHTS, date(2026, 9, 1), "NSE factsheet", NOW)  # an older official file still wins
    assert (svc.store.latest_weights("nifty50") or ({}, "", ""))[2] == "NSE factsheet"
    assert "official weights loaded" in svc.estimate_weights(NOW)


def test_a_changed_constituent_list_is_logged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from types import SimpleNamespace

    svc = build(tmp_path, {})
    changed = LIST_TEXT.replace("BAJAJ-AUTO", "NEWSTOCK")
    monkeypatch.setattr("app.market.service.fetch_text", lambda url: (SimpleNamespace(body=changed.encode(), status=200, error=None), changed))
    res = svc.refresh_lists()
    assert res["nifty50"] == "CHANGED: +1 -1"
    assert svc.store.list_changes()[0]["added"] == ["NEWSTOCK"] and svc.store.list_changes()[0]["removed"] == ["BAJAJ-AUTO"]
    assert svc.refresh_lists()["nifty50"] == "unchanged"


# ------------------------------------------------------------------------------------ official weights (NSE index tracker)

SEED_FILE = Path(__file__).resolve().parents[2] / "app" / "market" / "seed" / "nifty50_weights_2026-10-29.csv"


def _full_service(tmp_path: Path) -> MarketService:
    """A service whose NIFTY 50 list holds the 50 symbols of the captured NSE weights file (list rows are labels only)."""
    syms = [ln.split(",")[0] for ln in SEED_FILE.read_text().splitlines()[1:]]
    text = "Company Name,Industry,Symbol,Series,ISIN Code\n" + "".join(f"{s} Ltd.,Financial Services,{s},EQ,INE{i:09d}\n" for i, s in enumerate(syms))
    st = MarketStore(tmp_path)
    st.save_list("nifty50", parse_index_list(text, "nifty50"), text.encode(), NOW)
    return MarketService(st, clock=lambda: NOW)


def test_the_captured_nse_weights_are_complete_and_load_as_official(tmp_path: Path) -> None:
    """The file holds the 'weightage' values NSE's index-tracker page returned on 29 Oct 2026 15:30 IST (50 stocks)."""
    rows = [ln.split(",") for ln in SEED_FILE.read_text().splitlines()[1:]]
    assert len(rows) == 50 and sum(float(w) for _, w in rows) == pytest.approx(100.01, abs=0.001)
    svc = _full_service(tmp_path)
    assert svc.seed_weights() == "50 official weights as of 2026-10-29"
    w, as_of, src, rolled = svc.weights_now() or ({}, "", "", None)
    assert as_of == "2026-10-29" and src.startswith("NSE index tracker") and rolled is None
    assert w["HDFCBANK"] == 9.9 and w["ICICIBANK"] == 9.44 and w["RELIANCE"] == 7.6 and w["M&M"] == 2.43
    assert svc.heavy() == (["HDFCBANK", "ICICIBANK", "RELIANCE", "BHARTIARTL", "LT"], "official index weights")
    assert svc.seed_weights() == "official weights already stored"  # not loaded twice


def test_official_weights_move_with_price_until_the_next_official_file(tmp_path: Path) -> None:
    svc = _full_service(tmp_path)
    svc.seed_weights()
    syms = [s.symbol for s in svc.universe("nifty50")]
    svc.store.save_bhav([sources.BhavRow(date(2026, 10, 29), s, 100.0, 100.0, 1000, None, 100.0, 100.0, 100.0) for s in syms])
    # next session HDFCBANK +10 %, every other stock unchanged
    svc.store.save_bhav([sources.BhavRow(date(2026, 10, 30), s, 100.0, 110.0 if s == "HDFCBANK" else 100.0, 1000, None, 100.0, 100.0, 100.0) for s in syms])
    w, _, _, rolled = svc.weights_now() or ({}, "", "", None)
    # raw: 9.9 x 1.10 = 10.89 and the other 90.11 unchanged -> total 101.0; scaled back to the 100.01 total
    assert rolled == "2026-10-30" and w["HDFCBANK"] == pytest.approx(10.89 / 101.0 * 100.01) and sum(w.values()) == pytest.approx(100.01)
    assert w["RELIANCE"] == pytest.approx(7.6 / 101.0 * 100.01)
    # a price ratio that looks like a split disables the roll-forward instead of guessing
    svc.store.save_bhav([sources.BhavRow(date(2026, 10, 31), s, 100.0, 50.0 if s == "LT" else 100.0, 1000, None, 100.0, 100.0, 100.0) for s in syms])
    assert (svc.weights_now() or ({}, "", "", "x"))[3] is None
    src = svc.sources(NOW)["weights"]
    assert src["stale"] is False and src["age_days"] == 0 and src["approximate"] is False
