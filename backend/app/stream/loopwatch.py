"""Watches the asyncio event loop for stalls (a callback that holds it, or threads that starve it).

The broker feed, the browser sockets and every HTTP answer run on one loop on a one-core server.
A stall there delays them all, and a stall of 20 s would make the broker feed miss its keep-
alive ping and drop. A ticker on the loop records how late it runs; a separate thread notices
when the ticker has not run for a while and logs what the loop thread was doing at that moment,
so the cause is named instead of guessed.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import sys
import threading
import time
import traceback
from collections import Counter, deque
from typing import Any

logger = logging.getLogger(__name__)
TICK_S = 0.25
STALL_LOG_S = 1.0  # a loop that has not run for this long is logged with its stack


class LoopWatch:
    def __init__(self, window_s: float = 300.0) -> None:
        self._window = window_s
        self._lags: deque[tuple[float, float]] = deque()  # (monotonic time, lag seconds)
        self._beat = time.monotonic()
        self._loop_thread: int | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._task: asyncio.Task[None] | None = None
        self.stalls = 0
        # what the loop thread was doing, sampled 10 times a second: two buckets of 150 s, swapped
        self._cur: Counter[str] = Counter()
        self._prev: Counter[str] = Counter()
        self._bucket_at = time.monotonic()
        self.last_stall: dict[str, Any] | None = None

    def start(self) -> None:
        self._loop_thread = threading.get_ident()
        self._task = asyncio.get_running_loop().create_task(self._tick())
        self._thread = threading.Thread(target=self._watch, name="loop-watch", daemon=True)
        self._thread.start()

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _tick(self) -> None:
        last = time.monotonic()
        while True:
            await asyncio.sleep(TICK_S)
            now = time.monotonic()
            self._beat = now
            self._lags.append((now, max(0.0, now - last - TICK_S)))
            last = now
            while self._lags and now - self._lags[0][0] > self._window:
                self._lags.popleft()

    def _watch(self) -> None:
        reported = 0.0
        while not self._stop.wait(0.1):
            self._sample()
            behind = time.monotonic() - self._beat
            if behind < STALL_LOG_S:
                reported = 0.0
                continue
            if behind - reported < 5.0 and reported:
                continue  # one report per stall, then again every 5 s while it lasts
            reported = behind
            frame = sys._current_frames().get(self._loop_thread or 0)  # noqa: SLF001
            where = traceback.format_stack(frame, limit=6) if frame else []
            self.stalls += 1
            others = self._others()
            self.last_stall = {
                "behind_s": round(behind, 2),
                "at": time.time(),
                "stack": [w.strip() for w in where[-4:]],
                "others": others,
            }
            logger.warning(
                "event_loop_stall",
                extra={"fields": {"behind_s": round(behind, 2), "stack": self.last_stall["stack"], "others": others}},
            )

    def _others(self) -> list[str]:
        """What every other thread is doing at the moment of a stall (27 Nov 2026: stalls of a second at the open with the loop thread itself busy in the feed's decoder: the cause was
        another thread holding the CPU or the interpreter lock, and the loop's own stack cannot show which). The innermost frame of this application's code in each thread."""
        names = {t.ident: t.name for t in threading.enumerate()}
        out: list[str] = []
        for ident, frame in sys._current_frames().items():  # noqa: SLF001
            if ident in (self._loop_thread, threading.get_ident()):
                continue
            f: Any = frame
            mine = None
            while f is not None and mine is None:
                if "/app/" in f.f_code.co_filename.replace("\\", "/"):
                    mine = f
                f = f.f_back
            inner = frame.f_code
            if inner.co_name in ("wait", "_wait_for_tstate_lock", "select", "poll", "_poll", "get", "acquire") and mine is None:
                continue  # parked, not working
            where = self._label(mine) if mine is not None else f"{inner.co_filename.replace(chr(92), '/').rsplit('/', 1)[-1]}:{inner.co_name}"
            out.append(f"{names.get(ident, ident)}: {where} (in {inner.co_name})")
        return out[:8]

    def _sample(self) -> None:
        inner: Any = sys._current_frames().get(self._loop_thread or 0)  # noqa: SLF001
        if inner is None:
            return
        mine = None  # the nearest frame of this application's own code
        f = inner
        while f is not None and mine is None:
            if "/app/" in f.f_code.co_filename.replace("\\", "/"):
                mine = f
            f = f.f_back
        code = inner.f_code
        where = code.co_filename
        idle = (
            code.co_name in ("select", "poll", "_poll")
            or "selectors" in where
            or "windows_events" in where
        )
        label = "idle (waiting)" if idle else self._label(mine or inner)
        now = time.monotonic()
        if now - self._bucket_at > 150.0:
            self._prev, self._cur, self._bucket_at = self._cur, Counter(), now
        self._cur[label] += 1

    @staticmethod
    def _label(f: Any) -> str:
        name = f.f_code.co_filename.replace("\\", "/").rsplit("/app/", 1)[-1]
        return f"{name}:{f.f_code.co_name}"

    def busy(self, top: int = 12) -> dict[str, Any]:
        """Share of the last 2.5-5 minutes the loop thread spent in each place."""
        both = self._cur + self._prev
        total = sum(both.values())
        rows = [
            {"where": k, "share_pct": round(v / total * 100, 1)} for k, v in both.most_common(top)
        ]
        return {"samples": total, "top": rows}

    def stats(self) -> dict[str, Any]:
        now = time.monotonic()
        lags = sorted(lag for t, lag in self._lags if now - t <= 60.0)
        n = len(lags)
        return {
            "lag_ms_p99_60s": round(lags[int(n * 0.99)] * 1000, 1) if n else None,
            "lag_ms_max_60s": round(lags[-1] * 1000, 1) if n else None,
            "lag_ms_max_5min": round(max((lag for _, lag in self._lags), default=0.0) * 1000, 1),
            "stalls": self.stalls,
            "last_stall": self.last_stall,
            "busy": self.busy(),
        }
