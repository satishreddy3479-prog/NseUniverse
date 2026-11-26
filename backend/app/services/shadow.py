"""Does the live feed agree with the stored one-minute chain? (shadow comparison, nothing stored changes)

The one-minute samples the whole analysis is built on come from a REST option-chain call made about 5 seconds into every minute (26 Nov 2026: median 5.4 s after the minute, 99th
percentile 14.6 s, worst 43.8 s; a failed call loses the minute). The streaming feed already holds the same prices in memory, from the same broker. Before the sample is ever built
from the feed instead, this measures how the two compare, quote by quote, on every real capture: how many quotes the feed had, how many prices and open-interest and volume figures
are identical, how far apart the others are, and how old the feed's tick was. The result is one row per capture in ``runtime.sqlite3`` (GET /api/runtime/shadow).

Read-only: it never writes to the chain store and never changes what is captured.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Callable
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from app.domain.models import OptionChainSnapshot, OptionQuote
from app.stream.models import LiveTick

KEEP_DAYS = 45
TICK = 0.005  # prices are in rupees with a 0.05 tick: anything closer than half a paisa is the same price
COLUMNS = (
    "ts", "expiry", "quotes", "with_tick", "ltp_equal", "ltp_differs", "mean_abs_diff", "max_abs_diff", "feed_missing", "rest_missing", "oi_equal", "oi_compared", "vol_equal", "vol_compared",
    "tick_age_p50_s", "tick_age_p95_s", "feed_newer",
)
SCHEMA = """
CREATE TABLE IF NOT EXISTS shadow (
  ts TEXT NOT NULL, expiry TEXT NOT NULL, quotes INTEGER, with_tick INTEGER, ltp_equal INTEGER, ltp_differs INTEGER, mean_abs_diff REAL, max_abs_diff REAL,
  feed_missing INTEGER, rest_missing INTEGER, oi_equal INTEGER, oi_compared INTEGER, vol_equal INTEGER, vol_compared INTEGER, tick_age_p50_s REAL, tick_age_p95_s REAL,
  feed_newer INTEGER, PRIMARY KEY (ts, expiry));
"""


def _quotes(snap: OptionChainSnapshot) -> list[OptionQuote]:
    return [q for r in snap.rows for q in (r.call, r.put) if q is not None and q.exchange_segment and q.instrument_token]


def compare(snap: OptionChainSnapshot, tick_of: Callable[[str], LiveTick | None], at: datetime) -> dict[str, Any]:
    """How the feed's latest ticks compare with one stored chain, at the moment ``at`` (when the chain was received)."""
    n = with_tick = equal = differs = feed_missing = rest_missing = oi_eq = oi_n = vol_eq = vol_n = newer = 0
    diffs: list[float] = []
    ages: list[float] = []
    for q in _quotes(snap):
        n += 1
        t = tick_of(f"{q.exchange_segment}|{q.instrument_token}")
        if t is None:
            if q.ltp is not None:
                feed_missing += 1  # the chain has a price the feed never delivered
            continue
        with_tick += 1
        ages.append(max(0.0, (at - t.received_at).total_seconds()))
        if t.received_at > at:
            newer += 1  # the feed moved on after this chain was received: a difference may be real movement
        if q.ltp is None and t.ltp is not None:
            rest_missing += 1
        elif q.ltp is not None and t.ltp is not None:
            d = abs(q.ltp - t.ltp)
            if d <= TICK:
                equal += 1
            else:
                differs += 1
                diffs.append(d)
        if q.oi is not None and t.oi is not None:
            oi_n += 1
            oi_eq += int(abs(q.oi - t.oi) < 0.5)
        if q.volume is not None and t.volume is not None:
            vol_n += 1
            vol_eq += int(abs(q.volume - t.volume) < 0.5)
    ages.sort()

    def pick(p: float) -> float | None:
        return None if not ages else round(ages[min(len(ages) - 1, int(len(ages) * p))], 2)

    return {
        "ts": at.astimezone(UTC).isoformat(timespec="seconds"), "expiry": snap.expiry.isoformat(), "quotes": n, "with_tick": with_tick, "ltp_equal": equal, "ltp_differs": differs,
        "mean_abs_diff": None if not diffs else round(sum(diffs) / len(diffs), 3), "max_abs_diff": None if not diffs else round(max(diffs), 2), "feed_missing": feed_missing,
        "rest_missing": rest_missing, "oi_equal": oi_eq, "oi_compared": oi_n, "vol_equal": vol_eq, "vol_compared": vol_n, "tick_age_p50_s": pick(0.5), "tick_age_p95_s": pick(0.95),
        "feed_newer": newer,
    }


class ShadowStore:
    def __init__(self, data_dir: Path) -> None:
        self.path = Path(data_dir) / "runtime.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with closing(self._conn()) as c, c:
            c.executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        return c

    def add(self, row: dict[str, Any], now: datetime | None = None) -> None:
        now = now or datetime.now(UTC)
        with self._lock, closing(self._conn()) as c, c:
            c.execute(f"INSERT OR REPLACE INTO shadow VALUES ({','.join('?' * len(COLUMNS))})", tuple(row[k] for k in COLUMNS))  # noqa: S608 - our own column names
            c.execute("DELETE FROM shadow WHERE ts < ?", ((now - timedelta(days=KEEP_DAYS)).isoformat(timespec="seconds"),))

    def rows(self, since: datetime) -> list[dict[str, Any]]:
        with self._lock, closing(self._conn()) as c:
            return [dict(r) for r in c.execute("SELECT * FROM shadow WHERE ts >= ? ORDER BY ts", (since.astimezone(UTC).isoformat(timespec="seconds"),))]


def summarise(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """The figures worth reading first, over a set of captures."""
    def s(k: str) -> int:
        return int(sum(r[k] or 0 for r in rows))

    quotes, with_tick = s("quotes"), s("with_tick")
    priced = s("ltp_equal") + s("ltp_differs")
    ages95 = sorted(r["tick_age_p95_s"] for r in rows if r["tick_age_p95_s"] is not None)

    def share(a: int, b: int) -> float | None:
        return None if b == 0 else round(a / b * 100, 2)

    return {
        "captures": len(rows), "quotes": quotes, "feed_had_a_tick_pct": share(with_tick, quotes), "price_identical_pct": share(s("ltp_equal"), priced),
        "open_interest_identical_pct": share(s("oi_equal"), s("oi_compared")), "volume_identical_pct": share(s("vol_equal"), s("vol_compared")),
        "feed_missing": s("feed_missing"), "rest_missing": s("rest_missing"), "feed_newer_pct": share(s("feed_newer"), with_tick),
        "worst_price_gap": max((r["max_abs_diff"] for r in rows if r["max_abs_diff"] is not None), default=None),
        "tick_age_p95_s_median": ages95[len(ages95) // 2] if ages95 else None,
    }
