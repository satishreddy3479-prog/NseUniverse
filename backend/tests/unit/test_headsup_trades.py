"""Heads-up messages for the managed trades, from real events captured on the server on 17 Nov 2026 (the strategy's stop, stop to cost and 15:20 close; the swing book's volume wait, signal,
entry and day-1 exits)."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient

from app import headsup_trades as ht
from tests.unit.test_globalmkts import make_app

FIX = json.loads((Path(__file__).parent.parent / "fixtures" / "headsup" / "trades_17nov2026.json").read_text(encoding="utf-8"))
NOW = datetime(2026, 11, 17, 10, 0, tzinfo=UTC)  # 15:30 IST on 17 Nov


def test_the_strategy_messages_are_classified_from_what_the_server_wrote() -> None:
    doc = {"serverEvents": FIX["strategy_events"]}
    got = {a["kind"]: a for a in ht.strategy_alerts(doc, NOW)}
    assert set(got) == {"stop", "cost", "close"}  # today's three events (the 16 Nov close is yesterday's, and older ones are dropped)
    assert got["stop"]["level"] == "bad" and got["stop"]["title"] == "Stop loss hit" and "SELL 25300 CE closed at 122.05" in got["stop"]["text"] and "[server]" not in got["stop"]["text"]
    assert got["cost"]["level"] == "info" and got["cost"]["title"] == "Stop moved to cost"
    assert got["close"]["title"] == "Auto close" and got["stop"]["link"] == "/strategy"
    keys = [a["key"] for a in ht.strategy_alerts(doc, NOW)]
    assert len(set(keys)) == 3 and keys == [a["key"] for a in ht.strategy_alerts(doc, NOW)]  # stable: a closed message does not come back


def test_the_strategy_rule_texts_map_to_their_kinds() -> None:
    def kind(text: str) -> tuple[str, str]:
        a = ht.strategy_alerts({"serverEvents": [{"at": NOW.isoformat(), "text": text}]}, NOW)[0]
        return a["kind"], a["level"]

    assert kind("15:00:00 Target: SELL 25300 PE closed at 20.00 (entry 51.15), +₹2,000 [server]") == ("target", "good")
    assert kind("11:00:00 Trailing stop: SELL 25300 PE stop 102.30 → 90.00 (price 70.00) [server]") == ("trail", "info")
    assert kind("11:00:00 Strategy stop loss (−₹5,000): every leg closed [server]") == ("strategy_stop", "bad")
    assert kind("11:00:00 Strategy target (+₹5,000): every leg closed [server]") == ("strategy_target", "good")
    assert kind("11:00:00 Locked profit (floor +₹1,000): every leg closed [server]") == ("lock", "good")
    assert kind("11:00:00 Stop to cost skipped for SELL 25300 PE: it is not in profit [server]") == ("cost_skipped", "warn")
    assert kind("11:00:00 something new the server says") == ("event", "info")


def test_events_of_another_day_or_older_than_six_hours_are_not_shown() -> None:
    old = [{"at": "2026-11-17T03:00:00+00:00", "text": "08:30:00 Stop: SELL 25300 PE closed at 1.00 [server]"}]  # 09:00 IST: more than six hours before 15:30
    yesterday = [{"at": "2026-11-16T09:50:00+00:00", "text": "Stop: x"}]
    future = [{"at": "2026-11-17T11:00:00+00:00", "text": "Stop: x"}]
    assert ht.strategy_alerts({"serverEvents": old}, NOW) == []
    assert ht.strategy_alerts({"serverEvents": yesterday}, NOW) == []
    assert ht.strategy_alerts({"serverEvents": future}, NOW) == []
    assert ht.strategy_alerts(None, NOW) == []


def test_the_swing_book_messages_waiting_for_volume_entry_and_day_one_exits() -> None:
    out = ht.swing_alerts(FIX["live_events"], FIX["minute_events"], FIX["positions"], datetime(2026, 11, 17, 10, 0, tzinfo=UTC), "2026-11-17")
    by = {}
    for a in out:
        by.setdefault(a["kind"], []).append(a)
    assert {"entry_trigger", "waiting_volume", "signal", "entered", "not_chased", "day1_fail", "day1_wick"} >= set(by) and {"waiting_volume", "signal", "entered"} <= set(by)
    wait = by["waiting_volume"][0]
    assert wait["level"] == "warn" and "triggered, waiting for volume" in wait["title"] and "of the pace needed" in wait["text"]
    entered = by["entered"][0]
    assert entered["level"] == "good" and "shares at" in entered["text"] and "stop" in entered["text"]
    exits = [a for a in out if a["kind"] in ("day1_fail", "day1_wick", "stop")]
    assert exits and all(a["level"] == "bad" for a in exits)
    assert any("Day-1 exit" in a["title"] for a in exits) and any("below the pivot" in a["text"] for a in exits)
    assert len({a["key"] for a in out}) == len(out)  # every message has its own key
    assert not any("outside_window" in json.dumps(a) for a in out)  # the noisy states are not messages


def test_open_positions_say_when_the_stop_or_a_level_is_reached() -> None:
    pos = [{"symbol": "ABC", "state": "stop_hit", "ltp": 99.0, "stop": 100.0, "reached_1_8r": False, "reached_2_5r": False, "level_1_8r": 130.0, "level_2_5r": 145.0},
           {"symbol": "XYZ", "state": "holding", "ltp": 150.0, "stop": 100.0, "reached_1_8r": True, "reached_2_5r": True, "level_1_8r": 130.0, "level_2_5r": 145.0}]
    out = ht.swing_alerts([], [], pos, NOW, "2026-11-17")
    kinds = {(a["title"].split(":")[0], a["kind"]) for a in out}
    assert kinds == {("ABC", "stop"), ("XYZ", "target")}
    xyz = next(a for a in out if a["kind"] == "target")
    assert "2.5R" in xyz["title"] and "145" in xyz["text"]  # the higher level is the one said (not both)
    assert next(a for a in out if a["kind"] == "stop")["key"] == "swing-pos:2026-11-17:ABC:stop"


def test_the_list_is_newest_first_and_capped() -> None:
    many = [{"key": str(i), "at": f"2026-11-17T09:{i:02d}:00+00:00", "source": "swing"} for i in range(20)]
    out = ht.build([], many)
    assert len(out) == ht.MAX_ALERTS and out[0]["key"] == "19" and out[-1]["key"] == "8"


def test_the_api_serves_the_trade_messages_even_with_no_swing_book(tmp_path: Path) -> None:
    app = make_app(tmp_path)
    with TestClient(app) as c:
        body = c.get("/api/headsup/trades").json()
    assert body["alerts"] == [] and "generated_at" in body
