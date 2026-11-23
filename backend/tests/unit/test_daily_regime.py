"""Daily regime: the readings are hand calculations (the same numbers as the frontend's trend-stats tests), the label rule and the study's mechanics."""

from __future__ import annotations

import math
import random
from datetime import date, timedelta

import pytest

from app.intraday import regime as rg
from app.prediction.targets import Bar


def bar(d: int, h: float, low: float, c: float) -> Bar:
    o = (h + low) / 2
    return Bar(date(2026, 1, 1) + timedelta(days=d), o, h, low, c)


def test_efficiency_ratio_and_regression_by_hand() -> None:
    assert rg.efficiency_ratio([100, 102, 101, 105, 104]) == 0.5  # net 4 over a path of 2 + 1 + 4 + 1
    assert rg.efficiency_ratio([5, 5, 5]) is None
    slope, r2 = rg.regression([1, 2, 4, 3, 5]) or (0, 0)  # Sxy 9, Sxx 10, Syy 10
    assert slope == pytest.approx(0.9) and r2 == pytest.approx(0.81)
    assert (rg.regression([3, 3, 3]) or (0, 0))[1] is None


def test_wilder_adx_with_n_2_matches_the_hand_values() -> None:
    b = [bar(0, 10, 8, 9), bar(1, 12, 9, 11), bar(2, 13, 10, 12), bar(3, 12, 9, 10), bar(4, 14, 11, 13)]
    r = rg.adx_series(b, 2)
    assert r[2][0] == pytest.approx(50) and r[2][1] == pytest.approx(0) and r[2][2] is None
    assert r[3][2] == pytest.approx(60)  # first ADX: mean of DX 100 and 20
    assert r[4][0] == pytest.approx(39.2857, abs=1e-3) and r[4][1] == pytest.approx(7.1429, abs=1e-3)
    assert r[4][2] == pytest.approx(64.6154, abs=1e-3)


def test_choppiness_by_hand() -> None:
    b = [bar(0, 10, 8, 9), bar(1, 12, 9, 11), bar(2, 13, 10, 12)]
    assert rg.choppiness(b) == pytest.approx(100 * math.log10(1.5) / math.log10(2), abs=1e-9)  # TR 3 + 3 over a range of 13 - 9 = 4


def test_dwell_and_the_label_rule() -> None:
    assert rg.apply_dwell(list("AABBABBB")) == list("AAAAAAAB")
    assert rg.classify(0.5, 30, 30, 10, 0.8, 1.0, 30)[0] == "Trending up"
    assert rg.classify(0.5, 30, 10, 30, 0.8, -1.0, 30)[0] == "Trending down"
    assert rg.classify(0.5, 30, 10, 30, 0.8, 1.0, 30)[0] == "Unclear"  # slope against the DI lines
    assert rg.classify(0.1, 15, 20, 20, 0.1, 0.1, 70)[0] == "Range-bound"
    assert rg.classify(0.9, None, None, None, 0.9, 1.0, None)[0] == "Warming up"  # two readings only


def _walk(n: int, seed: int) -> list[Bar]:
    rnd = random.Random(seed)
    price, out = 100.0, []
    for i in range(n):
        o = price
        price *= math.exp(rnd.gauss(0, 0.01))
        out.append(Bar(date(2020, 1, 1) + timedelta(days=i), o, max(o, price) * 1.001, min(o, price) * 0.999, price))
    return out


def test_the_study_uses_only_every_horizon_th_day_and_reports_a_failed_claim_as_failed() -> None:
    bars = _walk(1500, 7)
    rows = rg.label_series(bars)
    st = rg.study(bars, rows)
    first = rg.WINDOW + 2 * rg.ADX_N
    assert st["samples"] == len(range(first, len(bars) - rg.HORIZON, rg.HORIZON)) - sum(1 for i in range(first, len(bars) - rg.HORIZON, rg.HORIZON) if rows[i]["label"] == "Warming up")
    assert st["claim"]["validated"] is (
        st["claim"]["diff_forward_er"] is not None and st["claim"]["diff_forward_er"] > 0 and st["claim"]["p_value"] < 0.05 and all(t["diff"] > 0 for t in st["claim"]["thirds"])
    )
    assert st == rg.study(bars, rows)  # fixed seed: the same answer every time
    assert len(st["claim"]["thirds"]) == 3


def test_only_data_up_to_a_day_decides_that_days_label() -> None:
    bars = _walk(400, 3)
    full = rg.label_series(bars)
    cut = rg.label_series(bars[:300])
    assert [r["raw"] for r in full[:300]] == [r["raw"] for r in cut]  # no look-ahead


def test_too_few_bars_is_stated() -> None:
    assert rg.daily_regime(_walk(50, 1), date(2026, 1, 1))["status"].startswith("not computed")
