# ruff: noqa: E501
"""Strike positioning: classification, changes, baskets, premium asymmetry and the demand rules, on hand-calculated numbers."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.intraday import strike_positioning as sp

CALL, PUT = 0, 1


@dataclass
class C:
    ltp: float | None
    oi: int | None
    oi_prev: int | None
    volume: int | None


def surf(rows: list[tuple[float, str, float, float]], atm: float) -> dict[str, object]:
    return {"status": "ok", "atm_strike": atm, "rows": [{"strike": k, "side": s, "iv": iv, "delta": d} for k, s, iv, d in rows]}


def test_classification_follows_the_premium_and_oi_direction_and_ignores_tiny_moves() -> None:
    assert sp.classify(5.0, 3.0) == "potential long buildup"
    assert sp.classify(-5.0, 3.0) == "potential short buildup"
    assert sp.classify(5.0, -3.0) == "potential short covering"
    assert sp.classify(-5.0, -3.0) == "potential long unwinding"
    assert sp.classify(0.2, 3.0) == "no clear change" and sp.classify(5.0, -0.1) == "no clear change"
    assert sp.classify(None, 3.0) == "insufficient data"


def test_strike_table_changes_by_hand() -> None:
    now = {(24000.0, CALL): C(120.0, 110_000, 100_000, 5000), (24000.0, PUT): C(80.0, 90_000, 95_000, 4000)}
    then = {(24000.0, CALL): C(100.0, 100_000, 100_000, 3000), (24000.0, PUT): C(100.0, 95_000, 95_000, 2500)}
    sn = surf([(24000.0, "CE", 15.0, 0.52), (24000.0, "PE", 16.0, -0.48)], 24000.0)
    st = surf([(24000.0, "CE", 14.0, 0.5), (24000.0, "PE", 17.0, -0.5)], 24000.0)
    [row] = sp.strike_table(now, then, sn, st)
    ce, pe = row["ce"], row["pe"]
    assert (ce["premium_change"], ce["premium_pct"]) == (20.0, 20.0)  # 120 - 100; 120 / 100 - 1
    assert (ce["oi_change"], ce["oi_pct"], ce["oi_session_change"]) == (10_000, 10.0, 10_000)
    assert ce["volume_change"] == 2000 and ce["iv_change"] == 1.0 and ce["class"] == "potential long buildup"
    assert (pe["premium_pct"], pe["oi_pct"], pe["iv_change"]) == (-20.0, pytest.approx(-5.2632, abs=1e-3), -1.0)
    assert pe["class"] == "potential long unwinding" and pe["oi_session_change"] == -5000


def test_missing_values_stay_missing() -> None:
    now = {(24000.0, CALL): C(None, 1000, None, None)}
    [row] = sp.strike_table(now, {(24000.0, CALL): C(100.0, 900, 900, 10)}, None, None)
    assert row["ce"]["premium_pct"] is None and row["ce"]["oi_session_change"] is None and row["ce"]["class"] == "insufficient data"
    assert row["pe"]["premium"] is None


def chain(prem: dict[float, tuple[float, float]]) -> dict[tuple[float, int], C]:
    out: dict[tuple[float, int], C] = {}
    for k, (ce, pe) in prem.items():
        out[(k, CALL)], out[(k, PUT)] = C(ce, 1, 1, 1), C(pe, 1, 1, 1)
    return out


def test_fixed_and_dynamic_baskets_and_the_asymmetry_ratio() -> None:
    # strikes 100..140; ATM at then = 120, ATM now = 130
    then = chain({100: (30, 1), 110: (22, 3), 120: (15, 8), 130: (9, 14), 140: (5, 21)})
    now = chain({100: (33, 1), 110: (24, 2), 120: (17, 5), 130: (11, 9), 140: (6, 15)})
    rows = sp.baskets(now, then, 130.0, 120.0, windows=(1,))
    fixed = next(r for r in rows if r["kind"] == "fixed")
    dyn = next(r for r in rows if r["kind"] == "dynamic")
    # fixed: strikes 110,120,130 (ATM then +-1): CE 24+17+11 = 52 vs 22+15+9 = 46 -> +6; PE 2+5+9 = 16 vs 3+8+14 = 25 -> -9
    assert fixed["ce"]["now"] == 52 and fixed["ce"]["then"] == 46 and fixed["ce"]["change"] == 6
    assert fixed["pe"]["change"] == -9 and fixed["asymmetry"]["ratio"] == pytest.approx(1.5)  # |-9| / |6|
    # dynamic: now-side basket re-centred on 130 (120,130,140), like for like at both times: CE 17+11+6 = 34 vs 15+9+5 = 29
    assert dyn["ce"]["now"] == 34 and dyn["ce"]["then"] == 29 and dyn["ce"]["pct"] == pytest.approx(17.2414, abs=1e-3)
    assert fixed["strikes"] != 0 and fixed["kind"] != dyn["kind"]


def test_asymmetry_is_missing_for_a_zero_or_insignificant_denominator() -> None:
    assert sp.asymmetry({"change": 0.0, "then": 100.0}, {"change": -5.0})["ratio"] is None
    assert sp.asymmetry({"change": 0.1, "then": 100.0}, {"change": -5.0})["ratio"] is None  # 0.1 < 0.2 % of 100
    assert sp.asymmetry({"change": None, "then": 100.0}, {"change": -5.0})["ratio"] is None
    assert sp.asymmetry({"change": 2.0, "then": 100.0}, {"change": -5.0})["ratio"] == 2.5


def test_demand_needs_enough_evidence_and_names_what_it_rests_on() -> None:
    # near OTM puts: premium up 30 %, IV up, OI up, volume up, NIFTY down 0.3 % -> downside speculation
    def row(k: float, ce: dict[str, float | None], pe: dict[str, float | None]) -> dict[str, object]:
        base = {"premium": 10.0, "premium_then": 10.0, "oi": 100, "oi_then": 100, "volume_change": 0, "iv_change": 0.0, "delta": None}
        return {"strike": k, "ce": {**base, **ce}, "pe": {**base, **pe}}

    up = {"premium": 13.0, "oi": 130, "volume_change": 500, "iv_change": 1.2}
    rows = [row(23900.0, {"delta": 0.4}, {**up, "delta": -0.3}), row(23800.0, {"delta": 0.3}, {**up, "delta": -0.2})]
    out = {(d["side"], d["group"]): d for d in sp.demand(rows, 24000.0, -0.3)}
    pe = out[("PE", "otm")]
    assert pe["label"] == "Downside speculation" and pe["evidence"]["score"] == 5 and "NIFTY falling" in pe["evidence"]["met"]
    assert out[("CE", "otm")]["label"] == "INSUFFICIENT EVIDENCE"  # call strikes are not out of the money here: nothing to judge
    assert out[("PE", "deep")]["label"] == "INSUFFICIENT EVIDENCE" and out[("PE", "deep")]["summary"]["strikes"] == 0
