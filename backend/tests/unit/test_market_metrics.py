"""Breadth, contribution, volume, move quality and sectors. Small hand-built universes whose arithmetic is
written out in comments (formula checks only: these are not market data)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.market.metrics import (
    Stock,
    StockTick,
    breadth,
    change_pct,
    contributions,
    direction,
    move_quality,
    relative_volume,
    rotation,
    sector_table,
)

NOW = datetime(2026, 10, 29, 5, 0, tzinfo=UTC)


def tick(sym: str, ltp: float | None, prev: float | None = 100.0, vol: int | None = None, high: float | None = None, low: float | None = None, age_s: float = 5) -> StockTick:
    return StockTick(sym, ltp, prev, vol, high, low, NOW - timedelta(seconds=age_s))


# A +2.00, B +1.00, C -1.00, D +0.02 (flat), E no tick. Weights 40/30/20/10; E has no weight.
UNIVERSE = [Stock("A", "X", 40), Stock("B", "X", 30), Stock("C", "Y", 20), Stock("D", "Y", 10), Stock("E", "Y", None)]
TICKS = {
    "A": tick("A", 102.0, vol=400, high=102.0, low=100.0),
    "B": tick("B", 101.0, vol=100, high=101.5, low=100.0),
    "C": tick("C", 99.0, vol=200, high=100.0, low=99.0),
    "D": tick("D", 100.02, vol=200),
}


def test_change_and_direction_edges() -> None:
    assert change_pct(tick("A", 102.0)) == pytest.approx(2.0)
    assert change_pct(tick("A", None)) is None and change_pct(tick("A", 0.0)) is None and change_pct(tick("A", 5.0, None)) is None
    assert change_pct(None) is None
    assert [direction(x) for x in (0.06, 0.05, 0.0, -0.05, -0.06)] == ["adv", "flat", "flat", "flat", "dec"]


def test_breadth_counts_hand_calculated() -> None:
    b = breadth(UNIVERSE, TICKS, NOW)
    assert (b.total, b.covered, b.advancing, b.declining, b.flat) == (5, 4, 2, 1, 1)
    assert b.ad_ratio == pytest.approx(2.0) and b.ad_balance == pytest.approx(1 / 3)
    assert b.pct_advancing == pytest.approx(50.0)
    assert b.equal_weight_return == pytest.approx((2 + 1 - 1 + 0.02) / 4)  # 0.505
    assert b.coverage == pytest.approx(0.8)
    assert b.at_high == 1 and b.at_low == 1  # A at its high, C at its low (B is 0.5 below its high)
    assert b.gainers[0] == ("A", 2.0) and b.losers == [("C", -1.0)]


def test_a_missing_or_stale_stock_is_not_covered_and_never_flat() -> None:
    ticks = {**TICKS, "B": tick("B", 101.0, age_s=900), "C": tick("C", None)}
    b = breadth(UNIVERSE, ticks, NOW)
    assert b.covered == 2 and b.flat == 1 and b.advancing == 1 and b.declining == 0  # only A and D
    assert breadth(UNIVERSE, {}, NOW).covered == 0 and breadth(UNIVERSE, {}, NOW).ad_balance is None


def test_no_decliners_gives_no_ratio_not_infinity() -> None:
    b = breadth([Stock("A"), Stock("B")], {"A": tick("A", 101), "B": tick("B", 102)}, NOW)
    assert b.ad_ratio is None and b.ad_balance == 1.0


def test_contribution_hand_calculated() -> None:
    c = contributions(UNIVERSE, TICKS, NOW)
    assert c is not None
    assert c.weight_loaded == 100 and c.weight_covered == 100  # E has no weight and is ignored
    # A 0.40*2 = 0.800, B 0.30*1 = 0.300, C 0.20*-1 = -0.200, D 0.10*0.02 = 0.002 -> net 0.902
    assert c.net_points_pct == pytest.approx(0.902)
    assert c.cap_weight_return == pytest.approx(0.902)
    assert c.top[0] == ("A", 0.8) and c.top[1] == ("B", 0.3)
    assert c.top5_share == pytest.approx((0.8 + 0.3 + 0.002) / 0.902)  # >100 %: C pulled the other way
    assert c.stocks_for_half == 1  # A alone is 88.7 % of the net


def test_contribution_for_a_falling_index_counts_the_decliners() -> None:
    uni = [Stock("A", "X", 60), Stock("B", "X", 40)]
    c = contributions(uni, {"A": tick("A", 98.0), "B": tick("B", 101.0)}, NOW)
    assert c is not None
    # A 0.60 * -2 = -1.2, B 0.40 * +1 = +0.4 -> net -0.8; same-direction (down) share = -1.2 / -0.8 = 150 %
    assert c.net_points_pct == pytest.approx(-0.8) and c.top5_share == pytest.approx(1.5) and c.stocks_for_half == 1


def test_contribution_without_weights_is_none_not_a_guess() -> None:
    assert contributions([Stock("A"), Stock("B")], TICKS, NOW) is None


def test_partial_coverage_is_reported() -> None:
    c = contributions(UNIVERSE, {"A": TICKS["A"], "C": TICKS["C"]}, NOW)
    assert c is not None and c.weight_covered == 60 and c.weight_loaded == 100
    assert c.cap_weight_return == pytest.approx((40 * 2 + 20 * -1) / 60)


def test_relative_volume_hand_calculated_linear_reference() -> None:
    avg = {"A": 1000, "B": 1000, "C": 1000, "D": 1000}
    v = relative_volume(UNIVERSE, TICKS, avg, elapsed_minutes=75, now=NOW)  # 20 % of the 375-minute session
    assert v is not None and v.reference == "linear"
    # rv: A 400/(1000*0.2)=2.0, B 0.5, C 1.0, D 1.0 -> weighted (40*2 + 30*0.5 + 20*1 + 10*1)/100 = 1.25
    assert v.weighted_rv == pytest.approx(1.25)
    assert v.up_volume_share == pytest.approx(500 / 700)  # A+B advancing volume vs C declining
    assert v.low_volume_names == ["B"]


def test_relative_volume_with_a_profile_and_without_data() -> None:
    avg = {"A": 1000}
    v = relative_volume([Stock("A", None, 50)], {"A": tick("A", 101, vol=300)}, avg, 75, profile_fraction=0.3, now=NOW)
    assert v is not None and v.reference == "profile" and v.weighted_rv == pytest.approx(1.0)
    assert relative_volume(UNIVERSE, TICKS, avg, elapsed_minutes=10, now=NOW) is None  # too early
    assert relative_volume(UNIVERSE, TICKS, {}, 75, now=NOW) is None  # no baseline


def stock_set(weights_changes: list[tuple[float, float]]) -> tuple[list[Stock], dict[str, StockTick]]:
    uni = [Stock(f"S{i}", "X", w) for i, (w, _) in enumerate(weights_changes)]
    ticks = {f"S{i}": tick(f"S{i}", 100 * (1 + c / 100), vol=100) for i, (_, c) in enumerate(weights_changes)}
    return uni, ticks


def test_move_quality_cases() -> None:
    # broad: ten equal stocks, eight up 0.4 %, two down 0.1 %
    uni, t = stock_set([(10, 0.4)] * 8 + [(10, -0.1)] * 2)
    b, c = breadth(uni, t, NOW), contributions(uni, t, NOW)
    v = relative_volume(uni, t, {s.symbol: 1000 for s in uni}, 75, now=NOW)  # volume 100 vs 1000*0.2 -> 0.5x
    idx = c.cap_weight_return if c else 0.0
    assert move_quality(idx, b, c, None)["state"] == "broad"  # no volume data: broad but not confirmed
    assert move_quality(idx, b, c, v)["state"] == "thin"  # volume 0.5x normal
    ok = relative_volume(uni, {k: StockTick(k, x.ltp, x.prev_close, 400, None, None, x.at) for k, x in t.items()}, {s.symbol: 1000 for s in uni}, 75, profile_fraction=0.2, now=NOW)
    assert move_quality(idx, b, c, ok)["state"] == "broad_confirmed"

    # narrow: one 50 % heavyweight +3 %, nine small ones slightly down
    uni, t = stock_set([(50, 3.0)] + [(50 / 9, -0.1)] * 9)
    b, c = breadth(uni, t, NOW), contributions(uni, t, NOW)
    q = move_quality(c.cap_weight_return if c else 0.0, b, c, None)
    assert q["state"] == "narrow" and "top 5" in q["reasons"][0]


def test_move_quality_needs_coverage_and_a_move() -> None:
    uni, t = stock_set([(10, 0.4)] * 10)
    b = breadth(uni, {k: v for k, v in list(t.items())[:3]}, NOW)
    assert move_quality(0.4, b, None, None)["state"] == "unknown"
    assert move_quality(0.05, breadth(uni, t, NOW), None, None)["state"] == "no_move"
    assert move_quality(None, breadth(uni, t, NOW), None, None)["state"] == "unknown"


def test_sector_table_hand_calculated_and_ranked() -> None:
    rows = sector_table(UNIVERSE, TICKS, benchmark_change=0.9, now=NOW)
    x, y = rows[0], rows[1]
    assert (x.sector, x.rank) == ("X", 1) and (y.sector, y.rank) == ("Y", 2)
    assert x.equal_weight_return == pytest.approx(1.5)  # (2 + 1) / 2
    assert x.cap_weight_return == pytest.approx((40 * 2 + 30 * 1) / 70)
    assert x.contribution_pts == pytest.approx(0.4 * 2 + 0.3 * 1)  # 1.1 percentage points
    assert y.cap_weight_return == pytest.approx((20 * -1 + 10 * 0.02) / 30)
    assert x.relative_strength == pytest.approx(x.cap_weight_return - 0.9)
    assert (x.advancing, x.declining, y.advancing, y.declining) == (2, 0, 0, 1)
    assert y.stocks == 3 and y.covered == 2  # E has no tick


def test_a_sector_index_return_is_preferred_when_streamed() -> None:
    rows = sector_table(UNIVERSE, TICKS, 0.9, sector_index_change={"Y": 0.5}, now=NOW)
    y = next(r for r in rows if r.sector == "Y")
    assert y.index_return == 0.5 and y.relative_strength == pytest.approx(0.5 - 0.9)


def test_sector_with_too_few_covered_stocks_gets_no_return_and_no_rank() -> None:
    rows = sector_table(UNIVERSE, {"C": TICKS["C"]}, 0.9, now=NOW, min_covered=2)
    assert all(r.equal_weight_return is None and r.rank is None for r in rows)


def test_rotation_reports_only_real_rank_changes() -> None:
    rows = sector_table(UNIVERSE, TICKS, 0.9, now=NOW)
    assert rotation({"X": 1, "Y": 2}, rows) == []
    assert rotation({"X": 3, "Y": 1}, rows) == [
        {"sector": "X", "from_rank": 3, "to_rank": 1, "direction": "up"},
    ]
