"""Basis, open interest and volume of the NIFTY future, from recorded minute samples (hand-calculated)."""

from __future__ import annotations

import math
from datetime import UTC, date, datetime
from pathlib import Path

from fastapi.testclient import TestClient

from app.market.futures_series import futures_series
from app.market.store import MarketStore
from app.storage.observations import ObservationStore
from tests.conftest import make_app

NOW = datetime(2026, 11, 10, 9, 0, tzinfo=UTC)  # the tests use fixed 2026 dates: the 12-day look-back must not depend on the real clock


def put(m: MarketStore, utc: str, **p: object) -> None:
    m.record_sample("fut", utc, p)


def test_basis_carry_fair_value_oi_change_and_volume_per_minute(tmp_path: Path) -> None:
    m, o = MarketStore(tmp_path), ObservationStore(tmp_path)
    # previous session (Fri 30 Oct): last OI of the same contract 1,000,000
    put(m, "2026-10-30T10:00:00+00:00", v=900_000, ltp=23100.0, spot=23050.0, oi=990_000, exp="2026-11-25", sym="NIFTY25NOVFUT")
    put(m, "2026-10-30T10:05:00+00:00", v=1_000_000, ltp=23110.0, spot=23060.0, oi=1_000_000, exp="2026-11-25", sym="NIFTY25NOVFUT")
    # Monday 2 Nov, 09:16 and 09:17 IST (03:46 / 03:47 UTC)
    put(m, "2026-11-02T03:46:00+00:00", v=50_000, ltp=23200.0, spot=23150.0, oi=1_010_000, exp="2026-11-25", sym="NIFTY25NOVFUT")
    put(m, "2026-11-02T03:47:00+00:00", v=80_000, ltp=23210.0, spot=23160.0, oi=None, exp="2026-11-25", sym="NIFTY25NOVFUT")
    r = futures_series(m, o, "NIFTY", rate=0.06, day=date(2026, 11, 2), now=NOW)
    assert r["day"] == "2026-11-02" and r["contract"] == "NIFTY25NOVFUT"
    assert r["basis"] == [50.0, 50.0] and r["basis_pct"][0] == round(50 / 23150 * 100, 4)
    # T: 09:16 IST on 2 Nov to 15:40 IST on 25 Nov = 23 days + 6 h 24 min = 23.26667 days
    T = (23 * 86400 + 6 * 3600 + 24 * 60) / (365 * 86400)
    assert abs(r["carry_pct"][0] - math.log(23200 / 23150) / T * 100) < 1e-2
    assert abs(r["fair_basis"][0] - 23150 * (math.exp(0.06 * T) - 1)) < 1e-2
    assert abs(r["vs_fair"][0] - (50 - r["fair_basis"][0])) < 1e-2
    # OI change against the previous session's last OI of the same contract
    assert r["oi_baseline"] == {"kind": "previous session close", "value": 1_000_000, "day": "2026-10-30", "sessions_ago": 1}
    assert r["oi"] == [1_010_000, None] and r["oi_change"] == [10_000, None] and r["oi_per_min"] == [None, None]  # a missing OI stays missing
    assert r["volume"] == [50_000, 80_000] and r["volume_per_min"] == [None, 30_000]
    assert r["latest"]["basis"] == 50.0


def test_oi_baseline_falls_back_to_the_session_open_and_a_rolled_contract_is_not_compared(tmp_path: Path) -> None:
    m, o = MarketStore(tmp_path), ObservationStore(tmp_path)
    put(m, "2026-10-30T10:05:00+00:00", v=1, ltp=23100.0, spot=23050.0, oi=700_000, exp="2026-10-28", sym="OLD")  # another contract
    put(m, "2026-11-02T03:46:00+00:00", v=1, ltp=23200.0, spot=23150.0, oi=2_000_000, exp="2026-11-25", sym="NEW")
    put(m, "2026-11-02T03:47:00+00:00", v=2, ltp=23201.0, spot=23151.0, oi=2_005_000, exp="2026-11-25", sym="NEW")
    r = futures_series(m, o, "NIFTY", rate=0.06, now=NOW)
    assert r["oi_baseline"]["kind"] == "session open" and r["oi_change"] == [0, 5_000]


def test_without_a_recorded_index_level_the_nearest_snapshot_is_used_and_said(tmp_path: Path) -> None:
    m, o = MarketStore(tmp_path), ObservationStore(tmp_path)
    put(m, "2026-11-02T03:46:00+00:00", v=1, ltp=23200.0, oi=None, exp="2026-11-25", sym="F")
    r = futures_series(m, o, "NIFTY", rate=0.06, now=NOW)
    assert r["spot"] == [None] and r["basis"] == [None] and r["carry_pct"] == [None]  # no snapshot near: missing, not guessed
    assert any("Open interest was not supplied" in w for w in r["warnings"])


def test_endpoint_returns_the_series_and_an_empty_state(tmp_path: Path) -> None:
    with TestClient(make_app(tmp_path)) as c:
        r = c.get("/api/futures/series").json()
        assert r["times"] == [] and r["warnings"]
        c.app.state.market.store.record_sample("fut", datetime.now(UTC).replace(second=0, microsecond=0).isoformat(), {"v": 5, "ltp": 100.0, "spot": 99.0, "oi": 10, "exp": None, "sym": "X"})
        r = c.get("/api/futures/series").json()
        assert r["basis"] == [1.0] and r["oi"] == [10] and r["carry_pct"] == [None]  # no expiry recorded: no annualised carry


def test_stale_baseline_clock_and_oi_jump_warnings(tmp_path: Path) -> None:
    m, o = MarketStore(tmp_path), ObservationStore(tmp_path)
    put(m, "2026-11-03T10:00:00+00:00", v=1, ltp=23100.0, spot=23050.0, oi=1_445_000, exp="2026-11-23", sym="F")  # Tuesday
    put(m, "2026-11-09T04:00:00+00:00", v=1, ltp=23200.0, spot=23150.0, oi=1_375_000, exp="2026-11-23", sym="F")  # Monday 9:30 IST
    put(m, "2026-11-09T04:01:00+00:00", v=2, ltp=23201.0, spot=23151.0, oi=1_380_000, exp="2026-11-23", sym="F")  # +5,000 = 0.36 %
    put(m, "2026-11-09T04:02:00+00:00", v=3, ltp=23202.0, spot=23152.0, oi=1_300_000, exp="2026-11-23", sym="F")  # -80,000 = 5.8 %
    r = futures_series(m, o, "NIFTY", rate=0.06, day=date(2026, 11, 9), now=NOW)
    assert r["oi_baseline"]["sessions_ago"] == 4  # Wed, Thu, Fri, Mon
    assert r["oi_per_min"] == [None, 5_000, -80_000]
    ws = " ".join(r["warnings"])
    assert "4 weekdays before this day" in ws and "1 one-minute OI move" in ws
    # the test runs after 9 Nov 2026 or not: only assert the clock warning when the sample really is in the future
    future = datetime(2026, 11, 9, 4, 2, tzinfo=UTC) > datetime.now(UTC)
    assert ("later than this computer's clock" in ws) == future
