# ruff: noqa: E501
"""Server-side GEX against the browser's, on the SAME snapshot.

``tests/fixtures/gex_parity.json`` holds one real captured NIFTY chain (rows with last price and open interest, spot, expiry, time) and
the server's reconstruction of it (``app/intraday/gex_history.py``). This test regenerates the server half and fails if the file is stale
(``NSE_REGEN_GEX=1`` rewrites it); the frontend test ``gex-parity.test.ts`` runs the browser's ``gexProfile`` / ``gexLevels`` on the same
rows and compares. Differences, and why they exist, are documented in docs/market-intelligence-audit.md.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from app.intraday import gex_history as gx
from app.intraday import volatility as vm
from tests.unit.test_intraday import EXP, as_chain, ist, real_chain

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "gex_parity.json"
RATE = 0.06


def build() -> dict[str, Any]:
    at = ist(10, 0)
    snap = real_chain(at.astimezone(vm.IST), "gex-parity", EXP)
    spot = float(snap.underlying_ltp or 0)
    chain = as_chain(snap)
    prices = {k: v.ltp for k, v in chain.items()}
    from datetime import date

    exp_d = date.fromisoformat(EXP)
    sf = vm.surface(prices, spot, exp_d, at, RATE, 400)
    assert sf["status"] == "ok"
    t = vm.years_to_expiry(exp_d, at)
    ks = sorted({k for k, _ in chain})
    opening = min(ks, key=lambda k: (abs(k - spot), k))
    out = gx.reconstruct(sf["rows"], chain, spot, float(sf["forward"]), t, RATE, opening)
    rows = [{"strike": r.strike, "call": None if (c := chain.get((r.strike, 0))) is None else {"ltp": c.ltp, "oi": c.oi},
             "put": None if (p := chain.get((r.strike, 1))) is None else {"ltp": p.ltp, "oi": p.oi}} for r in snap.rows]
    return {
        "at": at.isoformat(), "expiry": EXP, "spot": spot, "rate": RATE, "forward": sf["forward"], "forward_source": sf["forward_source"], "rows": rows,
        "server": {k: (None if v is None else {a: (round(b, 6) if isinstance(b, float) else b) for a, b in v.items()}) for k, v in out["universes"].items()},
        "missing": out["missing"],
    }


def test_fixture_is_current_and_the_server_reproduces_it() -> None:
    built = json.loads(json.dumps(build()))
    if os.environ.get("NSE_REGEN_GEX") == "1":
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(json.dumps(built, indent=1), encoding="utf-8")
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == built


def test_the_fixture_is_a_real_chain_with_exposure_on_both_sides() -> None:
    d = json.loads(FIXTURE.read_text(encoding="utf-8"))
    full = d["server"]["full"]
    assert len(d["rows"]) > 30 and full["used"] > 20 and full["ce"] > 0 and full["pe"] < 0
    # net and absolute count only strikes with an exposure on both sides, while the CE and PE totals count every strike with one: they differ by design
    assert full["used"] < full["strikes"] and abs(full["net"]) < full["abs"]
