"""The server's stop, target, trail, re-entry and strategy rules must give exactly the browser's results.

``backend/tests/fixtures/strategy_parity.json`` holds 300 generated strategies (legs, live prices, strategy rules) with the
result of one automation pass. This test regenerates them with the server code and fails if the file is out of date; the
frontend test ``strategy-parity.test.ts`` runs the same file through the browser code. Set ``NSE_REGEN_PARITY=1`` to rewrite it.
It also checks the properties that stop a rule firing twice: a second pass over the same prices does nothing, a closed leg with
no re-entry left never re-opens, and a fired strategy rule closes every leg for good.
"""

from __future__ import annotations

import json
import os
import random
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.strategy.automation import apply_automation, apply_strategy_rules, is_exited

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "strategy_parity.json"
AT = datetime(2026, 11, 6, 5, 0, tzinfo=UTC)
LOT = 65
FIELDS = ("premium", "stop", "stopBase", "stopTrailed", "target", "exitPrice", "exitReason", "realised", "reentry", "reentryLevel", "cycles", "stopPct", "targetPct")


def tick(v: float) -> float:
    return max(0.05, round(v * 20) / 20)


def make_cases() -> list[dict[str, Any]]:
    rnd = random.Random(20261106)
    cases = []
    for i in range(300):
        legs = []
        for j in range(rnd.randint(1, 4)):
            action = rnd.choice(["BUY", "SELL"])
            prem = tick(rnd.uniform(20, 300))
            sell = action == "SELL"
            leg: dict[str, Any] = {
                "id": f"l{i}-{j}", "key": f"k{i}-{j}", "expiry": "2026-11-09", "strike": 24000 + 50 * rnd.randint(0, 20), "type": rnd.choice(["CE", "PE"]),
                "action": action, "lots": rnd.randint(1, 3), "premium": prem, "premiumSource": "manual",
                "stop": tick(prem * (1 + rnd.choice([0.2, 0.3, 0.5]) * (1 if sell else -1))) if rnd.random() < 0.8 else None,
                "target": tick(prem * (1 - rnd.choice([0.3, 0.5]) * (1 if sell else -1))) if rnd.random() < 0.5 else None,
                "reentry": rnd.choice([0, 0, 1, 2]),
            }
            if rnd.random() < 0.3:
                leg.update(trailEvery=rnd.choice([10, 20]), trailBy=rnd.choice([5, 10]))
                if leg["trailBy"] > leg["trailEvery"]:
                    leg["trailBy"] = leg["trailEvery"]
            if rnd.random() < 0.2:
                reason = rnd.choice(["stop", "target"])
                leg.update(exitPrice=tick(prem * rnd.uniform(0.5, 1.6)), exitReason=reason, realised=round((rnd.random() - 0.5) * 8000, 2), reentryLevel=prem if reason == "stop" else None)
            legs.append(leg)
        prices = {f"{lg['strike']}{lg['type']}": (None if rnd.random() < 0.08 else tick(lg["premium"] * rnd.uniform(0.3, 2.4))) for lg in legs}
        rules = {k: v for k, v in (("sl", rnd.choice([None, 3000, 8000])), ("target", rnd.choice([None, 2000, 6000])), ("lockAt", None), ("lockProfit", None), ("trailEvery", None), ("trailBy", None))}
        if rnd.random() < 0.4:
            rules.update(lockAt=rnd.choice([2000, 4000]), lockProfit=rnd.choice([500, 1000]))
            if rnd.random() < 0.5:
                rules.update(trailEvery=rnd.choice([1000, 2000]), trailBy=rnd.choice([250, 500]))
        state = {"floor": rnd.choice([None, None, 600.0]), "done": None}
        cases.append({"legs": legs, "prices": prices, "rules": rules, "state": state, "mult": rnd.choice([1, 1, 2])})
    return cases


def run(case: dict[str, Any]) -> dict[str, Any]:
    price = lambda lg: case["prices"].get(f"{lg['strike']}{lg['type']}")  # noqa: E731
    legs1, ev1 = apply_automation(case["legs"], price, LOT, AT, case["mult"])
    legs2, state2, ev2 = apply_strategy_rules(legs1, case["rules"], case["state"], price, LOT, AT, case["mult"])
    pick = lambda legs: [{k: lg.get(k) for k in FIELDS} for lg in legs]  # noqa: E731
    return {"legs": pick(legs2), "events": len(ev1) + len(ev2), "state": {"floor": state2.get("floor"), "done": state2.get("done")}}


def build() -> list[dict[str, Any]]:
    out = []
    for c in make_cases():
        out.append({**c, "expected": run(c)})
    return out


def test_fixture_is_current_and_the_server_reproduces_it() -> None:
    built = json.loads(json.dumps(build()))
    if os.environ.get("NSE_REGEN_PARITY") == "1":
        FIXTURE.write_text(json.dumps(built, indent=0), encoding="utf-8")
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == built


def test_a_second_pass_over_the_same_prices_changes_nothing_except_a_permitted_re_entry() -> None:
    fired = 0
    for c in make_cases():
        price = lambda lg, c=c: c["prices"].get(f"{lg['strike']}{lg['type']}")  # noqa: E731
        legs1, _ = apply_automation(c["legs"], price, LOT, AT, c["mult"])
        legs2, st, _ = apply_strategy_rules(legs1, c["rules"], c["state"], price, LOT, AT, c["mult"])
        legs3, _ = apply_automation(legs2, price, LOT, AT, c["mult"])
        for before, after in zip(legs2, legs3, strict=True):
            if before != after:  # the only thing a repeat may do: enter a stopped leg again, once, while re-entries are left
                assert is_exited(before) and not is_exited(after)
                assert before.get("exitReason") == "stop" and (before.get("reentry") or 0) > 0 and after.get("reentry") == before["reentry"] - 1
        if st.get("done"):
            fired += 1
            assert all(not (is_exited(a) and not is_exited(b)) for a, b in zip(legs2, legs3, strict=True)), "after a strategy rule nothing re-enters"
            legs4, st4, ev4 = apply_strategy_rules(legs3, c["rules"], st, price, LOT, AT, c["mult"])
            assert (legs4, st4, ev4) == (legs3, st, []), "a fired strategy rule does not fire again"
    assert fired > 20  # the generator does exercise strategy-level rules
