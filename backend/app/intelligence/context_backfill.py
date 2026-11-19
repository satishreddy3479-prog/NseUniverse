"""One-off fill of the event ledger with the high-importance calendar events of past days (the live service only keeps what it sees from now on).

``python -m app.intelligence.context_backfill --data-dir PATH --from 2026-10-28 --to 2026-11-17`` asks the same third-party calendar the app already uses (biquote / MQL5) for the past range,
all countries the page shows, high importance only, and writes them to the ledger. Overnight market moves cannot be backfilled: the bars of earlier days are gone.
"""

from __future__ import annotations

import argparse
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path

from app.globalmkts import calendar_feed, news
from app.intelligence.context_ledger import ContextLedger


def url(start: date, end: date) -> str:
    countries = ",".join(calendar_feed.BQ_COUNTRIES)
    return f"{calendar_feed.BQ_URL}?from={start}&to={end}&countries={countries}&importance=high&limit=500"


def backfill(ledger: ContextLedger, start: date, end: date, fetch: Callable[[str], bytes] = news.http_get) -> int:
    """Events of ``start``..``end`` into the ledger, week by week (the API caps a response at 500 rows). Returns the high-importance rows written."""
    n, day = 0, start
    ledger.mark_covered(start.isoformat())
    while day <= end:
        stop = min(end, date.fromordinal(day.toordinal() + 6))
        n += ledger.add_events(calendar_feed.parse_biquote(fetch(url(day, stop))), datetime.now(UTC))
        day = date.fromordinal(stop.toordinal() + 1)
    return n


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", required=True, type=Path)
    ap.add_argument("--from", dest="start", required=True, type=date.fromisoformat)
    ap.add_argument("--to", dest="end", required=True, type=date.fromisoformat)
    a = ap.parse_args()
    ledger = ContextLedger(a.data_dir)
    n = backfill(ledger, a.start, a.end)
    print(f"{n} high-importance events written; ledger now holds {ledger.counts()} covering {ledger.coverage()}")  # noqa: T201
    ledger.close()


if __name__ == "__main__":
    main()
