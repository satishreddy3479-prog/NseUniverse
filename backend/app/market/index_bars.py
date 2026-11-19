"""One-minute open/high/low/close of the NIFTY 50 index, built from the live index feed.

The option-chain sampler stores one index level per snapshot (about one a minute), so candles cut from those samples have
no real wicks and leave a gap between one candle's close and the next one's open. This builder reads the latest index
tick about once a second and keeps the minute's first, highest, lowest and last level, so a minute bar carries the
extremes seen during the minute (at the resolution of those reads; the exchange's tick-by-tick tape is not available).

A bar is written once, when its minute is over (append-only, never rewritten). A minute in which no fresh tick was seen
has no bar: nothing is filled in. Bars are session-only; the caller decides what counts as the session.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass
class MinuteBar:
    minute: str  # UTC ISO start of the minute
    o: float
    h: float
    l: float  # noqa: E741 - open/high/low/close
    c: float
    n: int  # distinct ticks that moved into the bar
    x: int = 0  # reads dropped as unconfirmed one-read spikes

    def payload(self) -> dict[str, float | int]:
        return {"o": self.o, "h": self.h, "l": self.l, "c": self.c, "n": self.n} | ({"x": self.x} if self.x else {})


JUMP = 0.0015  # a read this far (0.15 %, about 38 points) from the last accepted level must be confirmed by the next read before it counts
SILENCE_S = 120.0  # after this long without an accepted read the old level is stale: the next read starts over (19 Nov 2026: the index was silent 15:15-15:19, the closing auction)


class IndexBarBuilder:
    """A lone read far from its neighbours is a feed glitch, not a price (on 17 Nov 2026 a read of 25,284 and one of 25,580 came within one minute of a market near 25,450, drawing a
    300-point wick). Such a read is held back; if the next read agrees with it (within a third of the jump size) the move is real and counts, otherwise it is dropped and counted in ``x``.
    Nothing is invented: a dropped read just leaves the bar to the reads that agree."""

    def __init__(self) -> None:
        self.cur: MinuteBar | None = None
        self._last_tick_at: datetime | None = None
        self._level: float | None = None  # the last accepted level
        self._level_at: datetime | None = None
        self._held: float | None = None  # a far read waiting for confirmation

    def observe(self, now: datetime, price: float | None, tick_at: datetime | None) -> MinuteBar | None:
        """Feed one read. Returns the bar this read completed (the minute rolled over), else None.

        ``price`` None means no fresh index level right now: the bar in progress is kept and nothing is added."""
        minute = now.replace(second=0, microsecond=0)
        key = minute.isoformat()
        done: MinuteBar | None = None
        if self.cur is not None and self.cur.minute != key:
            done, self.cur = self.cur, None
        if price is None or price <= 0:
            return done
        new_tick = tick_at is None or tick_at != self._last_tick_at
        self._last_tick_at = tick_at
        if self._level_at is not None and (now - self._level_at).total_seconds() > SILENCE_S:
            self._level, self._held = None, None  # silent for minutes: a far read is not a glitch against a stale neighbour, it is the first read of a new stretch
        if self._level is not None and abs(price / self._level - 1) > JUMP:
            held, self._held = self._held, price
            if held is None or abs(price - held) > abs(held - self._level) / 3:
                if self.cur is not None:
                    self.cur.x += 1
                return done  # unconfirmed: wait for the next read
            if self.cur is not None and self.cur.x > 0:
                self.cur.x -= 1  # the read that waited was confirmed: it was a move, not a glitch
        self._held = None
        self._level = price
        self._level_at = now
        if self.cur is None:
            self.cur = MinuteBar(key, price, price, price, price, 1)
        else:
            self.cur.h, self.cur.l, self.cur.c = max(self.cur.h, price), min(self.cur.l, price), price
            if new_tick:
                self.cur.n += 1
        return done

    def flush(self) -> MinuteBar | None:
        """The bar in progress, handed back and cleared (used when the session ends)."""
        done, self.cur = self.cur, None
        return done
