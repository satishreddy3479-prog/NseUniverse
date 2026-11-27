"""The slow-answer cache serves an expired answer at once and rebuilds it behind the request."""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime
from pathlib import Path

from app.api import routes


def test_an_expired_answer_is_served_at_once_and_replaced_in_the_background() -> None:
    key = "test-swr"
    routes._ttl_cache.pop(key, None)
    gate = threading.Event()
    calls: list[int] = []

    def build() -> str:
        calls.append(1)
        if len(calls) > 1:
            gate.wait(5)
        return f"v{len(calls)}"

    assert routes._cached(key, 0.0, build) == "v1"  # first call waits for the build
    t0 = time.perf_counter()
    assert routes._cached(key, 0.0, build) == "v1"  # expired: the old answer, not the 5 s wait
    assert time.perf_counter() - t0 < 1.0
    assert routes._cached(key, 0.0, build) == "v1" and len(calls) == 2  # one rebuild at a time
    gate.set()
    end = time.time() + 3
    while routes._ttl_cache[key][1] != "v2" and time.time() < end:
        time.sleep(0.01)
    assert routes._ttl_cache[key][1] == "v2"


def test_an_expired_intelligence_input_is_answered_from_the_stored_one_and_recomputed_behind(
    tmp_path,
) -> None:  # type: ignore[no-untyped-def]
    from datetime import UTC, datetime

    from app.intelligence.service import TTL, MarketIntelligence
    from app.intelligence.store import IntelligenceStore

    gate = threading.Event()
    calls: list[int] = []

    def slow() -> dict[str, int]:
        calls.append(1)
        if len(calls) > 1:
            gate.wait(5)
        return {"n": len(calls)}

    now = datetime(2026, 11, 25, 5, 0, tzinfo=UTC)
    svc = MarketIntelligence(
        providers={"vix": slow},
        store=IntelligenceStore(tmp_path / "i.db"),
        default_expiry=lambda: None,
        clock=lambda: now,
    )
    svc.background_refresh = True
    assert svc._get("vix", None, now)[0] == {"n": 1}  # noqa: SLF001 - nothing stored yet: computed in the call
    svc._cache[("vix", "")] = (time.monotonic() - TTL["vix"] - 1, *svc._cache[("vix", "")][1:])  # noqa: SLF001
    t0 = time.perf_counter()
    assert svc._get("vix", None, now)[0] == {"n": 1}  # noqa: SLF001 - expired: the stored one, no wait
    assert time.perf_counter() - t0 < 1.0
    svc._get("vix", None, now)  # noqa: SLF001
    wait_until = time.time() + 2
    while len(calls) < 2 and time.time() < wait_until:  # the recompute is queued on the worker
        time.sleep(0.01)
    assert len(calls) == 2  # one recompute at a time
    gate.set()
    end = time.time() + 3
    while svc._cache[("vix", "")][1] != {"n": 2} and time.time() < end:  # noqa: SLF001
        time.sleep(0.01)
    assert svc._cache[("vix", "")][1] == {"n": 2}  # noqa: SLF001


def test_expired_inputs_refresh_one_at_a_time(tmp_path: Path) -> None:
    """27 Nov 2026: seven panel refreshes ran in parallel on one core and starved the feed loop."""
    from app.intelligence.service import TTL, MarketIntelligence
    from app.intelligence.store import IntelligenceStore

    running = 0
    peak = 0
    lock = threading.Lock()
    done = threading.Event()
    finished: list[str] = []

    def make(name: str):  # type: ignore[no-untyped-def]
        def provider() -> dict[str, str]:
            nonlocal running, peak
            with lock:
                running += 1
                peak = max(peak, running)
            time.sleep(0.05)
            with lock:
                running -= 1
                finished.append(name)
                if len(finished) >= 3 * 2:
                    done.set()
            return {"n": name}

        return provider

    names = ["vix", "flow", "futures"]
    now = datetime(2026, 11, 25, 5, 0, tzinfo=UTC)
    svc = MarketIntelligence(
        providers={n: make(n) for n in names},
        store=IntelligenceStore(tmp_path / "i.db"),
        default_expiry=lambda: None,
        clock=lambda: now,
    )
    svc.background_refresh = True
    for n in names:
        svc._get(n, None, now)  # noqa: SLF001 - first read computes in the call
    for n in names:
        svc._cache[(n, "")] = (time.monotonic() - TTL[n] - 1, *svc._cache[(n, "")][1:])  # noqa: SLF001
    for n in names:
        svc._get(n, None, now)  # noqa: SLF001 - expired: stored answer now, recompute queued
    assert done.wait(5)
    assert peak == 1
