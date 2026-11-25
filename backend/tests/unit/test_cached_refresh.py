"""The slow-answer cache serves an expired answer at once and rebuilds it behind the request."""

from __future__ import annotations

import threading
import time

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
