# ruff: noqa: E501
"""The live paper ledger: when it fills, sizing, stops, reconciliation with the evening settlement, and that the official book is untouched."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest

from app.swing.engine import Config, Decision, Trade, position_size
from app.swing.live_ledger import LiveLedger
from tests.unit.test_swing_live import CFG, Rig, order, position, tick


async def rig(tmp_path: Path, **kw: object) -> Rig:
    r = Rig(tmp_path, **kw)  # type: ignore[arg-type]
    r.live.ledger = LiveLedger(tmp_path / "ledger.sqlite3", CFG)
    r.live._live_fills = lambda: True
    r.live._no = 4
    await r.live.refresh()
    r.ticks["nse_cm|111"] = tick("nse_cm|111", received=r.now)  # ABC: ltp 100, open 99 ... set the trigger reading below
    return r


def triggered(r: Rig, **kw: object) -> None:
    base: dict[str, object] = dict(ltp=101.0, open_=99.0, high=101.5, low=98.8, volume=600_000, received=r.now)
    base.update(kw)
    r.ticks["nse_cm|111"] = tick("nse_cm|111", **base)  # type: ignore[arg-type]


def test_position_size_is_the_evening_runs_formula() -> None:
    cfg = Config()
    # equity 1,000,000: risk budget 2 % = 20,000 over a 3.0 stop distance = 6,666; one slot of five = 200,000 / 100 = 2,000 shares -> 2,000
    assert position_size(1_000_000, 1_000_000, 100.0, 97.0, cfg) == 2000
    # a wide stop (20.0) makes the risk budget the limit: 20,000 / 20 = 1,000
    assert position_size(1_000_000, 1_000_000, 100.0, 80.0, cfg) == 1000
    # little cash is the limit: 50,000 / (100 x 1.0015) = 499
    assert position_size(1_000_000, 50_000, 100.0, 97.0, cfg) == 499
    assert position_size(1_000_000, 1_000_000, 100.0, 100.0, cfg) == 0 and position_size(1_000_000, 1_000_000, 100.0, 101.0, cfg) == 0


async def test_one_triggered_reading_is_not_enough_two_consecutive_make_one_fill_at_the_evening_runs_price(tmp_path: Path) -> None:
    r = await rig(tmp_path)
    triggered(r)
    r.live.poll(r.now)
    assert r.live.ledger.rows() == []  # a single reading: no fill (a bad tick must not create one)
    r.live.poll(r.now + timedelta(seconds=2))
    [f] = r.live.ledger.rows()
    assert f["symbol"] == "ABC" and f["price"] == pytest.approx(100.3)  # max(day open 99.0, trigger 100.3): the evening run's fill price
    assert f["shares"] == position_size(1_000_000, 1_000_000, 100.3, 97.0, CFG) and f["status"] == "open" and f["recon"] == "pending"
    r.live.poll(r.now + timedelta(seconds=4))
    assert len(r.live.ledger.rows()) == 1  # one fill per order per day
    assert r.live.ledger.cash() == pytest.approx(1_000_000 - f["shares"] * 100.3 * 1.0015)
    assert r.live.ledger.equity() == pytest.approx(r.live.ledger.cash() + f["shares"] * 101.0)  # marked at the last live price


async def test_the_reading_must_hold_on_consecutive_polls(tmp_path: Path) -> None:
    r = await rig(tmp_path)
    triggered(r)
    r.live.poll(r.now)
    triggered(r, ltp=100.0)  # back under the trigger: the count restarts
    r.live.poll(r.now + timedelta(seconds=2))
    triggered(r)
    r.live.poll(r.now + timedelta(seconds=4))
    assert r.live.ledger.rows() == []


@pytest.mark.parametrize("why", ["stale", "gap", "volume", "feed", "behind", "held", "slots", "cooldown", "no_token"])
async def test_no_fill_when_a_condition_fails(tmp_path: Path, why: str) -> None:
    r = await rig(tmp_path)
    triggered(r)
    if why == "stale":
        r.ticks["nse_cm|111"] = tick("nse_cm|111", ltp=101.0, received=r.now - timedelta(minutes=5))
    elif why == "gap":
        triggered(r, open_=103.0)  # opened above the no-chase limit 102.5
    elif why == "volume":
        triggered(r, volume=1_000)
    elif why == "feed":
        r.live._feed_state = lambda: "reconnecting"
    elif why == "behind":
        r.live._last_scan = "2026-10-20"  # the book is behind: its queue was meant for an earlier session
    elif why == "held":
        r.live._positions.append(position("ABC"))
    elif why == "slots":
        for i in range(CFG.slots):
            r.live.ledger.record_fill(session="2026-11-04", now=r.now, order=order(f"S{i}", id=50 + i), price=100.0, shares=1, equity=1e6, evidence="x")
    elif why == "cooldown":
        r.live._last_exit = {"ABC": 4}  # stopped out in the last session: three sessions of cooldown
    elif why == "no_token":
        r.live._tokens.pop("ABC", None)
    before = len(r.live.ledger.rows())
    for k in range(3):
        r.live.poll(r.now + timedelta(seconds=2 * k))
    assert len(r.live.ledger.rows()) == before


async def test_a_live_stop_closes_the_ledger_position_and_nothing_else(tmp_path: Path) -> None:
    r = await rig(tmp_path)
    triggered(r)
    r.live.poll(r.now)
    r.live.poll(r.now + timedelta(seconds=2))
    r.ticks["nse_cm|111"] = tick("nse_cm|111", ltp=96.5, open_=99.0, high=101.5, low=96.5, received=r.now + timedelta(minutes=30))
    r.live.poll(r.now + timedelta(minutes=30))
    [f] = r.live.ledger.rows()
    assert f["status"] == "closed" and f["exit_price"] == pytest.approx(97.0)  # the initial stop; the official stop state is unchanged
    assert f["pnl"] == pytest.approx(f["shares"] * (97.0 - 100.3) - f["shares"] * (97.0 + 100.3) * 0.0015)
    assert "breached" in f["exit_reason"]


async def test_the_official_book_is_unchanged_by_the_ledger(tmp_path: Path) -> None:
    r = await rig(tmp_path)
    r.live.load_watch = lambda: None  # type: ignore[method-assign]
    before = r.store.snapshot()
    triggered(r)
    for k in range(3):
        r.live.poll(r.now + timedelta(seconds=2 * k))
    o = order()
    r.live.ledger.reconcile("2026-11-04", [Decision(o, "skipped", "volume 1,000 below the minimum 1,000,000")], [])
    assert r.store.snapshot() == before  # not a row of the official tables was written


def _fill(ledger: LiveLedger, r: Rig, **kw: object) -> dict[str, object]:
    ledger.record_fill(session="2026-11-04", now=r.now, order=order(), price=100.3, shares=100, equity=1e6, evidence="e")
    [f] = ledger.rows()
    return f


async def test_reconciliation_confirms_rejects_and_follows_official_exits(tmp_path: Path) -> None:
    r = await rig(tmp_path)
    led = r.live.ledger
    f = _fill(led, r)
    # undecided: stays pending
    assert led.reconcile("2026-11-04", [], []) == {"confirmed": 0, "rejected": 0, "closed": 0}
    # official book filled it at the same price: confirmed with the gap kept
    out = led.reconcile("2026-11-04", [Decision(order(), "filled", "", 100.3, 90)], [])
    assert out["confirmed"] == 1
    [c] = led.rows()
    assert c["recon"] == "confirmed" and c["official_fill"] == 100.3 and c["official_shares"] == 90 and c["status"] == "open"
    # later the official book closes it on a stop: the ledger follows at the official exit
    t = Trade("ABC", "CNXIT", "BLUE_SKY", 70.0, "2026-11-04", 100.3, 100.0, 97.0, 90, "2026-11-05", 97.0, "STOP", -297.0, 27.0, -324.0, -1.0, 1, 6)
    assert led.close_with_official("2026-11-05", [t]) == 1
    [d] = led.rows()
    assert d["status"] == "closed" and d["exit_price"] == 97.0 and "official STOP" in d["exit_reason"]
    assert f["id"] == d["id"]


async def test_a_fill_the_official_book_skipped_is_voided_not_hidden(tmp_path: Path) -> None:
    r = await rig(tmp_path)
    led = r.live.ledger
    _fill(led, r)
    led.mark(1, 101.5, r.now)
    out = led.reconcile("2026-11-04", [Decision(order(), "skipped", "volume 700,000 below the minimum 1,000,000")], [])
    assert out == {"confirmed": 0, "rejected": 1, "closed": 1}
    [f] = led.rows()
    assert f["recon"] == "rejected" and "volume 700,000 below the minimum" in f["recon_reason"]
    assert f["status"] == "closed" and f["exit_price"] == 101.5 and f["exit_reason"].startswith("void: official book skipped it")
    snap = led.snapshot()
    assert snap["reconciliation"] == {"pending": 0, "confirmed": 0, "rejected": 1} and len(snap["fills"]) == 1  # still listed


async def test_a_confirmed_fill_the_official_book_closed_the_same_day_is_closed_at_the_official_exit(tmp_path: Path) -> None:
    r = await rig(tmp_path)
    led = r.live.ledger
    _fill(led, r)
    t = Trade("ABC", "CNXIT", "BLUE_SKY", 70.0, "2026-11-04", 100.3, 100.0, 97.0, 90, "2026-11-04", 99.0, "D1_FAIL_CLOSE", -117.0, 27.0, -144.0, -0.4, 0, 5)
    out = led.settled("2026-11-04", [Decision(order(), "filled", "", 100.3, 90)], [t])
    assert out["confirmed"] == 1 and out["closed"] == 1
    [f] = led.rows()
    assert f["status"] == "closed" and f["exit_price"] == 99.0 and "D1_FAIL_CLOSE" in f["exit_reason"]


async def test_the_snapshot_reports_equity_and_the_gap_to_the_official_fill(tmp_path: Path) -> None:
    r = await rig(tmp_path)
    led = r.live.ledger
    _fill(led, r)
    led.reconcile("2026-11-04", [Decision(order(), "filled", "", 100.1, 80)], [])
    s = led.snapshot()
    assert s["fills"][0]["price_gap"] == pytest.approx(0.2) and s["open"] == 1 and s["capital"] == CFG.capital
    assert s["equity"] == pytest.approx(CFG.capital - 100 * 100.3 * 0.0015)  # marked at its own fill price: only the entry cost is lost
