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

    def payload(self) -> dict[str, float | int]:
        return {"o": self.o, "h": self.h, "l": self.l, "c": self.c, "n": self.n}


class IndexBarBuilder:
    def __init__(self) -> None:
        self.cur: MinuteBar | None = None
        self._last_tick_at: datetime | None = None

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
