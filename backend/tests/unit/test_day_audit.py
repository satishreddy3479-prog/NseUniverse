"""The after-close audit and the override ledger (19 Nov 2026).

The chain's spot-replacement check replaced a healthy index quote 32 times between 09:15 and 09:47 IST with a level 10-66 points below the live index; the opening strike became 25150
instead of 25200. The audit cross-checks the stored spot against the live index bars; the ledger counts every override.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from app.domain.overrides import OverrideLedger
from app.lifecycle.day_audit import audit_alerts, audit_day, minute_key, spot_vs_index_bars

FIX = json.loads((Path(__file__).parent.parent / "fixtures" / "audit" / "spot_vs_bars_19nov2026.json").read_text(encoding="utf-8"))
DAY = date(2026, 11, 19)
BARS = {minute_key(datetime.fromisoformat(b["at"])): b for b in FIX["bars"]}


def spots(field: str) -> list[tuple[datetime, float]]:
    return [(datetime.fromisoformat(s["at"]), float(s[field])) for s in FIX["spots"]]


def test_the_stored_replacement_levels_of_19_nov_fail_the_audit_and_the_broker_quotes_pass() -> None:
    bad = spot_vs_index_bars(DAY, spots("stored"), BARS)
    # hand count on the real rows: 30 captures have a bar of 10+ reads; 27 of them lie more than 15 points outside the bar's low-high range, the worst 46.1 below the high at 09:17
    assert bad["checked"] == 30 and bad["outside"] == 27 and bad["first_at"] == "09:15"
    assert bad["worst"]["at"] == "09:17" and bad["worst"]["off"] == -46.1 and bad["worst"]["spot"] == 25166.42
    good = spot_vs_index_bars(DAY, spots("broker"), BARS)
    assert good["checked"] == 30 and good["outside"] == 0  # the broker's own quote was inside the live bar's range every minute (within 15 points)
    out = audit_day(DAY, spots("stored"), BARS)
    f = out["findings"][0]
    assert f["id"] == "spot_vs_index" and f["level"] == "warning" and "27 of 30 minutes" in f["text"] and "-46.1 at 09:17" in f["text"] and "opening strike" in f["text"]
    assert audit_day(DAY, spots("broker"), BARS)["findings"] == []  # nothing to report on the fixed behaviour


def test_the_closing_auction_thin_bars_and_missing_bars_are_not_judged() -> None:
    at = datetime(2026, 11, 19, 9, 46, tzinfo=UTC)  # 15:16 IST: the index is silent in the closing auction
    bars = {minute_key(at): {"l": 25500.0, "h": 25502.0, "n": 59}}
    assert spot_vs_index_bars(DAY, [(at, 25300.0)], bars)["checked"] == 0
    early = datetime(2026, 11, 19, 5, 30, tzinfo=UTC)  # 11:00 IST
    assert spot_vs_index_bars(DAY, [(early, 25300.0)], {minute_key(early): {"l": 25500.0, "h": 25502.0, "n": 4}})["checked"] == 0  # a bar of 4 reads
    assert spot_vs_index_bars(DAY, [(early, 25300.0)], {})["checked"] == 0  # no bar
    assert audit_day(DAY, [(early, 25300.0)], {})["findings"][0]["level"] == "info"  # said, not alarmed
    near = {minute_key(early): {"l": 25500.0, "h": 25502.0, "n": 59}}
    assert spot_vs_index_bars(DAY, [(early, 25486.0)], near)["outside"] == 0  # 14 below the low: inside the 15-point margin
    assert spot_vs_index_bars(DAY, [(early, 25484.0)], near)["outside"] == 1  # 16 below: outside


def test_two_stray_minutes_are_not_a_finding_three_are() -> None:
    base = datetime(2026, 11, 19, 5, 30, tzinfo=UTC)
    bars = {minute_key(base + timedelta(minutes=i)): {"l": 25500.0, "h": 25502.0, "n": 59} for i in range(5)}
    pts = [(base + timedelta(minutes=i), 25400.0 if i < 2 else 25501.0) for i in range(5)]
    assert audit_day(DAY, pts, bars)["findings"] == []
    pts3 = [(base + timedelta(minutes=i), 25400.0 if i < 3 else 25501.0) for i in range(5)]
    assert audit_day(DAY, pts3, bars)["findings"][0]["id"] == "spot_vs_index"


def test_the_warnings_of_recent_audits_reach_the_alert_list() -> None:
    doc = audit_day(DAY, spots("stored"), BARS)
    now = datetime(2026, 11, 19, 12, 0, tzinfo=UTC)
    got = audit_alerts(lambda d: {"audit": doc} if d == DAY else None, now)
    assert [a["key"] for a in got] == ["audit-2026-11-19-spot_vs_index"] and got[0]["level"] == "warning" and got[0]["text"].startswith("After-close audit of 2026-11-19")
    assert audit_alerts(lambda d: {"audit": doc} if d == DAY else None, now + timedelta(days=4)) == []  # older than three days: not shown
    assert audit_alerts(lambda d: None, now) == []


def test_the_ledger_counts_per_day_and_warns_above_the_hourly_threshold() -> None:
    led = OverrideLedger()
    t0 = datetime(2026, 11, 19, 3, 45, tzinfo=UTC)  # 09:15 IST: the 32 replacements of 19 Nov came once a minute from here
    for i in range(4):
        led.record("index_quote_replaced", f"broker 25190.7 -> 25128.25 #{i}", t0 + timedelta(minutes=i))
    assert led.warnings(t0 + timedelta(minutes=4)) == []  # four in the hour: below the threshold of five
    led.record("index_quote_replaced", "5th", t0 + timedelta(minutes=4))
    w = led.warnings(t0 + timedelta(minutes=5))
    assert len(w) == 1 and w[0]["key"] == "override-index_quote_replaced" and "5 times in the last hour (5 today)" in w[0]["text"]
    assert led.counts(t0 + timedelta(minutes=5))["index_quote_replaced"] == {"today": 5, "last_hour": 5}
    assert led.warnings(t0 + timedelta(hours=2)) == []  # an hour later the rate is zero, the day count stays
    assert led.counts(t0 + timedelta(hours=2))["index_quote_replaced"] == {"today": 5, "last_hour": 0}
    assert led.counts(t0 + timedelta(days=1)) == {}  # a new IST day starts from nothing
    assert led.recent(2)[0]["detail"] == "5th"
    led.record("something_new", "x", t0)  # a kind without its own threshold warns at ten an hour
    assert led.warnings(t0 + timedelta(minutes=5))[0]["key"] == "override-index_quote_replaced"
