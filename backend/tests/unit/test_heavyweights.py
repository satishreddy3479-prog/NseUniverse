"""Heavyweight CVD intelligence: windows, normalisation, weighted aggregate, validity rules, participation, divergences. Hand-calculated numbers."""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.intelligence import heavyweights as hw

NOW = datetime(2026, 11, 9, 5, 30, tzinfo=UTC)  # 11:00 IST
SYMS = ["HDFCBANK", "RELIANCE", "ICICIBANK", "INFY", "TCS"]
WEIGHTS = [10.0, 8.0, 6.0, 4.0, 2.0]
T20 = round(100 * math.tanh(20 / 25), 1)  # 66.4: a 20 % CVD share of classified volume


def stock_rows(n: int, specs: dict[str, dict[str, Any]], scale: float = 1.0, restart_at: int | None = None, skip: range | None = None) -> list[tuple[str, dict[str, Any]]]:
    """n one-minute samples ending at NOW. Per stock: ``b``/``s`` per-minute buy and sell volume; an optional ``late`` = (from minute index, b, s) for a later rate."""
    out: list[tuple[str, dict[str, Any]]] = []
    state = {s: [0.0, 0.0, 0.0] for s in specs}
    for i in range(n):
        if restart_at is not None and i == restart_at:
            state = {s: [0.0, 0.0, 0.0] for s in specs}
        rows = []
        for sym, sp in specs.items():
            b_, s_ = sp["b"], sp["s"]
            if "late" in sp and i >= sp["late"][0]:
                b_, s_ = sp["late"][1], sp["late"][2]
            st = state[sym]
            st[0] += b_ * scale
            st[1] += s_ * scale
            st[2] += (b_ + s_) * scale
            rows.append([sym, st[0] - st[1], st[0], st[1], st[2], 0.0, sp.get("ltp", 100.0) + sp.get("drift", 0.0) * i, sp.get("atp", 100.0), sp.get("w"), 0.1, None, False])
        if skip is not None and i in skip:
            continue
        out.append(((NOW - timedelta(minutes=n - 1 - i)).isoformat(), {"rows": rows}))
    return out


def live(specs: dict[str, dict[str, Any]], stale: set[str] | None = None, missing: set[str] | None = None, change: float = 0.3, day: float = 0.0) -> dict[str, Any]:
    stocks = []
    for sym, sp in specs.items():
        if missing and sym in missing:
            stocks.append({"symbol": sym, "weight": sp["w"], "change_pct": change, "flow": None})
            continue
        cls = sp["b"] + sp["s"]
        pct = (sp["b"] - sp["s"]) / cls * 100
        stocks.append({"symbol": sym, "weight": sp["w"], "change_pct": change, "volume": 1000,
                       "flow": {"cvd": 1.0, "cvd_pct": pct, "classified_share": 0.95, "stale": bool(stale and sym in stale), "age_seconds": 400.0 if stale and sym in stale else 3.0, "updated": NOW.isoformat(),
                                "vwap": sp.get("atp", 100.0), "last_price": sp.get("ltp", 100.0) + 0.5, "buy_volume": sp["b"], "sell_volume": sp["s"]}})
    return {"generated_at": NOW.isoformat(), "index_change_pct": day, "flow": {"heavy5": {"basis": "official index weights", "stocks": stocks}}}


def build(buy_sell: list[tuple[float, float]], n: int = 40, **kw: Any) -> dict[str, Any]:
    specs = {sym: {"b": b, "s": s, "w": w} for sym, w, (b, s) in zip(SYMS, WEIGHTS, buy_sell, strict=True)}
    return {"market": live(specs, **{k: v for k, v in kw.items() if k in ("stale", "missing", "change", "day")}), "flow": {"heavy5": stock_rows(n, specs, kw.get("scale", 1.0)), "fut": kw.get("fut", [])},
            "heavymeta": kw.get("meta"), "intraday": {"vwap": {"side": "above"}}}


UP, DOWN = (600.0, 400.0), (400.0, 600.0)  # per minute: CVD +20 % / -20 % of classified volume


def test_every_window_is_a_difference_of_stored_cumulative_flow() -> None:
    h = hw.assess(build([UP] * 5))
    s = next(r for r in h["stocks"] if r["symbol"] == "HDFCBANK")
    for m in ("5", "15", "30"):
        w = s["windows"][m]
        assert w["status"] == "ok" and w["pct"] == 20.0 and w["norm"] == T20 and w["cvd"] == 200.0 * int(m)
    assert s["session"]["norm"] == T20 and s["methodology"] == "CVD PROXY" and h["method"].startswith("CVD PROXY")


def test_normalised_aggregate_is_the_index_weighted_mean_and_not_a_sum_of_raw_cvd() -> None:
    inp = build([UP, UP, UP, DOWN, DOWN])
    h = hw.assess(inp)
    # (10 + 8 + 6) x 66.4 - (4 + 2) x 66.4 = 18 x 66.4 over weight 30 = 39.84 -> 39.8
    assert h["aggregate"]["15"]["score"] == pytest.approx(18 / 30 * T20, abs=0.06) and h["aggregate"]["session"]["score"] == pytest.approx(39.8, abs=0.06)
    assert h["aggregate"]["15"]["valid"] == 5 and h["aggregate"]["15"]["status"] == "ok"
    big = hw.assess(build([UP, UP, UP, DOWN, DOWN], scale=1000.0))  # a thousand times the raw volume: the same score
    assert big["aggregate"]["15"]["score"] == h["aggregate"]["15"]["score"]
    skewed = build([UP, UP, UP, DOWN, DOWN])
    for _, pl in skewed["flow"]["heavy5"]:
        pl["rows"][4][1] *= 1e6  # one stock's raw CVD explodes: normalised by its own classified volume it still saturates, and the weight (2 of 30) limits it
    assert abs(hw.assess(skewed)["aggregate"]["session"]["score"] - h["aggregate"]["session"]["score"]) < 40.0


def test_contribution_percentages_split_the_pressure_by_weight_times_reading() -> None:
    h = hw.assess(build([UP, UP, UP, DOWN, DOWN]))
    c = {r["symbol"]: r["contribution_pct"] for r in h["stocks"]}
    assert c["HDFCBANK"] == pytest.approx(10 / 30 * T20 / (30 / 30 * T20) * 100, abs=0.2)  # 10 of the 30 weight, every stock at the same size of reading: 33.3 %
    assert c["HDFCBANK"] > 0 > c["INFY"] and sum(abs(v) for v in c.values()) == pytest.approx(100.0, abs=0.5)


def test_momentum_and_acceleration_follow_the_5_and_15_minute_windows() -> None:
    specs = {sym: {"b": 600.0, "s": 400.0, "w": w, "late": (35, 800.0, 200.0)} for sym, w in zip(SYMS, WEIGHTS, strict=True)}  # from minute 35 buying jumps to 60 %
    inp = {"market": live(specs), "flow": {"heavy5": stock_rows(40, specs), "fut": []}}
    h = hw.assess(inp)
    n5 = 100 * math.tanh(60 / 25)  # last 5 minutes: 800 - 200 of 1000 = 60 %
    p15 = (10 * 200 + 5 * 600) / 15000 * 100  # 10 minutes at +200 and 5 at +600 per 1000 classified
    n15 = 100 * math.tanh(p15 / 25)
    assert h["aggregate"]["momentum"] == pytest.approx(n5 - n15, abs=0.3)
    s = h["stocks"][0]
    assert s["momentum"] == pytest.approx(n5 - n15, abs=0.3)
    n5_before = 100 * math.tanh(20 / 25)  # five minutes earlier the 5-minute window was still all at 20 %
    assert s["acceleration"] == pytest.approx(n5 - n5_before, abs=0.3) and h["aggregate"]["acceleration"] == pytest.approx(n5 - n5_before, abs=0.3)


def test_a_window_that_cannot_be_formed_says_why_and_is_never_reconstructed() -> None:
    short = hw.assess(build([UP] * 5, n=10))
    w = short["stocks"][0]["windows"]
    assert w["5"]["status"] == "ok" and w["15"]["status"].startswith("unavailable: fewer than 15 minutes") and w["15"]["norm"] is None
    assert short["aggregate"]["15"]["score"] is None and short["aggregate"]["5"]["score"] is not None
    restarted = hw.assess(build([UP] * 5, n=40) | {"flow": {"heavy5": stock_rows(40, {s: {"b": 600.0, "s": 400.0, "w": w_} for s, w_ in zip(SYMS, WEIGHTS, strict=True)}, restart_at=30), "fut": []}})
    assert restarted["stocks"][0]["windows"]["15"]["status"].startswith("unavailable: fewer than 15 minutes of continuous")  # counters began again at minute 30
    assert restarted["stocks"][0]["windows"]["5"]["status"] == "ok"
    gap = hw.assess(build([UP] * 5) | {"flow": {"heavy5": stock_rows(40, {s: {"b": 600.0, "s": 400.0, "w": w_} for s, w_ in zip(SYMS, WEIGHTS, strict=True)}, skip=range(14, 28)), "fut": []}})
    assert gap["stocks"][0]["windows"]["15"]["status"].startswith("unavailable: no stored sample within")
    old = hw.assess({**build([UP] * 5), "market": {**build([UP] * 5)["market"], "generated_at": (NOW + timedelta(minutes=10)).isoformat()}})
    assert old["stocks"][0]["windows"]["5"]["status"] == "unavailable: the newest stored sample is older than 3 minutes"
    thin = build([(30.0, 20.0)] * 5)  # classified 50 of volume 50 is fine; make volume far larger than classified
    for _, pl in thin["flow"]["heavy5"]:
        for r in pl["rows"]:
            r[4] = r[4] * 5
    assert hw.assess(thin)["stocks"][0]["windows"]["5"]["status"].startswith("unavailable: classified volume is under half")


def test_missing_and_stale_feeds_exclude_the_stock_and_the_aggregate_is_never_presented_as_five_stocks() -> None:
    four = hw.assess(build([UP] * 5, missing={"TCS"}))
    a = four["aggregate"]["session"]
    assert a["valid"] == 4 and a["of"] == 5 and a["status"] == "PARTIAL: 4 of 5 stocks" and a["weight_share"] == pytest.approx(28 / 30, abs=1e-3)
    tcs = next(r for r in four["stocks"] if r["symbol"] == "TCS")
    assert tcs["valid"] is False and tcs["freshness"]["feed"] == "no data" and tcs["session"]["norm"] is None and tcs["bias"] == "No reading" or tcs["freshness"]["feed"] == "no data"
    stale = hw.assess(build([UP] * 5, stale={"INFY"}))
    assert next(r for r in stale["stocks"] if r["symbol"] == "INFY")["freshness"]["feed"] == "STALE" and stale["aggregate"]["session"]["valid"] == 4
    assert stale["aggregate"]["15"]["valid"] == 4  # a stale stock is excluded from the rolling windows too: weights are re-normalised over the valid ones
    two = hw.assess(build([UP] * 5, missing={"RELIANCE", "ICICIBANK", "INFY"}))
    assert two["aggregate"]["session"]["score"] is None and "unavailable: 2 of 5 stocks valid" in two["aggregate"]["session"]["status"]
    small = hw.aggregate([(2.0, 50.0), (2.0, 50.0), (2.0, 50.0), (24.0, None)], 30.0)  # three stocks but only 20 % of the weight
    assert small["score"] is None and small["weight_share"] == 0.2
    assert two["quality"]["aggregate_available"] is False and two["participation"]["class"] == "Unavailable"


def test_participation_is_classified_from_the_counts_and_the_weight() -> None:
    assert hw.assess(build([UP] * 5))["participation"]["class"] == "Broad heavyweight buying"
    assert hw.assess(build([DOWN] * 5))["participation"]["class"] == "Broad heavyweight selling"
    narrow = hw.assess(build([UP, DOWN, DOWN, (500.0, 500.0), (500.0, 500.0)]))  # one big stock buying against two selling: a 1 / 2 split
    p = narrow["participation"]
    assert p["positive"] == 1 and p["negative"] == 2 and p["neutral"] == 2 and p["class"] == "Mixed heavyweight participation"  # aggregate 10 x 66.4 - 14 x 66.4 over 30 = -8.9: inside +-15
    nb = hw.assess(build([UP, (500.0, 500.0), (500.0, 500.0), (500.0, 500.0), (500.0, 500.0)]))
    assert nb["participation"]["class"] == "Narrow heavyweight buying"  # aggregate 10/30 x 66.4 = 22 is buying, but only one stock is
    narrow_buy = hw.assess(build([(700.0, 300.0), UP, (500.0, 500.0), (500.0, 500.0), (500.0, 500.0)]))
    assert narrow_buy["participation"]["class"] == "Narrow heavyweight buying" and narrow_buy["participation"]["positive"] == 2
    one = hw.assess(build([UP, UP, DOWN, DOWN, DOWN]))
    assert one["participation"]["positive"] == 2 and one["participation"]["negative"] == 3 and one["participation"]["weight_share_positive"] == pytest.approx(18 / 30)


def test_nifty_against_heavyweights_signals_and_their_evidence() -> None:
    def fut(change: float) -> list[tuple[str, dict[str, Any]]]:
        return [((NOW - timedelta(minutes=39 - i)).isoformat(), {"spot": 24000.0 * (1 + change / 100 * max(0.0, (i - 24) / 15))}) for i in range(40)]

    sell = hw.assess(build([DOWN] * 5, fut=fut(0.3)))
    assert sell["nifty"]["change_15m_pct"] == pytest.approx(0.3, abs=0.01)
    ids = {s["id"] for s in sell["signals"]}
    assert "hw_up_cvd_down" in ids and sell["participation"]["class"] == "Heavyweight divergence"
    d = next(s for s in sell["signals"] if s["id"] == "hw_up_cvd_down")
    assert d["kind"] == "divergence" and d["direction"] == "bearish" and d["invalidation"] and d["explanation"] and len(d["evidence"]) == 3 and d["at"] is not None
    up_buy = hw.assess(build([UP] * 5, fut=fut(-0.3)))
    assert "hw_down_cvd_up" in {s["id"] for s in up_buy["signals"]}
    broad = hw.assess(build([UP] * 5, fut=fut(0.3)))
    assert {s["id"] for s in broad["signals"]} == {"hw_up_broad"} and broad["signals"][0]["kind"] == "confirmation"
    sellers = hw.assess(build([DOWN] * 5, fut=fut(-0.3)))
    assert {s["id"] for s in sellers["signals"]} == {"hw_down_broad"}
    weak_day = hw.assess(build([UP] * 5, day=-0.4))
    assert weak_day["signals"] == []  # recovering needs momentum, and this flow is steady
    specs = {sym: {"b": 500.0, "s": 500.0, "w": w, "late": (35, 900.0, 100.0)} for sym, w in zip(SYMS, WEIGHTS, strict=True)}
    rec = hw.assess({"market": live(specs, day=-0.4), "flow": {"heavy5": stock_rows(40, specs), "fut": []}})
    assert "hw_recovering" in {s["id"] for s in rec["signals"]}
    specs2 = {sym: {"b": 500.0, "s": 500.0, "w": w, "late": (35, 100.0, 900.0)} for sym, w in zip(SYMS, WEIGHTS, strict=True)}
    det = hw.assess({"market": live(specs2, day=0.4), "flow": {"heavy5": stock_rows(40, specs2), "fut": []}})
    assert "hw_deteriorating" in {s["id"] for s in det["signals"]}


def test_stock_bias_combines_cvd_with_vwap_and_flags_a_price_versus_cvd_divergence() -> None:
    specs = {sym: {"b": 600.0, "s": 400.0, "w": w, "ltp": 100.0, "atp": 99.0} for sym, w in zip(SYMS, WEIGHTS, strict=True)}
    h = hw.assess({"market": live(specs), "flow": {"heavy5": stock_rows(40, specs), "fut": []}})
    s = h["stocks"][0]
    assert s["bias"] == "Buying · above VWAP (confirmed)" and s["price_vs_vwap_pct"] == pytest.approx((100.5 / 99 - 1) * 100, abs=0.01)
    below = {sym: {**sp, "atp": 101.0} for sym, sp in specs.items()}
    assert hw.assess({"market": live(below), "flow": {"heavy5": stock_rows(40, below), "fut": []}})["stocks"][0]["bias"] == "Buying · below VWAP (unconfirmed)"
    falling = {sym: {**sp, "drift": -0.05} for sym, sp in specs.items()}  # price falls 0.05 a minute (0.75 over 15 minutes, about -0.75 %) while CVD is positive
    h2 = hw.assess({"market": live(falling), "flow": {"heavy5": stock_rows(40, falling), "fut": []}})
    assert h2["stocks"][0]["price_cvd_divergence"] == "price down, CVD proxy up"


def test_old_samples_with_only_the_original_six_fields_still_work() -> None:
    inp = build([UP] * 5)
    for _, pl in inp["flow"]["heavy5"]:
        pl["rows"] = [r[:6] for r in pl["rows"]]
    h = hw.assess(inp)
    assert h["aggregate"]["15"]["score"] is not None and h["stocks"][0]["windows"]["15"]["price_change_pct"] is None


def test_the_stored_aggregate_series_is_chronological_and_carries_the_nifty_level() -> None:
    fut = [((NOW - timedelta(minutes=39 - i)).isoformat(), {"spot": 24000.0 + i}) for i in range(40)]
    h = hw.assess(build([UP] * 5, fut=fut))
    ts = [x["t"] for x in h["series"]]
    assert ts == sorted(ts) and len(ts) == 40
    last, first = h["series"][-1], h["series"][0]
    assert last["spot"] == 24039.0 and last["session"] == T20 and last["w15"] == T20 and first["w15"] is None  # a 15-minute window needs 15 stored minutes


def test_weights_metadata_flags_stale_and_approximate_weights() -> None:
    meta = {"weights": {"as_of": "2026-06-30", "source": "NSE index tracker", "age_days": 133, "approximate": False}, "stocks": [{"symbol": "HDFCBANK", "name": "HDFC Bank Ltd.", "weight": 13.1, "previous_weight": 12.4}]}
    h = hw.assess(build([UP] * 5, meta=meta))
    w = h["quality"]["weights"]
    assert w["stale"] is True and w["as_of"] == "2026-06-30" and h["quality"]["weights"]["basis"] == "official index weights"
    s = next(r for r in h["stocks"] if r["symbol"] == "HDFCBANK")
    assert s["name"] == "HDFC Bank Ltd." and s["previous_weight"] == 12.4
    fresh = hw.assess(build([UP] * 5, meta={"weights": {"as_of": "2026-10-30", "age_days": 10, "approximate": True}, "stocks": []}))
    assert fresh["quality"]["weights"]["stale"] is False and fresh["quality"]["weights"]["approximate"] is True


def test_nothing_tracked_is_reported_as_unavailable() -> None:
    h = hw.assess({"market": {}, "flow": {"heavy5": [], "fut": []}})
    assert h["available"] is False and h["aggregate"] == {} and h["participation"]["class"] == "Unavailable" and h["signals"] == []
    assert any("not observed" in x for x in hw.LIMITS) and any("timestamps" in x for x in hw.LIMITS)
