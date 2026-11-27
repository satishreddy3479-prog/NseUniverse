"""The server's port of the Session Structure tab (TWAP crossings, distance) and its exposure through the trend group. Hand-calculated and checked against the page's figures on the real bars of 23 Nov 2026. (The seller score does not use it: D346.)"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.intelligence import fusion as fz
from app.intelligence import trend_engine as te

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "index_bars_2026-11-23.json"


def test_the_session_structure_of_a_small_set_of_closes_by_hand() -> None:
    closes = [100.0, 102.0, 101.0, 99.0, 100.0, 103.0]
    # running means: 100, 101, 101, 100.5, 100.4, 100.8333; sides (close vs mean): 0, +1, 0 (101 = 101), -1, -1, +1
    s = te.session_structure(closes)
    assert s is not None
    assert s["n"] == 6 and s["pct_above"] == pytest.approx(33.3, abs=0.05)  # 2 of 6 above
    assert s["crossings"] == 2  # +1 -> -1 and -1 -> +1 (the equal-to-mean bars are skipped)
    assert s["longest_run"] == 2 and s["run_side"] == -1  # the two bars below
    assert s["distance"] == pytest.approx(103 - 605 / 6, abs=0.005)  # 2.17
    assert te.session_structure([100.0]) is None


def test_the_structure_of_the_real_trend_day_matches_the_page() -> None:
    """23 Nov 2026 (NIFTY fell about 565 points): the Session Structure tab showed the close 163.1 points below its session mean, never above it."""
    real = json.loads(FIXTURE.read_text(encoding="utf-8"))
    a = te.assess(real["bars"])
    st = a["structure"]
    assert st["n"] == 72 and st["pct_above"] == 0.0 and st["crossings"] == 0 and st["longest_run"] == 71 and st["run_side"] == -1
    assert st["distance"] == pytest.approx(-163.14, abs=0.01)
    group = fz.trend_group({"trend": {**a, "is_today": True}}, {})
    exposed = group["structure"]
    assert exposed["crossings"] == 0 and exposed["atr"] == pytest.approx(25.32) and exposed["distance_atr"] == pytest.approx(-163.14 / 25.32, abs=0.01)  # -6.44 ATR
    assert fz.trend_group({"trend": {**a, "is_today": False, "day": "2026-11-23"}}, {})["structure"] is None  # an earlier session is no evidence for today
