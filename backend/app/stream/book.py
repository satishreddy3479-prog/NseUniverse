"""LiveBook: latest tick per instrument, plus coalescing for broadcast."""

from __future__ import annotations

from app.stream.models import LiveTick


class LiveBook:
    def __init__(self) -> None:
        self._ticks: dict[str, LiveTick] = {}
        self._pending: dict[str, LiveTick] = {}
        self._seq = 0
        self.tick_count = 0
        # breadth stocks: kept for the analysis, never broadcast to browsers, never counted as
        # option-feed activity
        self.internal_keys: set[str] = set()
        self._internal: dict[str, LiveTick] = {}
        # a server-side contract the browser is also shown live (the NIFTY future),
        # kept apart from the option feed so it never counts as option-feed activity
        self._public: dict[str, LiveTick] = {}

    @staticmethod
    def _same(a: LiveTick, b: LiveTick) -> bool:
        ignore = {"received_at", "seq"}
        return a.model_dump(exclude=ignore) == b.model_dump(exclude=ignore)

    def update(self, tick: LiveTick) -> LiveTick | None:
        """Store the tick; return it, or None if it is an exact repeat of the stored one.

        A repeat is not broadcast again, but it is a message from the feed: the stored tick's
        receive time moves to it. Without that, an instrument whose value did not change looked
        silent to everything that asks how old its tick is (the one-minute index bars, the minute
        samples), exactly as if the feed had stopped."""
        prev = self._ticks.get(tick.key)
        if prev is not None and self._same(prev, tick):
            if tick.received_at > prev.received_at:
                self._ticks[tick.key] = prev.model_copy(update={"received_at": tick.received_at})
            return None
        self._seq += 1
        tick = tick.model_copy(update={"seq": self._seq})
        self._ticks[tick.key] = tick
        self._pending[tick.key] = tick  # keep only the latest per key between flushes
        self.tick_count += 1
        return tick

    def update_internal(self, tick: LiveTick) -> None:
        self._internal[tick.key] = tick

    def publish_internal(self, tick: LiveTick) -> LiveTick | None:
        """Also show an internal contract's tick to the browsers (next broadcast, new clients).

        Returns None for an exact repeat.
        """
        prev = self._public.get(tick.key)
        if prev is not None and self._same(prev, tick):
            return None
        self._seq += 1
        tick = tick.model_copy(update={"seq": self._seq})
        self._public[tick.key] = tick
        self._pending[tick.key] = tick
        return tick

    def get_internal(self, key: str) -> LiveTick | None:
        """Latest tick of a server-side contract (a NIFTY future)."""
        return self._internal.get(key)

    def internal_ticks(self) -> dict[str, LiveTick]:
        return dict(self._internal)

    def drain_pending(self) -> list[LiveTick]:
        out = list(self._pending.values())
        self._pending.clear()
        return out

    def snapshot(self) -> list[LiveTick]:
        return [*self._ticks.values(), *self._public.values()]

    def get(self, key: str) -> LiveTick | None:
        return self._ticks.get(key)

    def __len__(self) -> int:
        return len(self._ticks)

    def clear(self) -> None:
        self._ticks.clear()
        self._pending.clear()
        self._internal.clear()
        self._public.clear()
