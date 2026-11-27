"""The live position monitor: the account of an open short straddle, hand-checked against Black-76 prices, plus a sanity check on the real captured chain of 2026-11-23."""

from __future__ import annotations

import json
import math
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.domain.models import DataSource, ExpiryKind
from app.domain.normalize import normalize_option_chain
from app.intelligence import straddle as sd
from app.intraday.volatility import CALL, DEFAULT_RATE, PUT, greeks, price, years_to_expiry
from app.storage.strategies import StrategyStore
from app.strategy import monitor as mon
from app.strategy.automation import (
    RUNNING_KEY,
    RUNNING_KIND,
    StrategyAutomation,
    ladder_from_snapshot,
)
from tests.conftest import make_app

SPOT_KEY = "nse_cm|Nifty 50"
EXPIRY = date(2026, 12, 1)
IV = 0.14
STRIKES = [float(k) for k in range(25650, 26051, 50)]
LADDER = [{"strike": k, "ce": f"nse_fo|{int(k)}C", "pe": f"nse_fo|{int(k)}P"} for k in STRIKES]
T0 = datetime(2026, 11, 27, 6, 30, tzinfo=UTC)  # 12:00 IST
FIXTURES = Path(__file__).parent.parent / "fixtures"


class Clock:
    def __init__(self, at: datetime = T0) -> None:
        self.at = at

    def __call__(self) -> datetime:
        return self.at

    def advance(self, minutes: float) -> None:
        self.at += timedelta(minutes=minutes)


def quotes(spot: float, at: datetime, iv: float = IV) -> dict[str, float]:
    """Black-76 prices of every strike on the ladder and the index, as the feed would show them at ``at``."""
    t = years_to_expiry(EXPIRY, at)
    f = spot * math.exp(DEFAULT_RATE * t)
    out: dict[str, float] = {SPOT_KEY: spot}
    for k in STRIKES:
        out[f"nse_fo|{int(k)}C"] = price(CALL, f, k, t, iv)
        out[f"nse_fo|{int(k)}P"] = price(PUT, f, k, t, iv)
    return out


def short_straddle(book: dict[str, float], strike: int = 25850) -> list[dict[str, Any]]:
    """A straddle sold at the book's prices, one lot of 65."""
    base = {"expiry": EXPIRY.isoformat(), "strike": strike, "action": "SELL", "lots": 1, "enabled": True, "premiumSource": "market", "enteredAt": T0.isoformat()}
    return [
        {**base, "id": "c", "type": "CE", "key": f"nse_fo|{strike}C", "premium": book[f"nse_fo|{strike}C"]},
        {**base, "id": "p", "type": "PE", "key": f"nse_fo|{strike}P", "premium": book[f"nse_fo|{strike}P"]},
    ]


def setup(tmp_path: Path, spot: float = 25850.0, extra: dict[str, Any] | None = None) -> tuple[mon.PositionMonitor, Clock, dict[str, float], StrategyAutomation]:
    clock, book = Clock(), quotes(spot, T0)
    store = StrategyStore(tmp_path / "s")
    auto = StrategyAutomation(store, book.get, lambda: True, now=clock, ladder_of=lambda _e: LADDER)
    (tmp_path / "d").mkdir(exist_ok=True)
    doc = {"auto": True, "lotSize": 65, "mult": 1, "expiry": EXPIRY.isoformat(), "legs": short_straddle(book), "restrike": {"points": 100}, **(extra or {})}
    store.put(RUNNING_KIND, RUNNING_KEY, {**doc, "rev": 1})
    monitor = mon.PositionMonitor(auto, tmp_path / "d", now=clock)
    return monitor, clock, book, auto


def move(clock: Clock, book: dict[str, float], spot: float, minutes: float) -> None:
    clock.advance(minutes)
    book.update(quotes(spot, clock.at))


def test_with_nothing_open_the_monitor_says_so(tmp_path: Path) -> None:
    monitor, _clock, _book, auto = setup(tmp_path)
    auto.store.put(RUNNING_KIND, RUNNING_KEY, {"auto": True, "lotSize": 65, "legs": []})
    out = monitor.payload()
    assert out["available"] is False and "No open option leg" in out["reason"]


def test_one_expiry_at_a_time(tmp_path: Path) -> None:
    monitor, _clock, book, auto = setup(tmp_path)
    legs = short_straddle(book)
    legs[1]["expiry"] = "2026-12-29"
    auto.store.put(RUNNING_KIND, RUNNING_KEY, {"auto": True, "lotSize": 65, "legs": legs})
    assert "one expiry at a time" in monitor.payload()["reason"]


def test_time_alone_pays_a_short_straddle_its_theta_by_hand(tmp_path: Path) -> None:
    monitor, clock, book, _ = setup(tmp_path)
    assert monitor.sample() is True
    spot0 = 25850.0
    t_a, t_b = years_to_expiry(EXPIRY, clock.at), years_to_expiry(EXPIRY, clock.at + timedelta(minutes=30))
    move(clock, book, spot0, 30)  # 30 minutes pass, NIFTY has not moved
    assert monitor.sample() is True
    out = monitor.payload()
    assert out["available"] is True
    # by hand: the straddle is repriced at the same index level 30 minutes later; a seller gains what the straddle loses
    f_a, f_b = spot0 * math.exp(DEFAULT_RATE * t_a), spot0 * math.exp(DEFAULT_RATE * t_b)
    before = price(CALL, f_a, 25850, t_a, IV) + price(PUT, f_a, 25850, t_a, IV)
    after = price(CALL, f_b, 25850, t_b, IV) + price(PUT, f_b, 25850, t_b, IV)
    assert out["pnl"]["points"] == pytest.approx(before - after, abs=0.01) and out["pnl"]["points"] > 0
    a = out["attribution"]
    assert a["theta"] > 0 and abs(a["spot"]) < 0.3 and abs(a["vol"]) < 0.3  # time did the work; flat vol; the index did not move
    assert a["theta"] + a["vol"] + a["spot"] + a["other"] == pytest.approx(a["total"], abs=0.021)  # four figures rounded to 0.01
    assert out["pnl"]["rupees"] == pytest.approx(out["pnl"]["points"] * 65, abs=0.5 * 65 * 0.01 + 1)  # rupees from the unrounded points, one lot of 65


def test_a_move_away_from_the_strike_costs_the_seller_and_the_account_adds_up(tmp_path: Path) -> None:
    monitor, clock, book, _ = setup(tmp_path)
    monitor.sample()
    for spot in (25830.0, 25800.0, 25780.0):  # NIFTY slides 70 points over 15 minutes, a sample every 5
        move(clock, book, spot, 5)
        monitor.sample()
    out = monitor.payload()
    a = out["attribution"]
    assert a["steps"] == 3 and a["spot"] < 0 and a["theta"] > 0  # the move cost, time paid
    assert a["theta"] + a["vol"] + a["spot"] + a["other"] == pytest.approx(out["pnl"]["points"], abs=0.021)  # four figures rounded to 0.01
    assert abs(a["other"]) < 0.5  # the repricing explains the premium change
    # hand check of the total: entry premiums were taken at the opening prices, the position is marked at the prices now
    t_now = years_to_expiry(EXPIRY, clock.at)
    f_now = 25780.0 * math.exp(DEFAULT_RATE * t_now)
    now_straddle = price(CALL, f_now, 25850, t_now, IV) + price(PUT, f_now, 25850, t_now, IV)
    entry = sum(lg["premium"] for lg in short_straddle(quotes(25850.0, T0)))
    assert out["pnl"]["points"] == pytest.approx(entry - now_straddle, abs=0.01)
    assert out["premium"]["entry"] == pytest.approx(entry, abs=0.01) and out["premium"]["now"] == pytest.approx(now_straddle, abs=0.01)
    assert out["premium"]["loss_pct"] == pytest.approx((now_straddle - entry) / entry * 100, abs=0.06) and out["premium"]["credit"] is True


def test_net_delta_and_the_distance_gauge_by_hand(tmp_path: Path) -> None:
    monitor, clock, book, _ = setup(tmp_path)
    monitor.sample()
    move(clock, book, 25780.0, 70)  # 13:10 IST, NIFTY 70 points under the strike
    monitor.sample()
    out = monitor.payload()
    t = years_to_expiry(EXPIRY, clock.at)
    f = 25780.0 * math.exp(DEFAULT_RATE * t)
    gc, gp = greeks(CALL, f, 25850, t, IV), greeks(PUT, f, 25850, t, IV)
    assert gc is not None and gp is not None
    assert out["delta"]["net"] == pytest.approx(-(gc.delta + gp.delta), abs=0.003) and out["delta"]["net"] > 0  # a short straddle under its strike is long NIFTY
    assert out["delta"]["units"] == round(out["delta"]["net"] * 65)
    d = out["distance"]
    assert d["points"] == -70.0 and d["restrike_points"] == 100 and d["share_of_restrike"] == 0.7
    # expected move to the end of continuous cash trading (15:15): 125 minutes left, in trading time (375 x 252 minutes a year)
    assert d["minutes_left"] == 125
    assert d["expected_move"] == pytest.approx(25780 * IV * math.sqrt(125 / (375 * 252)), abs=0.6)  # about 131 points
    assert d["share_of_expected"] == pytest.approx(70 / d["expected_move"], abs=0.01)


def test_status_levels() -> None:
    m = mon.PositionMonitor.__new__(mon.PositionMonitor)
    ok = m._status(2.7, 0.6, {"share_of_restrike": 0.3})
    assert ok["level"] == "ok" and ok["reasons"] == []
    assert m._status(16.0, None, None)["level"] == "watch"
    assert m._status(2.0, 1.6, None)["level"] == "watch" and "1.6 times" in m._status(2.0, 1.6, None)["reasons"][0]
    assert m._status(2.0, None, {"share_of_restrike": 0.65})["level"] == "watch"
    assert m._status(2.0, None, {"share_of_restrike": 0.95})["level"] == "alert"
    assert m._status(31.0, 0.2, {"share_of_restrike": 0.1})["level"] == "alert"


def test_the_account_survives_a_restart_and_a_new_position_starts_afresh(tmp_path: Path) -> None:
    monitor, clock, book, auto = setup(tmp_path)
    monitor.sample()
    move(clock, book, 25820.0, 5)
    monitor.sample()
    first = monitor.payload()["attribution"]
    again = mon.PositionMonitor(auto, tmp_path / "d", now=clock)  # a new process reads the file
    assert again.payload()["attribution"] == first and len(again.state["samples"]) == 2
    legs = short_straddle(book, 25800)  # a re-strike: other contracts, a new entry
    for lg in legs:
        lg["enteredAt"] = clock.at.isoformat()
    doc = auto.get()
    assert doc is not None
    auto.store.put(RUNNING_KIND, RUNNING_KEY, {**doc, "legs": legs, "rev": 2})
    assert again.sample() is True
    assert len(again.state["samples"]) == 1 and again.payload()["attribution"]["steps"] == 0  # the account of the new pair starts here


def test_a_sample_is_stored_once_a_minute_and_only_in_a_live_session(tmp_path: Path) -> None:
    monitor, clock, book, auto = setup(tmp_path)
    assert monitor.sample() is True
    clock.advance(0.5)
    assert monitor.sample() is False  # 30 seconds later: too soon
    move(clock, book, 25850.0, 1)
    assert monitor.sample() is True
    auto.is_live = lambda: False  # type: ignore[method-assign]
    clock.advance(2)
    assert monitor.sample() is False  # the stream is not live: nothing is stored from stale prices


def test_the_log_remembers_the_first_minute_each_level_was_crossed(tmp_path: Path) -> None:
    monitor, clock, book, _ = setup(tmp_path)
    monitor.sample()
    for spot in (25830.0, 25810.0, 25790.0, 25755.0):  # 95 points away: past 60 % and 90 % of the 100-point re-strike
        move(clock, book, spot, 5)
        monitor.sample()
    out = monitor.payload()
    keys = [e["key"] for e in monitor.state["events"]]
    assert keys.count("dist60") == 1 and keys.count("dist90") == 1  # each level once, at the minute it was crossed
    assert out["status"]["level"] == "alert" and any("re-strike" in e["text"] for e in out["events"])


def test_the_api_serves_the_monitor(tmp_path: Path) -> None:
    monitor, clock, book, _ = setup(tmp_path)
    monitor.sample()
    move(clock, book, 25820.0, 5)
    monitor.sample()
    app = make_app(tmp_path / "app")
    with TestClient(app) as c:
        app.state.position_monitor = monitor
        body = c.get("/api/strategies/running/monitor").json()
        assert body["available"] is True and body["attribution"]["steps"] == 1 and body["legs"][0]["label"] == "SELL 25850 CE"
        assert body["series"]["theta"] and len(body["series"]["t"]) == 2
        app.state.position_monitor = None
        assert c.get("/api/strategies/running/monitor").status_code == 503


def test_on_the_real_captured_chain_a_short_atm_straddle_is_nearly_delta_neutral_and_every_figure_is_finite() -> None:
    """The real Kotak chain captured for the 23 Nov 2026 expiry: the live prices of the ATM contracts feed the same build_snap and point as the live monitor."""
    raw = json.loads((FIXTURES / "kotak_option_chain_NIFTY_2026-11-23.json").read_text(encoding="utf-8"))
    at = datetime(2026, 11, 20, 5, 0, tzinfo=UTC)
    snap = normalize_option_chain(
        raw, snapshot_id="s", session_id="x", underlying="NIFTY", expiry=date(2026, 11, 23), expiry_kinds=[ExpiryKind.MONTHLY],
        source=DataSource.SNAPSHOT, retrieved_at=at, requested_strike_count=40,
    )
    ladder = ladder_from_snapshot(snap)
    by_key = {}
    for r in snap.rows:
        for q in (r.call, r.put):
            if q is not None and q.exchange_segment and q.instrument_token and q.ltp:
                by_key[f"{q.exchange_segment}|{q.instrument_token}"] = float(q.ltp)
    spot = float(snap.underlying_ltp or 0)
    atm = min((r["strike"] for r in ladder), key=lambda k: abs(k - spot))
    row = next(r for r in ladder if r["strike"] == atm)
    legs = [{"expiry": "2026-11-23", "strike": atm, "type": t, "action": "SELL", "lots": 1, "key": row["ce" if t == "CE" else "pe"], "premium": by_key[row["ce" if t == "CE" else "pe"]]} for t in ("CE", "PE")]
    s = mon.build_snap(at, spot, legs, ladder, lambda lg: by_key.get(lg["key"]))
    pt, why = sd.build_point(s, date(2026, 11, 23), DEFAULT_RATE)
    assert pt is not None, why
    net = 0.0
    for lg in legs:
        leg = pt.leg(float(lg["strike"]), mon.side_of(lg))
        assert leg is not None and leg.iv > 0 and math.isfinite(leg.iv)
        net += mon.weight(lg) * leg.g.delta
    assert abs(net) < 0.25  # a sold at-the-money pair: its two deltas nearly cancel
    assert s.prices[(atm, CALL)] == legs[0]["premium"]
