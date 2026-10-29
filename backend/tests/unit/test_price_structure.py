"""Opening-range breakout, quality score, swing structure and futures-VWAP descriptors.

The price paths are small SYNTHETIC sequences built to exercise each rule with a hand calculation (formula checks,
not market data). Real captured paths are added once the sampler has stored sessions for the dashboard replay.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app.intraday import price_structure as ps
from app.intraday.features import Point
from app.market.vwap import describe

IST = ZoneInfo("Asia/Kolkata")
B = datetime(2026, 10, 29, 9, 15, tzinfo=IST)
OR = [
    100,
    101,
    100,
    102,
    101,
    100,
    101,
    102,
    101,
    100,
    101,
    100,
    102,
    101,
    100,
]  # minutes 0-14: high 102, low 100, width 2


def path(after: list[float]) -> tuple[list[Point], datetime]:
    px = OR + after
    pts = [Point(B + timedelta(minutes=i, seconds=20), p) for i, p in enumerate(px)]
    return pts, B + timedelta(
        minutes=len(px), seconds=30
    )  # `now` is inside the minute after the last sample


def brk(after: list[float], **kw) -> dict:
    pts, now = path(after)
    return ps.analyze(pts, now, **kw)


def test_opening_range_is_forming_until_its_minutes_have_passed() -> None:
    pts = [Point(B + timedelta(minutes=i, seconds=20), 100 + i) for i in range(8)]
    r = ps.opening_range(pts, B + timedelta(minutes=8, seconds=30), 15)
    assert r["state"] == "forming" and (r["high"], r["low"], r["mid"], r["width"]) == (
        107,
        100,
        103.5,
        7,
    )
    full = brk([])["ranges"][0]
    assert full["state"] == "complete" and (
        full["high"],
        full["low"],
        full["mid"],
        full["width"],
    ) == (102, 100, 101.0, 2)
    assert brk([])["breakout"] is None  # nothing has left the range


def test_breakout_becomes_confirmed_after_three_clear_closes() -> None:
    # buffer = 10 % of the width 2 = 0.2, so "clear" means above 102.2. closes 103, 104, 105, 104.9
    b = brk([103, 104, 105, 104.9], vwap_side="up", ad_balance=0.5)["breakout"]
    assert (b["direction"], b["status"], b["beyond"], b["clear"], b["invalidation"]) == (
        "up",
        "CONFIRMED",
        4,
        4,
        102,
    )
    assert b["extension_ow"] == 1.45  # (104.9 - 102) / 2
    only_two = brk([103, 104], vwap_side="up")["breakout"]
    assert only_two["status"] == "DEVELOPING"  # 2 closes beyond, not yet 3 clear
    one = brk([103])["breakout"]
    assert one["status"] == "UNCONFIRMED"


def test_failed_invalidated_and_expired_breakouts() -> None:
    assert brk([103, 104, 101])["breakout"]["status"] == "FAILED"  # back inside the range
    assert brk([103, 99])["breakout"]["status"] == "INVALIDATED"  # beyond the opposite boundary
    # 32 closes at 102.1: beyond the boundary but never clear of the buffer -> expires 30 minutes after the first
    ex = brk([102.1] * 32)["breakout"]
    assert ex["status"] == "EXPIRED" and ex["clear"] == 0
    # a new break after a failure starts a new candidate and remembers the old one
    again = brk([103, 104, 101, 98])["breakout"]
    assert (
        again["direction"] == "down"
        and again["status"] == "UNCONFIRMED"
        and again["previous"] == "up FAILED"
    )


def test_the_minute_that_is_still_forming_is_never_used() -> None:
    pts, now = path([103, 104, 105])
    base = ps.analyze(pts, now)["breakout"]
    pts2 = [
        *pts,
        Point(now - timedelta(seconds=5), 90.0),
    ]  # a sample inside the current minute: price crashes
    assert (
        ps.analyze(pts2, now)["breakout"] == base
    )  # unchanged: an unfinished candle cannot move the status


def test_quality_score_is_a_documented_weighted_mean_and_not_a_probability() -> None:
    b = brk([103, 104, 105, 104.9], vwap_side="up", ad_balance=0.5)["breakout"]["quality"]
    # distance 1, follow-through 1, vwap 1, breadth (0.5+1)/2 = 0.75, volume missing: (25+20+20+20x0.75)/85
    assert (
        b["score"] == round((25 + 20 + 20 + 15) / 85 * 100, 1)
        and b["coverage"] == 0.85
        and b["missing"] == ["volume"]
    )
    assert b["is_probability"] is False
    down_vwap = brk([103, 104, 105, 104.9], vwap_side="down", ad_balance=0.5, rel_volume=0.7)[
        "breakout"
    ]["quality"]
    assert (
        down_vwap["components"]["vwap"] == 0.0 and down_vwap["components"]["volume"] == 0.0
    )  # against VWAP; volume at the 0.7x floor
    thin = brk([103, 104, 105, 104.9])["breakout"][
        "quality"
    ]  # only distance (25) and follow-through (20): 45 % coverage
    assert thin["score"] is None and thin["coverage"] == 0.45


def test_historical_data_gives_no_breakout_call() -> None:
    r = brk([103, 104, 105], live=False)
    assert (
        r["data"] == "HISTORICAL"
        and r["breakout"] is None
        and r["ranges"][0]["state"] == "complete"
    )


def test_swing_structure_labels_and_confirmation_lag() -> None:
    v = [10, 12, 15, 12, 10, 12, 14, 12, 11, 13, 16, 14, 12]  # one 5-minute close per step
    closes = [ps.Close(i * 5 + 4, p, p, p) for i, p in enumerate(v)]  # the close of each completed 5-minute bucket
    s = ps.structure(closes)
    assert [x["price"] for x in s["swing_highs"]] == [15, 14, 16] and [
        x["price"] for x in s["swing_lows"]
    ] == [10, 11]
    assert s["label"] == "uptrend (higher highs, higher lows)" and s["break"] is None
    # the last two points can never be a confirmed swing: a swing needs K later points
    assert all(
        x["minute"] <= (len(v) - 1 - ps.SWING_K) * 5 for x in s["swing_highs"] + s["swing_lows"]
    )
    up = ps.structure([*closes, ps.Close(69, 17, 17, 17)])
    assert up["break"] == "break_of_structure_up"
    down_then_up = ps.structure(
        [
            ps.Close(i * 5, p, p, p)
            for i, p in enumerate([10, 12, 15, 12, 10, 12, 14, 12, 8, 10, 12, 11, 9, 13, 16])
        ]
    )
    assert down_then_up["break"] in ("change_of_character_up", "break_of_structure_up")


def test_vwap_descriptors_side_crosses_reclaims_and_rejections() -> None:
    series = [(i, p, 100.0) for i, p in enumerate([99, 99, 99, 101, 101, 101, 99, 99, 99, 99])]
    d = describe(series)
    assert d is not None
    assert (d["price"], d["vwap"], d["distance_pts"], d["distance_pct"], d["side"]) == (
        99,
        100.0,
        -1.0,
        -1.0,
        "below",
    )
    assert d["crosses"] == 2 and d["minutes_above"] == 3 and d["minutes_below"] == 7
    assert [(e["event"], e["minute"]) for e in d["events"]] == [
        ("vwap_reclaim", 3),
        ("vwap_rejection", 6),
    ]
    assert d["slope_pts_per_15m"] is None  # fewer than 15 minutes of history
    longer = describe([(i, 100.0, 100.0 + i * 0.1) for i in range(20)])
    assert longer is not None and longer["slope_pts_per_15m"] == round(
        1.9 - 0.4, 2
    )  # ATP now 101.9 vs ATP at minute 4
    assert (
        describe([]) is None and describe([(0, 100.0, 0.0)]) is None
    )  # no ATP: nothing is invented
