"""The live regime and squeeze detectors and their four alerts (D219), by hand on small series. Open interest is in units (one lot = 65 units)."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from app.intelligence import live_regime as lr
from app.intelligence import straddle_watch as watch
from app.intraday.volatility import CALL, PUT

IST = ZoneInfo("Asia/Kolkata")
OPEN = datetime(2026, 11, 19, 9, 15, tzinfo=IST)


def at(minute: int) -> datetime:
    return OPEN + timedelta(minutes=minute)


def analysis(spots: list[float], start_min: int = 0, sd: float | None = 200.0) -> dict[str, Any]:
    """One stored sample a minute from the open (+ ``start_min``); implied daily SD ``sd`` points."""
    return {"times": [at(start_min + i).isoformat() for i in range(len(spots))], "spot": spots, "realised_vs_implied": {"implied_daily_sd_pts": sd}}


def ib_spots(extreme: float, at_minute: int = 20, n: int = 61) -> list[float]:
    s = [25000.0] * n
    s[at_minute] = 25000.0 + extreme
    return s


# ------------------------------------------------------------------ initial balance
def test_the_opening_range_against_the_implied_daily_move_by_hand() -> None:
    wide = lr.initial_balance(analysis(ib_spots(140.0)))  # 140 points / 200 = 0.70 > 0.65
    assert wide["status"] == "ok" and wide["range_pts"] == 140.0 and wide["ratio"] == 0.7 and wide["flag"] == "IB_EXPANSION_TREND"
    tight = lr.initial_balance(analysis(ib_spots(60.0)))  # 0.30 < 0.35
    assert tight["ratio"] == 0.3 and tight["flag"] == "IB_COMPRESSION_DECAY"
    middle = lr.initial_balance(analysis(ib_spots(100.0)))  # 0.50: neither
    assert middle["ratio"] == 0.5 and middle["flag"] is None
    edge = lr.initial_balance(analysis(ib_spots(130.0)))  # exactly 0.65 is not above it
    assert edge["ratio"] == 0.65 and edge["flag"] is None


def test_only_the_first_thirty_minutes_count_and_an_incomplete_or_late_first_half_hour_is_not_judged() -> None:
    late_move = ib_spots(0.0)
    late_move[31] = 25300.0  # a 300-point move in minute 31: outside the opening range
    assert lr.initial_balance(analysis(late_move))["range_pts"] == 0.0
    in_30 = ib_spots(0.0)
    in_30[30] = 25140.0  # minute 30 itself (09:45) is inside
    assert lr.initial_balance(analysis(in_30))["range_pts"] == 140.0
    forming = lr.initial_balance(analysis(ib_spots(140.0, at_minute=10, n=20)))  # 19 minutes stored
    assert forming["status"] == "forming" and forming["ratio"] is None and forming["flag"] is None
    started_late = lr.initial_balance(analysis(ib_spots(140.0), start_min=25))  # the first stored minute is 09:40
    assert started_late["status"] == "unknown" and "not the open" in started_late["reason"] and started_late["flag"] is None
    assert lr.initial_balance(analysis(ib_spots(140.0), sd=None))["status"] == "unknown"  # no implied daily move to compare with
    assert lr.initial_balance({"times": [], "spot": []})["status"] == "unknown"


# ------------------------------------------------------------------ the track and the windows
def test_the_track_reads_open_interest_near_the_money_and_the_vwap() -> None:
    oi = {(25000.0, CALL): 1000, (25000.0, PUT): 2000, (25500.0, CALL): 300, (26000.0, CALL): 5000, (24000.0, PUT): 7000, (25050.0, PUT): None}
    mi = {"panels": {"futures": {"oi_change": -12000}}, "pulse": {"vwap": {"side": "above", "distance_pct": 0.31}}}
    t = lr.track_now(oi, 25000.0, mi)  # the band is 2.5 % of 25,000 = 625 points: 26,000 and 24,000 are outside it
    assert t == {"fut_oi_chg": -12000.0, "ce_oi": 1300, "pe_oi": 2000, "vwap_side": "above", "vwap_dist_pct": 0.31}
    none = lr.track_now(None, None, {})
    assert none == {"fut_oi_chg": None, "ce_oi": None, "pe_oi": None, "vwap_side": None, "vwap_dist_pct": None}


def hist(rows: list[tuple[int, dict[str, Any]]]) -> list[tuple[str, dict[str, Any]]]:
    """(minute offset from the open, track) rows, newest first, as the store returns them."""
    return [(at(m).isoformat(), tr) for m, tr in sorted(rows, key=lambda x: -x[0])]


def spots_to(minute: int, start: float, end: float) -> list[float]:
    """A flat session from the open that is at ``start`` 15 minutes before ``minute`` and at ``end`` at ``minute``."""
    s = [start] * (minute + 1)
    s[minute] = end
    return s


def test_a_short_squeeze_is_the_index_up_and_the_futures_open_interest_shedding() -> None:
    a = analysis(spots_to(60, 25000.0, 25055.0), sd=None)  # +55 / 25,000 = +0.22 % over the last 15 minutes; no implied move, so no opening-range flag
    track = {"fut_oi_chg": -50000.0, "ce_oi": None, "pe_oi": None, "vwap_side": None, "vwap_dist_pct": None}
    r = lr.evaluate_live_regime(a, {}, track, hist([(45, {"fut_oi_chg": -10000.0})]))
    sq = r["squeeze"]
    assert sq["status"] == "ok" and sq["active"] is True and sq["spot_change_15m_pct"] == 0.22 and sq["fut_oi_change_15m"] == -40000
    assert "40,000 units (615 lots)" in sq["message"] and "Do not sell at-the-money calls or straddles" in sq["message"]  # 40,000 / 65 = 615.4
    assert [f["id"] for f in r["flags"]] == ["ACTIVE_SHORT_SQUEEZE"] and r["flags"][0]["severity"] == "high" and r["label"] == "TREND_RISK"
    weak_price = lr.evaluate_live_regime(analysis(spots_to(60, 25000.0, 25047.5), sd=None), {}, track, hist([(45, {"fut_oi_chg": -10000.0})]))  # +0.19 %
    assert weak_price["squeeze"]["active"] is False and weak_price["squeeze"]["status"] == "ok"
    weak_oi = lr.evaluate_live_regime(a, {}, {**track, "fut_oi_chg": -40000.0}, hist([(45, {"fut_oi_chg": -10000.0})]))  # -30,000: not beyond -35,000
    assert weak_oi["squeeze"]["active"] is False


def test_a_window_with_no_stored_minute_near_it_is_unknown_not_zero() -> None:
    a = analysis(spots_to(60, 25000.0, 25055.0), sd=None)
    track = {"fut_oi_chg": -50000.0}
    no_hist = lr.evaluate_live_regime(a, {}, track, [])
    assert no_hist["squeeze"]["status"] == "unknown" and no_hist["squeeze"]["fut_oi_change_15m"] is None and "no stored futures open interest" in no_hist["squeeze"]["reason"]
    far = lr.evaluate_live_regime(a, {}, track, hist([(40, {"fut_oi_chg": -10000.0})]))  # 20 minutes ago: more than 3 minutes from the 15-minute mark
    assert far["squeeze"]["status"] == "unknown"
    near = lr.evaluate_live_regime(a, {}, track, hist([(42, {"fut_oi_chg": -10000.0})]))  # exactly 3 minutes from it
    assert near["squeeze"]["status"] == "ok"
    no_fut = lr.evaluate_live_regime(a, {}, {"fut_oi_chg": None}, hist([(45, {"fut_oi_chg": -10000.0})]))
    assert no_fut["squeeze"]["status"] == "unknown"


def test_the_put_floor_needs_puts_added_much_faster_than_calls_while_the_index_rises() -> None:
    a = analysis(spots_to(60, 25000.0, 25030.0), sd=None)  # +0.12 %
    before = {"ce_oi": 100000, "pe_oi": 500000}
    now = {"ce_oi": 110000, "pe_oi": 530000, "fut_oi_chg": None}  # calls +10,000, puts +30,000: 3.0 x
    r = lr.evaluate_live_regime(a, {}, now, hist([(45, before)]))
    fl = r["put_floor"]
    assert fl["status"] == "ok" and fl["active"] is True and fl["put_additions_15m"] == 30000 and fl["call_additions_15m"] == 10000 and r["flags"][0]["id"] == "PUT_FLOOR_ADVANCING"
    assert r["flags"][0]["severity"] == "medium" and r["label"] == "UNCLEAR"  # a put floor alone is not a trend flag
    slower = lr.evaluate_live_regime(a, {}, {**now, "pe_oi": 524000}, hist([(45, before)]))  # puts +24,000 < 2.5 x 10,000
    assert slower["put_floor"]["active"] is False
    unwinding = lr.evaluate_live_regime(a, {}, {**now, "ce_oi": 95000, "pe_oi": 508000}, hist([(45, before)]))  # calls -5,000 count as none added; puts +8,000 >= 0.5 % of 508,000
    assert unwinding["put_floor"]["active"] is True
    noise = lr.evaluate_live_regime(a, {}, {**now, "ce_oi": 100000, "pe_oi": 502000}, hist([(45, before)]))  # puts +2,000 is under 0.5 % of the put interest: noise
    assert noise["put_floor"]["active"] is False
    falling = lr.evaluate_live_regime(analysis(spots_to(60, 25000.0, 25020.0), sd=None), {}, now, hist([(45, before)]))  # +0.08 % is not above 0.10 %
    assert falling["put_floor"]["active"] is False


def test_vwap_detachment_counts_the_minutes_on_one_side_and_the_distance() -> None:
    a = analysis([25000.0] * 61, sd=None)
    track = {"vwap_side": "above", "vwap_dist_pct": 0.30}
    run = hist([(m, {"vwap_side": "above"}) for m in range(21, 60)])  # above since minute 21 of the session: 39 minutes before minute 60
    r = lr.evaluate_live_regime(a, {}, track, run)
    v = r["vwap"]
    assert v["status"] == "ok" and v["active"] is True and v["minutes_away"] == 39 and v["at_least"] is True  # the stored minutes start at 21: a lower bound
    assert "at least 39 minutes" in v["message"] and r["flags"][0]["id"] == "VWAP_TREND_DETACHMENT" and r["label"] == "TREND_RISK"
    crossed = hist([(m, {"vwap_side": "above"}) for m in range(41, 60)] + [(40, {"vwap_side": "below"})])  # crossed 20 minutes ago: 19 minutes on this side
    c = lr.evaluate_live_regime(a, {}, track, crossed)["vwap"]
    assert c["active"] is False and c["minutes_away"] == 19 and c["at_least"] is False
    close = lr.evaluate_live_regime(a, {}, {"vwap_side": "above", "vwap_dist_pct": 0.20}, run)["vwap"]  # 0.20 % is not beyond 0.22 %
    assert close["active"] is False
    assert lr.evaluate_live_regime(a, {}, {"vwap_side": None, "vwap_dist_pct": None}, run)["vwap"]["status"] == "unknown"
    thirty_five = lr.evaluate_live_regime(a, {}, track, hist([(m, {"vwap_side": "above"}) for m in range(25, 60)]))["vwap"]  # exactly 35 minutes: not more than 35
    assert thirty_five["minutes_away"] == 35 and thirty_five["active"] is False


def test_the_label_is_trend_risk_decay_favoured_unclear_or_no_data() -> None:
    tight = lr.evaluate_live_regime(analysis(ib_spots(60.0)), {}, {}, [])
    assert tight["ib"]["flag"] == "IB_COMPRESSION_DECAY" and tight["label"] == "DECAY_FAVOURED" and tight["any_known"] is True
    wide = lr.evaluate_live_regime(analysis(ib_spots(140.0)), {}, {}, [])
    assert wide["label"] == "TREND_RISK" and wide["flags"][0]["id"] == "IB_EXPANSION_TREND" and "0.70 of the implied daily move (200)" in wide["flags"][0]["message"]
    nothing = lr.evaluate_live_regime({"times": [], "spot": []}, {}, {}, [])
    assert nothing["label"] == "NO_DATA" and nothing["any_known"] is False and nothing["flags"] == []
    assert tight["track"] == {} and "not a forecast" in tight["note"]


# ------------------------------------------------------------------ the four alerts
def snap(*flags: str, msgs: dict[str, str] | None = None) -> dict[str, Any]:
    return {"live": {"flags": list(flags), "messages": msgs or {}}}


def kinds(prev: list[dict[str, Any]], cur: dict[str, Any]) -> list[tuple[str, str, str]]:
    return [(x["kind"], x["severity"], x["direction"]) for x in watch.detect(prev, cur)]


def test_a_short_squeeze_alert_fires_once_when_it_has_held_two_minutes() -> None:
    m = {"ACTIVE_SHORT_SQUEEZE": "Short squeeze in progress: NIFTY +0.22%"}
    cur = snap("ACTIVE_SHORT_SQUEEZE", msgs=m)
    quiet = [snap(), snap(), snap()]
    held = [snap("ACTIVE_SHORT_SQUEEZE"), snap(), snap()]  # newest first: on this minute and the one before, not three minutes ago
    assert kinds(held, cur) == [("Short squeeze detected", "high", "bearish")]
    assert watch.detect(held, cur)[0]["text"] == "Short squeeze in progress: NIFTY +0.22%"
    assert kinds(quiet, cur) == []  # one minute is a blip
    already = [snap("ACTIVE_SHORT_SQUEEZE"), snap("ACTIVE_SHORT_SQUEEZE"), snap("ACTIVE_SHORT_SQUEEZE")]
    assert kinds(already, cur) == []  # three minutes ago it was already on: already alerted


def test_the_wide_opening_range_alert_fires_when_the_flag_first_appears() -> None:
    cur = snap("IB_EXPANSION_TREND", msgs={"IB_EXPANSION_TREND": "The opening 30 minutes covered 140 points"})
    assert kinds([snap()], cur) == [("Opening range expansion (wide IB)", "high", "neutral")]
    assert kinds([snap("IB_EXPANSION_TREND")], cur) == []  # the minute before already had it
    assert kinds([snap()], snap("IB_COMPRESSION_DECAY")) == []  # a compressed range is not an alert


def test_the_put_floor_and_vwap_alerts_have_their_severities() -> None:
    held = [snap("PUT_FLOOR_ADVANCING"), snap(), snap()]
    assert kinds(held, snap("PUT_FLOOR_ADVANCING")) == [("Put floor advancing aggressively", "medium", "bullish")]
    runaway = [snap("VWAP_TREND_DETACHMENT"), snap(), snap()]
    assert kinds(runaway, snap("VWAP_TREND_DETACHMENT")) == [("VWAP trend runaway", "high", "neutral")]
    assert kinds([snap()], snap()) == [] and kinds([{}], {}) == []  # a snapshot without a live block raises nothing
    default_text = watch.detect(held, snap("PUT_FLOOR_ADVANCING"))[0]["text"]
    assert "Put open interest is being added much faster" in default_text  # a sentence even without the stored message


def test_the_service_computes_the_track_the_regime_and_the_radar_and_stores_the_track(tmp_path) -> None:  # type: ignore[no-untyped-def]
    from tests.unit.test_straddle_env import TestRecordingEndToEnd

    t = TestRecordingEndToEnd()
    from tests.unit.test_straddle_env import OPEN as SVC_OPEN

    now = [SVC_OPEN + timedelta(minutes=90)]
    s = t.svc(tmp_path, now)
    assert s.record(now[0]) is True
    row = s.store.rows("2026-11-11")[0]["data"] if s.store else {}
    assert row["track"]["vwap_side"] == "above" and row["track"]["vwap_dist_pct"] == 0.05 and row["track"]["ce_oi"] is not None and row["track"]["fut_oi_chg"] is None  # no futures panel in this fixture
    assert set(row["live"]) == {"flags", "messages", "label", "ib_ratio"}
    out = s.summary()
    assert out["live_regime"]["track"]["vwap_side"] == "above" and out["live_regime"]["ib"]["status"] in ("ok", "unknown")
    pf = out["preflight"]
    assert set(pf["gates"]) == {"premium_decay", "volatility_shock", "regime_squeeze", "structure_flip"} and pf["verdict"] in ("ALL_CLEAR_TO_SELL", "SELECTIVE", "BLOCKED", "INCOMPLETE")
    assert pf["regime"]["label"] == out["live_regime"]["label"] and pf["trade_setup"]["re_strike_pts"] == 35.0
    pytest.importorskip("app")  # keeps the import used: the regime module is part of the service
