"""Backtest engine on small stored datasets with hand-calculated results (lot size 65, zero costs unless stated)."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from app.domain.models import (
    Completeness,
    DataSource,
    ExpiryKind,
    OptionChainRow,
    OptionChainSnapshot,
    OptionQuote,
)
from app.storage.observations import ObservationStore
from app.strategy.backtest import BacktestConfig, backtest
from app.strategy.costs import CostModel, execution_cost

EXPIRY = date(2026, 11, 3)
FREE = CostModel(brokerage_per_order=0, stt_sell_pct=0, exchange_pct=0, sebi_pct=0, stamp_buy_pct=0, gst_pct=0)


def quote(side: str, ltp: float | None) -> OptionQuote:
    return OptionQuote(
        exchange_segment="nse_fo", instrument_token=None, trading_symbol=None, option_type=side, ltp=ltp, open=None, high=None,
        low=None, prev_close=None, close=None, volume=10, oi=100, oi_previous=90, oi_change=None, oi_change_pct=None, moneyness=None,
    )  # fmt: skip


def snapshot(sid: str, at: datetime, spot: float, ce: dict[int, float | None], pe: dict[int, float | None]) -> OptionChainSnapshot:
    rows = [OptionChainRow(strike=k, call=quote("CE", ce[k]), put=quote("PE", pe[k])) for k in sorted(ce)]
    return OptionChainSnapshot(
        snapshot_id=sid, session_id="s", underlying="NIFTY", expiry=EXPIRY, expiry_kinds=[ExpiryKind.WEEKLY], source=DataSource.SNAPSHOT,
        retrieved_at=at, lot_size=65, multiplier=1, requested_strike_count=3, completeness=Completeness.COMPLETE, rows=rows,
        ce_count=3, pe_count=3, underlying_ltp=spot,
    )  # fmt: skip


def fill_day(store: ObservationStore, day: date, ce_at: Callable[[int], float | None], pe_at: Callable[[int], float | None],
             minutes: int = 45, spot_at: Callable[[int], float] = lambda m: 110.0) -> None:
    """One sample a minute from 09:15 IST. Strikes 100/110/120; the ATM (110) prices come from the callables."""
    for m in range(minutes):
        at = datetime(day.year, day.month, day.day, 3, 45, tzinfo=UTC) + timedelta(minutes=m)
        ce = {100: 20.0, 110: ce_at(m), 120: 3.0}
        pe = {100: 2.0, 110: pe_at(m), 120: 18.0}
        store.record_snapshot(snapshot(f"{day}-{m}", at, spot_at(m), ce, pe), unchanged=False)


def straddle(**over: object) -> BacktestConfig:
    base = {"legs": [{"type": "CE", "action": "SELL", "lots": 1, "offset_steps": 0}, {"type": "PE", "action": "SELL", "lots": 1, "offset_steps": 0}],
            "entry_time": "09:20", "exit_time": "09:50", "costs": FREE.model_dump()}
    return BacktestConfig.model_validate({**base, **over})


@pytest.fixture
def store(tmp_path: Path) -> ObservationStore:
    return ObservationStore(tmp_path)


def test_time_exit_pnl_is_hand_calculated(store: ObservationStore) -> None:
    # Both options decay 0.1 a minute. Entry 09:20 (m=5): CE 9.5, PE 7.5. Exit 09:50 (m=35): CE 6.5, PE 4.5.
    fill_day(store, date(2026, 10, 28), lambda m: 10 - 0.1 * m, lambda m: 8 - 0.1 * m)
    r = backtest(store, straddle())
    t = r["trades"][0]
    assert t["exit_reason"] == "time" and t["minutes_held"] == 30.0
    assert [(g["strike"], g["entry"], g["exit"]) for g in t["legs"]] == [(110.0, 9.5, 6.5), (110.0, 7.5, 4.5)]
    assert t["gross"] == pytest.approx(((9.5 - 6.5) + (7.5 - 4.5)) * 65)  # 390: short legs gain the decay
    assert t["net"] == t["gross"] and r["metrics"]["net_pnl"] == 390.0 and r["metrics"]["win_rate"] == 100.0


def test_stop_loss_exits_at_the_first_sample_that_shows_the_breach_at_that_samples_price(store: ObservationStore) -> None:
    # CE entry 12.5 at m=5 then +0.5 a minute; PE flat 8. Loss per minute held = 0.5 x 65 = 32.5; stop 100 first breached at +4 minutes.
    fill_day(store, date(2026, 10, 28), lambda m: 10 + 0.5 * m, lambda m: 8.0)
    r = backtest(store, straddle(stop_loss={"mode": "rupees", "value": 100}))
    t = r["trades"][0]
    assert t["exit_reason"] == "stop_loss" and t["minutes_held"] == 4.0
    assert t["legs"][0]["entry"] == 12.5 and t["legs"][0]["exit"] == 14.5
    assert t["gross"] == pytest.approx(-(14.5 - 12.5) * 65)  # -130: the loss is the price at the breaching sample, not the stop level


def test_target_exit_and_percent_of_premium_limits(store: ObservationStore) -> None:
    fill_day(store, date(2026, 10, 28), lambda m: 10 - 0.1 * m, lambda m: 8 - 0.1 * m)
    # premium collected = (9.5 + 7.5) x 65 = 1105; 5 % of it = 55.25; the position gains 13 a minute (0.2 x 65): first >= 55.25 after 5 minutes
    r = backtest(store, straddle(target={"mode": "pct_of_premium", "value": 5}))
    t = r["trades"][0]
    assert t["exit_reason"] == "target" and t["minutes_held"] == 5.0
    assert t["gross"] == pytest.approx(0.2 * 5 * 65)


def test_missing_prices_are_never_filled(store: ObservationStore) -> None:
    # no PE price until 09:26: entry at 09:20 cannot be priced within the 5-minute wait (to 09:25)
    fill_day(store, date(2026, 10, 28), lambda m: 10.0, lambda m: None if m < 11 else 8.0)
    r = backtest(store, straddle())
    assert r["trades"] == [] and "no sample within 5 min" in r["skipped_sessions"][0]["reason"]
    r2 = backtest(store, straddle(max_wait_minutes=10))  # waiting long enough finds the first priced sample (09:26)
    assert r2["trades"][0]["entry_at"].startswith("2026-10-28T03:56")
    # missing prices after entry are skipped and counted, not carried forward
    fill_day(store, date(2026, 10, 29), lambda m: 10.0, lambda m: None if 8 <= m < 12 else 8.0)
    t = [x for x in backtest(store, straddle())["trades"] if x["session"] == "2026-10-29"][0]
    assert t["samples_skipped_missing_price"] == 4


def test_an_exit_that_cannot_be_priced_is_reported_not_closed_at_a_made_up_price(store: ObservationStore) -> None:
    fill_day(store, date(2026, 10, 28), lambda m: 10.0, lambda m: 8.0 if m < 36 else None, minutes=45)  # nothing priced from 09:51
    r = backtest(store, straddle(exit_time="09:55"))
    assert r["trades"] == [] and "could not be closed" in r["unpriced_sessions"][0]["reason"]


def test_thin_sessions_and_bad_times_are_reported(store: ObservationStore) -> None:
    fill_day(store, date(2026, 10, 28), lambda m: 10.0, lambda m: 8.0, minutes=10)  # 10 samples: too few
    r = backtest(store, straddle())
    assert r["trades"] == [] and "only 10 stored samples" in r["skipped_sessions"][0]["reason"]
    bad = backtest(store, straddle(entry_time="15:00", exit_time="10:00"))
    assert bad["trades"] == [] and any("entry and exit must satisfy" in w for w in bad["warnings"])


def test_costs_and_slippage_come_off_every_trade(store: ObservationStore) -> None:
    fill_day(store, date(2026, 10, 28), lambda m: 10 - 0.1 * m, lambda m: 8 - 0.1 * m)
    c = CostModel(brokerage_per_order=20, slippage_per_unit=0.5)
    r = backtest(store, straddle(costs=c.model_dump()))
    t = r["trades"][0]
    expect = sum(
        execution_cost("SELL", entry, 65, c) + execution_cost("BUY", exit_, 65, c) for entry, exit_ in ((9.5, 6.5), (7.5, 4.5))
    )
    assert t["costs"] == pytest.approx(expect, abs=0.01) and t["net"] == pytest.approx(t["gross"] - expect, abs=0.01)
    assert execution_cost("BUY", 100, 65, CostModel()) == pytest.approx(26.48947, abs=1e-4)  # 20 + 2.27695 + 0.0065 + 0.195, plus 18 % GST on 22.28345


def test_metrics_over_several_sessions_and_reproducibility(store: ObservationStore) -> None:
    fill_day(store, date(2026, 10, 27), lambda m: 10 - 0.1 * m, lambda m: 8 - 0.1 * m)  # +390
    fill_day(store, date(2026, 10, 28), lambda m: 10 + 0.1 * m, lambda m: 8 + 0.1 * m)  # entry 10.5/8.5 -> exit 13.5/11.5: -390
    fill_day(store, date(2026, 10, 29), lambda m: 10 - 0.05 * m, lambda m: 8 - 0.05 * m)  # +195
    cfg = straddle()
    r = backtest(store, cfg)
    m = r["metrics"]
    assert [t["net"] for t in r["trades"]] == [390.0, -390.0, 195.0]
    assert (m["trades"], m["wins"], m["losses"]) == (3, 2, 1) and m["win_rate"] == 66.7
    assert m["net_pnl"] == 195.0 and m["profit_factor"] == pytest.approx(585 / 390, abs=0.01)
    assert m["max_drawdown"] == 390.0  # equity 390 -> 0 -> 195: peak 390, trough 0
    assert [p["equity"] for p in r["equity_curve"]] == [390.0, 0.0, 195.0]
    assert m["largest_win"] == 390.0 and m["largest_loss"] == -390.0 and m["avg_loss"] == -390.0
    assert r["monthly_net"] == {"2026-10": 195.0} and m["sharpe_note"] and "3 trades" in m["sharpe_note"]
    assert any("not a durable edge" in w for w in r["warnings"])
    again = backtest(store, cfg)
    assert again["trades"] == r["trades"] and again["config_hash"] == r["config_hash"] and again["data_fingerprint"] == r["data_fingerprint"]
    assert backtest(store, straddle(exit_time="09:40"))["config_hash"] != r["config_hash"]


def test_strike_offsets_pick_listed_strikes_and_unlisted_offsets_skip_the_day(store: ObservationStore) -> None:
    fill_day(store, date(2026, 10, 28), lambda m: 10.0, lambda m: 8.0)
    cfg = BacktestConfig.model_validate({"legs": [{"type": "CE", "action": "BUY", "lots": 2, "offset_steps": 1}], "entry_time": "09:20", "exit_time": "09:50", "costs": FREE.model_dump()})
    t = backtest(store, cfg)["trades"][0]
    assert t["legs"][0]["strike"] == 120.0 and t["legs"][0]["lots"] == 2 and t["gross"] == 0.0  # price flat: no gain
    far = BacktestConfig.model_validate({"legs": [{"type": "CE", "action": "BUY", "lots": 1, "offset_steps": 5}], "entry_time": "09:20", "exit_time": "09:50"})
    assert backtest(store, far)["trades"] == []


def test_expiry_day_and_direction_buckets_state_how_few_trades_there_are(store: ObservationStore) -> None:
    fill_day(store, date(2026, 10, 28), lambda m: 10 - 0.1 * m, lambda m: 8 - 0.1 * m, spot_at=lambda m: 110.0 + m)  # NIFTY rises
    r = backtest(store, straddle())
    assert r["by_day_direction"]["NIFTY rose"]["n"] == 1 and r["by_day_direction"]["NIFTY rose"]["enough_data"] is False
    assert r["by_expiry_day"]["before expiry"]["n"] == 1


def test_the_api_reports_availability_and_runs_a_backtest(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from tests.conftest import make_app

    app = make_app(tmp_path)
    with TestClient(app) as c:
        obs = app.state.observations
        fill_day(obs, date(2026, 10, 28), lambda m: 10 - 0.1 * m, lambda m: 8 - 0.1 * m)
        av = c.get("/api/strategy/availability").json()
        assert av["sessions"] == [{"session": "2026-10-28", "samples": 45, "usable": True}]
        body = {"legs": [{"type": "CE", "action": "SELL", "lots": 1, "offset_steps": 0}], "entry_time": "09:20", "exit_time": "09:50", "costs": FREE.model_dump()}
        r = c.post("/api/strategy/backtest", json=body)
        assert r.status_code == 200 and r.json()["metrics"]["trades"] == 1
        assert c.post("/api/strategy/backtest", json={**body, "legs": []}).status_code == 422  # a strategy needs legs
        assert c.post("/api/strategy/backtest", json={**body, "entry_time": "9:xx"}).status_code == 422
