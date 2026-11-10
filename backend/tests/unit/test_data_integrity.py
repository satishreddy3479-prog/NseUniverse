"""Independent cross-checks of the numbers the pages show, on the real captured Kotak chains.

Each check recomputes a figure with separate code (own Black-76 formula, own parity, own skew) instead of calling the
function under test twice. A failure means a displayed figure no longer agrees with first principles.
"""

from __future__ import annotations

import math
from datetime import UTC, date, datetime, timedelta

import pytest

from app.intraday import volatility as volmod
from tests.unit.test_intraday import CALL, EXP, PUT, as_chain, real_chain

AT = datetime(2026, 10, 29, 5, 0, tzinfo=UTC)  # 10:30 IST, inside the session


def _n(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _b76(side: int, f: float, k: float, t: float, v: float, r: float) -> float:
    d1 = (math.log(f / k) + 0.5 * v * v * t) / (v * math.sqrt(t))
    d2 = d1 - v * math.sqrt(t)
    df = math.exp(-r * t)
    return df * (f * _n(d1) - k * _n(d2)) if side == CALL else df * (k * _n(-d2) - f * _n(-d1))


def _surface() -> tuple[dict[str, object], dict[tuple[float, int], float | None], float, float]:
    snap = real_chain(AT, "i1")
    prices = {k: q.ltp for k, q in as_chain(snap).items()}
    spot = snap.underlying_ltp
    out = volmod.surface(prices, spot, date.fromisoformat(EXP), AT)
    t = volmod.years_to_expiry(date.fromisoformat(EXP), AT)
    return out, prices, spot, t


def test_every_solved_iv_reprices_the_market_price_with_an_independent_formula() -> None:
    out, prices, _spot, t = _surface()
    assert out["status"] == "ok"
    f, r = float(out["forward"]), float(out["rate_assumed"])  # type: ignore[arg-type]
    checked = 0
    for row in out["rows"]:  # type: ignore[attr-defined]
        if row["iv"] is None:
            continue
        side = CALL if row["side"] == "CE" else PUT
        model = _b76(side, f, row["strike"], t, row["iv"] / 100, r)
        assert model == pytest.approx(prices[(row["strike"], side)], abs=0.05), row
        checked += 1
    assert checked >= 8


def test_forward_atm_strike_and_atm_iv_follow_from_the_chain() -> None:
    out, prices, spot, t = _surface()
    r = float(out["rate_assumed"])  # type: ignore[arg-type]
    ks = sorted({k for k, _ in prices})
    near = sorted(ks, key=lambda k: abs(k - spot))[:5]
    fs = sorted(k + math.exp(r * t) * (prices[(k, CALL)] - prices[(k, PUT)]) for k in near if prices.get((k, CALL)) and prices.get((k, PUT)))  # type: ignore[operator]
    assert float(out["forward"]) == pytest.approx(fs[len(fs) // 2], abs=3.0)  # a median of nearby parity forwards, never a single noisy pair
    atm = min(ks, key=lambda k: abs(k - float(out["forward"])))
    assert out["atm_strike"] == atm
    ivs = [row["iv"] for row in out["rows"] if row["strike"] == atm and row["iv"] is not None]  # type: ignore[attr-defined]
    assert out["atm_iv"] == pytest.approx(sum(ivs) / len(ivs), abs=0.002)


def test_skew_measures_follow_from_the_solved_rows() -> None:
    out, _p, _s, _t = _surface()
    rows = out["rows"]  # type: ignore[assignment]
    m = volmod.skew_metrics(rows, float(out["forward"]), float(out["atm_iv"]))  # type: ignore[arg-type]
    atm = out["atm_strike"]
    puts = [x for x in rows if x["side"] == "PE" and x["otm"] and x["delta"] is not None and x["iv"] is not None and x["strike"] < atm]  # type: ignore[attr-defined]
    calls = [x for x in rows if x["side"] == "CE" and x["otm"] and x["delta"] is not None and x["iv"] is not None and x["strike"] > atm]  # type: ignore[attr-defined]
    p25 = min(puts, key=lambda x: abs(abs(x["delta"]) - 0.25))
    c25 = min(calls, key=lambda x: abs(x["delta"] - 0.25))
    if abs(abs(p25["delta"]) - 0.25) <= 0.1 and abs(c25["delta"] - 0.25) <= 0.1:
        assert m["skew_25d"] == pytest.approx(p25["iv"] - c25["iv"], abs=0.002)
        assert m["butterfly_25d"] == pytest.approx((p25["iv"] + c25["iv"]) / 2 - float(out["atm_iv"]), abs=0.002)  # type: ignore[arg-type]
    else:
        assert m["skew_25d"] is None  # no contract near 25 delta: missing, not a number from a far strike


def test_time_to_expiry_runs_to_the_expiry_close_in_calendar_time() -> None:
    expiry = date.fromisoformat(EXP)
    t = volmod.years_to_expiry(expiry, AT)
    close = datetime(expiry.year, expiry.month, expiry.day, 10, 10, tzinfo=UTC)  # 15:40 IST: derivatives close since 3 Aug 2026 (app/domain/session.py)
    assert t == pytest.approx((close - AT).total_seconds() / (365 * 86400), rel=1e-6)
    assert volmod.years_to_expiry(expiry, AT + timedelta(days=30)) < 0  # past expiry is never a positive time


def test_expiries_report_the_latest_stored_session_of_each_expiry(tmp_path: object) -> None:
    from pathlib import Path

    from app.storage.observations import ObservationStore
    from tests.unit.test_intraday import ist, seed

    base = Path(str(tmp_path))
    times = [ist(9, 15) + timedelta(minutes=i) for i in range(12)]
    obs = seed(base / "a", times)  # 12 in-session samples of EXP on 2026-10-29
    assert isinstance(obs, ObservationStore)
    assert obs.last_session_by_expiry("NIFTY") == {EXP: "2026-10-29"}
    after = seed(base / "b", [ist(16, 30) + timedelta(minutes=i) for i in range(12)])  # only after hours
    assert after.last_session_by_expiry("NIFTY") == {}  # no session: the expiry is absent, not dated
    few = seed(base / "c", times[:5])
    assert few.last_session_by_expiry("NIFTY") == {}  # fewer than 10 samples is not a session


def test_an_exchange_holiday_of_stale_samples_is_not_a_session(tmp_path: object) -> None:
    from pathlib import Path

    from app.intraday.service import IntradayService
    from app.intraday.store import IntradayStore
    from app.prediction.flows_store import FlowsStore
    from app.prediction.history_store import HistoryStore
    from tests.unit.test_intraday import ist, seed

    base = Path(str(tmp_path))
    real = [ist(9, 15) + timedelta(minutes=i) for i in range(12)]  # a real session, 29 Oct
    obs = seed(base, real)
    holiday = ist(9, 15) + timedelta(days=12)  # 10 Nov: three samples, then the same chain flagged unchanged
    for n in range(15):
        obs.record_snapshot(real_chain(holiday + timedelta(minutes=n), f"h{n}"), unchanged=n >= 3)
    counts = obs.session_sample_counts("NIFTY")
    assert counts[holiday.date().isoformat()] == 3 and counts["2026-10-29"] == 12  # only changed samples count
    assert holiday.date().isoformat() not in obs.last_session_by_expiry("NIFTY").get(EXP, "")
    svc = IntradayService(obs, HistoryStore(base), FlowsStore(base), IntradayStore(base), clock=lambda: (holiday + timedelta(hours=7)).astimezone(UTC))
    assert svc.iv_sessions() == ["2026-10-29"]  # the holiday is not offered, and gives no provisional bar for the IV charts
