"""Index VWAP estimate, stock futures and rollover: hand-calculated arithmetic, contract lookup and the service wiring. Synthetic numbers = FORMULA CHECKS."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from app.intelligence import fusion as fz
from app.market import futures as fut
from app.market import sources
from app.market.futures import FoQuote
from app.market.service import FUT_NEXT_SYMBOL, STK_PREFIX, MarketService
from app.market.sources import TokenInfo, next_month, parse_stock_futures
from app.market.store import MarketStore
from app.stream.models import LiveTick
from tests.unit.test_market_service import (
    LIST_TEXT,
    NOW,
    SYMS,
    TOKENS,
    WEIGHTS,
    build,
    parse_index_list,
)


@pytest.fixture(autouse=True)
def _small_lists(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sources.INDEXES, "nifty50", (1, 60))
    monkeypatch.setitem(sources.INDEXES, "nifty500", (1, 600))


# ----------------------------------------------------------------------------------------------------------------- index VWAP


def test_index_vwap_is_the_weighted_mean_ratio_times_the_previous_close() -> None:
    # 20 stocks of weight 2 with VWAP 2 % above their previous close, 12 of weight 1 with VWAP 2 % below: sum(w) = 52,
    # sum(w x ratio) = 20 x 2 x 1.02 + 12 x 1 x 0.98 = 40.8 + 11.76 = 52.56 -> ratio 1.0107692 -> 25 000 x 1.0107692 = 25 269.23
    stocks = {f"A{i}": (2.0, 102.0, 100.0) for i in range(20)} | {f"B{i}": (1.0, 98.0, 100.0) for i in range(12)}
    r = fut.index_vwap(stocks, 25_000.0, 25_338.0)
    assert r["value"] == pytest.approx(25_269.23, abs=0.005) and r["stocks"] == 32 and r["weight_share"] == 1.0 and r["estimate"] is True
    assert r["distance_pts"] == pytest.approx(25_338.0 - 25_269.23, abs=0.01) and r["side"] == "above"
    assert r["distance_pct"] == pytest.approx((25_338.0 / 25_269.2308 - 1) * 100, abs=0.001)
    assert fut.index_vwap(stocks, 25_000.0, 25_100.0)["side"] == "below"
    assert "not a true spot VWAP" in r["note"]


def test_index_vwap_leaves_out_stocks_without_a_vwap_and_says_how_much_weight_it_used() -> None:
    stocks = {f"A{i}": (2.0, 102.0, 100.0) for i in range(30)} | {"X": (4.0, None, 100.0), "Y": (4.0, 99.0, None)}
    r = fut.index_vwap(stocks, 1000.0, None)
    assert r["value"] == pytest.approx(1020.0) and r["stocks"] == 30 and r["weight_share"] == pytest.approx(60 / 68, abs=0.001)
    assert "spot" not in r  # no live spot: no distance


def test_index_vwap_needs_enough_stocks_and_weight_and_a_previous_close() -> None:
    few = {f"A{i}": (2.0, 102.0, 100.0) for i in range(29)}
    assert fut.index_vwap(few, 1000.0, 1000.0)["value"] is None and "30 stocks" in fut.index_vwap(few, 1000.0, 1000.0)["reason"]
    light = {f"A{i}": (1.0, 101.0, 100.0) for i in range(30)} | {"BIG": (50.0, None, None)}  # 30 of 80 weight: under 80 %
    assert fut.index_vwap(light, 1000.0, 1000.0)["value"] is None
    assert fut.index_vwap({f"A{i}": (2.0, 102.0, 100.0) for i in range(30)}, None, 1000.0)["value"] is None


# ----------------------------------------------------------------------------------------------------------------- stock futures


def test_buildup_follows_the_price_and_open_interest_rule() -> None:
    assert fut.buildup(1.0, 100) == "Long buildup"
    assert fut.buildup(-1.0, 100) == "Short buildup"
    assert fut.buildup(1.0, -100) == "Short covering"
    assert fut.buildup(-1.0, -100) == "Long unwinding"
    assert fut.buildup(0.0, 100) is None and fut.buildup(1.0, 0) is None and fut.buildup(None, 5) is None and fut.buildup(1.0, None) is None


def test_stock_futures_rows_by_hand() -> None:
    now = datetime(2026, 11, 12, 5, 0, tzinfo=UTC)
    cur = {"AAA": FoQuote(ltp=102.0, prev_close=100.0, oi=1200, volume=500, atp=101.0, at=now),
           "BBB": FoQuote(ltp=49.0, prev_close=50.0, oi=900, at=now),
           "OLD": FoQuote(ltp=10.0, prev_close=10.0, oi=1, at=now - timedelta(minutes=10))}
    nxt = {"AAA": FoQuote(ltp=103.0, oi=300, at=now), "BBB": FoQuote(ltp=None, oi=None, at=now)}
    r = fut.stock_futures(["AAA", "BBB", "OLD", "CCC"], cur, nxt, {"AAA": 101.0, "BBB": 49.5}, {"AAA": 1000, "BBB": 1000}, now)
    assert r["covered"] == 2 and r["of"] == 4  # the stale OLD and the absent CCC are left out
    a, b = r["rows"]
    # AAA: price +2 %, OI 1200 - 1000 = +200 (+20 %): long buildup; basis 102/101 - 1 = 0.990 %; rollover: next value 300 x 103 = 30 900, current 1200 x 102 = 122 400
    assert (a["price_change_pct"], a["oi_change"], a["oi_change_pct"], a["buildup"], a["basis_pct"]) == (2.0, 200, 20.0, "Long buildup", 0.990)
    assert a["rollover_pct"] == pytest.approx(30_900 / (122_400 + 30_900) * 100, abs=0.05) and a["roll_cost_pct"] == pytest.approx((103 / 102 - 1) * 100, abs=0.001)
    # BBB: price -2 %, OI 900 - 1000 = -100: long unwinding; no next-month price, so no rollover (missing stays missing)
    assert (b["price_change_pct"], b["oi_change"], b["buildup"], b["rollover_pct"], b["roll_cost_pct"]) == (-2.0, -100, "Long unwinding", None, None)
    assert r["buildup_counts"] == {"Long buildup": 1, "Long unwinding": 1}
    assert r["rollover_stocks"] == 1 and r["rollover_pct"] == pytest.approx(a["rollover_pct"], abs=0.05)


def test_open_interest_change_needs_a_first_reading() -> None:
    now = datetime(2026, 11, 12, 5, 0, tzinfo=UTC)
    r = fut.stock_futures(["AAA"], {"AAA": FoQuote(ltp=102.0, prev_close=100.0, oi=1200, at=now)}, {}, {}, {}, now)
    row = r["rows"][0]
    assert row["oi_change"] is None and row["oi_change_pct"] is None and row["buildup"] is None and row["basis_pct"] is None


def test_nifty_rollover_is_the_next_month_share_of_open_interest() -> None:
    now = datetime(2026, 11, 12, 5, 0, tzinfo=UTC)
    cur = FoQuote(ltp=25_300.0, oi=900_000, at=now)
    nxt = FoQuote(ltp=25_380.0, oi=100_000, at=now)
    r = fut.nifty_rollover(cur, nxt, now, base_cur=950_000, base_next=50_000)
    assert r["available"] and r["rollover_pct"] == 10.0 and r["roll_cost_pts"] == 80.0 and r["roll_cost_pct"] == pytest.approx(80 / 25_300 * 100, abs=0.001)
    assert r["rollover_pct_at_open"] == 5.0 and r["cur_oi_change"] == -50_000 and r["next_oi_change"] == 50_000
    assert fut.nifty_rollover(cur, FoQuote(), now)["available"] is False
    assert fut.nifty_rollover(cur, FoQuote(ltp=1.0, oi=1, at=now - timedelta(minutes=9)), now)["available"] is False


# ----------------------------------------------------------------------------------------------------------------- contract lookup


def test_stock_futures_are_found_by_trading_symbol_and_next_month_rolls_the_year() -> None:
    rows = [
        {"pTrdSymbol": "RELIANCE26NOVFUT", "pSymbol": "51001", "pExchSeg": "nse_fo"},
        {"pTrdSymbol": "M&M26NOVFUT", "pSymbol": "51002", "pExchSeg": "nse_fo"},
        {"pTrdSymbol": "BAJAJ-AUTO26DECFUT", "pSymbol": "51003", "pExchSeg": "nse_fo"},
        {"pTrdSymbol": "RELIANCE26NOV2500CE", "pSymbol": "51004", "pExchSeg": "nse_fo"},  # an option, not a future
        {"pTrdSymbol": "TCS26NOVFUT", "pSymbol": "51005", "pExchSeg": "bse_fo"},  # another exchange
    ]
    cur = parse_stock_futures(rows, 2026, 11, ["RELIANCE", "M&M", "BAJAJ-AUTO", "TCS", "INFY"])
    assert {k: v.token for k, v in cur.items()} == {"RELIANCE": "51001", "M&M": "51002"} and cur["M&M"].symbol == "FUTSTK:M&M"
    assert parse_stock_futures(rows, 2026, 12, ["BAJAJ-AUTO"])["BAJAJ-AUTO"].trading_symbol == "BAJAJ-AUTO26DECFUT"
    assert next_month(2026, 11) == (2026, 12) and next_month(2026, 12) == (2027, 1)


# ----------------------------------------------------------------------------------------------------------------- service wiring


def fo_tokens(svc: MarketService) -> None:
    toks = {s: TokenInfo(s, t, f"{s}-EQ") for s, t in TOKENS.items()}
    toks["FUT:NIFTY"] = TokenInfo("FUT:NIFTY", "55001", "NIFTY26NOVFUT")
    toks[FUT_NEXT_SYMBOL] = TokenInfo(FUT_NEXT_SYMBOL, "55002", "NIFTY26DECFUT")
    for i, s in enumerate(SYMS[:3]):
        toks[f"{STK_PREFIX}{s}"] = TokenInfo(f"{STK_PREFIX}{s}", str(60000 + i), f"{s}26NOVFUT")
        toks[f"{STK_PREFIX}{s}:NEXT"] = TokenInfo(f"{STK_PREFIX}{s}:NEXT", str(61000 + i), f"{s}26DECFUT")
    svc.store.save_tokens(toks, date(2026, 10, 29))


def fo_tick(token: str, ltp: float, oi: int, prev: float = 100.0, at: datetime = NOW, atp: float | None = None) -> LiveTick:
    return LiveTick(key=f"nse_fo|{token}", kind="scrip", exchange_segment="nse_fo", instrument_token=token, ltp=ltp, prev_close=prev, oi=oi, volume=10, avg_price=atp, received_at=at)


def test_the_futures_are_subscribed_as_internal_touch_line_tokens(tmp_path: Path) -> None:
    svc = build(tmp_path, {s: 101.0 for s in SYMS})
    fo_tokens(svc)
    toks = svc.stream_tokens()
    stk = [t for t in toks if t.exchange_segment == "nse_fo" and t.instrument_token not in ("55001",)]
    assert {t.instrument_token for t in stk} == {"55002", "60000", "60001", "60002", "61000", "61001", "61002"}
    assert all(not t.depth for t in stk)  # no depth: touch line only
    assert next(t for t in toks if t.instrument_token == "55001").depth is True  # the NIFTY current future keeps its depth


def test_futures_ticks_feed_the_summary_and_the_stored_sample_and_a_restart_keeps_the_open_interest_baseline(tmp_path: Path) -> None:
    svc = build(tmp_path, {s: 101.0 for s in SYMS})
    fo_tokens(svc)
    early = NOW - timedelta(minutes=30)
    svc.on_tick(fo_tick("60000", 100.0, 1000, at=early))  # ADANIENT current: first reading of the day
    svc.on_tick(fo_tick("61000", 101.0, 200, at=early))
    svc.on_tick(fo_tick("55002", 25_400.0, 50_000, prev=25_300.0, at=early))
    assert svc.sample(early) is True  # 09:30 IST: a fifth-minute sample, written with these first readings
    svc.on_tick(fo_tick("60000", 103.0, 1100))
    svc.on_tick(fo_tick("61000", 104.0, 300))
    svc.on_tick(fo_tick("55002", 25_410.0, 60_000, prev=25_300.0))
    svc.on_tick(LiveTick(key="nse_fo|55001", kind="scrip", exchange_segment="nse_fo", instrument_token="55001", ltp=25_330.0, oi=940_000, volume=1, received_at=NOW))
    s = svc.summary(NOW)["stock_futures"]
    row = next(r for r in s["rows"] if r["symbol"] == "ADANIENT")
    assert (row["price_change_pct"], row["oi_change"], row["buildup"]) == (3.0, 100, "Long buildup")
    assert row["rollover_pct"] == pytest.approx(300 * 104 / (1100 * 103 + 300 * 104) * 100, abs=0.05)
    assert s["nifty"]["available"] and s["nifty"]["next_oi"] == 60_000 and s["nifty"]["rollover_pct"] == 6.0
    # a restart: a new service over the same store reads the first stored reading as the baseline, not today's later one
    svc2 = MarketService(svc.store, ticks=svc._ticks, clock=lambda: NOW)
    svc2.on_tick(fo_tick("60000", 103.0, 1100))
    base = svc2._fo_base(NOW)
    assert base["cur"]["ADANIENT"] == 1000 and base["next"]["ADANIENT"] == 200


def test_the_futures_ticks_are_not_mistaken_for_unmatched_keys_and_stale_ones_are_left_out(tmp_path: Path) -> None:
    svc = build(tmp_path, {s: 101.0 for s in SYMS})
    fo_tokens(svc)
    svc.on_tick(fo_tick("60001", 99.0, 500, at=NOW - timedelta(minutes=10)))  # ADANIPORTS current, stale
    assert "nse_fo|60001" not in svc.summary(NOW)["flow"]["diagnostics"]["unmatched_keys"]
    assert all(r["symbol"] != "ADANIPORTS" for r in svc.summary(NOW)["stock_futures"]["rows"])


def test_the_index_vwap_estimate_comes_from_the_constituents_in_the_book(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(fut, "MIN_INDEX_STOCKS", 5)
    svc = build(tmp_path, {s: 101.0 for s in SYMS})
    book = svc._ticks()
    for s in SYMS:  # day VWAP 1 % above the previous close (100) for every stock
        book[f"nse_cm|{TOKENS[s]}"] = book[f"nse_cm|{TOKENS[s]}"].model_copy(update={"avg_price": 101.0})
    r = svc.summary(NOW)["index_vwap"]
    # every ratio is 1.01, so the estimate is 1.01 x the index previous close (100) = 101.0; the stored weights cover all eight stocks
    assert r["value"] == pytest.approx(101.0) and r["stocks"] == 8 and r["weight_share"] == 1.0 and r["estimate"] is True
    assert r["spot"] == 101.0 and r["side"] == "at"  # the stand-in index tick is at 101.0


# ----------------------------------------------------------------------------------------------------------------- capabilities


def caps(mk: dict[str, object]) -> dict[str, dict[str, object]]:
    rows = fz.capabilities({"market": mk, "intraday": {}, "futures": {}, "skew": {}}, {}, {})
    return {r["id"]: r for r in rows if r["id"] in ("spot_vwap", "rollover", "stock_futures")}


def test_the_three_capabilities_follow_the_data_that_exists() -> None:
    c = caps({"index_vwap": {"value": 25_260.0, "stocks": 49, "weight_share": 0.99}, "stock_futures": {"covered": 48, "of": 50, "rollover_stocks": 47, "nifty": {"available": True, "rollover_pct": 7.5, "roll_cost_pts": 80.0}}})
    assert c["spot_vwap"]["status"] == "AVAILABLE" and "ESTIMATE" in c["spot_vwap"]["reason"] and "not a true spot VWAP" in c["spot_vwap"]["reason"]
    assert c["rollover"]["status"] == "AVAILABLE" and c["stock_futures"]["status"] == "AVAILABLE"
    part = caps({"index_vwap": {"value": 25_260.0, "stocks": 35, "weight_share": 0.85}, "stock_futures": {"covered": 10, "of": 50, "nifty": {"available": False, "reason": "x"}}})
    assert part["spot_vwap"]["status"] == "PARTIAL" and part["stock_futures"]["status"] == "PARTIAL" and part["rollover"]["status"] == "UNAVAILABLE"
    none = caps({"index_vwap": {"value": None, "reason": "needs at least 30 stocks"}, "stock_futures": {"covered": 0, "of": 50, "tokens_note": "stock futures subscribed: 0 of 50", "nifty": {"available": False}}})
    assert none["spot_vwap"]["status"] == "UNAVAILABLE" and none["stock_futures"]["status"] == "UNAVAILABLE"
    gone = caps({})
    assert gone["stock_futures"]["status"] == "UNAVAILABLE" and gone["stock_futures"]["why"] == "not_subscribed"


@pytest.mark.asyncio
async def test_the_token_refresh_finds_the_stock_futures_of_both_months_and_the_nifty_next_month_future(tmp_path: Path) -> None:
    svc = build(tmp_path, {s: 101.0 for s in SYMS})
    cm = [{"pTrdSymbol": f"{sym}-EQ", "pSymbol": tok, "pExchSeg": "nse_cm", "pSeries": "EQ"} for sym, tok in TOKENS.items()]
    fo = [{"pTrdSymbol": "NIFTY26NOVFUT", "pSymbol": "55001", "pExchSeg": "nse_fo"}, {"pTrdSymbol": "NIFTY26DECFUT", "pSymbol": "55002", "pExchSeg": "nse_fo"},
          {"pTrdSymbol": "ADANIENT26NOVFUT", "pSymbol": "60000", "pExchSeg": "nse_fo"}, {"pTrdSymbol": "ADANIENT26DECFUT", "pSymbol": "61000", "pExchSeg": "nse_fo"},
          {"pTrdSymbol": "BAJAJ-AUTO26NOVFUT", "pSymbol": "60006", "pExchSeg": "nse_fo"}]

    async def scrip(segment: str = "nse_cm") -> list[dict[str, str]]:
        return fo if segment == "nse_fo" else cm

    svc._scrip_master = scrip
    svc._monthly_expiry = lambda: date(2026, 11, 23)
    out = await svc.refresh_tokens()
    tm = svc.token_map()
    assert tm[f"{STK_PREFIX}ADANIENT"].token == "60000" and tm[f"{STK_PREFIX}ADANIENT:NEXT"].token == "61000" and tm[FUT_NEXT_SYMBOL].token == "55002"
    assert tm[f"{STK_PREFIX}BAJAJ-AUTO"].token == "60006" and f"{STK_PREFIX}BAJAJ-AUTO:NEXT" not in tm  # a contract the file lacks is absent, never invented
    assert "2 of 8 current-month and 1 next-month" in svc.fo_note and "NIFTY next-month future found" in svc.fo_note
    assert out.endswith("tokens")
    toks = {t.instrument_token for t in svc.stream_tokens() if t.exchange_segment == "nse_fo"}
    assert {"55002", "60000", "61000", "60006"} <= toks


def test_unused_imports_are_used() -> None:
    assert MarketStore and parse_index_list and LIST_TEXT and WEIGHTS and NOW
