"""LiveBook: latest tick per instrument, plus coalescing for broadcast."""

from __future__ import annotations

from app.stream.models import LiveTick


class LiveBook:
    def __init__(self) -> None:
        self._ticks: dict[str, LiveTick] = {}
        self._pending: dict[str, LiveTick] = {}
        self._seq = 0
        self.tick_count = 0

    @staticmethod
    def _same(a: LiveTick, b: LiveTick) -> bool:
        ignore = {"received_at", "seq"}
        return a.model_dump(exclude=ignore) == b.model_dump(exclude=ignore)

    def update(self, tick: LiveTick) -> LiveTick | None:
        """Store the tick; return it, or None if it is an exact repeat of the stored one."""
        prev = self._ticks.get(tick.key)
        if prev is not None and self._same(prev, tick):
            return None
        self._seq += 1
        tick = tick.model_copy(update={"seq": self._seq})
        self._ticks[tick.key] = tick
        self._pending[tick.key] = tick  # keep only the latest per key between flushes
        self.tick_count += 1
        return tick

    def drain_pending(self) -> list[LiveTick]:
        out = list(self._pending.values())
        self._pending.clear()
        return out

    def snapshot(self) -> list[LiveTick]:
        return list(self._ticks.values())

    def get(self, key: str) -> LiveTick | None:
        return self._ticks.get(key)

    def __len__(self) -> int:
        return len(self._ticks)

    def clear(self) -> None:
        self._ticks.clear()
        self._pending.clear()
