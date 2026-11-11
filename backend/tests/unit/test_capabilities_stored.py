"""Capabilities that depend on the live flow tracker fall back to the last stored minute (labelled PARTIAL, with its time) instead of saying UNAVAILABLE after the
close or right after a restart; the capabilities that cannot exist say whether the feed lacks the data or nothing subscribes to it. Synthetic numbers = FORMULA CHECKS."""

from __future__ import annotations

from typing import Any

from app.intelligence import fusion as fz

STAMP = "2026-11-11T09:45:00+00:00"  # 15:15 IST


def caps(inp: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {c["id"]: c for c in fz.capabilities(inp, {}, {})}


STORED = {"flow": {"fut": [(STAMP, {"b": 600, "s": 400, "atp": 25000.0, "ltp": 25050.0, "v": 1})], "heavy5": [(STAMP, {"rows": [["HDFCBANK", 1, 2, 3, 4]]})]}}


def test_after_the_close_session_cvd_and_vwap_come_from_the_last_stored_minute() -> None:
    c = caps(STORED)
    s = c["session_cvd"]
    assert s["status"] == fz.PARTIAL and "+20.0% of classified volume" in s["reason"] and "15:15 IST" in s["reason"] and s["as_of"] == STAMP  # (600 - 400) / 1000
    v = c["vwap"]
    assert v["status"] == fz.PARTIAL and "25000.00" in v["reason"] and "+0.20%" in v["reason"] and "15:15 IST" in v["reason"]  # 25050 / 25000 - 1
    h = c["hw_cvd"]
    assert h["status"] == fz.PARTIAL and "up to 15:15 IST" in h["reason"] and h["as_of"] == STAMP


def test_live_figures_win_over_stored_ones() -> None:
    live = STORED | {"market": {"flow": {"futures": {"cvd_pct": 7.5}}}, "intraday": {"vwap": {"vwap": 25001.0}}}
    c = caps(live)
    assert c["session_cvd"]["status"] == fz.AVAILABLE and "stored" not in c["session_cvd"]["reason"]
    assert c["vwap"]["status"] == fz.AVAILABLE


def test_nothing_stored_and_nothing_live_is_unavailable_and_says_it_is_not_data_yet() -> None:
    c = caps({})
    for k in ("session_cvd", "vwap", "hw_cvd"):
        assert c[k]["status"] == fz.UNAVAILABLE and c[k]["why"] == "no_data_yet"


def test_a_stored_sample_with_a_missing_figure_is_skipped_not_zero_filled() -> None:
    c = caps({"flow": {"fut": [(STAMP, {"b": 600, "s": 400, "atp": 25000.0, "ltp": 25050.0}), ("2026-11-11T09:46:00+00:00", {"b": None, "s": None, "atp": None, "ltp": None})], "heavy5": []}})
    assert c["session_cvd"]["as_of"] == STAMP  # the newest sample with both figures, not the empty one after it


def test_capabilities_that_cannot_exist_say_why() -> None:
    c = caps({})
    assert {k: c[k]["why"] for k in ("hw_genuine_cvd", "spot_vwap", "option_aggressor")} == {"hw_genuine_cvd": "feed", "spot_vwap": "feed", "option_aggressor": "feed"}
    assert c["rollover"]["why"] == "not_subscribed" and c["stock_futures"]["why"] == "not_subscribed"
